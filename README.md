# pump-fun-paper-sprint-01

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/slyfunds-commits/pump-fun-paper-sprint-01/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/slyfunds-commits/pump-fun-paper-sprint-01/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Free entry, five minutes of work: your bot paper-trades pump.fun on a 6-hour replay, highest net PnL takes the pot. Any strategy counts - even buy-and-hold.

This bot is the **Graduation Rider**: it buys coins only as they prove themselves by SOL locked in the bonding curve (entry at 5 SOL real, pyramiding at 10/20/40 SOL real), applies a rug filter at entry (creator buy ≤ 2.5 SOL, creator has not sold, no big single dump, several distinct buyers, positive recent flow), rides winners to completion (the replay force-closes at ~14.7x), and exits losers fast (trailing stop 25% once up 50%, hard stop −30%, creator-sell and stale exits). A guardrail pacer keeps the run at ≥ 20 coins with ≥ 0.01 SOL round trips via minimum-size probe trades when the natural flow lags.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=t2zg4r38&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
