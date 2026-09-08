/**
 * Live testnet smoke test — proves the write path end to end.
 *
 * Picks the soonest live round that has a crossable book, sends ONE
 * immediate-or-cancel order for a single contract, and reports the transaction
 * hash plus the fill as the indexer sees it.
 *
 *   npm run smoke
 */
import { createPublicClient, http, formatUnits } from "viem";
import { somniaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
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

const gql = async (q) => {
  const r = await fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};

const die = (m) => {
  console.error(`\n  \x1b[31m${m}\x1b[0m\n`);
  process.exit(1);
};

const pk = process.env.PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) die("PRIVATE_KEY missing — run npm run doctor");
const account = privateKeyToAccount(pk);
console.log(`\n  Live smoke test — ${account.address}\n`);

const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const erc20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const [gas, coll] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.readContract({ address: SOMNIA_TESTNET_ADDRESSES.testUsdc, abi: erc20, functionName: "balanceOf", args: [account.address] }).catch(() => 0n),
]);
if (gas === 0n) die("No STT for gas. Fund at https://testnet.somnia.network/ then retry.");
if (coll === 0n) die("No tUSDC collateral. Ask in the SomniaHacks faucet topic, then retry.");
console.log(`  gas ${formatUnits(gas, 18)} STT · collateral ${formatUnits(coll, 6)} tUSDC`);

// ── find a round with something to cross ───────────────────────────────────
const now = Math.floor(Date.now() / 1000);
const { Market: rounds } = await gql(`{
  Market(where:{marketType:{_eq:"BINARY"},asset:{_in:["BTC","ETH"]},intervalSec:{_lte:"86400"},
    finalized:{_eq:false},expiry:{_gt:"${now + 60}"},clobStatus:{_eq:"Trading"}},
    order_by:{expiry:asc}, limit:10){ marketId asset intervalSec expiry binaryPoolAddress }
}`);
if (rounds.length === 0) die("No live rounds open. Try again in a minute.");

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
if (!target) die("Live rounds exist but no resting depth to cross. Try again shortly.");

const { r, dir, px, depth } = target;
console.log(`  round  ${r.asset} ${r.intervalSec}s, expires in ${r.expiry - now}s`);
console.log(`  taking ${dir} at ${(px * 100).toFixed(1)}c (depth ${depth.toFixed(0)}), 1 contract\n`);

// ── send it ────────────────────────────────────────────────────────────────
const ex = new SomniaMarkets({
  chain: somniaTestnet,
  addresses: SOMNIA_TESTNET_ADDRESSES,
  privateKey: pk,
  wsRpcUrl: WS,
  indexerUrl: INDEXER,
});

// Price is quoted on the YES axis: backing DOWN at p is YES at 1-p.
const yesPrice = dir === "UP" ? px : 1 - px;
const limit = Math.min(0.99, yesPrice + 0.02); // small buffer so it crosses

try {
  const res = await ex.trader.placeOrder({
    pool: r.binaryPoolAddress,
    side: dir === "UP" ? "BUY_YES" : "BUY_NO",
    price: BigInt(Math.round(limit * 1e6)),
    quantity: BigInt(1e6), // one whole contract
    orderType: 2, // IOC
  });
  const hash = res.receipt?.transactionHash ?? res.hash;
  const status = res.receipt?.status;
  console.log(`  tx      ${hash}`);
  console.log(`  status  ${status ?? "(no receipt)"}`);
  console.log(`  gasUsed ${res.receipt?.gasUsed ?? "-"}`);
  console.log(`  explorer ${EXPLORER}/tx/${hash}`);
  if (status && status !== "success") die("Transaction reverted — see explorer.");

  // ── confirm the indexer saw a fill ───────────────────────────────────────
  process.stdout.write("\n  waiting for the indexer to show the fill");
  let seen = null;
  for (let i = 0; i < 15 && !seen; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    process.stdout.write(".");
    const { Fill } = await gql(`{
      Fill(where:{market_id:{_eq:"${r.marketId}"}}, order_by:{timestamp:desc}, limit:5){ txHash fillPrice quantity taker }
    }`);
    seen = Fill.find((f) => f.txHash?.toLowerCase() === String(hash).toLowerCase());
  }
  console.log();
  if (seen) {
    console.log(`\n  \x1b[32mFILLED\x1b[0m ${Number(seen.quantity) / 1e6} contracts at ${(Number(seen.fillPrice) / 1e6 * 100).toFixed(1)}c`);
    console.log(`  \x1b[32mLive trading on Somnia Shannon testnet is working.\x1b[0m\n`);
  } else {
    console.log(`\n  \x1b[33mTransaction mined, but no fill indexed.\x1b[0m`);
    console.log(`  An IOC that could not cross cancels rather than resting — this is a valid outcome.\n`);
  }
} catch (e) {
  die(`placeOrder failed: ${e?.message ?? e}`);
} finally {
  // The SDK's websocket keeps the loop alive.
  process.exit(0);
}
