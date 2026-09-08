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
