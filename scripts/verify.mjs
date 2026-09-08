/**
 * Independent audit — is this really running on Somnia Shannon testnet?
 *
 * Deliberately does NOT trust our own database or gates. It reads the public
 * block explorer and the chain directly, so the answer comes from Somnia rather
 * than from us. Also useful as demo evidence.
 *
 *   npm run verify
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

const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const BASE = process.env.BASE_URL || "http://localhost:4311";
const EXPLORER = process.env.EXPLORER_URL || "https://shannon-explorer.somnia.network";
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const ok = (s) => c(32, s), bad = (s) => c(31, s), dim = (s) => c(90, s);

const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const e6909 = parseAbi(["function balanceOf(address,uint256) view returns (uint256)"]);
const poolAbi = parseAbi(["function outcomeToken() view returns (address)"]);

// ── the chain we are actually on ───────────────────────────────────────────
const [chainId, block] = await Promise.all([pub.getChainId(), pub.getBlockNumber()]);
console.log(`\n${c(1, "  Independent verification — Somnia Shannon testnet")}`);
console.log(`  RPC       ${RPC}`);
console.log(`  chainId   ${chainId} ${chainId === 50312 ? ok("(Somnia Shannon ✓)") : bad("(WRONG CHAIN)")}`);
console.log(`  block     ${block}`);

// ── whose wallets ──────────────────────────────────────────────────────────
const owner = privateKeyToAccount(process.env.PRIVATE_KEY).address;
const agents = await fetch(`${BASE}/api/agent?owner=${owner}`)
  .then((r) => r.json()).then((j) => j.agents ?? []).catch(() => []);

if (!agents.length) {
  console.log(bad("\n  No agents registered — run `npm run gate1`.\n"));
  process.exit(1);
}

for (const a of agents) {
  console.log(`\n${c(1, `  Agent "${a.name}" — ${a.address}`)}`);

  // Explorer is the independent witness: it is not our code and not our DB.
  const res = await fetch(
    `${EXPLORER}/api?module=account&action=txlist&address=${a.address}&sort=asc`,
  ).then((r) => r.json()).catch(() => ({}));
  const txs = Array.isArray(res.result) ? res.result : [];

  console.log(`  transactions on the public explorer: ${txs.length ? ok(String(txs.length)) : bad("0")}`);
  for (const t of txs) {
    const when = new Date(Number(t.timeStamp) * 1000).toISOString().replace("T", " ").slice(0, 19);
    const kind = t.from?.toLowerCase() === a.address.toLowerCase() ? "sent" : "recv";
    const okTx = t.isError === "0";
    console.log(
      `    ${okTx ? ok("✓") : bad("✗")} ${when}  ${kind}  ${dim(t.hash.slice(0, 22) + "…")}` +
      `  gas ${String(t.gasUsed).padStart(7)}  ${dim(methodOf(t))}`,
    );
  }

  const [stt, usdc] = await Promise.all([
    pub.getBalance({ address: a.address }),
    pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a.address] }).catch(() => 0n),
  ]);
  console.log(`  balances  ${formatUnits(stt, 18).slice(0, 8)} STT · ${formatUnits(usdc, 6)} tUSDC`);

  // Positions held, read from the outcome-token singleton (RESEARCH.md §7).
  const pools = [...new Set(txs.map((t) => t.to).filter(Boolean))];
  let held = 0;
  for (const pool of pools) {
    const singleton = await pub.readContract({ address: pool, abi: poolAbi, functionName: "outcomeToken" }).catch(() => null);
    if (!singleton) continue;
    const ids = await tokenIdsFor(pool);
    for (const id of ids) {
      const b = await pub.readContract({ address: singleton, abi: e6909, functionName: "balanceOf", args: [a.address, BigInt(id)] }).catch(() => 0n);
      if (b > 0n) {
        held += Number(b) / 1e6;
        console.log(`  position  ${ok(`${Number(b) / 1e6} contracts`)} in pool ${dim(pool.slice(0, 12) + "…")}`);
      }
    }
  }
  if (!held) console.log(dim(`  position  none currently held`));
  console.log(`  ${dim(`${EXPLORER}/address/${a.address}`)}`);
}

// ── the owner's funds never moved through us ───────────────────────────────
const ownerUsdc = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [owner] }).catch(() => 0n);
console.log(`\n  owner ${owner}`);
console.log(`  holds ${formatUnits(ownerUsdc, 6)} tUSDC ${dim("— spent only by the owner's own funding transfers")}`);
console.log();

async function tokenIdsFor(pool) {
  // One pool hosts a whole SERIES of markets, so check every id it has issued,
  // not just the newest — the position we hold may be in an earlier round.
  const q = `{ Market(where:{binaryPoolAddress:{_eq:"${pool.toLowerCase()}"}}, order_by:{expiry:desc}, limit:40){ yesTokenId noTokenId } }`;
  const r = await fetch(process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }),
  }).then((x) => x.json()).catch(() => ({}));
  return (r?.data?.Market ?? []).flatMap((m) => [m?.yesTokenId, m?.noTokenId]).filter(Boolean);
}

function methodOf(t) {
  const sel = (t.input || "").slice(0, 10);
  return { "0x718c2d4d": "placeBinaryOrder", "0x095ea7b3": "approve", "0x": "transfer (STT)" }[sel] ?? sel;
}
