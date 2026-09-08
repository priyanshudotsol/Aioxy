import { NextRequest, NextResponse } from "next/server";
import { runner } from "@/lib/runner";
import { internalAuthorized } from "@/lib/internal";
import { timingSafeEqual } from "node:crypto";

/**
 * Vercel Cron signs its requests with `Authorization: Bearer $CRON_SECRET`.
 * Accepted alongside the internal secret so the same endpoint works for the
 * platform scheduler, an external one, and the gate scripts.
 */
function cronAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const got = req.headers.get("authorization") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Drive one runner tick.
 *
 * `instrumentation.ts` starts an in-process interval, which works under
 * `next dev` but does not survive serverless — a deployed build would silently
 * stop trading. A cron hitting this endpoint is the shape that survives
 * (chunk 8). It doubles as the only window into what the runner is deciding.
 */
export async function POST(req: NextRequest) {
  if (!internalAuthorized(req) && !cronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const before = runner.status.decisions;
  await runner.tickNow();
  return NextResponse.json({
    ok: true,
    tradesThisTick: runner.status.decisions - before,
    status: runner.status,
  });
}

/** Read-only status, same guard — it names live venues and the last error. */
/**
 * Vercel Cron issues GET, so this both reports status and drives a tick.
 *
 * The runner's in-process interval cannot survive a serverless function, so on
 * Vercel this endpoint IS the clock. Cron's finest granularity is one minute,
 * against a three-second interval locally — fine for hour-long rounds, and the
 * reason short series are better served by a long-running host.
 */
export async function GET(req: NextRequest) {
  const cron = cronAuthorized(req);
  if (!internalAuthorized(req) && !cron) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (cron) {
    const before = runner.status.decisions;
    await runner.tickNow();
    return NextResponse.json({
      ok: true,
      driver: "cron",
      tradesThisTick: runner.status.decisions - before,
      status: runner.status,
    });
  }
  return NextResponse.json(runner.status);
}
