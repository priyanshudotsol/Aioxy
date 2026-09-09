"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { useWallet } from "./WalletProvider";
import { useToast } from "./Toast";
import { EXPLORER } from "@/lib/config";
import { pct, windowLabel, shortAddr } from "@/lib/fmt";
import { withdrawMessage } from "@/lib/agentkey";

type FleetAgent = {
  deskId: string; instance: number; name: string; thesis: string; color: string;
  address: string; risk: string; status: string;
  balance: string; gas: string; sizePct: number; maxConcurrent: number;
  trades: number; settled: number; wins: number; open: number; awaiting: number; pnl: number;
};

type Activity = {
  id: string; agentId: string; asset: string; intervalSec: number;
  direction: "UP" | "DOWN"; price: number; contracts: number; cost: number; reason: string;
  settled: boolean; awaiting: boolean; expiry: number; won: boolean | null; pnl: number | null; placedAt: number;
  txHash: string | null; redeemTx: string | null; sweepTx: string | null;
};

type FleetData = {
  agents: FleetAgent[];
  totals: { agents: number; balance: number; trades: number; settled: number; wins: number; open: number; awaiting: number; pnl: number; staked: number; roi: number | null };
  activity: Activity[];
};

const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;

/**
 * The only place colour carries meaning. Zero is not a gain, so it stays in the
 * theme's ink rather than reading as green — everything else on this page is
 * deliberately monochrome so profit and loss are the one thing that stands out.
 */
const pnlColor = (n: number) => (n === 0 ? "var(--text)" : n > 0 ? "var(--up)" : "var(--down)");

/**
 * One colour per desk, used only as an identity chip beside the name. The rest
 * of the page stays monochrome so profit, loss and open positions remain the
 * things that actually signal.
 */
const DESK_COLOR: Record<string, string> = {
  clockwork: "#8b7cf6",
  driftwood: "#22d3ee",
  undertow: "#f59e0b",
  contrary: "#f43f5e",
};
const deskColor = (id: string) => DESK_COLOR[id] ?? "var(--faint)";

/**
 * Colour for a money figure, by what it represents rather than by its sign:
 * collateral you hold reads green, money already spent reads red, and a P&L
 * takes the sign. Everything that is not money stays monochrome.
 */
const HELD = "var(--up)";
const SPENT = "var(--down)";

/** Replay guard for a withdraw signature; the server rejects anything stale. */
function freshNonce() {
  return Date.now();
}

export default function Dashboard() {
  const { account, walletClient } = useWallet();
  const toast = useToast();
  const [data, setData] = useState<FleetData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);


  const load = useCallback(async () => {
    if (!account) return;
    try {
      const r = await fetch(`/api/fleet?owner=${account}`, { cache: "no-store" });
      setData(await r.json());
    } catch {
      /* keep the last good view */
    }
  }, [account]);

  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) void load(); };
    run();
    const t = setInterval(run, 6000);
    return () => { alive = false; clearInterval(t); };
  }, [load]);

  /**
   * Withdraw is authorised by the OWNER'S signature, not by a server secret —
   * the browser must never hold one. It is a convenience: the same funds can be
   * swept by re-deriving the agent key independently.
   */
  const withdraw = async (a: FleetAgent) => {
    const wc = walletClient();
    if (!wc || !account) return;
    setBusy(a.address);
    try {
      // Read the clock outside the render-tracked path — Date.now() inside the
      // component body is impure and the lint rule is right to reject it.
      const nonce = freshNonce();
      const signature = await wc.signMessage({
        account: account as Address,
        message: withdrawMessage(account as Address, a.deskId, "all", nonce),
      });
      const res = await fetch("/api/agent/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: account, deskId: a.deskId, address: a.address, signature, nonce }),
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);
      toast.ok(`Swept ${res.sent} tUSDC back to your wallet.`, res.txHash);
      setTimeout(() => void load(), 3000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message.slice(0, 160) : String(e));
    } finally {
      setBusy(null);
    }
  };

  const t = data?.totals;
  const winRate = t && t.settled > 0 ? t.wins / t.settled : null;

  // An agent with no collateral and nothing open is retired, not running. It
  // stays reachable for its record, but it should not sit in the way of the
  // agents actually doing something.
  const all = data?.agents ?? [];
  const active = all.filter((a) => Number(a.balance) > 0 || a.open > 0 || a.awaiting > 0);
  const retired = all.filter((a) => !(Number(a.balance) > 0 || a.open > 0 || a.awaiting > 0));
  const openTrades = (data?.activity ?? []).filter((a) => !a.settled && !a.awaiting);
  const awaiting = (data?.activity ?? []).filter((a) => a.awaiting);

  return (
    <div className="max-w-[1240px] px-8 pb-24 pt-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h-page">Your agents</h1>
          <p className="sub mt-2">
            Each agent trades from its own wallet on Somnia. Only what you fund is at risk.
          </p>
        </div>
        <Link
          href="/deploy"
          className="shrink-0 px-5 py-3 text-[13px] font-semibold transition-opacity hover:opacity-90"
          style={{ background: "var(--ink)", color: "#fff" }}
        >
          Deploy an agent
        </Link>
      </header>

      <div className="rule mt-8 grid border-l sm:grid-cols-2 lg:grid-cols-4" style={{ borderColor: "var(--line-strong)" }}>
        <Stat
          label="In agent wallets"
          value={t ? `$${t.balance.toFixed(2)}` : "—"}
          note="the only funds at risk"
          tone={t && t.balance > 0 ? "up" : undefined}
        />
        <Stat
          label="Agents running"
          value={String(active.length)}
          note={
            t?.awaiting
              ? `${t.open} open · ${t.awaiting} awaiting result`
              : t?.open
                ? `${t.open} open position${t.open === 1 ? "" : "s"}`
                : "no open positions"
          }
          noteTone={t?.open ? "up" : undefined}
        />
        <Stat
          label="Realised P&L"
          value={t ? money(t.pnl) : "—"}
          note="settled rounds only"
          tone={t && t.pnl !== 0 ? (t.pnl > 0 ? "up" : "down") : undefined}
        />
        <Stat
          label="Win rate"
          value={winRate == null ? "—" : pct(winRate, 0)}
          note={t?.settled ? `${t.wins} of ${t.settled} settled` : "nothing settled yet"}
        />
      </div>

      <section className="mt-14">
        <div className="rule flex flex-wrap items-baseline justify-between gap-2 pt-5">
          <h2 className="h-section">Agents</h2>
          {retired.length > 0 && (
            /* A disclosure, not an action — so it reads as text you can click:
               a caret that turns, and ink on hover, rather than a button chrome
               that would compete with "Withdraw all" beside it. */
            <button
              onClick={() => setShowRetired((v) => !v)}
              aria-expanded={showRetired}
              className="group flex cursor-pointer items-center gap-1.5 text-[12px] transition-colors"
              style={{ color: "var(--muted)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
            >
              <svg
                width="9"
                height="9"
                viewBox="0 0 10 10"
                fill="none"
                aria-hidden
                style={{
                  transform: showRetired ? "rotate(90deg)" : "none",
                  transition: "transform .15s ease",
                }}
              >
                <path d="M3 1.5 7 5l-4 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="underline decoration-dotted underline-offset-4">
                {showRetired ? "Hide" : "Show"} closed agents ({retired.length})
              </span>
            </button>
          )}
        </div>
        {active.length ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {(showRetired ? all : active).map((a) => (
              <div
                key={a.address}
                className="card p-4"
                style={Number(a.balance) > 0 || a.open > 0 ? undefined : { opacity: 0.55 }}
              >
                <div className="flex items-start gap-2.5">
                  <span className="mt-1.5 h-2.5 w-2.5 shrink-0" style={{ background: a.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <h3 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
                        {a.name}
                        {a.instance > 0 && (
                          <span className="mono ml-1 text-[11px]" style={{ color: "var(--faint)" }}>
                            #{a.instance + 1}
                          </span>
                        )}
                      </h3>
                      <span className="mono text-[10px] uppercase tracking-[.08em]" style={{ color: "var(--faint)" }}>
                        {a.risk} · {(a.sizePct * 100).toFixed(0)}%/trade
                      </span>
                    </div>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>{a.thesis}</p>
                  </div>
                  <span className="mono shrink-0 text-[15px] font-semibold" style={{ color: pnlColor(a.pnl) }}>
                    {money(a.pnl)}
                  </span>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" style={{ color: "var(--muted)" }}>
                  <span
                    className="mono font-medium"
                    style={{ color: Number(a.balance) > 0 ? HELD : "var(--faint)" }}
                  >
                    {Number(a.balance).toFixed(2)} tUSDC
                  </span>
                  <span>{a.trades} trades · {a.wins}/{a.settled} won</span>
                  {a.open > 0 && (
                    <span className="font-medium" style={{ color: "var(--up)" }}>{a.open} open</span>
                  )}
                  {a.awaiting > 0 && (
                    <span title="The round ended but the venue has not posted a result yet">
                      {a.awaiting} awaiting result
                    </span>
                  )}
                  {Number(a.gas) < 0.02 && <span style={{ color: "var(--muted)" }}>low gas</span>}
                  {Number(a.balance) === 0 && a.open === 0 && (
                    <span style={{ color: "var(--faint)" }}>closed</span>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <a
                    href={`${EXPLORER}/address/${a.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono text-[10.5px] underline underline-offset-2"
                    style={{ color: "var(--muted)" }}
                  >
                    {shortAddr(a.address)}
                  </a>
                  <button
                    onClick={() => void withdraw(a)}
                    disabled={busy !== null || Number(a.balance) <= 0}
                    className="ml-auto rounded-full border px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-40"
                    style={{ borderColor: "var(--line)" }}
                  >
                    {busy === a.address ? "Sign in wallet…" : "Withdraw all"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyBox>
            <p className="text-[13.5px]" style={{ color: "var(--muted)" }}>
              {retired.length ? "No funded agents — all of yours are closed." : "No agents yet."}
            </p>
            <Link href="/deploy" className="mt-3 inline-block rounded-full px-4 py-2.5 text-[13px] font-semibold" style={{ background: "var(--text)", color: "#fff" }}>
              Deploy your first agent
            </Link>
          </EmptyBox>
        )}
      </section>

      <section className="mt-14">
        <div className="rule flex flex-wrap items-center gap-2.5 pt-5">
          <h2 className="h-section">Live activity</h2>
          <span
            className="mono flex items-center gap-1.5 border px-2 py-0.5 text-[10.5px] uppercase tracking-[.08em]"
            style={{
              borderColor: openTrades.length ? "var(--up)" : "var(--line)",
              color: openTrades.length ? "var(--up)" : "var(--muted)",
            }}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span
                className="absolute inline-flex h-full w-full animate-ping opacity-60"
                style={{ background: openTrades.length ? "var(--up)" : "var(--muted)" }}
              />
              <span
                className="relative inline-flex h-1.5 w-1.5"
                style={{ background: openTrades.length ? "var(--up)" : "var(--muted)" }}
              />
            </span>
            {openTrades.length
              ? `${openTrades.length} open`
              : awaiting.length
                ? `${awaiting.length} awaiting`
                : "watching"}
          </span>
        </div>
        <p className="sub mt-3">
          Wins and losses shown alike, each with the reasoning behind it and the transaction that
          carried it out. Refreshes every few seconds.
        </p>

        {data?.activity.length ? (
          <div className="mt-6 flex flex-col gap-2">
            {data.activity.map((a) => (
              <div
                key={a.id}
                className="card p-3"
                style={
                  a.settled
                    ? undefined
                    : { borderLeftColor: a.awaiting ? "var(--line-strong)" : "var(--up)", borderLeftWidth: 3 }
                }
              >
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="text-[12.5px] font-semibold">{a.direction}</span>
                  <span className="text-[12.5px]">
                    {a.asset} <span style={{ color: "var(--faint)" }}>{windowLabel(a.intervalSec)}</span>
                  </span>
                  <span className="mono text-[11.5px]" style={{ color: "var(--muted)" }}>
                    {a.contracts} @ {pct(a.price, 0)}
                  </span>
                  {/*
                    Stake and result are different quantities, and on a LOSS they
                    are the same number — which is what made an unlabelled pair
                    unreadable: the loss row looked like one figure repeated, so
                    the win row's second figure looked like it contradicted the
                    first. Both carry a word now, and the settled row spells out
                    stake -> returned so the P&L is visibly the difference.
                  */}
                  <span className="mono text-[11.5px]" style={{ color: SPENT }}>
                    staked ${a.cost.toFixed(2)}
                  </span>
                  {a.settled ? (
                    <span className="mono text-[11.5px]" style={{ color: "var(--muted)" }}>
                      → back ${(a.cost + (a.pnl ?? 0)).toFixed(2)}
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-2">
                    <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--faint)" }}>
                      <span className="h-1.5 w-1.5 shrink-0" style={{ background: deskColor(a.agentId) }} />
                      {a.agentId}
                    </span>
                    {a.settled ? (
                      <span
                        className="mono text-[12.5px] font-semibold"
                        style={{ color: pnlColor(a.pnl ?? 0) }}
                        title={`Staked $${a.cost.toFixed(2)}, got back $${(a.cost + (a.pnl ?? 0)).toFixed(2)}`}
                      >
                        {money(a.pnl ?? 0)} net
                      </span>
                    ) : a.awaiting ? (
                      <span
                        className="mono text-[11px]"
                        style={{ color: "var(--muted)" }}
                        title="The round ended but the venue has not posted a result yet"
                      >
                        awaiting result
                      </span>
                    ) : (
                      <span className="mono text-[11px] font-semibold" style={{ color: "var(--up)" }}>open</span>
                    )}
                  </span>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{a.reason}</p>
                <div className="mt-1.5 flex flex-wrap gap-3">
                  <TxLink label="trade" hash={a.txHash} />
                  <TxLink label="redeem" hash={a.redeemTx} />
                  <TxLink label="paid home" hash={a.sweepTx} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyBox>
            <p className="text-[13.5px]" style={{ color: "var(--muted)" }}>
              No trades yet. An agent only acts when it sees edge, and stands down on rounds with no
              resting depth.
            </p>
          </EmptyBox>
        )}
      </section>
    </div>
  );
}

function TxLink({ label, hash }: { label: string; hash: string | null }) {
  if (!hash) return null;
  return (
    <a
      href={`${EXPLORER}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="mono text-[10.5px] underline underline-offset-2"
      style={{ color: "var(--muted)" }}
    >
      {label} {hash.slice(0, 10)}…
    </a>
  );
}

/** One cell of the headline strip. Borders are shared, so it reads as a table. */
function Stat({ label, value, note, tone, noteTone }: {
  label: string; value: string; note?: string; tone?: "up" | "down"; noteTone?: "up";
}) {
  return (
    <div
      className="border-b border-r px-5 py-5"
      style={{ borderColor: "var(--line-strong)", background: "var(--surface)" }}
    >
      <p className="label">{label}</p>
      <p
        className="mono mt-3 text-[28px] font-semibold leading-none"
        style={{ color: tone ? (tone === "up" ? "var(--up)" : "var(--down)") : "var(--ink)" }}
      >
        {value}
      </p>
      {note && (
        <p className="mt-2.5 text-[11.5px]" style={{ color: noteTone ? "var(--up)" : "var(--faint)" }}>
          {note}
        </p>
      )}
    </div>
  );
}

function EmptyBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 grid place-items-center rounded-2xl px-6 py-12 text-center" style={{ border: "1px dashed var(--line)" }}>
      <div>{children}</div>
    </div>
  );
}
