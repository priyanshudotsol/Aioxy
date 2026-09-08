import { FEED_SCALE, STRIKE_SCALE } from "./config";

/** Probability 0..1 -> percent string */
export const pct = (p: number | null | undefined, dp = 0) =>
  p == null ? "—" : `${(p * 100).toFixed(dp)}%`;

/** Strike (cents) -> dollars */
export const toStrike = (raw: string | number | null | undefined) =>
  raw == null ? null : Number(raw) / STRIKE_SCALE;

/** 18-decimal feed price -> dollars, without precision loss on the integer part. */
export function toFeedPrice(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  try {
    const v = BigInt(raw);
    const whole = v / FEED_SCALE;
    const frac = v % FEED_SCALE;
    return Number(whole) + Number(frac) / 1e18;
  } catch {
    return null;
  }
}

export const usd = (n: number | null | undefined, dp = 2) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function windowLabel(intervalSec: number) {
  if (intervalSec < 60) return `${intervalSec}s`;
  if (intervalSec < 3600) return `${intervalSec / 60}m`;
  if (intervalSec < 86400) return `${intervalSec / 3600}h`;
  return `${intervalSec / 86400}d`;
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
