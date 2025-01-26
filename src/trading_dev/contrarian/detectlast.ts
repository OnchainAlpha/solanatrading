import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "../../helpers/config";
import { buy } from "../../jupiter/swap/buy-helper";
import { sell } from "../../jupiter/swap/sell-helper";
import { logger } from "../../helpers/logger"; // Import logger

interface TradeState {
  lastTradeDirection: 'buy' | 'sell' | null;
  lastTradeSizeInSOL: number;
  lastTradeTimestamp: number;
}

const tradeStates: { [key: string]: TradeState } = {};
const OPPOSITE_TRADE_PERCENTAGE = 0.1; // 10% of the original trade size
const WSOL_ADDRESS = "So11111111111111111111111111111111111111112";
const RAYDIUM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8FxcJPMeVpkEgPWjCzGw3ZNzo"; // Raydium LP Program Authority - from stream-trader.ts

export async function detectLatestTrade(data: any, targetTokenMint: string): Promise<{ side: 'buy' | 'sell' | null, swappedSOLAmount: number }> {
  const preTokenBalances = data.transaction.transaction.meta.preTokenBalances;
  const postTokenBalances = data.transaction.transaction.meta.postTokenBalances;
  let postPoolSOL = 0, postPoolToken = 0, prePoolSOL = 0, prePoolToken = 0;

  for (const account of preTokenBalances) {
    if (prePoolSOL !== 0 && prePoolToken !== 0) break;
    if (account.owner === RAYDIUM_AUTHORITY && account.mint === WSOL_ADDRESS) {
      prePoolSOL = account.uiTokenAmount.uiAmount;
    }
    if (account.owner === RAYDIUM_AUTHORITY && account.mint === targetTokenMint) {
      prePoolToken = account.uiTokenAmount.uiAmount;
    }
  }
  for (const account of postTokenBalances) {
    if (postPoolSOL !== 0 && postPoolToken !== 0) break;
    if (account.owner === RAYDIUM_AUTHORITY && account.mint === WSOL_ADDRESS) {
      postPoolSOL = account.uiTokenAmount.uiAmount;
    }
    if (account.owner === RAYDIUM_AUTHORITY && account.mint === targetTokenMint) {
      postPoolToken = account.uiTokenAmount.uiAmount;
    }
  }

  if (postPoolSOL > prePoolSOL) {
    return { side: "buy", swappedSOLAmount: postPoolSOL - prePoolSOL };
  } else if (postPoolSOL < prePoolSOL) {
    return { side: "sell", swappedSOLAmount: prePoolSOL - postPoolSOL };
  }
  
  return { side: null, swappedSOLAmount: 0 };
}

async function handleTradeDetection(tokenAddress: string, data: any) {
  const currentTimestamp = Date.now();
  const lastState = tradeStates[tokenAddress] || null;
  const tradeResult = await detectLatestTrade(data, tokenAddress);
  const tradeDirection = tradeResult.side;
  const swappedSOLAmount = tradeResult.swappedSOLAmount;


  if (tradeDirection && (!lastState || currentTimestamp - lastState.lastTradeTimestamp > 1000)) {
    const oppositeSizeInSOL = swappedSOLAmount * OPPOSITE_TRADE_PERCENTAGE;

    if (tradeDirection === 'buy') {
      await sell(tokenAddress, oppositeSizeInSOL, 1); // Sell token
    } else if (tradeDirection === 'sell') {
      await buy(tokenAddress, oppositeSizeInSOL, 1); // Buy token
    }

    tradeStates[tokenAddress] = {
      lastTradeDirection: tradeDirection,
      lastTradeSizeInSOL: oppositeSizeInSOL,
      lastTradeTimestamp: currentTimestamp
    };
    logger.info(`Contrarian strategy executed: ${tradeDirection === 'buy' ? 'sell' : 'buy'} ${oppositeSizeInSOL} SOL worth of token: ${tokenAddress}`);
  }
}


export async function startContrarianStrategy(tokenAddress: string) {
  // Placeholder for stream subscription - to be implemented in next steps
  console.log(`Started contrarian strategy for token: ${tokenAddress}`);
}