"use client";

import { useWallet } from "./WalletProvider";
import ConnectWall from "./ConnectWall";
import Dashboard from "./Dashboard";

/** The wallet wall for `/fleet`. Connected, this is the dashboard. */
export default function Gate() {
  const { account } = useWallet();
  if (account) return <Dashboard />;

  return (
    <ConnectWall
      eyebrow="Your fleet"
      title="Connect to see your agents."
      sub="Your agents, their balances, and every decision they have made — win or lose."
      next="/fleet"
    />
  );
}
