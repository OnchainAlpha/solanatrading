import { PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PumpFunSDK } from "../pumpfunsdk/pumpdotfun-sdk/src/pumpfun";
import { connection, wallet } from "../helpers/config";
import { program } from "commander";
import { logger } from "../helpers/logger";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import * as fs from 'fs';
import { TradeEvent } from "../pumpfunsdk/pumpdotfun-sdk/src/types";

let tokenAddress: string;

program
  .argument("<token_address>", "The token address to fetch price for")
  .option("-h, --help", "display help for command")
  .action((address: string, options: any) => {
    if (options.help) {
      logger.info("ts-node getPrice.ts <TOKEN_ADDRESS>");
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

async function getPrice() {
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

    // Get current reserves
    logger.info("Token Information:");
    logger.info(`Address: ${mint.toString()}`);
    logger.info(`Virtual Token Reserves: ${bondingCurveAccount.virtualTokenReserves.toString()}`);
    logger.info(`Virtual SOL Reserves: ${bondingCurveAccount.virtualSolReserves.toString()}`);
    logger.info(`Real Token Reserves: ${bondingCurveAccount.realTokenReserves.toString()}`);
    logger.info(`Real SOL Reserves: ${bondingCurveAccount.realSolReserves.toString()}`);

    // Fetch last 10 transactions
    const signatures = await connection.getSignaturesForAddress(mint, { limit: 10 });
    const trades: TradeInfo[] = [];

    for (const sig of signatures) {
      try {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx || !tx.meta) continue;

        // Find SOL transfer to identify buy/sell
        const preBalances = tx.meta.preBalances;
        const postBalances = tx.meta.postBalances;
        const accountKeys = tx.transaction.message.accountKeys;
        
        // Find the user's account (usually the first one)
        const userAccount = accountKeys[0];
        const userIndex = accountKeys.findIndex(key => key.pubkey.toBase58() === userAccount.pubkey.toBase58());
        
        if (userIndex === -1) continue;

        const solChange = (postBalances[userIndex] - preBalances[userIndex]) / LAMPORTS_PER_SOL;
        const isBuy = solChange < 0; // if user's SOL decreased, it's a buy

        // Find token balance change
        const tokenPreBalance = tx.meta.preTokenBalances?.find(b => b.mint === mint.toString());
        const tokenPostBalance = tx.meta.postTokenBalances?.find(b => b.mint === mint.toString());
        
        if (!tokenPreBalance || !tokenPostBalance) continue;

        const tokenChange = Math.abs(
          Number(tokenPostBalance.uiTokenAmount.uiAmount) - 
          Number(tokenPreBalance.uiTokenAmount.uiAmount)
        );

        if (tokenChange === 0) continue; // Skip if no token transfer

        const tradeInfo: TradeInfo = {
          timestamp: new Date(tx.blockTime! * 1000).toISOString(),
          type: isBuy ? "BUY" : "SELL",
          solAmount: Math.abs(solChange).toString(),
          tokenAmount: tokenChange.toString(),
          txHash: sig.signature
        };

        trades.push(tradeInfo);
        logger.info(`Found ${tradeInfo.type} transaction: ${Math.abs(solChange)} SOL for ${tokenChange} tokens`);
      } catch (err) {
        logger.error(`Error processing transaction ${sig.signature}:`, err);
        continue;
      }
    }

    // Create CSV content
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

    // Write to file
    const fileName = `${mint.toString()}_trades.csv`;
    fs.writeFileSync(fileName, csvContent);
    logger.info(`Trade data saved to ${fileName}`);
    logger.info(`Found ${trades.length} trades`);

  } catch (error) {
    logger.error("Error fetching price:", error);
  }
}

const LAMPORTS_PER_SOL = 1000000000;
getPrice(); 