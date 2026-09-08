import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * Agent keys are encrypted at rest with AES-256-GCM.
 *
 * The server has to hold agent keys to trade while the user is away — that is the
 * custody trade-off this model accepts (docs/IDEA.md). Storing them as plaintext
 * in SQLite on top of that would be indefensible, and the fix costs twenty lines.
 *
 * The secret comes from AGENT_KEY_SECRET. Without it we fall back to a
 * machine-local constant so development works, and shout about it — a fallback
 * secret protects against a stolen database file, not against a stolen host.
 */
function secretKey(): Buffer {
  const s = process.env.AGENT_KEY_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production" && !warned) {
      console.warn("[vault] AGENT_KEY_SECRET is unset — agent keys are weakly protected");
      warned = true;
    }
    return createHash("sha256").update("aioxy-dev-fallback").digest();
  }
  return createHash("sha256").update(s).digest();
}
let warned = false;

/** iv.ciphertext.tag, all base64url — one opaque column value. */
export function sealKey(privateKey: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ct = Buffer.concat([c.update(privateKey, "utf8"), c.final()]);
  return [iv, ct, c.getAuthTag()].map((b) => b.toString("base64url")).join(".");
}

/** Returns null rather than throwing — a key sealed under a different secret is
 *  unreadable, and the caller should skip that agent, not crash the runner. */
export function openKey(sealed: string): string | null {
  try {
    const [iv, ct, tag] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    if (!iv || !ct || !tag) return null;
    const d = createDecipheriv("aes-256-gcm", secretKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
