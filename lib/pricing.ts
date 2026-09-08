/**
 * The shared pricing spine.
 *
 * Every agent prices a round with the same model, so their disagreements are
 * about inputs and thresholds rather than arithmetic. The model is deliberately
 * simple and defensible: driftless lognormal motion, which is the standard
 * first approximation for a short-horizon touch probability.
 */

/** Abramowitz & Stegun 7.1.26 — max abs error ~1.5e-7, ample here. */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * P(spot >= strike at expiry) under driftless lognormal motion.
 *
 * @param spot   current oracle price
 * @param strike the round's strike
 * @param tau    seconds to expiry
 * @param sigma  per-second volatility of log returns
 *
 * As tau -> 0 this collapses toward 0 or 1 — the effect Clockwork trades.
 */
export function fairUpProbability(
  spot: number,
  strike: number,
  tau: number,
  sigma: number,
): number {
  if (!(spot > 0) || !(strike > 0)) return 0.5;
  // At or past expiry the outcome is determined by where spot sits.
  if (tau <= 0) return spot >= strike ? 1 : 0;
  const denom = sigma * Math.sqrt(tau);
  if (!(denom > 0)) return spot >= strike ? 1 : 0;
  return clampProb(normCdf(Math.log(spot / strike) / denom));
}

/** Keep probabilities off the exact bounds so downstream maths stays finite. */
export const clampProb = (p: number) => Math.min(0.999, Math.max(0.001, p));

/**
 * Rolling per-second volatility estimated from oracle ticks.
 *
 * Ticks arrive irregularly, so each log return is normalised by the actual
 * elapsed time rather than assuming a fixed interval.
 */
export class VolEstimator {
  private ticks: { t: number; px: number }[] = [];
  /** Cold-start guess: ~55% annualised, a reasonable BTC/ETH baseline. */
  private readonly fallback = 0.55 / Math.sqrt(365 * 24 * 3600);

  constructor(private windowMs = 10 * 60 * 1000) {}

  push(px: number, tMs = Date.now()) {
    if (!(px > 0)) return;
    const last = this.ticks[this.ticks.length - 1];
    // The feed republishes the same price; ignore exact repeats at the same ms.
    if (last && last.t === tMs) return;
    this.ticks.push({ t: tMs, px });
    const cutoff = tMs - this.windowMs;
    while (this.ticks.length > 2 && this.ticks[0].t < cutoff) this.ticks.shift();
  }

  /** Per-second sigma of log returns; falls back until enough ticks exist. */
  sigma(): number {
    if (this.ticks.length < 12) return this.fallback;
    const rates: number[] = [];
    for (let i = 1; i < this.ticks.length; i++) {
      const dt = (this.ticks[i].t - this.ticks[i - 1].t) / 1000;
      if (dt <= 0) continue;
      const r = Math.log(this.ticks[i].px / this.ticks[i - 1].px);
      // Variance scales with time, so the per-second rate is r / sqrt(dt).
      rates.push(r / Math.sqrt(dt));
    }
    if (rates.length < 8) return this.fallback;
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const varc = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / (rates.length - 1);
    const s = Math.sqrt(Math.max(varc, 0));
    // Guard against a stalled feed collapsing sigma to zero.
    return s > 1e-9 ? s : this.fallback;
  }

  /** Signed drift over the last `sec` seconds, as a fraction of price. */
  drift(sec: number): number {
    if (this.ticks.length < 3) return 0;
    const cutoff = Date.now() - sec * 1000;
    const recent = this.ticks.filter((t) => t.t >= cutoff);
    if (recent.length < 3) return 0;
    const a = recent[0].px;
    const b = recent[recent.length - 1].px;
    return a > 0 ? (b - a) / a : 0;
  }

  get count() {
    return this.ticks.length;
  }

  latest(): number | null {
    return this.ticks.length ? this.ticks[this.ticks.length - 1].px : null;
  }
}
