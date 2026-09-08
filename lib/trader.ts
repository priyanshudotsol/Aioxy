import "server-only";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaTestnet } from "viem/chains";
import { INDEXER_URL, PROB_SCALE, QTY_SCALE, WS_RPC_URL } from "./config";

/**
 * The SDK opens a websocket that keeps the event loop alive, so it is built once
 * and reused across requests rather than per-invocation.
 */
let cached: SomniaMarkets | null = null;

export function exchange(): SomniaMarkets {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("PRIVATE_KEY not set — the app is in read-only mode");
  if (!cached) {
    cached = new SomniaMarkets({
      chain: somniaTestnet,
      addresses: SOMNIA_TESTNET_ADDRESSES,
      privateKey,
      wsRpcUrl: WS_RPC_URL,
      indexerUrl: INDEXER_URL,
    });
  }
  return cached;
}

export type Direction = "UP" | "DOWN";

/**
 * Take liquidity on one side of a round.
 *
 * Up and Down share a single book, so backing DOWN is expressed as BUY_NO. Both
 * are sent IOC (orderType 2) so nothing rests behind a one-tap trade — a resting
 * remainder would lock escrow invisibly for a user who thinks they either got
 * filled or did not.
 */
export async function takeSide(opts: {
  pool: `0x${string}`;
  direction: Direction;
  /** Probability 0..1 the taker is willing to pay for the side they are backing. */
  limitPrice: number;
  /** Whole outcome contracts. */
  contracts: number;
}) {
  const { pool, direction, limitPrice, contracts } = opts;

  if (!(limitPrice > 0 && limitPrice < 1)) throw new Error("limitPrice must be between 0 and 1");
  if (!(contracts > 0)) throw new Error("contracts must be positive");

  // `price` is always quoted on the YES axis. Backing DOWN at p means YES at 1-p.
  const yesPrice = direction === "UP" ? limitPrice : 1 - limitPrice;

  // Integer-only conversion: the SDK's float path can land a few wei off the tick
  // grid and get rejected with InvalidPrice.
  const price = BigInt(Math.round(yesPrice * PROB_SCALE));
  const quantity = BigInt(Math.round(contracts * QTY_SCALE));

  const ex = exchange();
  const res = await ex.trader.placeOrder({
    pool,
    side: direction === "UP" ? "BUY_YES" : "BUY_NO",
    price,
    quantity,
    orderType: 2, // ImmediateOrCancel
  });

  // A reverted write does not throw on every tier — the receipt is authoritative.
  if (res.receipt && res.receipt.status !== "success") {
    throw new Error(`transaction reverted: ${res.receipt.transactionHash}`);
  }
  return res;
}
