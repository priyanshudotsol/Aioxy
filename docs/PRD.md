> ## ⚠️ SUPERSEDED — 2026-09-07
>
> This document predates the venue research in [RESEARCH.md](RESEARCH.md) and
> describes the earlier "marketplace of house agents" framing.
>
> **It contains at least one claim that is factually wrong:** there are no
> 15-minute DreamDEX markets and there never have been, and the 60-second series
> it targets has produced zero trades across 317 markets.
>
> The canonical product definition is **[IDEA.md](IDEA.md)**; the plan is
> **[BUILD.md](BUILD.md)**. Kept for the research in §1, which is still sound.

# Aioxy — Product Requirements

**Agents that trade for you, that cannot take your money, on markets that settle provably.**

Somnia × DreamDEX Event Contracts Hackathon. Submission deadline 8 Sep.

---

## 1. The problem

Three findings from research drive every decision below.

**(a) Event Contracts are unused.** Measured live on Shannon testnet:

| Metric | Value |
|---|---|
| Event-contract fills | ~54/hour |
| Share of DreamDEX venue flow | 4.3% (95.7% is spot) |
| Unique addresses trading them | 83 |
| Top-3 taker concentration | 38% |

The sponsor's problem is adoption, not features. "Business & Ecosystem Impact" is 20% of the rubric.

**(b) The category is proven, so novelty is not the wedge.** Kalshi's `KXBTC15M`, Coinbase
Predict, and Polymarket all run 15-minute and 5-minute BTC binaries at real volume. Pantera's
"Crypto on the Clock" puts short-duration at $7.8B of $10.07B combined crypto volume, and
Kalshi's crypto share rose 4.3% → 17.9% across H1 2026. Robinhood's event contracts earned
$156M in Q2 2026 — more than its stocks or crypto desks.

**(c) Trust is the open wound.** Documented complaints against the incumbents: a 99%-probability
contract that filled at 98.5% on Kalshi filled at **80%** through Coinbase's wrapper; "$56 total
fee which puts me at an actual loss"; markets resolved on a "false score" that support would not
correct. Separately, Synthetix deprecated its binary options (SIP-149) explicitly because
secondary markets were OTC-only and illiquid — the exact failure a CLOB fixes.

So: the category works, the incumbents are opaque, and this venue has no users.

## 2. The product

A marketplace of AI trading agents on DreamDEX Event Contracts, where **delegation is
non-custodial by construction** and **every settlement is auditable**.

Three claims, each backed by a protocol primitive rather than a promise:

1. **Your funds never leave your wallet.** DreamDEX's operator model records authorization
   on-chain in `OperatorPermissionsRegistry`, per function selector. An operator key can call
   `placeOrderFor` / `cancelOrderFor` and *nothing else* — it cannot deposit, withdraw, or
   approve. Fills settle to the owner's vault. Revocation is immediate. Verified in use on
   testnet: 1,000+ approvals across 61 distinct owners.
2. **Every trade is public.** Each agent publishes every decision it made, the reason it made
   it, and what it was worth — wins and losses alike.
3. **Every settlement is verifiable.** Each resolved round shows the payout vector the oracle
   delivered on-chain, with its block, linked to the explorer.

### Why this beats a prettier trading UI
An agent platform *manufactures* the trading activity the venue lacks. Every agent deployed is
a trader that never sleeps. It is the most direct available answer to "will this generate
trading activity."

### What we deliberately do not claim
Short-window crypto binaries are close to a coin flip minus fees. The bot kit's own
`measuring-edge.md` is blunt: if net markout is negative at your horizon, "passive liquidity
provision there is a donation." We therefore present **transparent competition, never
guaranteed returns.** No "already winning" copy. Losing agents stay on the leaderboard.

## 3. Users

- **Spectator** — lands, watches agents trade live 60-second rounds, understands the mechanism.
  Needs zero setup. This is the judge.
- **Delegator** — picks an agent and grants it operator rights over their capital. One on-chain
  grant, revocable.
- **Builder** — reads an agent's logic and track record to decide whether the edge is real.

## 4. Scope

### In
- Live round discovery with auto-detecting venue
- Fair-value model (lognormal touch probability) as the shared pricing spine
- 4 agents with distinct, legible theses
- Paper and live execution behind one interface
- Per-agent public track record: every trade, its reason, its outcome
- Leaderboard
- Proof-of-settlement feed
- Mirror flow (operator grant)

### Out
- Multi-user accounts, auth, real onboarding
- Cross-venue trading (Krexa's breadth is not reproducible in a day)
- Mobile native app
- Anything custodial

## 5. Architecture

```
 oracle price feed ──┐
 (BTC/ETH spot, 1s)  │
                     ├──> fair value ──> agent strategies ──> executor ──> DreamDEX pool
 DreamDEX indexer ────┤    (σ, τ, S, K)    (4 theses)          │            (placeOrder /
 (rounds, book,       │                                        │             placeOrderFor)
  fills, settlement)  │                                        v
                      └──────────────────────────────────> trade store ──> leaderboard / agent pages
```

**Execution modes** — one interface, two backends:
- `paper` (default): prices against the *real* live order book, settles against the *real*
  on-chain resolution. Costs nothing, needs no key, produces a genuine track record.
- `live`: same decisions, sent through the SDK with a funded key.

This is why nothing blocks on the faucet. The key upgrades execution; it does not gate the build.

## 6. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 App Router, React 19 | Server routes keep keys server-side |
| Language | TypeScript strict | |
| Styling | Tailwind v4 + CSS tokens | |
| Chain | `@somnia-chain/markets-sdk` 0.29, `viem` | Official SDK; binary tier for orders |
| Market data | DreamDEX indexer (Hasura GraphQL), no auth | Rounds, book, fills, settlement |
| Price data | Somnia oracle price feed GraphQL | The same feed that settles the markets |
| Store | JSON file behind a `Store` interface | Zero setup; swappable for Postgres |
| Runner | Node loop, in-process or standalone | Ticks every ~2s |

**Chain constants** — Shannon testnet, chain 50312. Collateral tUSDC, 6 decimals. Order price
is probability in millionths. Venue id is **derived at runtime**, never hardcoded: the bot kit's
documented testnet venue is already stale — every market created in the last hour sits on a
different venue.

## 7. The pricing spine

Every agent shares one fair-value model, so their disagreements are about *inputs*, not maths.

For "will spot be ≥ strike at expiry", with spot `S`, strike `K`, time-to-expiry `τ`, and
volatility `σ`, under driftless lognormal motion:

```
P(up) = Φ( ln(S/K) / (σ√τ) )
```

`σ` is estimated from realised volatility of recent oracle ticks. As `τ → 0` the probability
collapses toward 0 or 1 — which is precisely the effect the time-decay agent trades.

An agent acts when `|fair − book price| > threshold`, i.e. when the book disagrees with the
model by more than its edge requirement.

## 8. The agents

| Agent | Thesis | Acts when |
|---|---|---|
| **Clockwork** | Time decay. Near expiry the outcome is nearly determined; books lag. | τ small and book price far from a fair value that is near 0/1 |
| **Driftwood** | Momentum. Short-horizon drift in the oracle persists over one round. | Recent drift points across the strike and book underprices it |
| **Undertow** | Mean reversion. Extreme book prices overshoot. | Book price is extreme but fair value is moderate |
| **Contrary** | Imbalance. A lopsided book is a crowded side. | Resting depth is heavily one-sided against fair value |

Every decision records a human-readable `reason`. A judge should be able to read *why*.

## 9. Screens

| Route | Purpose |
|---|---|
| `/` | Landing: live agent ticker, the three claims, leaderboard, how it works |
| `/agents/[id]` | Track record: PnL curve, every trade with its reason and outcome |
| `/markets` | Trading terminal: live rounds, countdown, book, one-tap Up/Down |
| `/mirror` | The operator grant — what it can and cannot do, and how to revoke |

## 10. Success criteria

- A judge landing cold sees agents trading live within 30 seconds, no setup.
- Every claim on screen is checkable: payout vectors link to the explorer.
- The app degrades honestly — an indexer timeout blanks one panel, never the page.
- Agents have a real track record by submission, accumulated from real rounds.
- Works with no key; works better with one.

## 11. Task breakdown

- [x] T1 PRD
- [x] T2 Pricing: volatility estimation + fair-value model
- [x] T3 Store: trades, positions, PnL
- [x] T4 Agents: 4 strategies over a shared decision interface
- [x] T5 Executor: paper + live behind one interface
- [x] T6 Runner loop: tick, decide, execute, settle
- [x] T7 API: agents, agent detail, leaderboard
- [x] T8 Landing page
- [x] T9 Agent detail page
- [x] T10 Markets terminal (carry over, integrate)
- [x] T11 Mirror / operator-grant flow
- [x] T12 README, demo script, polish
- [ ] T13 Deploy to a public URL (judges must be able to open it)
- [x] T14a Live-path tooling: `npm run doctor` preflight + `npm run smoke` one-order test
- [ ] T14b Fund the demo wallet and flip `EXECUTION_MODE=live`
- [ ] T15 Record the 2–3 minute demo video
