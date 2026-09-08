import type { Direction } from "./store";

/** Everything an agent sees when it decides. */
export type Ctx = {
  asset: string;
  /** Seconds remaining until the round expires. */
  tau: number;
  /** Round length in seconds. */
  interval: number;
  spot: number;
  strike: number;
  /** Model probability that the round settles UP. */
  fair: number;
  /** Per-second volatility of log returns. */
  sigma: number;
  /** Signed fractional drift over the last n seconds. */
  drift: (sec: number) => number;
  /**
   * Cost to buy UP, or null when nothing on the book offers UP.
   *
   * Asks on the Up axis are traders willing to give you UP (selling YES or
   * buying NO); bids are traders who want UP. You can only buy the side someone
   * is actually offering, so an absent side is null rather than a guessed price.
   */
  priceUp: number | null;
  /** Cost to buy DOWN, or null when no resting bid can be crossed. */
  priceDown: number | null;
  /**
   * Liquidity a TAKER can actually cross, per direction.
   *
   * Named for the trade they enable rather than for a book side: `SELL_YES` is
   * the only thing a BUY_YES fills against, and `SELL_NO` the only thing a
   * BUY_NO fills against. Calling these "bid" and "ask" is what let an earlier
   * version quietly measure the wrong quantity.
   */
  depthUp: number;
  depthDown: number;
  /**
   * Resting `BUY_YES` depth — other traders' demand for UP.
   *
   * Not crossable by us (we are also a buyer), but it is the honest read on
   * which way the book is leaning.
   */
  demandUp: number;
  /** True when the book was empty and a synthetic spread was assumed. */
  synthetic: boolean;
};

export type Decision = {
  direction: Direction;
  /** Limit probability the agent will pay. */
  price: number;
  /**
   * Conviction as a fraction (0.2–1.0) of the risk profile's budget. The runner
   * turns it into a contract count using the wallet balance and the price, so
   * the same decision stakes proportionally on a $10 wallet and a $1,000 one.
   */
  contracts: number;
  reason: string;
} | null;

export type Agent = {
  id: string;
  name: string;
  thesis: string;
  /** One-line description of what it actually looks at. */
  blurb: string;
  color: string;
  decide: (c: Ctx) => Decision;
};

/**
 * Conviction, 0.2 to 1.0 — a FRACTION of the risk budget, not a contract count.
 *
 * This used to return contracts directly, capped at 5. That cap silently became
 * the binding constraint on every trade: at 6c a contract a 10%-of-wallet
 * setting allows ~14, so the agent staked 24c of an 8.7 wallet and the risk
 * profile never applied. Sizing in contracts cannot work when contract prices
 * span 2c to 98c — conviction has to be relative, and the wallet decides scale.
 */
const conviction = (edge: number) => Math.max(0.2, Math.min(1, edge * 8));

const pctS = (x: number) => `${(x * 100).toFixed(0)}%`;
const money = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/**
 * Edge on each side: model probability minus what that side costs to take. A
 * side with no resting liquidity scores -Infinity so it can never be chosen.
 *
 * `floor` is the model probability below which a side is not worth owning
 * however cheap it looks, and it exists because of a real hole this code had.
 * A side quoted at 5c against a model that says 15c shows ten points of edge,
 * and in expectation that is genuine — but it is also a bet the model itself
 * expects to lose 85% of the time, priced in the tail where the estimate is
 * least trustworthy, because a probability that far from 0.5 is dominated by
 * the volatility guess rather than by the distance to the strike.
 *
 * Worse, it was not a free choice. Synthetic DOWN costs `1 - bestBid`, so
 * DOWN's edge reduces to `bestBid - fair`: when the model turns bearish the bid
 * is already below fair and DOWN becomes unreachable. Without a floor the loser
 * of that comparison is always DOWN, and the agent answers a bearish read by
 * buying the bullish side. Every losing trade on record was that mistake.
 */
function edges(c: Ctx, floor = 0) {
  const pUp = c.fair;
  const pDown = 1 - c.fair;
  return {
    up: c.priceUp == null || pUp < floor ? -Infinity : pUp - c.priceUp,
    down: c.priceDown == null || pDown < floor ? -Infinity : pDown - c.priceDown,
  };
}

/**
 * Pick whichever tradeable side carries more edge, if either clears the bar.
 *
 * `floor` is passed through to `edges` — see the note there. Standing down is
 * a valid answer: a strategy with a bearish read and no reachable DOWN should
 * take nothing, not take UP.
 */
function best(
  c: Ctx,
  bar: number,
  reason: (d: Direction, e: number) => string,
  floor = 0,
): Decision {
  const e = edges(c, floor);
  const dir: Direction = e.up >= e.down ? "UP" : "DOWN";
  const edge = Math.max(e.up, e.down);
  if (!Number.isFinite(edge) || edge < bar) return null;
  const price = dir === "UP" ? c.priceUp : c.priceDown;
  if (price == null) return null;
  return { direction: dir, price, contracts: conviction(edge), reason: reason(dir, edge) };
}

/**
 * The model probability below which no strategy will buy a side.
 *
 * Not a view about odds — a view about this model. Below roughly a third, the
 * fair value is mostly the volatility estimate rather than the distance to the
 * strike, and that estimate is the least reliable input we have.
 */
const TAIL_FLOOR = 0.3;

export const AGENTS: Agent[] = [
  {
    id: "clockwork",
    name: "Clockwork",
    thesis: "Time decay",
    blurb:
      "Near expiry an outcome is almost determined, but books are slow to price certainty. Trades the gap in the last quarter of a round.",
    color: "#8b7cf6",
    decide: (c) => {
      // Only in the closing stretch, and only when the model is confident.
      if (c.tau > c.interval * 0.35) return null;
      if (Math.abs(c.fair - 0.5) < 0.22) return null;
      return best(
        c,
        0.06,
        (d, e) =>
          `${c.tau.toFixed(0)}s left and spot is ${money(Math.abs(c.spot - c.strike))} ${
            c.spot >= c.strike ? "above" : "below"
          } the strike — the model says ${pctS(c.fair)} UP but ${d} is only ${pctS(
            (d === "UP" ? c.priceUp : c.priceDown) ?? 0,
          )}. Taking ${d} on ${pctS(e)} of edge.`,
        // "Books are slow to price certainty" means backing the outcome the
        // model calls certain. Buying the other side because it is cheap is the
        // opposite of this thesis, and it is what lost money.
        0.5,
      );
    },
  },
  {
    id: "driftwood",
    name: "Driftwood",
    thesis: "Momentum",
    blurb:
      "Short-horizon drift in the oracle tends to persist across one round. Extrapolates the last 30 seconds and trades where the book has not caught up.",
    color: "#22d3ee",
    decide: (c) => {
      // Needs time left for the drift to actually play out.
      if (c.tau < c.interval * 0.25) return null;
      const d30 = c.drift(30);
      if (Math.abs(d30) < 0.0002) return null;
      // Nudge the model by projecting the observed drift to expiry.
      const projected = c.spot * (1 + d30 * (c.tau / 30));
      const tilt = projected >= c.strike ? 0.08 : -0.08;
      const tilted = Math.min(0.97, Math.max(0.03, c.fair + tilt));
      // Same floor as everywhere else: momentum is a reason to prefer a side,
      // never a reason to buy one the model still expects to lose.
      const eUp = c.priceUp == null || tilted < TAIL_FLOOR ? -Infinity : tilted - c.priceUp;
      const eDown =
        c.priceDown == null || 1 - tilted < TAIL_FLOOR ? -Infinity : 1 - tilted - c.priceDown;
      const dir: Direction = eUp >= eDown ? "UP" : "DOWN";
      const edge = Math.max(eUp, eDown);
      if (!Number.isFinite(edge) || edge < 0.08) return null;
      const price = dir === "UP" ? c.priceUp : c.priceDown;
      if (price == null) return null;
      return {
        direction: dir,
        price,
        contracts: conviction(edge),
        reason: `${c.asset} drifted ${(d30 * 100).toFixed(2)}% over 30s; projected to expiry that lands ${
          projected >= c.strike ? "above" : "below"
        } ${money(c.strike)}. Book has ${dir} at ${pctS(
          price,
        )} against a tilted fair of ${pctS(dir === "UP" ? tilted : 1 - tilted)}.`,
      };
    },
  },
  {
    id: "undertow",
    name: "Undertow",
    thesis: "Mean reversion",
    blurb:
      "Extreme quotes overshoot when the underlying has not actually moved much. Fades prices that imply more certainty than the volatility supports.",
    color: "#f59e0b",
    decide: (c) => {
      // Only interesting while there is still time for a reversion.
      if (c.tau < c.interval * 0.3) return null;
      const upPx = c.priceUp;
      if (upPx == null) return null;
      const extreme = upPx >= 0.78 || upPx <= 0.22;
      if (!extreme) return null;
      // The model must actually disagree — a genuinely determined round is not an overshoot.
      if (c.fair > 0.68 || c.fair < 0.32) return null;
      return best(
        c,
        0.1,
        (d, e) =>
          `Book implies ${pctS(upPx)} UP with ${c.tau.toFixed(
            0,
          )}s to run, but realised vol only supports ${pctS(
            c.fair,
          )}. Fading the overshoot with ${d} at ${pctS(e)} edge.`,
        TAIL_FLOOR,
      );
    },
  },
  {
    id: "contrary",
    name: "Contrary",
    thesis: "Book imbalance",
    blurb:
      "A one-sided book is a crowded side. Takes the thin side when the depth imbalance is not justified by the model.",
    color: "#f43f5e",
    decide: (c) => {
      // Imbalance is only meaningful against a real book.
      if (c.synthetic) return null;

      // Demand for UP (resting BUY_YES) against supply of UP (resting
      // SELL_YES). Both live on the same axis, so the ratio is a genuine
      // lean — unlike comparing UP-side liquidity with DOWN-side liquidity,
      // which are different books and not comparable at all.
      const total = c.demandUp + c.depthUp;
      if (total < 5) return null;
      const demandShare = c.demandUp / total;
      if (demandShare > 0.3 && demandShare < 0.7) return null;

      // Heavy resting demand means the crowd is leaning UP; heavy supply means
      // it is leaning DOWN. Either way we take the side they are not on.
      const crowded: Direction = demandShare >= 0.7 ? "UP" : "DOWN";
      const thin: Direction = crowded === "UP" ? "DOWN" : "UP";
      const price = thin === "UP" ? c.priceUp : c.priceDown;
      if (price == null) return null; // the thin side has nothing to cross
      // A crowded book is a reason to doubt the price, not a reason to buy a
      // side the model puts in the tail. The thin side has to be worth owning
      // on its own merits too.
      const pThin = thin === "UP" ? c.fair : 1 - c.fair;
      if (pThin < TAIL_FLOOR) return null;
      const edge = pThin - price;
      if (edge < 0.05) return null;
      return {
        direction: thin,
        price,
        contracts: conviction(edge),
        reason: `${pctS(Math.max(demandShare, 1 - demandShare))} of resting interest is leaning ${crowded}, but the model puts UP at ${pctS(
          c.fair,
        )}. Taking the other side — ${thin} at ${pctS(price)}.`,
      };
    },
  },
];

export const agentById = (id: string) => AGENTS.find((a) => a.id === id);
