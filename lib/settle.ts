import "server-only";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { somniaTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SOMNIA_TESTNET_ADDRESSES, binarySettlementAbi, erc6909Abi } from "@somnia-chain/markets-sdk";
import { RPC_URL } from "./config";

/**
 * Settlement, on chain.
 *
 * Two separate actions, deliberately kept apart because they prove different
 * things:
 *
 *   redeem  — burn winning outcome tokens for collateral, from the agent's key
 *   sweep   — send that collateral to the OWNER'S main wallet
 *
 * The sweep is the point. Leaving winnings to pile up in an agent wallet grows
 * the amount a user is trusting us with; moving them home keeps the trust
 * surface at roughly what they funded (docs/IDEA.md).
 */

const USDC = SOMNIA_TESTNET_ADDRESSES.testUsdc as Address;
const SETTLEMENT = SOMNIA_TESTNET_ADDRESSES.binarySettlement as Address;

/**
 * Redemption goes DIRECT to BinarySettlement, not through BinaryMarketsModule.
 *
 * The module path reverts `InsufficientPermission()` for an ordinary EOA — it
 * wants operator attribution we do not have, the same family of restriction
 * that made `placeBinaryOrderFor` unreachable (docs/RESEARCH.md §2). The
 * settlement singleton accepts the position holder directly, which is what an
 * agent wallet is.
 */

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

const pub = () => createPublicClient({ chain: somniaTestnet, transport: http(RPC_URL) });
const walletFor = (key: Hex) =>
  createWalletClient({ account: privateKeyToAccount(key), chain: somniaTestnet, transport: http(RPC_URL) });

export type SettleResult = {
  redeemTx?: string;
  sweepTx?: string;
  /** Collateral released by the redemption, in whole tUSDC. */
  redeemed: number;
  /** Collateral actually sent home, in whole tUSDC. */
  sweptHome: number;
  error?: string;
};

/**
 * Redeem a settled winning position and send the proceeds to the owner.
 *
 * `outcomeIdx` is the side the agent HELD (0 = YES/UP, 1 = NO/DOWN). Redeeming a
 * losing side releases nothing, so callers should only reach here on a win — but
 * the balance delta is measured rather than assumed, so a zero payout is
 * reported honestly instead of being invented.
 */
export async function redeemAndSweep(opts: {
  key: Hex;
  owner: Address;
  /** ERC-6909 outcome id held — the market's yesTokenId or noTokenId. */
  outcomeId: bigint;
  /** Outcome-token amount to burn, in whole contracts. */
  contracts: number;
}): Promise<SettleResult> {
  const { key, owner, contracts } = opts;
  const account = privateKeyToAccount(key);
  const client = pub();
  const wallet = walletFor(key);

  const balanceOf = () =>
    client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [account.address] });

  let redeemTx: string | undefined;
  let released = 0n;
  try {
    const before = await balanceOf();

    // The settlement contract burns the caller's tokens, so it must be an
    // operator on the ERC-6909 singleton first. One approval per agent wallet.
    const singleton = await client.readContract({
      address: SETTLEMENT, abi: parseAbi(["function outcomeToken() view returns (address)"]),
      functionName: "outcomeToken",
    }) as Address;
    const isOp = await client.readContract({
      address: singleton, abi: erc6909Abi, functionName: "isOperator",
      args: [account.address, SETTLEMENT],
    });
    if (!isOp) {
      const approve = await wallet.writeContract({
        address: singleton, abi: erc6909Abi, functionName: "setOperator", args: [SETTLEMENT, true],
      });
      await client.waitForTransactionReceipt({ hash: approve });
    }

    const hash = await wallet.writeContract({
      address: SETTLEMENT,
      abi: binarySettlementAbi,
      functionName: "redeem",
      args: [opts.outcomeId, BigInt(Math.round(contracts * 1e6)), account.address],
    });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { redeemed: 0, sweptHome: 0, redeemTx: hash, error: "redeem reverted" };
    redeemTx = hash;
    released = (await balanceOf()) - before;
  } catch (e) {
    return { redeemed: 0, sweptHome: 0, error: `redeem failed: ${msg(e)}` };
  }

  // Nothing came back — a losing side, or already redeemed. Not an error.
  if (released <= 0n) return { redeemed: 0, sweptHome: 0, redeemTx };

  let sweepTx: string | undefined;
  try {
    const hash = await wallet.writeContract({
      address: USDC, abi: erc20, functionName: "transfer", args: [owner, released],
    });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status === "success") sweepTx = hash;
  } catch (e) {
    // The redemption stands even if the sweep fails; the funds are simply still
    // in the agent wallet and the next attempt will move them.
    return { redeemed: Number(released) / 1e6, sweptHome: 0, redeemTx, error: `sweep failed: ${msg(e)}` };
  }

  return {
    redeemed: Number(released) / 1e6,
    sweptHome: sweepTx ? Number(released) / 1e6 : 0,
    redeemTx,
    sweepTx,
  };
}

/**
 * Move free collateral from an agent wallet to its owner, unconditionally.
 *
 * The user-facing "withdraw" — it needs no permission from us beyond the key,
 * and the owner can always do it themselves by re-deriving that key.
 */
export async function sweepHome(key: Hex, owner: Address, amount?: number): Promise<{ txHash?: string; sent: number; error?: string }> {
  const account = privateKeyToAccount(key);
  const client = pub();
  try {
    const balance = await client.readContract({
      address: USDC, abi: erc20, functionName: "balanceOf", args: [account.address],
    });
    const value = amount == null ? balance : BigInt(Math.round(amount * 1e6));
    if (value <= 0n || value > balance) return { sent: 0, error: "nothing to sweep" };

    const hash = await walletFor(key).writeContract({
      address: USDC, abi: erc20, functionName: "transfer", args: [owner, value],
    });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { sent: 0, txHash: hash, error: "sweep reverted" };
    return { txHash: hash, sent: Number(value) / 1e6 };
  } catch (e) {
    return { sent: 0, error: msg(e) };
  }
}

const msg = (e: unknown) =>
  String(e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : e).slice(0, 200);

/**
 * Redeem one outcome leg into the agent's own wallet, leaving it there.
 *
 * `redeemAndSweep` is the settlement path and sends the proceeds home. Recovery
 * needs the other half of that: put the collateral back where it came from, so
 * the caller can decide what happens next.
 */
export async function redeemOutcome(
  key: Hex,
  outcomeId: bigint,
  contracts: number,
): Promise<{ redeemed: number; txHash?: string; error?: string }> {
  const account = privateKeyToAccount(key);
  const client = pub();
  const wallet = walletFor(key);
  const balanceOf = () =>
    client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [account.address] });

  try {
    const before = await balanceOf();
    const singleton = (await client.readContract({
      address: SETTLEMENT, abi: parseAbi(["function outcomeToken() view returns (address)"]),
      functionName: "outcomeToken",
    })) as Address;
    const isOp = await client.readContract({
      address: singleton, abi: erc6909Abi, functionName: "isOperator", args: [account.address, SETTLEMENT],
    });
    if (!isOp) {
      const approve = await wallet.writeContract({
        address: singleton, abi: erc6909Abi, functionName: "setOperator", args: [SETTLEMENT, true],
      });
      await client.waitForTransactionReceipt({ hash: approve });
    }
    const hash = await wallet.writeContract({
      address: SETTLEMENT, abi: binarySettlementAbi, functionName: "redeem",
      args: [outcomeId, BigInt(Math.round(contracts * 1e6)), account.address],
    });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { redeemed: 0, txHash: hash, error: "redeem reverted" };
    const released = (await balanceOf()) - before;
    return { redeemed: Number(released) / 1e6, txHash: hash };
  } catch (e) {
    return { redeemed: 0, error: `redeem failed: ${msg(e)}` };
  }
}
