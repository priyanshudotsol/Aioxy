import { NextRequest, NextResponse } from "next/server";
import { isAddress, type Address, type Hex } from "viem";
import { store } from "@/lib/store";
import { internalAuthorized } from "@/lib/internal";
import { openKey } from "@/lib/vault";
import { agentTake, agentBalance, sizeFor, RISK, type Risk } from "@/lib/agenttrader";
import type { Direction } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Place one order from an agent's own wallet.
 *
 * Exists so the trading path is reachable and testable on its own (chunk 2's
 * gate drives it directly) before the runner starts calling it on a tick. The
 * runner will call `agentTake` in-process rather than coming back through HTTP.
 */
export async function POST(req: NextRequest) {
  // This route reaches a user's agent key and identity here is a public address,
  // so it must never be callable by an anonymous browser request.
  if (!internalAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    owner?: string; deskId?: string; pool?: string; direction?: string;
    limitPrice?: number; contracts?: number; expiry?: number; dryRun?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { owner, deskId, pool, direction, limitPrice, expiry } = body;
  if (!owner || !isAddress(owner)) return NextResponse.json({ error: "owner required" }, { status: 400 });
  if (!deskId) return NextResponse.json({ error: "deskId required" }, { status: 400 });
  if (!pool || !isAddress(pool)) return NextResponse.json({ error: "pool required" }, { status: 400 });
  if (direction !== "UP" && direction !== "DOWN") {
    return NextResponse.json({ error: "direction must be UP or DOWN" }, { status: 400 });
  }
  if (typeof limitPrice !== "number" || !(limitPrice > 0 && limitPrice < 1)) {
    return NextResponse.json({ error: "limitPrice must be between 0 and 1" }, { status: 400 });
  }
  if (typeof expiry !== "number" || expiry <= Math.floor(Date.now() / 1000)) {
    return NextResponse.json({ error: "expiry must be in the future" }, { status: 400 });
  }

  const agent = await store.agent(owner, deskId);
  if (!agent) return NextResponse.json({ error: "no agent deployed for this owner/desk" }, { status: 404 });
  if (agent.status !== "running") return NextResponse.json({ error: "agent is paused" }, { status: 409 });

  const key = openKey(agent.sealedKey) as Hex | null;
  if (!key) {
    // A key sealed under a rotated AGENT_KEY_SECRET is unreadable. Skip loudly
    // rather than crashing — the owner can re-derive and re-register.
    return NextResponse.json({ error: "agent key unreadable — re-deploy the agent" }, { status: 409 });
  }

  const balance = await agentBalance(agent.address as Address);
  const risk = (agent.risk in RISK ? agent.risk : "medium") as Risk;
  // An explicit size is honoured (the gate asks for exactly 1); otherwise the
  // risk profile decides.
  const want = typeof body.contracts === "number" && body.contracts > 0
    ? Math.floor(body.contracts)
    : sizeFor(balance, limitPrice, risk);

  if (want < 1) {
    return NextResponse.json(
      { filled: false, error: `insufficient balance: ${balance} tUSDC at ${limitPrice}` },
      { status: 200 },
    );
  }
  if (want * limitPrice > balance) {
    return NextResponse.json(
      { filled: false, error: `size ${want} exceeds balance ${balance} tUSDC` },
      { status: 200 },
    );
  }

  // Lets the gate assert risk sizing without spending real collateral.
  if (body.dryRun) {
    return NextResponse.json({ dryRun: true, contracts: want, balance, risk, agent: agent.address });
  }

  const res = await agentTake({
    key,
    pool: pool as Address,
    direction: direction as Direction,
    limitPrice,
    contracts: want,
    expiry,
  });

  return NextResponse.json({ ...res, agent: agent.address, contracts: want, balance, risk });
}
