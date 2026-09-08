import { NextRequest, NextResponse, after } from "next/server";
import { runner } from "@/lib/runner";
import { internalAuthorized } from "@/lib/internal";
import { canTrade, TICK_MS } from "@/lib/config";
import {
  LOOP_BUDGET_MS,
  acquireLease,
  chainEnabled,
  newLeaseToken,
  releaseLease,
  renewLease,
} from "@/lib/heartbeat";
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

/** Header the chain uses to hand its lease to the invocation that succeeds it. */
const LEASE_HEADER = "x-runner-lease";

/** Renewing on every tick would be a database write every few seconds. */
const RENEW_EVERY_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive one tick.
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

/**
 * Vercel Cron issues GET, so this both reports status and drives the clock.
 *
 * The runner's in-process interval cannot survive a serverless function, and on
 * Hobby a cron may fire only once a day — so the cron is a kick, not a cadence.
 * One kick claims the lease, ticks at `TICK_MS` for most of the 300s budget in
 * `after()` (the response goes back immediately, so nothing waits on the loop),
 * then calls this endpoint again and passes its lease along. That chain is what
 * keeps a continuous cadence under a once-a-day schedule; the lease is what
 * keeps a second kick from starting a second chain.
 */
export async function GET(req: NextRequest) {
  const cron = cronAuthorized(req);
  if (!internalAuthorized(req) && !cron) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl;
  // `?once=1` is the debugging shape: tick synchronously, report what happened,
  // touch no lease. It is also what an external per-minute scheduler wants.
  if (url.searchParams.get("once") === "1") {
    const before = runner.status.decisions;
    await runner.tickNow();
    return NextResponse.json({
      ok: true,
      driver: "once",
      tradesThisTick: runner.status.decisions - before,
      status: runner.status,
    });
  }

  // A kick is what starts (or continues) the chain. Cron always kicks; the
  // internal secret has to ask, so `/api/tick` stays a plain status read.
  const kick = cron || url.searchParams.get("loop") === "1";
  if (!kick) return NextResponse.json(runner.status);

  // No key means no on-chain path, so a 300s loop would burn compute deciding
  // nothing. Tick once for the status it produces and stop there.
  if (!canTrade()) {
    await runner.tickNow();
    return NextResponse.json({
      ok: true,
      driver: "cron",
      looping: false,
      reason: "no PRIVATE_KEY — nothing to trade with",
      status: runner.status,
    });
  }

  const inherited = req.headers.get(LEASE_HEADER);
  const token = inherited ?? newLeaseToken();
  // An inherited token renews the lease the previous link already held, so the
  // handoff leaves no window for a third party to claim it.
  const held = (inherited ? await renewLease(token) : false) || (await acquireLease(token));
  if (!held) {
    return NextResponse.json({
      ok: true,
      driver: "cron",
      looping: false,
      reason: "another invocation holds the tick lease",
      status: runner.status,
    });
  }

  after(() => runLoop(token, url.origin));

  return NextResponse.json({
    ok: true,
    driver: inherited ? "chain" : "cron",
    looping: true,
    budgetMs: LOOP_BUDGET_MS,
    tickMs: TICK_MS,
    status: runner.status,
  });
}

/**
 * Tick until the budget runs out, then hand the lease to a fresh invocation.
 *
 * Runs inside `after()`, which keeps the function alive up to `maxDuration`
 * after the response — the budget stays under that so the handoff happens
 * before the platform cuts the invocation off mid-tick.
 */
async function runLoop(token: string, origin: string) {
  const started = Date.now();
  let renewedAt = started;
  try {
    while (Date.now() - started < LOOP_BUDGET_MS) {
      await runner.tickNow();
      const now = Date.now();
      if (now - renewedAt >= RENEW_EVERY_MS) {
        // Losing the lease means something else took over. Stop rather than
        // tick alongside it.
        if (!(await renewLease(token, now))) return;
        renewedAt = now;
      }
      const left = LOOP_BUDGET_MS - (Date.now() - started);
      if (left <= 0) break;
      await sleep(Math.min(TICK_MS, left));
    }
  } catch (e) {
    console.error("[tick] loop failed", e);
  }

  if (!chainEnabled()) {
    await releaseLease(token).catch(() => {});
    return;
  }
  await chain(token, origin);
}

/**
 * Ask the platform for the next link.
 *
 * The successor answers before it starts looping, so this resolves in
 * milliseconds; the timeout is only there so a hung request cannot pin this
 * invocation open until `maxDuration`.
 */
async function chain(token: string, origin: string) {
  const base = process.env.TICK_SELF_URL ?? origin;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn("[tick] CRON_SECRET unset — cannot chain, the clock stops here");
    await releaseLease(token).catch(() => {});
    return;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(new URL("/api/tick", base), {
      headers: { authorization: `Bearer ${secret}`, [LEASE_HEADER]: token },
      signal: ac.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`chain returned ${res.status}`);
  } catch (e) {
    // The lease is left to expire rather than deleted: if the successor did
    // start and only the reply was lost, deleting it here would let a third
    // invocation run beside it.
    console.error("[tick] chain failed — the next cron kick restarts it", e);
  } finally {
    clearTimeout(timer);
  }
}
