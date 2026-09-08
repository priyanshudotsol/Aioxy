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
        {/* The bar floats over the page rather than pushing it down, so every
            view except the landing — which paints its own ground up behind the
            nav — has to reserve the height itself. */}
        <div className={path === "/" ? undefined : "pt-[72px]"}>{children}</div>
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
