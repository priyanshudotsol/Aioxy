# Aioxy

**Agents that trade for you, that cannot take your money.**

Deploy an AI trading agent onto [DreamDEX Event Contracts](https://docs.dreamdex.io/developers/event-contracts)
— short-window Up/Down markets on BTC and ETH, on Somnia Shannon testnet (chain 50312).
The agent places orders on your behalf under an on-chain grant scoped to two functions.
It can never move your collateral.

Built for the Somnia × DreamDEX Event Contracts Hackathon.

---

## Run it

```bash
npm install
npm run dev          # http://localhost:4311
```

No configuration, no key, no database.

## The product

Three screens, one loop.

| Route | |
|---|---|
| `/` | What it is and why the grant is safe |
| `/deploy` | Connect → pick a desk → one signature grants it order rights |
| `/fleet` | Your agents, your collateral, your P&L, every trade with its reasoning |

That is the whole surface. Anything that was not on the path from *connect* to
*an agent trading for you* has been removed.

## Status: the delegated execution path is not wired yet

Being precise about this matters more than the feature list.

The grant is real — `/deploy` writes an `OperatorPermissionsRegistry` approval on-chain,
scoped to `placeOrderFor` and `cancelOrderFor`, and you can check it on the explorer.
**Nothing calls those functions yet.**

What runs today is a house runner (`lib/runner.ts`) that trades four agents on a single
server key, in paper mode by default. `/fleet` attributes those trades to a connected
owner by filtering on desk id and grant timestamp — it is a preview of the shape, not
per-owner execution. Two things have to change before the headline claim is true:

1. `lib/executor.ts` must send `placeOrderFor(owner, …)` per active delegation, not
   `placeOrder` on the house key.
2. `UNIQUE(agentId, marketId)` in `lib/store.ts` must become
   `UNIQUE(agentId, marketId, owner)` — today the schema physically cannot hold two
   owners' orders in the same round.

Until then `/fleet` is showing you a shared record, and it says so.

### Going live on testnet

```bash
npm run doctor   # can this wallet trade right now, and if not, what is missing?
npm run smoke    # send ONE real IOC order and print the tx hash + indexed fill
```

`doctor` verifies the key, RPC and chain id, STT (gas) balance, tUSDC (collateral)
balance, that live rounds exist, and the execution mode — then names exactly what is
blocking and where to fix it. `smoke` finds the soonest round with crossable depth,
sends a single one-contract immediate-or-cancel order, waits for the indexer to show the
fill, and prints the explorer link.

Funding a wallet needs two different taps:

| Need | Where |
|---|---|
| **STT** (gas) | <https://testnet.somnia.network/> — also Google Cloud, Stakely, thirdweb faucets |
| **tUSDC** (collateral) | SomniaHacks dev group, faucet topic: <https://t.me/+XHq0F0JXMyhmMzM0> |

Native STT cannot substitute for collateral: `mintSetNative` requires the market's
collateral to be wNative, and every live binary round settles in tUSDC.

Then:

```bash
echo 'EXECUTION_MODE=live' >> .env.local
npm run doctor   # expect: Ready to trade on testnet
```

## What is actually real

| | Source |
|---|---|
| Rounds, strikes, expiries | DreamDEX indexer, live |
| Order books | DreamDEX indexer, live resting orders |
| BTC/ETH spot | Somnia oracle price feed — the same feed that settles these markets |
| Round resolution | On-chain payout vectors, read back to settle every agent trade |
| Your grant | `OperatorApproval` on-chain, written by you, revocable by you |
| Agent execution | **Paper by default, on a house key.** See the status note above. |

Paper trades are labelled `paper` in the UI. Nothing is presented as an on-chain fill
that was not one.

## The non-custodial claim

DreamDEX records operator authorization on-chain in `OperatorPermissionsRegistry`, scoped
per function selector. An operator key can call `placeOrderFor` and `cancelOrderFor` — and
nothing else. It cannot deposit, withdraw, or grant approvals. Fills settle to the
**owner's** vault. Revocation is immediate.

The grant is global rather than per-pool because binary pools are recycled every window:
a 60-second series mints a new pool each round, so a per-pool grant would need a signature
per round and could never keep up. Global is broader than per-pool — it covers pools
registered later — and it is still limited to those two selectors.

## The agents

All four share one pricing model, so their disagreements are about inputs rather than
arithmetic. For "will spot be ≥ strike at expiry", under driftless lognormal motion:

```
P(up) = Φ( ln(S/K) / (σ√τ) )
```

`σ` is realised volatility estimated from oracle ticks, normalised by actual elapsed time
between them. As `τ → 0` the probability collapses toward 0 or 1 — the effect Clockwork trades.

| Agent | Thesis | Acts when |
|---|---|---|
| **Clockwork** | Time decay | Last third of a round, model confident, book lagging |
| **Driftwood** | Momentum | 30s drift projects across the strike and the book has not caught up |
| **Undertow** | Mean reversion | Book quotes an extreme that realised volatility does not support |
| **Contrary** | Book imbalance | Resting depth is lopsided beyond what the model justifies |

Every decision records a sentence explaining itself. A losing trade shows its reasoning
exactly as prominently as a winning one.

## What is deliberately not claimed

Short-window crypto binaries are close to a coin flip minus fees. The DreamDEX bot kit's own
`measuring-edge.md` is blunt: if net markout is negative at your horizon, passive liquidity
provision "is a donation." Samples this small are noise and a hot streak is not an edge.

Two caveats that specifically flatter the record:

1. **Selection.** Agents only trade when they believe they see edge, so a conditional win
   rate sits above 50% by construction. It is not comparable to a coin flip.
2. **Paper fills are optimistic.** In paper mode a fill is assumed at the price resting on
   the book at the instant the decision was made — no latency, no slippage, no queue
   position. Live execution will be *worse* than the paper record, never better.

An earlier build also priced rounds with an empty book against an assumed counterparty at
0.55. That handed agents roughly 24 points of unearned edge. It was removed: **agents now
stand down on rounds with no resting depth** rather than invent a price.

## Architecture

```
 oracle price feed ──┐
 (BTC/ETH, ~1s)      │
                     ├──> fair value ──> agent strategies ──> executor ──> DreamDEX pool
 DreamDEX indexer ────┤    (σ, τ, S, K)     (4 theses)          │           placeOrder
 (rounds, book,       │                                         │           (placeOrderFor:
  fills, settlement)  │                                         v            not wired yet)
                      └───────────────────────────────────> trade store ──> /fleet
```

| Path | Purpose |
|---|---|
| `lib/pricing.ts` | Normal CDF, fair-value model, rolling volatility estimator |
| `lib/agents.ts` | Four strategies over a shared decision interface |
| `lib/runner.ts` | Tick loop: price, decide, execute, settle |
| `lib/executor.ts` | Paper and live behind one interface |
| `lib/indexer.ts` | Indexer + price-feed queries, venue auto-detection |
| `lib/store.ts` | SQLite store — trades, delegations, SQL-aggregated stats |
| `lib/delegation.ts`, `lib/wallet.ts` | EIP-6963 connection and the on-chain operator grant |
| `app/` | Landing, deploy, fleet |

### Storage

Trades and delegations live in **SQLite**, through Node 25's built-in `node:sqlite` — a real
database with transactions, indexes and SQL aggregates, and no dependency to install or
service to provision. It runs in WAL mode so the agent runner writes while requests read.

Per-agent statistics are computed as a **SQL aggregate**, not by pulling every row into JS.
The one-position-per-agent-per-round rule is a `UNIQUE(agentId, marketId)` **index**, so the
database rejects a duplicate rather than the runner having to remember to check — which is
also why it has to gain an `owner` column before agents can trade per-owner.

## One implementation note worth flagging

**The venue id is derived at runtime, never hardcoded.** The bot kit documents a testnet
`VENUE_ID`, and it is already stale — every market created in the last hour sits on a
different venue. `activeVenueId()` reads it off the newest market instead, and the runner
re-derives it after any hard failure. The docs warn that these move; they moved.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · `@somnia-chain/markets-sdk` 0.29 · viem
