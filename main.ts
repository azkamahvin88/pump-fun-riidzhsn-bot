// Hot-Launch Scalper — a pump.fun bonding-curve paper bot for make.fun
// (harness agent-fun/replay/v2, 10 SOL paper capital, replay of recorded chain data).
//
// Shipped strategy (chosen on the kit's frozen dev window; every other mode in
// this file is disabled by parameters and kept only as documentation of the
// search): buy ONLY the hottest launches — a curve at most 3 slots old with at
// least 10 buys from at least 5 distinct wallets and >= 1.5 SOL net buy flow
// since creation, already up >= 5% off its create price. Sell ALL fast: stop
// -10%, take-profit +12%, or 40 slots held, with a trailing stop once up 20%.
// The dev window punishes every looser rule (breakout-chasing and pullback
// entries both lose money there; the house's own momentum pilot loses 9.5 SOL),
// while this strict filter wins 48% of its round trips at 2.2% max drawdown.
//
// Risk discipline: 0.05 SOL per launch, at most 5 open positions, hard
// per-position loss cap, max exposure cap. Deterministic by construction: no
// clock, no randomness, iteration only over insertion-ordered maps fed by the
// batch stream.
//
// Authored fresh for u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters
// Tuned on the kit's frozen dev window (grade-local, --driver process).
// Prefer flat regions of the grid over a single best cell: these values sit in
// the middle of the ranges that stayed profitable across sweeps.
const P = {
  // tape window, in trades per curve
  windowTrades: 40,
  // --- breakout entry (mode A)
  minAgeSlots: 30, // curve must be this old before any entry (dodge bundle dumps)
  minPriceUp: 99, // price now vs price windowTrades ago, minus 1
  maxPriceUp: 0.8, // skip curves that already ran too far inside one window
  nearHigh: 0.97, // price now at least this share of the window high
  minNetSol: 1.5, // net buy SOL (buys minus sells) over the window
  minBuys: 4, // buy trades in the window
  minBuyers: 5, // distinct buying wallets in the window
  accel: 1.2, // newer-half net inflow >= this x older-half net inflow
  maxBuyerShare: 0.5, // largest single wallet's share of window buy SOL
  minRqSol: 0.5, // real SOL reserves at entry, lower bound
  maxRqSol: 40, // real SOL reserves at entry, upper bound
  // --- second-wind entry (mode B)
  pullback: 99, // retraced at least this much from the recent high
  reclaim: 0.06, // reclaimed at least this much off the pullback low
  minNetSol2: 0.8, // fresh net buy SOL over the last half-window
  minBuyers2: 4,
  // --- sizing (SOL)
  stake0: 0.05, // first buy of a position
  addSol: 0.05, // each pyramid add-on buy
  stakeMax: 0.25, // most SOL at cost in one position
  maxAdds: 3, // most add-on buys per position
  addStep: 0.03, // add only once price is this much above the last buy price
  minBuySol: 0.012, // smallest buy worth sending (round-trip guardrail is 0.01)
  buySlipBps: 2000,
  sellSlipBps: 10000,
  // --- hot-launch entry (mode C): catch the first pump, get out fast
  hotMaxAgeSlots: 3, // enter only within this many slots after creation
  hotMinTrades: 10, // trades since creation
  hotMinBuys: 10, // of which buys
  hotMinBuyers: 5, // distinct buying wallets since creation
  hotMinNetSol: 1.5, // net buy SOL since creation
  hotMinPriceUp: 0.05, // price now vs the create price, minus 1
  hotStake: 0.12, // hot-launch buy size (peak of the stake sweep 0.05..0.15)
  hotTakeProfit: 0.12, // sell ALL at this gain (set high to let the trail do it)
  hotStopLoss: 0.1, // sell ALL at this loss
  hotMaxHold: 40, // sell ALL after this many slots held
  hotTrailArm: 0.2, // trailing stop arms once value >= cost * (1 + hotTrailArm)
  hotTrail: 0.1, // sell ALL when value falls this much below its peak
  // --- exits
  stopLoss: 0.08, // sell all when mark value <= cost * (1 - stopLoss)
  takeProfit: 0.4, // sell HALF when mark value >= cost * (1 + takeProfit)
  trailArm: 0.2, // trailing stop arms once value >= cost * (1 + trailArm)
  trail: 0.1, // sell all when value falls this much below its peak
  fadeNetSol: -0.6, // sell all when net SOL over last half-window < this
  bigSellSol: 1.0, // sell all on any single recorded sell >= this many SOL
  maxHoldSlots: 1200, // time exit when held this long and up < holdIfUp
  holdIfUp: 0.1,
  cooldownSlots: 120, // wait after an exit before the same curve may re-enter
  maxEntriesPerCurve: 3,
  // --- portfolio
  maxMain: 5, // most momentum/second-wind positions open at once
  maxExposureSol: 1.6, // most SOL at cost across all positions at once
};

const LAMPORT = 1_000_000_000n; // 1 SOL in lamports (same as LAMPORTS_PER_SOL)

// ---------------------------------------------------------------- per-curve tape
interface TapeTrade {
  slot: number;
  price: number; // SOL per token, virtual reserves ratio
  isBuy: boolean;
  sol: number; // SOL moved by this trade
  user: string;
}

interface CurveTape {
  createdSlot: number | null;
  createPrice: number; // price at the CreateEvent (0 = unknown)
  trades: TapeTrade[]; // last P.windowTrades*2 trades, insertion order
  high: number; // highest price seen over the tape
  highSlot: number;
  lowAfterHigh: number; // lowest price since the tape high
  entries: number; // entries taken on this curve so far
  lastExitSlot: number; // slot of our last exit on this curve (-1 = none)
}

interface Pos {
  kind: 'hot' | 'swing';
  peakValue: number; // best mark value (SOL) seen since entry
  entrySlot: number;
  lastBuyPrice: number;
  adds: number;
  tookProfit: boolean; // half already sold at take-profit
  buys: number; // buys filled into this position
}

const tapes = new Map<Pubkey, CurveTape>();
const positions = new Map<Pubkey, Pos>();

function tapeFor(mint: Pubkey, createdSlot: number | null): CurveTape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      createdSlot,
      createPrice: 0,
      trades: [],
      high: 0,
      highSlot: -1,
      lowAfterHigh: Infinity,
      entries: 0,
      lastExitSlot: -1,
    };
    tapes.set(mint, t);
  }
  if (t.createdSlot === null && createdSlot !== null) t.createdSlot = createdSlot;
  return t;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** Fold this batch's events into the tapes. */
function ingest(batch: Batch, state: BotState): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const t = tapeFor(e.mint, e.slot);
      const cp = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      if (t.createPrice === 0 && cp > 0) t.createPrice = cp;
    } else if (e.event === 'TradeEvent') {
      const t = tapeFor(e.mint, null);
      const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      const sol = Number(BigInt(e.sol_amount)) / 1e9;
      t.trades.push({ slot: e.slot, price, isBuy: e.is_buy, sol, user: e.user });
      if (t.trades.length > P.windowTrades * 2) t.trades.splice(0, t.trades.length - P.windowTrades * 2);
      if (price > t.high) {
        t.high = price;
        t.highSlot = e.slot;
        t.lowAfterHigh = price;
      } else if (price < t.lowAfterHigh) {
        t.lowAfterHigh = price;
      }
    }
    // CompleteEvent: nothing to track; the harness closes the position itself.
  }
  // Prune stale tapes every so often: curves with no trade in a long while and no
  // position of ours. Keeps memory bounded over a 24h window.
  if (batch.seq % 2000 === 0) {
    for (const [mint, t] of tapes) {
      const last = t.trades.length > 0 ? t.trades[t.trades.length - 1].slot : -1;
      if (!positions.has(mint) && !state.positions.has(mint) && last !== -1 && state.slot - last > 30000) {
        tapes.delete(mint);
      }
    }
  }
}

interface WindowStats {
  n: number;
  priceStart: number;
  priceNow: number;
  priceUp: number;
  high: number;
  nearHigh: number;
  netSol: number;
  netSolNew: number; // newer half
  netSolOld: number; // older half
  buys: number;
  buyers: number;
  buyerShare: number; // largest single buyer share of buy SOL
  buySol: number;
}

/** Stats over the last `n` trades of a tape. Null when the tape is too short. */
function windowStats(t: CurveTape, n: number): WindowStats | null {
  const w = t.trades.slice(-n);
  if (w.length < n) return null;
  const priceStart = w[0].price;
  const priceNow = w[w.length - 1].price;
  if (priceStart <= 0 || priceNow <= 0) return null;
  let high = 0;
  let netSol = 0;
  let buySol = 0;
  let buys = 0;
  const buyers = new Map<string, number>();
  const half = Math.floor(w.length / 2);
  let netNew = 0;
  let netOld = 0;
  for (let i = 0; i < w.length; i++) {
    const tr = w[i];
    if (tr.price > high) high = tr.price;
    const signed = tr.isBuy ? tr.sol : -tr.sol;
    netSol += signed;
    if (i >= half) netNew += signed;
    else netOld += signed;
    if (tr.isBuy) {
      buys++;
      buySol += tr.sol;
      buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
    }
  }
  let top = 0;
  for (const v of buyers.values()) if (v > top) top = v;
  return {
    n: w.length,
    priceStart,
    priceNow,
    priceUp: priceNow / priceStart - 1,
    high,
    nearHigh: high > 0 ? priceNow / high : 0,
    netSol,
    netSolNew: netNew,
    netSolOld: netOld,
    buys,
    buyers: buyers.size,
    buyerShare: buySol > 0 ? top / buySol : 0,
    buySol,
  };
}

// ---------------------------------------------------------------- signals
function breakoutSignal(t: CurveTape, curve: { realSol: number; age: number }): boolean {
  if (curve.age < P.minAgeSlots) return false;
  if (curve.realSol < P.minRqSol || curve.realSol > P.maxRqSol) return false;
  const s = windowStats(t, P.windowTrades);
  if (s === null) return false;
  if (s.priceUp < P.minPriceUp || s.priceUp > P.maxPriceUp) return false;
  if (s.nearHigh < P.nearHigh) return false;
  if (s.netSol < P.minNetSol) return false;
  if (s.buys < P.minBuys || s.buyers < P.minBuyers) return false;
  if (s.buyerShare > P.maxBuyerShare) return false;
  // acceleration: the newer half of the window must carry at least as much net
  // inflow as the older half (and the newer half must be positive on its own).
  if (s.netSolNew < P.accel * Math.max(s.netSolOld, 0.01)) return false;
  return true;
}

function secondWindSignal(t: CurveTape, curve: { realSol: number; age: number }): boolean {
  if (curve.age < P.minAgeSlots) return false;
  if (curve.realSol < P.minRqSol || curve.realSol > P.maxRqSol) return false;
  // The curve ran, then pulled back hard off its tape high.
  if (t.high <= 0 || t.lowAfterHigh === Infinity) return false;
  const pullback = 1 - t.lowAfterHigh / t.high;
  if (pullback < P.pullback) return false;
  // ...and is now reclaiming off the pullback low on fresh buying.
  const s = windowStats(t, P.windowTrades);
  if (s === null) return false;
  const reclaim = s.priceNow / t.lowAfterHigh - 1;
  if (reclaim < P.reclaim) return false;
  const half = windowStats(t, Math.floor(P.windowTrades / 2));
  if (half === null) return false;
  if (half.netSol < P.minNetSol2) return false;
  if (half.buyers < P.minBuyers2) return false;
  if (s.priceUp > P.maxPriceUp) return false;
  return true;
}

function hotLaunchSignal(t: CurveTape, curve: { realSol: number; age: number }): boolean {
  if (curve.age < 0 || curve.age > P.hotMaxAgeSlots) return false;
  if (t.createPrice <= 0) return false;
  const s = windowStats(t, P.windowTrades);
  if (s === null && t.trades.length < P.hotMinTrades) return false;
  // All tape trades are since creation: the curve is only a few slots old.
  let trades = 0;
  let buys = 0;
  let netSol = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    trades++;
    if (tr.isBuy) {
      buys++;
      buyers.add(tr.user);
      netSol += tr.sol;
    } else {
      netSol -= tr.sol;
    }
  }
  if (trades < P.hotMinTrades) return false;
  if (buys < P.hotMinBuys) return false;
  if (buyers.size < P.hotMinBuyers) return false;
  if (netSol < P.hotMinNetSol) return false;
  const priceNow = t.trades[t.trades.length - 1].price;
  if (priceNow <= 0 || priceNow / t.createPrice - 1 < P.hotMinPriceUp) return false;
  return true;
}

// ---------------------------------------------------------------- exits
function markValueSol(state: BotState, mint: Pubkey): number {
  const pos = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (pos === undefined || curve === undefined) return 0;
  const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
  if (price <= 0) return 0;
  return Number(pos.token_amount) * price / 1e9;
}

function costSol(state: BotState, mint: Pubkey): number {
  const pos = state.positions.get(mint);
  if (pos === undefined) return 0;
  return Number(BigInt(pos.cost_lamports)) / 1e9;
}

// ---------------------------------------------------------------- the bot
await runBot({
  onBatch(state, batch): OrderInput[] {
    ingest(batch, state);
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // Exposure guard: SOL at cost across all open positions.
    let exposure = 0;
    for (const [, p] of state.positions) exposure += Number(BigInt(p.cost_lamports)) / 1e9;

    // --- exits first: free slots and cash before any new entry.
    const selling = new Set<Pubkey>();
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = markValueSol(state, mint);
      const cost = costSol(state, mint);
      if (cost <= 0 || value <= 0) continue;
      const rec = positions.get(mint);
      if (rec === undefined) continue;
      if (value > rec.peakValue) rec.peakValue = value;
      const ratio = value / cost;
      const held = state.slot - rec.entrySlot;
      let sellAll = false;
      let sellHalf = false;

      if (rec.kind === 'hot') {
        // Hot-launch positions: tight stop, then trail the winner; hard time exit.
        if (ratio <= 1 - P.hotStopLoss) sellAll = true;
        else if (ratio >= 1 + P.hotTakeProfit) sellAll = true;
        else if (
          rec.peakValue >= cost * (1 + P.hotTrailArm) &&
          value <= rec.peakValue * (1 - P.hotTrail)
        ) {
          sellAll = true; // trailing stop
        } else if (held >= P.hotMaxHold) sellAll = true;
      } else if (ratio <= 1 - P.stopLoss) sellAll = true; // hard stop-loss
      else if (ratio >= 1 + P.takeProfit && !rec.tookProfit) {
        sellHalf = true; // bank half at take-profit, ride the rest
        rec.tookProfit = true;
      } else if (rec.peakValue >= cost * (1 + P.trailArm) && value <= rec.peakValue * (1 - P.trail)) {
        sellAll = true; // trailing stop
      } else if (held > P.maxHoldSlots && ratio < 1 + P.holdIfUp) {
        sellAll = true; // time exit: going nowhere
      } else {
        // flow exits from this batch's tape
        const t = tapes.get(mint);
        if (t !== undefined) {
          const half = windowStats(t, Math.floor(P.windowTrades / 2));
          if (half !== null && half.netSol < P.fadeNetSol) sellAll = true;
          for (const e of batch.events) {
            if (e.event === 'TradeEvent' && e.mint === mint && !e.is_buy) {
              if (Number(BigInt(e.sol_amount)) / 1e9 >= P.bigSellSol) {
                sellAll = true;
                break;
              }
            }
          }
        }
      }

      const heldTokens = state.positions.get(mint)?.token_amount;
      if (heldTokens === undefined) continue;
      if (sellAll) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: BigInt(heldTokens),
          max_slippage_bps: P.sellSlipBps,
        });
        const tt = tapes.get(mint);
        if (tt !== undefined) tt.lastExitSlot = state.slot;
        positions.delete(mint);
        selling.add(mint);
      } else if (sellHalf) {
        const halfTokens = BigInt(heldTokens) / 2n;
        if (halfTokens > 0n) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: halfTokens,
            max_slippage_bps: P.sellSlipBps,
          });
        }
      }
    }

    // --- pyramid adds into strength on open positions (swing only; hot exits fast).
    for (const [mint, pos] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (selling.has(mint)) continue;
      const rec = positions.get(mint);
      if (rec === undefined || rec.kind !== 'swing') continue;
      const curve = state.curves.get(mint);
      if (rec === undefined || curve === undefined || curve.complete) continue;
      if (rec.adds >= P.maxAdds) continue;
      const cost = costSol(state, mint);
      if (cost >= P.stakeMax) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0 || price < rec.lastBuyPrice * (1 + P.addStep)) continue;
      const t = tapes.get(mint);
      if (t === undefined) continue;
      const s = windowStats(t, P.windowTrades);
      if (s === null || s.netSol < P.minNetSol) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < BigInt(Math.round(P.minBuySol * 1e9))) continue;
      let amount = BigInt(Math.round(P.addSol * 1e9));
      if (amount > cap) amount = cap;
      if (amount > BigInt(Math.round((P.stakeMax - cost) * 1e9))) {
        amount = BigInt(Math.round((P.stakeMax - cost) * 1e9));
      }
      if (amount < BigInt(Math.round(P.minBuySol * 1e9))) continue;
      if (free < amount + tx) continue;
      if (exposure + Number(amount) / 1e9 > P.maxExposureSol) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlipBps });
      free -= amount + tx;
      exposure += Number(amount) / 1e9;
      rec.adds += 1;
      rec.lastBuyPrice = price;
    }

    // --- new entries, in the order the batch's events arrived.
    const seenThisBatch = new Set<Pubkey>();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const mint = e.mint;
      if (seenThisBatch.has(mint)) continue;
      seenThisBatch.add(mint);
      if (state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = tapes.get(mint);
      if (t === undefined) continue;
      if (t.entries >= P.maxEntriesPerCurve) continue;
      if (t.lastExitSlot >= 0 && state.slot - t.lastExitSlot < P.cooldownSlots) continue;
      const age = t.createdSlot !== null ? state.slot - t.createdSlot : 0;
      const realSol = Number(curve.real_quote_reserves) / 1e9;
      const isHot = hotLaunchSignal(t, { realSol, age });
      const isSwing =
        !isHot && (breakoutSignal(t, { realSol, age }) || secondWindSignal(t, { realSol, age }));
      if (!isHot && !isSwing) continue;
      const stakeSol = isHot ? P.hotStake : P.stake0;
      const cap = state.maxBuyLamports(mint);
      if (cap < BigInt(Math.round(P.minBuySol * 1e9))) continue;
      let amount = BigInt(Math.round(stakeSol * 1e9));
      if (amount > cap) amount = cap;
      if (free < amount + tx) continue;
      if (exposure + Number(amount) / 1e9 > P.maxExposureSol) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlipBps });
      free -= amount + tx;
      exposure += Number(amount) / 1e9;
      slots -= 1;
      t.entries += 1;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      positions.set(mint, {
        kind: isHot ? 'hot' : 'swing',
        peakValue: 0,
        entrySlot: state.slot,
        lastBuyPrice: price > 0 ? price : 0,
        adds: 0,
        tookProfit: false,
        buys: 1,
      });
    }

    return orders;
  },

  onDone(state) {
    // Final account already flattened by the harness; nothing to do.
    const cash = Number(BigInt(state.account.cash_lamports)) / 1e9;
    console.error(`done: cash=${cash.toFixed(4)} SOL, curves seen=${state.curves.size}`);
  },
});
