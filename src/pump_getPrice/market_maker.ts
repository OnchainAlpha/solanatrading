import { PublicKey, ParsedTransactionWithMeta, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PumpFunSDK } from "../pumpfunsdk/pumpdotfun-sdk/src/pumpfun";
import { connection, wallet } from "../helpers/config";
import { program } from "commander";
import { logger } from "../helpers/logger";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import * as fs from 'fs';
import * as readline from 'readline';

// Configuration
let tokenAddress: string;
let buyPercentage: number;
let sellPercentage: number;
const UPDATE_INTERVAL = 1000; // Check more frequently
const BATCH_SIZE = 5;

// Market making state
let lastProcessedTimestamp = '';
let lastProcessedHash = '';
let isProcessingTrade = false;
let processedBatches = new Set<string>();

// Update BondingCurveAccount interface to match SDK
interface BondingCurveAccount {
  baseAmount: bigint;
  targetAmount: bigint;
  base: bigint;
  target: bigint;
  totalSupply: bigint;
  buyTaxBps: number;
  sellTaxBps: number;
  publicKey: PublicKey;
}

interface TradeInfo {
  timestamp: string;
  type: string;
  solAmount: string;
  tokenAmount: string;
  txHash: string;
}

// Setup command line arguments
program
  .argument("<token_address>", "The token address to market make for")
  .option("-h, --help", "display help for command")
  .action((address: string, options: any) => {
    if (options.help) {
      logger.info("ts-node market_maker.ts <TOKEN_ADDRESS>");
      process.exit(0);
    }
    tokenAddress = address;
  });

program.parse();

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function promptForPercentages(): Promise<void> {
  return new Promise((resolve) => {
    rl.question('Enter buy percentage (0-100): ', (buyPct) => {
      rl.question('Enter sell percentage (0-100): ', (sellPct) => {
        buyPercentage = Number(buyPct) / 100;
        sellPercentage = Number(sellPct) / 100;
        
        logger.info(`\nStrategy Configuration:`);
        logger.info(`- Buy Percentage: ${buyPct}%`);
        logger.info(`- Sell Percentage: ${sellPct}%`);
        logger.info(`- Token Address: ${tokenAddress}\n`);
        
        resolve();
        rl.close();
      });
    });
  });
}

async function watchTradeFile(): Promise<void> {
  const fileName = `${tokenAddress}_trades.csv`;
  if (!fs.existsSync(fileName)) {
    logger.error("No trade history found. Please run order_watcher.ts first.");
    return;
  }

  try {
    const content = fs.readFileSync(fileName, 'utf-8');
    const lines = content.split('\n');
    lines.shift(); // Remove header

    const trades = lines
      .filter(line => line.trim() !== '')
      .map(line => {
        const [timestamp, type, solAmount, tokenAmount, txHash] = line.split(',');
        return { timestamp, type, solAmount: parseFloat(solAmount), tokenAmount, txHash };
      });

    // Get the last 5 trades
    const lastFiveTrades = trades.slice(-5);
    
    if (lastFiveTrades.length < 5) {
      return; // Wait for more trades
    }

    // Create a batch identifier using first and last trade timestamps and hashes
    const batchId = `${lastFiveTrades[0].timestamp}-${lastFiveTrades[4].timestamp}-${lastFiveTrades[0].txHash.slice(0,8)}-${lastFiveTrades[4].txHash.slice(0,8)}`;
    
    // Check if we've already processed this batch
    if (processedBatches.has(batchId)) {
      return;
    }

    // Calculate net volume for this batch
    let netVolume = 0;
    for (const trade of lastFiveTrades) {
      netVolume += trade.type === 'SELL' ? -trade.solAmount : trade.solAmount;
    }

    logger.info('\n🔄 New Trade Batch Detected:');
    logger.info('Last 5 trades:');
    lastFiveTrades.forEach((trade, index) => {
      logger.info(`${index + 1}. ${trade.type} - ${trade.solAmount.toFixed(4)} SOL`);
    });
    logger.info(`Net Volume: ${netVolume.toFixed(4)} SOL`);

    // Execute counter-cyclical trade based on net volume
    if (netVolume !== 0) {
      if (netVolume > 0) {
        // Net buying pressure -> We should sell
        await executeTrade(false, netVolume);
      } else {
        // Net selling pressure -> We should buy
        await executeTrade(true, Math.abs(netVolume));
      }
    }

    // Mark this batch as processed
    processedBatches.add(batchId);
    
    // Keep set size manageable
    if (processedBatches.size > 100) {
      const batchArray = Array.from(processedBatches);
      processedBatches = new Set(batchArray.slice(-50));
    }

  } catch (error) {
    logger.error("Error watching trade file:", error);
  }
}

async function executeTrade(isBuy: boolean, amount: number) {
  if (isProcessingTrade) return;
  isProcessingTrade = true;

  try {
    const Wallet = new NodeWallet(wallet);
    const provider = new AnchorProvider(connection, Wallet, {
      commitment: "confirmed",
    });

    const sdk = new PumpFunSDK(provider);
    const mint = new PublicKey(tokenAddress);

    // Get bonding curve info
    const bondingCurve = await sdk.getBondingCurveAccount(mint);
    if (!bondingCurve) {
      logger.error("Bonding curve account not found");
      return;
    }

    const tradeType = isBuy ? "BUY" : "SELL";
    const percentage = isBuy ? buyPercentage : sellPercentage;
      const tradeAmount = Math.abs(amount * percentage);
      const lamports = BigInt(Math.floor(tradeAmount * LAMPORTS_PER_SOL));

      logger.info(`\n💰 Executing ${tradeType} Order:`);
      logger.info(`- Net Volume: ${amount.toFixed(4)} SOL`);
    logger.info(`- Trade Amount: ${tradeAmount.toFixed(4)} SOL (${(percentage * 100)}%)`);

    // Execute the trade with required parameters
    if (isBuy) {
      await sdk.buy(
        mint,
        lamports,
        0n, // Linear curve type as bigint
        0n, // Base reserve (not needed for execution)
        0n  // Target reserve (not needed for execution)
      );
      logger.info("✅ Buy order executed successfully");
    } else {
      await sdk.sell(
        mint,
        lamports,
        0n, // Linear curve type as bigint
        0n, // Base reserve (not needed for execution)
        0n  // Target reserve (not needed for execution)
      );
      logger.info("✅ Sell order executed successfully");
    }

  } catch (error) {
    logger.error(`Error executing ${isBuy ? 'buy' : 'sell'} trade:`, error);
  } finally {
    isProcessingTrade = false;
  }
}

// Start the market making process
async function start() {
  logger.info("🤖 Starting Market Making Strategy\n");
  
  // Get user input for percentages
  await promptForPercentages();
  
  logger.info("Watching for trade batches...\n");
  
  // Start monitoring file changes
  setInterval(watchTradeFile, UPDATE_INTERVAL);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info("\n\n🛑 Stopping Market Making Strategy");
  logger.info("Cleaning up...");
  process.exit(0);
});

start(); 
