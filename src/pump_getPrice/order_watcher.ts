import { PublicKey, ParsedTransactionWithMeta, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PumpFunSDK } from "../pumpfunsdk/pumpdotfun-sdk/src/pumpfun";
import { connection, wallet } from "../helpers/config";
import { program } from "commander";
import { logger } from "../helpers/logger";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import * as fs from 'fs';

// Define RPC error interface
interface RpcError extends Error {
  code?: number;
}

let tokenAddress: string;
// Keep track of processed signatures to avoid duplicates
const processedSignatures = new Set<string>();
// Keep track of pending trades before writing to CSV
let pendingTrades: TradeInfo[] = [];
let lastProcessedTime = 0; // Track the timestamp of the last processed trade
let isInitialFetch = true; // Flag to track initial fetch

// Adjust constants for better trade collection
const MIN_SOL_AMOUNT = 0.001; // Keep small trades
const BATCH_SIZE = 5;
const UPDATE_INTERVAL = 5000;
const MAX_RETRIES = 5;
const BASE_DELAY = 2000;
const RATE_LIMIT_DELAY = 500;

// Add progress tracking
let tradeCounter = 0;

// Add debug counters
let skippedByAmount = 0;
let skippedByPump = 0;
let skippedByToken = 0;
let processedCount = 0;

program
  .argument("<token_address>", "The token address to fetch transactions for")
  .option("-h, --help", "display help for command")
  .action((address: string, options: any) => {
    if (options.help) {
      logger.info("ts-node order_watcher.ts <TOKEN_ADDRESS>");
      process.exit(0);
    }
    tokenAddress = address;
  });

program.parse();

interface TradeInfo {
  timestamp: string;
  type: string;
  solAmount: string;
  tokenAmount: string;
  txHash: string;
}

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// Add type interfaces for account keys and token balances
interface AccountKey {
  pubkey: PublicKey;
  signer: boolean;
  writable: boolean;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

async function writeTradestoCSV(mint: string, trades: TradeInfo[]) {
  try {
    const fileName = `${mint}_trades.csv`;
    
    // For initial fetch, just write the trades directly
    if (isInitialFetch) {
      const headers = ["TIMESTAMP", "TYPE", "SOL_AMOUNT", "TOKEN_AMOUNT", "TX_HASH"];
      const csvContent = [
        headers.join(","),
        ...trades.map(trade => [
          trade.timestamp,
          trade.type,
          trade.solAmount,
          trade.tokenAmount,
          trade.txHash
        ].join(","))
      ].join("\n");
      fs.writeFileSync(fileName, csvContent);
      return;
    }

    // For subsequent writes, append to existing trades
    let existingTrades: TradeInfo[] = [];
    if (fs.existsSync(fileName)) {
      const content = fs.readFileSync(fileName, 'utf-8');
      const lines = content.split('\n');
      lines.shift(); // Remove header
      existingTrades = lines
        .filter(line => line.trim() !== '')
        .map(line => {
          const [timestamp, type, solAmount, tokenAmount, txHash] = line.split(',');
          return { timestamp, type, solAmount, tokenAmount, txHash };
        });
    }

    const allTrades = [...existingTrades, ...trades];
    
    const headers = ["TIMESTAMP", "TYPE", "SOL_AMOUNT", "TOKEN_AMOUNT", "TX_HASH"];
    const csvContent = [
      headers.join(","),
      ...allTrades.map(trade => [
        trade.timestamp,
        trade.type,
        trade.solAmount,
        trade.tokenAmount,
        trade.txHash
      ].join(","))
    ].join("\n");

    fs.writeFileSync(fileName, csvContent);
  } catch (error) {
    logger.error("Error writing to CSV:", error);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function exponentialBackoff(retryCount: number): Promise<void> {
  const delay = BASE_DELAY * Math.pow(2, retryCount);
  logger.info(`Waiting ${delay/1000} seconds before retry...`);
  await sleep(delay);
}

async function fetchWithRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await operation();
    } catch (err) {
      const rpcError = err as RpcError;
      if (rpcError.message?.includes('429')) {
        logger.info(`Rate limited while ${context}. Retry ${i + 1}/${MAX_RETRIES}`);
        await exponentialBackoff(i);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed after ${MAX_RETRIES} retries while ${context}`);
}

async function processTransaction(tx: any, mint: PublicKey): Promise<TradeInfo | null> {
  if (!tx?.meta || !tx.blockTime) {
    logger.info("Skipped: No meta or blockTime");
    return null;
  }

  processedCount++;
  const meta = tx.meta;
  
  // Check if this is a pump.fun transaction
  const isPumpTransaction = tx.transaction.message.accountKeys.some(
    (key: AccountKey) => key.pubkey.toString() === PUMP_PROGRAM_ID.toString()
  );

  if (!isPumpTransaction) {
    skippedByPump++;
    logger.info("Skipped: Not a Pump.fun transaction");
    return null;
  }

  // Find all relevant accounts
  const accountKeys = tx.transaction.message.accountKeys;
  const pumpFunFeeAccount = accountKeys.findIndex(
    (key: AccountKey) => key.pubkey.toString() === "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
  );

  // Find the user's account (the one with the largest SOL change)
  let maxSolChange = 0;
  let userAccountIndex = -1;
  
  for (let i = 0; i < meta.preBalances.length; i++) {
    const solChange = Math.abs(meta.postBalances[i] - meta.preBalances[i]) / LAMPORTS_PER_SOL;
    if (solChange > maxSolChange) {
      maxSolChange = solChange;
      userAccountIndex = i;
    }
  }

  if (userAccountIndex === -1) return null;

  const userSolChange = (meta.preBalances[userAccountIndex] - meta.postBalances[userAccountIndex]) / LAMPORTS_PER_SOL;

  // Find token balance changes
  const userTokenAccounts = meta.postTokenBalances?.filter((b: TokenBalance) => 
    b.mint === mint.toString() && 
    meta.preTokenBalances?.some((pre: TokenBalance) => pre.accountIndex === b.accountIndex)
  ) || [];

  if (userTokenAccounts.length === 0) {
    skippedByToken++;
    logger.info("Skipped: No token balance changes found");
    return null;
  }

  const postTokenBalance = userTokenAccounts[0];
  const preTokenBalance = meta.preTokenBalances?.find((b: TokenBalance) => 
    b.accountIndex === postTokenBalance.accountIndex
  );

  if (!preTokenBalance) return null;

  const preAmount = Number(preTokenBalance.uiTokenAmount.uiAmount || 0);
  const postAmount = Number(postTokenBalance.uiTokenAmount.uiAmount || 0);
  const tokenChange = Math.abs(postAmount - preAmount);

  if (tokenChange === 0) return null;

  const isBuy = postAmount > preAmount;

  // Calculate actual SOL amount
  let actualSolChange = Math.abs(userSolChange);

  // For buys, account for fees
  if (isBuy && pumpFunFeeAccount !== -1) {
    const pumpFunFee = (meta.postBalances[pumpFunFeeAccount] - meta.preBalances[pumpFunFeeAccount]) / LAMPORTS_PER_SOL;
    actualSolChange -= pumpFunFee;
  }

  if (actualSolChange < MIN_SOL_AMOUNT) {
    skippedByAmount++;
    logger.info(`Skipped: Trade amount ${actualSolChange} SOL below minimum ${MIN_SOL_AMOUNT} SOL`);
    return null;
  }

  const timestamp = new Date(tx.blockTime * 1000);
  const currentYear = new Date().getFullYear();
  // Ensure timestamp is not in the future
  if (timestamp.getFullYear() > currentYear) {
    timestamp.setFullYear(currentYear);
  }

  tradeCounter++;
  logger.info(`[Trade ${tradeCounter}/${BATCH_SIZE}] ${isBuy ? "SELL" : "BUY"} - ${actualSolChange.toFixed(4)} SOL (${tokenChange} tokens)`);
  logger.info(`Timestamp: ${timestamp.toISOString()}`);
  
  return {
    timestamp: timestamp.toISOString(),
    type: isBuy ? "SELL" : "BUY",
    solAmount: actualSolChange.toString(),
    tokenAmount: tokenChange.toString(),
    txHash: tx.transaction.signatures[0]
  };
}

async function getInitialTrades() {
  try {
    tradeCounter = 0;
    skippedByAmount = 0;
    skippedByPump = 0;
    skippedByToken = 0;
    processedCount = 0;

    const mint = new PublicKey(tokenAddress);

    logger.info("Initializing connection to Solana...");
    logger.info(`Looking for trades for token: ${mint.toString()}`);
    await sleep(1000);

    // Get signatures with retry and increased limit for better coverage
    const signatures = await fetchWithRetry(
      () => connection.getSignaturesForAddress(mint, { limit: 1000 }, "confirmed"),
      "fetching signatures"
    );

    logger.info(`Found ${signatures.length} total transactions to process`);
    
    let validTrades = [];
    let processedSigs = 0;
    
    for (const sig of signatures) {
      try {
        await sleep(RATE_LIMIT_DELAY);
        processedSigs++;
        
        const tx = await fetchWithRetry(
          () => connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
          }),
          `fetching transaction ${sig.signature.slice(0, 8)}... (${processedSigs}/${signatures.length})`
        );

        const tradeInfo = await processTransaction(tx, mint);
        if (tradeInfo) {
          validTrades.push(tradeInfo);
          processedSignatures.add(sig.signature);
          
          if (validTrades.length >= BATCH_SIZE) {
            break;
          }
        }
      } catch (err) {
        logger.error(`Error processing tx ${sig.signature}:`, err);
        continue;
      }
    }

    // Log summary of processed transactions
    logger.info("\nProcessing Summary:");
    logger.info(`Total transactions processed: ${processedCount}`);
    logger.info(`Skipped by amount: ${skippedByAmount}`);
    logger.info(`Skipped - not Pump.fun: ${skippedByPump}`);
    logger.info(`Skipped - no token changes: ${skippedByToken}`);
    logger.info(`Valid trades found: ${validTrades.length}`);

    if (validTrades.length > 0) {
      // Sort by timestamp in ascending order (oldest first)
      validTrades.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      
      // Take only the last BATCH_SIZE trades
      if (validTrades.length > BATCH_SIZE) {
        validTrades = validTrades.slice(-BATCH_SIZE);
      }
      
      await writeTradestoCSV(mint.toString(), validTrades);
      logger.info(`\nInitial collection complete:`);
      logger.info(`- Found and wrote ${validTrades.length} trades to CSV`);
      logger.info(`- File: ${mint.toString()}_trades.csv`);
      
      const lastTrade = validTrades[validTrades.length - 1];
      lastProcessedTime = new Date(lastTrade.timestamp).getTime() / 1000;
    } else {
      logger.info("\nNo valid trades found in initial collection");
    }

    isInitialFetch = false;
    tradeCounter = 0;
  } catch (error) {
    logger.error("Error fetching initial trades:", error);
  }
}

async function monitorTrades() {
  try {
    const mint = new PublicKey(tokenAddress);

    const signatures = await fetchWithRetry(
      () => connection.getSignaturesForAddress(mint, { limit: 25 }, "confirmed"),
      "fetching recent signatures"
    );

    const newSignatures = signatures.filter(sig => 
      !processedSignatures.has(sig.signature) && 
      (sig.blockTime || 0) > lastProcessedTime
    );

    if (newSignatures.length === 0) return;

    let validTradesFound = 0;
    let skippedTrades = 0;

    for (const sig of newSignatures) {
      try {
        if (processedSignatures.has(sig.signature)) continue;

        await sleep(RATE_LIMIT_DELAY);

        const tx = await fetchWithRetry(
          () => connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
          }),
          `fetching transaction ${sig.signature.slice(0, 8)}...`
        );

        const tradeInfo = await processTransaction(tx, mint);
        if (tradeInfo) {
          validTradesFound++;
          pendingTrades.push(tradeInfo);

          if (pendingTrades.length >= BATCH_SIZE) {
            await writeTradestoCSV(mint.toString(), pendingTrades);
            logger.info(`\nBatch complete! Wrote ${BATCH_SIZE} trades to CSV`);
            pendingTrades = [];
            tradeCounter = 0; // Reset counter for next batch
          }
        } else {
          skippedTrades++;
        }

        processedSignatures.add(sig.signature);
        if (tx?.blockTime) {
          lastProcessedTime = tx.blockTime;
        }
      } catch (err) {
        logger.error(`Error processing tx ${sig.signature}:`, err);
        skippedTrades++;
        continue;
      }
    }

    if (validTradesFound > 0 || skippedTrades > 0) {
      logger.info('\nMonitoring Summary:');
      logger.info(`- New trades found: ${validTradesFound}`);
      logger.info(`- Skipped transactions: ${skippedTrades}`);
      logger.info(`- Trades pending CSV write: ${pendingTrades.length}`);
    }

  } catch (error) {
    logger.error("Error monitoring trades:", error);
  }
}

// Start the process
async function start() {
  // First get initial trades
  await getInitialTrades();
  
  // Then start monitoring
  setInterval(monitorTrades, UPDATE_INTERVAL);
}

start(); 