import { NextResponse } from "next/server";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { CHAIN_ID, EXPLORER } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Public chain addresses the browser needs — the collateral token to fund with. */
export async function GET() {
  return NextResponse.json({
    collateral: SOMNIA_TESTNET_ADDRESSES.testUsdc,
    chainId: CHAIN_ID,
    explorer: EXPLORER,
  });
}
