"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SomniaWordmark, DreamdexWordmark } from "@/components/BrandMarks";

type Desk = { id: string; name: string; thesis: string; blurb: string; color: string };
type Live = { traders: number; agents: number; trades: number; pnl: number };

/**
 * The landing page.
 *
 * Editorial rather than decorative: full-height sections, one idea each, thin
 * rules instead of boxes, and numbers set in mono so they read as data. Every
 * claim here is one the product can keep — the honesty section exists because a
 * page that only promised upside would misrepresent a coin-flip instrument.
 */
export default function Landing() {
  const [desks, setDesks] = useState<Desk[]>([]);
  const [live, setLive] = useState<Live | null>(null);

  useEffect(() => {
    fetch("/api/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setDesks(j.agents ?? []))
      .catch(() => {});
    fetch("/api/leaderboard", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setLive(j.totals ?? null))
      .catch(() => {});
  }, []);

  return (
    <main>
      {/* ── hero ─────────────────────────────────────────────── 100vh ── */}
      <Section className="min-h-[100svh] place-content-center">
        <p className="label">Somnia Shannon · DreamDEX Event Contracts</p>

        <h1 className="mt-8 max-w-[16ch] text-[clamp(44px,7.5vw,104px)] font-bold leading-[0.95] tracking-[-.045em]" style={{ color: "var(--ink)" }}>
          A desk that trades while you sleep.
        </h1>

        <p className="sub mt-8 text-[16px]">
          Fund an agent. It trades BTC and ETH prediction markets on chain and shows you every
          decision it makes — win or lose.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Link
            href="/deploy"
            className="px-6 py-3.5 text-[14px] font-semibold transition-opacity hover:opacity-90"
            style={{ background: "var(--ink)", color: "#fff" }}
          >
            Deploy an agent
          </Link>
          <Link
            href="/leaderboard"
            className="border px-6 py-3.5 text-[14px] font-medium transition-colors hover:bg-[var(--surface)]"
            style={{ borderColor: "var(--line-strong)" }}
          >
            See the leaderboard
          </Link>
        </div>

        {live && live.trades > 0 && (
          <div className="mt-16 flex flex-wrap gap-x-14 gap-y-6">
            <Metric value={String(live.agents)} label="agents deployed" />
            <Metric value={String(live.trades)} label="trades on chain" />
            <Metric value={String(live.traders)} label="traders" />
          </div>
        )}
      </Section>

      {/* ── how ───────────────────────────────────────────────── 90vh ── */}
      <Section className="min-h-[90svh] place-content-center" ruled>
        <p className="label">How it works</p>
        <h2 className="mt-6 max-w-[20ch] text-[clamp(32px,4.5vw,56px)] font-bold leading-[1.02] tracking-[-.035em]" style={{ color: "var(--ink)" }}>
          Three steps, then it runs on its own.
        </h2>

        <ol className="mt-16 grid gap-px" style={{ background: "var(--line-strong)" }}>
          {[
            ["Pick a desk", "Four strategies, one pricing model. They differ on when to act, not on arithmetic."],
            ["Fund its wallet", "That amount is the risk. An agent can never lose more than what is in its wallet."],
            ["It trades", "It picks its own rounds, sizes by conviction, and stands down when there is no edge."],
          ].map(([title, body], i) => (
            <li key={title} className="grid gap-6 p-8 sm:grid-cols-[80px_minmax(0,1fr)]" style={{ background: "var(--bg)" }}>
              <span className="mono text-[28px] font-semibold leading-none" style={{ color: "var(--line-strong)" }}>
                0{i + 1}
              </span>
              <div>
                <h3 className="text-[19px] font-semibold" style={{ color: "var(--ink)" }}>{title}</h3>
                <p className="sub mt-2">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* ── desks ─────────────────────────────────────────────── 90vh ── */}
      <Section className="min-h-[90svh] place-content-center" ruled>
        <p className="label">The desks</p>
        <h2 className="mt-6 max-w-[22ch] text-[clamp(32px,4.5vw,56px)] font-bold leading-[1.02] tracking-[-.035em]" style={{ color: "var(--ink)" }}>
          Four theses. One model.
        </h2>
        <p className="sub mt-6">
          All four price the same way — <span className="mono">P(up) = Φ(ln(S/K) / σ√τ)</span>, with
          volatility read from the oracle. Their disagreements are about inputs, never arithmetic.
        </p>

        <div className="mt-14 grid gap-px sm:grid-cols-2" style={{ background: "var(--line-strong)" }}>
          {(desks.length ? desks : PLACEHOLDER).map((d) => (
            <article key={d.id} className="p-8" style={{ background: "var(--bg)" }}>
              <div className="flex items-center gap-2.5">
                <span className="h-2.5 w-2.5 shrink-0" style={{ background: d.color }} />
                <h3 className="text-[18px] font-semibold" style={{ color: "var(--ink)" }}>{d.name}</h3>
                <span className="label">{d.thesis}</span>
              </div>
              <p className="sub mt-3 text-[13px]">{d.blurb}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* ── honesty ───────────────────────────────────────────── 60vh ── */}
      <Section className="min-h-[60svh] place-content-center" ruled>
        <p className="label">Read this before you fund anything</p>
        <div className="mt-10 grid gap-12 lg:grid-cols-2">
          <div>
            <h3 className="text-[22px] font-semibold" style={{ color: "var(--ink)" }}>What is true</h3>
            <ul className="mt-5 flex flex-col gap-3">
              <Claim>Only what you fund can be lost. An agent cannot reach the rest of your balance.</Claim>
              <Claim>Your agent&rsquo;s key is derived from your own signature — re-derive it and sweep the wallet without us.</Claim>
              <Claim>Every trade is a real transaction, shown with its reasoning and a link to the explorer.</Claim>
            </ul>
          </div>
          <div>
            <h3 className="text-[22px] font-semibold" style={{ color: "var(--ink)" }}>What is not</h3>
            <ul className="mt-5 flex flex-col gap-3">
              <Claim off>This is not non-custodial. We hold a copy of the key so it can trade while you are away.</Claim>
              <Claim off>An agent cannot steal from you, but it can absolutely lose.</Claim>
              <Claim off>Short-window binaries are close to a coin flip minus fees. Fund what you can afford to lose.</Claim>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── close ─────────────────────────────────────────────── 60vh ── */}
      <Section className="min-h-[60svh] place-content-center" ruled>
        <h2 className="max-w-[18ch] text-[clamp(32px,5vw,64px)] font-bold leading-[1.0] tracking-[-.04em]" style={{ color: "var(--ink)" }}>
          Put one to work.
        </h2>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Link
            href="/deploy"
            className="px-6 py-3.5 text-[14px] font-semibold transition-opacity hover:opacity-90"
            style={{ background: "var(--ink)", color: "#fff" }}
          >
            Deploy an agent
          </Link>
        </div>

        <footer className="mt-24 flex flex-wrap items-center justify-between gap-6 border-t pt-8" style={{ borderColor: "var(--line-strong)" }}>
          <span className="label">© 2026 Aioxy · testnet</span>
          <div className="flex items-center gap-8" style={{ color: "var(--faint)" }}>
            <SomniaWordmark className="h-[13px] w-auto" title="Somnia" />
            <DreamdexWordmark className="h-[13px] w-auto" title="DreamDEX" />
          </div>
        </footer>
      </Section>
    </main>
  );
}

/* ── pieces ────────────────────────────────────────────────────────────── */

/** One full-height band. `ruled` draws the hairline that separates sections. */
function Section({ children, className = "", ruled }: {
  children: React.ReactNode; className?: string; ruled?: boolean;
}) {
  return (
    <section
      className={`grid px-6 py-24 sm:px-10 ${className}`}
      style={ruled ? { borderTop: "1px solid var(--line-strong)" } : undefined}
    >
      <div className="mx-auto w-full max-w-[1080px]">{children}</div>
    </section>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="mono text-[34px] font-semibold leading-none" style={{ color: "var(--ink)" }}>{value}</p>
      <p className="label mt-2">{label}</p>
    </div>
  );
}

function Claim({ children, off }: { children: React.ReactNode; off?: boolean }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-[7px] h-1.5 w-1.5 shrink-0" style={{ background: off ? "var(--down)" : "var(--up)" }} />
      <span className="text-[14px] leading-relaxed" style={{ color: "var(--muted)" }}>{children}</span>
    </li>
  );
}

/** Shown until the live roster loads, so the section never renders empty. */
const PLACEHOLDER: Desk[] = [
  { id: "clockwork", name: "Clockwork", thesis: "Time decay", color: "#8b7cf6", blurb: "Near expiry an outcome is almost determined, but books are slow to price certainty." },
  { id: "driftwood", name: "Driftwood", thesis: "Momentum", color: "#22d3ee", blurb: "Short-horizon drift in the oracle tends to persist across one round." },
  { id: "undertow", name: "Undertow", thesis: "Mean reversion", color: "#f59e0b", blurb: "Fades prices that imply more certainty than realised volatility supports." },
  { id: "contrary", name: "Contrary", thesis: "Book imbalance", color: "#f43f5e", blurb: "A one-sided book is a crowded side. Takes the thin side when the model allows." },
];
