import { NextRequest, NextResponse } from "next/server";
import { isAddress, verifyMessage, type Address, type Hex } from "viem";
import { store } from "@/lib/store";
import { openKey } from "@/lib/vault";
import { sweepHome } from "@/lib/settle";
import { burnCompleteSets } from "@/lib/agenttrader";
import { liveRounds, settledRounds } from "@/lib/indexer";
import { internalAuthorized } from "@/lib/internal";
import { withdrawMessage } from "@/lib/agentkey";

export const dynamic = "force-dynamic";

/**
 * Move collateral from an agent wallet back to its owner.
 *
 * The user-facing withdraw. It needs nothing from us that the owner could not
 * do alone — they can re-derive the same key from a signature and sweep it
 * themselves — so this is a convenience, not a gate.
 */
export async function POST(req: NextRequest) {
  let body: { owner?: string; deskId?: string; address?: string; amount?: number; signature?: string; nonce?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { owner, deskId, amount, signature, nonce } = body;
  if (!owner || !isAddress(owner)) return NextResponse.json({ error: "owner required" }, { status: 400 });
  if (!deskId) return NextResponse.json({ error: "deskId required" }, { status: 400 });

  // Two ways in: the server-side secret (runner and gates), or the owner's own
  // signature (the browser, which must never hold that secret).
  if (!internalAuthorized(req)) {
    if (!signature || typeof nonce !== "number") {
      return NextResponse.json({ error: "signature required" }, { status: 401 });
    }
    const message = withdrawMessage(owner as Address, deskId, String(amount ?? "all"), nonce);
    const valid = await verifyMessage({ address: owner as Address, message, signature: signature as Hex })
      .catch(() => false);
    if (!valid) return NextResponse.json({ error: "signature does not match owner" }, { status: 401 });
    // A stale signature must not stay spendable.
    if (Math.abs(Date.now() - nonce) > 5 * 60_000) {
      return NextResponse.json({ error: "signature expired" }, { status: 401 });
    }
  }

  // An owner can run several agents on one desk, so the wallet address is the
  // unambiguous handle. deskId still works for the single-agent case.
  const agent = body.address
    ? await store.agentByAddress(body.address)
    : await store.agent(owner, deskId);
  if (!agent) return NextResponse.json({ error: "no agent" }, { status: 404 });
  if (agent.owner.toLowerCase() !== owner.toLowerCase()) {
    return NextResponse.json({ error: "not your agent" }, { status: 403 });
  }

  const key = openKey(agent.sealedKey) as Hex | null;
  if (!key) return NextResponse.json({ error: "agent key unreadable" }, { status: 409 });

  // Anything the agent minted but never sold sits as a complete set, which is
  // collateral in the wrong form and invisible to a tUSDC sweep. Turn it back
  // into collateral first, or "withdraw all" quietly returns nothing while the
  // wallet still holds the money.
  // Both halves matter. A set on a round that is still open is burned; one on a
  // round that has already resolved has to be redeemed instead, and that is
  // where stranded collateral tends to be found, because it sits unnoticed
  // until the round ends.
  const [live, done] = await Promise.all([
    liveRounds(24).catch(() => []),
    settledRounds(40).catch(() => []),
  ]);
  const recovered = await burnCompleteSets(key, [
    ...live,
    ...done.map((m) => ({ ...m, finalized: true })),
  ]);

  const res = await sweepHome(key, owner as Address, amount);
  return NextResponse.json({ ...res, recovered, agent: agent.address, owner });
}
