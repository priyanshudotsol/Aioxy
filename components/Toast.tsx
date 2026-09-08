"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EXPLORER } from "@/lib/config";

type Kind = "ok" | "error";
type Toast = { id: number; kind: Kind; message: string; tx?: string };

type Api = {
  ok: (message: string, tx?: string) => void;
  error: (message: string) => void;
};

const Ctx = createContext<Api | null>(null);

/** Errors that are the user changing their mind, not something going wrong. */
const BENIGN = /user rejected|user denied|rejected in the wallet/i;

/**
 * Transient notices, rendered above everything.
 *
 * Feedback used to live inside whichever panel triggered it, which put a failed
 * signature in a different place from a failed withdrawal and let both scroll
 * out of view. A toast puts every outcome in one predictable place.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: Kind, message: string, tx?: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, message, tx }]);
  }, []);

  // `push` is stable, so this memo is too — consumers can depend on it safely.
  const api = useMemo<Api>(
    () => ({ ok: (m, tx) => push("ok", m, tx), error: (m) => push("error", m) }),
    [push],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[min(380px,calc(100vw-40px))] flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // A rejected signature needs a shorter life than a real failure: the user
  // already knows what happened, they did it.
  const life = toast.kind === "ok" ? 6000 : BENIGN.test(toast.message) ? 4000 : 9000;

  useEffect(() => {
    const t = setTimeout(onDismiss, life);
    return () => clearTimeout(t);
  }, [life, onDismiss]);

  return (
    <div
      role="status"
      className="pointer-events-auto flex items-start gap-3 border px-4 py-3"
      style={{
        borderColor: "var(--line-strong)",
        borderLeftColor: toast.kind === "ok" ? "var(--up)" : "var(--down)",
        borderLeftWidth: 3,
        background: "var(--surface)",
        boxShadow: "0 12px 32px -12px rgba(7,13,30,.28)",
        animation: "toast-in .16s ease-out",
      }}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--ink)" }}>
          {toast.message}
        </p>
        {toast.tx && (
          <a
            href={`${EXPLORER}/tx/${toast.tx}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono mt-1.5 inline-block text-[10.5px] underline underline-offset-2"
            style={{ color: "var(--muted)" }}
          >
            {toast.tx.slice(0, 18)}…
          </a>
        )}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 -mt-0.5 shrink-0 px-1 text-[15px] leading-none transition-colors"
        style={{ color: "var(--faint)" }}
      >
        ×
      </button>
    </div>
  );
}

export function useToast(): Api {
  const v = useContext(Ctx);
  // A no-op fallback keeps a component usable outside the provider (tests,
  // storybook) rather than throwing on a purely cosmetic dependency.
  return v ?? { ok: () => {}, error: () => {} };
}
