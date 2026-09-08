/**
 * Chunk 5 gate — settlement goes home, ON CHAIN.
 *
 * Per docs/PLAN.md's rule, nothing here counts without a transaction hash.
 * Two claims, proven separately:
 *
 *   A. sweepHome moves collateral from the agent wallet to the OWNER'S wallet
 *      -> a transfer tx, and both balances must move in opposite directions
 *   B. a settled WIN is redeemed on chain and the proceeds sent home
 *      -> a redeem tx + a sweep tx recorded against the trade
 *
 * (B) needs a winning settled position, which depends on the market. When none
 * exists the gate says so rather than passing on a technicality.
 *
 *   npm run gate5
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

const BASE = process.env.BASE_URL || "http://localhost:4311";
const SECRET = process.env.INTERNAL_SECRET || "";
const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const EXPLORER = "https://shannon-explorer.somnia.network";
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), warn = (s) => c(33, s), dim = (s) => c(90, s);
let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`  ${pass ? ok("PASS") : bad("FAIL")}  ${label}${detail ? dim("  " + detail) : ""}`);
  if (!pass) failures++;
};

const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const bal = (a) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });

const owner = privateKeyToAccount(process.env.PRIVATE_KEY).address;
const db = new DatabaseSync(".data/aioxy.db");

console.log(`\n${c(1, "  Chunk 5 gate — payouts settle HOME, on chain")}`);

// ── A. the sweep, proven with a transaction ────────────────────────────────
const agent = db.prepare("SELECT owner,deskId,address FROM agents WHERE owner=? LIMIT 1").get(owner.toLowerCase());
if (!agent) { console.log(bad("\n  no agent for this owner — run gate1\n")); process.exit(1); }

const agentBefore = await bal(agent.address);
const ownerBefore = await bal(owner);
console.log(`  agent ${agent.address}  ${formatUnits(agentBefore, 6)} tUSDC`);
console.log(`  owner ${owner}  ${formatUnits(ownerBefore, 6)} tUSDC\n`);

const res = await fetch(`${BASE}/api/agent/withdraw`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-internal-secret": SECRET },
  body: JSON.stringify({ owner, deskId: agent.deskId, amount: 1 }),
}).then((r) => r.json());

check("withdraw returned a transaction hash", Boolean(res.txHash), res.txHash ?? res.error ?? "");

if (res.txHash) {
  const rcpt = await pub.getTransactionReceipt({ hash: res.txHash }).catch(() => null);
  check("that transaction SUCCEEDED on chain", rcpt?.status === "success",
    `${EXPLORER}/tx/${res.txHash}  block ${rcpt?.blockNumber}`);
  const tx = await pub.getTransaction({ hash: res.txHash }).catch(() => null);
  check("it was sent FROM the agent wallet", tx?.from?.toLowerCase() === agent.address.toLowerCase(), tx?.from);

  const agentAfter = await bal(agent.address);
  const ownerAfter = await bal(owner);
  check("agent balance fell", agentAfter < agentBefore,
    `${formatUnits(agentBefore, 6)} → ${formatUnits(agentAfter, 6)}`);
  check("OWNER balance rose by the same amount", ownerAfter - ownerBefore === agentBefore - agentAfter,
    `owner ${formatUnits(ownerBefore, 6)} → ${formatUnits(ownerAfter, 6)}`);
}

// ── B. redemption of a settled win ─────────────────────────────────────────
console.log();
const wins = db.prepare(
  "SELECT id,agentId,owner,marketId,contracts,redeemTx,sweepTx FROM trades WHERE won=1 AND settled=1 AND owner!='house'",
).all();
if (wins.length === 0) {
  const pending = db.prepare("SELECT COUNT(*) n FROM trades WHERE settled=0 AND owner!='house'").get().n;
  console.log(`  ${warn("PENDING")}  no settled WIN yet — ${pending} positions still open`);
  console.log(dim("           the redeem path cannot be proven until a round resolves in our favour;"));
  console.log(dim("           reporting that rather than passing on a technicality"));
} else {
  const withTx = wins.filter((w) => w.redeemTx);
  check("a winning position was redeemed ON CHAIN", withTx.length > 0,
    withTx[0] && `${EXPLORER}/tx/${withTx[0].redeemTx}`);
  const swept = wins.filter((w) => w.sweepTx);
  check("its proceeds were swept to the owner ON CHAIN", swept.length > 0,
    swept[0] && `${EXPLORER}/tx/${swept[0].sweepTx}`);
  for (const w of withTx.slice(0, 3)) {
    const r = await pub.getTransactionReceipt({ hash: w.redeemTx }).catch(() => null);
    check(`redeem tx for ${w.agentId} confirmed`, r?.status === "success", w.redeemTx);
  }
}

db.close();
console.log(failures === 0
  ? `\n  ${ok("Chunk 5 sweep PROVEN on chain")}${wins.length ? ok(" — redemption too") : warn(" — redemption pending a winning round")}\n`
  : `\n  ${bad(`Chunk 5 gate FAILED (${failures})`)}\n`);
process.exit(failures ? 1 : 0);
