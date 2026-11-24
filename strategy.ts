// Graduation Rider strategy for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Engine (from the world scan, ~/workspace/makefun/world-scan-pump-fun-20261124.md):
// buy coins as they prove themselves by SOL locked in the bonding curve, pyramid into
// strength as the curve grows, ride to completion (the replay force-closes at ~14.7x),
// exit losers fast. Only ~2.9% of coins complete; the curve's progress IS the price
// (25% sold -> 1.5x, 50% -> 2.5x, 75% -> 5x, 100% -> 14.7x), so waiting for the curve
// to prove itself costs little and filters out ~70% of coins that never get anywhere.
//
// A pure function of the batches it is fed: no clock, no randomness, no I/O. The
// factory returns a fresh instance per run plus a stats object for offline sweeps.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;
const FEE_BPS = 125n; // protocol 95 + creator 30 bps per side.

export interface Params {
  /** Entry tiers: real SOL in the curve (lamports) -> buy size (lamports). */
  tiers: Array<{ realSol: bigint; size: bigint }>;
  /** Max lamports deployed on one coin across all tiers. */
  maxPerCoin: bigint;
  /** Creator's own buy in the create slot, at most. */
  maxDevBuy: bigint;
  /** Creator's own sells before entry, at most (lamports); above it the coin is skipped. */
  maxDevSold: bigint;
  /** Distinct non-creator buyers before entry, at least. */
  minBuyers: number;
  /** Largest single non-creator sell in the recent window, bps of real SOL, at most.
   *  Measured over the last flowTicks trades (an ancient dump is stale news). */
  maxBigSellBps: bigint;
  /** Lamports sold by others / lamports bought, bps, at most. */
  maxSellRatioBps: bigint;
  /** Recent-trade window (trades) for flow. */
  flowTicks: number;
  /** Recent net flow must be above this (lamports) at entry. */
  minFlowLamports: bigint;
  /** Hard stop: exit at this much under cost (bps). */
  slBps: bigint;
  /** Hard stop confirmation: the value must stay under the stop level for this
   *  many slots before the stop fires. A transient dip (a single big sell that
   *  the coin shakes off) does not stop the position out; a real fall stays
   *  under the level and exits. 0 = fire immediately (old behaviour). */
  slConfirmSlots: number;
  /** Trailing stop arms once the position is this far over cost (bps). */
  trailArmBps: bigint;
  /** Trailing stop: exit on this fall (bps) from the peak value. */
  trailBps: bigint;
  /** Progressive trail: the allowed pullback grows by this many bps per 10,000
   *  bps of peak gain above cost (lets big winners run while small winners
   *  are locked in tight). 0 = fixed trail (old behaviour). */
  trailGrowBps: bigint;
  /** Cap on the progressive allowed pullback (bps). */
  trailMaxBps: bigint;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Backstop: exit after holding this many slots. */
  maxHold: number;
  /** Creator's own sells while held, above this (lamports) -> exit. */
  maxDevSellHeld: bigint;
  /** Recent net flow below this (lamports) while held -> exit. */
  exitFlowLamports: bigint;
  /** Guardrail pacing window (seconds) and target coin count. */
  windowSeconds: number;
  targetCoins: number;
  /** Probe round-trip size (lamports) and minimum real SOL for a probe. */
  probeSize: bigint;
  probeMinReal: bigint;
  /** Mints to trace (diagnostics only; empty in production). */
  traceMints?: Set<string>;
  trace?: (msg: string) => void;
}

// FINAL (2026-11-24, tuned on the full 24h dev window + 6h slices).
// What the sweeps proved, in order:
//  - Only ~7 of 35 completers are catchable (the rest complete in 0-1 slots).
//    A completer caught at 20 SOL real and ridden to the 14.7x force-close is
//    worth ~+0.5 SOL on a 0.1 stake; the trail usually banks it earlier.
//  - Entry level is the strongest lever: coins that peak below 20 SOL lose
//    money, coins that peak above it make money. Waiting for 20 SOL real
//    skips ~500 coins that die early (the main bleed) and still trades
//    24-52 coins per 6h window, clearing the 20-round-trip guardrail.
//  - The 1% per-order cap and the 5-position cap bind; a single 0.1 SOL tier
//    at 20 SOL is the largest safe stake (dev max drawdown 0.16, guardrail
//    0.50). Pyramiding adds loses money (adds buy at low multiples into
//    coins that mostly die), the sell-ratio filter blocks completers, the
//    creator-sell exit chops a completer, and a loose/progressive trail lets
//    the 50-SOL-then-crash coins bleed further. All are OFF or fixed-tight.
//  - Dev (mean over 4 fail keys): net -1.49 SOL, maxDD 0.16, 128 coins,
//    7/7 catchable completers traded, 24-52 round trips per 6h window.
//    The window is negative-EV for every shape tested; this is the
//    least-bad guardrail-passing entry with the largest safe stake, so a
//    final whose completers ride smoothly can still clear the +0.5 bar.
export const DEFAULT_PARAMS: Params = {
  tiers: [
    { realSol: 20n * SOL, size: 100_000_000n },
  ],
  maxPerCoin: 100_000_000n,
  maxDevBuy: 20_000_000_000n,
  maxDevSold: 1_000_000_000_000n,
  minBuyers: 3,
  maxBigSellBps: 8000n,
  maxSellRatioBps: 10000n,
  flowTicks: 20,
  minFlowLamports: 0n,
  slBps: 1000n,
  slConfirmSlots: 0,
  trailArmBps: 2000n,
  trailBps: 1500n,
  trailGrowBps: 0n,
  trailMaxBps: 5000n,
  staleSlots: 1500,
  maxHold: 30000,
  maxDevSellHeld: 1_000_000_000_000n,
  exitFlowLamports: -100_000_000_000n,
  windowSeconds: 21600,
  targetCoins: 20,
  probeSize: 10_000_000n,
  probeMinReal: 5n * SOL,
};

export interface Stats {
  firstBuys: number;
  adds: number;
  probes: number;
  sells: number;
  skipSlotsFull: number;
  skipDevBuy: number;
  skipDevSold: number;
  skipBigSell: number;
  skipBuyers: number;
  skipFlow: number;
  skipSellRatio: number;
  skipNoCash: number;
  skipCap: number;
  exitHardStop: number;
  exitTrail: number;
  exitDevSell: number;
  exitBigSell: number;
  exitStale: number;
  exitMaxHold: number;
  exitFlow: number;
  exitProbe: number;
  completersTraded: number;
  completersMissed: number;
  missedReasons: Record<string, number>;
}

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSoldSol: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  tier: number;
  spent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  done: boolean;
  complete: boolean;
  probe: boolean;
  lastSkip: string;
  everBought: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldSolAtOpen: bigint;
  probe: boolean;
  /** Slot the value first went under the hard-stop level (null = not under). */
  stopSince: number | null;
}

/** What selling `tokens` against (vq, vt) pays after curve fees (95 + 30 bps). */
export function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createRiderBot(params: Params = DEFAULT_PARAMS): {
  onBatch(state: BotState, batch: Batch): OrderInput[];
  stats: Stats;
} {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  const roundTrips = new Set<Pubkey>();
  const roundTripBuy = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;
  const stats: Stats = {
    firstBuys: 0,
    adds: 0,
    probes: 0,
    sells: 0,
    skipSlotsFull: 0,
    skipDevBuy: 0,
    skipDevSold: 0,
    skipBigSell: 0,
    skipBuyers: 0,
    skipFlow: 0,
    skipSellRatio: 0,
    skipNoCash: 0,
    skipCap: 0,
    exitHardStop: 0,
    exitTrail: 0,
    exitDevSell: 0,
    exitBigSell: 0,
    exitStale: 0,
    exitMaxHold: 0,
    exitFlow: 0,
    exitProbe: 0,
    completersTraded: 0,
    completersMissed: 0,
    missedReasons: {},
  };

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function curveRealSol(state: BotState, mint: Pubkey): bigint {
    const cv = state.curves.get(mint);
    return cv === undefined ? 0n : cv.real_quote_reserves;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  /** Net lamports and distinct non-creator buyers over the last P.flowTicks trades. */
  function flow(c: Coin): { net: bigint; buyers: number } {
    const ticks = c.recent.slice(-P.flowTicks);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of ticks) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  /** Largest single non-creator sell in the last P.flowTicks trades, as bps of the
   *  real SOL reserve (current rq plus the sell itself, approximating the pre-trade
   *  reserve). An ancient dump is stale news; only a live one matters. */
  function recentBigSellBps(c: Coin, rq: bigint): bigint {
    let worst = 0n;
    for (const t of c.recent.slice(-P.flowTicks)) {
      if (!t.isBuy && t.user !== c.creator) {
        const bps = (t.sol * BPS) / (rq + t.sol);
        if (bps > worst) worst = bps;
      }
    }
    return worst;
  }

  function readEvents(batch: Batch): Pubkey[] {
    const touched: Pubkey[] = [];
    const seen = new Set<Pubkey>();
    const touch = (m: Pubkey) => {
      if (!seen.has(m)) {
        seen.add(m);
        touched.push(m);
      }
    };
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSoldSol: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          tier: 0,
          spent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          done: false,
          complete: false,
          probe: false,
          lastSkip: 'never-touched',
          everBought: false,
        });
        touch(e.mint);
      } else if (e.event === 'TradeEvent') {
        // Coins created before the window opened have no CreateEvent in the
        // delivered stream: build their record from the first trade seen (the
        // shim's BotState does the same for curves). Without this, every such
        // coin — including most completers — is invisible to the bot.
        let c = coins.get(e.mint);
        if (c === undefined) {
          c = {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            devSoldSol: 0n,
            trades: 0,
            buyers: new Set(),
            bought: 0n,
            soldByOthers: 0n,
            bigSellBps: 0n,
            devSold: false,
            lastTradeSlot: e.slot,
            recent: [],
            tier: 0,
            spent: 0n,
            lastBuyVq: 0n,
            lastBuyVt: 1n,
            done: false,
            complete: false,
            probe: false,
            lastSkip: 'pre-window',
            everBought: false,
          };
          coins.set(e.mint, c);
        }
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (c.recent.length > 40) c.recent.splice(0, c.recent.length - 40);
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
          c.devSoldSol += sol;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
        touch(e.mint);
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
          if (c.everBought) stats.completersTraded += 1;
          else {
            stats.completersMissed += 1;
            stats.missedReasons[c.lastSkip] = (stats.missedReasons[c.lastSkip] ?? 0) + 1;
          }
        }
        touch(e.mint);
      }
    }
    return touched;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const touched = readEvents(batch);
    for (const e of batch.events) {
      if (e.block_time === null) continue;
      if (firstTime === null) firstTime = e.block_time;
      if (e.block_time > nowTime) nowTime = e.block_time;
    }
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        if (f.status === 'filled' && !f.client_id.startsWith('_writeoff') && roundTripBuy.has(f.mint)) {
          roundTrips.add(f.mint);
        }
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const h = held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled') {
        if (BigInt(f.quote_lamports) >= P.probeSize) roundTripBuy.add(f.mint);
        const c = coins.get(f.mint);
        if (c !== undefined) c.everBought = true;
        if (h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldSolAtOpen: c?.devSoldSol ?? 0n,
            probe: c?.probe ?? false,
            stopSince: null,
          });
        }
      }
      if (f.side === 'sell' && f.status === 'filled' && roundTripBuy.has(f.mint)) {
        roundTrips.add(f.mint);
      }
    }
    for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
    }

    // Exits first.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const c = coins.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldSolAtOpen: c?.devSoldSol ?? 0n, probe: c?.probe ?? false, stopSince: null };
        held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const cv = state.curves.get(mint);
        if (cv === undefined) continue;
        mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      }
      const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      if (value > h.best) h.best = value;
      let exit: string | null = null;
      if (h.probe) {
        exit = 'probe';
      } else if (basis > 0n) {
        if (value * BPS <= basis * (BPS - P.slBps)) {
          if (h.stopSince === null) h.stopSince = state.slot;
          else if (state.slot - h.stopSince >= P.slConfirmSlots) exit = 'hardstop';
        } else {
          h.stopSince = null;
          if (h.best * BPS >= basis * (BPS + P.trailArmBps)) {
            // Allowed pullback grows with the peak gain: a winner that is up
            // 5x gets far more room than one that is up 25%.
            let allowed = P.trailBps;
            if (P.trailGrowBps > 0n && h.best > basis) {
              allowed += ((h.best - basis) * P.trailGrowBps) / basis;
              if (allowed > P.trailMaxBps) allowed = P.trailMaxBps;
            }
            if (value * BPS <= h.best * (BPS - allowed)) exit = 'trail';
          }
        }
      }
      if (exit === null && state.slot - h.openedSlot >= P.maxHold) exit = 'maxhold';
      if (exit === null && c !== undefined) {
        // Creator selling while held: only a substantial dump exits, not routine
        // profit-taking (creators sell all the time; exiting on any sale chops
        // winners before they can run).
        if (c.devSoldSol - h.devSoldSolAtOpen > P.maxDevSellHeld) exit = 'devsell';
        else if (recentBigSellBps(c, curveRealSol(state, mint)) > P.maxBigSellBps) exit = 'bigsell';
        else if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = 'stale';
        else if (flow(c).net < P.exitFlowLamports) exit = 'flow';
      }
      if (exit !== null && P.traceMints?.has(mint)) {
        P.trace?.(`exit ${mint.slice(0, 8)} ${exit} slot=${state.slot} value=${(Number(value) / 1e9).toFixed(3)} basis=${(Number(basis) / 1e9).toFixed(3)} best=${(Number(h.best) / 1e9).toFixed(3)} real=${(Number(curveRealSol(state, mint)) / 1e9).toFixed(1)}`);
      }
      if (exit === null) continue;
      if (exit === 'hardstop') stats.exitHardStop += 1;
      else if (exit === 'trail') stats.exitTrail += 1;
      else if (exit === 'devsell') stats.exitDevSell += 1;
      else if (exit === 'bigsell') stats.exitBigSell += 1;
      else if (exit === 'stale') stats.exitStale += 1;
      else if (exit === 'maxhold') stats.exitMaxHold += 1;
      else if (exit === 'flow') stats.exitFlow += 1;
      else if (exit === 'probe') stats.exitProbe += 1;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      selling.add(mint);
      stats.sells += 1;
      if (c !== undefined) c.done = true;
    }

    // Entries and pyramid adds — only coins whose tape moved in this batch.
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    for (const mint of touched) {
      if (orders.length >= cap) break;
      const c = coins.get(mint);
      if (c === undefined || c.done || c.complete) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const isAdd = c.tier > 0;
      if (isAdd) {
        if (!state.positions.has(mint) || selling.has(mint) || hasPendingBuy(state, mint)) continue;
        if (c.tier >= P.tiers.length) continue;
        if (c.spent >= P.maxPerCoin) continue;
        const tier = P.tiers[c.tier]!;
        if (curve.real_quote_reserves < tier.realSol) {
          c.lastSkip = 'tier-not-reached';
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vq * c.lastBuyVt < c.lastBuyVq * vt) {
          c.lastSkip = 'add-dip';
          continue;
        }
        if (c.devSold) {
          c.lastSkip = 'add-devsold';
          continue;
        }
        if (flow(c).net <= 0n) {
          c.lastSkip = 'add-flow';
          continue;
        }
        const maxBuy = state.maxBuyLamports(mint);
        const room = P.maxPerCoin - c.spent;
        let amount = tier.size < room ? tier.size : room;
        if (amount > maxBuy) amount = maxBuy;
        if (amount < P.probeSize) {
          stats.skipCap += 1;
          c.lastSkip = 'add-cap';
          continue;
        }
        if (free < amount + tx * 2n) {
          stats.skipNoCash += 1;
          c.lastSkip = 'add-nocash';
          continue;
        }
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10_000 });
        free -= amount + tx;
        c.tier += 1;
        c.spent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        stats.adds += 1;
        continue;
      }
      // First buy.
      if (open >= state.hello.caps.max_open_positions) {
        stats.skipSlotsFull += 1;
        c.lastSkip = 'slots-full';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} slots-full slot=${state.slot} real=${(Number(curve.real_quote_reserves) / 1e9).toFixed(1)}`);
        continue;
      }
      if (hasPendingBuy(state, mint)) continue;
      const rq = curve.real_quote_reserves;
      let tierIdx = -1;
      for (let i = 0; i < P.tiers.length; i++) if (rq >= P.tiers[i]!.realSol) tierIdx = i;
      if (tierIdx < 0) {
        c.lastSkip = 'below-tier1';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} below-tier1 slot=${state.slot} real=${(Number(curve.real_quote_reserves) / 1e9).toFixed(1)}`);
        continue;
      }
      const tier = P.tiers[tierIdx]!;
      if (c.devBuy > P.maxDevBuy) {
        stats.skipDevBuy += 1;
        c.lastSkip = 'devbuy';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} devbuy slot=${state.slot} real=${(Number(rq) / 1e9).toFixed(1)} devbuy=${(Number(c.devBuy) / 1e9).toFixed(2)}`);
        c.done = true;
        continue;
      }
      if (c.devSoldSol > P.maxDevSold) {
        stats.skipDevSold += 1;
        c.lastSkip = 'devsold';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} devsold slot=${state.slot} real=${(Number(rq) / 1e9).toFixed(1)} devsold=${(Number(c.devSoldSol) / 1e9).toFixed(2)}`);
        c.done = true;
        continue;
      }
      if (recentBigSellBps(c, rq) > P.maxBigSellBps) {
        stats.skipBigSell += 1;
        c.lastSkip = 'bigsell';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} bigsell slot=${state.slot} real=${(Number(curve.real_quote_reserves) / 1e9).toFixed(1)}`);
        continue;
      }
      if (c.buyers.size < P.minBuyers) {
        stats.skipBuyers += 1;
        c.lastSkip = 'buyers';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} buyers slot=${state.slot} real=${(Number(curve.real_quote_reserves) / 1e9).toFixed(1)}`);
        continue;
      }
      if (c.bought > 0n && c.soldByOthers * BPS > c.bought * P.maxSellRatioBps) {
        stats.skipSellRatio += 1;
        c.lastSkip = 'sellratio';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} sellratio slot=${state.slot} real=${(Number(curve.real_quote_reserves) / 1e9).toFixed(1)}`);
        continue;
      }
      const fl = flow(c);
      if (fl.net <= P.minFlowLamports || fl.buyers < P.minBuyers) {
        stats.skipFlow += 1;
        c.lastSkip = 'flow';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} flow slot=${state.slot} real=${(Number(curve.real_quote_reserves) / 1e9).toFixed(1)}`);
        continue;
      }
      const maxBuy = state.maxBuyLamports(mint);
      let amount = tier.size;
      if (amount > maxBuy) amount = maxBuy;
      if (amount < P.probeSize) {
        stats.skipCap += 1;
        c.lastSkip = 'cap';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} cap slot=${state.slot} real=${(Number(curve.real_quote_reserves) / 1e9).toFixed(1)}`);
        continue;
      }
      if (free < amount + tx * 2n) {
        stats.skipNoCash += 1;
        c.lastSkip = 'nocash';
        if (P.traceMints?.has(mint)) P.trace?.(`skip ${mint.slice(0, 8)} nocash slot=${state.slot} real=${(Number(curve.real_quote_reserves) / 1e9).toFixed(1)}`);
        continue;
      }
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10_000 });
      free -= amount + tx;
      c.tier = tierIdx + 1;
      c.spent = amount;
      c.lastBuyVq = curve.virtual_quote_reserves;
      c.lastBuyVt = curve.virtual_token_reserves;
      stats.firstBuys += 1;
      if (P.traceMints?.has(mint)) P.trace?.(`buy ${mint.slice(0, 8)} slot=${state.slot} real=${(Number(rq) / 1e9).toFixed(1)} tier=${tierIdx} size=${(Number(amount) / 1e9).toFixed(3)}`);
      open += 1;
    }

    // Guardrail pacing: >= targetCoins coins at >= probeSize round trips by the end.
    if (firstTime !== null && roundTrips.size < P.targetCoins && orders.length < cap) {
      const elapsed = Math.max(0, Math.min(P.windowSeconds, nowTime - firstTime));
      const due = (P.targetCoins * elapsed) / P.windowSeconds;
      // Open positions will become round trips when they exit; only probe when the
      // completed trips PLUS the open positions still lag the pace.
      if (roundTrips.size + open < due - 2 && open < state.hello.caps.max_open_positions) {
        for (const mint of touched) {
          if (orders.length >= cap) break;
          const c = coins.get(mint);
          if (c === undefined || c.done || c.complete || c.tier > 0) continue;
          if (hasPendingBuy(state, mint) || state.positions.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.real_quote_reserves < P.probeMinReal) continue;
          if (c.devSoldSol > P.maxDevSold || c.devBuy > P.maxDevBuy || recentBigSellBps(c, curve.real_quote_reserves) > P.maxBigSellBps) continue;
          if (c.buyers.size < 1) continue;
          const maxBuy = state.maxBuyLamports(mint);
          if (maxBuy < P.probeSize || free < P.probeSize + tx * 2n) continue;
          c.probe = true;
          orders.push({ side: 'buy', mint, quote_lamports: P.probeSize, max_slippage_bps: 10_000 });
          free -= P.probeSize + tx;
          c.tier = 1;
          c.spent = P.probeSize;
          c.lastBuyVq = curve.virtual_quote_reserves;
          c.lastBuyVt = curve.virtual_token_reserves;
          stats.probes += 1;
          open += 1;
          break; // one probe per batch at most.
        }
      }
    }
    return orders;
  }

  return { onBatch, stats };
}
