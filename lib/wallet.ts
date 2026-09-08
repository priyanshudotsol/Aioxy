"use client";

import { createWalletClient, custom, type Address, type EIP1193Provider } from "viem";
import { somniaTestnet } from "viem/chains";
import { CHAIN_ID, RPC_URL, EXPLORER } from "./config";

/** EIP-6963 announced provider. */
export type Injected = { info: { rdns: string; name: string; icon: string }; provider: EIP1193Provider };

/**
 * Discover wallets via EIP-6963, falling back to a legacy window.ethereum.
 * Multiple extensions fight over window.ethereum, so 6963 is the correct path.
 */
export function discoverWallets(timeoutMs = 400): Promise<Injected[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Injected>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent).detail as Injected;
      if (d?.info?.rdns) found.set(d.info.rdns, d);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      if (found.size === 0) {
        const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
        if (legacy) {
          found.set("injected", {
            info: { rdns: "injected", name: "Browser wallet", icon: "" },
            provider: legacy,
          });
        }
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}`;

/** Ask the wallet to switch to Shannon, adding the network if it is unknown. */
export async function ensureChain(provider: EIP1193Provider) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    // 4902 = chain not added yet.
    const code = (e as { code?: number })?.code;
    if (code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_HEX,
          chainName: "Somnia Shannon Testnet",
          nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER],
        },
      ],
    } as never);
  }
}

export async function connect(provider: EIP1193Provider): Promise<Address> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  if (!accounts?.length) throw new Error("no account returned");
  await ensureChain(provider);
  return accounts[0];
}

export function walletClientFor(provider: EIP1193Provider, account: Address) {
  return createWalletClient({ account, chain: somniaTestnet, transport: custom(provider) });
}
