"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "./WalletProvider";
import { EXPLORER } from "@/lib/config";
import { pct, shortAddr } from "@/lib/fmt";

type DeskChip = { id: string; name: string; color: string };
type Row = {
  owner: string; username: string | null; trader: string;
  desks: string[]; deskChips: DeskChip[];
  agents: number; live: number;
  trades: number; settled: number; wins: number; open: number;
  pnl: number; staked: number; roi: number | null; lastTradeAt: number;
};
type Data = {
  rows: Row[];
  totals: { traders: number; agents: number; trades: number; pnl: number; staked: number };
};

type Sort = "pnl" | "return" | "trades";

const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
const pnlColor = (n: number) => (n === 0 ? "var(--text)" : n > 0 ? "var(--up)" : "var(--down)");

/**
 * Public standings, one row per deployed agent.
 *
 * Ranked by agent rather than by owner: each agent has its own wallet, its own
 * strategy and its own record, so "who is performing" is a question about
 * agents. The owner is shown underneath so a person can still be followed.
 */
export default function Leaderboard() {
  const { account } = useWallet();
  const [data, setData] = useState<Data | null>(null);
  const [sort, setSort] = useState<Sort>("pnl");
  const [activeOnly, setActiveOnly] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/leaderboard", { cache: "no-store" });
      setData(await r.json());
    } catch {
      /* keep the last good view */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) void load(); };
    run();
    const t = setInterval(run, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [load]);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    // "Active" means the trader still has at least one agent running.
    const kept = activeOnly ? all.filter((r) => r.live > 0) : all;
    const by: Record<Sort, (a: Row, b: Row) => number> = {
      pnl: (a, b) => b.pnl - a.pnl,
      // An agent with nothing staked has no return to rank, so it sorts last.
      return: (a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity),
      trades: (a, b) => b.trades - a.trades,
    };
    return [...kept].sort(by[sort]);
  }, [data, sort, activeOnly]);

  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);
  const mine = account?.toLowerCase();
  const t = data?.totals;

  return (
    <div className="max-w-[1240px] px-8 pb-24 pt-8">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-8">
        <div>
          <p className="label">Public leaderboard</p>
          <h1 className="h-page mt-2">Top-performing traders</h1>
        </div>
        {t && (
          <div className="flex gap-8">
            <Figure label="Traders" value={String(t.traders)} />
            <Figure label="Agents" value={String(t.agents)} />
            <Figure label="Combined P&L" value={money(t.pnl)} tone={t.pnl} />
          </div>
        )}
      </header>

      {/* ── controls ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          options={[["pnl", "P&L"], ["return", "Return"], ["trades", "Trades"]]}
          value={sort}
          onChange={(v) => setSort(v as Sort)}
        />
        <Segmented
          options={[["active", "Active only"], ["all", "Include closed"]]}
          value={activeOnly ? "active" : "all"}
          onChange={(v) => setActiveOnly(v === "active")}
        />
      </div>

      {/* ── podium ───────────────────────────────────────────────────────── */}
      {podium.length > 0 && (
        <div className="mt-8 grid items-end gap-4 sm:grid-cols-3">
          {[podium[1], podium[0], podium[2]].map((r, i) =>
            r ? (
              <PodiumCard
                key={r.owner}
                row={r}
                place={i === 1 ? 1 : i === 0 ? 2 : 3}
                mine={mine === r.owner.toLowerCase()}
              />
            ) : (
              <div key={`empty-${i}`} />
            ),
          )}
        </div>
      )}

      {/* ── the rest ─────────────────────────────────────────────────────── */}
      <section className="mt-14">
        <div className="rule flex flex-wrap items-baseline justify-between gap-2 pt-5">
          <h2 className="h-section">Standings</h2>
          <span className="text-[12px]" style={{ color: "var(--faint)" }}>updates every 10s</span>
        </div>

        {rest.length ? (
          <div className="mt-6 border" style={{ borderColor: "var(--line-strong)", background: "var(--surface)" }}>
            <Header />
            {rest.map((r, i) => (
              <TableRow key={r.owner} row={r} rank={i + 4} mine={mine === r.owner.toLowerCase()} />
            ))}
          </div>
        ) : (
          <div className="mt-6 grid place-items-center px-6 py-14 text-center" style={{ border: "1px dashed var(--line-strong)" }}>
            <p className="text-[13.5px]" style={{ color: "var(--muted)" }}>
              {podium.length ? "That is everyone so far." : "No traders yet. Deploy an agent to appear here."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────────── */

const COLS = "56px minmax(0,1fr) 90px 110px 110px 100px 100px";

function Header() {
  return (
    <div
      className="label grid items-center gap-3 border-b px-4 py-3"
      style={{ borderColor: "var(--line-strong)", gridTemplateColumns: COLS }}
    >
      <span>Rank</span>
      <span>Agent</span>
      <span>Agents</span>
      <span className="text-right">P&amp;L</span>
      <span className="text-right">Put in</span>
      <span className="text-right">Return</span>
      <span className="text-right">Trades</span>
    </div>
  );
}

function TableRow({ row: r, rank, mine }: { row: Row; rank: number; mine: boolean }) {
  return (
    <div
      className="grid items-center gap-3 border-b px-4 py-3.5 text-[12.5px] last:border-b-0"
      style={{
        borderColor: "var(--line-soft)",
        gridTemplateColumns: COLS,
        background: mine ? "var(--surface-2)" : undefined,
        borderLeft: mine ? "3px solid var(--ink)" : "3px solid transparent",
      }}
    >
      <span
        className="mono grid h-7 w-7 place-items-center border text-[11px]"
        style={{ borderColor: "var(--line-strong)", color: "var(--muted)" }}
      >
        {rank}
      </span>

      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <a
            href={`${EXPLORER}/address/${r.owner}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`truncate font-semibold ${r.username ? "" : "mono"}`}
            style={{ color: "var(--ink)" }}
          >
            {r.trader}
          </a>
          <StatusTag live={r.live} open={r.open} />
          {mine && (
            <span className="label border px-1.5 py-0.5" style={{ borderColor: "var(--line-strong)", color: "var(--muted)" }}>
              you
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px]" style={{ color: "var(--faint)" }}>
          <Desks chips={r.deskChips} />
          <span className="mono">{shortAddr(r.owner)}</span>
        </span>
      </span>

      <span className="mono text-[11.5px]" style={{ color: "var(--muted)" }}>
        {r.agents}
        {r.live < r.agents && <span style={{ color: "var(--faint)" }}> · {r.live} live</span>}
      </span>
      <span className="mono text-right font-semibold" style={{ color: pnlColor(r.pnl) }}>{money(r.pnl)}</span>
      <span className="mono text-right" style={{ color: r.staked > 0 ? "var(--down)" : "var(--faint)" }}>
        ${r.staked.toFixed(2)}
      </span>
      <span className="mono text-right" style={{ color: r.roi == null ? "var(--faint)" : pnlColor(r.roi) }}>
        {r.roi == null ? "—" : `${r.roi > 0 ? "+" : ""}${(r.roi * 100).toFixed(1)}%`}
      </span>
      <span className="mono text-right" style={{ color: "var(--muted)" }}>
        {r.trades}
        {r.settled > 0 && <span style={{ color: "var(--faint)" }}> · {pct(r.wins / r.settled, 0)}</span>}
      </span>
    </div>
  );
}

/** 1st is taller and darker; 2nd and 3rd flank it. */
function PodiumCard({ row: r, place, mine }: { row: Row; place: 1 | 2 | 3; mine: boolean }) {
  const first = place === 1;
  return (
    <div
      className="border px-5"
      style={{
        borderColor: first ? "var(--ink)" : "var(--line-strong)",
        borderWidth: first ? 2 : 1,
        background: "var(--surface)",
        paddingTop: first ? 28 : 20,
        paddingBottom: first ? 28 : 20,
      }}
    >
      <div className="flex items-center justify-between">
        <span className="label" style={{ color: first ? "var(--ink)" : "var(--faint)" }}>
          {place === 1 ? "1st" : place === 2 ? "2nd" : "3rd"}
        </span>
        <StatusTag live={r.live} open={r.open} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span
          className={`truncate ${r.username ? "" : "mono"} ${first ? "text-[19px] font-bold" : "text-[15px] font-semibold"}`}
          style={{ color: "var(--ink)" }}
        >
          {r.trader}
        </span>
        {mine && (
          <span className="label border px-1.5 py-0.5" style={{ borderColor: "var(--line-strong)", color: "var(--muted)" }}>
            you
          </span>
        )}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
        <Desks chips={r.deskChips} />
        <span style={{ color: "var(--faint)" }}>
          {r.agents} agent{r.agents === 1 ? "" : "s"}
        </span>
      </p>

      <p
        className="mono mt-4 font-semibold leading-none"
        style={{ color: pnlColor(r.pnl), fontSize: first ? 34 : 26 }}
      >
        {money(r.pnl)}
      </p>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11.5px]">
        <span className="mono" style={{ color: r.roi == null ? "var(--faint)" : pnlColor(r.roi) }}>
          {r.roi == null ? "no return yet" : `${r.roi > 0 ? "+" : ""}${(r.roi * 100).toFixed(1)}% return`}
        </span>
        <span className="mono" style={{ color: "var(--faint)" }}>${r.staked.toFixed(2)} in</span>
        <span className="mono" style={{ color: "var(--faint)" }}>{r.trades} trades</span>
      </div>

      <a
        href={`${EXPLORER}/address/${r.owner}`}
        target="_blank"
        rel="noopener noreferrer"
        className="mono mt-3 block text-[10.5px] underline underline-offset-2"
        style={{ color: "var(--faint)" }}
      >
        {shortAddr(r.owner)}
      </a>
    </div>
  );
}

function StatusTag({ live, open }: { live: number; open: number }) {
  if (open > 0) {
    return (
      <span className="mono text-[10px] font-semibold uppercase tracking-[.08em]" style={{ color: "var(--up)" }}>
        {open} open
      </span>
    );
  }
  return (
    <span className="label border px-1.5 py-0.5" style={{ borderColor: "var(--line-strong)", color: "var(--faint)" }}>
      {live > 0 ? "live" : "closed"}
    </span>
  );
}

/** The desks a trader runs, as colour chips — identity, not decoration. */
function Desks({ chips }: { chips: DeskChip[] }) {
  if (chips.length === 0) return null;
  return (
    <span className="flex items-center gap-1" title={chips.map((c) => c.name).join(", ")}>
      {chips.map((c) => (
        <span key={c.id} className="h-1.5 w-1.5 shrink-0" style={{ background: c.color }} />
      ))}
    </span>
  );
}

function Segmented({ options, value, onChange }: {
  options: [string, string][]; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex border" style={{ borderColor: "var(--line-strong)" }}>
      {options.map(([id, label]) => {
        const on = id === value;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className="label px-3 py-2 transition-colors"
            style={{
              background: on ? "var(--ink)" : "var(--surface)",
              color: on ? "#fff" : "var(--muted)",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p
        className="mono mt-1.5 text-[20px] font-semibold leading-none"
        style={{ color: tone === undefined ? "var(--ink)" : pnlColor(tone) }}
      >
        {value}
      </p>
    </div>
  );
}
