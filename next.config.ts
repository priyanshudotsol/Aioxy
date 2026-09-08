import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Next blocks cross-origin requests to dev-only assets by default, so a
   * tunnelled host (ngrok, Cloudflare) serves an empty page: the HTML arrives,
   * every chunk and RSC request is refused, and nothing hydrates — which also
   * means the wallet button never wires up.
   *
   * Tunnels are how we get an HTTPS origin, and an HTTPS origin is what stops
   * MetaMask gating every transaction behind its HTTP warning.
   */
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.ngrok.io",
    "*.trycloudflare.com",
    "*.loca.lt",
  ],
};

export default nextConfig;
