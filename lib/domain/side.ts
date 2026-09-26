// WHICH SIDE OPENED A TRADE ROW (PURE, no DB/React) — v4.6.0 W6, migration 0077.
//
// Direction used to be re-derived at ~40 sites as `sellQty > buyQty` (or
// `buyQty >= sellQty`, `buyDate <= sellDate`, `readsLong`). A FULLY-CLOSED row
// is flat (`sellQty === buyQty`), so every closed short read as a long unless
// the site remembered to patch around it with the dates. `trades.side` answers
// the ONE question a row cannot: which side opened a FLAT row.
//
// THE RULE (contract D2): quantities first, the stored column only on a FLAT
// row. A lopsided row is self-describing and its quantities WIN — which is what
// makes an IPO link or a basis write safe: after `setAcquisitionAction` writes
// `buyQty = sellQty` the row is flat and the writer's 'long' is read; before it,
// the quantities say short and nothing else matters.
//
// A NULL column (a row written before 0077 that the `trades-side-v1` data fix
// has not reached yet, a pre-W6 Trash envelope) falls back to `backfillSide` —
// the SAME function the data fix writes with, so a reader and the fix can never
// disagree about one row.
//
// NO SIGNAL IS NO SIDE (fix wave, finding 2): a flat row that is same-day or
// undated and carries no intraday-short note states nothing, so `backfillSide`
// answers null and the data fix leaves the column NULL. `sideOf` then reads it
// long — the pre-W6 reading, unchanged — while `statedSideOf` says null, and a
// reader that must not guess (the stop-migration direction map) uses that.
//
// `tests/side-column.test.ts` scans lib/ app/ components/ scripts/ and fails on
// a direction comparison anywhere but here.

import { normalizeDate } from "./trading-day";

export type Side = "long" | "short";

/**
 * The one fixed note a covered INTRADAY short carries (pair-legs.ts reads it off
 * file order). Defined here so the backfill can read it without lib/domain
 * importing lib/import; `lib/import/pair-legs.ts` re-exports it.
 */
export const INTRADAY_SHORT_NOTE =
  "Intraday short: sold before buying on the same day, covered by the later buy.";

/**
 * The note an OVERNIGHT F&O short carries (v4.6.0 W6, contract D4): a sell with
 * no long lot to consume, covered by a LATER buy of the same contract in the same
 * file. It names the other reading, because the file cannot rule it out.
 */
export const OVERNIGHT_SHORT_NOTE =
  "Overnight short: sold before buying, covered by a later buy of the same contract in this file. The other reading — held before this file, sold, re-bought — would make this an opening sale plus an open long; if that is what happened, edit the legs.";

/** The slice of a row the side reading needs. Structural: a Trade, a SlimTrade,
 *  a NormalizedTrade or a raw fixture all satisfy it. */
export interface SideInput {
  buyQty: number;
  sellQty: number;
  side?: string | null;
  buyDate?: string | null;
  sellDate?: string | null;
  /** Stored joined by " | " (commit.ts) or as the parser's array. */
  importNotes?: string | string[] | null;
}

const isSide = (s: unknown): s is Side => s === "long" || s === "short";

function notesHave(notes: SideInput["importNotes"], marker: string): boolean {
  if (!notes) return false;
  return Array.isArray(notes) ? notes.some((n) => n.includes(marker)) : notes.includes(marker);
}

/**
 * The side a row states WITHOUT its column — what the `trades-side-v1` data fix
 * writes and what `sideOf` falls back to on a NULL.
 *
 *   1. lopsided: the larger leg opened it;
 *   2. flat with two dates: the EARLIER one opened it — compared as the ISO day
 *      each states (`normalizeDate`), never as bytes: a 4.2.x row holds
 *      'DD-MM-YYYY' and a same-day ISO row can carry a time suffix;
 *   3. flat, same day or undated: `INTRADAY_SHORT_NOTE` → short (the only trace
 *      a same-day covered short leaves), otherwise NULL — no signal is no side.
 *      Writing 'long' there would make a guess read as stated, and an old
 *      intraday short from before the note would be a stated long.
 */
export function backfillSide(t: SideInput): Side | null {
  if (t.sellQty > t.buyQty) return "short";
  if (t.buyQty > t.sellQty) return "long";
  const b = normalizeDate(t.buyDate ?? null);
  const s = normalizeDate(t.sellDate ?? null);
  if (b && s && s !== b) return s < b ? "short" : "long";
  return notesHave(t.importNotes, INTRADAY_SHORT_NOTE) ? "short" : null;
}

/**
 * The side a row STATES — its quantities on a lopsided row, else the column,
 * else a signal its legs or notes carry (`backfillSide`) — or null when it
 * states none. For a reader that must not guess.
 */
export function statedSideOf(t: SideInput): Side | null {
  if (t.buyQty !== t.sellQty) return t.sellQty > t.buyQty ? "short" : "long";
  return isSide(t.side) ? t.side : backfillSide(t);
}

/** THE reader: quantities on a lopsided row, the stored side on a flat one; a
 *  flat row that states none reads long (the pre-W6 reading). */
export function sideOf(t: SideInput): Side {
  return statedSideOf(t) ?? "long";
}

export const isShortSide = (t: SideInput): boolean => sideOf(t) === "short";
export const isLongSide = (t: SideInput): boolean => sideOf(t) === "long";

/** The opening leg's date (a short opens on its sale). */
export function entryDateOf(t: SideInput): string | null {
  return (sideOf(t) === "short" ? t.sellDate : t.buyDate) ?? null;
}

/** The closing leg's date (a short closes on its buy-back). */
export function exitDateOf(t: SideInput): string | null {
  return (sideOf(t) === "short" ? t.buyDate : t.sellDate) ?? null;
}

export interface LegView {
  price: number;
  qty: number;
  date: string | null;
}

type PricedInput = SideInput & { avgBuyPrice: number; avgSellPrice: number };

const buyLeg = (t: PricedInput): LegView => ({ price: t.avgBuyPrice, qty: t.buyQty, date: t.buyDate ?? null });
const sellLeg = (t: PricedInput): LegView => ({ price: t.avgSellPrice, qty: t.sellQty, date: t.sellDate ?? null });

/** The opening leg: price, quantity and date, by side. */
export function entryLegOf(t: PricedInput): LegView {
  return sideOf(t) === "short" ? sellLeg(t) : buyLeg(t);
}

/** The closing leg: price, quantity and date, by side. */
export function exitLegOf(t: PricedInput): LegView {
  return sideOf(t) === "short" ? buyLeg(t) : sellLeg(t);
}

/**
 * The side an EDITED row keeps (contract D3, rule R-7): lopsided → the quantity
 * rule; flat with two different (normalised) dates → the date rule; flat and
 * same-day or undated → the side it was stored with. So an opening sell given
 * its buy leg in the editor reads long when the buy precedes the sale, and a
 * wrong side on a flat row is fixed by editing its legs.
 *
 * NO SIGNAL IS NO SIDE here too (v4.6.0 fix wave, MO-2 / design review A6): the
 * last branch answers what the stored row STATES (`statedSideOf`), so a flat,
 * same-day row that states nothing stays NULL through an editor save or a
 * same-day re-pull supersede — exactly what the `trades-side-v1` backfill leaves.
 * Answering `sideOf(stored)` there wrote a guessed 'long' as a stated one, and
 * the stop-migration direction map then read it as a fact.
 */
export function sideAfterEdit(next: SideInput, stored: SideInput): Side | null {
  if (next.buyQty !== next.sellQty) return next.sellQty > next.buyQty ? "short" : "long";
  const b = normalizeDate(next.buyDate ?? null);
  const s = normalizeDate(next.sellDate ?? null);
  if (b && s && s !== b) return s < b ? "short" : "long";
  return statedSideOf(stored);
}
