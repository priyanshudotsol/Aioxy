import { INDEXER_URL, PRICE_FEED_URL } from "./config";

/** Minimal GraphQL POST with a hard timeout — the indexer 504s under load. */
async function gql<T>(url: string, query: string, timeoutMs = 12000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: ctl.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let json: { data?: T; errors?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      // The indexer returns bare text ("upstream request timeout") on overload.
      throw new Error(`indexer: ${text.slice(0, 120)}`);
    }
    if (json.errors) throw new Error(`indexer: ${JSON.stringify(json.errors).slice(0, 200)}`);
    return json.data as T;
  } finally {
    clearTimeout(t);
  }
}

export const idx = <T>(q: string, ms?: number) => gql<T>(INDEXER_URL, q, ms);
export const feed = <T>(q: string, ms?: number) => gql<T>(PRICE_FEED_URL, q, ms);

export const nowSec = () => Math.floor(Date.now() / 1000);

export type Round = {
  venueId?: string;
  marketId: string;
  asset: string;
  strike: string;
  intervalSec: string;
  expiry: string;
  tradingStart: string;
  binaryPoolAddress: string;
  yesTokenId: string;
  noTokenId: string;
  tradeCount: string;
  lastPrice: string | null;
  clobStatus: string | null;
  finalized: boolean;
};

export type Settled = Round & {
  winningOutcome: number | null;
  payoutNumerators: string[] | null;
  payoutDenominator: string | null;
  resolvedAtTimestamp: string | null;
  resolvedAtBlock: string | null;
  closingMid: string | null;
  voided: boolean | null;
};

const ROUND_FIELDS = `
  marketId asset strike intervalSec expiry tradingStart
  binaryPoolAddress yesTokenId noTokenId
  tradeCount lastPrice clobStatus finalized
`;

/**
 * Assets we can price. The oracle feed only publishes BTC and ETH, and other
 * venues list test assets (BOTNAV) we have no spot for — filtering by asset is
 * both safer and more meaningful than filtering by venue.
 */
const TRADEABLE = ["BTC", "ETH"];
const ASSET_FILTER = `asset:{_in:[${TRADEABLE.map((a) => `"${a}"`).join(",")}]}`;

/**
 * Longest round we treat as an event contract. Some venues list multi-week
 * binaries; those are a different product and their pricing is dominated by
 * drift rather than the short-horizon volatility this model assumes.
 */
const MAX_INTERVAL_SEC = 86400;
const INTERVAL_FILTER = `intervalSec:{_lte:"${MAX_INTERVAL_SEC}"}`;

/**
 * Rounds still open for trading, soonest expiry first.
 *
 * Deliberately NOT scoped to a venue. Several venues run in parallel with
 * different cadences: a fast 60s/300s series and a slower 1h/4h/1d series. The
 * fast series is bursty and stalls for minutes at a time, so keying off "the
 * venue that created the newest market" latches onto a venue whose rounds have
 * all expired while genuinely live rounds sit on another. Selecting by what is
 * actually open, across venues, is the only correct read.
 */
export async function liveRounds(limit = 12): Promise<Round[]> {
  const d = await idx<{ Market: Round[] }>(`{
    Market(where:{
      marketType:{_eq:"BINARY"}, ${ASSET_FILTER}, ${INTERVAL_FILTER},
      finalized:{_eq:false}, expiry:{_gt:"${nowSec()}"},
      clobStatus:{_eq:"Trading"}
    }, order_by:{expiry:asc}, limit:${limit}){ ${ROUND_FIELDS} venueId }
  }`);
  return d.Market;
}

/** Most recently resolved rounds — the substrate for the settlement proof feed. */
export async function settledRounds(limit = 12): Promise<Settled[]> {
  const d = await idx<{ Market: Settled[] }>(`{
    Market(where:{
      marketType:{_eq:"BINARY"}, ${ASSET_FILTER}, ${INTERVAL_FILTER}, finalized:{_eq:true}
    }, order_by:{resolvedAtTimestamp:desc}, limit:${limit}){
      ${ROUND_FIELDS}
      winningOutcome payoutNumerators payoutDenominator
      resolvedAtTimestamp resolvedAtBlock closingMid voided
    }
  }`);
  return d.Market;
}

export type BookLevel = { price: number; qty: number };

/**
 * Resting book for one market, split by what a TAKER can actually cross.
 *
 * An earlier version normalised everything onto a single "YES axis" and assumed
 * a `BUY_NO` could cross a resting `BUY_YES` — "two opposite-side buyers mint a
 * fresh pair". **That is not how this CLOB matches.** Live proof: a market with
 * 200 contracts of `BUY_YES` resting at 0.684 and no `SELL_NO` rejected every
 * `BUY_NO` with `ImmediateOrCancelNoFill()`, at every price. The agents chose
 * DOWN repeatedly and every order reverted.
 *
 * So the two sides are kept apart:
 *   yesAsks — `SELL_YES` orders. Cross these to buy UP.
 *   noAsks  — `SELL_NO` orders. Cross these to buy DOWN.
 *
 * A side with nothing resting is not tradeable, and an agent must stand down on
 * it rather than send an order that cannot fill.
 */
export async function orderBook(marketId: string) {
  const d = await idx<{
    Order: {
      price: string;
      quantityRemaining: string;
      isBid: boolean;
      side: string | null;
    }[];
  }>(`{
    Order(where:{market_id:{_eq:"${marketId}"}, status:{_eq:"Open"}}, limit:200){
      price quantityRemaining isBid side
    }
  }`);

  const yesAsks = new Map<number, number>();
  const noAsks = new Map<number, number>();
  const yesBids = new Map<number, number>();

  for (const o of d.Order) {
    const qty = Number(o.quantityRemaining) / 1e6;
    if (qty <= 0) continue;
    const raw = Number(o.price) / 1e6;
    // Each order's price is quoted in its OWN side's units.
    if (o.side === "SELL_YES") yesAsks.set(raw, (yesAsks.get(raw) ?? 0) + qty);
    else if (o.side === "SELL_NO") noAsks.set(raw, (noAsks.get(raw) ?? 0) + qty);
    else if (o.side === "BUY_YES") yesBids.set(raw, (yesBids.get(raw) ?? 0) + qty);
    // BUY_NO is another taker's bid for the side we would be buying — not
    // something we can cross.
  }

  const levels = (m: Map<number, number>, desc: boolean): BookLevel[] =>
    [...m.entries()]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => (desc ? b.price - a.price : a.price - b.price))
      .slice(0, 8);

  return {
    yesAsks: levels(yesAsks, false),
    noAsks: levels(noAsks, false),
    yesBids: levels(yesBids, true),
  };
}

/**
 * Opening price for a floating-strike round.
 *
 * Several series ask "closes at or above its OPENING price" rather than a fixed
 * number. The indexer reports `strike: 0` for those, and the real strike is the
 * oracle price at `tradingStart`. That value never changes once the window has
 * opened, so it is cached permanently.
 */
const openingCache = new Map<string, number | null>();

export async function openingPrice(asset: string, tradingStartSec: number): Promise<number | null> {
  const key = `${asset}:${tradingStartSec}`;
  const hit = openingCache.get(key);
  if (hit !== undefined) return hit;

  const d = await feed<{ PricePoint: { spot: string }[] }>(`{
    PricePoint(
      where:{base:{_eq:"${asset}"}, updatedAtMs:{_lte:"${tradingStartSec * 1000}"}},
      order_by:{updatedAtMs:desc}, limit:1
    ){ spot }
  }`);
  const raw = d.PricePoint[0]?.spot;
  let px: number | null = null;
  if (raw) {
    const v = BigInt(raw);
    px = Number(v / 10n ** 18n) + Number(v % 10n ** 18n) / 1e18;
  }
  // Only cache a real answer — a transient miss must not be sticky.
  if (px != null) openingCache.set(key, px);
  return px;
}

/** Live BTC/ETH spot from the oracle price feed that settles these markets. */
export async function spot(): Promise<Record<string, { spot: string; updatedAtMs: string }>> {
  const d = await feed<Record<string, { spot: string; updatedAtMs: string }[]>>(`{
    BTC: PricePoint(where:{base:{_eq:"BTC"}}, order_by:{updatedAtMs:desc}, limit:1){ spot updatedAtMs }
    ETH: PricePoint(where:{base:{_eq:"ETH"}}, order_by:{updatedAtMs:desc}, limit:1){ spot updatedAtMs }
  }`);
  const out: Record<string, { spot: string; updatedAtMs: string }> = {};
  for (const k of ["BTC", "ETH"]) if (d[k]?.[0]) out[k] = d[k][0];
  return out;
}

/** Resolution state for a set of rounds — used to settle recorded trades. */
export async function resolutions(marketIds: string[]) {
  if (marketIds.length === 0) return new Map<string, { finalized: boolean; winningOutcome: number | null; voided: boolean | null; venueId: string | null }>();
  const list = marketIds.map((m) => `"${m}"`).join(",");
  const d = await idx<{
    Market: { marketId: string; finalized: boolean; winningOutcome: number | null; voided: boolean | null; venueId: string | null }[];
  }>(`{
    Market(where:{marketId:{_in:[${list}]}}, limit:${marketIds.length}){
      marketId finalized winningOutcome voided venueId
    }
  }`);
  return new Map(d.Market.map((m) => [m.marketId, m]));
}

/**
 * Live evidence for the non-custodial claim: how many owners have already
 * delegated order rights to an operator key on this deployment.
 */
export async function delegationStats() {
  const d = await idx<{ OperatorApproval: { id: string }[] }>(`{
    OperatorApproval(limit:1000){ id }
  }`);
  const rows = d.OperatorApproval;
  const owners = new Set<string>();
  const operators = new Set<string>();
  const selectors: Record<string, number> = {};
  for (const r of rows) {
    const parts = r.id.split("_");
    if (parts[0]) owners.add(parts[0]);
    if (parts[1]) operators.add(parts[1]);
    const sel = parts[parts.length - 1];
    if (sel) selectors[sel] = (selectors[sel] ?? 0) + 1;
  }
  return {
    grants: rows.length,
    owners: owners.size,
    operators: operators.size,
    selectors,
    global: rows.filter((r) => r.id.includes("_global_")).length,
  };
}

/** ERC-6909 outcome ids for one market — needed to redeem a settled position. */
export async function outcomeIds(marketId: string): Promise<{ yes: string; no: string } | null> {
  const d = await idx<{ Market: { yesTokenId: string; noTokenId: string }[] }>(`{
    Market(where:{marketId:{_eq:"${marketId}"}}, limit:1){ yesTokenId noTokenId }
  }`);
  const m = d.Market[0];
  return m ? { yes: m.yesTokenId, no: m.noTokenId } : null;
}
