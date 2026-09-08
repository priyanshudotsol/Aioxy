# Build plan

**Submission deadline: 8 September. Today is 7 September.** Roughly one working
day. Everything below is ordered by what most changes the score per hour spent,
and the ordering matters more than the contents.

The governing constraint: [IDEA.md](IDEA.md) says a grant that nothing calls is a
mock. Right now `placeBinaryOrderFor` is never called anywhere in this repo —
`grep -rn placeOrderFor app components lib` returns UI copy and comments only.
That is the whole gap between a demo and a claim.

---

## Step 0 — Prove the selector (30 min, blocks everything)

Nothing else is worth starting until this is answered, because if the binary
pool's gate does not honour `0x5d97c566` the entire product needs a different
shape and we need to know today, not tonight.

1. Wallet A (owner) grants operator = wallet B for selector `0x5d97c566`:
   ```ts
   trader.setOperatorApprovalGlobal({ operator: B, selectors: ["0x5d97c566"], approved: true })
   ```
2. Read it back with `client.isOperatorAuthorized({ owner: A, operator: B, selector: "0x5d97c566" })`.
3. From wallet B, call `placeBinaryOrderFor(A, …)` on a live 4h BTC pool, IOC, one contract.
4. Confirm the fill settles to **A's** vault, not B's.

Also confirm **where the escrow is pulled from** — the owner's ERC20 allowance to
the pool, a funded vault balance, or both. That is the user's real spending cap
and the "your budget is your allowance" feature depends on it (RESEARCH.md §3b).

If the global grant does not reach binary pools, fall back to
`setOperatorApprovalForPool` per pool. Binary pools recycle every round, so that
would mean a signature per round — which breaks "deploy once and it keeps
trading". If that is the outcome, the honest fallback is to grant per-pool for
the next N live rounds in one batch and be explicit that the agent runs for a
session rather than forever.

Extend `scripts/smoke.mjs` rather than writing something new; it already finds a
crossable round and prints the tx hash.

**Do not touch the UI until this prints a fill.**

---

## Step 1 — Fix the grant (30 min)

`lib/delegation.ts` grants the spot selectors. Replace with the binary one:

```ts
export const PLACE_BINARY_ORDER_FOR = "0x5d97c566" as const;  // verified in RESEARCH.md §2
export const AGENT_SELECTORS = [PLACE_BINARY_ORDER_FOR] as const;
```

Keep the spot selectors only if step 0 shows they are also consulted. Update the
Deploy page's selector chips to show what is actually granted — the page
currently advertises `placeOrderFor` / `cancelOrderFor`, which would be a lie.

---

## Step 2 — Make the runner trade per owner (3–4 hours, the product)

This is the work. Three changes, in order:

**2a. Schema.** `lib/store.ts` has `UNIQUE(agentId, marketId)` — one trade per
agent per round, globally. Two owners running the same agent physically cannot
both hold a position. Add an `owner` column and make it
`UNIQUE(agentId, marketId, owner)`. There is already a migration path in the file
to copy.

**2b. Executor.** `lib/executor.ts` sends `placeOrder` on the house key. It needs
to take an `owner` and send `placeBinaryOrderFor(owner, …)`. Paper mode stays as
the fallback and still records an owner, so the dashboard is honest either way.

**2c. Runner.** `lib/runner.ts` decides once per round per agent. It should decide
once, then execute that decision for every owner with an active grant on that
agent. Read grants from the store; skip an owner whose on-chain
`isOperatorAuthorized` is false, so a revoke takes effect on the next tick without
any cooperation from us.

Then `app/api/fleet/route.ts:46` stops inferring ownership from
`deskId + grantedAt` and filters on the real `owner` column.

**Sizing:** scale size with edge, then cap hard (1–5 contracts). Testnet
collateral is scarce and a demo that runs out of tUSDC mid-recording is worse than
a small one. If step 0 confirms the allowance is the escrow ceiling, ask for an
allowance of exactly the user's chosen budget during deploy — that is the
"your budget is your allowance" feature and it is nearly free.

---

## Step 3 — Retarget the strategies (1–2 hours)

The agents were written for 60-second rounds. `τ → 0` collapse and "last third of
the round" do not transfer to a 4-hour window, and the 60s markets have zero
trades anyway.

Minimum viable change: keep the same `Φ(ln(S/K)/(σ√τ))` model, express every
threshold as a fraction of `intervalSec` rather than in absolute seconds so it
works on whatever window is live, and make sure an agent can **close** a position
before expiry —
`placeBinaryOrderFor` with `SELL_YES`/`SELL_NO` — because "opens and closes
positions" is the Krexa loop and the thing a 4-hour window finally makes possible.

Cut from four agents to **two** if time is short. Two agents that demonstrably
open, manage and close beat four that only ever open.

---

## Step 4 — Demo-critical UI only (1–2 hours)

- Dashboard shows **your** positions from `getPortfolio` / `computeOpenPositionsPnL`
  (SDK, RESEARCH.md §5) rather than reconstructing from our log.
- Every trade row shows its reasoning sentence and a tx hash that resolves on the
  explorer.
- Revoke button, prominent, working.
- The comparison table from IDEA.md on the landing page. It is the pitch; put it
  where a judge lands.

---

## Step 5 — Submission (2 hours, non-negotiable)

Worth 15% on presentation alone, and the whole thing scores zero if not submitted.

- **Demo video, 2–3 min.** Script: the custody problem → one grant tx on chain →
  agent places a delegated order, fill lands in the *user's* vault → dashboard
  with reasoning → revoke, and the next tick stands down. Record the chain, not a
  mock.
- **README** — already rewritten; update once execution is live so the status
  section reflects reality.
- **SDK feedback report** (optional, cheap, differentiating): the exported
  selector constants are spot-only and silently wrong for binary pools. That is a
  genuine finding and it demonstrates depth.

---

## Explicitly deferred

| Idea | Why not now |
|---|---|
| Market making instead of taking | Right on the merits — the venue's problem is nobody makes liquidity, and a taker on a coin-flip binary pays the spread. Wrong on the clock. Put it in the video as the future vision. |
| Builder fees / operator registration | Real revenue, real code. Talk about it, do not build it. |
| `policy` contract on `registerOperator` | Strongest possible safety story. Days, not hours. |
| Agent marketplace / third-party authors | Needs supply we cannot manufacture overnight. |

## If time runs out

Ship in this order and stop wherever the clock stops: **step 0 → 1 → 2 → 5**.
A working delegated trade with an ugly dashboard and a good video scores far
higher than a beautiful dashboard over a grant that nothing calls.
