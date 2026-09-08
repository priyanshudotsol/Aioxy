"use client";

import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  PLACE_ORDER_FOR_SELECTOR,
  CANCEL_ORDER_FOR_SELECTOR,
} from "@somnia-chain/markets-sdk";
import { somniaTestnet } from "viem/chains";
import type { Address, WalletClient } from "viem";
import { INDEXER_URL, WS_RPC_URL } from "./config";

/**
 * The two selectors an agent is admitted to call — and the whole basis of the
 * non-custodial claim. `placeOrderFor` and `cancelOrderFor` are order-routing
 * entrypoints; neither can move funds. Deposit, withdraw and approval remain
 * owner-scoped, and every fill settles to the owner's account.
 */
export const AGENT_SELECTORS = [PLACE_ORDER_FOR_SELECTOR, CANCEL_ORDER_FOR_SELECTOR] as const;

function exchangeFor(walletClient: WalletClient) {
  return new SomniaMarkets({
    chain: somniaTestnet,
    addresses: SOMNIA_TESTNET_ADDRESSES,
    walletClient,
    wsRpcUrl: WS_RPC_URL,
    indexerUrl: INDEXER_URL,
  });
}

/**
 * Grant an agent the right to trade for you.
 *
 * Uses the GLOBAL grant deliberately. Binary pools are recycled every window —
 * a 60-second series creates a new pool each round — so a per-pool grant would
 * need a signature per round and could never keep up. The global grant covers
 * pools registered later, which is exactly the rolling case. It is broader than
 * a per-pool grant, and the UI says so.
 */
export async function grantAgent(walletClient: WalletClient, operator: Address) {
  const ex = exchangeFor(walletClient);
  return ex.trader.setOperatorApprovalGlobal({
    operator,
    selectors: [...AGENT_SELECTORS],
    approved: true,
  });
}

/** Revoke immediately. No unbonding, no cooperation from the agent required. */
export async function revokeAgent(walletClient: WalletClient, operator: Address) {
  const ex = exchangeFor(walletClient);
  return ex.trader.setOperatorApprovalGlobal({
    operator,
    selectors: [...AGENT_SELECTORS],
    approved: false,
  });
}
