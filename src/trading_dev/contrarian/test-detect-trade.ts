import { detectLatestTrade } from "./detectlast";

async function main() {
  // Test Case 1: Buy Scenario
  console.log("Test Case 1: Buy Scenario");
  const buyTransactionData = {
    transaction: {
      transaction: {
        meta: {
          preTokenBalances: [
            {
              owner: "5Q544fKrFoe6tsEbD7S8FxcJPMeVpkEgPWjCzGw3ZNzo",
              mint: "So11111111111111111111111111111111111111112",
              uiTokenAmount: { uiAmount: 100 }
            },
            {
              owner: "5Q544fKrFoe6tsEbD7S8FxcJPMeVpkEgPWjCzGw3ZNzo",
              mint: "TEST_TOKEN_ADDRESS",
              uiTokenAmount: { uiAmount: 1000 }
            }
          ],
          postTokenBalances: [
            {
              owner: "5Q544fKrFoe6tsEbD7S8FxcJPMeVpkEgPWjCzGw3ZNzo",
              mint: "So11111111111111111111111111111111111111112",
              uiTokenAmount: { uiAmount: 101 }
            },
            {
              owner: "5Q544fKrFoe6tsEbD7S8FxcJPMeVpkEgPWjCzGw3ZNzo",
              mint: "TEST_TOKEN_ADDRESS",
              uiTokenAmount: { uiAmount: 990 }
            }
          ]
        }
      }
    }
  };

  const buyResult = await detectLatestTrade(buyTransactionData, "TEST_TOKEN_ADDRESS");
  console.log("Buy Result:", buyResult);
  console.log(buyResult.side === "buy" ? "✅ Buy Scenario Test Passed!" : "❌ Buy Scenario Test Failed!");

  // Test Case 2: Sell Scenario
  console.log("\nTest Case 2: Sell Scenario");
  const sellTransactionData = {
    transaction: {
      transaction: {
        meta: {
          preTokenBalances: [
            {
              owner: "5Q544fKrFoe6tsEbD7S8FxcJPMeVpkEgPWjCzGw3ZNzo",
              mint: "So11111111111111111111111111111111111111112",
              uiTokenAmount: { uiAmount: 100 }
            },
            {
              owner: "5Q544fKrFoe6tsEbD7S8FxcJPMeVpkEgPWjCzGw3ZNzo",
              mint: "TEST_TOKEN_ADDRESS",
              uiTokenAmount: { uiAmount: 1000 }
            }
          ],
          postTokenBalances: [
            {
              owner: "5Q544fKrFoe6tsEbD7S8FxcJPMeVpkEgPWjCzGw3ZNzo",
              mint: "So11111111111111111111111111111111111111112",
              uiTokenAmount: { uiAmount: 99 }
            },
            {
              owner: "5Q544fKrFoe6tsEbD7S8FxcJPMeVpkEgPWjCzGw3ZNzo",
              mint: "TEST_TOKEN_ADDRESS",
              uiTokenAmount: { uiAmount: 1010 }
            }
          ]
        }
      }
    }
  };

  const sellResult = await detectLatestTrade(sellTransactionData, "TEST_TOKEN_ADDRESS");
  console.log("Sell Result:", sellResult);
  console.log(sellResult.side === "sell" ? "✅ Sell Scenario Test Passed!" : "❌ Sell Scenario Test Failed!");
}

main().catch(console.error);