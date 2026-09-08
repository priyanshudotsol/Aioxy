import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * An agent's key is DERIVED from the owner's signature, never invented by us.
 *
 * The owner signs a fixed message; the key is `keccak256(signature)`. Because
 * the message is deterministic and the signature is reproducible by that wallet
 * alone, the owner can re-derive the same key at any time, from any machine,
 * without our cooperation — so if this service disappears they can still sweep
 * the agent wallet. That recoverability is the only meaningful safety property
 * left after chunk 0 (docs/RESEARCH.md §2), so it is worth doing properly.
 *
 * It does not make us non-custodial: the server holds a copy of the key in order
 * to trade while the user is away. Say so plainly in the UI.
 */
export function agentKeyMessage(owner: Address, deskId: string, instance = 0) {
  return [
    "Aioxy — derive agent key (v1)",
    "",
    `owner: ${owner.toLowerCase()}`,
    `agent: ${deskId}`,
    // Lets one owner run several agents of the same desk, each with its own
    // wallet. Without it the derivation is fixed per desk, so a second
    // Clockwork would land on the first one's address.
    `instance: ${instance}`,
    "",
    "Signing this derives the private key for this agent's wallet.",
    "Anyone holding this signature controls that wallet. Only sign it on Aioxy.",
  ].join("\n");
}

/** signature -> the agent's private key. Deterministic, and reproducible by the owner. */
export const agentKeyFromSignature = (signature: Hex): Hex => keccak256(signature);

export const agentAddressFromKey = (key: Hex): Address => privateKeyToAccount(key).address;

/**
 * Message an owner signs to authorise a withdrawal from the browser.
 *
 * The internal secret is a server-side credential and must never reach a page,
 * so browser-initiated withdrawals prove ownership the same way deployment does
 * — with a signature only the owner's wallet can produce. The nonce keeps a
 * captured signature from being replayed later.
 */
export function withdrawMessage(owner: Address, deskId: string, amount: string, nonce: number) {
  return [
    "Aioxy — withdraw from agent (v1)",
    "",
    `owner: ${owner.toLowerCase()}`,
    `agent: ${deskId}`,
    `amount: ${amount} tUSDC`,
    `nonce: ${nonce}`,
    "",
    "Signing this sweeps the agent's collateral back to your wallet.",
  ].join("\n");
}

/**
 * Message an owner signs to claim a display name.
 *
 * The leaderboard is public, so a name has to be provably tied to the wallet
 * that owns it — otherwise anyone could rename anyone. Same shape as the
 * withdraw authorisation: a signature the browser can produce, verified server
 * side, with a nonce so it cannot be replayed later.
 */
export function usernameMessage(owner: Address, username: string, nonce: number) {
  return [
    "Aioxy — set display name (v1)",
    "",
    `owner: ${owner.toLowerCase()}`,
    `name: ${username}`,
    `nonce: ${nonce}`,
    "",
    "This name appears next to your agents on the public leaderboard.",
  ].join("\n");
}
