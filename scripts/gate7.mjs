/**
 * Chunk 7 gate — dashboard truth + withdraw, proven on chain.
 *
 * The withdraw button is the only place a user moves real money from the UI, so
 * it is tested the way the BROWSER calls it: an owner signature and NO internal
 * secret. A browser must never hold a server credential, so if this path only
 * worked with the secret it would not work at all in production.
 *
 *   1. a signed withdraw succeeds WITHOUT the internal secret -> tx on chain
 *   2. both balances move, in opposite directions, by the same amount
 *   3. an unsigned request is refused
 *   4. a forged signature is refused
 *   5. a stale nonce is refused (replay guard)
 *   6. the dashboard's numbers match a direct chain read
 *
 *   npm run gate7
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
const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const EXPLORER = "https://shannon-explorer.somnia.network";
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), dim = (s) => c(90, s);
let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`  ${pass ? ok("PASS") : bad("FAIL")}  ${label}${detail ? dim("  " + detail) : ""}`);
  if (!pass) failures++;
};

const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const bal = (a) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] });

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const owner = account.address;

/** Exactly the message the browser signs — kept in step with lib/agentkey.ts. */
const withdrawMessage = (o, desk, amount, nonce) => [
  "Aioxy — withdraw from agent (v1)", "",
  `owner: ${o.toLowerCase()}`, `agent: ${desk}`, `amount: ${amount} tUSDC`, `nonce: ${nonce}`, "",
  "Signing this sweeps the agent's collateral back to your wallet.",
].join("\n");

console.log(`\n${c(1, "  Chunk 7 gate — dashboard truth + withdraw")}`);

const fleet = await fetch(`${BASE}/api/fleet?owner=${owner}`).then((r) => r.json());
const target = fleet.agents?.find((a) => Number(a.balance) > 1);
if (!target) { console.log(bad("\n  no funded agent to withdraw from\n")); process.exit(1); }
console.log(`  agent ${target.name} ${target.address}  ${target.balance} tUSDC\n`);

// ── 6. the dashboard must agree with the chain ─────────────────────────────
const onChain = await bal(target.address);
check("dashboard balance matches a direct chain read",
  Math.abs(Number(formatUnits(onChain, 6)) - Number(target.balance)) < 1e-6,
  `api ${target.balance} · chain ${formatUnits(onChain, 6)}`);

// ── 3/4/5. the refusals, before we spend anything ──────────────────────────
const post = (body, headers = {}) =>
  fetch(`${BASE}/api/agent/withdraw`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });

const unsigned = await post({ owner, deskId: target.deskId, amount: 1 });
check("an UNSIGNED withdraw is refused", unsigned.status === 401, `status ${unsigned.status}`);

const forged = await post({ owner, deskId: target.deskId, amount: 1, nonce: Date.now(), signature: "0x" + "22".repeat(65) });
check("a FORGED signature is refused", forged.status === 401, `status ${forged.status}`);

const staleNonce = Date.now() - 10 * 60_000;
const staleSig = await account.signMessage({ message: withdrawMessage(owner, target.deskId, "all", staleNonce) });
const stale = await post({ owner, deskId: target.deskId, nonce: staleNonce, signature: staleSig });
check("a STALE signature is refused (replay guard)", stale.status === 401, `status ${stale.status}`);

// ── 1/2. the real thing: signed, no secret, on chain ───────────────────────
const agentBefore = await bal(target.address);
const ownerBefore = await bal(owner);

const nonce = Date.now();
const signature = await account.signMessage({ message: withdrawMessage(owner, target.deskId, "1", nonce) });
const res = await post({ owner, deskId: target.deskId, amount: 1, nonce, signature }).then((r) => r.json());

check("a SIGNED withdraw succeeds with no internal secret", Boolean(res.txHash), res.txHash ?? res.error ?? "");

if (res.txHash) {
  const rcpt = await pub.getTransactionReceipt({ hash: res.txHash }).catch(() => null);
  check("the withdrawal SUCCEEDED on chain", rcpt?.status === "success",
    `${EXPLORER}/tx/${res.txHash}  block ${rcpt?.blockNumber}`);

  const tx = await pub.getTransaction({ hash: res.txHash }).catch(() => null);
  check("sent FROM the agent wallet", tx?.from?.toLowerCase() === target.address.toLowerCase(), tx?.from);

  const agentAfter = await bal(target.address);
  const ownerAfter = await bal(owner);
  const moved = agentBefore - agentAfter;
  check("agent balance fell", moved > 0n, `${formatUnits(agentBefore, 6)} → ${formatUnits(agentAfter, 6)}`);
  check("OWNER balance rose by exactly the same amount", ownerAfter - ownerBefore === moved,
    `${formatUnits(ownerBefore, 6)} → ${formatUnits(ownerAfter, 6)}  (+${formatUnits(moved, 6)})`);

  // and the dashboard must reflect it
  await new Promise((r) => setTimeout(r, 1500));
  const after = await fetch(`${BASE}/api/fleet?owner=${owner}`).then((r) => r.json());
  const updated = after.agents?.find((a) => a.deskId === target.deskId);
  check("the dashboard reflects the new balance", Number(updated?.balance) < Number(target.balance),
    `${target.balance} → ${updated?.balance}`);
}

// ── activity rows must carry their on-chain evidence ───────────────────────
const withTx = (fleet.activity ?? []).filter((a) => a.txHash);
check("every activity row carries a transaction hash",
  fleet.activity.length > 0 && withTx.length === fleet.activity.length,
  `${withTx.length}/${fleet.activity?.length ?? 0}`);
check("every activity row carries its reasoning",
  (fleet.activity ?? []).every((a) => a.reason && a.reason.length > 10));

console.log(failures === 0
  ? `\n  ${ok("Chunk 7 gate PASSED — withdraw proven on chain from the browser path")}\n`
  : `\n  ${bad(`Chunk 7 gate FAILED (${failures})`)}\n`);
process.exit(failures ? 1 : 0);
