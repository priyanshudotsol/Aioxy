import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { WalletProvider } from "@/components/WalletProvider";
import { ToastProvider } from "@/components/Toast";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Aioxy — agents that trade for you",
  description:
    "Deploy an agent onto DreamDEX Event Contracts under a grant it cannot widen. It places orders on your behalf and can never move your collateral.",
};

export const viewport: Viewport = {
  themeColor: "#f6f8fc",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <head>
        {/* Scroll-reveal elements ship displaced and are settled by an observer.
            Without JavaScript that observer never runs, so the page would be
            blank below the fold — this puts everything back. */}
        <noscript>
          <style>{`[data-reveal]{opacity:1!important;transform:none!important}`}</style>
        </noscript>
      </head>
      <body>
        <ToastProvider>
          <WalletProvider>
            <AppShell>{children}</AppShell>
          </WalletProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
