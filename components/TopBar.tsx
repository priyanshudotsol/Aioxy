"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AioxyMark } from "./BrandMarks";
import ConnectButton from "./ConnectButton";

/**
 * The bar for every view that has no left rail: the landing page, and any app
 * page a reader reaches before connecting. It carries the wordmark — without it
 * the landing never says what the product is called — and the connect action.
 */
export default function TopBar() {
  const path = usePathname();
  const onLanding = path === "/";

  const links = onLanding
    ? [
        { href: "/#how", label: "How it works" },
        { href: "/deploy", label: "Deploy an agent" },
      ]
    : [
        { href: "/deploy", label: "Deploy" },
        { href: "/fleet", label: "Fleet" },
      ];

  return (
    <header
      className="sticky top-0 z-50 border-b backdrop-blur-md"
      style={{ borderColor: "var(--line)", background: "color-mix(in srgb, var(--surface) 82%, transparent)" }}
    >
      <div className="mx-auto flex h-[58px] max-w-[1180px] items-center gap-4 px-4 sm:px-5">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <AioxyMark size={26} />
          <span className="text-[15.5px] font-semibold tracking-[-.015em]">Aioxy</span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 sm:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={path === l.href ? "page" : undefined}
              className="rounded-full px-3 py-1.5 text-[13.5px] font-medium transition-colors hover:bg-[var(--surface-2)]"
              style={{ color: path === l.href ? "var(--text)" : "var(--muted)" }}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <span className="ml-auto shrink-0">
          <ConnectButton />
        </span>
      </div>
    </header>
  );
}
