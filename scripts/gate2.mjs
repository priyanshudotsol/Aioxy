/**
 * Chunk 2 gate — see docs/PLAN.md.
 *
 * Proves the agent trades ITS OWN funds:
 *   1. approve lands against a recycled pool (and is cached, not repeated)
 *   2. a real order fills on a live round, paid from the agent wallet
 *   3. the agent's collateral falls; the OWNER's is untouched
 *   4. risk sizing produces sane whole-contract sizes
 *
 *   npm run gate2        (needs the dev server, and an agent funded by gate1)
 */
import { createPublicClient, http, formatUnits, parseAbi } from "viem";
import { somniaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { readFileSync, existsSync } from "fs";

for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const BASE = process.env.BASE_URL || "http://localhost:4311";
const SECRET = process.env.INTERNAL_SECRET || "";
const internal = { "content-type": "application/json", "x-internal-secret": SECRET };
const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const INDEXER = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const EXPLORER = process.env.EXPLORER_URL || "https://shannon-explorer.somnia.network";

const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), warnc = (s) => c(33, s), dim = (s) => c(90, s);
let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`  ${pass ? ok("PASS") : bad("FAIL")}  ${label}${detail ? dim("  " + detail) : ""}`);
  if (!pass) failures++;
};
const gql = async (q) => {
  const r = await fetch(INDEXER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};

const owner = privateKeyToAccount(process.env.PRIVATE_KEY);
const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const bal = (a) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });

/**
 * The agent's outcome-token position, read from chain.
 *
 * The indexer's `Fill` table does NOT surface these binary fills (RESEARCH.md
 * §7), and a successful tx alone proves nothing — an IOC that failed to cross
 * also succeeds. Holding the position is the only honest proof of a fill.
 */
const poolAbi = parseAbi(["function outcomeToken() view returns (address)"]);
const e6909 = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);
async function positionOf(pool, who, tokenIds) {
  const singleton = await pub.readContract({ address: pool, abi: poolAbi, functionName: "outcomeToken" });
  let total = 0n;
  for (const id of tokenIds) {
    total += await pub.readContract({ address: singleton, abi: e6909, functionName: "balanceOf", args: [who, BigInt(id)] }).catch(() => 0n);
  }
  return total;
}

console.log(`\n${c(1, "  Chunk 2 gate — agent trades its own funds")}`);

// ── the agent from chunk 1 ─────────────────────────────────────────────────
const got = await fetch(`${BASE}/api/agent?owner=${owner.address}`).then((r) => r.json());
const agent = got.agents?.find((a) => Number(a.balance?.usdc) > 0);
if (!agent) { console.log(bad("\n  No funded agent. Run `npm run gate1` first.\n")); process.exit(1); }
console.log(`  agent  ${agent.address}  ${dim(`${agent.balance.usdc} tUSDC · ${agent.balance.stt} STT · risk=${agent.risk}`)}`);
console.log(`  owner  ${owner.address}\n`);

// ── FLAW FOUND IN AUDIT: risk sizing had never actually executed ──────────
// The old check imported the TS module from node, silently failed, and printed
// "checked via the API instead" without checking anything. Every trade also
// passed contracts:1, bypassing sizeFor entirely. Now exercised for real, via a
// dryRun so it costs no collateral.
{
  const sized = await fetch(`${BASE}/api/agent/trade`, {
    method: "POST", headers: internal,
    body: JSON.stringify({
      owner: owner.address, deskId: agent.deskId, pool: "0x06b0c35e61c7cef10689b48500fc374867e33df4",
      direction: "UP", limitPrice: 0.5, expiry: Math.floor(Date.now() / 1000) + 3600, dryRun: true,
    }),
  }).then((r) => r.json());
  // medium = 10% of balance, at 0.5 per contract
  const expected = Math.floor((sized.balance * 0.10) / 0.5);
  check("risk sizing runs and matches the profile", sized.contracts === expected && expected > 0,
    `balance ${sized.balance} → ${sized.contracts} contracts (expected ${expected})`);
}

// ── the endpoint must refuse an unauthenticated caller ────────────────────
{
  const anon = await fetch(`${BASE}/api/agent/trade`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: owner.address, deskId: agent.deskId, pool: "0x06b0c35e61c7cef10689b48500fc374867e33df4",
      direction: "UP", limitPrice: 0.97, contracts: 1, expiry: Math.floor(Date.now() / 1000) + 3600 }),
  });
  check("anonymous callers CANNOT make an agent trade", anon.status === 401, `status ${anon.status}`);
}

// ── find a live round with crossable depth ─────────────────────────────────
const now = Math.floor(Date.now() / 1000);
const { Market: rounds } = await gql(`{
  Market(where:{marketType:{_eq:"BINARY"},asset:{_in:["BTC","ETH"]},intervalSec:{_lte:"86400"},
    finalized:{_eq:false},expiry:{_gt:"${now + 120}"},clobStatus:{_eq:"Trading"}},
    order_by:{expiry:asc}, limit:12){ marketId asset intervalSec expiry binaryPoolAddress yesTokenId noTokenId }
}`);
let target = null;
for (const r of rounds) {
  const { Order } = await gql(`{ Order(where:{market_id:{_eq:"${r.marketId}"},status:{_eq:"Open"}}, limit:100){ price quantityRemaining isBid side } }`);
  const bids = [], asks = [];
  for (const o of Order) {
    const qty = Number(o.quantityRemaining) / 1e6;
    if (qty <= 0) continue;
    const isNo = o.side === "BUY_NO" || o.side === "SELL_NO";
    const price = isNo ? 1 - Number(o.price) / 1e6 : Number(o.price) / 1e6;
    (((isNo ? !o.isBid : o.isBid)) ? bids : asks).push({ price, qty });
  }
  bids.sort((a, b) => b.price - a.price); asks.sort((a, b) => a.price - b.price);
  if (asks[0]) { target = { r, dir: "UP", px: asks[0].price }; break; }
  if (bids[0]) { target = { r, dir: "DOWN", px: 1 - bids[0].price }; break; }
}
if (!target) {
  console.log(warnc("\n  No resting depth on any live round right now."));
  console.log(dim("  That is a venue state, not a bug — retry in a few minutes.\n"));
  process.exit(2);
}
console.log(`  round  ${target.r.asset} ${target.r.intervalSec}s · taking ${target.dir} at ${(target.px * 100).toFixed(1)}c\n`);

// ── trade, through the app's own endpoint ──────────────────────────────────
const tokenIds = [target.r.yesTokenId, target.r.noTokenId].filter(Boolean);
const posBefore = await positionOf(target.r.binaryPoolAddress, agent.address, tokenIds);
const ownerBefore = await bal(owner.address);
const agentBefore = await bal(agent.address);
const allowBefore = await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [agent.address, target.r.binaryPoolAddress] });

const res = await fetch(`${BASE}/api/agent/trade`, {
  method: "POST", headers: internal,
  body: JSON.stringify({
    owner: owner.address, deskId: agent.deskId, pool: target.r.binaryPoolAddress,
    direction: target.dir, limitPrice: Math.min(0.98, target.px + 0.02),
    contracts: 1, expiry: Number(target.r.expiry),
  }),
}).then((r) => r.json());

console.log(dim(`  response ${JSON.stringify(res).slice(0, 200)}\n`));

const allowAfter = await pub.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [agent.address, target.r.binaryPoolAddress] });
check("approval landed against the recycled pool", allowAfter > allowBefore || allowBefore > 0n,
  `${allowBefore === 0n ? "0 → approved" : "already approved"}`);
check("transaction succeeded", res.filled === true, res.error ?? "");
const posAfter = await positionOf(target.r.binaryPoolAddress, agent.address, tokenIds);
check("agent actually HOLDS the position (not just a mined tx)", posAfter > posBefore,
  `${Number(posBefore) / 1e6} → ${Number(posAfter) / 1e6} contracts`);
if (res.txHash) console.log(dim(`         ${EXPLORER}/tx/${res.txHash}`));

const ownerAfter = await bal(owner.address);
const agentAfter = await bal(agent.address);
check("agent's collateral was spent", agentAfter < agentBefore,
  `${formatUnits(agentBefore, 6)} → ${formatUnits(agentAfter, 6)} tUSDC`);
check("owner's collateral was NOT touched", ownerAfter === ownerBefore,
  `${formatUnits(ownerAfter, 6)} tUSDC`);

// second call must not re-approve
const res2 = await fetch(`${BASE}/api/agent/trade`, {
  method: "POST", headers: internal,
  body: JSON.stringify({ owner: owner.address, deskId: agent.deskId, pool: target.r.binaryPoolAddress,
    direction: target.dir, limitPrice: Math.min(0.98, target.px + 0.02), contracts: 1, expiry: Number(target.r.expiry) }),
}).then((r) => r.json());
check("approval is cached, not repeated", !res2.approvalTx);

console.log(failures === 0
  ? `\n  ${ok("Chunk 2 gate PASSED")} — the agent trades its own funds. Start chunk 3.\n`
  : `\n  ${bad(`Chunk 2 gate FAILED (${failures})`)}\n`);
process.exit(failures ? 1 : 0);
