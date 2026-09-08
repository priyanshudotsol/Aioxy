import { NextResponse, after } from "next/server";
import { store } from "@/lib/store";
import { AGENTS } from "@/lib/agents";
import { ensureRunnerAlive } from "@/lib/heartbeat";

export const dynamic = "force-dynamic";

/**
 * Public standings, one row per trader.
 *
 * Every trade this product places is on chain already, so the record is public
 * whether we publish it or not — ranking it is the honest version, losses
 * included. A person's standing is the sum of every agent they run, so one
 * good agent does not hide a bad one.
 */
export async function GET(req: Request) {
  // A visit to the board is also a heartbeat — see the note in /api/fleet.
  after(() => ensureRunnerAlive(new URL(req.url).origin));

  const [raw, names] = await Promise.all([store.leaderboard(100), store.profiles()]);

  const rows = raw.map((r) => {
    const username = names.get(r.owner.toLowerCase()) ?? null;
    return {
      ...r,
      username,
      /** What the board calls this trader: their name, or their address. */
      trader: username ?? `${r.owner.slice(0, 6)}…${r.owner.slice(-4)}`,
      // Desk identity chips, in the fixed order the desks are defined.
      deskChips: AGENTS.filter((d) => r.desks.includes(d.id)).map((d) => ({
        id: d.id,
        name: d.name,
        color: d.color,
      })),
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      traders: acc.traders + 1,
      agents: acc.agents + r.agents,
      trades: acc.trades + r.trades,
      pnl: acc.pnl + r.pnl,
      staked: acc.staked + r.staked,
    }),
    { traders: 0, agents: 0, trades: 0, pnl: 0, staked: 0 },
  );

  return NextResponse.json({ rows, totals });
}
