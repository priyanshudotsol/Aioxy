import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * The Postgres connection.
 *
 * Created on first use, never at import. `neon()` throws when DATABASE_URL is
 * missing, and Next evaluates module-level code during `next build` — so an
 * eager client crashes the build on any deploy that has not been provisioned
 * yet. A plain lazy `let` rather than a Proxy: Proxy wrappers break libraries
 * that inspect the client object.
 */
let client: NeonQueryFunction<false, false> | null = null;

export function sql(): NeonQueryFunction<false, false> {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. Provision Postgres (vercel integration add neon) " +
          "and run `vercel env pull .env.local`.",
      );
    }
    client = neon(url);
  }
  return client;
}

/** Parameterised query. `$1`-style placeholders, values passed separately. */
export async function q<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await sql().query(text, params)) as T[];
}

/**
 * Create every table and index if absent.
 *
 * Run once per process on first query rather than as a migration step: there is
 * no deploy hook on serverless that is guaranteed to run before the first
 * request, and every statement here is idempotent.
 */
let ready: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!ready) ready = createSchema();
  return ready;
}

async function createSchema() {
  const s = sql();

  await s`
    CREATE TABLE IF NOT EXISTS trades (
      id             TEXT PRIMARY KEY,
      "agentId"      TEXT NOT NULL,
      owner          TEXT NOT NULL DEFAULT 'house',
      "agentAddress" TEXT,
      "marketId"     TEXT NOT NULL,
      pool           TEXT NOT NULL,
      asset          TEXT NOT NULL,
      "intervalSec"  INTEGER NOT NULL,
      strike         DOUBLE PRECISION NOT NULL,
      direction      TEXT NOT NULL,
      price          DOUBLE PRECISION NOT NULL,
      contracts      DOUBLE PRECISION NOT NULL,
      cost           DOUBLE PRECISION NOT NULL,
      reason         TEXT NOT NULL,
      "fairValue"    DOUBLE PRECISION NOT NULL,
      "spotAtEntry"  DOUBLE PRECISION NOT NULL,
      "syntheticBook" BOOLEAN NOT NULL DEFAULT FALSE,
      mode           TEXT NOT NULL,
      "txHash"       TEXT,
      "placedAt"     BIGINT NOT NULL,
      expiry         BIGINT NOT NULL,
      settled        BOOLEAN NOT NULL DEFAULT FALSE,
      won            BOOLEAN,
      payout         DOUBLE PRECISION,
      pnl            DOUBLE PRECISION,
      "settledAt"    BIGINT,
      voided         BOOLEAN NOT NULL DEFAULT FALSE,
      "redeemTx"     TEXT,
      "sweepTx"      TEXT
    )`;

  await s`CREATE INDEX IF NOT EXISTS idx_trades_agent ON trades ("agentId", "placedAt" DESC)`;
  await s`CREATE INDEX IF NOT EXISTS idx_trades_pending ON trades (settled, expiry)`;
  await s`CREATE INDEX IF NOT EXISTS idx_trades_owner ON trades (owner, "placedAt" DESC)`;
  // One position per agent WALLET per round, enforced by the database rather
  // than by a read-then-write race in the runner.
  await s`CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_position_agent
          ON trades ("agentAddress", "marketId")`;

  await s`
    CREATE TABLE IF NOT EXISTS agents (
      owner       TEXT NOT NULL,
      "deskId"    TEXT NOT NULL,
      idx         INTEGER NOT NULL DEFAULT 0,
      address     TEXT NOT NULL,
      "sealedKey" TEXT NOT NULL,
      risk        TEXT NOT NULL DEFAULT 'medium',
      status      TEXT NOT NULL DEFAULT 'running',
      "createdAt" BIGINT NOT NULL,
      PRIMARY KEY (owner, "deskId", idx)
    )`;
  await s`CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status)`;
  await s`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_address ON agents (address)`;

  await s`
    CREATE TABLE IF NOT EXISTS profiles (
      owner       TEXT PRIMARY KEY,
      username    TEXT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )`;
  // Case-insensitive uniqueness, so two people cannot race for one name.
  await s`CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_name ON profiles (LOWER(username))`;

  // One row, held by whichever invocation is currently driving the tick loop.
  // Serverless has no "is the runner already running?" question a process can
  // answer for itself, so the answer lives in the database.
  await s`
    CREATE TABLE IF NOT EXISTS runner_lease (
      id          TEXT PRIMARY KEY,
      holder      TEXT NOT NULL,
      "expiresAt" BIGINT NOT NULL
    )`;
}
