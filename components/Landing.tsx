"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SomniaWordmark, DreamdexWordmark } from "@/components/BrandMarks";
import { usd } from "@/lib/fmt";
import HeroArt from "@/components/HeroArt";
import Reveal from "@/components/Reveal";
import Parallax from "@/components/Parallax";
import ScrollWipe from "@/components/ScrollWipe";
import { useWallet } from "@/components/WalletProvider";

type Stats = {
  trades: number;
  settled: number;
  wins: number;
  winRate: number | null;
  pnl: number;
  roi: number | null;
  open: number;
};
type Desk = {
  id: string;
  name: string;
  thesis: string;
  blurb: string;
  color: string;
  stats?: Stats;
};
type Row = {
  owner: string;
  trader: string;
  agents: number;
  trades: number;
  settled: number;
  wins: number;
  pnl: number;
  staked: number;
  roi: number | null;
  lastTradeAt: number;
};

/**
 * The landing page.
 *
 * Centred and airy where the app is dense: this is the one surface whose job is
 * to invite rather than to inform, so it is built on pills and soft ground
 * inside a `.soft` subtree (see globals.css) while the app stays square.
 *
 * Every number on it is read from the live record — the ticker, the stat row,
 * the traders — and every section is hidden rather than faked when that record
 * is empty. The honesty section stays for the same reason: a page that only
 * promised upside would misrepresent a coin-flip instrument.
 */
export default function Landing() {
  const [desks, setDesks] = useState<Desk[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  /**
   * The clock the "how long ago" chips are measured against, sampled once when
   * the standings land. Reading `Date.now()` while rendering a card would be an
   * impure render, and on the server it would be a different instant than the
   * one the client hydrates with.
   */
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setDesks(j.agents ?? []))
      .catch(() => {});
    fetch("/api/leaderboard", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setRows(j.rows ?? []);
        setNow(Date.now());
      })
      .catch(() => {});
  }, []);

  const totals = rows.reduce(
    (a, r) => ({
      agents: a.agents + r.agents,
      trades: a.trades + r.trades,
      settled: a.settled + r.settled,
      wins: a.wins + r.wins,
      staked: a.staked + r.staked,
      pnl: a.pnl + r.pnl,
    }),
    { agents: 0, trades: 0, settled: 0, wins: 0, staked: 0, pnl: 0 },
  );
  const winRate = totals.settled > 0 ? totals.wins / totals.settled : null;
  const traded = rows.filter((r) => r.settled > 0).sort((a, b) => b.pnl - a.pnl);

  return (
    <main className="soft overflow-x-clip">
      {/* ── hero ──────────────────────────────────────────────────────────── */}
      {/* Full-bleed: the art runs to every edge and the copy is centred in what
          is left, so the fold is the whole viewport rather than a band of it.
          `pt` clears the floating nav; the ticker sits directly under it and the
          rest of the block centres in the space that remains. */}
      <section className="hero-wash relative isolate flex min-h-[100svh] flex-col items-center overflow-hidden px-5 pb-14 pt-[86px] sm:pt-[96px]">
        <div className="hero-grid pointer-events-none absolute inset-0 -z-10" aria-hidden />
        {/* Taller than the section it fills: the backdrop drifts down as the
            page scrolls, and the extra height is what keeps its bottom edge
            from riding up into view. */}
        <Parallax speed={0.14} className="pointer-events-none absolute inset-x-0 -top-[6%] -z-10 h-[118%]">
          <HeroArt />
        </Parallax>

        {traded.length > 0 && (
          <div className="rise w-full max-w-[1080px] shrink-0">
            <Ticker rows={traded} />
          </div>
        )}

        <div className="flex w-full max-w-[1080px] flex-1 flex-col items-center justify-center py-10 text-center">
          <h1
            className="rise max-w-[15ch] text-[clamp(42px,6.4vw,86px)] font-semibold leading-[1.0] tracking-[-.038em]"
            style={{ color: "var(--text)" }}
          >
            An agent that trades while you sleep.
          </h1>

          <p
            className="rise mt-7 max-w-[62ch] text-[16.5px] leading-[1.6] sm:text-[18px]"
            style={{ color: "var(--muted)", "--d": "80ms" } as React.CSSProperties}
          >
            Fund an agent. It trades{" "}
            <span className="font-semibold" style={{ color: "var(--brand)" }}>
              BTC and ETH prediction markets
            </span>{" "}
            on DreamDEX Events and shows you every decision — win or lose.
          </p>

          <div
            className="rise mt-9 flex flex-wrap items-center justify-center gap-3"
            style={{ "--d": "160ms" } as React.CSSProperties}
          >
            <DeployCta>Deploy an agent</DeployCta>
            <BoardLink>See the leaderboard</BoardLink>
          </div>

          {totals.trades > 0 && (
            <div
              className="rise mt-14 grid w-full max-w-[700px] grid-cols-1 overflow-hidden rounded-[24px] border sm:grid-cols-3"
              style={{
                background: "color-mix(in srgb, var(--surface) 62%, transparent)",
                borderColor: "color-mix(in srgb, var(--line) 70%, transparent)",
                boxShadow: "var(--shadow-pill)",
                backdropFilter: "blur(10px)",
                "--d": "240ms",
              } as React.CSSProperties}
            >
              <Stat value={String(totals.agents)} label="agents deployed" />
              <Stat value={String(totals.trades)} label="trades on chain" divided />
              <Stat
                value={winRate == null ? "—" : `${(winRate * 100).toFixed(1)}%`}
                label="settled win rate"
                divided
              />
            </div>
          )}
        </div>
      </section>

      {/* ── the record ────────────────────────────────────────────────────── */}
      {/* Four figures the hero deliberately does not carry. Repeating the hero's
          agents / trades / win-rate at twice the size within one scroll would be
          filler; this is the money and the exposure behind those counts. */}
      {totals.trades > 0 && (
        <section className="px-5 pt-4 sm:pt-10">
          {/* The rules between cells are the container's own background showing
              through a 1px grid gap. One row at four columns, two at two, one
              column stacked — and the dividers land correctly at every one of
              them without a single nth-child rule. */}
          <div
            className="mx-auto grid w-full max-w-[1080px] grid-cols-1 gap-px overflow-hidden rounded-[24px] border sm:grid-cols-2 lg:grid-cols-4"
            style={{ background: "var(--line-soft)", borderColor: "var(--line-soft)", boxShadow: "var(--shadow-pill)" }}
          >
            <Figure
              label="Collateral staked"
              value={`$${usd(totals.staked, 0)}`}
              line="put to work by agents"
              note="settled positions · testnet tUSDC"
              delay={0}
            />
            <Figure
              label="Net p&l"
              value={`${totals.pnl >= 0 ? "+" : "−"}$${usd(Math.abs(totals.pnl))}`}
              tone={totals.pnl >= 0 ? "up" : "down"}
              line="across every trader"
              note="wins minus losses, after fees"
              delay={70}
            />
            <Figure
              label="Traders"
              value={String(rows.length)}
              line="running at least one agent"
              note={`${totals.agents} ${totals.agents === 1 ? "agent" : "agents"} between them`}
              delay={140}
            />
            <Figure
              label="Strategies"
              value="4"
              line="one shared pricing model"
              note="Φ(ln(S/K) / σ√τ)"
              delay={210}
            />
          </div>
        </section>
      )}

      {/* ── how it works ──────────────────────────────────────────────────── */}
      <Band id="how" eyebrow="How it works" title="Three steps, then it runs on its own.">
        {/* Columns divided by rules rather than boxed into cards: three steps are
            one argument in sequence, and cards would read as three unrelated
            things. The verticals are the container's background showing through
            a 1px gap, so they run the full height of the tallest column and fall
            back to horizontals when the grid stacks. */}
        <div
          className="mt-14 grid grid-cols-1 gap-px border-y md:grid-cols-3"
          style={{ background: "var(--line)", borderColor: "var(--line)" }}
        >
          {STEPS.map(([n, label, title, body], i) => (
            <div
              key={n}
              className={`py-11 md:pr-9 ${i === 0 ? "" : "md:pl-9"}`}
              style={{ background: "var(--bg)" }}
            >
              {/* The reveal is on the contents, not the cell: the cell paints
                  over the container background that draws the dividing rules,
                  so fading the cell would flash those rules as a solid block. */}
              <Reveal delay={i * 110} y={18}>
                <p className="label">
                  <span style={{ color: "var(--muted)" }}>{n}</span>
                  <span className="px-2" style={{ color: "var(--line-strong)" }}>
                    /
                  </span>
                  {label}
                </p>
                <h3
                  className="mt-7 max-w-[19ch] text-[clamp(21px,2vw,27px)] font-medium leading-[1.2] tracking-[-.022em]"
                  style={{ color: "var(--ink)" }}
                >
                  {title}
                </h3>
                <p className="mt-4 max-w-[42ch] text-[14.5px] leading-[1.65]" style={{ color: "var(--muted)" }}>
                  {body}
                </p>
              </Reveal>
            </div>
          ))}
        </div>
      </Band>

      {/* ── strategies ────────────────────────────────────────────────────── */}
      {/* Split rather than stacked: the argument lives in the left column and
          the four desks answer it as a list on the right. `Band` puts its header
          full width above its children, which is the wrong shape here, so this
          section lays out its own header. */}
      <section id="strategies" className="scroll-mt-24 px-5 py-24 sm:py-28">
        <div className="mx-auto grid w-full max-w-[1080px] gap-14 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)] lg:gap-20">
          <div className="lg:pt-2">
            <Reveal y={14}>
              <p className="label" style={{ color: "var(--brand)" }}>
                Strategies
              </p>
            </Reveal>
            <Reveal delay={80} y={22}>
              <h2
                className="mt-5 text-[clamp(32px,4vw,54px)] font-medium leading-[1.04] tracking-[-.035em]"
                style={{ color: "var(--ink)" }}
              >
                Four theses. One model.
              </h2>
            </Reveal>
            <Reveal delay={160} y={16}>
              <p className="mt-6 max-w-[46ch] text-[15px] leading-[1.7]" style={{ color: "var(--muted)" }}>
                All four price the same way — <span className="mono">P(up) = Φ(ln(S/K) / σ√τ)</span>, with
                volatility read from the oracle. Their disagreements are about inputs, never arithmetic.
              </p>
            </Reveal>
          </div>

          <div>
            {(desks.length ? desks : PLACEHOLDER).map((d, i) => (
              <Reveal key={d.id} delay={i * 90} y={18}>
                <div
                  className="grid gap-x-8 gap-y-2 border-b py-7 sm:grid-cols-[minmax(0,190px)_minmax(0,1fr)]"
                  style={{ borderColor: "var(--line)" }}
                >
                  <div>
                    <h3 className="flex items-center gap-2.5 text-[15.5px] font-semibold" style={{ color: "var(--ink)" }}>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.color }} />
                      {d.name}
                    </h3>
                    <p className="label mt-2 sm:ml-[18px]">{d.thesis}</p>
                  </div>

                  <div>
                    <p className="text-[14.5px] leading-[1.65]" style={{ color: "var(--muted)" }}>
                      {d.blurb}
                    </p>
                    {/* The record, only once there is one — a desk with nothing
                        settled shows no line rather than a row of zeroes. */}
                    {d.stats && d.stats.settled > 0 && (
                      <p className="mono mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]" style={{ color: "var(--faint)" }}>
                        <span>{d.stats.settled} settled</span>
                        <span>
                          {d.stats.winRate == null ? "—" : `${(d.stats.winRate * 100).toFixed(0)}% won`}
                        </span>
                        <span style={{ color: d.stats.pnl >= 0 ? "var(--up)" : "var(--down)" }}>
                          {d.stats.pnl >= 0 ? "+" : "−"}${usd(Math.abs(d.stats.pnl))}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── traders ───────────────────────────────────────────────────────── */}
      {traded.length > 0 && (
        <Band id="traders" eyebrow="The people already in" title="Top traders." lede="How other desks are doing.">
          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {traded.slice(0, 4).map((r, i) => (
              <TraderCard key={r.owner} row={r} now={now} delay={i * 90} />
            ))}
          </div>
          <Reveal delay={200} className="mt-8">
            <BoardLink>See every trader on the leaderboard</BoardLink>
          </Reveal>
        </Band>
      )}

      {/* ── honesty ──────────────────────────────────────────────────────── */}
      {/* The page turns dark exactly where its tone does. This is the section
          that tells you what can go wrong, and a full-bleed panel that wipes in
          over the light page is the interruption that warrants — see
          ScrollWipe.tsx for how the edge tracks the scroll. */}
      <ScrollWipe
        className="relative isolate flex min-h-[100svh] items-center overflow-hidden"
        style={{ background: "var(--night)" }}
      >
        <div className="mx-auto w-full max-w-[1080px] px-5 py-24">
          <Reveal y={14}>
            <p className="label" style={{ color: "#ffffff59" }}>
              Read this before you fund anything
            </p>
          </Reveal>
          <Reveal delay={80} y={24}>
            <h2 className="mt-6 max-w-[16ch] text-[clamp(34px,5vw,66px)] font-bold leading-[1.02] tracking-[-.04em] text-white">
              What is true, and what is not.
            </h2>
          </Reveal>

          {/* Two solid cards, tilted and overlapping — the claims stop being a
              tidy symmetrical list and start being two objects in tension, which
              is the honest shape for a section where one side is the upside and
              the other is the way you lose. The tilt and the overlap are `lg:`
              only: below that they stack square and legible.

              The rotation sits on an inner element because `Reveal` animates
              `transform` on its own node — putting both on one element means the
              reveal's translate wipes out the tilt. */}
          <div className="mt-16 grid gap-8 lg:mt-20 lg:grid-cols-2 lg:gap-0">
            <Reveal delay={140} y={26}>
              <div className="tilt tilt-left">
                <Panel tone="up" label="What is true">
                  <Line tone="up">
                    Only what you fund can be lost. An agent cannot reach the rest of your balance.
                  </Line>
                  <Line tone="up">
                    Your agent&rsquo;s key is derived from your own signature — re-derive it and sweep
                    the wallet without us.
                  </Line>
                  <Line tone="up">
                    Every trade is a real transaction, shown with its reasoning and a link to the
                    explorer.
                  </Line>
                </Panel>
              </div>
            </Reveal>

            <Reveal delay={260} y={26} className="lg:-ml-14 lg:mt-28">
              <div className="tilt tilt-right">
                <Panel tone="down" label="What is not">
                  <Line tone="down">
                    This is not non-custodial. We hold a copy of the key so it can trade while you
                    are away.
                  </Line>
                  <Line tone="down">An agent cannot steal from you, but it can absolutely lose.</Line>
                  <Line tone="down">
                    Short-window binaries are close to a coin flip minus fees. Fund what you can
                    afford to lose.
                  </Line>
                </Panel>
              </div>
            </Reveal>
          </div>
        </div>
      </ScrollWipe>

      {/* ── close ─────────────────────────────────────────────────────────── */}
      <CreedBand />

      {/* Full height, with the copy centred in the space above a footer pinned
          to the bottom. The three small nav pills that used to sit here just
          repeated the navbar; a close should ask for one thing. */}
      <section
        className="flex min-h-[100svh] flex-col px-5 pb-10 pt-24 text-center"
        style={{ background: "linear-gradient(180deg, var(--bg) 0%, var(--bg-deep) 100%)" }}
      >
        <div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col items-center justify-center">
          <Reveal y={14}>
            <p className="label" style={{ color: "var(--brand)" }}>
              Somnia Shannon · testnet
            </p>
          </Reveal>

          <Reveal delay={80} y={26}>
            <h2
              className="mt-7 max-w-[18ch] text-[clamp(38px,5.6vw,74px)] font-bold leading-[1.02] tracking-[-.04em]"
              style={{ color: "var(--ink)" }}
            >
              You can sleep, but your agent won&rsquo;t.
            </h2>
          </Reveal>

          <Reveal delay={160} y={16}>
            <p className="mt-7 max-w-[54ch] text-[16px] leading-[1.65] sm:text-[17px]" style={{ color: "var(--muted)" }}>
              Pick a desk, fund its wallet, and it trades the next round it likes. Sweep the wallet
              back to your own whenever you want.
            </p>
          </Reveal>

          <Reveal delay={240} className="mt-11 flex flex-wrap items-center justify-center gap-3">
            <DeployCta>Pick a desk and deploy</DeployCta>
            <BoardLink>See the live record</BoardLink>
          </Reveal>
        </div>

        <footer
          className="mx-auto mt-16 flex w-full max-w-[1080px] flex-wrap items-center justify-between gap-6 border-t pt-8 text-left"
          style={{ borderColor: "var(--line)" }}
        >
          <span className="label">© 2026 Aioxy · testnet</span>
          <div className="flex items-center gap-8" style={{ color: "var(--faint)" }}>
            <SomniaWordmark className="h-[13px] w-auto" title="Somnia" />
            <DreamdexWordmark className="h-[13px] w-auto" title="DreamDEX" />
          </div>
        </footer>
      </section>
    </main>
  );
}

/* ── pieces ────────────────────────────────────────────────────────────── */

/** One content band. Sections read as separate through space, not boxes. */
function Band({
  id,
  eyebrow,
  title,
  lede,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  lede?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 px-5 py-24 sm:py-28">
      <div className="mx-auto w-full max-w-[1080px]">
        {/* Eyebrow, title and lede rise as three beats rather than one slab —
            the heading is the thing the eye should land on first. */}
        <Reveal y={14}>
          <p className="label" style={{ color: "var(--brand)" }}>
            {eyebrow}
          </p>
        </Reveal>
        <Reveal delay={80} y={22}>
          <h2
            className="mt-5 max-w-[22ch] text-[clamp(30px,4.2vw,52px)] font-bold leading-[1.04] tracking-[-.035em]"
            style={{ color: "var(--ink)" }}
          >
            {title}
          </h2>
        </Reveal>
        {lede && (
          <Reveal delay={160} y={16}>
            <p className="mt-5 max-w-[64ch] text-[15px] leading-[1.65]" style={{ color: "var(--muted)" }}>
              {lede}
            </p>
          </Reveal>
        )}
        {children}
      </div>
    </section>
  );
}

/**
 * The deploy call to action.
 *
 * Deploying needs a signature, so sending a disconnected reader to /deploy only
 * lands them on a wall. Connected, this is a link. Otherwise it asks for the
 * wallet here and carries "/deploy" as the destination, so the reader arrives
 * at the flow they asked for rather than at the dashboard.
 *
 * With more than one wallet installed it opens a picker — EIP-6963 exists so
 * the reader chooses, not so we pick whichever extension loaded first.
 */
function DeployCta({ children }: { children: React.ReactNode }) {
  const { account, wallets, discovered, connect, connecting, error } = useWallet();
  const [pick, setPick] = useState(false);

  if (account) {
    return (
      <Pill href="/deploy" primary>
        {children}
      </Pill>
    );
  }

  // Before discovery finishes there is nothing true to say about what is
  // installed, so the button keeps its normal label and simply cannot be
  // pressed yet — announcing "install a wallet" to someone who has one is worse
  // than a few milliseconds of a disabled button.
  const label = connecting
    ? "Connecting…"
    : discovered && wallets.length === 0
      ? "Install a wallet to deploy"
      : "Connect wallet to deploy";

  return (
    <span className="relative inline-flex flex-col items-center">
      <button
        onClick={() => {
          if (wallets.length === 1) void connect(wallets[0], "/deploy");
          else if (wallets.length > 1) setPick((o) => !o);
        }}
        disabled={connecting || !discovered || wallets.length === 0}
        className="inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-[14.5px] font-semibold transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100"
        style={{ background: "var(--text)", color: "#fff", boxShadow: "var(--shadow-pill)" }}
      >
        {label}
      </button>

      {pick && (
        <div
          className="absolute top-[calc(100%+10px)] z-20 min-w-[220px] rounded-2xl p-1.5"
          style={{ background: "var(--surface)", border: "1px solid var(--line)", boxShadow: "var(--shadow-pill)" }}
        >
          {wallets.map((w) => (
            <button
              key={w.info.rdns}
              onClick={() => {
                void connect(w, "/deploy");
                setPick(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] hover:bg-[var(--surface-2)]"
            >
              {w.info.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={w.info.icon} alt="" className="h-4 w-4 rounded" />
              ) : (
                <span className="h-4 w-4 rounded" style={{ background: "var(--line)" }} />
              )}
              {w.info.name}
            </button>
          ))}
        </div>
      )}

      {error && (
        <span className="mt-2.5 text-[12.5px]" style={{ color: "var(--down)" }}>
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * A link to the leaderboard, shown only to a connected reader.
 *
 * The board is behind a wallet, so offering it to everyone else would send them
 * to a wall — and the connect action they would need is already the primary
 * button beside this one. Rendering nothing keeps the disconnected page down to
 * a single ask.
 */
function BoardLink({ children }: { children: React.ReactNode }) {
  const { account } = useWallet();
  if (!account) return null;
  return <Pill href="/leaderboard">{children}</Pill>;
}

function Pill({
  href,
  children,
  primary,
  small,
}: {
  href: string;
  children: React.ReactNode;
  primary?: boolean;
  small?: boolean;
}) {
  const size = small ? "px-4 py-2 text-[13px]" : "px-6 py-3.5 text-[14.5px]";
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 rounded-full font-semibold transition-transform hover:scale-[1.02] ${size}`}
      style={
        primary
          ? // Navy rather than the near-black `--ink`: on the blue hero ground a
            // black pill reads as a foreign object, and the page's own text
            // colour is already the right deep blue.
            { background: "var(--text)", color: "#fff", boxShadow: "var(--shadow-pill)" }
          : {
              background: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--line)",
              boxShadow: "var(--shadow-pill)",
            }
      }
    >
      {children}
    </Link>
  );
}

/**
 * One cell of the record strip: label, the figure, what it means in words, and
 * a mono footnote pinned to the bottom so the four notes line up whatever the
 * cells above them do.
 */
function Figure({
  label,
  value,
  line,
  note,
  tone,
  delay,
}: {
  label: string;
  value: string;
  line: string;
  note: string;
  tone?: "up" | "down";
  delay?: number;
}) {
  return (
    // Same as the steps: the cell paints the background that hides the grid's
    // divider colour, so only its contents may fade.
    <div className="flex p-8" style={{ background: "var(--surface)" }}>
      <Reveal delay={delay} y={16} className="flex flex-1 flex-col">
        <p className="label">{label}</p>
        <p
          className="mt-5 text-[clamp(32px,3.6vw,50px)] font-bold leading-none tracking-[-.035em]"
          style={{ color: tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : "var(--ink)" }}
        >
          {value}
        </p>
        <p className="mt-4 text-[14px]" style={{ color: "var(--muted)" }}>
          {line}
        </p>
        <p className="mono mt-auto pt-10 text-[11px] leading-relaxed" style={{ color: "var(--faint)" }}>
          {note}
        </p>
      </Reveal>
    </div>
  );
}

/**
 * `divided` draws the rule that separates this cell from the one before it —
 * a top rule when the three stack, a left rule when they sit in a row. Tailwind
 * `divide-*` would need its border colour as a class, and every colour here is
 * a token applied inline.
 */
function Stat({ value, label, divided }: { value: string; label: string; divided?: boolean }) {
  return (
    <div
      className={`px-6 py-7 ${divided ? "border-t sm:border-l sm:border-t-0" : ""}`}
      style={{ borderColor: "var(--line-soft)" }}
    >
      <p className="mono text-[30px] font-semibold leading-none" style={{ color: "var(--ink)" }}>
        {value}
      </p>
      <p className="label mt-2.5">{label}</p>
    </div>
  );
}

/**
 * A trader's card: what they staked, what it became, and on how many settled
 * trades. The bar is `staked → staked + pnl`, so a loss shows as a bar that
 * falls short of the track rather than as a green bar with a minus sign.
 */
function TraderCard({ row, now, delay }: { row: Row; now: number | null; delay?: number }) {
  const up = row.pnl >= 0;
  const end = row.staked + row.pnl;
  const fill = row.staked > 0 ? Math.max(0, Math.min(1, end / Math.max(row.staked, end))) : 0;
  const days =
    now != null && row.lastTradeAt ? Math.floor((now - row.lastTradeAt) / 86_400_000) : null;

  return (
    <Reveal
      delay={delay}
      className="rounded-[22px] border p-6"
      style={{ background: "var(--surface)", borderColor: "var(--line-soft)", boxShadow: "var(--shadow-pill)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="truncate text-[15px] font-semibold" style={{ color: "var(--ink)" }}>
          {row.trader}
        </h3>
        {days != null && (
          <span className="mono shrink-0 text-[11px]" style={{ color: "var(--faint)" }}>
            {days === 0 ? "today" : `${days}d`}
          </span>
        )}
      </div>

      <p className="mono mt-3 flex items-baseline gap-2 text-[26px] font-semibold leading-none">
        <span style={{ color: up ? "var(--up)" : "var(--down)" }}>
          {up ? "+" : "−"}
          {usd(Math.abs(row.pnl))}
        </span>
        {row.roi != null && (
          <span className="text-[12px] font-medium" style={{ color: "var(--faint)" }}>
            {row.roi >= 0 ? "+" : "−"}
            {Math.abs(row.roi * 100).toFixed(0)}%
          </span>
        )}
      </p>

      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-2)" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${fill * 100}%`, background: up ? "var(--up)" : "var(--down)" }}
        />
      </div>

      <p className="mono mt-3 text-[12px]" style={{ color: "var(--muted)" }}>
        ${usd(row.staked)} <span style={{ color: "var(--faint)" }}>→</span> ${usd(end)}
      </p>

      <p className="mt-4 border-t pt-4 text-[12px]" style={{ borderColor: "var(--line-soft)", color: "var(--faint)" }}>
        {row.settled} {row.settled === 1 ? "trade" : "trades"} settled
      </p>
    </Reveal>
  );
}

/**
 * The live band under the nav.
 *
 * The track is rendered twice and animated by exactly -50%, so the loop closes
 * on an identical copy. `aria-hidden` on the duplicate keeps a screen reader
 * from reading the whole standings twice.
 */
function Ticker({ rows }: { rows: Row[] }) {
  const items = rows.slice(0, 12);
  const run = (
    <div className="flex shrink-0 items-center">
      {items.map((r) => (
        <span key={r.owner} className="flex items-center gap-2 whitespace-nowrap px-4 text-[12.5px]">
          <span className="font-semibold" style={{ color: "#fff" }}>
            {r.trader}
          </span>
          <span className="mono" style={{ color: r.pnl >= 0 ? "#4ade80" : "#fb7185" }}>
            {r.pnl >= 0 ? "+" : "−"}${usd(Math.abs(r.pnl))}
          </span>
          <span style={{ color: "#ffffff66" }}>{r.settled} trades</span>
          <span aria-hidden style={{ color: "#ffffff33" }}>
            ·
          </span>
        </span>
      ))}
    </div>
  );

  return (
    <div
      className="marquee flex max-w-full items-center gap-3 overflow-hidden rounded-full py-2.5 pl-5 pr-2"
      style={{ background: "var(--ink)", boxShadow: "var(--shadow-pill)" }}
    >
      <span className="flex shrink-0 items-center gap-2">
        <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: "#4ade80" }} aria-hidden />
        <span className="label" style={{ color: "#ffffff99" }}>
          live
        </span>
      </span>
      <span className="h-3.5 w-px shrink-0" style={{ background: "#ffffff26" }} aria-hidden />
      <div className="fade-x overflow-hidden">
        <div className="marquee-track" style={{ "--speed": `${items.length * 5}s` } as React.CSSProperties}>
          {run}
          <div aria-hidden>{run}</div>
        </div>
      </div>
    </div>
  );
}

/** The tilted band of claims above the closing call. Decoration that says something. */
function CreedBand() {
  const run = (
    <div className="flex shrink-0 items-center">
      {["Testnet", "Every agent on chain", "Every trade public", "Prediction markets"].map((t) => (
        <span key={t} className="label flex items-center whitespace-nowrap px-8 text-[11px]">
          {t}
          <span aria-hidden className="pl-8" style={{ color: "var(--line-strong)" }}>
            +
          </span>
        </span>
      ))}
    </div>
  );

  return (
    <div className="relative py-10" aria-hidden>
      <div
        className="marquee -rotate-[1.6deg] overflow-hidden border-y py-3.5"
        style={{ background: "var(--surface)", borderColor: "var(--line-soft)" }}
      >
        <div className="marquee-track" style={{ "--speed": "34s" } as React.CSSProperties}>
          {run}
          {run}
        </div>
      </div>
    </div>
  );
}

/**
 * One solid card on the dark panel.
 *
 * The fill carries the meaning — green for what holds, red for what does not —
 * so the type inside is plain white. The tilt, the offset shadow and the hover
 * that brings a card to the front all live on `.tilt` in globals.css.
 */
function Panel({
  tone,
  label,
  children,
}: {
  tone: "up" | "down";
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="tilt-card rounded-[3px] p-8 sm:p-10"
      style={{ background: tone === "up" ? "var(--up)" : "var(--down)" }}
    >
      <p className="label" style={{ color: "#ffffffbf" }}>
        {label}
      </p>
      <ul className="mt-7">{children}</ul>
    </div>
  );
}

/** One claim inside a card, ruled off from the one above it. */
function Line({ children, tone }: { children: React.ReactNode; tone: "up" | "down" }) {
  return (
    <li
      className="border-t py-5 text-[14.5px] leading-[1.6] text-white first:border-t-0 first:pt-0 last:pb-0"
      // Lightening the card's own fill rather than a flat white: a white rule
      // on saturated red glows, this one just separates.
      style={{ borderColor: tone === "up" ? "#ffffff2e" : "#ffffff33" }}
    >
      {children}
    </li>
  );
}

const STEPS: [string, string, string, string][] = [
  [
    "01",
    "Pick a desk",
    "Four theses, one pricing model.",
    "They disagree about inputs, never about arithmetic. Pick the desk whose read on the market you share.",
  ],
  [
    "02",
    "Fund its wallet",
    "What you fund is the whole risk.",
    "An agent can never lose more than what is in its wallet, and it can never reach the rest of your balance.",
  ],
  [
    "03",
    "It trades",
    "It picks its own rounds, and its own moments.",
    "Sizes by conviction, stands down when there is no edge, and shows you the reasoning behind every position.",
  ],
];

/** Shown until the live roster loads, so the section never renders empty. */
const PLACEHOLDER: Desk[] = [
  {
    id: "clockwork",
    name: "Clockwork",
    thesis: "Time decay",
    color: "#8b7cf6",
    blurb: "Near expiry an outcome is almost determined, but books are slow to price certainty.",
  },
  {
    id: "driftwood",
    name: "Driftwood",
    thesis: "Momentum",
    color: "#22d3ee",
    blurb: "Short-horizon drift in the oracle tends to persist across one round.",
  },
  {
    id: "undertow",
    name: "Undertow",
    thesis: "Mean reversion",
    color: "#f59e0b",
    blurb: "Fades prices that imply more certainty than realised volatility supports.",
  },
  {
    id: "contrary",
    name: "Contrary",
    thesis: "Book imbalance",
    color: "#f43f5e",
    blurb: "A one-sided book is a crowded side. Takes the thin side when the model allows.",
  },
];
