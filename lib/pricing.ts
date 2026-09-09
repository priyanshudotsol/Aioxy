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
 * Longest lag we measure directly. Beyond this the sample count inside the
 * window collapses and the estimate turns into noise, so the remainder of a
 * long horizon is bridged with the usual sqrt scaling.
 */
const MAX_LAG_SEC = 300;

/** Shortest lag worth measuring — below this the oracle's own staleness dominates. */
const MIN_LAG_SEC = 15;

/**
 * Correction for the residual gap between measured and realised dispersion.
 *
 * Measured on 9h of BTC and ETH oracle history by scoring
 * `z = ln(p(t+H)/p(t)) / (sigma * sqrt(H))` at H of 60s, 300s and 900s: a
 * correct sigma puts `std(z)` at 1.0. Lag-matched estimation over an hour still
 * ran hot at 1.03-1.26, and this constant brings it to 0.89-1.09 across both
 * assets and all three horizons. Re-derive it if the feed's behaviour changes.
 */
const CALIBRATION = 1.15;

/**
 * Rolling volatility estimated from oracle ticks, matched to the horizon asked for.
 *
 * The obvious estimator — variance of consecutive log returns, normalised by
 * elapsed time and scaled by sqrt(tau) — understates this feed badly. Measured
 * against realised moves it produced `std(z)` of 1.27 to 1.45, meaning real
 * moves were ~40% larger than the model expected. Two things cause that, and
 * neither is fixed by a constant:
 *
 *   The oracle republishes stale prices. It stamps a fresh `updatedAtMs` on an
 *   unchanged value, so sampling at a fixed cadence collects long runs of exact
 *   zeros punctuated by the whole accumulated move.
 *
 *   Returns here are not independent across time. The understatement grew with
 *   the horizon (ETH: 1.31 at 60s, 1.43 at 300s, 1.50 at 900s), which is the
 *   signature of trending — variance over H seconds outruns H times the
 *   per-second variance, so sqrt scaling from one tick to fifteen minutes is
 *   the wrong shape regardless of the constant in front of it.
 *
 * So the dispersion is measured at a lag close to the horizon actually being
 * priced, using overlapping windows, and only the leftover is sqrt-scaled.
 * That is why `sigma` needs the horizon: a 60s round and a 15m round are not
 * two scalings of the same number.
 *
 * An overconfident sigma is not a harmless inaccuracy here. `fair` is
 * `Phi(ln(spot/strike) / (sigma * sqrt(tau)))`, and for a floating-strike round
 * `ln(spot/strike)` IS the return since the round opened — so shrinking sigma
 * drives every reading toward 0 or 1 and turns the desks into maximum-conviction
 * momentum followers that buy whichever way price has already moved, and swap
 * sides wholesale when the trend does.
 */
export class VolEstimator {
  private ticks: { t: number; px: number }[] = [];
  /** Cold-start guess: ~55% annualised, a reasonable BTC/ETH baseline. */
  private readonly fallback = 0.55 / Math.sqrt(365 * 24 * 3600);

  /**
   * An hour, not ten minutes. Lag-matched estimation needs enough span to hold
   * a useful number of non-overlapping horizons, and the wider window measured
   * better at every horizon tested (std(z) 1.15-1.20 against 1.27-1.45).
   */
  constructor(private windowMs = 60 * 60 * 1000) {}

  push(px: number, tMs = Date.now()) {
    if (!(px > 0)) return;
    const last = this.ticks[this.ticks.length - 1];
    // The feed republishes the same price; ignore exact repeats at the same ms.
    if (last && last.t === tMs) return;
    this.ticks.push({ t: tMs, px });
    const cutoff = tMs - this.windowMs;
    while (this.ticks.length > 2 && this.ticks[0].t < cutoff) this.ticks.shift();
  }

  /**
   * Per-second sigma appropriate for pricing a `tauSec`-second horizon.
   *
   * Callers scale this by `sqrt(tau)`, so the value returned is deliberately
   * horizon-dependent: it is the per-second rate that reproduces the dispersion
   * actually observed over a window of that length.
   */
  sigma(tauSec = 60): number {
    const want = Math.min(MAX_LAG_SEC, Math.max(MIN_LAG_SEC, tauSec || MIN_LAG_SEC));
    // Step down if the window cannot support the requested lag yet — a short
    // history should degrade toward a shorter measurement, not to the cold-start
    // constant, which knows nothing about today.
    for (let lag = want; lag >= MIN_LAG_SEC; lag /= 2) {
      const s = this.sigmaAtLag(lag);
      if (s != null) return s;
    }
    return this.fallback;
  }

  /**
   * Dispersion of log returns measured over `lagSec`, returned as a per-second
   * rate. Windows overlap, which correlates the samples and costs some
   * effective sample size, but at this tick density that is a far better trade
   * than the handful of disjoint windows an hour would otherwise yield.
   */
  private sigmaAtLag(lagSec: number): number | null {
    if (this.ticks.length < 12) return null;
    const lagMs = lagSec * 1000;
    const rs: number[] = [];
    // `j` only ever moves forward: both `ticks[i].t` and the target it chases
    // are increasing, so the whole sweep stays linear.
    let j = 0;
    for (let i = 0; i < this.ticks.length; i++) {
      while (j < this.ticks.length && this.ticks[j].t < this.ticks[i].t + lagMs) j++;
      if (j >= this.ticks.length) break;
      rs.push(Math.log(this.ticks[j].px / this.ticks[i].px));
    }
    if (rs.length < 8) return null;
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const varc = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1);
    const s = Math.sqrt(Math.max(varc, 0));
    // A stalled feed collapses this to zero; report nothing rather than certainty.
    return s > 1e-12 ? (s / Math.sqrt(lagSec)) * CALIBRATION : null;
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
