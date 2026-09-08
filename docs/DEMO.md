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

# Demo script — 2:30

The rubric gives Presentation & Demo 15%, and judges allow roughly 3–4 minutes per project.
This is written to be read aloud over a screen recording.

---

### 0:00–0:20 — The problem, with a number

> "Kalshi and Polymarket already run 15-minute Bitcoin up/down markets — it's the fastest
> growing product at the category leader. But their users' loudest complaints are disputed
> resolutions and bad fills: a contract that filled at 98.5% on Kalshi filled at 80% through
> Coinbase's wrapper.
>
> Meanwhile on DreamDEX, I measured these markets doing 54 fills an hour across 83 addresses —
> 4% of the venue's flow. The product works. Nobody's using this one."

*On screen: the landing hero.*

### 0:20–0:50 — The product

> "Aioxy is a marketplace of trading agents on DreamDEX Event Contracts. Four desks, each
> with a different thesis, trading live 60-second and 15-minute rounds on BTC and ETH.
>
> Every one of them publishes every trade it makes, with the sentence explaining why — losses
> exactly as prominently as wins."

*Scroll the leaderboard. Click into the top agent.*

### 0:50–1:25 — The track record

> "This is Clockwork. It trades time decay: near expiry an outcome is nearly determined, but
> the book is slow to price certainty.
>
> Here's a real trade. Twelve seconds left, spot was ninety dollars above the strike, the model
> said 84% UP, the book was still offering it at 71%. It took UP. Here's one it lost, with the
> same reasoning shown.
>
> All four agents share one pricing model — a lognormal touch probability off realised
> volatility — so what the leaderboard measures is judgement, not arithmetic."

*Scroll trades. Point at a loss.*

### 1:25–1:55 — The two hard claims

> "Two things make this different from a dashboard.
>
> First, delegation without custody. DreamDEX records operator rights on-chain, scoped per
> function selector. An agent key can place and cancel orders and *nothing else* — it can't
> withdraw, it can't approve, and fills settle to your vault, not the agent's. That's not a
> design I'm proposing: this page reads the registry live, and 61 owners are already using it."

*Show `/mirror`.*

> "Second, provable settlement. Every resolved round shows the raw payout vector the oracle
> delivered on-chain, and the block it landed in. You never have to take my word for an outcome."

*Show the markets page, proof-of-settlement feed.*

### 1:55–2:20 — Live

> "And it's running now. Live rounds off the indexer, live spot off the same oracle that settles
> these markets, the book normalised onto one probability axis — because Up and Down share a
> single book here.
>
> One detail worth flagging: the venue id in the official bot kit is already stale. Every market
> created in the last hour is on a different venue. Aioxy derives it at runtime, so it survives
> the next move."

*Countdown ticking, a round resolving.*

### 2:20–2:30 — The honest close

> "Short-window binaries are close to a coin flip minus fees, and I haven't hidden that — the
> app says so on the front page. What Aioxy does is make every claim checkable: every trade,
> every reason, every settlement. That's the thing this category is missing."

---

## Pre-flight

- [ ] Runner has been up long enough for a real track record with **both wins and losses**
- [ ] A round with a short window is open, so something resolves on camera
- [ ] `EXECUTION_MODE=live` if the key is funded — otherwise say "paper" out loud, once
- [ ] Have a losing trade ready to point at. It is more persuasive than a winning one.
