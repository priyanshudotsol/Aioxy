/**
 * Copy the local SQLite database into Postgres.
 *
 * One-way and idempotent: every insert is ON CONFLICT DO NOTHING, so running it
 * twice changes nothing. The SQLite file is left untouched.
 *
 *   DATABASE_URL=postgres://… npm run migrate:pg
 */
import { DatabaseSync } from "node:sqlite";
import { neon } from "@neondatabase/serverless";
import { readFileSync, existsSync } from "fs";
import path from "path";

for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), dim = (s) => c(90, s);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(bad("\n  DATABASE_URL is not set. Run `vercel env pull .env.local` first.\n"));
  process.exit(1);
}

const file = process.env.SQLITE_PATH ?? path.join(process.cwd(), ".data", "aioxy.db");
if (!existsSync(file)) {
  console.error(bad(`\n  No SQLite database at ${file}\n`));
  process.exit(1);
}

const sql = neon(url);
const db = new DatabaseSync(file);
console.log(`\n  ${c(1, "SQLite → Postgres")}`);
console.log(`  from ${file}`);
console.log(`  to   ${url.replace(/:[^:@]+@/, ":****@")}\n`);

// The app creates its own schema on first query; do the same here so the
// migration can run before the app has ever been hit.
const { ensureSchemaSql } = await import("./schema.mjs").catch(() => ({}));
if (ensureSchemaSql) await ensureSchemaSql(sql);

const b = (v) => v === 1 || v === true;
let counts = {};

/* ── agents ──────────────────────────────────────────────────────────────── */
const agents = db.prepare("SELECT * FROM agents").all();
for (const a of agents) {
  await sql`
    INSERT INTO agents (owner,"deskId",idx,address,"sealedKey",risk,status,"createdAt")
    VALUES (${a.owner},${a.deskId},${a.idx ?? 0},${a.address},${a.sealedKey},
            ${a.risk},${a.status},${a.createdAt})
    ON CONFLICT DO NOTHING`;
}
counts.agents = agents.length;

/* ── profiles ────────────────────────────────────────────────────────────── */
let profiles = [];
try { profiles = db.prepare("SELECT * FROM profiles").all(); } catch { /* table may not exist */ }
for (const p of profiles) {
  await sql`
    INSERT INTO profiles (owner,username,"updatedAt")
    VALUES (${p.owner},${p.username},${p.updatedAt})
    ON CONFLICT DO NOTHING`;
}
counts.profiles = profiles.length;

/* ── trades ──────────────────────────────────────────────────────────────── */
const trades = db.prepare("SELECT * FROM trades").all();
for (const t of trades) {
  await sql`
    INSERT INTO trades
      (id,"agentId",owner,"agentAddress","marketId",pool,asset,"intervalSec",strike,
       direction,price,contracts,cost,reason,"fairValue","spotAtEntry","syntheticBook",
       mode,"txHash","placedAt",expiry,settled,won,payout,pnl,"settledAt",voided,
       "redeemTx","sweepTx")
    VALUES
      (${t.id},${t.agentId},${t.owner ?? "house"},${t.agentAddress ?? null},${t.marketId},
       ${t.pool},${t.asset},${t.intervalSec},${t.strike},${t.direction},${t.price},
       ${t.contracts},${t.cost},${t.reason},${t.fairValue},${t.spotAtEntry},
       ${b(t.syntheticBook)},${t.mode},${t.txHash ?? null},${t.placedAt},${t.expiry},
       ${b(t.settled)},${t.won == null ? null : b(t.won)},${t.payout ?? null},
       ${t.pnl ?? null},${t.settledAt ?? null},${b(t.voided)},
       ${t.redeemTx ?? null},${t.sweepTx ?? null})
    ON CONFLICT DO NOTHING`;
}
counts.trades = trades.length;
db.close();

/* ── verify against Postgres, not against our own loop ───────────────────── */
const after = {
  agents: Number((await sql`SELECT COUNT(*) AS n FROM agents`)[0].n),
  profiles: Number((await sql`SELECT COUNT(*) AS n FROM profiles`)[0].n),
  trades: Number((await sql`SELECT COUNT(*) AS n FROM trades`)[0].n),
};

let failed = false;
for (const k of ["agents", "profiles", "trades"]) {
  const good = after[k] >= counts[k];
  if (!good) failed = true;
  console.log(`  ${good ? ok("OK  ") : bad("FAIL")} ${k.padEnd(9)} sqlite ${String(counts[k]).padStart(4)} → postgres ${String(after[k]).padStart(4)}`);
}

console.log(failed
  ? `\n  ${bad("Migration incomplete.")}\n`
  : `\n  ${ok("Migrated.")} ${dim("The SQLite file is untouched; keep it until the deploy is verified.")}\n`);
process.exit(failed ? 1 : 0);
