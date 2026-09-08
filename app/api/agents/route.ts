import { NextResponse, after } from "next/server";
import { AGENTS } from "@/lib/agents";
import { store } from "@/lib/store";
import { runner } from "@/lib/runner";
import { ensureRunnerAlive } from "@/lib/heartbeat";

export const dynamic = "force-dynamic";

/** Leaderboard: every agent with its live track record, best first. */
export async function GET(req: Request) {
  // A visit to the landing page is also a heartbeat — see the note in /api/fleet.
  after(() => ensureRunnerAlive(new URL(req.url).origin));

  const rows = await Promise.all(
    AGENTS.map(async (a) => ({
      id: a.id,
      name: a.name,
      thesis: a.thesis,
      blurb: a.blurb,
      color: a.color,
      stats: await store.stats(a.id),
    })),
  );
  rows.sort((x, y) => y.stats.pnl - x.stats.pnl);
  return NextResponse.json({ agents: rows, runner: runner.status });
}
