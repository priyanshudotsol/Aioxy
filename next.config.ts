import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Bundles only the files the server actually needs, so the Docker image
   * carries a runtime instead of a whole node_modules. See Dockerfile.
   *
   * Off on Vercel, where it broke the deploy: `onBuildComplete` from Vercel's
   * build adapter died on a missing `.next/next-server.js.nft.json`. A local
   * standalone build does emit that file, so the conflict is with the adapter
   * rather than with standalone alone — but Vercel traces and packages the
   * server itself and has no use for `.next/standalone` either way. Standalone
   * exists here only for the Docker image.
   */
  output: process.env.VERCEL ? undefined : "standalone",

  /**
   * Keep the live database out of the build.
   *
   * The tracer follows `.data/aioxy.db` from the store and copies it into
   * `.next/standalone`, which would ship a real database — sealed agent keys
   * and all — inside the Docker image. `.dockerignore` cannot help, because by
   * then the file is inside the output being copied.
   */
  outputFileTracingExcludes: {
    // Leading-dot directories need to be matched explicitly; picomatch will not
    // match them with a bare `*`. The Dockerfile also deletes these after the
    // copy, because a build artefact containing real keys is not something to
    // leave to a glob.
    "*": [".data/**", "./.data/**/*", "certificates/**", "docs/**"],
  },

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
