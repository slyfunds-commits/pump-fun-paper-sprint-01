// Graduation Rider — pump.fun Paper Sprint (6h final, $2 winner-takes-all).
//
// Engine (from the world scan, ~/workspace/makefun/world-scan-pump-fun-20261124.md):
// buy coins as they prove themselves by SOL locked in the bonding curve, pyramid into
// strength as the curve grows, ride to completion (the replay force-closes at ~14.7x),
// exit losers fast. Only ~2.9% of coins complete; the curve's progress IS the price
// (25% sold -> 1.5x, 50% -> 2.5x, 75% -> 5x, 100% -> 14.7x), so waiting for the curve
// to prove itself costs little and filters out ~70% of coins that never get anywhere.
//
// Entry tiers (real SOL in the curve -> buy size; each size is exactly the 1% order
// cap at its threshold): 5 SOL -> 0.05, 10 -> 0.10, 20 -> 0.20, 40 -> 0.40.
// Max per coin 0.75 SOL, max 5 open positions. Never add on a dip.
// Rug filter at first buy: creator's own buy in the create slot <= 2.5 SOL, creator
// has not sold, no single non-creator sell > 30% of real SOL, sells <= 50% of buys,
// >= 3 distinct buyers, recent (last 20 trades) net flow positive with >= 3 buyers.
// Exits: no take-profit before completion; trailing stop 25% once up 50% from cost;
// hard stop -30% from cost; creator sells while held -> exit at once; sharp negative
// flow -> exit; stale (no trade for 1500 slots) -> exit; 30000-slot backstop.
// Guardrail pacing: the run must end with >= 20 coins at >= 0.01 SOL round trips.
// If round trips lag the pace (20 coins over an assumed 6h window), minimum-size
// 0.01 SOL probe round trips fill the gap; each burns ~0.00046 SOL.
//
// Determinism: a pure function of the batches it is fed. No clock, no environment,
// no Math.random; block_time comes from the events themselves. No I/O, no imports
// beyond the vendored shim.

import { runBot, BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;
const FEE_BPS = 125n; // protocol 95 + creator 30 bps per side.

// Entry tiers: real SOL in the curve (lamports) -> buy size (lamports).
const TIERS: Array<{ realSol: bigint; size: bigint }> = [
  { realSol: 5n * SOL, size: 50_000_000n },
  { realSol: 10n * SOL, size: 100_000_000n },
  { realSol: 20n * SOL, size: 200_000_000n },
  { realSol: 40n * SOL, size: 400_000_000n },
];
const MAX_PER_COIN = 750_000_000n;

// Rug / quality filter.
const MAX_DEV_BUY = 2_500_000_000n; // creator's own buy in the create slot.
const MIN_BUYERS = 3; // distinct non-creator buyers before entry.
const MAX_BIG_SELL_BPS = 3000n; // largest single non-creator sell, bps of real SOL.
const MAX_SELL_RATIO_BPS = 5000n; // lamports sold by others / lamports bought, at most.
const FLOW_TICKS = 20; // recent-trade window for flow.

// Exits.
const SL_BPS = 3000n; // hard stop: exit at -30% of cost.
const TRAIL_ARM_BPS = 5000n; // trailing stop arms at +50% of cost.
const TRAIL_BPS = 2500n; // trailing stop: exit on a 25% fall from the peak value.
const STALE_SLOTS = 1500; // no trade for this many slots -> exit.
const MAX_HOLD = 30000; // slots; backstop only.
const EXIT_FLOW_LAMPORTS = -500_000_000n; // recent net flow below this -> exit.

// Guardrail pacing (assumed 6h window; the final is 6h).
const WINDOW_SECONDS = 21600;
const TARGET_COINS = 20;
const PROBE_SIZE = 10_000_000n; // 0.01 SOL.
const PROBE_MIN_REAL = 1n * SOL;

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
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  tier: number; // next tier index to buy (0 = first buy not yet sent).
  spent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  done: boolean;
  complete: boolean;
  probe: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  bigSellAtOpen: bigint;
  probe: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const selling = new Set<Pubkey>();
/** Mints whose buy (>= 0.01 SOL) filled and whose position later closed. */
const roundTrips = new Set<Pubkey>();
const roundTripBuy = new Set<Pubkey>();
let firstTime: number | null = null;
let nowTime = 0;

function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
  return false;
}

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
  return false;
}

/** Net lamports and distinct non-creator buyers over the last FLOW_TICKS trades. */
function flow(c: Coin): { net: bigint; buyers: number } {
  const ticks = c.recent.slice(-FLOW_TICKS);
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
      });
      touch(e.mint);
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
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
      }
      touch(e.mint);
    }
  }
  return touched;
}

await runBot({
  onBatch(state, batch) {
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

    // Fold fills: track round trips, held-state bookkeeping, harness closes.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // Harness close (complete / flatten / writeoff): position is gone.
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
        if (BigInt(f.quote_lamports) >= PROBE_SIZE) roundTripBuy.add(f.mint);
        if (h === undefined) {
          const c = coins.get(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: c?.devSold ?? false,
            bigSellAtOpen: c?.bigSellBps ?? 0n,
            probe: c?.probe ?? false,
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
        h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, bigSellAtOpen: c?.bigSellBps ?? 0n, probe: c?.probe ?? false };
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
      let exit = false;
      if (h.probe) {
        // Probe round trip: sell as soon as the buy has landed.
        exit = true;
      } else if (basis > 0n) {
        if (value * BPS <= basis * (BPS - SL_BPS)) exit = true; // hard stop -30%.
        if (h.best * BPS >= basis * (BPS + TRAIL_ARM_BPS) && value * BPS <= h.best * (BPS - TRAIL_BPS)) exit = true; // trailing stop.
      }
      if (state.slot - h.openedSlot >= MAX_HOLD) exit = true;
      if (c !== undefined) {
        if (c.devSold && !h.devSoldAtOpen) exit = true; // creator sells while held.
        if (c.bigSellBps > h.bigSellAtOpen && c.bigSellBps > MAX_BIG_SELL_BPS) exit = true; // big dump while held.
        if (state.slot - c.lastTradeSlot >= STALE_SLOTS) exit = true;
        if (flow(c).net < EXIT_FLOW_LAMPORTS) exit = true;
      }
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      selling.add(mint);
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
        if (c.tier >= TIERS.length) continue;
        if (c.spent >= MAX_PER_COIN) continue;
        const tier = TIERS[c.tier]!;
        if (curve.real_quote_reserves < tier.realSol) continue;
        // Pyramid into strength only: price at or above the last buy's decision price.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vq * c.lastBuyVt < c.lastBuyVq * vt) continue;
        if (c.devSold) continue;
        if (flow(c).net <= 0n) continue;
        const maxBuy = state.maxBuyLamports(mint);
        const room = MAX_PER_COIN - c.spent;
        let amount = tier.size < room ? tier.size : room;
        if (amount > maxBuy) amount = maxBuy;
        if (amount < PROBE_SIZE || free < amount + tx * 2n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10_000 });
        free -= amount + tx;
        c.tier += 1;
        c.spent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        continue;
      }
      // First buy.
      if (open >= state.hello.caps.max_open_positions) continue;
      if (hasPendingBuy(state, mint)) continue;
      const tier = TIERS[0]!;
      const rq = curve.real_quote_reserves;
      if (rq < tier.realSol) continue;
      // Rug filter.
      if (c.devBuy > MAX_DEV_BUY) {
        c.done = true;
        continue;
      }
      if (c.devSold) {
        c.done = true;
        continue;
      }
      if (c.bigSellBps > MAX_BIG_SELL_BPS) {
        c.done = true;
        continue;
      }
      if (c.buyers.size < MIN_BUYERS) continue;
      if (c.bought > 0n && c.soldByOthers * BPS > c.bought * MAX_SELL_RATIO_BPS) continue;
      const fl = flow(c);
      if (fl.net <= 0n || fl.buyers < MIN_BUYERS) continue;
      const maxBuy = state.maxBuyLamports(mint);
      let amount = tier.size;
      if (amount > maxBuy) amount = maxBuy;
      if (amount < PROBE_SIZE || free < amount + tx * 2n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10_000 });
      free -= amount + tx;
      c.tier = 1;
      c.spent = amount;
      c.lastBuyVq = curve.virtual_quote_reserves;
      c.lastBuyVt = curve.virtual_token_reserves;
      open += 1;
    }

    // Guardrail pacing: >= 20 coins at >= 0.01 SOL round trips by the end of the window.
    if (firstTime !== null && roundTrips.size < TARGET_COINS && orders.length < cap) {
      const elapsed = Math.max(0, Math.min(WINDOW_SECONDS, nowTime - firstTime));
      const due = (TARGET_COINS * elapsed) / WINDOW_SECONDS;
      if (roundTrips.size < due - 2 && open < state.hello.caps.max_open_positions) {
        for (const mint of touched) {
          if (orders.length >= cap) break;
          const c = coins.get(mint);
          if (c === undefined || c.done || c.complete || c.tier > 0) continue;
          if (hasPendingBuy(state, mint) || state.positions.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.real_quote_reserves < PROBE_MIN_REAL) continue;
          if (c.devSold || c.devBuy > MAX_DEV_BUY || c.bigSellBps > MAX_BIG_SELL_BPS) continue;
          if (c.buyers.size < 1) continue;
          const maxBuy = state.maxBuyLamports(mint);
          if (maxBuy < PROBE_SIZE || free < PROBE_SIZE + tx * 2n) continue;
          c.probe = true;
          orders.push({ side: 'buy', mint, quote_lamports: PROBE_SIZE, max_slippage_bps: 10_000 });
          free -= PROBE_SIZE + tx;
          c.tier = 1;
          c.spent = PROBE_SIZE;
          c.lastBuyVq = curve.virtual_quote_reserves;
          c.lastBuyVt = curve.virtual_token_reserves;
          open += 1;
          break; // one probe per batch at most.
        }
      }
    }
    return orders;
  },
});
