"use client";

import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { somniaTestnet } from "viem/chains";
import { useWallet } from "./WalletProvider";
import { useToast } from "./Toast";
import { EXPLORER } from "@/lib/config";
import { shortAddr } from "@/lib/fmt";
import { agentKeyMessage, agentKeyFromSignature, agentAddressFromKey } from "@/lib/agentkey";
import { ensureChain } from "@/lib/wallet";

type Desk = { id: string; name: string; thesis: string; color: string };
type RiskRow = { id: string; minEdge: number; sizeFraction: number; maxConcurrent: number };
type Deployed = { address: Address; balance: { usdc: string; stt: string; funded: boolean } };

const USDC_ABI = parseAbi(["function transfer(address,uint256) returns (bool)"]);

/**
 * Deploy an agent: pick a desk and a risk profile, derive its wallet from a
 * signature, fund it, and it runs.
 *
 * The signature step is the one worth reading. The key is `keccak256` of a
 * signature only this wallet can produce, so the owner can re-derive it later
 * and sweep the agent without us. The server is sent the SIGNATURE, never the
 * key, and verifies it against the claimed address.
 */
export default function Deploy() {
  const { account, provider, walletClient } = useWallet();
  const toast = useToast();
  const [desks, setDesks] = useState<Desk[]>([]);
  const [risks, setRisks] = useState<RiskRow[]>([]);
  const [desk, setDesk] = useState("clockwork");
  const [risk, setRisk] = useState("medium");
  const [busy, setBusy] = useState<string | null>(null);

  const [deployed, setDeployed] = useState<Deployed | null>(null);
  const [amount, setAmount] = useState("25");
  const [usdcAddress, setUsdcAddress] = useState<Address | null>(null);
  const [ownerBalance, setOwnerBalance] = useState<string | null>(null);
  // How many agents of this desk the owner already runs — the next one gets
  // its own wallet rather than colliding with the first.
  const [existing, setExisting] = useState(0);

  useEffect(() => {
    fetch("/api/desks", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setDesks(j.desks ?? []);
        setRisks(j.risk ?? []);
      })
      .catch(() => {});
    fetch("/api/config", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setUsdcAddress(j.collateral ?? null))
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    if (!account) return;
    const j = await fetch(`/api/agent?owner=${account}`, { cache: "no-store" }).then((r) => r.json());
    const mine = j.agents?.find((a: { deskId: string }) => a.deskId === desk);
    setDeployed(mine ? { address: mine.address, balance: mine.balance } : null);
  }, [account, desk]);

  // Guarded so a stale response for a previously selected desk cannot land
  // after the reader has moved on.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!account) {
        if (alive) setDeployed(null);
        return;
      }
      const j = await fetch(`/api/agent?owner=${account}`, { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => null);
      if (!alive) return;
      const sameDesk = (j?.agents ?? []).filter((a: { deskId: string }) => a.deskId === desk);
      setExisting(sameDesk.length);
      setDeployed(null); // deploying always creates a NEW agent
      setOwnerBalance(j?.ownerBalance ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [account, desk]);

  const selected = desks.find((d) => d.id === desk) ?? desks[0];
  const profile = risks.find((r) => r.id === risk);
  const tooMuch = ownerBalance != null && Number(amount) > Number(ownerBalance);

  /**
   * Sign → derive → FUND → only then register.
   *
   * The address is `keccak256(signature)` and can be computed entirely in the
   * browser, so nothing is told to the server until the wallet actually holds
   * collateral. That ordering matters: registering first leaves an orphan — an
   * agent marked "running" with an empty wallet that can never trade — if the
   * transfer is rejected or the tab is closed. The server refuses an unfunded
   * registration too, so the rule holds even if this code is bypassed.
   *
   * Abandoning halfway is safe: the same signature re-derives the same address,
   * so re-running the flow picks the funds back up.
   */
  const deploy = async () => {
    const wc = walletClient();
    if (!wc || !account) return;
    const amt = Number(amount);
    if (!(amt > 0)) {
      toast.error("Choose how much to fund the agent with first.");
      return;
    }
    if (ownerBalance != null && amt > Number(ownerBalance)) {
      toast.error(`You only hold ${Number(ownerBalance).toFixed(2)} tUSDC.`);
      return;
    }
    setBusy("deploy");
    try {
      const instance = existing;
      const signature = await wc.signMessage({
        account: account as Address,
        message: agentKeyMessage(account as Address, desk, instance),
      });

      // Derived in the browser. The server is not involved yet.
      const address = agentAddressFromKey(agentKeyFromSignature(signature as Hex));
      toast.ok(`Agent wallet ${shortAddr(address)} derived. Confirm the transfer to fund it.`);

      setBusy("fund");
      const hash = await sendFunds(address, amt);

      setBusy("confirming");
      const pub = createPublicClient({ chain: somniaTestnet, transport: http() });
      await pub.waitForTransactionReceipt({ hash });

      // Funded — now it is real, so register it.
      setBusy("deploy");
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: account, deskId: desk, signature, risk, instance }),
      }).then((r) => r.json());
      if (!res.ok) throw new Error(res.error ?? "deploy failed");

      setDeployed({ address: res.address, balance: res.balance });
      toast.ok(`${selected?.name ?? "Agent"} is live with ${amt} tUSDC. It trades the next round it likes.`, hash);
      setTimeout(() => void refresh(), 4000);
    } catch (e) {
      toast.error(msgOf(e));
    } finally {
      setBusy(null);
    }
  };

  /** The transfer itself, shared by first-time funding and topping up. */
  const sendFunds = async (to: Address, amt: number) => {
    const wc = walletClient();
    if (!wc || !account || !usdcAddress) throw new Error("wallet not ready");
    // Make the wallet prove it is on Shannon before moving money.
    if (provider) await ensureChain(provider);
    return wc.writeContract({
      account: account as Address,
      chain: somniaTestnet,
      address: usdcAddress,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [to, BigInt(Math.round(amt * 1e6))],
    });
  };

  /** Top up an agent that is already deployed. */
  const fund = async () => {
    if (!deployed) return;
    const amt = Number(amount);
    if (!(amt > 0)) return;
    setBusy("fund");
    try {
      const hash = await sendFunds(deployed.address, amt);
      toast.ok(`Sent ${amt} tUSDC to your agent.`, hash);
      setTimeout(() => void refresh(), 4000);
    } catch (e) {
      toast.error(msgOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="max-w-[1240px] px-8 pb-24 pt-8">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-12">
        <div className="min-w-0">
          <header className="pb-8">
            <h1 className="h-page">Deploy an agent</h1>
          </header>

          <Step n={1} title="Choose a desk" done={Boolean(selected)}>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {desks.map((d) => (
                <DeskCard key={d.id} desk={d} on={desk === d.id} onSelect={() => setDesk(d.id)} />
              ))}
              {desks.length === 0 &&
                [0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-[74px] animate-pulse rounded-2xl" style={{ background: "var(--surface-2)" }} />
                ))}
            </div>
          </Step>

          <Step n={2} title="Set its risk appetite" done>
            <div className="flex flex-wrap gap-2">
              {risks.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRisk(r.id)}
                  aria-pressed={risk === r.id}
                  className="rounded-xl border px-3.5 py-2.5 text-left transition-colors"
                  style={{
                    borderColor: risk === r.id ? "var(--text)" : "var(--line)",
                    background: "var(--surface)",
                  }}
                >
                  <span className="block text-[13px] font-semibold capitalize">{r.id}</span>
                  <span className="mono mt-0.5 block text-[10.5px]" style={{ color: "var(--muted)" }}>
                    {(r.sizeFraction * 100).toFixed(0)}% per trade · {r.maxConcurrent} open
                  </span>
                </button>
              ))}
            </div>
            {profile && (
              <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
                It acts only when it sees at least{" "}
                <strong>{(profile.minEdge * 100).toFixed(0)} points</strong> of edge over the book,
                stakes <strong>{(profile.sizeFraction * 100).toFixed(0)}%</strong> of the wallet per
                trade, and holds at most <strong>{profile.maxConcurrent}</strong> position
                {profile.maxConcurrent === 1 ? "" : "s"} at once.
              </p>
            )}

          </Step>

          <Step n={3} title="Decide how much to fund it with" done={Number(amount) > 0 && !tooMuch}>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div
                className="flex items-center gap-2 rounded-xl border px-3 py-2.5"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}
              >
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                  className="mono w-[90px] bg-transparent text-[14px] outline-none"
                  aria-label="Amount of tUSDC to fund the agent with"
                />
                <span className="text-[12.5px]" style={{ color: "var(--muted)" }}>tUSDC</span>
              </div>
              {[10, 25, 50].map((v) => (
                <button
                  key={v}
                  onClick={() => setAmount(String(v))}
                  className="rounded-full border px-3 py-1.5 text-[12px] transition-colors"
                  style={{
                    borderColor: amount === String(v) ? "var(--text)" : "var(--line)",
                    color: amount === String(v) ? "var(--text)" : "var(--muted)",
                  }}
                >
                  {v}
                </button>
              ))}
              {ownerBalance != null && Number(ownerBalance) > 0 && (
                <button
                  onClick={() => setAmount(String(Math.floor(Number(ownerBalance))))}
                  className="rounded-full border px-3 py-1.5 text-[12px]"
                  style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                >
                  Max
                </button>
              )}
            </div>
            <p className="mt-2.5 text-[11.5px]" style={{ color: "var(--faint)" }}>
              {ownerBalance == null ? "—" : `You hold ${Number(ownerBalance).toFixed(2)} tUSDC · gas is on us`}
            </p>
            {tooMuch && (
              <p className="mt-1.5 text-[12px]" style={{ color: "var(--down)" }}>
                That is more than you hold.
              </p>
            )}
          </Step>

          <Step n={4} title="Fund and deploy" done={Boolean(deployed?.balance?.funded)} last>
            <p className="text-[13px]" style={{ color: "var(--muted)" }}>
              Two wallet prompts: a signature that derives the key, then the transfer that funds it.
            </p>
            {deployed && (
              <div className="mt-3">
                <p className="mono text-[12px]">
                  <a
                    href={`${EXPLORER}/address/${deployed.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                    style={{ color: "var(--muted)" }}
                  >
                    {deployed.address}
                  </a>
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <span className="mono text-[12.5px]">
                    {Number(deployed.balance.usdc).toFixed(2)} tUSDC in the agent
                  </span>
                  <button
                    onClick={() => void fund()}
                    disabled={busy !== null || tooMuch}
                    className="rounded-full border px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
                    style={{ borderColor: "var(--line)" }}
                  >
                    {busy === "fund" ? "Confirm in wallet…" : `Add ${amount || 0} more`}
                  </button>
                </div>
              </div>
            )}
          </Step>
        </div>

        {/* ── the commit panel ────────────────────────────────────────────── */}
        <aside className="min-w-0 lg:sticky lg:top-[90px] lg:self-start">
          <section className="card overflow-hidden">
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--line-soft)" }}>
              <h2 className="text-[13px] font-semibold">Your agent</h2>
              <StatusPill account={account} deployed={Boolean(deployed)} funded={Boolean(deployed?.balance?.funded)} />
            </div>

            <div className="flex flex-col gap-3 p-4">
              <Row label="Desk">
                {selected ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 shrink-0" style={{ background: selected.color }} />
                    <span className="text-[12.5px] font-medium">{selected.name}</span>
                  </span>
                ) : <span style={{ color: "var(--faint)" }}>—</span>}
              </Row>
              <Row label="Risk"><span className="text-[12.5px] capitalize">{risk}</span></Row>
              <Row label="Funding">
                <span className="mono text-[12.5px]">{Number(amount) > 0 ? `${amount} tUSDC` : "—"}</span>
              </Row>
              <Row label="Instance">
                <span className="mono text-[12.5px]">#{existing + 1}</span>
              </Row>
              <Row label="Wallet">
                {deployed ? (
                  <span className="mono text-[12px]">{shortAddr(deployed.address)}</span>
                ) : <span style={{ color: "var(--faint)" }}>derived on deploy</span>}
              </Row>

              <div className="mt-1">
                <button
                    onClick={() => void deploy()}
                    disabled={!account || busy !== null || !(Number(amount) > 0) || tooMuch}
                    className="w-full px-4 py-2.5 text-[13px] font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
                    style={{ background: "var(--text)", color: "#fff" }}
                  >
                    {busy === "deploy"
                      ? "Registering…"
                      : busy === "fund"
                        ? "Confirm the transfer…"
                        : busy === "confirming"
                          ? "Waiting for the transfer…"
                          : !account
                            ? "Connect a wallet first"
                            : `Fund ${amount || 0} tUSDC & deploy`}
                  </button>
                <p className="mt-2 text-center text-[11px]" style={{ color: "var(--faint)" }}>
                  {existing > 0
                    ? `You already run ${existing} ${selected?.name ?? "agent"}${existing === 1 ? "" : "s"} — this deploys another, with its own wallet.`
                    : "A signature, then a transfer. Nothing else."}
                </p>
              </div>
            </div>

            <div className="border-t px-4 py-3.5" style={{ borderColor: "var(--line-soft)" }}>
              <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
                Only what you fund can be lost, and you can re-derive the key and sweep the wallet
                yourself. Not non-custodial — we hold a copy of the key so it can trade while you
                are away.
              </p>
            </div>
          </section>
        </aside>
      </div>

    </main>
  );
}

/* ── pieces ────────────────────────────────────────────────────────────── */

function Step({ n, title, done, last, children }: {
  n: number; title: string; done?: boolean; last?: boolean; children: React.ReactNode;
}) {
  return (
    <section className="relative flex gap-4 pb-8 last:pb-0">
      {!last && <span className="absolute left-[13px] top-7 bottom-0 w-px" style={{ background: "var(--line)" }} aria-hidden />}
      <span
        className="mono relative z-10 grid h-[27px] w-[27px] shrink-0 place-items-center rounded-full border text-[11px] font-semibold"
        style={done
          ? { background: "var(--text)", borderColor: "var(--text)", color: "#fff" }
          : { background: "var(--surface)", borderColor: "var(--line)", color: "var(--muted)" }}
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h2 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </section>
  );
}

function DeskCard({ desk, on, onSelect }: { desk: Desk; on: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={on}
      className="w-full rounded-2xl border p-3.5 text-left transition-colors"
      style={{ borderColor: on ? "var(--text)" : "var(--line)", background: "var(--surface)" }}
    >
      <span className="flex items-center gap-2.5">
        <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border"
          style={{ borderColor: on ? "var(--text)" : "var(--line)", background: on ? "var(--text)" : "transparent" }}>
          {on && (
            <svg width="9" height="9" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path d="M2.4 7.4 5.4 10.4 11.6 3.9" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0" style={{ background: desk.color }} />
            <span className="block truncate text-[13.5px] font-semibold">{desk.name}</span>
          </span>
          <span className="mt-0.5 block truncate text-[11.5px]" style={{ color: "var(--muted)" }}>{desk.thesis}</span>
        </span>
      </span>
    </button>
  );
}

function StatusPill({ account, deployed, funded }: { account: string | null; deployed: boolean; funded: boolean }) {
  const [label, fg, bg] = !account
    ? ["Not connected", "var(--muted)", "var(--surface-2)"]
    : deployed && funded
      ? ["Running", "var(--text)", "var(--surface-2)"]
      : ["Ready to deploy", "var(--muted)", "var(--surface-2)"];
  return (
    <span className="mono rounded-full px-2.5 py-1 text-[10.5px] uppercase tracking-[.1em]" style={{ color: fg, background: bg }}>
      {label}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px]" style={{ color: "var(--faint)" }}>{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}


function msgOf(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied/i.test(m)) return "Signature rejected in the wallet.";
  return m.slice(0, 200);
}
