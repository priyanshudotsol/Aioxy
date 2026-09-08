"use client";

import { useWallet } from "./WalletProvider";
import ConnectWall from "./ConnectWall";
import Leaderboard from "./Leaderboard";

/** The wallet wall for `/leaderboard`. */
export default function LeaderboardGate() {
  const { account } = useWallet();
  if (account) return <Leaderboard />;

  return (
    <ConnectWall
      eyebrow="Standings"
      title="Connect to see the board."
      sub="Every trader running an agent, ranked by what they have actually made and lost — and your own row marked among them."
      next="/leaderboard"
    />
  );
}
