// THE CLOSING LEG A MANUAL CLOSE WRITES (PURE, no DB/React).
//
// v4.3.0 fix wave 2H (H1) taught `closePosition` (lib/import/commit.ts) to close
// a PARTLY closed row by ADDING the exit to the leg already on the closing side —
// a long's sell leg, a short's buy leg — instead of replacing that leg with the
// remainder (100 bought / 60 sold used to close as 100 / 40, and a +5,200 trade
// booked −9,800). The Trades close dialog's live preview kept its own copy of the
// old write, so it priced sell 40 for ₹10,200 while the save stored sell 100 for
// ₹25,200 (seam S1). Both read this one function now, so the preview is the save.
//
// Values are RUPEES (the column converts to paise — invariant 1, never here); the
// average is a level and stays REAL and unrounded.

import { sideOf } from "./side";

/** The legs a close reads. Order counts are REQUIRED (T2): brokerage is per
 *  order, and a caller that could omit them — the Trades wire row once did —
 *  previews a bill the save does not store. A stored 0 reads as the settings
 *  default on a leg gaining its first quantity, else as 1 (V4). */
export interface CloseSource {
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  buyOrderCount: number;
  sellOrderCount: number;
  /** Which side opened the row (migration 0077) — read only through `sideOf`, on a flat row. */
  side?: string | null;
  buyDate?: string | null;
  sellDate?: string | null;
}

export interface CloseRemainder {
  /** A short (`sideOf`: the larger sell leg, or a flat row stated short): the close BUYS to cover. */
  isShort: boolean;
  /** The quantity still open — or the whole position when the row states no remainder. */
  qty: number;
}

export interface ClosingAggregate extends CloseRemainder {
  /** remaining qty × exit price, rounded to the paisa (₹). */
  exitValue: number;
  /** The closing side's new quantity, value (₹), average (REAL) and order count. */
  closeQty: number;
  closeValue: number;
  closeAvg: number;
  closeOrderCount: number;
}

/** settings.defaultBuyOrders / defaultSellOrders — passed IN, so this module stays pure. */
export interface DefaultOrders {
  buyOrders: number;
  sellOrders: number;
}

/** Which side closes, and how much of the position is still open. */
export function closeRemainder(row: Pick<CloseSource, "buyQty" | "sellQty" | "side" | "buyDate" | "sellDate">): CloseRemainder {
  // Short (sell-to-open) has the open leg on sellQty — closing means BUYING to
  // cover, not selling. Long (the common case) closes by selling. v4.6.0 W6: the
  // ONE reading, `sideOf` — a flat row states its side in the `side` column.
  const isShort = sideOf(row) === "short";
  const qty = Math.abs(row.buyQty - row.sellQty) || (isShort ? row.sellQty : row.buyQty);
  return { isShort, qty };
}

/** The quantity already on the closing leg (0 when it is empty or the row states no remainder). */
function closingPriorQty(row: Pick<CloseSource, "buyQty" | "sellQty">, isShort: boolean): number {
  return row.buyQty !== row.sellQty ? (isShort ? row.buyQty : row.sellQty) : 0;
}

/**
 * V4 — true when the closing leg gains its FIRST quantity and stores no order
 * count, so its count is the settings default (`DefaultOrders`), as
 * updateManualTrade and commitManualTrade bill a side that gains quantity. The
 * wire row carries no settings, so a preview OMITS this count and
 * /api/charges/preview fills the same default.
 */
export function closingCountIsDefault(row: CloseSource): boolean {
  const { isShort } = closeRemainder(row);
  return closingPriorQty(row, isShort) === 0 && !(isShort ? row.buyOrderCount : row.sellOrderCount);
}

/**
 * The closing side after an exit of the remaining quantity at `exitPrice`:
 * prior leg + remaining × exit, the weighted average, and the exit as one more
 * order. A row with nothing on its closing side — or one stating no remainder
 * (buyQty === sellQty, where the remainder falls back to the whole position) —
 * keeps the pre-H1 write exactly: the remainder's value, the exit price itself
 * as the average (not value ÷ qty), and the leg's own count — or, when it
 * stores none, the side's settings default (`defaults`; 1 when not passed, V4).
 */
export function closingAggregate(row: CloseSource, exitPrice: number, defaults: DefaultOrders = { buyOrders: 1, sellOrders: 1 }): ClosingAggregate {
  const { isShort, qty } = closeRemainder(row);
  const exitValue = Math.round(exitPrice * qty * 100) / 100;
  const priorQty = closingPriorQty(row, isShort);
  const closeQty = priorQty + qty;
  const closeValue = priorQty > 0 ? Math.round(((isShort ? row.buyValue : row.sellValue) + exitValue) * 100) / 100 : exitValue;
  const closeAvg = priorQty > 0 ? closeValue / closeQty : exitPrice; // a level: REAL, unrounded
  const firstOrders = isShort ? defaults.buyOrders : defaults.sellOrders;
  const closeOrders = (isShort ? row.buyOrderCount : row.sellOrderCount) || (priorQty > 0 ? 1 : firstOrders);
  const closeOrderCount = priorQty > 0 ? closeOrders + 1 : closeOrders;
  return { isShort, qty, exitValue, closeQty, closeValue, closeAvg, closeOrderCount };
}
