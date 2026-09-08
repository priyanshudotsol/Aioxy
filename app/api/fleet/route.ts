import { NextRequest, NextResponse, after } from "next/server";
import { createPublicClient, http, formatUnits, isAddress, parseAbi, type Address } from "viem";
import { somniaTestnet } from "viem/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { store } from "@/lib/store";
import { AGENTS } from "@/lib/agents";
import { RISK } from "@/lib/agenttrader";
import { RPC_URL } from "@/lib/config";
import { ensureRunnerAlive } from "@/lib/heartbeat";

export const dynamic = "force-dynamic";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc as Address;

/**
 * Everything the dashboard shows for one owner.
 *
 * Balances are read from CHAIN, not from our trade log — the indexer does not
 * surface binary fills (docs/RESEARCH.md §7) and our own database is not
 * evidence of anything. The log supplies the reasoning; the chain supplies the
 * money.
 */
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner || !isAddress(owner)) {
    return NextResponse.json({ error: "owner required" }, { status: 400 });
  }

  // The heartbeat. Hobby cron fires once a day, which cannot keep a runner
  // alive across a deploy — so the dashboard's own polling revives it. Inside
  // `after()`, and throttled and lease-guarded inside the helper, so a reader
  // waiting on their agents never waits on this.
  after(() => ensureRunnerAlive(req.nextUrl.origin));

  const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC_URL) });
  const now = Math.floor(Date.now() / 1000);
  // A position whose round has ended but which the venue has not resolved is
  // neither open nor settled. Roughly 40% of expired markets on this testnet
  // never post an oracle answer, so this is a real state, not an edge case —
  // and calling it "open" hides the fact that nothing more will happen to it.
  const isAwaiting = (t: { settled: boolean; expiry: number }) => !t.settled && t.expiry <= now;
  const rows = await store.agentsFor(owner);
  const trades = await store.tradesForOwner(owner, 100);

  const agents = await Promise.all(
    rows.map(async (a) => {
      const desk = AGENTS.find((d) => d.id === a.deskId);
      // Scope to THIS agent wallet, not every agent on the desk.
      const mine = trades.filter((t) => (t.agentAddress ?? "").toLowerCase() === a.address.toLowerCase());
      const settled = mine.filter((t) => t.settled && !t.voided);
      const [stt, usdc] = await Promise.all([
        pub.getBalance({ address: a.address as Address }).catch(() => 0n),
        pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a.address as Address] }).catch(() => 0n),
      ]);
      const profile = RISK[(a.risk in RISK ? a.risk : "medium") as keyof typeof RISK];
      return {
        deskId: a.deskId,
        instance: a.idx,
        name: desk?.name ?? a.deskId,
        thesis: desk?.thesis ?? "",
        color: desk?.color ?? "#888",
        address: a.address,
        risk: a.risk,
        status: a.status,
        createdAt: a.createdAt,
        balance: formatUnits(usdc as bigint, 6),
        gas: formatUnits(stt, 18),
        sizePct: profile.sizeFraction,
        maxConcurrent: profile.maxConcurrent,
        trades: mine.length,
        settled: settled.length,
        wins: settled.filter((t) => t.won).length,
        open: mine.filter((t) => !t.settled && !isAwaiting(t)).length,
        awaiting: mine.filter(isAwaiting).length,
        pnl: mine.reduce((acc, t) => acc + (t.pnl ?? 0), 0),
      };
    }),
  );

  const settledAll = trades.filter((t) => t.settled && !t.voided);
  const staked = settledAll.reduce((acc, t) => acc + t.cost, 0);
  const pnl = trades.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
  const totalBalance = agents.reduce((acc, a) => acc + Number(a.balance), 0);

  return NextResponse.json({
    owner,
    agents,
    totals: {
      agents: agents.length,
      balance: totalBalance,
      trades: trades.length,
      settled: settledAll.length,
      wins: settledAll.filter((t) => t.won).length,
      open: trades.filter((t) => !t.settled && !isAwaiting(t)).length,
      awaiting: trades.filter(isAwaiting).length,
      pnl,
      staked,
      roi: staked > 0 ? pnl / staked : null,
    },
    activity: trades.slice(0, 25).map((t) => ({
      id: t.id,
      agentId: t.agentId,
      asset: t.asset,
      intervalSec: t.intervalSec,
      direction: t.direction,
      price: t.price,
      contracts: t.contracts,
      reason: t.reason,
      settled: t.settled,
      awaiting: isAwaiting(t),
      expiry: t.expiry,
      won: t.won ?? null,
      pnl: t.pnl ?? null,
      placedAt: t.placedAt,
      txHash: t.txHash ?? null,
      redeemTx: t.redeemTx ?? null,
      sweepTx: t.sweepTx ?? null,
    })),
  });
}
