import "server-only";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import path from "path";

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

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "aioxy.db");
const LEGACY_JSON = path.join(DATA_DIR, "trades.json");

function open(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  // WAL lets the runner write while requests read, without blocking either.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id            TEXT PRIMARY KEY,
      agentId       TEXT    NOT NULL,
      owner         TEXT    NOT NULL DEFAULT 'house',
      agentAddress  TEXT,
      marketId      TEXT    NOT NULL,
      pool          TEXT    NOT NULL,
      asset         TEXT    NOT NULL,
      intervalSec   INTEGER NOT NULL,
      strike        REAL    NOT NULL,
      direction     TEXT    NOT NULL,
      price         REAL    NOT NULL,
      contracts     REAL    NOT NULL,
      cost          REAL    NOT NULL,
      reason        TEXT    NOT NULL,
      fairValue     REAL    NOT NULL,
      spotAtEntry   REAL    NOT NULL,
      syntheticBook INTEGER NOT NULL DEFAULT 0,
      mode          TEXT    NOT NULL,
      txHash        TEXT,
      placedAt      INTEGER NOT NULL,
      expiry        INTEGER NOT NULL,
      settled       INTEGER NOT NULL DEFAULT 0,
      won           INTEGER,
      payout        REAL,
      pnl           REAL,
      settledAt     INTEGER,
      voided        INTEGER NOT NULL DEFAULT 0,
      redeemTx      TEXT,
      sweepTx       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trades_agent   ON trades(agentId, placedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_trades_pending ON trades(settled, expiry);

    -- One funded agent wallet per (owner, desk). The key is stored sealed, and
    -- is derivable by the owner from a signature, so this row is a convenience
    -- for us rather than the only copy — see lib/agentkey.ts.
    CREATE TABLE IF NOT EXISTS agents (
      owner        TEXT NOT NULL,
      deskId       TEXT NOT NULL,
      idx          INTEGER NOT NULL DEFAULT 0,
      address      TEXT NOT NULL,
      sealedKey    TEXT NOT NULL,
      risk         TEXT NOT NULL DEFAULT 'medium',
      status       TEXT NOT NULL DEFAULT 'running',
      createdAt    INTEGER NOT NULL,
      PRIMARY KEY (owner, deskId, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

    -- A display name an owner may set for the public leaderboard. Optional:
    -- with no row the board falls back to the wallet address, which is the
    -- honest default for a public record.
    CREATE TABLE IF NOT EXISTS profiles (
      owner     TEXT PRIMARY KEY,
      username  TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_name ON profiles(LOWER(username));

    CREATE TABLE IF NOT EXISTS delegations (
      owner     TEXT NOT NULL,
      operator  TEXT NOT NULL,
      deskId    TEXT NOT NULL,
      txHash    TEXT,
      grantedAt INTEGER NOT NULL,
      revokedAt INTEGER,
      PRIMARY KEY (owner, operator)
    );
  `);
  migrateSchema(db);
  return db;
}

/**
 * Bring a pre-chunk-3 database up to date.
 *
 * The old schema had no `owner` and enforced UNIQUE(agentId, marketId), which
 * made it physically impossible for two users to run the same desk on the same
 * round. Existing rows predate agent wallets, so they belong to the house.
 */
function migrateSchema(db: DatabaseSync) {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(trades)").all() as unknown as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has("owner")) {
    db.exec("ALTER TABLE trades ADD COLUMN owner TEXT NOT NULL DEFAULT 'house'");
    console.log("[store] added trades.owner");
  }
  if (!cols.has("agentAddress")) {
    db.exec("ALTER TABLE trades ADD COLUMN agentAddress TEXT");
    console.log("[store] added trades.agentAddress");
  }
  // Chunk 5: settlement is an on-chain action, so it has transaction hashes.
  if (!cols.has("redeemTx")) db.exec("ALTER TABLE trades ADD COLUMN redeemTx TEXT");
  if (!cols.has("sweepTx")) db.exec("ALTER TABLE trades ADD COLUMN sweepTx TEXT");
  // The old index blocks multi-owner trading outright — drop it, and let the
  // per-owner uniqueness below take over.
  db.exec("DROP INDEX IF EXISTS idx_trades_position");
  // Keyed on the agent WALLET, not (desk, owner): one owner may now run several
  // agents of the same desk, and each is entitled to its own position.
  db.exec("DROP INDEX IF EXISTS idx_trades_position_owner");
  // Guarded: an older database can hold rows that violate this (two owners
  // sharing one agent wallet was possible before agents had instances). Skip
  // rather than crash the whole store on boot.
  try {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_position_agent ON trades(agentAddress, marketId)",
    );
  } catch {
    console.warn("[store] legacy duplicate positions present — per-agent index not applied");
  }
  if (!new Set((db.prepare("PRAGMA table_info(agents)").all() as unknown as { name: string }[]).map((c) => c.name)).has("idx")) {
    db.exec("ALTER TABLE agents ADD COLUMN idx INTEGER NOT NULL DEFAULT 0");
    console.log("[store] added agents.idx");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_trades_owner ON trades(owner, placedAt DESC)");
}

const b = (v: unknown) => (v ? 1 : 0);

function rowToTrade(r: Record<string, unknown>): Trade {
  return {
    id: r.id as string,
    agentId: r.agentId as string,
    owner: (r.owner as string) ?? "house",
    agentAddress: (r.agentAddress as string) ?? undefined,
    marketId: r.marketId as string,
    pool: r.pool as string,
    asset: r.asset as string,
    intervalSec: Number(r.intervalSec),
    strike: Number(r.strike),
    direction: r.direction as Direction,
    price: Number(r.price),
    contracts: Number(r.contracts),
    cost: Number(r.cost),
    reason: r.reason as string,
    fairValue: Number(r.fairValue),
    spotAtEntry: Number(r.spotAtEntry),
    syntheticBook: Boolean(r.syntheticBook),
    mode: r.mode as Mode,
    txHash: (r.txHash as string) ?? undefined,
    placedAt: Number(r.placedAt),
    expiry: Number(r.expiry),
    settled: Boolean(r.settled),
    won: r.won == null ? undefined : Boolean(r.won),
    payout: r.payout == null ? undefined : Number(r.payout),
    pnl: r.pnl == null ? undefined : Number(r.pnl),
    settledAt: r.settledAt == null ? undefined : Number(r.settledAt),
    voided: Boolean(r.voided),
  };
}

/**
 * SQLite-backed store.
 *
 * Uses Node's built-in `node:sqlite`, so this is a real database — transactions,
 * indexes, aggregate queries — with no dependency to install and no service to
 * provision. Reads that used to scan a JSON array in memory are now indexed
 * queries, and the one-position-per-round invariant is a UNIQUE constraint
 * rather than a check the runner has to remember to perform.
 */
class TradeStore {
  private db = open();

  constructor() {
    this.migrateLegacyJson();
  }

  /** Carry over any track record written by the previous file-backed store. */
  private migrateLegacyJson() {
    if (!existsSync(LEGACY_JSON)) return;
    try {
      const rows = JSON.parse(readFileSync(LEGACY_JSON, "utf8")) as Trade[];
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO trades
        (id,agentId,owner,agentAddress,marketId,pool,asset,intervalSec,strike,direction,price,
         contracts,cost,reason,fairValue,spotAtEntry,syntheticBook,mode,txHash,
         placedAt,expiry,settled,won,payout,pnl,settledAt,voided)
        VALUES
        (:id,:agentId,:owner,:agentAddress,:marketId,:pool,:asset,:intervalSec,:strike,:direction,:price,
         :contracts,:cost,:reason,:fairValue,:spotAtEntry,:syntheticBook,:mode,:txHash,
         :placedAt,:expiry,:settled,:won,:payout,:pnl,:settledAt,:voided)
      `);
      this.db.exec("BEGIN");
      for (const t of rows) insert.run(this.params(t));
      this.db.exec("COMMIT");
      renameSync(LEGACY_JSON, `${LEGACY_JSON}.migrated`);
      console.log(`[store] migrated ${rows.length} trades from JSON into SQLite`);
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing open */
      }
      console.warn("[store] legacy migration skipped:", String(e).slice(0, 120));
    }
  }

  private params(t: Trade) {
    return {
      id: t.id,
      agentId: t.agentId,
      owner: (t.owner ?? "house").toLowerCase(),
      agentAddress: t.agentAddress?.toLowerCase() ?? null,
      marketId: t.marketId,
      pool: t.pool,
      asset: t.asset,
      intervalSec: t.intervalSec,
      strike: t.strike,
      direction: t.direction,
      price: t.price,
      contracts: t.contracts,
      cost: t.cost,
      reason: t.reason,
      fairValue: t.fairValue,
      spotAtEntry: t.spotAtEntry,
      syntheticBook: b(t.syntheticBook),
      mode: t.mode,
      txHash: t.txHash ?? null,
      placedAt: t.placedAt,
      expiry: t.expiry,
      settled: b(t.settled),
      won: t.won == null ? null : b(t.won),
      payout: t.payout ?? null,
      pnl: t.pnl ?? null,
      settledAt: t.settledAt ?? null,
      voided: b(t.voided),
    };
  }

  async add(t: Trade): Promise<Trade | null> {
    try {
      this.db
        .prepare(
          `INSERT INTO trades
           (id,agentId,owner,agentAddress,marketId,pool,asset,intervalSec,strike,direction,price,
            contracts,cost,reason,fairValue,spotAtEntry,syntheticBook,mode,txHash,
            placedAt,expiry,settled,won,payout,pnl,settledAt,voided)
           VALUES
           (:id,:agentId,:owner,:agentAddress,:marketId,:pool,:asset,:intervalSec,:strike,:direction,:price,
            :contracts,:cost,:reason,:fairValue,:spotAtEntry,:syntheticBook,:mode,:txHash,
            :placedAt,:expiry,:settled,:won,:payout,:pnl,:settledAt,:voided)`,
        )
        .run(this.params(t));
      return t;
    } catch (e) {
      // The UNIQUE index rejected a second position in the same round.
      if (String(e).includes("UNIQUE")) return null;
      throw e;
    }
  }

  /** Does this agent WALLET already hold a position in this round? */
  async hasPosition(agentAddress: string, marketId: string): Promise<boolean> {
    const r = this.db
      .prepare("SELECT 1 AS hit FROM trades WHERE agentAddress=? AND marketId=? LIMIT 1")
      .get(agentAddress.toLowerCase(), marketId);
    return Boolean(r);
  }

  /** Unsettled positions this owner holds on this desk — the concurrency cap. */
  async openPositionCount(agentAddress: string): Promise<number> {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE agentAddress=? AND settled=0 AND voided=0")
      .get(agentAddress.toLowerCase()) as { n: number };
    return Number(r.n);
  }

  /** Every trade placed for one owner, newest first. */
  async tradesForOwner(owner: string, limit = 200): Promise<Trade[]> {
    const rows = this.db
      .prepare("SELECT * FROM trades WHERE owner=? ORDER BY placedAt DESC LIMIT ?")
      .all(owner.toLowerCase(), limit) as unknown as Record<string, unknown>[];
    return rows.map(rowToTrade);
  }

  async all(): Promise<Trade[]> {
    return this.db
      .prepare("SELECT * FROM trades ORDER BY placedAt DESC")
      .all()
      .map(rowToTrade);
  }

  async byAgent(agentId: string, limit = 500): Promise<Trade[]> {
    return this.db
      .prepare("SELECT * FROM trades WHERE agentId=? ORDER BY placedAt DESC LIMIT ?")
      .all(agentId, limit)
      .map(rowToTrade);
  }

  async pendingSettlement(nowSec: number): Promise<Trade[]> {
    return this.db
      .prepare("SELECT * FROM trades WHERE settled=0 AND expiry<=? ORDER BY expiry ASC LIMIT 200")
      .all(nowSec)
      .map(rowToTrade);
  }

  async settle(
    id: string,
    outcome: { won: boolean; voided?: boolean; settledAt: number; redeemTx?: string; sweepTx?: string },
  ): Promise<Trade | null> {
    const row = this.db.prepare("SELECT * FROM trades WHERE id=?").get(id);
    if (!row) return null;
    const t = rowToTrade(row as Record<string, unknown>);
    if (t.settled) return null;

    // A voided round returns the premium: complete sets redeem at par.
    const payout = outcome.voided ? t.cost : outcome.won ? t.contracts : 0;
    const won = outcome.voided ? false : outcome.won;
    const pnl = payout - t.cost;

    this.db
      .prepare(
        `UPDATE trades SET settled=1, settledAt=?, voided=?, won=?, payout=?, pnl=?,
                           redeemTx=?, sweepTx=? WHERE id=?`,
      )
      .run(outcome.settledAt, b(outcome.voided), b(won), payout, pnl,
           outcome.redeemTx ?? null, outcome.sweepTx ?? null, id);

    return { ...t, settled: true, settledAt: outcome.settledAt, voided: Boolean(outcome.voided), won, payout, pnl };
  }

  /** Aggregate in SQL rather than pulling every row into JS. */
  async stats(agentId: string): Promise<AgentStats> {
    const r = this.db
      .prepare(
        `SELECT
           COUNT(*)                                                  AS trades,
           COUNT(DISTINCT marketId)                                  AS rounds,
           COALESCE(SUM(CASE WHEN settled=1 AND voided=0 THEN 1 ELSE 0 END),0) AS settled,
           COALESCE(SUM(CASE WHEN settled=1 AND voided=0 AND won=1 THEN 1 ELSE 0 END),0) AS wins,
           COALESCE(SUM(pnl),0)                                      AS pnl,
           COALESCE(SUM(CASE WHEN settled=1 AND voided=0 THEN cost ELSE 0 END),0) AS staked,
           COALESCE(SUM(CASE WHEN settled=0 THEN 1 ELSE 0 END),0)    AS open
         FROM trades WHERE agentId=?`,
      )
      .get(agentId) as Record<string, number>;

    const settled = Number(r.settled);
    const wins = Number(r.wins);
    const staked = Number(r.staked);
    const pnl = Number(r.pnl);
    return {
      agentId,
      trades: Number(r.trades),
      rounds: Number(r.rounds),
      settled,
      wins,
      losses: settled - wins,
      winRate: settled ? wins / settled : null,
      pnl,
      staked,
      roi: staked > 0 ? pnl / staked : null,
      open: Number(r.open),
    };
  }

  /**
   * Every trader, ranked by realised P&L.
   *
   * Computed as a SQL aggregate rather than by pulling rows into JS — the table
   * grows with every trade of every user, and this is read on a page anyone can
   * open. `house` is excluded: those are pre-agent-wallet rows with no owner.
   */
  async leaderboard(limit = 100): Promise<LeaderboardRow[]> {
    // Grouped by OWNER: a person's standing is the sum of everything they run,
    // so someone with one good agent and one bad one is judged on the pair.
    // Left join from `agents` so a funded-but-untraded trader still appears.
    const rows = this.db
      .prepare(
        `SELECT
           a.owner,
           COUNT(DISTINCT a.address)                                    AS agents,
           COUNT(DISTINCT CASE WHEN a.status='running' THEN a.address END) AS live,
           GROUP_CONCAT(DISTINCT a.deskId)                              AS desks,
           COUNT(t.id)                                                  AS trades,
           SUM(CASE WHEN t.settled=1 AND t.voided=0 THEN 1 ELSE 0 END)  AS settled,
           SUM(CASE WHEN t.won=1 THEN 1 ELSE 0 END)                     AS wins,
           SUM(CASE WHEN t.id IS NOT NULL AND t.settled=0 THEN 1 ELSE 0 END) AS open,
           COALESCE(SUM(t.pnl), 0)                                      AS pnl,
           COALESCE(SUM(CASE WHEN t.settled=1 AND t.voided=0 THEN t.cost ELSE 0 END), 0) AS staked,
           COALESCE(MAX(t.placedAt), MAX(a.createdAt))                  AS lastTradeAt
         FROM agents a
         LEFT JOIN trades t ON t.agentAddress = a.address
         GROUP BY a.owner
         ORDER BY pnl DESC, trades DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as Record<string, number | string>[];

    return rows.map((r) => ({
      owner: String(r.owner),
      desks: String(r.desks ?? "").split(",").filter(Boolean),
      live: Number(r.live),
      agents: Number(r.agents),
      trades: Number(r.trades),
      settled: Number(r.settled),
      wins: Number(r.wins),
      open: Number(r.open),
      pnl: Number(r.pnl),
      staked: Number(r.staked),
      roi: Number(r.staked) > 0 ? Number(r.pnl) / Number(r.staked) : null,
      lastTradeAt: Number(r.lastTradeAt),
    }));
  }

  /* ── profiles ─────────────────────────────────────────────────────────── */

  async profile(owner: string): Promise<{ username: string } | null> {
    const r = this.db.prepare("SELECT username FROM profiles WHERE owner=?").get(owner.toLowerCase());
    return (r as { username: string }) ?? null;
  }

  /** Every display name, for joining onto the leaderboard in one read. */
  async profiles(): Promise<Map<string, string>> {
    const rows = this.db.prepare("SELECT owner, username FROM profiles").all() as unknown as
      { owner: string; username: string }[];
    return new Map(rows.map((r) => [r.owner, r.username]));
  }

  /** Returns false when the name is already taken by someone else. */
  async setUsername(owner: string, username: string): Promise<boolean> {
    try {
      this.db
        .prepare(
          `INSERT INTO profiles (owner, username, updatedAt) VALUES (?,?,?)
           ON CONFLICT(owner) DO UPDATE SET username=excluded.username, updatedAt=excluded.updatedAt`,
        )
        .run(owner.toLowerCase(), username, Math.floor(Date.now() / 1000));
      return true;
    } catch {
      return false; // the case-insensitive unique index rejected a duplicate
    }
  }

  /* ── agent wallets ────────────────────────────────────────────────────── */

  async upsertAgent(a: AgentWallet) {
    this.db
      .prepare(
        `INSERT INTO agents (owner,deskId,idx,address,sealedKey,risk,status,createdAt)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(owner,deskId,idx) DO UPDATE SET
           address=excluded.address, sealedKey=excluded.sealedKey,
           risk=excluded.risk, status=excluded.status`,
      )
      .run(
        a.owner.toLowerCase(), a.deskId, a.idx, a.address.toLowerCase(),
        a.sealedKey, a.risk, a.status, a.createdAt,
      );
  }

  /** The next free instance number for this owner and desk. */
  async nextAgentIndex(owner: string, deskId: string): Promise<number> {
    const r = this.db
      .prepare("SELECT COALESCE(MAX(idx), -1) AS m FROM agents WHERE owner=? AND deskId=?")
      .get(owner.toLowerCase(), deskId) as { m: number };
    return Number(r.m) + 1;
  }

  /** An agent wallet is unique, so its address identifies one instance. */
  async agentByAddress(address: string): Promise<AgentWallet | null> {
    const r = this.db.prepare("SELECT * FROM agents WHERE address=?").get(address.toLowerCase());
    return (r as unknown as AgentWallet) ?? null;
  }

  async agentsFor(owner: string): Promise<AgentWallet[]> {
    return this.db
      .prepare("SELECT * FROM agents WHERE owner=? ORDER BY createdAt DESC")
      .all(owner.toLowerCase()) as unknown as AgentWallet[];
  }

  async agent(owner: string, deskId: string): Promise<AgentWallet | null> {
    const r = this.db
      .prepare("SELECT * FROM agents WHERE owner=? AND deskId=?")
      .get(owner.toLowerCase(), deskId);
    return (r as unknown as AgentWallet) ?? null;
  }

  /** Every agent the runner should act for. */
  async runningAgents(): Promise<AgentWallet[]> {
    return this.db
      .prepare("SELECT * FROM agents WHERE status='running'")
      .all() as unknown as AgentWallet[];
  }

  async setAgentStatus(owner: string, deskId: string, status: AgentWallet["status"]) {
    this.db
      .prepare("UPDATE agents SET status=? WHERE owner=? AND deskId=?")
      .run(status, owner.toLowerCase(), deskId);
  }

  /* ── delegations ──────────────────────────────────────────────────────── */

  async recordDelegation(d: Omit<Delegation, "revokedAt">) {
    this.db
      .prepare(
        `INSERT INTO delegations (owner,operator,deskId,txHash,grantedAt,revokedAt)
         VALUES (?,?,?,?,?,NULL)
         ON CONFLICT(owner,operator) DO UPDATE SET
           deskId=excluded.deskId, txHash=excluded.txHash,
           grantedAt=excluded.grantedAt, revokedAt=NULL`,
      )
      .run(d.owner.toLowerCase(), d.operator.toLowerCase(), d.deskId, d.txHash, d.grantedAt);
  }

  async revokeDelegation(owner: string, operator: string, at: number) {
    this.db
      .prepare("UPDATE delegations SET revokedAt=? WHERE owner=? AND operator=?")
      .run(at, owner.toLowerCase(), operator.toLowerCase());
  }

  async delegationsFor(owner: string): Promise<Delegation[]> {
    return this.db
      .prepare("SELECT * FROM delegations WHERE owner=? ORDER BY grantedAt DESC")
      .all(owner.toLowerCase()) as unknown as Delegation[];
  }

  async activeDelegations(): Promise<Delegation[]> {
    return this.db
      .prepare("SELECT * FROM delegations WHERE revokedAt IS NULL")
      .all() as unknown as Delegation[];
  }
}

/** Survive Next.js dev hot-reload, which re-evaluates modules. */
const g = globalThis as unknown as { __aioxyStore?: TradeStore };
export const store = g.__aioxyStore ?? (g.__aioxyStore = new TradeStore());
