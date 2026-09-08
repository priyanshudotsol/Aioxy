"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Address, EIP1193Provider } from "viem";
import { connect as connectWallet, discoverWallets, walletClientFor, type Injected } from "@/lib/wallet";

type WalletState = {
  wallets: Injected[];
  /** False until EIP-6963 discovery has finished. An empty `wallets` before
   *  this is "we have not looked yet", not "there is nothing installed". */
  discovered: boolean;
  provider: EIP1193Provider | null;
  account: Address | null;
  connecting: boolean;
  error: string | null;
  /** `next` overrides where to land once connected. */
  connect: (w: Injected, next?: string) => Promise<void>;
  disconnect: () => void;
  walletClient: () => ReturnType<typeof walletClientFor> | null;
};

const Ctx = createContext<WalletState | null>(null);

const STORAGE_KEY = "aioxy:wallet";

/**
 * One connection shared by the whole app, so connecting in the header is
 * immediately reflected on the Fleet page and vice versa.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<Injected[]>([]);
  const [discovered, setDiscovered] = useState(false);
  const [provider, setProvider] = useState<EIP1193Provider | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;
    discoverWallets().then((found) => {
      if (!alive) return;
      setWallets(found);
      setDiscovered(true);
      // Reconnect silently if this browser already authorised a wallet.
      const last = (() => {
        try {
          return localStorage.getItem(STORAGE_KEY);
        } catch {
          return null;
        }
      })();
      const match = last ? found.find((w) => w.info.rdns === last) : null;
      if (!match) return;
      match.provider
        .request({ method: "eth_accounts" })
        .then((accts) => {
          const list = accts as Address[];
          if (alive && list?.length) {
            setProvider(match.provider);
            setAccount(list[0]);
          }
        })
        .catch(() => {});
    });
    return () => {
      alive = false;
    };
  }, []);

  /* Follow account switches made inside the wallet itself. */
  useEffect(() => {
    if (!provider) return;
    const onAccounts = (...args: unknown[]) => {
      const accts = args[0] as Address[];
      setAccount(accts?.length ? accts[0] : null);
    };
    const p = provider as unknown as {
      on?: (e: string, h: (...a: unknown[]) => void) => void;
      removeListener?: (e: string, h: (...a: unknown[]) => void) => void;
    };
    p.on?.("accountsChanged", onAccounts);
    return () => p.removeListener?.("accountsChanged", onAccounts);
  }, [provider]);

  const connect = useCallback(async (w: Injected, next?: string) => {
    setConnecting(true);
    setError(null);
    try {
      const addr = await connectWallet(w.provider);
      setProvider(w.provider);
      setAccount(addr);
      try {
        localStorage.setItem(STORAGE_KEY, w.info.rdns);
      } catch {
        /* private mode — connection still works for this session */
      }

      // Where to land. `next` is set by whatever asked for the connection — the
      // deploy wall and the landing's deploy button both pass "/deploy", so a
      // reader who pressed "deploy" is not dropped on the dashboard instead.
      // Otherwise, connecting from the marketing page means the reader is done
      // reading, so send them to their fleet. Never a redirect from inside
      // /deploy itself: connecting is step 1 there and steps 2 and 3 follow on
      // the same page. The silent reconnect above never reaches here, so a
      // returning visitor can still open the landing page and read it.
      if (next) {
        if (next !== pathname) router.push(next);
      } else if (pathname === "/") {
        router.push("/fleet");
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(/user rejected|denied/i.test(m) ? "Connection rejected." : m.slice(0, 160));
    } finally {
      setConnecting(false);
    }
  }, [router, pathname]);

  const disconnect = useCallback(() => {
    setProvider(null);
    setAccount(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clear */
    }
    // Every route except the landing needs a wallet, so staying put after a
    // disconnect just swaps the page for a connect wall — which reads as the
    // app having thrown the reader out. Send them to the page that still has
    // something to say to them.
    router.push("/");
  }, [router]);

  const walletClient = useCallback(
    () => (provider && account ? walletClientFor(provider, account) : null),
    [provider, account],
  );

  const value = useMemo(
    () => ({ wallets, discovered, provider, account, connecting, error, connect, disconnect, walletClient }),
    [wallets, discovered, provider, account, connecting, error, connect, disconnect, walletClient],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside <WalletProvider>");
  return v;
}
