import { NextRequest, NextResponse } from "next/server";
import { isAddress, verifyMessage, type Address, type Hex } from "viem";
import { store } from "@/lib/store";
import { usernameMessage } from "@/lib/agentkey";

export const dynamic = "force-dynamic";

/** 2–20 characters, letters/digits/_-. — enough to be a handle, not a sentence. */
const VALID = /^[a-zA-Z0-9_.-]{2,20}$/;

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner || !isAddress(owner)) {
    return NextResponse.json({ error: "owner required" }, { status: 400 });
  }
  return NextResponse.json({ owner, username: (await store.profile(owner))?.username ?? null });
}

/**
 * Claim a display name.
 *
 * Authorised by the owner's signature — the leaderboard is public, so without
 * this anyone could rename anyone else.
 */
export async function POST(req: NextRequest) {
  let body: { owner?: string; username?: string; signature?: string; nonce?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { owner, username, signature, nonce } = body;

  if (!owner || !isAddress(owner)) return NextResponse.json({ error: "owner required" }, { status: 400 });
  if (!username || !VALID.test(username)) {
    return NextResponse.json(
      { error: "2–20 characters, letters, digits, dot, dash or underscore" },
      { status: 400 },
    );
  }
  if (!signature || typeof nonce !== "number") {
    return NextResponse.json({ error: "signature required" }, { status: 401 });
  }
  if (Math.abs(Date.now() - nonce) > 5 * 60_000) {
    return NextResponse.json({ error: "signature expired" }, { status: 401 });
  }

  const valid = await verifyMessage({
    address: owner as Address,
    message: usernameMessage(owner as Address, username, nonce),
    signature: signature as Hex,
  }).catch(() => false);
  if (!valid) return NextResponse.json({ error: "signature does not match owner" }, { status: 401 });

  const ok = await store.setUsername(owner, username);
  if (!ok) return NextResponse.json({ error: "that name is taken" }, { status: 409 });

  return NextResponse.json({ ok: true, owner, username });
}
