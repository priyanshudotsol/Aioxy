"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { useWallet } from "./WalletProvider";
import { useToast } from "./Toast";
import { usernameMessage } from "@/lib/agentkey";
import { AioxyMark } from "./BrandMarks";
import { shortAddr } from "@/lib/fmt";

const LINKS = [
  { href: "/fleet", label: "Fleet", icon: GridIcon },
  { href: "/deploy", label: "Deploy", icon: PlusIcon },
  { href: "/leaderboard", label: "Leaderboard", icon: RankIcon },
];

export const SIDEBAR_W = 236;

/** Persistent left rail for a signed-in session. */
export default function Sidebar() {
  const path = usePathname();
  const { account, walletClient, disconnect } = useWallet();
  const toast = useToast();
  const [username, setUsername] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  // A menu that survives a click elsewhere is a menu you have to fight.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!account) { if (alive) setUsername(null); return; }
      const j = await fetch(`/api/profile?owner=${account}`, { cache: "no-store" })
        .then((r) => r.json()).catch(() => null);
      if (alive) setUsername(j?.username ?? null);
    })();
    return () => { alive = false; };
  }, [account]);

  /**
   * The name is claimed with a signature, not just a POST — the leaderboard is
   * public, so without proof of ownership anyone could rename anyone.
   */
  const save = useCallback(async () => {
    const wc = walletClient();
    if (!wc || !account) return;
    setBusy(true);
    setError(null);
    try {
      const nonce = Date.now();
      const name = draft.trim();
      const signature = await wc.signMessage({
        account: account as Address,
        message: usernameMessage(account as Address, name, nonce),
      });
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: account, username: name, signature, nonce }),
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);
      setUsername(res.username);
      setEditing(false);
      toast.ok(`You are now “${res.username}” on the leaderboard.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 80) : "failed";
      // Kept inline as well: this one belongs beside the field it is about.
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }, [account, draft, walletClient, toast]);

  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 hidden flex-col lg:flex"
      style={{
        width: SIDEBAR_W,
        background: "var(--surface)",
        borderRight: "1px solid var(--line)",
      }}
    >
      <Link href="/fleet" className="flex items-center gap-2.5 px-5 py-5">
        <AioxyMark size={26} />
        <span className="text-[15px] font-semibold tracking-[-.015em]">Aioxy</span>
      </Link>

      <nav className="flex flex-col gap-0.5 px-3">
        {LINKS.map((l) => {
          const on = isActive(path, l.href);
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={on ? "page" : undefined}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors"
              style={{
                color: on ? "var(--text)" : "var(--muted)",
                background: on ? "var(--surface-2)" : "transparent",
              }}
            >
              <Icon active={on} />
              {l.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto px-3 pb-4">
        <div className="relative border" style={{ borderColor: "var(--line-strong)", background: "var(--surface-2)" }}>
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="p-3"
            >
              <p className="label mb-2">Display name</p>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
                placeholder={account ? shortAddr(account) : ""}
                maxLength={20}
                className="w-full border px-2.5 py-2 text-[12.5px] outline-none"
                style={{ borderColor: "var(--line-strong)", background: "var(--surface)" }}
              />
              <p className="mt-1.5 text-[10px]" style={{ color: "var(--faint)" }}>
                Shown on the public leaderboard. 2–20 characters.
              </p>
              {error && (
                <p className="mt-1.5 text-[10.5px]" style={{ color: "var(--down)" }}>{error}</p>
              )}
              <div className="mt-2.5 flex gap-2">
                <button
                  type="submit"
                  disabled={busy || draft.trim().length < 2}
                  className="flex-1 px-2.5 py-1.5 text-[11.5px] font-semibold disabled:opacity-40"
                  style={{ background: "var(--ink)", color: "#fff" }}
                >
                  {busy ? "Sign in wallet…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setError(null); }}
                  className="border px-2.5 py-1.5 text-[11.5px]"
                  style={{ borderColor: "var(--line-strong)", color: "var(--muted)" }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex items-start gap-2 p-3">
              <span className="mt-[5px] h-1.5 w-1.5 shrink-0" style={{ background: "var(--up)" }} />
              <div className="min-w-0 flex-1">
                <p className={`truncate text-[13px] font-semibold ${username ? "" : "mono"}`} style={{ color: "var(--ink)" }}>
                  {username ?? (account ? shortAddr(account) : "—")}
                </p>
                <p className="mono mt-0.5 truncate text-[10.5px]" style={{ color: "var(--faint)" }}>
                  {username && account ? shortAddr(account) : "Somnia Shannon"}
                </p>
              </div>

              {/* A menu keeps two competing text links out of the identity row. */}
              <button
                onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }}
                aria-label="Account options"
                aria-expanded={menu}
                className="-mr-1 -mt-1 shrink-0 px-1.5 py-1 transition-colors"
                style={{ color: menu ? "var(--ink)" : "var(--faint)" }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <circle cx="8" cy="3" r="1.4" />
                  <circle cx="8" cy="8" r="1.4" />
                  <circle cx="8" cy="13" r="1.4" />
                </svg>
              </button>

              {menu && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-full left-0 right-0 z-50 mb-1 border"
                  style={{ borderColor: "var(--line-strong)", background: "var(--surface)" }}
                >
                  <MenuItem onClick={() => { setDraft(username ?? ""); setEditing(true); setMenu(false); }}>
                    {username ? "Change display name" : "Set a display name"}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      if (account) void navigator.clipboard?.writeText(account).catch(() => {});
                      setMenu(false);
                    }}
                  >
                    Copy address
                  </MenuItem>
                  <MenuItem danger onClick={() => { setMenu(false); disconnect(); }}>
                    Disconnect
                  </MenuItem>
                </div>
              )}
            </div>
          )}
        </div>
        <p className="mt-3 px-1 text-[10px] leading-relaxed" style={{ color: "var(--faint)" }}>
          Somnia Shannon testnet
        </p>
      </div>
    </aside>
  );
}

/** Compact top bar for narrow screens, where the rail is hidden. */
export function MobileBar() {
  const path = usePathname();
  return (
    <div
      className="sticky top-0 z-40 flex gap-1 overflow-x-auto px-3 py-2 lg:hidden"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--line)" }}
    >
      {LINKS.map((l) => {
        const on = isActive(path, l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium"
            style={{
              color: on ? "var(--text)" : "var(--muted)",
              background: on ? "var(--surface-2)" : "transparent",
            }}
          >
            {l.label}
          </Link>
        );
      })}
    </div>
  );
}

function isActive(path: string, href: string) {
  return path === href;
}

type IconProps = { active?: boolean };
const stroke = (a?: boolean) => (a ? "var(--text)" : "var(--faint)");

function GridIcon({ active }: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      {[
        [2, 2],
        [9, 2],
        [2, 9],
        [9, 9],
      ].map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="5" height="5" rx="1.4" stroke={stroke(active)} strokeWidth="1.4" />
      ))}
    </svg>
  );
}

function PlusIcon({ active }: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3.5v9M3.5 8h9"
        stroke={stroke(active)}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Three bars of differing height — a standings chart, not a trophy. */
function RankIcon({ active }: IconProps) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 13V9.5M8 13V4M13 13v-6"
        stroke={stroke(active)}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MenuItem({ children, onClick, danger }: {
  children: React.ReactNode; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="block w-full px-3 py-2.5 text-left text-[12px] transition-colors hover:bg-[var(--surface-2)]"
      style={{ color: danger ? "var(--down)" : "var(--text)" }}
    >
      {children}
    </button>
  );
}
