import { NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";
import { RISK } from "@/lib/agenttrader";

export const dynamic = "force-dynamic";

/**
 * The desks a user can deploy, and what each risk profile actually means.
 *
 * The risk numbers are the SAME constants the runner decides with, served
 * rather than restated — a UI that described different thresholds from the ones
 * in force would be a lie that drifts silently.
 */
export async function GET() {
  return NextResponse.json({
    desks: AGENTS.map((a) => ({ id: a.id, name: a.name, thesis: a.thesis, color: a.color })),
    risk: Object.entries(RISK).map(([id, r]) => ({
      id,
      minEdge: r.minEdge,
      sizeFraction: r.sizeFraction,
      maxConcurrent: r.maxConcurrent,
    })),
  });
}
