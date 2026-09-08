import "server-only";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { somniaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_TESTNET_ADDRESSES, binaryPoolWriteAbi, erc6909Abi, ORDER_KIND } from "@somnia-chain/markets-sdk";
import { outcomeIds } from "./indexer";
import type { Direction } from "./store";
import { PROB_SCALE, QTY_SCALE, RPC_URL, UP, DOWN } from "./config";
import { redeemOutcome } from "./settle";

/**
 * An agent trading its OWN wallet.
 *
 * Chunk 0 (docs/RESEARCH.md §2) proved `placeBinaryOrderFor` is unreachable from
 * an EOA — it reverts `OnlyApprovedContracts()` even when the owner calls it for
 * themselves. The self-send `placeBinaryOrder` path works, so each user's agent
 * holds and spends its own funds. That is the model this file implements.
 */

const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc as Address;

const erc20 = parseAbi([
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

const pub = () => createPublicClient({ chain: somniaTestnet, transport: http(RPC_URL) });

/**
 * A pool must be approved before the agent's first order against it.
 *
 * One pool hosts a whole SERIES of markets — the same address serves many
 * consecutive rounds — so this costs one transaction per series, not per round.
 * Cached per (agent, pool) so we do not re-read the allowance every tick.
 */
const approved = new Set<string>();

async function ensureApproval(key: Hex, pool: Address): Promise<string | null> {
  const account = privateKeyToAccount(key);
  const tag = `${account.address}:${pool}`.toLowerCase();
  if (approved.has(tag)) return null;

  const client = pub();
  const have = await client.readContract({
    address: USDC, abi: erc20, functionName: "allowance", args: [account.address, pool],
  });
  // Approve against this ONE pool only. Note the allowance outlives the round —
  // a pool serves a whole series — so it is scoped by pool, not by round. The
  // real ceiling on losses is the agent wallet's balance, not this number.
  if (have >= 10n ** 12n) {
    approved.add(tag);
    return null;
  }

  const wallet = createWalletClient({ account, chain: somniaTestnet, transport: http(RPC_URL) });
  const hash = await wallet.writeContract({
    address: USDC, abi: erc20, functionName: "approve", args: [pool, 2n ** 200n],
  });
  await client.waitForTransactionReceipt({ hash });
  approved.add(tag);
  return hash;
}

export type AgentFill = {
  filled: boolean;
  txHash?: string;
  approvalTx?: string;
  error?: string;
};

/**
 * Take one side of a round from the agent's own wallet.
 *
 * Sent IOC so nothing rests: a resting remainder would lock the agent's
 * collateral invisibly between ticks, and the runner would have no idea its
 * budget had shrunk.
 */
export async function agentTake(opts: {
  key: Hex;
  pool: Address;
  direction: Direction;
  /** Probability 0..1 the agent will pay for the side it is backing. */
  limitPrice: number;
  contracts: number;
  /** Round expiry in seconds — an order may not outlive its market. */
  expiry: number;
}): Promise<AgentFill> {
  const { key, pool, direction, limitPrice, contracts, expiry } = opts;

  if (!(limitPrice > 0 && limitPrice < 1)) return { filled: false, error: "limitPrice out of range" };
  if (!(contracts > 0)) return { filled: false, error: "contracts must be positive" };

  let approvalTx: string | null = null;
  try {
    approvalTx = await ensureApproval(key, pool);
  } catch (e) {
    return { filled: false, error: `approve failed: ${msg(e)}` };
  }

  // Price is quoted on the YES axis: backing DOWN at p is YES at 1-p.
  const yesPrice = direction === "UP" ? limitPrice : 1 - limitPrice;
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: somniaTestnet, transport: http(RPC_URL) });
  const client = pub();

  try {
    const hash = await wallet.writeContract({
      address: pool,
      abi: binaryPoolWriteAbi,
      functionName: "placeBinaryOrder",
      args: [
        ORDER_KIND[direction === "UP" ? "BUY_YES" : "BUY_NO"],
        BigInt(Math.round(yesPrice * PROB_SCALE)),
        BigInt(Math.round(contracts * QTY_SCALE)),
        BigInt(expiry) * 1_000_000_000n, // expireTimestampNs, capped at market expiry
        2, // ImmediateOrCancel
        0, // CANCEL_TAKER on self-match
        "0x0000000000000000000000000000000000000000", // no builder
        0n,
        0n,
      ],
    });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { filled: false, txHash: hash, error: "reverted" };
    return { filled: true, txHash: hash, approvalTx: approvalTx ?? undefined };
  } catch (e) {
    return { filled: false, approvalTx: approvalTx ?? undefined, error: msg(e) };
  }
}

/**
 * Buy DOWN by minting a complete set and selling the YES leg.
 *
 * Nobody rests `SELL_NO` on this venue, so a plain `BUY_NO` has nothing to
 * cross and DOWN is untakeable — measured live: 0 SELL_NO against 1,040
 * contracts of resting BUY_YES demand. But a complete YES+NO set can always be
 * minted for exactly 1.00 of collateral, and the YES leg sold into that demand.
 * Net cost of the NO is `1 − sellPrice`.
 *
 * The failure mode is benign: if the sell does not fill, the agent is left
 * holding a complete set, which redeems for exactly what it cost. It loses the
 * gas, not the stake.
 */
export async function agentTakeDownViaMint(opts: {
  key: Hex;
  pool: Address;
  /** Whole outcome contracts to end up holding as NO. */
  contracts: number;
  /** Lowest YES price the agent will accept when selling the YES leg. */
  sellLimit: number;
  expiry: number;
}): Promise<AgentFill & { mintTx?: string }> {
  const { key, pool, contracts, sellLimit, expiry } = opts;
  if (!(contracts > 0)) return { filled: false, error: "contracts must be positive" };
  if (!(sellLimit > 0 && sellLimit < 1)) return { filled: false, error: "sellLimit out of range" };

  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: somniaTestnet, transport: http(RPC_URL) });
  const client = pub();

  let approvalTx: string | null = null;
  try {
    approvalTx = await ensureApproval(key, pool);
  } catch (e) {
    return { filled: false, error: `approve failed: ${msg(e)}` };
  }

  // A complete set costs 1.00 of collateral per contract.
  let mintTx: string | undefined;
  try {
    const hash = await wallet.writeContract({
      address: pool,
      abi: binaryPoolWriteAbi,
      functionName: "mintSet",
      args: [account.address, account.address, BigInt(Math.round(contracts * QTY_SCALE))],
    });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { filled: false, error: "mintSet reverted", approvalTx: approvalTx ?? undefined };
    mintTx = hash;
  } catch (e) {
    return { filled: false, error: `mintSet failed: ${msg(e)}`, approvalTx: approvalTx ?? undefined };
  }

  // Sell the YES leg into the resting demand, leaving the NO behind.
  try {
    const hash = await wallet.writeContract({
      address: pool,
      abi: binaryPoolWriteAbi,
      functionName: "placeBinaryOrder",
      args: [
        ORDER_KIND.SELL_YES,
        BigInt(Math.round(sellLimit * PROB_SCALE)),
        BigInt(Math.round(contracts * QTY_SCALE)),
        BigInt(expiry) * 1_000_000_000n,
        2, // IOC — leftover YES would just sit as an unsold leg
        0,
        "0x0000000000000000000000000000000000000000",
        0n,
        0n,
      ],
    });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") {
      const undo = await unwind(key, pool, contracts);
      return { filled: false, mintTx, error: `YES leg did not sell${undo}` };
    }
    return { filled: true, txHash: hash, mintTx, approvalTx: approvalTx ?? undefined };
  } catch (e) {
    // The mint has already spent the collateral at this point. Leaving it as a
    // complete set strands it: no trade is recorded, so nothing settles it and
    // nothing sweeps it, and the wallet simply reads as empty. Put it back.
    const undo = await unwind(key, pool, contracts);
    return { filled: false, mintTx, error: `sell leg failed: ${msg(e)}${undo}` };
  }
}

/** Burn a just-minted set back to collateral. Reported, never thrown. */
async function unwind(key: Hex, pool: Address, contracts: number): Promise<string> {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: somniaTestnet, transport: http(RPC_URL) });
  try {
    const hash = await wallet.writeContract({
      address: pool,
      abi: binaryPoolWriteAbi,
      functionName: "burnSet",
      args: [BigInt(Math.round(contracts * QTY_SCALE))],
    });
    const rcpt = await pub().waitForTransactionReceipt({ hash });
    return rcpt.status === "success"
      ? " — set burned back to collateral"
      : " — BURN REVERTED, collateral is parked in a complete set";
  } catch (e) {
    return ` — BURN FAILED (${msg(e)}), collateral is parked in a complete set`;
  }
}

/** The agent's spendable collateral, in whole tUSDC. */
export async function agentBalance(address: Address): Promise<number> {
  const raw = await pub()
    .readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [address] })
    .catch(() => 0n);
  return Number(raw) / 1e6;
}

/** Risk profile → the numbers that actually enter a decision. */
export const RISK = {
  low: { minEdge: 0.10, sizeFraction: 0.05, maxConcurrent: 1 },
  medium: { minEdge: 0.06, sizeFraction: 0.10, maxConcurrent: 2 },
  high: { minEdge: 0.03, sizeFraction: 0.20, maxConcurrent: 4 },
} as const;

export type Risk = keyof typeof RISK;

/**
 * Contracts to buy, given the agent's balance and its risk profile.
 *
 * A binary contract costs `price` and pays 1, so `balance * fraction / price`
 * is the whole-contract count that risks the intended slice of the wallet.
 * Floored to a whole contract, and never more than the wallet can pay for.
 */
export function sizeFor(balance: number, price: number, risk: Risk): number {
  const { sizeFraction } = RISK[risk];
  if (!(price > 0) || balance <= 0) return 0;
  const budget = balance * sizeFraction;
  return Math.max(0, Math.min(Math.floor(budget / price), Math.floor(balance / price)));
}

const msg = (e: unknown) =>
  String(e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : e).slice(0, 200);

/**
 * Recover collateral an agent is sitting on that no trade record knows about.
 *
 * A complete set is one YES and one NO of the same market. It is worth exactly
 * 1.00 whichever way the round goes, so holding one is not a position — it is
 * collateral parked in the wrong form.
 *
 * Agents end up holding them because the synthetic DOWN route mints a set and
 * then sells the YES leg, and the second half can fail after the first half has
 * already spent the money. Nothing noticed: the trade never filled so it was
 * never recorded, and settlement and sweeps only ever look at recorded trades.
 *
 * Two ways back, and which one applies depends on the round:
 *
 *   still trading — `burnSet` undoes the mint directly. Preferred, because it
 *     does not depend on a resolution that roughly 40% of rounds never get.
 *   already finalized — burning is no longer available, so the winning leg is
 *     redeemed instead. The set holds both legs, so the payout is the same.
 */
export async function burnCompleteSets(
  key: Hex,
  markets: {
    marketId: string;
    binaryPoolAddress: string;
    yesTokenId?: string;
    noTokenId?: string;
    finalized?: boolean;
    winningOutcome?: number | null;
  }[],
): Promise<{ burned: number; txs: string[]; errors: string[] }> {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: somniaTestnet, transport: http(RPC_URL) });
  const client = pub();
  const out = { burned: 0, txs: [] as string[], errors: [] as string[] };

  const singleton = await client
    .readContract({
      address: SOMNIA_TESTNET_ADDRESSES.binarySettlement as Address,
      abi: parseAbi(["function outcomeToken() view returns (address)"]),
      functionName: "outcomeToken",
    })
    .catch(() => null);
  if (!singleton) return { ...out, errors: ["could not resolve the outcome token"] };

  for (const m of markets) {
    const ids = m.yesTokenId && m.noTokenId
      ? { yes: m.yesTokenId, no: m.noTokenId }
      : await outcomeIds(m.marketId).catch(() => null);
    if (!ids) continue;

    const [yes, no] = await Promise.all([
      client.readContract({
        address: singleton as Address, abi: erc6909Abi,
        functionName: "balanceOf", args: [account.address, BigInt(ids.yes)],
      }).catch(() => 0n),
      client.readContract({
        address: singleton as Address, abi: erc6909Abi,
        functionName: "balanceOf", args: [account.address, BigInt(ids.no)],
      }).catch(() => 0n),
    ]);

    // Only the matched part is a set. An unmatched leg is a real position and
    // must be left alone — burning is not allowed to close someone's trade.
    const qty = (yes as bigint) < (no as bigint) ? (yes as bigint) : (no as bigint);
    if (qty <= 0n) continue;

    // A finalized round cannot be un-minted, so the winning leg is redeemed.
    if (m.finalized) {
      const winner = m.winningOutcome === UP ? ids.yes : m.winningOutcome === DOWN ? ids.no : null;
      if (winner == null) {
        out.errors.push(`${m.marketId}: finalized without a winning outcome`);
        continue;
      }
      const res = await redeemOutcome(key, BigInt(winner), Number(qty) / QTY_SCALE);
      if (res.error) out.errors.push(`${m.marketId}: ${res.error}`);
      else {
        out.burned += res.redeemed;
        if (res.txHash) out.txs.push(res.txHash);
      }
      continue;
    }

    try {
      const hash = await wallet.writeContract({
        address: m.binaryPoolAddress as Address,
        abi: binaryPoolWriteAbi,
        functionName: "burnSet",
        args: [qty],
      });
      const rcpt = await client.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") {
        out.errors.push(`burnSet reverted on ${m.marketId}`);
        continue;
      }
      out.burned += Number(qty) / QTY_SCALE;
      out.txs.push(hash);
    } catch (e) {
      out.errors.push(`${m.marketId}: ${msg(e)}`);
    }
  }
  return out;
}
