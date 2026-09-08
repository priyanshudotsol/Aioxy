// Endpoints and on-chain constants for DreamDEX Event Contracts on Somnia Shannon.
//
// The venue id is deliberately NOT hardcoded. The bot kit documents a testnet
// VENUE_ID, but it has already moved: markets created in the last hour sit on a
// different venue than the one in the docs. `activeVenueId()` in indexer.ts
// derives it from the newest market instead, so the app survives the next move.

export const INDEXER_URL =
  process.env.INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";

export const PRICE_FEED_URL =
  process.env.PRICE_FEED_URL ?? "https://price-feed.dev.oracle.somnia.host/v1/graphql";

export const RPC_URL = process.env.RPC_URL ?? "https://dream-rpc.somnia.network";

export const WS_RPC_URL =
  process.env.WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws";

export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 50312);

export const EXPLORER =
  process.env.EXPLORER_URL ?? "https://shannon-explorer.somnia.network";


/** Runner cadence. Rounds are hours long, so this is about responsiveness, not speed. */
export const TICK_MS = Number(process.env.TICK_MS ?? 3000);

/**
 * How far past the observed price a taker will pay to actually cross.
 *
 * The book comes from the indexer, which lags the chain: an order sent at
 * exactly the level we read reverts `ImmediateOrCancelNoFill()` the moment that
 * level moves.
 */
export const CROSSING_BUFFER = Number(process.env.CROSSING_BUFFER ?? 0.02);

/** Gas the house sends a new agent, and the floor it stops giving below. */
export const AGENT_GAS_TOPUP_WEI = BigInt(process.env.AGENT_GAS_TOPUP_WEI ?? 2n * 10n ** 17n);
export const AGENT_GAS_MIN_WEI = BigInt(process.env.AGENT_GAS_MIN_WEI ?? 10n ** 17n);
export const HOUSE_GAS_FLOOR_WEI = BigInt(process.env.HOUSE_GAS_FLOOR_WEI ?? 5n * 10n ** 18n);

/** Fixed-point scales used across the protocol. */
export const PROB_SCALE = 1_000_000; // order price = probability in millionths
export const QTY_SCALE = 1_000_000; // testnet collateral (tUSDC) is 6-decimals
export const STRIKE_SCALE = 100; // strike is cents
export const FEED_SCALE = 10n ** 18n; // price feed is 18-decimals

/** Outcome index -> label. payoutNumerators[0] is the UP leg. */
export const UP = 0;
export const DOWN = 1;

/** Live trading is enabled only when a funded key is present. */
export const canTrade = () => Boolean(process.env.PRIVATE_KEY);
