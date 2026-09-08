import "server-only";
import { AGENTS, type Agent, type Ctx } from "./agents";
import { liveRounds, openingPrice, orderBook, resolutions, spot, nowSec } from "./indexer";
import { fairUpProbability, VolEstimator } from "./pricing";
import { store, type Trade } from "./store";
import { openKey } from "./vault";
import { agentTake, agentTakeDownViaMint, agentBalance, sizeFor, RISK, type Risk } from "./agenttrader";
import { redeemAndSweep } from "./settle";
import { outcomeIds } from "./indexer";
import { toFeedPrice, toStrike } from "./fmt";
import { UP, canTrade, TICK_MS, CROSSING_BUFFER } from "./config";




export type RunnerStatus = {
  running: boolean;
  /** Positions whose round ended but which the venue has never resolved. */
  unresolved?: number;
  /** Last on-chain execution error, verbatim — never swallowed. */
  lastExecError?: string | null;
  /** Why the last tick did or did not trade — the runner was previously silent. */
  lastTick?: {
    rounds: number;
    tradeable: number;
    fundedAgents: number;
    decisions: number;
    intervals: Record<string, number>;
    skipped: Record<string, number>;
  };
  /** Live only. There is no paper mode — a trade is an on-chain transaction. */
  live: boolean;
  ticks: number;
  lastTickAt: number | null;
  lastError: string | null;
  decisions: number;
  /** Venues the currently open rounds belong to — several run in parallel. */
  venues: string[];
};

class Runner {
  private timer: NodeJS.Timeout | null = null;
  private vol = new Map<string, VolEstimator>();
  private busy = false;
  status: RunnerStatus = {
    running: false,
    live: false,
    ticks: 0,
    lastTickAt: null,
    lastError: null,
    decisions: 0,
    venues: [],
  };

  start() {
    if (this.timer) return;
    this.status.live = canTrade();
    // Refuse to pretend. Without a key there is no on-chain path, so the runner
    // stays down rather than accumulating a record that never touched a chain.
    if (!this.status.live) {
      console.warn("[runner] no PRIVATE_KEY — refusing to start (there is no paper mode)");
      return;
    }
    this.status.running = true;
    // Kick immediately so a cold start has data fast, then settle into a cadence.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status.running = false;
  }

  private estimator(asset: string) {
    let v = this.vol.get(asset);
    if (!v) this.vol.set(asset, (v = new VolEstimator()));
    return v;
  }

  /** Run one tick on demand — used by /api/tick (cron) and the gates. */
  async tickNow() {
    await this.tick();
  }

  private async tick() {
    // Ticks are not allowed to overlap — a slow indexer must not stack requests.
    if (this.busy) return;
    this.busy = true;
    try {
      this.status.live = canTrade();

      const px = await spot();
      for (const [asset, row] of Object.entries(px)) {
        const p = toFeedPrice(row.spot);
        if (p != null) this.estimator(asset).push(p, Number(row.updatedAtMs) || Date.now());
      }
      await this.settlePending();
      await this.trade(px);

      this.status.ticks++;
      this.status.lastTickAt = Date.now();
      this.status.lastError = null;
    } catch (e) {
      this.status.lastError = String(e instanceof Error ? e.message : e).slice(0, 200);
    } finally {
      this.busy = false;
    }
  }

  /** Mark expired trades against the round's on-chain resolution. */
  private async settlePending() {
    const pending = await store.pendingSettlement(nowSec());
    this.status.unresolved = 0;
    if (pending.length === 0) return;
    const ids = [...new Set(pending.map((t) => t.marketId))];
    const res = await resolutions(ids);
    for (const t of pending) {
      const r = res.get(t.marketId);
      // The venue has not posted an oracle answer. Measured on Shannon, ~40% of
      // expired markets sit like this indefinitely, so this is not a transient
      // wait — the position is dead but its outcome is genuinely unknown, and
      // inventing a loss here would be a fabrication.
      if (!r || !r.finalized) {
        this.status.unresolved = (this.status.unresolved ?? 0) + 1;
        continue;
      }
      if (r.voided) {
        await store.settle(t.id, { won: false, voided: true, settledAt: nowSec() });
        continue;
      }
      if (r.winningOutcome == null) continue;
      const upWon = r.winningOutcome === UP;
      const won = t.direction === "UP" ? upWon : !upWon;

      // A win is not booked until the payout is redeemed and sent home. A loss
      // has nothing to redeem, so it settles as bookkeeping only.
      let redeemTx: string | undefined;
      let sweepTx: string | undefined;
      if (won && t.owner !== "house") {
        const agent = await store.agent(t.owner, t.agentId);
        const key = agent && openKey(agent.sealedKey);
        const ids = await outcomeIds(t.marketId);
        // The side the agent held: UP is the YES token, DOWN is the NO token.
        const outcomeId = t.direction === "UP" ? ids?.yes : ids?.no;
        if (key && outcomeId) {
          const res = await redeemAndSweep({
            key: key as `0x${string}`,
            owner: t.owner as `0x${string}`,
            outcomeId: BigInt(outcomeId),
            contracts: t.contracts,
          });
          redeemTx = res.redeemTx;
          sweepTx = res.sweepTx;
          if (res.error) this.status.lastExecError = res.error;
        }
      }

      await store.settle(t.id, { won, settledAt: nowSec(), redeemTx, sweepTx });
    }
  }

  private async trade(px: Record<string, { spot: string }>) {
    const diag = {
      rounds: 0,
      tradeable: 0,
      fundedAgents: 0,
      decisions: 0,
      /** Which round lengths the venue is actually running, e.g. {"900": 2}. */
      intervals: {} as Record<string, number>,
      skipped: {} as Record<string, number>,
    };
    this.skip = (why: string) => { diag.skipped[why] = (diag.skipped[why] ?? 0) + 1; };

    // Fetch generously. `liveRounds` orders by soonest expiry, so a small limit
    // starves the long series whenever a fast one is running: a live 60s series
    // creates a round every minute and would fill the first ten slots on its
    // own, hiding every 4h and 1d round behind it.
    const rounds = await liveRounds(24);
    diag.rounds = rounds.length;
    for (const r of rounds) {
      diag.intervals[r.intervalSec] = (diag.intervals[r.intervalSec] ?? 0) + 1;
    }
    this.status.venues = [...new Set(rounds.map((r) => r.venueId).filter(Boolean) as string[])];

    const now = nowSec();

    for (const r of rounds) {
      const tau = Number(r.expiry) - now;
      // Too close to expiry to get filled, or not open for trading.
      if (tau < 5 || r.clobStatus !== "Trading") { this.skip("not-trading"); continue; }

      const spotPx = toFeedPrice(px[r.asset]?.spot);
      if (spotPx == null) continue;

      // A fixed strike is quoted directly; a floating-strike round ("closes at
      // or above its opening price") reports 0 and settles against the oracle
      // price at tradingStart, which we resolve and cache.
      const quoted = toStrike(r.strike) ?? 0;
      const strike =
        quoted > 0 ? quoted : await openingPrice(r.asset, Number(r.tradingStart));
      if (strike == null || strike <= 0) continue;

      const est = this.estimator(r.asset);
      const sigma = est.sigma();
      const fair = fairUpProbability(spotPx, strike, tau, sigma);

      let book: Awaited<ReturnType<typeof orderBook>>;
      try {
        book = await orderBook(r.marketId);
      } catch {
        book = { yesAsks: [], noAsks: [], yesBids: [] };
      }

      // What a taker can actually cross on each side. `SELL_YES` is the only
      // thing a BUY_YES fills against, and `SELL_NO` the only thing a BUY_NO
      // fills against — see the note on orderBook().
      const bestYesAsk = book.yesAsks[0]?.price ?? null;
      const bestNoAsk = book.noAsks[0]?.price ?? null;

      // No resting depth means no observable price, and inventing one flatters
      // the record: an assumed coin-flip counterparty would be selling
      // near-certain outcomes at 0.55, handing the agent ~24 points of edge it
      // never earned. Agents simply stand down instead.
      if (bestYesAsk == null && bestNoAsk == null && book.yesBids.length === 0) {
        this.skip("no-depth");
        continue;
      }
      diag.tradeable++;

      // Each side is priced off the book it would actually cross, in that
      // side's own units, and is null when nothing is resting there. A side
      // with nothing to cross is not tradeable and must not be given a price —
      // pricing DOWN off the UP bids produced orders that could never fill.
      const clamp = (p: number) => Math.min(0.98, Math.max(0.02, p));
      const priceUp = bestYesAsk == null ? null : clamp(bestYesAsk);

      // DOWN has two routes. Directly, by crossing a resting SELL_NO — which
      // almost never exists here. Or synthetically, by minting a complete set
      // for 1.00 and selling the YES leg into resting BUY_YES demand, which
      // costs `1 - bestBid`. Take whichever is cheaper; the synthetic route is
      // usually the only one available at all.
      const bestYesBid = book.yesBids[0]?.price ?? null;
      const mintCost = bestYesBid == null ? null : 1 - bestYesBid;
      const downDirect = bestNoAsk == null ? null : clamp(bestNoAsk);
      const downMint = mintCost == null ? null : clamp(mintCost);
      const priceDown =
        downDirect == null ? downMint : downMint == null ? downDirect : Math.min(downDirect, downMint);
      // Which route the executor must use for this round.
      const downViaMint = priceDown != null && (downDirect == null || (downMint != null && downMint <= downDirect));

      const ctx: Ctx = {
        asset: r.asset,
        tau,
        interval: Number(r.intervalSec),
        spot: spotPx,
        strike,
        fair,
        sigma,
        drift: (s) => est.drift(s),
        priceUp,
        priceDown,
        // Liquidity each direction can actually cross, plus the resting demand
        // for UP, which is the book's lean rather than something we can take.
        // Synthetic DOWN is limited by how much YES the book will absorb.
        depthDown:
          book.noAsks.reduce((a: number, l) => a + l.qty, 0) +
          book.yesBids.reduce((a: number, l) => a + l.qty, 0),
        depthUp: book.yesAsks.reduce((a: number, l) => a + l.qty, 0),
        demandUp: book.yesBids.reduce((a: number, l) => a + l.qty, 0),
        synthetic: false,
      };

      for (const agent of AGENTS) {
        let decision;
        try {
          decision = agent.decide(ctx);
        } catch {
          continue; // a broken strategy must not stop the others
        }
        if (!decision) { this.skip("no-signal"); continue; }
        diag.decisions++;

        // The decision is made ONCE per desk per round, then executed for every
        // user running that desk. Two owners on the same agent get the same
        // view — they differ in size, not in opinion.
        const runners = (await store.runningAgents()).filter((a) => a.deskId === agent.id);
        diag.fundedAgents = Math.max(diag.fundedAgents, runners.length);
        for (const funded of runners) {
          await this.tradeFor(funded, agent.id, decision, ctx, r, { strike, fair, spotPx, now, downViaMint, bestYesBid });
        }
      }
    }

    this.status.lastTick = diag;
  }

  /** Records why a round or decision was passed over; replaced each tick. */
  private skip: (why: string) => void = () => {};

  /**
   * Execute one desk's decision on behalf of one user, from that user's own
   * agent wallet.
   *
   * Every skip here is silent by design: a paused agent, an unfunded wallet or a
   * duplicate position are ordinary states on a tick loop, not errors.
   */
  private async tradeFor(
    funded: Awaited<ReturnType<typeof store.runningAgents>>[number],
    deskId: string,
    decision: NonNullable<ReturnType<Agent["decide"]>>,
    ctx: Ctx,
    r: { marketId: string; binaryPoolAddress: string; asset: string; intervalSec: string; expiry: string },
    meta: {
      strike: number; fair: number; spotPx: number; now: number;
      downViaMint: boolean; bestYesBid: number | null;
    },
  ) {
    const { strike, fair, spotPx, now, downViaMint, bestYesBid } = meta;

    // One position per agent per round PER OWNER.
    if (await store.hasPosition(funded.address, r.marketId)) return this.skip("already-positioned");

    const risk = (funded.risk in RISK ? funded.risk : "medium") as Risk;

    // The risk profile gates whether to act at all, not just how much: an agent
    // set to "low" should decline the marginal edges a "high" agent takes.
    const edge = Math.abs(fair - decision.price);
    if (edge < RISK[risk].minEdge) return this.skip("edge-below-risk-floor");

    const open = await store.openPositionCount(funded.address);
    if (open >= RISK[risk].maxConcurrent) return this.skip("max-concurrent");

    const balance = await agentBalance(funded.address as `0x${string}`);
    // Do not assume unlimited depth: crossing UP consumes asks, DOWN crosses
    // resting bids. Size is the smallest of appetite, book, and wallet.
    const available = decision.direction === "UP" ? ctx.depthUp : ctx.depthDown;
    const limitPrice = Math.min(0.98, decision.price + CROSSING_BUFFER);

    // The wallet and the risk profile set the budget; `decision.contracts` is a
    // conviction FRACTION of it, so a strong read stakes the full slice and a
    // marginal one stakes a fifth. Then capped by what the book can actually
    // absorb.
    const budgeted = sizeFor(balance * decision.contracts, limitPrice, risk);
    const contracts = Math.min(budgeted, Math.floor(available));
    if (contracts < 1) return this.skip(balance < 1 ? "agent-unfunded" : "size-below-one");

    // LIVE ONLY. Every trade in this system is an on-chain transaction — there
    // is no paper path to hide behind, because a record that is not on chain is
    // not evidence of anything.
    const key = openKey(funded.sealedKey);
    if (!key) return this.skip("key-unreadable"); // rotated secret — owner re-deploys

    // Pay up to the buffer past the quote so the order actually crosses.
    const limit = Math.min(0.98, decision.price + CROSSING_BUFFER);

    const useMint = decision.direction === "DOWN" && downViaMint && bestYesBid != null;
    const res = useMint
      ? await agentTakeDownViaMint({
          key: key as `0x${string}`,
          pool: r.binaryPoolAddress as `0x${string}`,
          contracts,
          // Accept the buffer below the bid so the YES leg actually clears.
          sellLimit: Math.max(0.02, bestYesBid - CROSSING_BUFFER),
          expiry: Number(r.expiry),
        })
      : await agentTake({
          key: key as `0x${string}`,
          pool: r.binaryPoolAddress as `0x${string}`,
          direction: decision.direction,
          limitPrice: limit,
          contracts,
          expiry: Number(r.expiry),
        });
    if (!res.filled) {
      this.status.lastExecError = res.error ?? null;
      return this.skip("not-filled");
    }
    const txHash = res.txHash;
    // A trade without a transaction hash is not a trade. Refuse to record one.
    if (!txHash) return this.skip("no-txhash");
    const filled = true;

    void filled;

    const trade: Trade = {
      id: `${deskId}-${r.marketId}-${funded.address}-${now}`,
      agentId: deskId,
      owner: funded.owner,
      agentAddress: funded.address,
      marketId: r.marketId,
      pool: r.binaryPoolAddress,
      asset: r.asset,
      intervalSec: Number(r.intervalSec),
      strike,
      direction: decision.direction,
      // The limit we were willing to pay. A buy fills at or below it, so this
      // is the conservative number — it can understate profit, never overstate.
      price: limit,
      contracts,
      cost: limit * contracts,
      reason: decision.reason,
      fairValue: fair,
      spotAtEntry: spotPx,
      mode: "live",
      txHash,
      placedAt: now,
      expiry: Number(r.expiry),
      settled: false,
    };
    // add() returns null when the UNIQUE index rejects a duplicate — count only
    // what actually landed.
    const saved = await store.add(trade);
    if (saved) this.status.decisions++;
  }
}

const g = globalThis as unknown as { __aioxyRunner?: Runner };
export const runner = g.__aioxyRunner ?? (g.__aioxyRunner = new Runner());
