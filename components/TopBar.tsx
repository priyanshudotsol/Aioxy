"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AioxyMark } from "./BrandMarks";
import ConnectButton from "./ConnectButton";
import { useWallet } from "./WalletProvider";

/**
 * The bar for every view that has no left rail: the landing page, and any app
 * page a reader reaches before connecting.
 *
 * It floats rather than sticks. At the top of the page it is a full-width bar
 * on bare background; past the fold it contracts into a white pill with a
 * shadow, so the nav stays legible over whatever has scrolled under it without
 * ever drawing a hard line across the design.
 */
export default function TopBar() {
  const path = usePathname();
  const { account } = useWallet();
  const onLanding = path === "/";
  const scrolled = useScrolled(24);

  // On the landing the links are page anchors; anywhere else they are routes,
  // because an anchor to "/#how" from /deploy is a navigation, not a jump.
  //
  // Deploy, Fleet and Leaderboard all need a wallet, so they only appear once
  // there is one. Offering them to a disconnected reader just routes them into
  // a wall, and the connect action is right there in the same bar.
  const links = onLanding
    ? account
      ? [
          { href: "#how", label: "How it works" },
          { href: "#strategies", label: "Strategies" },
          { href: "/leaderboard", label: "Leaderboard" },
        ]
      : [
          { href: "#how", label: "How it works" },
          { href: "#strategies", label: "Strategies" },
        ]
    : account
      ? [
          { href: "/deploy", label: "Deploy" },
          { href: "/fleet", label: "Fleet" },
          { href: "/leaderboard", label: "Leaderboard" },
        ]
      : [{ href: "/", label: "How it works" }];

  return (
    <header className="soft pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5 sm:pt-4">
      <div
        className={`pointer-events-auto mx-auto flex items-center gap-3 transition-all duration-300 ease-out ${
          scrolled
            ? "max-w-[860px] rounded-full py-2 pl-3 pr-2 sm:pl-5 sm:pr-2.5"
            : "max-w-[1180px] rounded-full py-2 pl-1 pr-1 sm:pl-2 sm:pr-2"
        }`}
        style={{
          background: scrolled ? "var(--surface)" : "transparent",
          boxShadow: scrolled ? "var(--shadow-pill)" : "none",
          border: `1px solid ${scrolled ? "var(--line-soft)" : "transparent"}`,
        }}
      >
        <Link href="/" className="flex shrink-0 items-center gap-2.5 rounded-full px-2 py-1">
          <AioxyMark size={26} />
          <span className="text-[15.5px] font-semibold tracking-[-.015em]">Aioxy</span>
        </Link>

        <nav className="mx-auto hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={path === l.href ? "page" : undefined}
              className="rounded-full px-3.5 py-2 text-[13.5px] font-medium transition-colors hover:text-[var(--text)]"
              style={{ color: path === l.href ? "var(--text)" : "var(--muted)" }}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        {/* `ml-auto` is the fallback for the narrow layout, where the centred
            nav is hidden and there is nothing else to push the action right. */}
        <span className="ml-auto shrink-0 md:ml-0">
          <ConnectButton />
        </span>
      </div>
    </header>
  );
}

/** True once the page has scrolled past `after` pixels. */
function useScrolled(after: number) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => setOn(window.scrollY > after);
    read();
    window.addEventListener("scroll", read, { passive: true });
    return () => window.removeEventListener("scroll", read);
  }, [after]);
  return on;
}
