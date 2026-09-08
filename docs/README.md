# docs

Read in this order.

| File | What it is |
|---|---|
| **[IDEA.md](IDEA.md)** | The canonical product definition. What we are building and why, what is in scope, what to say no to. Start here. |
| **[RESEARCH.md](RESEARCH.md)** | Verified facts about the venue and the SDK, each with a command to re-check it. When a decision needs evidence, it comes from here. |
| **[PLAN.md](PLAN.md)** | The working checklist — 10 chunks, each with a gate you must pass before moving on. This is what you tick off. |
| [BUILD.md](BUILD.md) | Longer-form reasoning behind the plan. PLAN.md supersedes its ordering. |
| ~~[PRD.md](PRD.md)~~ | Superseded. Earlier framing; the market research in §1 still holds. |
| ~~[DEMO.md](DEMO.md)~~ | Superseded. Rewrite the script once delegated execution is live. |

## The three facts that matter most

1. **`placeBinaryOrderFor` is never called in this repo.** The grant a user signs
   authorises nothing. Closing that gap is the highest-value work available.
2. **We are granting the wrong selector.** `lib/delegation.ts` grants the spot
   pool's `0x80054449`; binary pools need `0x5d97c566`. See RESEARCH.md §2.
3. **Nothing is proven until chunk 0 runs.** Binary pools recycle every round and
   the ERC20Vault address *is* the pool address — so if both the grant and the
   collateral are per-pool, "deploy once, runs forever" is impossible and the
   product needs reframing. Resolve before building UI.
