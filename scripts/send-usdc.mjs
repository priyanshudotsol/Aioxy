/**
 * Send tUSDC from the wallet in .env.local to an address.
 *
 *   node scripts/send-usdc.mjs <to> <amount>
 *   node scripts/send-usdc.mjs 0x0003613a5FBbdB74c7E5af87AB1D6338453391A3 50
 *
 * Prints the balance before and after, and the explorer link for the transfer.
 * Refuses rather than guesses: a malformed address, a bad amount or a balance
 * that will not cover the transfer all stop before anything is signed.
 */
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, parseUnits, isAddress, getAddress } from "viem";
import { somniaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { readFileSync, existsSync } from "fs";
import { createInterface } from "readline/promises";

const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const EXPLORER = process.env.EXPLORER_URL || "https://shannon-explorer.somnia.network";

// Same minimal loader the other scripts use, so this needs no extra dependency.
for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const die = (msg) => {
  console.error(`\n  \x1b[31m✗\x1b[0m ${msg}\n`);
  process.exit(1);
};

const [toArg, amountArg] = process.argv.slice(2);
if (!toArg || !amountArg) die("usage: node scripts/send-usdc.mjs <to> <amount>");
if (!isAddress(toArg)) die(`"${toArg}" is not a valid address`);

const amount = Number(amountArg);
if (!Number.isFinite(amount) || amount <= 0) die(`"${amountArg}" is not a positive amount`);

const pk = process.env.PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) die("PRIVATE_KEY missing or malformed in .env.local");

const to = getAddress(toArg);
const account = privateKeyToAccount(pk);
const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc;
const abi = parseAbi([
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: somniaTestnet, transport: http(RPC) });

const [balance, gas] = await Promise.all([
  pub.readContract({ address: USDC, abi, functionName: "balanceOf", args: [account.address] }),
  pub.getBalance({ address: account.address }),
]);

const value = parseUnits(String(amount), 6);
console.log(`\n  from     ${account.address}`);
console.log(`  to       ${to}`);
console.log(`  amount   ${amount} tUSDC`);
console.log(`  balance  ${formatUnits(balance, 6)} tUSDC · ${formatUnits(gas, 18)} STT for gas\n`);

if (balance < value) die(`balance is short: holds ${formatUnits(balance, 6)}, needs ${amount}`);
if (gas === 0n) die("no STT for gas — fund the sender at https://testnet.somnia.network/");

// A transfer is irreversible, so it is confirmed at the keyboard rather than
// executed on the strength of two command-line arguments.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`  Send ${amount} tUSDC to ${to}? [y/N] `);
rl.close();
if (answer.trim().toLowerCase() !== "y") {
  console.log("\n  Cancelled. Nothing was sent.\n");
  process.exit(0);
}

const hash = await wallet.writeContract({ address: USDC, abi, functionName: "transfer", args: [to, value] });
console.log(`\n  sent     ${hash}`);
console.log(`  explorer ${EXPLORER}/tx/${hash}`);

const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") die(`transaction reverted (${hash})`);

const after = await pub.readContract({ address: USDC, abi, functionName: "balanceOf", args: [to] });
console.log(`  \x1b[32m✓\x1b[0m confirmed in block ${receipt.blockNumber}`);
console.log(`  recipient now holds ${formatUnits(after, 6)} tUSDC\n`);
