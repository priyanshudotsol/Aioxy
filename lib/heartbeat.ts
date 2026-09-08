import "server-only";
import { randomUUID } from "node:crypto";
import { q, ensureSchema } from "./db";

/**
 * The clock for a serverless deployment.
 *
 * Vercel's Hobby plan allows a cron to fire at most once a day, so the old
 * `* * * * *` schedule in vercel.json failed the deploy outright. One tick a
 * day is not a trading bot, so the cron no longer supplies the cadence — it
 * only supplies the *kick*. `/api/tick` then ticks in a loop for most of its
 * 300s budget and hands off to a fresh invocation before it is cut short, so a
 * single daily kick keeps a continuous cadence running.
 *
 * A chain that can restart itself can also fork itself: two kicks (the cron and
 * a manual poke) would become two chains, then four. The lease below is what
 * makes the chain single-threaded — exactly one holder drives, everyone else
 * returns immediately, and a holder that dies mid-loop stops renewing so the
 * next kick can take over.
 */

const LEASE_ID = "runner";

/** How long a single invocation ticks before handing off. Under `maxDuration`. */
export const LOOP_BUDGET_MS = Number(process.env.TICK_LOOP_BUDGET_MS ?? 240_000);

/**
 * How long a lease survives without a renewal.
 *
 * Longer than the loop budget so a slow tick does not drop the lease it still
 * holds, short enough that a crashed chain is reclaimable within the hour.
 */
export const LEASE_TTL_MS = Number(process.env.TICK_LEASE_TTL_MS ?? LOOP_BUDGET_MS + 120_000);

/**
 * Chaining is the part that costs money, so it is opt-out and production-only
 * by default: previews get whatever ticks their own request drives.
 */
export function chainEnabled(): boolean {
  if (process.env.DISABLE_AGENTS === "1") return false;
  const flag = process.env.TICK_CHAIN;
  if (flag) return flag === "1";
  return process.env.VERCEL_ENV === "production";
}

export function newLeaseToken(): string {
  return randomUUID();
}

/**
 * Take the lease if it is free or expired. Returns false when someone else
 * holds a live one — the caller should then do nothing rather than tick twice.
 */
export async function acquireLease(token: string, now = Date.now()): Promise<boolean> {
  await ensureSchema();
  const rows = await q(
    `INSERT INTO runner_lease (id, holder, "expiresAt")
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET holder = EXCLUDED.holder, "expiresAt" = EXCLUDED."expiresAt"
       WHERE runner_lease."expiresAt" <= $4
     RETURNING holder`,
    [LEASE_ID, token, now + LEASE_TTL_MS, now],
  );
  return rows.length > 0;
}

/**
 * Push the expiry out, but only for the current holder.
 *
 * The chained invocation calls this with the token it inherited, which is how
 * the handoff keeps the lease continuous — no window where a third party could
 * grab it between one invocation ending and the next starting.
 */
export async function renewLease(token: string, now = Date.now()): Promise<boolean> {
  await ensureSchema();
  const rows = await q(
    `UPDATE runner_lease SET "expiresAt" = $1
       WHERE id = $2 AND holder = $3
     RETURNING holder`,
    [now + LEASE_TTL_MS, LEASE_ID, token],
  );
  return rows.length > 0;
}

/** Give the lease up early — a clean stop, so the next kick starts at once. */
export async function releaseLease(token: string): Promise<void> {
  await ensureSchema();
  await q(`DELETE FROM runner_lease WHERE id = $1 AND holder = $2`, [LEASE_ID, token]);
}

/**
 * Is a chain currently driving the runner?
 *
 * A live lease means some invocation is mid-loop and will hand off before it
 * expires. A missing or expired one means the chain is dead — usually because a
 * deploy replaced the functions underneath it.
 */
export async function leaseIsLive(now = Date.now()): Promise<boolean> {
  await ensureSchema();
  const rows = await q<{ expiresAt: string | number }>(
    `SELECT "expiresAt" FROM runner_lease WHERE id = $1`,
    [LEASE_ID],
  );
  const exp = rows[0]?.expiresAt;
  return exp != null && Number(exp) > now;
}

/**
 * How long a process waits before asking the database about the lease again.
 *
 * `ensureRunnerAlive` hangs off endpoints the dashboard polls every few seconds.
 * Checking on every one of those would be a query per poll per viewer to answer
 * a question whose answer changes about once a day.
 */
const CHECK_EVERY_MS = 30_000;
let checkedAt = 0;

/**
 * Restart the tick chain if nothing is driving it.
 *
 * This is the heartbeat that does not need a scheduler. Vercel's Hobby plan
 * caps cron at once a day, which cannot keep a trading runner alive — a deploy
 * kills the chain and nothing would restart it until midnight. So ordinary read
 * traffic revives it instead: any request to a polled endpoint checks the lease
 * and, if it has lapsed, kicks `/api/tick`, which claims the lease and runs a
 * self-chaining loop that outlives the request that started it.
 *
 * Cheap by construction. One in-process throttle and one lease read stand
 * between a poll and the database, and the kick itself only fires when the
 * runner is genuinely down.
 *
 * Call it from `after()` — a reader waiting on their dashboard must never wait
 * on this.
 */
export async function ensureRunnerAlive(origin: string): Promise<void> {
  if (process.env.DISABLE_AGENTS === "1") return;
  // Serverless only. Anywhere else `instrumentation.ts` is already running the
  // interval in-process, and kicking a chain alongside it would put two drivers
  // on one runner.
  if (process.env.VERCEL !== "1") return;
  const secret = process.env.CRON_SECRET;
  if (!secret) return;

  const now = Date.now();
  if (now - checkedAt < CHECK_EVERY_MS) return;
  checkedAt = now;

  try {
    if (await leaseIsLive(now)) return;
  } catch {
    // A database that cannot answer is not a reason to start a second chain.
    return;
  }

  const base = process.env.TICK_SELF_URL ?? origin;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    // The tick endpoint answers before it starts looping, so this returns in
    // milliseconds and the loop it started carries on without us.
    await fetch(new URL("/api/tick", base), {
      headers: { authorization: `Bearer ${secret}` },
      signal: ac.signal,
      cache: "no-store",
    });
    console.log("[heartbeat] runner was not running — kicked the tick chain");
  } catch (e) {
    console.error("[heartbeat] could not kick the tick chain", e);
  } finally {
    clearTimeout(timer);
  }
}
