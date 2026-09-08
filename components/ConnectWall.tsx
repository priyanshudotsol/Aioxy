"use client";

import Link from "next/link";
import { useWallet } from "./WalletProvider";

/**
 * The wall in front of every page that needs a wallet.
 *
 * Both `/fleet` and `/deploy` act on an owner's own agents, so neither has
 * anything to show a visitor who has not connected. This is NOT the landing
 * page — that lives at "/" and does the explaining. This offers the one action
 * available here, and the three claims that make it safe to take.
 *
 * `next` is where to land once connected, so a reader who pressed "deploy"
 * arrives at the deploy flow rather than at the dashboard.
 */
export default function ConnectWall({
  eyebrow,
  title,
  sub,
  next,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  next?: string;
}) {
  const { wallets, discovered, connect, connecting, error } = useWallet();

  return (
    <main className="grid min-h-[calc(100svh-72px)] place-content-center px-6 sm:px-10">
      <div className="mx-auto w-full max-w-[720px]">
        <p className="label">{eyebrow}</p>

        <h1
          className="mt-6 max-w-[15ch] text-[clamp(36px,5.5vw,64px)] font-bold leading-[1.0] tracking-[-.04em]"
          style={{ color: "var(--ink)" }}
        >
          {title}
        </h1>

        <p className="sub mt-6">{sub}</p>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <button
            onClick={() => wallets[0] && void connect(wallets[0], next)}
            disabled={connecting || !discovered || wallets.length === 0}
            className="px-6 py-3.5 text-[14px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--ink)", color: "#fff" }}
          >
            {/* Same reasoning as the landing CTA: say nothing about what is
                installed until discovery has actually run. */}
            {connecting
              ? "Connecting…"
              : discovered && wallets.length === 0
                ? "No wallet detected"
                : "Connect wallet"}
          </button>
          <Link
            href="/"
            className="border px-6 py-3.5 text-[14px] font-medium transition-colors hover:bg-[var(--surface)]"
            style={{ borderColor: "var(--line-strong)" }}
          >
            What is Aioxy?
          </Link>
        </div>

        {discovered && wallets.length === 0 && (
          <p className="mt-4 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Install MetaMask or Rabby and reload. Aioxy runs on Somnia Shannon testnet — it will
            offer to add the network for you.
          </p>
        )}
        {error && (
          <p className="mt-4 text-[12.5px]" style={{ color: "var(--down)" }}>
            {error}
          </p>
        )}

        <div
          className="mt-16 grid gap-px border-t pt-px sm:grid-cols-3"
          style={{ background: "var(--line-strong)", borderColor: "var(--line-strong)" }}
        >
          {[
            ["Only what you fund", "An agent cannot reach the rest of your balance"],
            ["A key you can recover", "Derived from your signature, never ours alone"],
            ["Every trade on chain", "Wins and losses, each with its reasoning"],
          ].map(([h, s]) => (
            <div key={h} className="py-6 pr-6" style={{ background: "var(--bg)" }}>
              <p className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
                {h}
              </p>
              <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
                {s}
              </p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
