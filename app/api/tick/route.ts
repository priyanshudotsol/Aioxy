import { NextRequest, NextResponse } from "next/server";
import { runner } from "@/lib/runner";
import { internalAuthorized } from "@/lib/internal";

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
  if (!internalAuthorized(req)) {
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
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(runner.status);
}
