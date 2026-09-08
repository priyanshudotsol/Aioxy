# Research — verified facts

Everything here was checked against the live indexer or the installed SDK on
**2026-09-07**, not recalled from memory. Each claim says how to re-check it.
When a decision in [IDEA.md](IDEA.md) or [BUILD.md](BUILD.md) rests on a fact,
it rests on one of these.

---

## 1. Full venue census — 15m carries the most flow, 1h/4h are live

**This is a complete census** of every binary market on the venue (~87,000
markets, ~183,000 trades), not a sample. Two earlier versions of this section
were wrong because they sampled recent markets; both corrections are noted below
so the mistake is not repeated.

| interval | markets | total trades | trades/market | newest |
|---:|---:|---:|---:|---|
| 60s | 61,363 | 2,539 | 0.04 | 0.1d ago |
| 300s (5m) | 14,992 | 7,962 | 0.5 | now |
| **900s (15m)** | 7,913 | **57,028** | 7.2 | 0.3d ago (BOTNAV) |
| 1800s (30m) | 0 | — | — | never existed |
| **3600s (1h)** | 2,159 | **51,208** | 23.7 | **live** |
| **14400s (4h)** | 555 | 43,069 | 77.6 | **live** |
| 86400s (1d) | 92 | 21,275 | 231.2 | **live** |
| 3888000s (45d) | 2 | 46 | 23.0 | live |

Two different orderings, and both matter:

- **By total flow:** 15m (57k) > 1h (51k) > 4h (43k) > 1d (21k) > 5m (8k) > 60s (2.5k).
  The 15-minute series is the single largest pool of trading this venue has ever
  seen. It is not currently being created for BTC/ETH.
- **By depth per market:** 1d (231) > 4h (78) > 1h (24) > 15m (7.2) > 5m (0.5) > 60s (0.04).
  Longer windows concentrate more flow into each book.

**Corrections to earlier versions of this file:**
1. "There are no 15-minute markets" — false. There are 7,913 of them and they
   carry more trades than any other interval.
2. "317 sixty-second markets produced zero trades" — a sampling artifact. Across
   all 61,363 of them there are 2,539 trades. At 0.04 trades per market that end
   is still effectively dead, but it is not literally zero.

Both errors came from `order_by: {expiry: desc}, limit: 400`, which returns only
the newest markets and is dominated by whatever series is currently spamming.
**Query per interval, not a global recent slice.**

```bash
# per-interval census — the query that produced the table above
for iv in 60 300 900 1800 3600 14400 86400; do
  curl -s -X POST https://dev.smk.somnia.host/v1/graphql -H 'content-type: application/json' \
    -d "{\"query\":\"{ Market(where:{marketType:{_eq:\\\"BINARY\\\"}, intervalSec:{_eq:\\\"$iv\\\"}}, order_by:{expiry:desc}, limit:1000){ expiry tradeCount asset } }\"}"
done   # page with offset until a page returns < 1000
```

### What this forces

- **Never hardcode an interval.** The venue id already rotates (`activeVenueId()`
  derives it at runtime because the documented one went stale); the market
  schedule rotates too. 15m was the flagship and is currently paused for BTC/ETH.
- **Trade what is live and has depth.** Today that is 1h/4h/1d. If 15m BTC/ETH
  comes back it becomes the best target on both flow and exit latency.
- Our `lib/indexer.ts` filter (`intervalSec <= 86400`) is the right shape. Keep it
  broad and let depth decide.
- **Strategies must not assume a window length.** Express thresholds as a fraction
  of `intervalSec`, never in absolute seconds — the same agent has to work on a
  15-minute and a 4-hour round.
- Short windows matter for **exit latency**, not strategy: the round length is the
  worst-case wait for a user to be back in cash. See §3c.

## 2. ⛔ Operator delegation DOES NOT WORK on Event Contracts

**Chunk 0 ran on 2026-09-07 and the gate failed. This invalidates the original
product thesis.** Evidence, in the order it was gathered:

**a. The address book has no operator registry.**
`SOMNIA_TESTNET_ADDRESSES` contains `binaryModule, binaryPoolBeacon,
binaryPoolImpl, binarySettlement, clobFactory, collateral, collateralRouter,
marketCreator, marketCreatorFactory, marketsCore, oracleHub, testUsdc, lend` —
**no `operatorPermissionsRegistry`**. The SDK refuses the grant outright:

```
@somnia-chain/markets-sdk: an operator grant — needs operatorRegistry
or addresses.operatorPermissionsRegistry
```

**b. Binary pools do not expose the registry getter.**
`getOperatorPermissionsRegistry()` reverts on a binary pool. It is a *SpotPool*
function. The `OperatorPermissionsRegistry` — and the "1,000+ grants across 61
owners" the old README cited — belongs to **spot markets, not Event Contracts.**

**c. `placeBinaryOrderFor` is closed to EOAs entirely.**
The decisive test: have the **owner** call `placeBinaryOrderFor(self, …)`, where
authorization cannot possibly be the problem.

| call | caller | result |
|---|---|---|
| `placeBinaryOrder(…)` (self-send) | owner EOA | `ERC20InsufficientAllowance` — **authorized**, just needs approval |
| `placeBinaryOrderFor(owner, …)` | owner EOA | `OnlyApprovedContracts()` (`0x3fb0ba2e`) |
| `placeBinaryOrderFor(owner, …)` | operator EOA | `OnlyApprovedContracts()` |

The gate is on **who is calling**, not on whether they are authorised. Only
venue-whitelisted *contracts* may call it. No grant an end user can sign will
ever admit our operator EOA, because there is no grant to sign.

**d. The binary module offers no delegated order placement.**
`binaryModuleWriteAbi` is `redeem`, `redeemMany`, `redeemFor`, `mintCompleteSet`,
`mergeCompleteSet`, `finalizeMarket`, `releasePool`, `syncSettlement`,
`pokeOracle`. Settlement only. `redeemFor` remains the *one* delegated action on
Event Contracts, and it is EIP-712 signature-based.

### Consequence

**An agent cannot place orders on a user's behalf on Event Contracts.** The
original pitch — "admitted to trade, never funded" using the venue's own operator
registry — is not implementable here. Anything built on it would be a mock.

Reproduce: `npm run prove`.

---

## 2b. ✅ What the same test DID prove

Not all bad news. `ERC20InsufficientAllowance` on the self-send path answers Q3
cleanly:

**Escrow is pulled from the trader's ERC20 allowance to the pool.** Whoever
places the order must have approved tUSDC to that pool, and `approve` is
`msg.sender`-scoped. So "your budget is your allowance" is confirmed as a real,
on-chain, user-controlled spending cap — it just applies to whichever account is
doing the trading.

Also confirmed working: the self-send path (`placeBinaryOrder`) is fine, the
venue has live books, and the ORDER_KIND enum is `{BUY_YES:0, SELL_YES:1,
BUY_NO:2, SELL_NO:3}`.

## 3. Opening, closing and settling are all delegable

The full agent lifecycle works without custody:

| Step | Call | Who signs | Who pays gas |
|---|---|---|---|
| Open | `placeBinaryOrderFor(owner, BUY_YES\|BUY_NO, …)` | agent | agent |
| Close early | `placeBinaryOrderFor(owner, SELL_YES\|SELL_NO, …)` | agent | agent |
| Settle at expiry | `redeemFor(authorization)` | owner, once, EIP-712 | **agent** |

Closing a binary position is not a "cancel" — it is an opposing order, so the
one `placeBinaryOrderFor` grant covers both open and close. `cancelOrder` is
only for pulling an unfilled resting order, and has no `…For` variant, so an
agent should trade IOC or accept that the owner is the only one who can cancel.

`redeemFor` is a **relayer path**: the owner pre-signs a `RedeemAuthorization`
(EIP-712 — marketId, outcomeIdx, amount, nonce, deadline), and anyone can submit
it. From `dist/trade.d.ts`:

> submit a position owner's pre-signed RedeemAuthorization so THEY pay the gas
> while the OWNER receives the payout

This is the piece that makes the UX competitive with a funded-agent product: the
user needs STT for exactly one transaction (the grant), and never again.

---

## 3b. The spending cap — the one real gap in "cannot take your money"

The operator grant scopes **which functions** an agent may call. It does **not**
scope **how much** it may spend. A grant admits the agent to `placeBinaryOrderFor`
for any size, on any live pool, indefinitely.

So "it cannot take your money" is precisely true — the agent cannot withdraw,
transfer or redirect a payout, and fills settle to the owner. But "it cannot spend
your money" is enforced by **our code**, not by the chain. A judge who asks about
this deserves a straight answer, and the product must not overclaim.

**The on-chain cap that does exist: the owner's own ERC20 allowance to the pool.**
`placeBinaryOrder` carries `autoApprove` ("approve the escrow token to the pool if
allowance is short") — but ERC20 `approve` is `msg.sender`-scoped, so an operator
calling `placeBinaryOrderFor` cannot raise the *owner's* allowance. The owner sets
it, the owner alone can raise it, and the agent can never escrow more collateral
than it covers.

That turns a limitation into a feature: **your budget is your allowance.** Ask for
an approval of exactly the amount the user wants at risk, and the ceiling is
enforced by the token contract rather than by our promise. Raising the budget is a
second, deliberate signature.

Verify in step 0: whether binary escrow pulls from the owner's wallet allowance,
from a funded vault balance (`getVaultBalance` / `withdrawVault` exist), or both.
Whichever it is, that is the user's real risk dial and the UI should say so.

---

## 3c. Stopping, and getting money out

Three distinct things the product must not conflate:

| User intent | Mechanism | Speed |
|---|---|---|
| "Stop trading for me" | Revoke the grant on-chain | Immediate, unilateral, needs no cooperation from us |
| "Give me back my free collateral" | It was never ours. `withdrawVault`, or it is already in their wallet | Immediate |
| "Get me out of an open position" | Sell the outcome tokens on the book, or wait for expiry and redeem | **Not immediate** |

The third row is the honest one. An open position in an unexpired round is not
cash. Exiting early means crossing the book, which needs a counterparty; otherwise
the user waits for expiry.

**This is the real argument for short windows.** On a 15-minute round the worst-case
wait to be fully in cash is 15 minutes. On a 1-day round it is a day. Exit latency,
not volatility, is what should drive the interval the agent trades — which is a
better reason than any strategy argument we had before.

---

## 4. There is a native revenue model

Two independent mechanisms, both protocol-level:

**Builder fees.** `PlaceOrderParams` carries `builder` and `builderFeeBpsTimes1k`.
The trader opts a builder in via `approveBuilder(address, maxFeeBpsTimes1k)` and
every order routed with that builder code pays us, capped by
`getMaxBuilderFeeBpsTimes1k()`. This is on the binary pool ABI directly.

**Routing attribution.** `operatorId` (uint32) and `venueId` (bytes32) are part
of the signed redeem struct and the order path — the venue tracks which operator
generated which flow. `registerOperator(feeRecipient, enabled, policy, context)`
in `marketsCoreWriteAbi` returns an `operatorId`, and venues carry
`makerFeeBps` / `takerFeeBps` / `routingFeeBps` / `settlementFeeBps` /
`maxBuilderFeeBps`.

Neither needs to ship for the demo. Both turn "Business & Ecosystem Impact"
(20% of the score) from a claim into a mechanism we can point at.

There is also a `policy` address on `registerOperator` — a programmable
constraint contract on what an operator may do. Unexplored; potentially the
strongest version of the safety story, but not a one-day build.

---

## 5. Portfolio reads are already built

`dist/binary/portfolio.d.ts` exports `getPortfolio`, `getOutcomeBalances`,
`computeOpenPositionsPnL`, `getVaultBalance`. We do not need to reconstruct a
user's positions from our own trade log — the SDK will tell us what they hold
and what it is worth. Our SQLite record becomes the *reasoning* log, and the
chain stays the source of truth for balances.

---

## 6. Krexa, for reference

Sources: [krexa.xyz](https://www.krexa.xyz/) (JS-rendered, marketing copy only),
[@krexa_xyz](https://x.com/krexa_xyz).

Tagline "Deploy AI Trading Agents". No-code: pick a strategy, deploy, **fund the
agent with USDC**, and it watches markets, opens and closes positions and manages
risk autonomously on Polymarket-style prediction markets. Performance is
front-and-centre ("agents up 22% in 48h", individual trades at +194%).

The thing to notice: **funding the agent is a custody event.** The user moves
money to something the agent controls. That is the industry-standard shape, and
it is the one thing DreamDEX's operator registry lets us not do.

---

## 6b. One pool serves a SERIES of markets, not one round

Corrects an assumption used earlier in this file and in the build. The same
`binaryPoolAddress` is shared by many consecutive markets:

```
pool 0x06b0c35e…  → market 0x…46ae, market 0x…46b3, …
```

Consequences:
- **Approval is per series, not per round.** One `approve` per pool covers many
  rounds. Cheaper than feared — but the allowance also *outlives* the round, so
  it is not the safety bound it looked like. The real ceiling on an agent's
  losses is its wallet balance.
- **Position lookups must check every market the pool has issued**, not just the
  newest. Querying `Market(where:{binaryPoolAddress}, limit:1)` returns the wrong
  token ids and silently reports "no position" — this exact bug appeared in
  `scripts/verify.mjs` and made a real 4-contract position invisible.

---

## 7. The indexer does not surface binary fills — read positions from chain

Chunk 2 placed a real, confirmed fill (tx `0x2acbe6f…`, 832k gas, 8 logs,
collateral transferred out of the agent). The indexer's `Fill` table shows
**zero** fills for that market. The rows it does return are 18-decimal spot
fills, not 6-decimal binary ones.

**Do not verify a binary trade through the indexer, and do not build the
dashboard on it.** A mined transaction is not proof either: an IOC that fails to
cross also succeeds.

The honest proof is the position itself — an ERC-6909 balance on the outcome-token
singleton:

```ts
const singleton = await pub.readContract({ address: pool, abi: [outcomeToken], functionName: "outcomeToken" });
// → 0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9 on Shannon
const held = await pub.readContract({
  address: singleton, abi: erc6909, functionName: "balanceOf",
  args: [agentAddress, BigInt(market.yesTokenId)],
});
```

`market.yesTokenId` / `noTokenId` come from the indexer's Market row. Note the
pool exposes `outcomeToken()` but **`yesId()` and `noId()` revert** — take the
ids from the indexer, the singleton from the pool.

Chunk 7's dashboard must use this path, or the SDK's `getOutcomeBalances` /
`getPortfolio`, which do the same thing.

---

## Open questions — resolve by testing, not by reasoning

1. Does the binary pool's gate check `0x5d97c566` against the
   `OperatorPermissionsRegistry`? Everything depends on this. One real tx settles it.
2. Does a *global* grant reach binary pools, or is `setOperatorApprovalForPool`
   required per pool? Global is what our UI uses; the SDK docs describe global in
   terms of the spot pool registry and `isRegistered(pool)`.
3. Is `nonce` for `signRedeemAuth` readable on-chain, or do we track it ourselves?
4. What is `BOTNAV`? A third asset nobody told us about.
