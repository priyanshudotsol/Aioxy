import { NextResponse } from "next/server";
import { runner } from "@/lib/runner";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Liveness for the container.
 *
 * Reports whether the RUNNER is alive, not just the web server — a deployment
 * that serves pages while its agents have silently stopped is the failure this
 * product is most likely to hit, and the one a plain HTTP 200 would hide.
 */
export async function GET() {
  let db = false;
  try {
    await store.leaderboard(1);
    db = true;
  } catch {
    db = false;
  }

  const s = runner.status;
  const staleMs = s.lastTickAt ? Date.now() - s.lastTickAt : null;
  // A tick every few seconds; a minute without one means it has stopped.
  const ticking = staleMs !== null && staleMs < 60_000;
  const healthy = db && s.running && ticking;

  return NextResponse.json(
    {
      ok: healthy,
      db,
      runner: {
        running: s.running,
        live: s.live,
        ticks: s.ticks,
        lastTickMsAgo: staleMs,
        lastError: s.lastError,
      },
    },
    { status: healthy ? 200 : 503 },
  );
}
