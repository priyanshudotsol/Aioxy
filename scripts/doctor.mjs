/**
 * Preflight for live testnet trading.
 *
 * Answers one question: can this wallet place a real order right now, and if
 * not, exactly what is missing?
 *
 *   npm run doctor
 */
import { createPublicClient, http, formatEther, formatUnits } from "viem";
import { somniaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { readFileSync, existsSync } from "fs";

const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const INDEXER = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";

// Minimal .env.local loader so the script needs no extra dependency.
for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const no = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`;
const problems = [];

console.log("\n  Aioxy — testnet preflight\n");

// 1. key
const pk = process.env.PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.log(no("PRIVATE_KEY missing or malformed in .env.local"));
  problems.push("no key");
  console.log("\n  Cannot continue without a key.\n");
  process.exit(1);
}
const account = privateKeyToAccount(pk);
console.log(ok(`wallet ${account.address}`));

const client = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });

// 2. chain reachable
try {
  const [bn, cid] = await Promise.all([client.getBlockNumber(), client.getChainId()]);
  if (cid !== 50312) throw new Error(`wrong chain ${cid}`);
  console.log(ok(`RPC ${RPC} — chain 50312, block ${bn}`));
} catch (e) {
  console.log(no(`RPC unreachable: ${String(e).slice(0, 90)}`));
  problems.push("rpc");
}

// 3. gas balance
const stt = await client.getBalance({ address: account.address }).catch(() => 0n);
const sttStr = Number(formatEther(stt)).toFixed(4);
if (stt === 0n) {
  console.log(no(`STT (gas): 0 — fund at https://testnet.somnia.network/`));
  problems.push("gas");
} else if (stt < 10n ** 16n) {
  console.log(warn(`STT (gas): ${sttStr} — low, a few writes may exhaust it`));
} else {
  console.log(ok(`STT (gas): ${sttStr}`));
}

// 4. collateral balance
const erc20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const COLLATERAL = SOMNIA_TESTNET_ADDRESSES.testUsdc;
let dec = 6, sym = "tUSDC", bal = 0n;
try {
  [bal, dec, sym] = await Promise.all([
    client.readContract({ address: COLLATERAL, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    client.readContract({ address: COLLATERAL, abi: erc20, functionName: "decimals" }),
    client.readContract({ address: COLLATERAL, abi: erc20, functionName: "symbol" }),
  ]);
} catch {
  console.log(warn("could not read collateral balance"));
}
if (bal === 0n) {
  console.log(no(`${sym} (collateral): 0 — request in the SomniaHacks dev group, faucet topic`));
  problems.push("collateral");
} else {
  console.log(ok(`${sym} (collateral): ${formatUnits(bal, dec)}`));
}

// 5. a live round to trade
const gql = async (q) => {
  const r = await fetch(INDEXER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 120));
  return j.data;
};
const now = Math.floor(Date.now() / 1000);
try {
  const d = await gql(`{ Market(where:{marketType:{_eq:"BINARY"},asset:{_in:["BTC","ETH"]},intervalSec:{_lte:"86400"},finalized:{_eq:false},expiry:{_gt:"${now}"},clobStatus:{_eq:"Trading"}},order_by:{expiry:asc},limit:5){ asset intervalSec expiry binaryPoolAddress } }`);
  if (d.Market.length === 0) {
    console.log(warn("no live rounds open right now — the venue rolls a successor shortly"));
  } else {
    console.log(ok(`${d.Market.length} live rounds — soonest: ${d.Market[0].asset} ${d.Market[0].intervalSec}s in ${d.Market[0].expiry - now}s`));
  }
} catch (e) {
  console.log(no(`indexer: ${String(e).slice(0, 80)}`));
  problems.push("indexer");
}

// 6. mode
console.log(ok("execution: live — every trade is an on-chain transaction"));

console.log();
if (problems.length === 0) {
  console.log("  \x1b[32mReady to trade on testnet.\x1b[0m  Run: npm run smoke\n");
} else {
  console.log(`  \x1b[33mBlocked on: ${problems.join(", ")}\x1b[0m`);
  if (problems.includes("gas")) console.log(`  Fund gas:       https://testnet.somnia.network/  (address above)`);
  if (problems.includes("collateral")) console.log(`  Fund collateral: https://t.me/+XHq0F0JXMyhmMzM0  (faucet topic, ask for tUSDC)`);
  console.log();
}
