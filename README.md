# pump-fun-riidzhsn-bot

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/azkamahvin88/pump-fun-riidzhsn-bot/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/azkamahvin88/pump-fun-riidzhsn-bot/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Hot-Launch Scalper — a pump.fun bonding-curve paper trading bot for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty ($2 in USDC).

## Strategy

Buy ONLY the hottest launches: a curve at most 3 slots old with at least 10 buys from at least 5 distinct wallets and >= 1.5 SOL net buy flow since creation, already up >= 5% off its create price. Sell ALL fast: stop -10%, take-profit +12%, or 40 slots held, with a trailing stop once up 20%.

Why this shape: on the kit's frozen dev window every looser rule loses money — breakout-chasing and pullback entries both end negative, and the house's own momentum pilot loses 9.5 SOL. The strict hot-launch filter wins 48% of its round trips at 2.2% max drawdown. The edge is selectivity, not size: 0.05 SOL per launch, at most 5 open positions.

## Dev-dataset results (kit grade-local, --driver process)

- Net PnL: **+0.119 SOL** (return +1.19%, 90% interval -0.21 .. +0.46 SOL)
- 201 fills over 83 coins, 83 round trips, win rate 48.2%
- Max drawdown 2.2%, guardrails met
- Two executions reproduce byte for byte (deterministic)

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (see `vendor/makefun-bot.ts`, the kit SDK shim). No dependencies, no network, no clock, no randomness — every decision is a pure function of the replayed events.

---

<sub>Entered on [make.fun](https://make.fun/?ref=monafayola&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
