# Aioxy — the idea

> **Read this before building anything.** If a change does not serve the one
> sentence below, it is not in scope. Facts cited here are verified in
> [RESEARCH.md](RESEARCH.md); the plan to get there is [BUILD.md](BUILD.md).

## One sentence

**Deploy an AI trading agent onto DreamDEX Event Contracts: fund it, and it
trades and publishes every decision — with a key you can always recover.**

## The model, and what changed

**Decision, 2026-09-07:** chunk 0 proved that operator delegation is unavailable
on Event Contracts (RESEARCH.md §2). The original pitch — "admitted to trade,
never funded", using the venue's `OperatorPermissionsRegistry` — is not
implementable. With one day to the deadline we took the working path:

> **Each user gets their own agent wallet. They fund it. It trades autonomously
> on Event Contracts and publishes every decision it makes.**

This is the Krexa shape, and it works today: the agent wallet is the trader, so
it uses the `placeBinaryOrder` self-send path that chunk 0 proved functional.

### What we can still honestly claim

Being a straight Krexa clone is a weak position, so lean on the three things that
are true here and cheap to build:

**1. Your agent key is yours to recover.** Derive it deterministically from a
signature only the user's wallet can produce. If we disappear tomorrow, they
re-derive the key and sweep the funds — no support ticket, no cooperation from
us. Most competitors cannot say this. Say it, and show the derivation.

**2. Only what you fund is ever at risk.** The agent wallet holds exactly what
the user put in it. That is the budget, and it is enforced by the balance itself.

**3. Payouts go home, not into the agent.** Settle winnings back to the user's
main wallet rather than letting a balance pile up in the agent. The less that
sits in the agent wallet, the smaller the trust surface.

### What we must NOT claim any more

The landing page currently says *"They cannot take your money"* and shows a
selector-scoping table. **That is now false and has to go.** Funding an agent
wallet is a custody event. Say plainly: *the agent holds only what you fund it
with, you can withdraw any time, and your key is recoverable.* Overclaiming here
is the one thing that would actually damage us in judging.

## Who this is for

Someone who wants automated exposure to prediction markets and is not willing to
wire money to a stranger's bot. Today they have no option — the category is
custodial by default. We are the first non-custodial one.

## What we are honest about

Non-custody protects you from **theft**, not from **loss**. An agent cannot take
your money; it can absolutely lose it. Say this in the product, in the README and
in the demo. Every peer in this category leads with "+22% in 48h"; leading
instead with a real risk statement is differentiation, not weakness — and the
research says the wound in this category is trust, not returns.

Two things that flatter any track record we show, to be stated on the page:
1. **Selection** — agents trade only when they think they see edge, so a
   conditional win rate exceeds 50% by construction.
2. **Paper fills are optimistic** — no latency, no slippage, no queue position.
   Live will be worse than paper, never better.

## Three findings that shape the build

**1. The market schedule rotates, so never hardcode an interval.** 5m, 15m and 1h
markets all exist. 15-minute BTC/ETH rounds were historically the venue's
highest-volume binaries (150–217 trades each), but are not being created right
now; today the live flow is at 1h/4h/1d. **The agent picks up whatever is live
and has a book** — the same runtime derivation we already do for the venue id,
which also went stale. ([RESEARCH.md §1](RESEARCH.md))

The window still matters, but for a reason we had backwards. It is not about
strategy — it is about **exit latency**. A user who wants out of an open position
either crosses the book or waits for expiry, so the round length is the worst-case
time to be back in cash. 15 minutes is a good answer. A day is not. Prefer the
shortest window that actually has depth.

**2. The user should sign exactly once.** `redeemFor` lets us relay a pre-signed
settlement so we pay the gas and the payout goes to the owner. Combined with the
operator grant, a user's entire on-chain footprint is one grant transaction.
Against a competitor that makes you bridge, fund and withdraw, that is a better
UX *and* a safer one — a combination that usually does not exist.

**3. There is a native revenue model.** Builder fees (`approveBuilder` +
`builderFeeBpsTimes1k`) and operator routing attribution are protocol features,
not something we bolt on. We do not need to ship them to talk about them, and
they make "sustainable product" a mechanism rather than a hope.

## What a deployed agent actually does

**Does it keep trading after I deploy it?**
Yes. Once the agent wallet is funded it trades round after round on its own key,
with no further signature from the user. This is why we took this path — it is
the one shape that actually delivers "deploy it and it keeps running" on Event
Contracts today.

Two mechanics to get right: binary pools **recycle every round**, so the agent
must `approve` tUSDC to each new pool before trading it (its own funds, its own
key — no user involvement). And the agent wallet needs **STT for gas**; top it up
from a house wallet so the user only ever sends tUSDC.

**Can I stop and take my money out whenever I want?**
Stopping: yes — pause or delete the agent, and it stops on the next tick.

Withdrawing: free collateral in the agent wallet can be swept back to the user's
main wallet at any time. The honest caveat is unchanged — **an open position in
an unexpired round is not cash**. Exiting early means selling into the book; if
there is no bid, the user waits for expiry. That is why round length matters:
it is the worst-case wait to be fully in cash.

**Can the agent size its own positions?**
Yes, scaled by edge and capped by risk profile. The hard ceiling is the agent
wallet balance — it can only ever lose what was funded into it, which is the
budget, enforced by arithmetic rather than by a promise.

**What stops you from running off with my money?**
The honest answer, and it must be on the page: the agent wallet is a custody
relationship, exactly as it is at every competitor. What we add is that the key
is **derived from your own signature**, so you can re-derive it and sweep the
funds without us — and that payouts settle back to your main wallet rather than
accumulating in the agent.

## Scope

**In:**
- Landing that makes the non-custodial claim and proves it
- Connect → pick agent + risk → fund the agent wallet → it trades
- Dashboard: your positions, your P&L, every decision with its reasoning
- Revoke, working, instant
- Agents that open *and close* positions on whichever BTC/ETH rounds are live
- Withdraw / sweep back to the user's main wallet, working

**Out — say no to these:**
- Manual trading UI. If you trade by hand, we are not the product.
- A public leaderboard of house agents. Ranking bots nobody deployed is a
  marketplace we do not have supply for.
- More than a handful of agents. Depth over breadth.
- Market making. Right on the merits, wrong on the clock — see BUILD.md.
- Hardcoding any interval. Trade what is live and has depth; prefer the
  shortest window with real depth, for exit latency.

## How this scores

| Criterion | % | Our claim |
|---|---|---|
| Innovation & Originality | 20 | Recoverable agent keys and payouts that settle home, in a category where the agent wallet is a black box. Weaker than the original thesis — be honest rather than overclaim. |
| Technical Implementation | 25 | Correct use of Event Contract mechanics: per-pool allowance, recycled pools, floating strikes, oracle-settled resolution, relayed `redeemFor`. Plus an SDK/venue feedback report — the exported operator selectors are spot-only and `placeBinaryOrderFor` is unreachable from an EOA, which is worth reporting. |
| UX & Design | 20 | Fund once, it runs. Withdraw any time. Every decision shown with its reasoning. |
| Business & Ecosystem Impact | 20 | Agents manufacture the persistent flow the venue lacks, and builder fees/routing attribution are a native revenue path. |
| Presentation & Demo | 15 | A live grant tx, a live delegated fill, and a revoke — on chain, on camera, in under three minutes. |

## The line that decides everything

**A grant that nothing calls is a mock.** The single highest-value work in this
repo is making `placeBinaryOrderFor` fire against a real user's account. Until
that lands, every claim on the landing page is a promise. After it lands, all of
them are demonstrable. Prioritise accordingly.
