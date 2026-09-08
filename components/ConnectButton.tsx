"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "./WalletProvider";
import { shortAddr } from "@/lib/fmt";

/**
 * The single header action. Shows a wallet picker when more than one extension
 * is present, because EIP-6963 exists precisely so the user chooses rather than
 * whichever extension won the race for window.ethereum.
 */
export default function ConnectButton() {
  const { wallets, account, connecting, error, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pill =
    "shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-semibold transition-transform hover:scale-[1.02] sm:px-4 sm:py-2 sm:text-[13px]";

  if (account) {
    return (
      <div className="relative" ref={box}>
        <button
          onClick={() => setOpen((o) => !o)}
          className={`${pill} mono flex items-center gap-2`}
          style={{ background: "var(--surface-2)", color: "var(--text)" }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--up, #10b981)" }}
            aria-hidden
          />
          {shortAddr(account)}
        </button>
        {open && (
          <Menu>
            <button
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
              className="w-full rounded-lg px-3 py-2 text-left text-[12.5px] hover:bg-[var(--surface-2)]"
            >
              Disconnect
            </button>
          </Menu>
        )}
      </div>
    );
  }

  const onClick = () => {
    if (wallets.length === 1) void connect(wallets[0]);
    else setOpen((o) => !o);
  };

  return (
    <div className="relative" ref={box}>
      <button
        onClick={onClick}
        disabled={connecting}
        className={`${pill} disabled:opacity-60`}
        style={{ background: "var(--text)", color: "#fff" }}
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>

      {open && (
        <Menu>
          {wallets.length === 0 ? (
            <p className="px-3 py-2 text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
              No browser wallet found.
              <br />
              Install MetaMask or Rabby, then reload.
            </p>
          ) : (
            wallets.map((w) => (
              <button
                key={w.info.rdns}
                onClick={() => {
                  void connect(w);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[12.5px] hover:bg-[var(--surface-2)]"
              >
                {w.info.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={w.info.icon} alt="" className="h-4 w-4 rounded" />
                ) : (
                  <span className="h-4 w-4 rounded" style={{ background: "var(--line)" }} />
                )}
                {w.info.name}
              </button>
            ))
          )}
          {error && (
            <p className="px-3 pb-2 pt-1 text-[11.5px]" style={{ color: "var(--down, #f43f5e)" }}>
              {error}
            </p>
          )}
        </Menu>
      )}
    </div>
  );
}

function Menu({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="absolute right-0 top-[calc(100%+8px)] z-50 min-w-[196px] rounded-xl p-1"
      style={{
        background: "var(--surface, #fff)",
        border: "1px solid var(--line)",
        boxShadow: "var(--shadow-pill, 0 8px 30px rgba(0,0,0,.12))",
      }}
    >
      {children}
    </div>
  );
}
