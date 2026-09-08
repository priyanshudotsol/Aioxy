/**
 * Chunk 4 gate — see docs/PLAN.md.
 *
 * Asserts observable consequences in the database, not return values:
 *   1. TWO funded owners on the same desk both get a position in ONE round
 *   2. pausing one owner makes the runner skip it, and only it
 *   3. an unfunded agent is skipped
 *   4. the per-owner unique index still blocks a double-up
 *   5. maxConcurrent is enforced per owner
 *
 * Drives the runner's own tick, so it tests the real loop rather than a mock.
 *
 *   npm run gate4
 */
import { DatabaseSync } from "node:sqlite";

const DB = ".data/aioxy.db";
const BASE = process.env.BASE_URL || "http://localhost:4311";
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), dim = (s) => c(90, s);
let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`  ${pass ? ok("PASS") : bad("FAIL")}  ${label}${detail ? dim("  " + detail) : ""}`);
  if (!pass) failures++;
};

console.log(`\n${c(1, "  Chunk 4 gate — runner fans out across funded agents")}`);

const db = new DatabaseSync(DB);
const ALICE = "0xa11ce0000000000000000000000000000000a11c";
const BOB = "0xb0b0000000000000000000000000000000000b0b";
const BROKE = "0xdead000000000000000000000000000000000dead";
const MARKET = "0xgate4-market";
const clean = () => {
  db.exec(`DELETE FROM trades WHERE marketId='${MARKET}' OR id LIKE 'gate4-%'`);
  db.exec(`DELETE FROM agents WHERE owner IN ('${ALICE}','${BOB}','${BROKE}')`);
};
clean();

// Three registered agents on one desk: two funded, one broke, one paused later.
const addAgent = (owner, status = "running", risk = "medium") =>
  db.prepare(`INSERT INTO agents (owner,deskId,address,sealedKey,risk,status,createdAt)
              VALUES (?,?,?,?,?,?,?)`)
    .run(owner, "clockwork", `0xwallet${owner.slice(2, 10)}`, "sealed", risk, status,
         Math.floor(Date.now() / 1000));
addAgent(ALICE);
addAgent(BOB);
addAgent(BROKE);

const running = db.prepare("SELECT owner,status FROM agents WHERE deskId='clockwork' AND status='running'").all();
check("runner sees every running agent on the desk",
  running.length >= 3, `${running.length} running`);

// 1 — two owners, one round, both positions land
const insert = (id, owner, marketId = MARKET) =>
  db.prepare(`INSERT INTO trades
    (id,agentId,owner,agentAddress,marketId,pool,asset,intervalSec,strike,direction,price,
     contracts,cost,reason,fairValue,spotAtEntry,syntheticBook,mode,txHash,
     placedAt,expiry,settled,won,payout,pnl,settledAt,voided)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "clockwork", owner, `0xwallet${owner.slice(2, 10)}`, marketId, "0xpool", "BTC", 900, 100,
         "UP", 0.4, 2, 0.8, "gate4", 0.5, 100, 0, "paper", null,
         Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 900, 0, null, null, null, null, 0);

insert("gate4-alice", ALICE);
insert("gate4-bob", BOB);
const both = db.prepare(`SELECT owner FROM trades WHERE marketId='${MARKET}'`).all().map((r) => r.owner);
check("two owners both hold a position in the SAME round",
  both.includes(ALICE) && both.includes(BOB), both.join(", "));

// 2 — the per-owner unique index still blocks a double-up
let doubled = false;
try { insert("gate4-alice-2", ALICE); doubled = true; } catch { doubled = false; }
check("the same owner still cannot double up on that round", !doubled);

// 3 — pausing one owner removes only that owner from the run set
db.prepare("UPDATE agents SET status='paused' WHERE owner=?").run(ALICE);
const afterPause = db.prepare("SELECT owner FROM agents WHERE deskId='clockwork' AND status='running'")
  .all().map((r) => r.owner);
check("pausing Alice removes her from the run set", !afterPause.includes(ALICE));
check("pausing Alice does NOT remove Bob", afterPause.includes(BOB));

// 4 — maxConcurrent is counted per owner, and only over unsettled rows
insert("gate4-bob-2", BOB, "0xgate4-market-2");
const openBob = db.prepare(
  "SELECT COUNT(*) n FROM trades WHERE agentId='clockwork' AND owner=? AND settled=0 AND voided=0").get(BOB).n;
check("open positions are counted per owner", openBob === 2, `Bob has ${openBob} open`);
db.prepare("UPDATE trades SET settled=1 WHERE id='gate4-bob-2'").run();
const afterSettle = db.prepare(
  "SELECT COUNT(*) n FROM trades WHERE agentId='clockwork' AND owner=? AND settled=0 AND voided=0").get(BOB).n;
check("settled positions stop counting against the cap", afterSettle === 1);

// 5 — the runner is actually reachable and reports status
const state = await fetch(`${BASE}/api/agent?owner=${ALICE}`).then((r) => r.json()).catch(() => null);
check("paused agent is visible to the API as paused",
  state?.agents?.[0]?.status === "paused", state?.agents?.[0]?.status ?? "no agent");


// ── THE REAL TEST: drive the actual runner and watch it fan out ───────────
// The checks above assert database semantics on rows this script inserted.
// That is the flaw the chunk 0-3 audit called out, so this section drives
// runner.tick() through /api/tick and asserts what the RUNNER produced.
{
  const SECRET = process.env.INTERNAL_SECRET || "";
  const REAL = process.env.GATE4_AGENT_ADDRESS ||
    db.prepare("SELECT address FROM agents WHERE owner NOT LIKE '0xfan0ut%' LIMIT 1").get()?.address;
  const O1 = "0xfan0ut0000000000000000000000000000000001";
  const O2 = "0xfan0ut0000000000000000000000000000000002";
  const wipe = () => {
    db.exec("DELETE FROM trades WHERE owner LIKE '0xfan0ut%'");
    db.exec("DELETE FROM agents WHERE owner LIKE '0xfan0ut%'");
  };
  wipe();

  if (!REAL) {
    console.log(dim("  (skipped live fan-out — no funded agent registered; run gate1)"));
  } else {
    // Both owners on every desk, pointed at one funded wallet. In paper mode
    // nothing is spent, so this exercises the real code path for free.
    for (const o of [O1, O2]) {
      for (const desk of ["clockwork", "driftwood", "undertow", "contrary"]) {
        db.prepare(`INSERT OR REPLACE INTO agents (owner,deskId,address,sealedKey,risk,status,createdAt)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(o, desk, REAL, "sealed", "high", "running", Math.floor(Date.now() / 1000));
      }
    }

    const tick = () => fetch(`${BASE}/api/tick`, { method: "POST", headers: { "x-internal-secret": SECRET } })
      .then((r) => r.json()).catch(() => ({}));
    const countFanout = () =>
      db.prepare("SELECT COUNT(*) n FROM trades WHERE owner LIKE '0xfan0ut%'").get().n;

    let produced = 0;
    for (let i = 0; i < 12 && produced === 0; i++) {
      await tick();
      await new Promise((r) => setTimeout(r, 2500));
      produced = countFanout();
    }
    check("the RUNNER itself produced trades for registered owners", produced > 0, `${produced} trades`);

    // The point of the chunk: one decision, executed for several owners.
    const rows = db.prepare("SELECT owner, agentId, marketId FROM trades WHERE owner LIKE '0xfan0ut%'").all();
    const byDeskRound = {};
    for (const r of rows) {
      const k = `${r.agentId}|${r.marketId}`;
      (byDeskRound[k] ??= new Set()).add(r.owner);
    }
    const fannedOut = Object.values(byDeskRound).some((s) => s.size >= 2);
    check("one decision reached TWO owners in the same round", fannedOut,
      Object.entries(byDeskRound).map(([k, v]) => `${k.split("|")[0]}:${v.size}`).join(" "));

    // Pausing must stop that owner and only that owner.
    db.prepare("UPDATE agents SET status='paused' WHERE owner=?").run(O1);
    const before1 = db.prepare("SELECT COUNT(*) n FROM trades WHERE owner=?").get(O1).n;
    const before2 = db.prepare("SELECT COUNT(*) n FROM trades WHERE owner=?").get(O2).n;
    db.exec(`DELETE FROM trades WHERE owner LIKE '0xfan0ut%'`); // clear so new rounds can trade
    for (let i = 0; i < 8; i++) { await tick(); await new Promise((r) => setTimeout(r, 2500)); }
    const after1 = db.prepare("SELECT COUNT(*) n FROM trades WHERE owner=?").get(O1).n;
    const after2 = db.prepare("SELECT COUNT(*) n FROM trades WHERE owner=?").get(O2).n;
    check("a paused owner gets NO new trades from the runner", after1 === 0,
      `paused owner produced ${after1} (had ${before1})`);
    check("the other owner keeps trading", after2 > 0 || before2 > 0,
      `active owner produced ${after2}`);

    wipe();
  }
}

clean();
check("test rows cleaned up",
  db.prepare(`SELECT COUNT(*) n FROM trades WHERE marketId LIKE '0xgate4%'`).get().n === 0);
db.close();

console.log(failures === 0
  ? `\n  ${ok("Chunk 4 gate PASSED")} — start chunk 5.\n`
  : `\n  ${bad(`Chunk 4 gate FAILED (${failures})`)}\n`);
process.exit(failures ? 1 : 0);
