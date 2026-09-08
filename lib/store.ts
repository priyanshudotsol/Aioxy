import "server-only";
import { q, ensureSchema } from "./db";

export type Direction = "UP" | "DOWN";
/** Retained for the historical rows; every new trade is "live". */
export type Mode = "paper" | "live";

export type Trade = {
  id: string;
  agentId: string;
  /** The user this position belongs to. "house" for pre-agent-wallet rows. */
  owner: string;
  /** The agent wallet that actually placed it — the address on the explorer. */
  agentAddress?: string;
  marketId: string;
  pool: string;
  asset: string;
  intervalSec: number;
  strike: number;
  direction: Direction;
  /** Probability paid per contract, 0..1 */
  price: number;
  contracts: number;
  /** price * contracts, in collateral */
  cost: number;
  /** Human-readable justification — the thing that makes an agent legible. */
  reason: string;
  fairValue: number;
  spotAtEntry: number;
  syntheticBook?: boolean;
  mode: Mode;
  txHash?: string;
  placedAt: number;
  expiry: number;
  settled: boolean;
  won?: boolean;
  payout?: number;
  pnl?: number;
  settledAt?: number;
  voided?: boolean;
  /** On-chain redemption of a winning position. */
  redeemTx?: string;
  /** On-chain transfer of the proceeds to the owner's main wallet. */
  sweepTx?: string;
};

export type AgentStats = {
  agentId: string;
  trades: number;
  /** Distinct rounds bet on. Lower than `trades` means repeated views of the
   *  same window, whose outcomes are not independent. */
  rounds: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
  staked: number;
  roi: number | null;
  open: number;
};

export type Delegation = {
  owner: string;
  operator: string;
  deskId: string;
  txHash: string | null;
  grantedAt: number;
  revokedAt: number | null;
};

export type LeaderboardRow = {
  /** One row per TRADER, with every agent they run rolled up. */
  owner: string;
  /** Desk ids they have deployed, for the identity chips. */
  desks: string[];
  /** Agents still running, of `agents` total. */
  live: number;
  trades: number;
  settled: number;
  wins: number;
  open: number;
  /** Distinct agent wallets this owner has run. */
  agents: number;
  pnl: number;
  staked: number;
  roi: number | null;
  lastTradeAt: number;
};

export type AgentWallet = {
  owner: string;
  deskId: string;
  /** Which agent of this desk, for owners running more than one. */
  idx: number;
  /** The agent's own address — it trades its own funds from here. */
  address: string;
  /** AES-256-GCM sealed private key; open with lib/vault.openKey. */
  sealedKey: string;
  risk: "low" | "medium" | "high";
  status: "running" | "paused";
  createdAt: number;
};

/** Postgres returns numerics as strings; every read goes through these. */
const n = (v: unknown) => Number(v ?? 0);
const s2 = (v: unknown) => (v == null ? undefined : String(v));

function rowToTrade(r: Record<string, unknown>): Trade {
  return {
    id: String(r.id),
    agentId: String(r.agentId),
    owner: (r.owner as string) ?? "house",
    agentAddress: s2(r.agentAddress),
    marketId: String(r.marketId),
    pool: String(r.pool),
    asset: String(r.asset),
    intervalSec: n(r.intervalSec),
    strike: n(r.strike),
    direction: r.direction as Direction,
    price: n(r.price),
    contracts: n(r.contracts),
    cost: n(r.cost),
    reason: String(r.reason),
    fairValue: n(r.fairValue),
    spotAtEntry: n(r.spotAtEntry),
    syntheticBook: Boolean(r.syntheticBook),
    mode: r.mode as Mode,
    txHash: s2(r.txHash),
    placedAt: n(r.placedAt),
    expiry: n(r.expiry),
    settled: Boolean(r.settled),
    won: r.won == null ? undefined : Boolean(r.won),
    payout: r.payout == null ? undefined : n(r.payout),
    pnl: r.pnl == null ? undefined : n(r.pnl),
    settledAt: r.settledAt == null ? undefined : n(r.settledAt),
    voided: Boolean(r.voided),
    redeemTx: s2(r.redeemTx),
    sweepTx: s2(r.sweepTx),
  };
}

function rowToAgent(r: Record<string, unknown>): AgentWallet {
  return {
    owner: String(r.owner),
    deskId: String(r.deskId),
    idx: n(r.idx),
    address: String(r.address),
    sealedKey: String(r.sealedKey),
    risk: r.risk as AgentWallet["risk"],
    status: r.status as AgentWallet["status"],
    createdAt: n(r.createdAt),
  };
}

/**
 * Every read and write goes through Postgres.
 *
 * `ensureSchema()` guards each call rather than running as a deploy step: on
 * serverless there is no hook guaranteed to run before the first request, and
 * the DDL is idempotent, so the first query of a cold process creates whatever
 * is missing and every later one resolves an already-settled promise.
 */
class TradeStore {
  private async ready() {
    await ensureSchema();
  }

  /* ── trades ───────────────────────────────────────────────────────────── */

  /** Returns null when the unique index rejects a duplicate position. */
  async add(t: Trade): Promise<Trade | null> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO trades
         (id,"agentId",owner,"agentAddress","marketId",pool,asset,"intervalSec",strike,
          direction,price,contracts,cost,reason,"fairValue","spotAtEntry","syntheticBook",
          mode,"txHash","placedAt",expiry,settled,won,payout,pnl,"settledAt",voided,
          "redeemTx","sweepTx")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        t.id, t.agentId, (t.owner ?? "house").toLowerCase(), t.agentAddress?.toLowerCase() ?? null,
        t.marketId, t.pool, t.asset, t.intervalSec, t.strike, t.direction, t.price, t.contracts,
        t.cost, t.reason, t.fairValue, t.spotAtEntry, Boolean(t.syntheticBook), t.mode,
        t.txHash ?? null, t.placedAt, t.expiry, Boolean(t.settled), t.won ?? null,
        t.payout ?? null, t.pnl ?? null, t.settledAt ?? null, Boolean(t.voided),
        t.redeemTx ?? null, t.sweepTx ?? null,
      ],
    );
    return rows[0] ? rowToTrade(rows[0]) : null;
  }

  /** Does this agent WALLET already hold a position in this round? */
  async hasPosition(agentAddress: string, marketId: string): Promise<boolean> {
    await this.ready();
    const rows = await q(
      `SELECT 1 FROM trades WHERE "agentAddress"=$1 AND "marketId"=$2 LIMIT 1`,
      [agentAddress.toLowerCase(), marketId],
    );
    return rows.length > 0;
  }

  /** Unsettled positions this agent holds — the concurrency cap. */
  async openPositionCount(agentAddress: string): Promise<number> {
    await this.ready();
    const rows = await q<{ n: string }>(
      `SELECT COUNT(*) AS n FROM trades
        WHERE "agentAddress"=$1 AND settled=FALSE AND voided=FALSE`,
      [agentAddress.toLowerCase()],
    );
    return n(rows[0]?.n);
  }

  async tradesForOwner(owner: string, limit = 200): Promise<Trade[]> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM trades WHERE owner=$1 ORDER BY "placedAt" DESC LIMIT $2`,
      [owner.toLowerCase(), limit],
    );
    return rows.map(rowToTrade);
  }

  async all(): Promise<Trade[]> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM trades ORDER BY "placedAt" DESC LIMIT 1000`,
    );
    return rows.map(rowToTrade);
  }

  async byAgent(agentId: string, limit = 500): Promise<Trade[]> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM trades WHERE "agentId"=$1 ORDER BY "placedAt" DESC LIMIT $2`,
      [agentId, limit],
    );
    return rows.map(rowToTrade);
  }

  async pendingSettlement(nowSec: number): Promise<Trade[]> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM trades WHERE settled=FALSE AND expiry<=$1 ORDER BY expiry ASC LIMIT 200`,
      [nowSec],
    );
    return rows.map(rowToTrade);
  }

  async settle(
    id: string,
    outcome: { won: boolean; voided?: boolean; settledAt: number; redeemTx?: string; sweepTx?: string },
  ): Promise<Trade | null> {
    await this.ready();
    const found = await q<Record<string, unknown>>(`SELECT * FROM trades WHERE id=$1`, [id]);
    if (!found[0]) return null;
    const t = rowToTrade(found[0]);
    if (t.settled) return null;

    // A voided round returns the premium: complete sets redeem at par.
    const payout = outcome.voided ? t.cost : outcome.won ? t.contracts : 0;
    const won = outcome.voided ? false : outcome.won;
    const pnl = payout - t.cost;

    const rows = await q<Record<string, unknown>>(
      `UPDATE trades SET settled=TRUE, "settledAt"=$1, voided=$2, won=$3, payout=$4, pnl=$5,
                         "redeemTx"=$6, "sweepTx"=$7
        WHERE id=$8 RETURNING *`,
      [outcome.settledAt, Boolean(outcome.voided), won, payout, pnl,
       outcome.redeemTx ?? null, outcome.sweepTx ?? null, id],
    );
    return rows[0] ? rowToTrade(rows[0]) : null;
  }

  /** Per-desk statistics, computed in SQL rather than by pulling every row. */
  async stats(agentId: string): Promise<AgentStats> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `SELECT
         COUNT(*)                                                       AS trades,
         COUNT(*) FILTER (WHERE settled AND NOT voided)                 AS settled,
         COUNT(*) FILTER (WHERE won)                                    AS wins,
         COUNT(*) FILTER (WHERE settled AND NOT voided AND NOT won)      AS losses,
         COUNT(DISTINCT "marketId")                                     AS rounds,
         COUNT(*) FILTER (WHERE NOT settled)                            AS "open",
         COALESCE(SUM(pnl), 0)                                          AS pnl,
         COALESCE(SUM(cost) FILTER (WHERE settled AND NOT voided), 0)   AS staked
       FROM trades WHERE "agentId"=$1`,
      [agentId],
    );
    const r = rows[0] ?? {};
    const staked = n(r.staked);
    const pnl = n(r.pnl);
    const settled = n(r.settled);
    return {
      agentId,
      trades: n(r.trades),
      rounds: n(r.rounds),
      settled,
      wins: n(r.wins),
      losses: n(r.losses),
      open: n(r.open),
      winRate: settled > 0 ? n(r.wins) / settled : null,
      pnl,
      staked,
      roi: staked > 0 ? pnl / staked : null,
    };
  }

  /**
   * Public standings, one row per TRADER.
   *
   * A SQL aggregate, not rows reduced in JS: this page is public and the table
   * grows with every trade of every user. Left join from `agents` so a funded
   * but untraded trader still appears.
   */
  async leaderboard(limit = 100): Promise<LeaderboardRow[]> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `SELECT
         a.owner,
         COUNT(DISTINCT a.address)                                        AS agents,
         COUNT(DISTINCT a.address) FILTER (WHERE a.status='running')      AS live,
         COALESCE(STRING_AGG(DISTINCT a."deskId", ','), '')               AS desks,
         COUNT(t.id)                                                      AS trades,
         COUNT(t.id) FILTER (WHERE t.settled AND NOT t.voided)            AS settled,
         COUNT(t.id) FILTER (WHERE t.won)                                 AS wins,
         COUNT(t.id) FILTER (WHERE t.id IS NOT NULL AND NOT t.settled)    AS "open",
         COALESCE(SUM(t.pnl), 0)                                          AS pnl,
         COALESCE(SUM(t.cost) FILTER (WHERE t.settled AND NOT t.voided), 0) AS staked,
         COALESCE(MAX(t."placedAt"), MAX(a."createdAt"))                  AS "lastTradeAt"
       FROM agents a
       LEFT JOIN trades t ON t."agentAddress" = a.address
       GROUP BY a.owner
       ORDER BY pnl DESC, trades DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => {
      const staked = n(r.staked);
      const pnl = n(r.pnl);
      return {
        owner: String(r.owner),
        desks: String(r.desks ?? "").split(",").filter(Boolean),
        live: n(r.live),
        agents: n(r.agents),
        trades: n(r.trades),
        settled: n(r.settled),
        wins: n(r.wins),
        open: n(r.open),
        pnl,
        staked,
        roi: staked > 0 ? pnl / staked : null,
        lastTradeAt: n(r.lastTradeAt),
      };
    });
  }

  /* ── profiles ─────────────────────────────────────────────────────────── */

  async profile(owner: string): Promise<{ username: string } | null> {
    await this.ready();
    const rows = await q<{ username: string }>(
      `SELECT username FROM profiles WHERE owner=$1`,
      [owner.toLowerCase()],
    );
    return rows[0] ?? null;
  }

  async profiles(): Promise<Map<string, string>> {
    await this.ready();
    const rows = await q<{ owner: string; username: string }>(`SELECT owner, username FROM profiles`);
    return new Map(rows.map((r) => [r.owner, r.username]));
  }

  /** False when the name is already taken by someone else. */
  async setUsername(owner: string, username: string): Promise<boolean> {
    await this.ready();
    try {
      await q(
        `INSERT INTO profiles (owner, username, "updatedAt") VALUES ($1,$2,$3)
         ON CONFLICT (owner) DO UPDATE SET username=EXCLUDED.username, "updatedAt"=EXCLUDED."updatedAt"`,
        [owner.toLowerCase(), username, Math.floor(Date.now() / 1000)],
      );
      return true;
    } catch {
      return false; // the case-insensitive unique index rejected a duplicate
    }
  }

  /* ── agent wallets ────────────────────────────────────────────────────── */

  async upsertAgent(a: AgentWallet) {
    await this.ready();
    await q(
      `INSERT INTO agents (owner,"deskId",idx,address,"sealedKey",risk,status,"createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (owner,"deskId",idx) DO UPDATE SET
         address=EXCLUDED.address, "sealedKey"=EXCLUDED."sealedKey",
         risk=EXCLUDED.risk, status=EXCLUDED.status`,
      [a.owner.toLowerCase(), a.deskId, a.idx, a.address.toLowerCase(),
       a.sealedKey, a.risk, a.status, a.createdAt],
    );
  }

  /** The next free instance number for this owner and desk. */
  async nextAgentIndex(owner: string, deskId: string): Promise<number> {
    await this.ready();
    const rows = await q<{ m: string | null }>(
      `SELECT MAX(idx) AS m FROM agents WHERE owner=$1 AND "deskId"=$2`,
      [owner.toLowerCase(), deskId],
    );
    return rows[0]?.m == null ? 0 : n(rows[0].m) + 1;
  }

  /** An agent wallet is unique, so its address identifies one instance. */
  async agentByAddress(address: string): Promise<AgentWallet | null> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM agents WHERE address=$1`, [address.toLowerCase()],
    );
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async agentsFor(owner: string): Promise<AgentWallet[]> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM agents WHERE owner=$1 ORDER BY "createdAt" DESC`, [owner.toLowerCase()],
    );
    return rows.map(rowToAgent);
  }

  async agent(owner: string, deskId: string): Promise<AgentWallet | null> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM agents WHERE owner=$1 AND "deskId"=$2 ORDER BY idx ASC LIMIT 1`,
      [owner.toLowerCase(), deskId],
    );
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  /** Every agent the runner should act for. */
  async runningAgents(): Promise<AgentWallet[]> {
    await this.ready();
    const rows = await q<Record<string, unknown>>(`SELECT * FROM agents WHERE status='running'`);
    return rows.map(rowToAgent);
  }

  async setAgentStatus(owner: string, deskId: string, status: AgentWallet["status"]) {
    await this.ready();
    await q(`UPDATE agents SET status=$1 WHERE owner=$2 AND "deskId"=$3`,
      [status, owner.toLowerCase(), deskId]);
  }
}

/** Survive Next.js dev hot-reload, which re-evaluates modules. */
const g = globalThis as unknown as { __aioxyStore?: TradeStore };
export const store = g.__aioxyStore ?? (g.__aioxyStore = new TradeStore());
