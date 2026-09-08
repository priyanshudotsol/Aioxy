import "server-only";
import { timingSafeEqual } from "node:crypto";

/**
 * Guards endpoints that act on an agent's key.
 *
 * `/api/agent/trade` reaches a user's agent wallet, and identity there is a
 * PUBLIC address — so without this any anonymous caller could force someone
 * else's agent to trade at a terrible price and drain it. Found by auditing the
 * chunk 0–3 gates; see docs/PLAN.md.
 *
 * These routes are for the runner and the gate scripts, never the browser, so a
 * shared secret is the right shape. Missing config denies rather than allows —
 * a hole that only opens in production is worse than a broken dev environment.
 */
export function internalAuthorized(req: Request): boolean {
  const expected = process.env.INTERNAL_SECRET;
  if (!expected || expected.length < 16) return false;
  const got = req.headers.get("x-internal-secret") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
