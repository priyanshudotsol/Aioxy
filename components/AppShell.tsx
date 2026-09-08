"use client";

import { usePathname } from "next/navigation";
import { useWallet } from "./WalletProvider";
import Sidebar, { MobileBar, SIDEBAR_W } from "./Sidebar";
import TopBar from "./TopBar";

/**
 * Two shells, chosen by connection state.
 *
 * Signed in: a persistent left rail between the fleet and the deploy flow.
 * Otherwise a top bar carrying the wordmark and the connect action.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const { account } = useWallet();
  const path = usePathname();

  // "/" is the marketing page. It gets the bar rather than the rail even for a
  // signed-in reader, so the landing never appears wrapped in a dashboard.
  if (!account || path === "/") {
    return (
      <>
        <TopBar />
        {children}
      </>
    );
  }

  return (
    <div className="min-h-[100dvh]">
      <Sidebar />
      <MobileBar />
      {/* No inline paddingLeft here: an inline style outranks the Tailwind
          class, so the rail offset silently never applied and the content sat
          underneath the sidebar. */}
      <div className="lg:pl-[var(--rail)]">{children}</div>
      <style>{`:root { --rail: ${SIDEBAR_W}px }`}</style>
    </div>
  );
}
