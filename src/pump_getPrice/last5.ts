import { PublicKey, ParsedTransactionWithMeta, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PumpFunSDK } from "../pumpfunsdk/pumpdotfun-sdk/src/pumpfun";
import { connection, wallet } from "../helpers/config";
import { program } from "commander";
import { logger } from "../helpers/logger";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import * as fs from 'fs';

let tokenAddress: string;

program
  .argument("<token_address>", "The token address to fetch transactions for")
  .option("-h, --help", "display help for command")
  .action((address: string, options: any) => {
    if (options.help) {
      logger.info("ts-node last5.ts <TOKEN_ADDRESS>");
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
const MIN_SOL_AMOUNT = 0.001; // Minimum SOL amount to consider for a trade

async function getLast5Trades() {
  try {
    const Wallet = new NodeWallet(wallet);
    const provider = new AnchorProvider(connection, Wallet, {
      commitment: "confirmed",
    });

    const sdk = new PumpFunSDK(provider);
    const mint = new PublicKey(tokenAddress);

    // Get bonding curve account
    const bondingCurveAccount = await sdk.getBondingCurveAccount(mint);
    if (!bondingCurveAccount) {
      logger.error("Bonding curve account not found for token");
      return;
    }

    // Get global account for fee info
    const globalAccount = await sdk.getGlobalAccount();

    // Log token information
    logger.info("Token Information:");
    logger.info(`Address: ${mint.toString()}`);
    logger.info(`Virtual Token Reserves: ${bondingCurveAccount.virtualTokenReserves.toString()}`);
    logger.info(`Virtual SOL Reserves: ${bondingCurveAccount.virtualSolReserves.toString()}`);
    logger.info(`Real Token Reserves: ${bondingCurveAccount.realTokenReserves.toString()}`);
    logger.info(`Real SOL Reserves: ${bondingCurveAccount.realSolReserves.toString()}`);

    // Fetch more transactions initially to ensure we find enough valid trades
    const signatures = await connection.getSignaturesForAddress(mint, { limit: 20 });
    const trades: TradeInfo[] = [];

    for (const sig of signatures) {
      try {
        if (trades.length >= 5) break; // Stop once we have 5 valid trades

        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        });

        if (!tx?.meta || !tx.blockTime) continue;

        // Check if this is a pump.fun transaction
        const isPumpTransaction = tx.transaction.message.accountKeys.some(
          key => key.pubkey.toString() === PUMP_PROGRAM_ID.toString()
        );

        if (!isPumpTransaction) continue;

        const meta = tx.meta;

        // Find all relevant accounts
        const accountKeys = tx.transaction.message.accountKeys;
        const pumpFunFeeAccount = accountKeys.findIndex(
          key => key.pubkey.toString() === "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
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

        if (userAccountIndex === -1) continue;

        const userSolChange = (meta.preBalances[userAccountIndex] - meta.postBalances[userAccountIndex]) / LAMPORTS_PER_SOL;

        // Find token balance changes
        const userTokenAccounts = meta.postTokenBalances?.filter(b => 
          b.mint === mint.toString() && 
          meta.preTokenBalances?.some(pre => pre.accountIndex === b.accountIndex)
        ) || [];

        if (userTokenAccounts.length === 0) continue;

        const postTokenBalance = userTokenAccounts[0];
        const preTokenBalance = meta.preTokenBalances?.find(b => 
          b.accountIndex === postTokenBalance.accountIndex
        );

        if (!preTokenBalance) continue;

        const preAmount = Number(preTokenBalance.uiTokenAmount.uiAmount || 0);
        const postAmount = Number(postTokenBalance.uiTokenAmount.uiAmount || 0);
        const tokenChange = Math.abs(postAmount - preAmount);

        if (tokenChange === 0) continue;

        const isBuy = postAmount > preAmount;

        // Calculate actual SOL amount
        let actualSolChange = Math.abs(userSolChange);
        
        if (isBuy && pumpFunFeeAccount !== -1) {
          const pumpFunFee = (meta.postBalances[pumpFunFeeAccount] - meta.preBalances[pumpFunFeeAccount]) / LAMPORTS_PER_SOL;
          actualSolChange -= pumpFunFee;
        }

        // Skip very small trades
        if (actualSolChange < MIN_SOL_AMOUNT) continue;

        const tradeInfo: TradeInfo = {
          timestamp: new Date(tx.blockTime * 1000).toISOString(),
          type: isBuy ? "SELL" : "BUY",
          solAmount: actualSolChange.toString(),
          tokenAmount: tokenChange.toString(),
          txHash: sig.signature
        };

        trades.push(tradeInfo);
        logger.info(`Found ${tradeInfo.type} transaction: ${actualSolChange.toFixed(3)} SOL for ${tokenChange} tokens`);
      } catch (err) {
        logger.error(`Error processing transaction ${sig.signature}:`, err);
        continue;
      }
    }

    // Sort trades by timestamp (most recent first)
    trades.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Take only the last 5 trades
    const last5Trades = trades.slice(0, 5);

    // Create CSV content
    const headers = ["TIMESTAMP", "TYPE", "SOL_AMOUNT", "TOKEN_AMOUNT", "TX_HASH"];
    const csvContent = [
      headers.join(","),
      ...last5Trades.map(trade => [
        trade.timestamp,
        trade.type,
        trade.solAmount,
        trade.tokenAmount,
        trade.txHash
      ].join(","))
    ].join("\n");

    // Write to file
    const fileName = `${mint.toString()}_trades.csv`;
    fs.writeFileSync(fileName, csvContent);
    logger.info(`Trade data saved to ${fileName}`);
    logger.info(`Found ${last5Trades.length} trades`);

  } catch (error) {
    logger.error("Error fetching trades:", error);
  }
}

getLast5Trades(); 