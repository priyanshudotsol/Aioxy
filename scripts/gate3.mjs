/**
 * Chunk 3 gate — see docs/PLAN.md.
 *
 *   1. the 106 pre-existing trades survive the migration
 *   2. the old UNIQUE(agentId, marketId) index is gone
 *   3. two owners CAN hold the same agent+market (the point of the chunk)
 *   4. one owner still CANNOT double up on the same agent+market
 *
 * Runs against the real database file, then cleans up its own test rows.
 *
 *   npm run gate3
 */
import { DatabaseSync } from "node:sqlite";

const DB = ".data/aioxy.db";
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), dim = (s) => c(90, s);
let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`  ${pass ? ok("PASS") : bad("FAIL")}  ${label}${detail ? dim("  " + detail) : ""}`);
  if (!pass) failures++;
};

console.log(`\n${c(1, "  Chunk 3 gate — owner column + per-owner uniqueness")}`);

const db = new DatabaseSync(DB);

// 1 — the existing record survived
const total = db.prepare("SELECT COUNT(*) n FROM trades").get().n;
check("existing trades survived the migration", total >= 106, `${total} rows`);

const cols = new Set(db.prepare("PRAGMA table_info(trades)").all().map((c) => c.name));
check("trades.owner exists", cols.has("owner"));
check("trades.agentAddress exists", cols.has("agentAddress"));

const housed = db.prepare("SELECT COUNT(*) n FROM trades WHERE owner='house'").get().n;
check("pre-agent rows were assigned to the house", housed >= 106, `${housed} rows`);

// 2 — the blocking index is gone, the right one is present
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='trades'").all().map((r) => r.name);
check("old UNIQUE(agentId, marketId) index dropped", !idx.includes("idx_trades_position"), idx.join(", "));
check("per-owner unique index present", idx.includes("idx_trades_position_owner"));

// 3 + 4 — the actual behaviour
const cleanup = () => db.exec("DELETE FROM trades WHERE id LIKE 'gate3-%'");
cleanup();

const insert = (id, owner) =>
  db.prepare(`INSERT INTO trades
    (id,agentId,owner,agentAddress,marketId,pool,asset,intervalSec,strike,direction,price,
     contracts,cost,reason,fairValue,spotAtEntry,syntheticBook,mode,txHash,
     placedAt,expiry,settled,won,payout,pnl,settledAt,voided)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "clockwork", owner, "0xagent", "0xmarket-gate3", "0xpool", "BTC", 900, 100,
         "UP", 0.5, 1, 0.5, "gate3", 0.5, 100, 0, "paper", null,
         Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 900, 0, null, null, null, null, 0);

let twoOwners = false, doubleUp = false;
try {
  insert("gate3-a", "0xalice");
  insert("gate3-b", "0xbob");
  twoOwners = true;
} catch (e) {
  console.log(dim(`    ${String(e).slice(0, 120)}`));
}
check("two owners can hold the same agent + market", twoOwners);

try {
  insert("gate3-c", "0xalice"); // same owner, same agent, same market
  doubleUp = true;
} catch {
  doubleUp = false;
}
check("one owner still cannot double up on the same round", !doubleUp);

cleanup();
check("test rows cleaned up", db.prepare("SELECT COUNT(*) n FROM trades WHERE id LIKE 'gate3-%'").get().n === 0);
db.close();

console.log(failures === 0
  ? `\n  ${ok("Chunk 3 gate PASSED")} — start chunk 4.\n`
  : `\n  ${bad(`Chunk 3 gate FAILED (${failures})`)}\n`);
process.exit(failures ? 1 : 0);
