/**
 * Chunk 0 — prove the primitive. See docs/PLAN.md.
 *
 * Everything in this product rests on three unverified assumptions. This script
 * answers all three with one real transaction, and prints a verdict you paste
 * into docs/RESEARCH.md:
 *
 *   Q1  Does a binary pool honour selector 0x5d97c566 (placeBinaryOrderFor)?
 *   Q2  Does a GLOBAL grant reach binary pools, or is a per-pool grant required?
 *   Q3  Where is escrow pulled from — the owner's ERC20 allowance to the pool,
 *       the owner's vault balance in that pool, or both?
 *
 * Q2 and Q3 decide whether "deploy once, it keeps trading" is possible at all:
 * binary pools recycle every round, so if BOTH the grant and the collateral are
 * per-pool, the product is per-session and the landing page is wrong.
 *
 *   npm run prove
 *
 * Needs two wallets. The OPERATOR needs STT for gas only — it never holds
 * collateral, which is the whole point.
 */
import { createPublicClient, createWalletClient, http, formatUnits, parseAbi } from "viem";
import { somniaTestnet } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  binaryPoolWriteAbi,
  ORDER_KIND,
} from "@somnia-chain/markets-sdk";
import { readFileSync, existsSync } from "fs";

for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const INDEXER = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const WS = process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws";
const EXPLORER = process.env.EXPLORER_URL || "https://shannon-explorer.somnia.network";

/** placeBinaryOrderFor — verified against binaryPoolWriteAbi, see RESEARCH.md §2. */
const PLACE_BINARY_ORDER_FOR = "0x5d97c566";

const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), warn = (s) => c(33, s), dim = (s) => c(90, s);
const die = (m) => { console.error(`\n  ${bad(m)}\n`); process.exit(1); };
const h2 = (s) => console.log(`\n${c(1, s)}\n${dim("─".repeat(66))}`);

const gql = async (q) => {
  const r = await fetch(INDEXER, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};

// ── wallets ────────────────────────────────────────────────────────────────
const ownerPk = process.env.OWNER_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!ownerPk || !/^0x[0-9a-fA-F]{64}$/.test(ownerPk)) {
  die("OWNER_PRIVATE_KEY (or PRIVATE_KEY) missing. This wallet needs tUSDC + STT.");
}
const owner = privateKeyToAccount(ownerPk);

let operatorPk = process.env.OPERATOR_PRIVATE_KEY;
if (!operatorPk || !/^0x[0-9a-fA-F]{64}$/.test(operatorPk)) {
  const fresh = generatePrivateKey();
  const addr = privateKeyToAccount(fresh).address;
  console.log(`\n  ${warn("No OPERATOR_PRIVATE_KEY set.")} Generated one for you:\n`);
  console.log(`    OPERATOR_PRIVATE_KEY=${fresh}`);
  console.log(`    address ${addr}\n`);
  console.log(`  1. Append that line to .env.local`);
  console.log(`  2. Send it a little STT for gas — https://testnet.somnia.network/`);
  console.log(`     It needs NO tUSDC. It escrows the owner's collateral, never its own.`);
  console.log(`  3. Re-run: npm run prove\n`);
  process.exit(1);
}
const operator = privateKeyToAccount(operatorPk);

if (owner.address.toLowerCase() === operator.address.toLowerCase()) {
  die("Owner and operator are the same wallet — that proves nothing. Use two keys.");
}

console.log(`\n${c(1, "  Chunk 0 — prove the primitive")}`);
console.log(`  owner     ${owner.address}   ${dim("(holds the collateral)")}`);
console.log(`  operator  ${operator.address}   ${dim("(gas only)")}`);

const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc;

const bal = async (a) => ({
  stt: await pub.getBalance({ address: a }),
  usdc: await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] }).catch(() => 0n),
});

const b0 = { owner: await bal(owner.address), operator: await bal(operator.address) };
console.log(`\n  owner     ${formatUnits(b0.owner.stt, 18).slice(0, 8)} STT · ${formatUnits(b0.owner.usdc, 6)} tUSDC`);
console.log(`  operator  ${formatUnits(b0.operator.stt, 18).slice(0, 8)} STT · ${formatUnits(b0.operator.usdc, 6)} tUSDC`);
if (b0.owner.usdc === 0n) die("Owner holds no tUSDC. Ask in the SomniaHacks faucet topic.");
if (b0.operator.stt === 0n) die(`Operator has no STT for gas. Fund ${operator.address} at https://testnet.somnia.network/`);

// ── find a live round with crossable depth ─────────────────────────────────
h2("  Finding a live round with resting depth");
const now = Math.floor(Date.now() / 1000);
const { Market: rounds } = await gql(`{
  Market(where:{marketType:{_eq:"BINARY"},asset:{_in:["BTC","ETH"]},intervalSec:{_lte:"86400"},
    finalized:{_eq:false},expiry:{_gt:"${now + 120}"},clobStatus:{_eq:"Trading"}},
    order_by:{expiry:asc}, limit:12){ marketId asset intervalSec expiry binaryPoolAddress }
}`);
if (!rounds.length) die("No live rounds open. Try again in a minute.");

let target = null;
for (const r of rounds) {
  const { Order } = await gql(`{
    Order(where:{market_id:{_eq:"${r.marketId}"},status:{_eq:"Open"}}, limit:100){ price quantityRemaining isBid side }
  }`);
  const bids = [], asks = [];
  for (const o of Order) {
    const qty = Number(o.quantityRemaining) / 1e6;
    if (qty <= 0) continue;
    const isNo = o.side === "BUY_NO" || o.side === "SELL_NO";
    const price = isNo ? 1 - Number(o.price) / 1e6 : Number(o.price) / 1e6;
    const yesBid = isNo ? !o.isBid : o.isBid;
    (yesBid ? bids : asks).push({ price, qty });
  }
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  if (asks[0]) { target = { r, dir: "UP", px: asks[0].price, depth: asks[0].qty }; break; }
  if (bids[0]) { target = { r, dir: "DOWN", px: 1 - bids[0].price, depth: bids[0].qty }; break; }
}
if (!target) die("Live rounds exist but nothing to cross. Retry shortly — this is a venue state, not a bug.");

const { r: round, dir, px, depth } = target;
const pool = round.binaryPoolAddress;
console.log(`  ${round.asset} ${round.intervalSec}s · expires in ${round.expiry - now}s`);
console.log(`  pool ${pool}`);
console.log(`  taking ${dir} at ${(px * 100).toFixed(1)}c, depth ${depth.toFixed(0)}, 1 contract`);

// ── Q3 (before): where could escrow come from? ─────────────────────────────
h2("  Q3 — where can escrow be pulled from?");
const vaultAbi = parseAbi(["function balanceOf(address,address) view returns (uint256)"]);
const readVault = async () =>
  pub.readContract({ address: pool, abi: vaultAbi, functionName: "balanceOf", args: [owner.address, USDC] })
     .catch(() => null);

const allowance0 = await pub.readContract({
  address: USDC, abi: erc20, functionName: "allowance", args: [owner.address, pool],
});
const vault0 = await readVault();
console.log(`  owner's tUSDC allowance to pool  ${formatUnits(allowance0, 6)}`);
console.log(`  owner's vault balance in pool    ${vault0 === null ? dim("(not readable this way)") : formatUnits(vault0, 6)}`);
if (allowance0 === 0n && (vault0 ?? 0n) === 0n) {
  console.log(`  ${warn("Both are zero — the delegated order will likely fail on escrow.")}`);
  console.log(`  ${dim("That is itself an answer: the owner must pre-fund or pre-approve per pool.")}`);
}

// ── Q1/Q2: grant, then read it back ────────────────────────────────────────
h2("  Q1/Q2 — grant 0x5d97c566 and read it back");
const ownerEx = new SomniaMarkets({
  chain: somniaTestnet, addresses: SOMNIA_TESTNET_ADDRESSES,
  privateKey: ownerPk, wsRpcUrl: WS, indexerUrl: INDEXER,
});

console.log(`  granting GLOBAL ${PLACE_BINARY_ORDER_FOR} → ${operator.address} ...`);
let grantTx = null;
try {
  const g = await ownerEx.trader.setOperatorApprovalGlobal({
    operator: operator.address, selectors: [PLACE_BINARY_ORDER_FOR], approved: true,
  });
  grantTx = g.receipt?.transactionHash ?? g.hash;
  console.log(`  ${ok("granted")} ${grantTx}`);
} catch (e) {
  console.log(`  ${bad("global grant FAILED")}: ${String(e?.message ?? e).slice(0, 160)}`);
}

const readBack = async (fn, args) =>
  ownerEx[fn] ? ownerEx[fn](args).catch((e) => `error: ${String(e?.message ?? e).slice(0, 80)}`)
              : "(client method missing)";

const globallyApproved = await readBack("isGloballyApproved", {
  owner: owner.address, operator: operator.address, selector: PLACE_BINARY_ORDER_FOR,
});
const authorized = await readBack("isOperatorAuthorized", {
  owner: owner.address, operator: operator.address, selector: PLACE_BINARY_ORDER_FOR,
});
const approvedForPool = await readBack("isApprovedForPool", {
  pool, owner: owner.address, operator: operator.address, selector: PLACE_BINARY_ORDER_FOR,
});
console.log(`  isGloballyApproved   ${globallyApproved}`);
console.log(`  isOperatorAuthorized ${authorized}   ${dim("← the resolved decision")}`);
console.log(`  isApprovedForPool    ${approvedForPool}`);

// ── the actual test: operator places FOR owner ─────────────────────────────
h2("  Q1 — operator calls placeBinaryOrderFor on the owner's behalf");
const opWallet = createWalletClient({ account: operator, chain: somniaTestnet, transport: http(RPC) });
const yesPrice = dir === "UP" ? px : 1 - px;
const limit = Math.min(0.99, yesPrice + 0.02);

// expireTimestampNs must satisfy 0 < expireNs <= pool.marketExpiryNs.
const expireNs = BigInt(round.expiry) * 1_000_000_000n;
const args = [
  owner.address,
  ORDER_KIND[dir === "UP" ? "BUY_YES" : "BUY_NO"],
  BigInt(Math.round(limit * 1e6)),
  1_000_000n,                       // one whole contract
  expireNs,
  2,                                // IOC
  0,                                // CANCEL_TAKER
  "0x0000000000000000000000000000000000000000", // no builder
  0n,
  0n,
];

let placeTx = null, reverted = null;
try {
  await pub.simulateContract({
    address: pool, abi: binaryPoolWriteAbi, functionName: "placeBinaryOrderFor",
    args, account: operator,
  });
  console.log(`  ${ok("simulation passed")} — the pool accepts the delegated call`);
} catch (e) {
  reverted = String(e?.shortMessage ?? e?.message ?? e).slice(0, 400);
  console.log(`  ${bad("simulation REVERTED")}`);
  console.log(dim(`  ${reverted.split("\n").slice(0, 4).join("\n  ")}`));
}

if (!reverted) {
  try {
    placeTx = await opWallet.writeContract({
      address: pool, abi: binaryPoolWriteAbi, functionName: "placeBinaryOrderFor", args,
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash: placeTx });
    console.log(`  tx       ${placeTx}`);
    console.log(`  status   ${rcpt.status}`);
    console.log(`  explorer ${EXPLORER}/tx/${placeTx}`);
    if (rcpt.status !== "success") reverted = "receipt status: reverted";
  } catch (e) {
    reverted = String(e?.shortMessage ?? e?.message ?? e).slice(0, 300);
    console.log(`  ${bad("send failed")}: ${reverted}`);
  }
}

// ── who paid, who got the position ─────────────────────────────────────────
h2("  Who paid, and who holds the position?");
const b1 = { owner: await bal(owner.address), operator: await bal(operator.address) };
const allowance1 = await pub.readContract({
  address: USDC, abi: erc20, functionName: "allowance", args: [owner.address, pool],
});
const vault1 = await readVault();
const d = (a, b) => `${a === b ? dim("unchanged") : (b > a ? ok("+") : bad("-")) + formatUnits(b > a ? b - a : a - b, 6)}`;

console.log(`  owner tUSDC      ${formatUnits(b0.owner.usdc, 6)} → ${formatUnits(b1.owner.usdc, 6)}  ${d(b0.owner.usdc, b1.owner.usdc)}`);
console.log(`  operator tUSDC   ${formatUnits(b0.operator.usdc, 6)} → ${formatUnits(b1.operator.usdc, 6)}  ${d(b0.operator.usdc, b1.operator.usdc)}`);
console.log(`  owner allowance  ${formatUnits(allowance0, 6)} → ${formatUnits(allowance1, 6)}`);
if (vault0 !== null) console.log(`  owner vault      ${formatUnits(vault0, 6)} → ${formatUnits(vault1 ?? 0n, 6)}`);

// ── verdict ────────────────────────────────────────────────────────────────
h2("  VERDICT — paste into docs/RESEARCH.md");
const q1 = reverted ? bad("NO") : ok("YES");
console.log(`  Q1  Binary pool honours 0x5d97c566?      ${q1}`);
if (reverted) console.log(dim(`      reason: ${reverted.split("\n")[0]}`));

const q2 = globallyApproved === true && authorized === true
  ? ok("YES — global grant reaches binary pools")
  : authorized === true ? warn("resolved true, but not via the global slot — inspect")
  : bad("NO — global grant does NOT authorise; try setOperatorApprovalForPool");
console.log(`  Q2  Global grant sufficient?             ${q2}`);

const spentFromWallet = b1.owner.usdc < b0.owner.usdc;
const spentFromVault = vault0 !== null && vault1 !== null && vault1 < vault0;
const q3 = spentFromWallet ? "owner's WALLET (via allowance to the pool)"
  : spentFromVault ? "owner's VAULT balance in the pool"
  : reverted ? warn("unknown — order did not execute")
  : dim("no collateral moved (IOC may not have crossed)");
console.log(`  Q3  Escrow pulled from:                  ${q3}`);

console.log(`\n  ${dim("Owner collateral moving while the OPERATOR paid gas is the whole product.")}`);
if (!reverted && spentFromWallet) {
  console.log(`  ${ok("Budget = the owner's ERC20 allowance. An operator cannot raise it.")}`);
}
if (reverted) {
  console.log(`\n  ${warn("Chunk 0 gate FAILED. Do not start chunk 1 — re-plan first (docs/PLAN.md).")}`);
} else {
  console.log(`\n  ${ok("Chunk 0 gate PASSED. Record the answers, then start chunk 1.")}`);
}
console.log();
process.exit(reverted ? 1 : 0);
