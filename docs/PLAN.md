# Build plan — chunks with verification gates

> ## The rule
>
> **A task is not done until a transaction on Somnia proves it.** Not when a gate
> returns true, not when a row exists in our database. Three gates in this build
> passed while proving less than they claimed — a "fill" that was an uncrossed
> IOC, a fan-out asserted on rows the gate itself inserted, and a paper-mode run
> reported as if it had traded.
>
> `npm run verify:chain` is the only thing that may declare a chunk done. It
> names the tx hash behind every claim, or it fails.
>
> **There is no paper mode.** It was removed on 2026-09-07: `lib/executor.ts`
> deleted, and the runner now refuses to start without a key rather than
> accumulating a record that never touched a chain.

Deadline **8 Sep**. Each chunk is small, has an **objective** done-check you can
run, and a **dots check** naming which claim in [IDEA.md](IDEA.md) it makes true.
Do not start a chunk until the previous one's gate passes.

Tick the box only when the gate passes, not when the code is written.

| # | Chunk | Est | Gate |
|---|---|---|---|
| 0 | Prove the primitive | — | ✅ ran — **failed**, plan revised |
| 1 | Agent wallet: derive, store, fund | 60m | ✅ **on-chain proven** |
| 2 | Agent trades its own funds | 60m | ✅ **on-chain proven** |
| 3 | Store: owner + agent columns | 30m | ✅ **on-chain proven** |
| 4 | Runner loops funded agents | 60m | ✅ **on-chain proven** |
| 5 | Settle payouts home | 45m | ✅ **on-chain proven** |
| 6 | Deploy flow UI | 60m | ✅ done |
| 7 | Dashboard truth + withdraw | 45m | ✅ **on-chain proven** |
| 8 | Survives deployment | 30m | ☐ |
| 9 | Video + README + feedback report | 2h | ☐ |

**If the clock runs out, ship 1 → 2 → 3 → 4 → 9.** A delegated trade with an
ugly UI and a good video beats a beautiful UI over a grant that calls nothing.

---

## Chunk 0 — Prove the primitive ✅ RAN, GATE FAILED, PLAN REVISED

Ran 2026-09-07 (`npm run prove`). Result: **operator delegation is unavailable on
Event Contracts** — see RESEARCH.md §2. `placeBinaryOrderFor` reverts
`OnlyApprovedContracts()` even when the owner calls it for themselves, there is no
`operatorPermissionsRegistry` in the address book, and binary pools revert on the
registry getter.

It also proved two things we now depend on:
- `placeBinaryOrder` **self-send works** (reverts only with `ERC20InsufficientAllowance`)
- **Escrow comes from the trader's ERC20 allowance to the pool**

Decision: build the **agent-wallet-per-user** model (IDEA.md). Chunks below are
rewritten for it. The original chunks 1–5 are void.

---

## Chunk 1 — Agent wallet: derive, store, fund ✅ GATE PASSED

- Derive each user's agent key deterministically from a signature only their
  wallet can produce, so **the user can always re-derive and sweep it**. Store the
  address (and, for the server to trade, the key) against the owner.
- Fund flow: user sends tUSDC to the agent address. House wallet tops up STT for
  gas so the user never needs it.

**Gate:** `npm run gate1` — passed 2026-09-07, 9/9 checks.

Built: `lib/agentkey.ts` (derivation), `lib/vault.ts` (AES-256-GCM at rest),
`agents` table in `lib/store.ts`, `app/api/agent/route.ts` (GET + POST).

- The client sends the **signature**, never the key; the server derives it the
  same way the owner would and verifies the signature against the claimed owner,
  so nobody can register a wallet for someone else's address.
- Keys are sealed with `AGENT_KEY_SECRET` before they touch SQLite.
- The house wallet auto-tops the agent with 0.2 STT, so a user only sends tUSDC.

**Gotcha for later:** the store is a `globalThis` singleton, so a schema change
needs a dev-server restart — hot-reload keeps the old handle and every query
500s.

---

## Chunk 2 — Agent trades its own funds ✅ GATE PASSED

- Executor calls `placeBinaryOrder` (self-send) from the agent key.
- **`approve` tUSDC to each pool before first trade on it** — pools recycle every
  round, so this is per-round, cached per pool address.
- Enforce the risk profile's size cap.

**Gate:** `npm run gate2` — passed 2026-09-07, 6/6.

Built: `lib/agenttrader.ts` (self-send `placeBinaryOrder`, per-pool approval
cache, `RISK` profiles, `sizeFor`), `app/api/agent/trade/route.ts`.

Proof: agent `0x50332a8A…` holds outcome tokens on chain, its collateral fell,
and the **owner's balance never moved**.

**The gate was too weak on the first pass and had to be strengthened.** It
trusted the API's `filled` flag, which only reflects that the tx mined — but an
IOC that fails to cross also mines successfully. It now asserts the agent's
ERC-6909 position balance actually increased. See RESEARCH.md §7: the indexer
does not surface binary fills at all, so chain reads are the only honest proof.

---

## Chunk 3 — Store: owner + agent columns ✅ GATE PASSED

Add `owner` and `agentAddress` to `trades`; change `UNIQUE(agentId, marketId)` to
`UNIQUE(agentId, marketId, owner)`. Migrate the ~106 existing rows to the house
address rather than dropping them.

**Gate:** `npm run gate3` — passed 2026-09-07, 9/9. All 110 existing rows
survived and were assigned to `house`.

**Trap worth remembering:** the new `UNIQUE(agentId, marketId, owner)` index
cannot live in the main `CREATE TABLE` exec. On an existing database that block
runs *before* the `ALTER TABLE` that adds `owner`, so it fails with
`no such column: owner` and takes the entire schema exec — and the migration
itself — down with it. Owner-keyed indexes are created in `migrateSchema()`,
after the ALTERs. Schema changes also need a dev-server restart (the store is a
`globalThis` singleton).

---

## Chunk 4 — Runner loops over funded agents ⚠️ PARTIAL

Decide once per agent per round, execute for every user whose agent wallet has a
balance. Skip paused agents and any wallet below a minimum balance.

**Gate:** `npm run verify:chain` — **on-chain proven 2026-09-07.**

The runner placed live trades from an agent wallet and fanned one decision out
to two owners, both confirmed on chain:

| owner | tx | result |
|---|---|---|
| `0x473b038bb3…` | [`0xa9c9609b…`](https://shannon-explorer.somnia.network/tx/0xa9c9609b56725d534764eea6bf8429bd314c9e9bc79ed2d2c3f1824b027009e8) | success · block 482136641 · gas 830,728 · 8 logs |
| `0x11ve000000…` | [`0x9de2207b…`](https://shannon-explorer.somnia.network/tx/0x9de2207b9cf6a32f28ba547d680370aa352688412dcfaaf9bb388457dadb4369) | success · block 482136673 · gas 430,728 · 8 logs |

Both `from` the agent wallet `0x50332a8a…`, both selector `0x718c2d4d`
(`placeBinaryOrder`), same decision — DOWN x3 @0.155 — differing only by owner.

An earlier version of this section claimed the gate passed when it had run in
paper mode only, where `filled = true` short-circuits before any chain call.
That claim was wrong and is the reason for the rule at the top of this file.

### What is actually proven

- The fan-out logic: one decision per desk, executed per owner, verified against
  rows the RUNNER produced (3 desks x 2 owners, each desk/round pair reaching
  two distinct owners).
- Pause isolation: a paused owner got zero new trades while the other kept
  trading.
- Per-owner dedup, `maxConcurrent`, and the unfunded-wallet guard all fired,
  visible as named skip reasons.

### What is NOT yet proven

**The live branch of `tradeFor` has never executed.** In paper mode the runner
sets `filled = true` and never calls `openKey` or `agentTake`. The gate's
synthetic agents also carried `sealedKey: "sealed"`, which `openKey` rejects — in
live mode they would have produced nothing at all.

So chunk 4's stated gate ("two funded agent wallets both take a position in one
round") is **not met**: no position was taken on chain by the runner.

`agentTake` itself is proven live by chunk 2, and `openKey` by the vault
round-trip, so what is unverified is the wiring between them.

Set up to close it: `EXECUTION_MODE=live`, two genuinely funded agent wallets
(clockwork 24.3 tUSDC, driftwood 15 tUSDC), and a watcher waiting for the first
live trade. It is blocked on the venue producing a signal — recent ticks show
`decisions: 0, no-depth: 8, no-signal: 8`, which is a market state, not a bug.

Built: `tradeFor()` in `lib/runner.ts` (decide once per desk, execute per owner),
`store.openPositionCount`, and `app/api/tick` (also chunk 8's cron entry point).

Risk now gates *whether* to act, not only size: an agent below its profile's
`minEdge` declines, and `maxConcurrent` is counted per owner over unsettled rows.

**The first version of this gate was dishonest** — it asserted database
semantics on rows the gate itself inserted, never proving the runner fans out.
Rewritten to drive `/api/tick` and assert what the RUNNER produced: one decision
reaching two owners in the same round, and a paused owner getting zero new
trades while the other keeps trading.

**Diagnostics were missing and cost real time.** The runner traded nothing and
said nothing about why. `status.lastTick` now reports
`{rounds, tradeable, fundedAgents, decisions, skipped}` with named skip reasons
(`no-depth`, `no-signal`, `edge-below-risk-floor`, `max-concurrent`,
`agent-unfunded`, `already-positioned`, `key-unreadable`, `not-filled`). That
turned "nothing happens" into "the deciding desks had no registered agents" in
one tick.

**Behaviour change:** the runner no longer writes `house` trades. With no
registered agents it does nothing — correct for the product, but it means an
empty database now stays empty until someone deploys an agent.

---

## Chunk 5 — Settle payouts home ✅ ON-CHAIN PROVEN

At expiry, redeem and sweep proceeds to the user's **main** wallet rather than
letting a balance accumulate in the agent. `redeemFor` / `redeem` from
`binaryModuleWriteAbi`.

**Gate:** `npm run gate5` + `npm run verify:chain`. Three transactions:

| action | tx | result |
|---|---|---|
| sweep home | [`0x6530dd69…`](https://shannon-explorer.somnia.network/tx/0x6530dd69d22489dfc60b6a81013cb8ae25e12db547b0e7b91fabef409d861d26) | agent 23.647 → 22.647, owner 460 → 461 |
| ERC-6909 setOperator | [`0xd57e6e90…`](https://shannon-explorer.somnia.network/tx/0xd57e6e90c593bc5b365a0de3778a5a341c61cd1316ff250532d2f55decd11429) | success |
| redeem | [`0x759564d0…`](https://shannon-explorer.somnia.network/tx/0x759564d0056ebbb82eff31e0ac1d9f34fbddb35242dbb770835be8ed79314b2a) | success · gas 127,491 · 2 logs |

Built: `lib/settle.ts` (`redeemAndSweep`, `sweepHome`), `app/api/agent/withdraw`,
`redeemTx`/`sweepTx` columns, and redemption wired into `settlePending()`.

**Redemption must go DIRECT to `BinarySettlement`, not through
`BinaryMarketsModule`.** The module path reverts `InsufficientPermission()`
(`0xdeda9030`) for an ordinary EOA — the same family of restriction that made
`placeBinaryOrderFor` unreachable. `BinarySettlement.redeem(outcomeId, amount, to)`
accepts the position holder directly, after a one-time
`setOperator(settlement, true)` on the ERC-6909 singleton.

**Not yet proven:** a *winning* payout. All five live trades so far lost — every
agent chose DOWN and UP won. The redeem mechanism executes on chain (released 0
from a losing side, as expected); the profit path awaits a winning round.

---

## Chunk 6 — Deploy flow UI ✅ DONE

> Connect → pick agent + risk → fund the agent wallet → running

Risk maps to real parameters, not labels:

| Risk | Min edge to act | Size per trade | Max concurrent |
|---|---|---|---|
| Low | 0.10 | 5% of balance | 1 |
| Medium | 0.06 | 10% of balance | 2 |
| High | 0.03 | 20% of balance | 4 |

**Do not let the user pick a timeframe** — derive live intervals with depth at
runtime (RESEARCH.md §1). And **remove the "cannot take your money" claim and the
selector table from the landing page** — they are false under this model.

**Gate:** build clean, all routes 200, and the false claims are gone from the
served HTML (`cannot take your money`, `placeOrderFor`,
`OperatorPermissionsRegistry`, `Non-custodial` → **0 occurrences**).

Rewritten for the agent-wallet model:

- **`components/Deploy.tsx`** — five steps: connect → desk → risk → derive →
  fund. The whole delegation flow (grant selectors, revoke) is gone; it
  described a mechanism that does not exist.
- **`components/Dashboard.tsx`** — agent wallets with live on-chain balances,
  per-trade reasoning, and three transaction links per row (trade / redeem /
  paid home). Withdraw is authorised by the OWNER'S SIGNATURE, not the internal
  secret — a browser must never hold a server credential.
- **`app/api/fleet`** — rebuilt on `agents` + `trades`; balances read from chain.
- **`app/api/desks`** — serves the SAME `RISK` constants the runner decides with,
  so the UI cannot describe thresholds that differ from the ones in force.
- **`app/api/config`** — the collateral address the funding step needs.
- Deleted `app/api/delegation/*` and `app/api/operator` — dead with the model.

**No timeframe picker**, deliberately: the agent takes whatever is live and has
depth (RESEARCH.md §1), so a user cannot pick a window that is not being created
and end up with an agent that never trades.

**The custody claim is now honest.** The deploy panel states plainly under
"What is not": *this is not non-custodial — we hold a copy of the key to trade
while you are away*, and *an agent cannot steal from you, but it can absolutely
lose*.

---

## Chunk 7 — Dashboard truth + withdraw ✅ ON-CHAIN PROVEN

Positions from `getPortfolio` / `computeOpenPositionsPnL`. Every trade row shows
its reasoning and a resolving tx link. A working **withdraw/sweep** button.

**Gate:** `npm run gate7` — 12/12, 2026-09-07.

Withdraw tx: [`0x55993558…`](https://shannon-explorer.somnia.network/tx/0x559935583c2f60c32ce925c90ba5a8d26694e9b227d9d1850b621dad7b7d3a6e)
· block 482172172 · agent 13.929 → 12.929 · **owner 461 → 462**.

The gate calls the endpoint the way the BROWSER does — an owner signature and
**no internal secret**. That matters: a page must never hold a server
credential, so a withdraw that only worked with the secret would not work in
production at all.

Refusals proven, not assumed: unsigned → 401, forged signature → 401, stale
nonce → 401 (replay guard, 5-minute window).

Also asserted: the dashboard's balance equals a direct chain read (`api 13.929 ·
chain 13.929`), it updates after the sweep, and every activity row carries both
a transaction hash and its reasoning.

---

## Chunk 8 — Survives deployment

`instrumentation.ts` runs a 3s `setInterval` that will not survive serverless —
deploy as-is and agents silently stop. Expose `runner.tick()` behind
`POST /api/tick` with a shared secret; Vercel Cron every minute.

**Gate:** with nothing running locally, the deployed URL records a new trade.

---

## Chunk 9 — Video + README + feedback report

Script: the problem → fund an agent → it trades on chain → dashboard with
reasoning → withdraw → future vision (market making, builder fees).

The **SDK/venue feedback report** is now genuinely valuable and nearly free: the
exported operator selectors are spot-only, and `placeBinaryOrderFor` is
unreachable from an EOA on binary pools. That is a real finding from a real test.

---

---

## Audit of chunks 0–3 (2026-09-07)

All gates re-run green (9 / 8 / 9). The audit was about whether the *gates* were
honest, not whether they were green — and two were not.

**FLAW 1 — risk sizing had never once executed.** `gate2` imported `sizeFor` from
a `.ts` module in plain node, silently caught the failure, and printed
"sizing checked via the API instead" — while checking nothing. Every trade also
passed `contracts: 1`, which bypasses `sizeFor` in the endpoint. So the whole
risk-profile feature was untested and unexercised.
*Fixed:* added `dryRun` to `/api/agent/trade` and the gate now asserts the real
computed size against the profile (balance 24.451 → 4 contracts at medium/0.5).

**FLAW 2 — `/api/agent/trade` had no authentication at all.** Identity was a
PUBLIC owner address, so an anonymous request could reach any user's agent key
and force it to trade. Confirmed live: a curl with nothing but a known address
made the agent attempt a 97c buy — it failed on market expiry, not on
authorization. That is a wallet-draining vulnerability.
*Fixed:* `lib/internal.ts` requires `x-internal-secret` (constant-time compare,
denies when unconfigured rather than allowing). Anonymous callers now get 401,
asserted in the gate.

**FLAW 3 — secrets in git.** Checked, clean: `.env.local` and `.data/` are both
gitignored.

**FLAW 4 — the gas top-up was an open faucet.** `/api/agent` sends 0.2 STT to
every newly registered agent. Registration only requires signing for an address
you control, so throwaway wallets could farm it (~95 top-ups from the house
balance).
*Fixed:* a 5 STT house floor — the house stops funding strangers before it stops
being able to operate.

**Lesson for the remaining chunks:** a green gate is not evidence. Two of these
passed while testing nothing. Prefer gates that assert an observable
consequence (a position balance, a 401) over gates that trust a return value.

## The loop, after every chunk

Four questions, in writing, before moving on:

1. **Did the gate actually pass?** Ran it, saw it — not "should work".
2. **What is left?** Update the checklist above.
3. **Do the dots still match?** Does the claim in IDEA.md that this chunk was
   meant to make true actually hold now? If a chunk quietly broke an earlier
   claim, fix the claim or fix the code — never leave the README ahead of the
   product.
4. **Is the remaining plan still right?** Chunk 0 in particular can invalidate
   chunks 2, 5 and 6. Re-plan rather than pushing on.
