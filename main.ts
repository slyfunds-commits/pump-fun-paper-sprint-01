// Graduation Rider — pump.fun Paper Sprint (6h final, $2 winner-takes-all).
//
// Engine (from the world scan, ~/workspace/makefun/world-scan-pump-fun-20261124.md):
// buy coins only once they prove themselves by SOL locked in the bonding curve
// (a single 0.1 SOL tier at 20 SOL real), ride to completion (the replay
// force-closes at ~14.7x), exit losers fast on a tight trailing stop.
// Only ~2.9% of coins complete and only ~7 of 35 completers are catchable
// (the rest complete in 0-1 slots), so the entry waits for the curve to prove
// itself: coins that peak below 20 SOL lose money, coins that peak above it
// make money. Full tuning notes are in strategy.ts (DEFAULT_PARAMS comment).
//
// The strategy lives in strategy.ts (a pure function of the batches it is fed: no
// clock, no randomness, no I/O). This file only wires it to the harness shim.

import { runBot } from './vendor/makefun-bot.ts';
import { createRiderBot, DEFAULT_PARAMS } from './strategy.ts';

const { onBatch } = createRiderBot(DEFAULT_PARAMS);

await runBot({ onBatch });
