"use client";

import { useWallet } from "./WalletProvider";
import ConnectWall from "./ConnectWall";
import Deploy from "./Deploy";

/**
 * The wallet wall for `/deploy`.
 *
 * Deploying derives the agent's key from the owner's own signature, so there is
 * no version of this flow that works without a connected wallet — showing the
 * desk picker first would only walk a visitor into a dead end at the signature.
 */
export default function DeployGate() {
  const { account } = useWallet();
  if (account) return <Deploy />;

  return (
    <ConnectWall
      eyebrow="Deploy an agent"
      title="Connect to deploy an agent."
      sub="Your agent's wallet is derived from a signature only your wallet can produce — so connecting is the first step, not a formality."
      next="/deploy"
    />
  );
}
