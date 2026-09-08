import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, formatUnits, verifyMessage, isAddress, type Address, type Hex } from "viem";
import { somniaTestnet } from "viem/chains";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { store } from "@/lib/store";
import { sealKey } from "@/lib/vault";
import { agentKeyMessage, agentKeyFromSignature, agentAddressFromKey } from "@/lib/agentkey";
import { AGENTS } from "@/lib/agents";
import { RPC_URL, AGENT_GAS_TOPUP_WEI, AGENT_GAS_MIN_WEI, HOUSE_GAS_FLOOR_WEI } from "@/lib/config";

export const dynamic = "force-dynamic";

const erc20 = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const pub = () => createPublicClient({ chain: somniaTestnet, transport: http(RPC_URL) });

async function funding(address: Address) {
  const c = pub();
  const [stt, usdc] = await Promise.all([
    c.getBalance({ address }).catch(() => 0n),
    c.readContract({
      address: SOMNIA_TESTNET_ADDRESSES.testUsdc as Address,
      abi: erc20, functionName: "balanceOf", args: [address],
    }).catch(() => 0n),
  ]);
  return {
    stt: formatUnits(stt, 18),
    usdc: formatUnits(usdc as bigint, 6),
    funded: (usdc as bigint) > 0n,
    hasGas: stt > 0n,
  };
}

/** The owner's agents, with live balances so the UI can show funding state. */
export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner || !isAddress(owner)) {
    return NextResponse.json({ error: "owner required" }, { status: 400 });
  }
  const rows = await store.agentsFor(owner);
  // The owner's own collateral, so the deploy page can show what is fundable
  // and cap the input at it.
  const ownerBalance = await pub()
    .readContract({
      address: SOMNIA_TESTNET_ADDRESSES.testUsdc as Address,
      abi: erc20, functionName: "balanceOf", args: [owner as Address],
    })
    .then((v) => formatUnits(v as bigint, 6))
    .catch(() => "0");
  const agents = await Promise.all(
    rows.map(async (a) => {
      const desk = AGENTS.find((d) => d.id === a.deskId);
      return {
        deskId: a.deskId,
        instance: a.idx,
        name: desk?.name ?? a.deskId,
        thesis: desk?.thesis ?? "",
        color: desk?.color ?? "#888",
        address: a.address,
        risk: a.risk,
        status: a.status,
        createdAt: a.createdAt,
        balance: await funding(a.address as Address),
      };
    }),
  );
  return NextResponse.json({ owner, ownerBalance, agents });
}

/**
 * Register a derived agent wallet.
 *
 * The client signs `agentKeyMessage` and sends the SIGNATURE, not the key — the
 * server derives the key the same way the owner would, which means the owner can
 * always re-derive it themselves and sweep the wallet without us. We verify the
 * signature against the claimed owner so nobody can register a wallet for someone
 * else's address.
 */
export async function POST(req: NextRequest) {
  let body: { owner?: string; deskId?: string; signature?: string; risk?: string; instance?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { owner, deskId, signature } = body;
  const risk = body.risk === "low" || body.risk === "high" ? body.risk : "medium";

  if (!owner || !isAddress(owner)) return NextResponse.json({ error: "owner required" }, { status: 400 });
  if (!deskId || !AGENTS.some((d) => d.id === deskId)) {
    return NextResponse.json({ error: "unknown deskId" }, { status: 400 });
  }
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return NextResponse.json({ error: "signature required" }, { status: 400 });
  }

  // The instance lets one owner run several agents of the same desk; it is part
  // of the signed message, so a signature for instance 0 cannot register 1.
  const instance = Number.isInteger(body.instance) && (body.instance as number) >= 0
    ? (body.instance as number)
    : 0;
  const message = agentKeyMessage(owner as Address, deskId, instance);
  const valid = await verifyMessage({
    address: owner as Address, message, signature: signature as Hex,
  }).catch(() => false);
  if (!valid) {
    return NextResponse.json({ error: "signature does not match owner" }, { status: 401 });
  }

  const key = agentKeyFromSignature(signature as Hex);
  const address = agentAddressFromKey(key);

  // An agent is only real once it is funded. Registering an empty wallet
  // produces exactly the orphan this flow used to create: a "running" agent
  // that can never trade, sitting in a fleet doing nothing.
  const funded = await funding(address);
  if (!funded.funded) {
    return NextResponse.json(
      { error: "fund the agent wallet before deploying it", address, balance: funded },
      { status: 409 },
    );
  }

  await store.upsertAgent({
    owner: owner.toLowerCase(),
    deskId,
    idx: instance,
    address: address.toLowerCase(),
    sealedKey: sealKey(key),
    risk,
    status: "running",
    createdAt: Math.floor(Date.now() / 1000),
  });

  // Gas is on us: the user should only ever have to send tUSDC.
  const gas = await topUpGas(address);

  return NextResponse.json({
    ok: true,
    deskId,
    instance,
    address,
    risk,
    gas,
    balance: await funding(address),
  });
}

/**
 * Send the agent a little STT so it can pay for its own orders. Best-effort —
 * a failure here is not fatal, the agent simply cannot trade until funded.
 *
 * Registration is open to anyone who can sign for an address they control, so
 * this is a faucet an attacker could farm with throwaway wallets. The floor
 * bounds the damage: the house stops funding strangers before it stops being
 * able to operate. Found in the chunk 0–3 audit.
 */
async function topUpGas(address: Address): Promise<{ sent: boolean; note: string }> {
  const pk = process.env.PRIVATE_KEY as Hex | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return { sent: false, note: "no house key configured" };
  try {
    const c = pub();
    const have = await c.getBalance({ address });
    if (have >= AGENT_GAS_MIN_WEI) return { sent: false, note: "already has gas" };

    const houseAddress = privateKeyToAccount(pk).address;
    const houseBalance = await c.getBalance({ address: houseAddress });
    if (houseBalance < HOUSE_GAS_FLOOR_WEI) {
      return { sent: false, note: "house gas reserve is low — fund the agent's gas manually" };
    }

    const { createWalletClient } = await import("viem");
    const house = createWalletClient({
      account: privateKeyToAccount(pk), chain: somniaTestnet, transport: http(RPC_URL),
    });
    const hash = await house.sendTransaction({ to: address, value: AGENT_GAS_TOPUP_WEI });
    await c.waitForTransactionReceipt({ hash });
    return { sent: true, note: hash };
  } catch (e) {
    return { sent: false, note: String(e instanceof Error ? e.message : e).slice(0, 120) };
  }
}
