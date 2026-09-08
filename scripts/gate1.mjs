/**
 * Chunk 1 gate — see docs/PLAN.md.
 *
 *   1. a connected wallet produces a STABLE agent address across reloads
 *   2. the SAME signature re-derives the SAME key (owner can always recover)
 *   3. a different desk gets a different wallet
 *   4. the agent shows a non-zero tUSDC balance after funding
 *
 * Simulates the browser: signs the derivation message with a local key, posts it
 * to /api/agent exactly as the client will, then funds the agent and re-reads.
 *
 *   npm run gate1        (needs the dev server on :4311)
 */
import { createPublicClient, createWalletClient, http, formatUnits, keccak256, parseAbi } from "viem";
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
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), dim = (s) => c(90, s);
let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`  ${pass ? ok("PASS") : bad("FAIL")}  ${label}${detail ? dim("  " + detail) : ""}`);
  if (!pass) failures++;
};

const owner = privateKeyToAccount(process.env.PRIVATE_KEY);
const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const wallet = createWalletClient({ account: owner, chain: somniaTestnet, transport: http(RPC) });

const message = (o, desk) => [
  "Aioxy — derive agent key (v1)", "",
  `owner: ${o.toLowerCase()}`, `agent: ${desk}`, "",
  "Signing this derives the private key for this agent's wallet.",
  "Anyone holding this signature controls that wallet. Only sign it on Aioxy.",
].join("\n");

const register = async (desk, risk = "medium") => {
  const signature = await wallet.signMessage({ message: message(owner.address, desk) });
  const r = await fetch(`${BASE}/api/agent`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: owner.address, deskId: desk, signature, risk }),
  });
  return { body: await r.json(), status: r.status, signature };
};

console.log(`\n${c(1, "  Chunk 1 gate — agent wallet: derive, store, fund")}`);
console.log(`  owner ${owner.address}\n`);

// 1 + 2 — determinism
const a1 = await register("clockwork");
if (a1.status !== 200) { console.log(bad(`  registration failed: ${JSON.stringify(a1.body)}`)); process.exit(1); }
const a2 = await register("clockwork");
check("agent address is stable across re-registration", a1.body.address === a2.body.address, a1.body.address);
check("same signature re-derives the same key", keccak256(a1.signature) === keccak256(a2.signature));
check("key is derivable by the owner alone (address matches local derivation)",
  privateKeyToAccount(keccak256(a1.signature)).address.toLowerCase() === String(a1.body.address).toLowerCase());

// 3 — separate desks, separate wallets
const b1 = await register("driftwood");
check("a different desk gets a different wallet", b1.body.address !== a1.body.address, b1.body.address);

// signature forgery must be refused
const forged = await fetch(`${BASE}/api/agent`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ owner: owner.address, deskId: "clockwork", signature: "0x" + "11".repeat(65) }),
});
check("a signature that does not match the owner is refused", forged.status === 401);

// gas top-up
check("house topped the agent up with gas", a1.body.gas?.sent === true || a1.body.balance?.hasGas === true,
  `stt=${a1.body.balance?.stt}`);

// 4 — funding
const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc;
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const before = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a1.body.address] });
if (before === 0n) {
  console.log(dim(`\n  funding the agent with 25 tUSDC ...`));
  const hash = await wallet.writeContract({ address: USDC, abi: erc20, functionName: "transfer", args: [a1.body.address, 25_000_000n] });
  await pub.waitForTransactionReceipt({ hash });
  console.log(dim(`  ${hash}`));
}
const got = await fetch(`${BASE}/api/agent?owner=${owner.address}`).then((r) => r.json());
const mine = got.agents?.find((x) => x.deskId === "clockwork");
check("GET returns the agent with a live balance", Boolean(mine), `${mine?.balance?.usdc} tUSDC`);
check("agent reports funded", mine?.balance?.funded === true);
check("agent persisted with its risk profile", mine?.risk === "medium" && mine?.status === "running");

console.log(`\n  agent wallet ${a1.body.address}`);
console.log(`  ${formatUnits(await pub.getBalance({ address: a1.body.address }), 18).slice(0, 6)} STT · ${mine?.balance?.usdc} tUSDC`);
console.log(failures === 0
  ? `\n  ${ok("Chunk 1 gate PASSED")} — start chunk 2.\n`
  : `\n  ${bad(`Chunk 1 gate FAILED (${failures})`)} — fix before chunk 2.\n`);
process.exit(failures ? 1 : 0);
