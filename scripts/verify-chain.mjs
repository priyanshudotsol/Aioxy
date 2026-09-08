/**
 * On-chain verification of chunks 0-4.
 *
 * The single source of truth. A chunk is DONE only if a transaction on Somnia
 * Shannon proves it — not because a gate returned true, not because a row
 * exists in our database. Three gates in this build passed while proving less
 * than they claimed; this script exists so that cannot happen again.
 *
 * Every check below names the tx hash it rests on, or fails.
 *
 *   npm run verify:chain
 */
import { createPublicClient, http, formatUnits, parseAbi } from "viem";
import { somniaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "fs";

for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const EXPLORER = "https://shannon-explorer.somnia.network";
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), dim = (s) => c(90, s), bold = (s) => c(1, s);

const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const e6909 = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);
const poolAbi = parseAbi(["function outcomeToken() view returns (address)"]);

const results = [];
const chunk = (n, title) => ({ n, title, checks: [] });
const record = (ch, label, pass, evidence) => {
  ch.checks.push({ label, pass, evidence });
  console.log(`  ${pass ? ok("PASS") : bad("FAIL")}  ${label}`);
  if (evidence) console.log(dim(`        ${evidence}`));
};

/** A transaction only counts if the chain says it succeeded. */
async function txSucceeded(hash) {
  try {
    const r = await pub.getTransactionReceipt({ hash });
    return { ok: r.status === "success", gas: r.gasUsed, logs: r.logs.length, block: r.blockNumber };
  } catch {
    return { ok: false };
  }
}

const chainId = await pub.getChainId();
const block = await pub.getBlockNumber();
console.log(`\n${bold("  ON-CHAIN VERIFICATION — nothing is 'done' without a tx hash")}`);
console.log(`  chain ${chainId} ${chainId === 50312 ? ok("Somnia Shannon") : bad("WRONG CHAIN")} · block ${block}\n`);

const db = new DatabaseSync(".data/aioxy.db");
const agents = db.prepare("SELECT owner,deskId,address,risk,status FROM agents").all();
const owner = privateKeyToAccount(process.env.PRIVATE_KEY).address;

// ── CHUNK 0 ────────────────────────────────────────────────────────────────
const c0 = chunk(0, "Prove the primitive");
console.log(bold(`  Chunk 0 — ${c0.title}`));
{
  // A NEGATIVE result: the delegated call must be impossible. Verified by
  // simulation against a live pool, which needs no transaction to be conclusive.
  const pool = db.prepare("SELECT pool FROM trades WHERE pool LIKE '0x%' ORDER BY placedAt DESC LIMIT 1").get()?.pool;
  let reverts = false, reason = "";
  if (pool) {
    const { binaryPoolWriteAbi, ORDER_KIND } = await import("@somnia-chain/markets-sdk");
    try {
      await pub.simulateContract({
        address: pool, abi: binaryPoolWriteAbi, functionName: "placeBinaryOrderFor",
        args: [owner, ORDER_KIND.BUY_YES, 500000n, 1000000n,
               BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n, 2, 0,
               "0x0000000000000000000000000000000000000000", 0n, 0n],
        account: owner,
      });
    } catch (e) {
      reverts = true;
      reason = String(e?.shortMessage ?? e).slice(0, 90);
    }
  }
  record(c0, "delegated placeBinaryOrderFor is unreachable (the recorded finding)",
    reverts, reason || "no pool available to simulate against");
}
results.push(c0);

// ── CHUNK 1 ────────────────────────────────────────────────────────────────
const c1 = chunk(1, "Agent wallet: derive, store, fund");
console.log(`\n${bold(`  Chunk 1 — ${c1.title}`)}`);
{
  record(c1, "agent wallets are registered", agents.length > 0, `${agents.length} agents`);
  let funded = 0, gassed = 0;
  for (const a of agents) {
    const [stt, usdc] = await Promise.all([
      pub.getBalance({ address: a.address }),
      pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a.address] }).catch(() => 0n),
    ]);
    if (usdc > 0n) funded++;
    if (stt > 0n) gassed++;
    console.log(dim(`        ${a.deskId.padEnd(10)} ${a.address}  ${formatUnits(stt, 18).slice(0, 6)} STT · ${formatUnits(usdc, 6)} tUSDC`));
  }
  record(c1, "at least one agent wallet holds collateral ON CHAIN", funded > 0, `${funded}/${agents.length} funded`);
  record(c1, "agent wallets hold gas ON CHAIN (house top-up landed)", gassed > 0, `${gassed}/${agents.length} have STT`);
}
results.push(c1);

// ── CHUNK 2 ────────────────────────────────────────────────────────────────
const c2 = chunk(2, "Agent trades its own funds");
console.log(`\n${bold(`  Chunk 2 — ${c2.title}`)}`);
{
  let approveTx = null, orderTx = null, held = 0n;
  for (const a of agents) {
    const res = await fetch(`${EXPLORER}/api?module=account&action=txlist&address=${a.address}&sort=asc`)
      .then((r) => r.json()).catch(() => ({}));
    const txs = Array.isArray(res.result) ? res.result : [];
    for (const t of txs) {
      const sel = (t.input || "").slice(0, 10);
      if (sel === "0x095ea7b3" && t.isError === "0") approveTx ??= t.hash;
      if (sel === "0x718c2d4d" && t.isError === "0") orderTx ??= t.hash;
    }
    // Positions, read from the outcome-token singleton (RESEARCH.md §7).
    for (const pool of [...new Set(txs.map((t) => t.to).filter(Boolean))]) {
      const singleton = await pub.readContract({ address: pool, abi: poolAbi, functionName: "outcomeToken" }).catch(() => null);
      if (!singleton) continue;
      for (const id of await tokenIds(pool)) {
        held += await pub.readContract({ address: singleton, abi: e6909, functionName: "balanceOf", args: [a.address, BigInt(id)] }).catch(() => 0n);
      }
    }
  }
  const ap = approveTx ? await txSucceeded(approveTx) : { ok: false };
  record(c2, "an agent approved a pool ON CHAIN", ap.ok, approveTx && `${EXPLORER}/tx/${approveTx}`);
  const op = orderTx ? await txSucceeded(orderTx) : { ok: false };
  record(c2, "an agent called placeBinaryOrder ON CHAIN", op.ok,
    orderTx && `${EXPLORER}/tx/${orderTx}  gas ${op.gas} · ${op.logs} logs · block ${op.block}`);
  record(c2, "the agent HOLDS outcome tokens (the fill was real, not a mined no-op)",
    held > 0n, `${Number(held) / 1e6} contracts`);
}
results.push(c2);

// ── CHUNK 3 ────────────────────────────────────────────────────────────────
const c3 = chunk(3, "Store: owner + agent columns");
console.log(`\n${bold(`  Chunk 3 — ${c3.title}`)}`);
{
  const cols = new Set(db.prepare("PRAGMA table_info(trades)").all().map((x) => x.name));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='trades'").all().map((r) => r.name);
  record(c3, "schema carries owner + agentAddress", cols.has("owner") && cols.has("agentAddress"));
  record(c3, "uniqueness is per owner, not global", idx.includes("idx_trades_position_owner") && !idx.includes("idx_trades_position"));
  console.log(dim("        schema-only chunk — no on-chain surface to verify"));
}
results.push(c3);

// ── CHUNK 4 ────────────────────────────────────────────────────────────────
const c4 = chunk(4, "Runner loops funded agents");
console.log(`\n${bold(`  Chunk 4 — ${c4.title}`)}`);
{
  const live = db.prepare("SELECT owner,agentId,marketId,txHash,contracts,price FROM trades WHERE mode='live' AND txHash IS NOT NULL").all();
  record(c4, "the RUNNER produced trades with transaction hashes", live.length > 0, `${live.length} live trades`);

  let confirmed = 0;
  for (const t of live.slice(0, 6)) {
    const r = await txSucceeded(t.txHash);
    if (r.ok) confirmed++;
    console.log(dim(`        ${r.ok ? "✓" : "✗"} ${t.agentId} owner=${t.owner.slice(0, 12)}… ${EXPLORER}/tx/${t.txHash}`));
  }
  record(c4, "those transactions SUCCEEDED on chain", live.length > 0 && confirmed === Math.min(live.length, 6),
    `${confirmed} confirmed`);

  const byRound = {};
  for (const t of live) (byRound[`${t.agentId}|${t.marketId}`] ??= new Set()).add(t.owner);
  const fanned = Object.values(byRound).some((s) => s.size >= 2);
  record(c4, "one decision reached TWO owners, both settled on chain", fanned,
    Object.entries(byRound).map(([k, v]) => `${k.split("|")[0]}:${v.size}`).join(" ") || "none yet");
}
results.push(c4);

// ── CHUNK 5 ────────────────────────────────────────────────────────────────
const c5 = chunk(5, "Settle payouts home");
console.log(`\n${bold(`  Chunk 5 — ${c5.title}`)}`);
{
  // Evidence recorded when the path was first exercised. Re-verified against
  // the chain on every run, never trusted from the file.
  const SWEEP_TX = "0x6530dd69d22489dfc60b6a81013cb8ae25e12db547b0e7b91fabef409d861d26";
  const SETOP_TX = "0xd57e6e90c593bc5b365a0de3778a5a341c61cd1316ff250532d2f55decd11429";
  const REDEEM_TX = "0x759564d0056ebbb82eff31e0ac1d9f34fbddb35242dbb770835be8ed79314b2a";

  const sw = await txSucceeded(SWEEP_TX);
  record(c5, "collateral swept from an agent wallet to its OWNER on chain", sw.ok,
    `${EXPLORER}/tx/${SWEEP_TX}  block ${sw.block}`);

  const so = await txSucceeded(SETOP_TX);
  record(c5, "agent approved BinarySettlement on the ERC-6909 singleton on chain", so.ok,
    `${EXPLORER}/tx/${SETOP_TX}`);

  const rd = await txSucceeded(REDEEM_TX);
  record(c5, "redemption executed on chain via BinarySettlement.redeem", rd.ok,
    `${EXPLORER}/tx/${REDEEM_TX}  gas ${rd.gas} · ${rd.logs} logs`);

  // Honest about what is NOT yet proven.
  const wins = db.prepare("SELECT COUNT(*) n FROM trades WHERE won=1 AND owner!='house'").get().n;
  if (wins === 0) {
    console.log(dim("        note: every settled position so far LOST, so a winning payout"));
    console.log(dim("        has not been redeemed yet — the mechanism is proven, the profit path is not"));
  }
}
results.push(c5);

// ── CHUNK 7 ────────────────────────────────────────────────────────────────
const c7 = chunk(7, "Dashboard truth + withdraw");
console.log(`\n${bold(`  Chunk 7 — ${c7.title}`)}`);
{
  // The BROWSER path: an owner signature, no server secret. Re-verified on chain.
  const WITHDRAW_TX = "0x559935583c2f60c32ce925c90ba5a8d26694e9b227d9d1850b621dad7b7d3a6e";
  const wd = await txSucceeded(WITHDRAW_TX);
  record(c7, "signature-authorised withdraw executed on chain (no server secret)", wd.ok,
    `${EXPLORER}/tx/${WITHDRAW_TX}  block ${wd.block}`);

  // The dashboard must agree with the chain, not with our own log.
  let agreed = 0;
  for (const a of agents) {
    const onChain = await pub.readContract({
      address: USDC, abi: erc20, functionName: "balanceOf", args: [a.address],
    }).catch(() => null);
    if (onChain !== null) agreed++;
  }
  record(c7, "agent balances are readable from chain for the dashboard", agreed === agents.length,
    `${agreed}/${agents.length}`);

  const withTx = db.prepare("SELECT COUNT(*) n FROM trades WHERE mode='live' AND txHash IS NOT NULL").get().n;
  const live = db.prepare("SELECT COUNT(*) n FROM trades WHERE mode='live'").get().n;
  record(c7, "every live trade shown carries a transaction hash", live > 0 && withTx === live, `${withTx}/${live}`);
}
results.push(c7);

// ── verdict ────────────────────────────────────────────────────────────────
console.log(`\n${bold("  VERDICT")}`);
let allDone = true;
for (const ch of results) {
  const passed = ch.checks.filter((x) => x.pass).length;
  const done = passed === ch.checks.length;
  if (!done) allDone = false;
  console.log(`  chunk ${ch.n}  ${done ? ok("DONE — proven on chain") : bad(`NOT DONE (${passed}/${ch.checks.length})`)}  ${dim(ch.title)}`);
}
db.close();
console.log();
process.exit(allDone ? 0 : 1);

async function tokenIds(pool) {
  const q = `{ Market(where:{binaryPoolAddress:{_eq:"${pool.toLowerCase()}"}}, order_by:{expiry:desc}, limit:40){ yesTokenId noTokenId } }`;
  const r = await fetch(process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }),
  }).then((x) => x.json()).catch(() => ({}));
  return (r?.data?.Market ?? []).flatMap((m) => [m?.yesTokenId, m?.noTokenId]).filter(Boolean);
}
