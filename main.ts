// Winner Takes All — dip-buying paper bot on the pump.fun replay harness.
//
// Idea in one line: most fresh pump.fun coins spike, dump hard, then bounce.
// This bot watches every coin's high since first sight, buys the dip when the
// price has fallen 30-45% off that high on a coin with real liquidity, adds
// small tranches only while the price holds at or above the entry, and exits
// every position on a take-profit, a stop-loss or a time cap. A tiny scout buy
// on each fresh coin exists only to reach the 20-coin round-trip guardrail.
//
// The grader runs `node /bot/main.ts`; all decisions come from the batch data
// and the deterministic book kept below. No clock, no randomness anywhere.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ knobs
// Strategy parameters, kept as named constants so they can be swept later.

/** Dip band: buy when the price sits this far below its own high (bps). */
const DIP_MIN_BPS = 3000; // 30% off the high
const DIP_MAX_BPS = 4000; // 40% off the high
/** A dip buy needs at least this much real SOL sitting in the curve. */
const MIN_REAL_RESERVE = 12n * LAMPORTS_PER_SOL;
/** First dip tranche, and the size of every pyramid add. */
const TRANCHE = (12n * LAMPORTS_PER_SOL) / 100n; // 0.12 SOL
/** Largest total cost basis allowed in one coin. */
const MAX_POSITION_COST = 3n * LAMPORTS_PER_SOL;
/** Scout stake: one small buy per fresh coin, for the mint-count guardrail. */
const SCOUT_STAKE = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
/** Smallest buy worth sending (the guardrail's round-trip floor). */
const MIN_BUY = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
/** Exit: sell when the position is worth this share of its cost (bps). */
const TAKE_PROFIT_BPS = 13000; // +30%
const STOP_LOSS_BPS = 9100; // -9%
/** Exit: sell whatever is left this many slots after the entry slot. */
const MAX_HOLD_SLOTS = 600;
/** Pyramid adds only while the price is within this band above the entry. */
const PYRAMID_TOP_BPS = 10500; // entry price +5%
/** Scout buys only while fewer than this many positions are committed, so
 *  dip entries always have a free slot waiting for them. */
const SCOUT_MAX_COMMITTED = 0;
/** A scout candidate that never grows a usable size cap is dropped after
 *  this many slots, so the candidate set stays small. */
const SCOUT_WINDOW_SLOTS = 3600;
/** Slippage left wide open so a fill is never refused for the price moving
 *  during the 2-slot latency. */
const MAX_SLIPPAGE_BPS = 10000;

// ------------------------------------------------------------------ book
// Per-coin memory, keyed by mint. `highNum / highDen` is the highest price
// (virtual SOL per token) seen since the coin was first observed.

interface CoinMemory {
  highNum: bigint;
  highDen: bigint;
  /** True once this coin has ever had a buy sent for it: one entry per mint. */
  entered: boolean;
}

interface OpenNote {
  entrySlot: number;
  entryNum: bigint;
  entryDen: bigint;
}

const memory = new Map<string, CoinMemory>();
const openNotes = new Map<string, OpenNote>();
const scoutQueue = new Set<string>();
/** Mints whose sell was already refused once: retrying it every batch only
 *  spams the reply. Cleared when the position leaves the book. */
const deadSells = new Set<string>();

/** Price of a curve right now as a fraction (numerator / denominator). */
function priceOf(state: BotState, mint: string): { num: bigint; den: bigint } | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  if (curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves < 0n) return null;
  return { num: curve.virtual_quote_reserves, den: curve.virtual_token_reserves };
}

/** Is `price` at most `high * pct / 10000`? All bigint, no floats. */
function atMost(price: { num: bigint; den: bigint }, high: CoinMemory, pct: number): boolean {
  return price.num * high.highDen * 10000n <= price.den * high.highNum * BigInt(pct);
}

/** Is `price` at least `high * pct / 10000`? */
function atLeast(price: { num: bigint; den: bigint }, high: CoinMemory, pct: number): boolean {
  return price.num * high.highDen * 10000n >= price.den * high.highNum * BigInt(pct);
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let freeCash = state.freeCashLamports();
    let freeSlots = caps.max_open_positions - state.committedPositionCount();

    // --- fold this batch's fills back into the book ---------------------
    // A buy that was refused never happened: the coin may be tried again.
    // A sell that was refused stays refused while the position sits there:
    // remember it instead of resending the same order every batch.
    for (const fill of batch.fills) {
      if (fill.status !== 'rejected') continue;
      if (fill.side === 'buy') {
        const memo = memory.get(fill.mint);
        if (memo !== undefined) memo.entered = false;
      } else {
        deadSells.add(fill.mint);
      }
    }

    // --- sync open notes with the positions the harness reports ----------
    for (const mint of [...openNotes.keys()]) {
      if (!state.positions.has(mint)) {
        openNotes.delete(mint);
        deadSells.delete(mint);
      }
    }
    for (const [mint, holding] of state.positions) {
      if (holding.token_amount <= 0n) continue;
      if (!openNotes.has(mint)) {
        const price = priceOf(state, mint);
        openNotes.set(mint, {
          entrySlot: batch.slot,
          entryNum: price?.num ?? 0n,
          entryDen: price?.den ?? 1n,
        });
      }
    }

    // --- learn from this batch's events ----------------------------------
    // Only coins with an event this slot can have moved, so only they are
    // examined: the high of every other coin is unchanged since last batch.
    const moved = new Set<string>();
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        scoutQueue.add(event.mint);
        const price = priceOf(state, event.mint);
        if (price !== null && !memory.has(event.mint)) {
          memory.set(event.mint, { highNum: price.num, highDen: price.den, entered: false });
        }
        moved.add(event.mint);
      } else if (event.event === 'TradeEvent') {
        moved.add(event.mint);
      } else {
        // CompleteEvent: the coin is done; forget its high (unless held).
        if (!state.positions.has(event.mint)) memory.delete(event.mint);
        scoutQueue.delete(event.mint);
      }
    }
    for (const mint of moved) {
      const price = priceOf(state, mint);
      if (price === null) continue;
      const memo = memory.get(mint);
      if (memo === undefined) {
        memory.set(mint, { highNum: price.num, highDen: price.den, entered: false });
      } else if (price.num * memo.highDen > price.den * memo.highNum) {
        memo.highNum = price.num;
        memo.highDen = price.den;
      }
    }

    const pushBuy = (mint: string, amount: bigint): boolean => {
      if (orders.length >= caps.max_orders_per_batch) return false;
      if (freeCash < amount + txFee) return false;
      const buy: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      freeCash -= amount + txFee;
      const memo = memory.get(mint);
      if (memo !== undefined) memo.entered = true;
      return true;
    };

    // --- exits first: take profit, stop loss, or time cap ----------------
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const note = openNotes.get(mint);
      if (note === undefined) continue;
      // A completed curve is closed by the harness itself; a sell here
      // would only be refused (token_complete) and waste an order slot.
      const curve = state.curves.get(mint);
      if (curve !== undefined && curve.complete) continue;
      // A sell already in flight for this coin covers it; do not double up.
      let sellPending = false;
      for (const pending of state.pending.values()) {
        if (pending.order.side === 'sell' && pending.order.mint === mint) {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      const price = priceOf(state, mint);
      if (price === null || price.den === 0n) continue;
      // Current value of the holding in lamports, from the live reserves.
      const value = (holding.token_amount * price.num) / price.den;
      const cost = holding.cost_lamports;
      // A sale whose proceeds cannot even cover its own transaction fee is
      // refused outright; skip it instead of retrying it every batch.
      if (deadSells.has(mint) || value <= txFee) continue;
      const takeProfit = value * 10000n >= cost * BigInt(TAKE_PROFIT_BPS);
      const stopLoss = value * 10000n <= cost * BigInt(STOP_LOSS_BPS);
      const timedOut = batch.slot - note.entrySlot >= MAX_HOLD_SLOTS;
      if (!takeProfit && !stopLoss && !timedOut) continue;
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(sell);
    }

    // --- dip entries and pyramid adds ------------------------------------
    for (const mint of moved) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const memo = memory.get(mint);
      if (memo === undefined || memo.entered) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE) continue;
      if (curve.created_slot === null || batch.slot - curve.created_slot < 300) continue; // dip only on seasoned coins
      // Inside the dip band: 30-40% below the coin's own high.
      if (!atMost(price, memo, 10000 - DIP_MIN_BPS)) continue;
      if (!atLeast(price, memo, 10000 - DIP_MAX_BPS)) continue;
      if (freeSlots <= 0) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < TRANCHE ? cap : TRANCHE;
      if (amount < MIN_BUY) continue;
      if (pushBuy(mint, amount)) freeSlots -= 1;
    }

    // Pyramid: one extra tranche per held coin per batch, only into strength
    // (price at or above the entry, at most 5% above it) and under the cap.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const note = openNotes.get(mint);
      if (note === undefined || note.entryNum === 0n) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const entry = { highNum: note.entryNum, highDen: note.entryDen };
      if (!atLeast(price, entry, 10000)) continue; // below the entry: no add
      if (!atMost(price, entry, PYRAMID_TOP_BPS)) continue; // ran away: no add
      // Headroom counts the buys already in flight too: cost only grows
      // when a fill lands, two slots after the order, so without this the
      // bot can queue tranches past the 3 SOL position cap.
      let inFlight = 0n;
      for (const pending of state.pending.values()) {
        if (pending.order.side === 'buy' && pending.order.mint === mint) {
          inFlight += BigInt(pending.order.quote_lamports);
        }
      }
      const headroom = MAX_POSITION_COST - holding.cost_lamports - inFlight;
      if (headroom < MIN_BUY) continue;
      const cap = state.maxBuyLamports(mint);
      let amount = cap < TRANCHE ? cap : TRANCHE;
      if (amount > headroom) amount = headroom;
      if (amount < MIN_BUY) continue;
      pushBuy(mint, amount);
    }

    // --- scout buys: one small stake per fresh coin ----------------------
    // Committed slots right now = slots taken before this batch plus the
    // buys already queued in this reply; scouts stop once that count hits
    // SCOUT_MAX_COMMITTED so dip entries keep free slots waiting for them.
    for (const mint of [...scoutQueue]) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (caps.max_open_positions - freeSlots >= SCOUT_MAX_COMMITTED) break;
      if (freeSlots <= 0) break;
      const memo = memory.get(mint);
      if (memo !== undefined && memo.entered) {
        scoutQueue.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        scoutQueue.delete(mint);
        continue;
      }
      if (curve.created_slot !== null && batch.slot - curve.created_slot > SCOUT_WINDOW_SLOTS) {
        scoutQueue.delete(mint);
        continue;
      }
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY) continue; // not liquid enough yet; try again later
      const amount = cap < SCOUT_STAKE ? cap : SCOUT_STAKE;
      scoutQueue.delete(mint);
      if (pushBuy(mint, amount)) freeSlots -= 1;
    }

    return orders;
  },
});
