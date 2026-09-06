import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { mtmPrices } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";

// ONE scan feeds both maps below: they used to run the identical
// full-table read back to back on /risk and /reports/performance.
const readMtmRows = cache(() => db.select().from(mtmPrices).orderBy(desc(mtmPrices.asOfDate)).all());

/** Latest manual/EOD MTM price per symbol (upper-cased keys). */
export const getMtmMap = cache((): Map<string, number> => {
  const rows = readMtmRows();
  const m = new Map<string, number>();
  for (const r of rows) {
    const key = r.symbol.toUpperCase();
    if (!m.has(key)) m.set(key, r.price); // first = latest by date
  }
  return m;
});

/**
 * Latest underlying SPOT price per symbol — only from rows that look like the
 * cash/equity underlying (tradingsymbol is NOT a derivative scrip). Used to judge
 * option moneyness for physical-settlement; derivative rows hold premiums, not spot.
 */
export const getSpotMap = cache((): Map<string, number> => {
  const rows = readMtmRows();
  const m = new Map<string, number>();
  for (const r of rows) {
    const ts = (r.tradingsymbol ?? "").trim().toUpperCase();
    if (ts.startsWith("OPT ") || ts.startsWith("FUT ")) continue; // skip option/future premium rows
    const key = r.symbol.toUpperCase();
    if (!m.has(key)) m.set(key, r.price);
  }
  return m;
});

/**
 * Write ONE mark the USER TYPED for (symbol, IST day): delete the day's row,
 * then insert. A TYPED MARK IS ALWAYS THE DAY'S MARK (owner ruling, v4.1).
 *
 * WHY A SECOND ROW IS NOT "THE NEWER PRICE". Every reader of `mtm_prices` —
 * the two maps above, `indexMarks()` in `lib/quotes/manual.ts`, and the
 * surfaces behind them — orders by `as_of_date DESC` with NO tiebreak and
 * takes the FIRST row per symbol, which SQLite then returns in rowid order.
 * So an extra row for a (symbol, day) that already has one is the row nobody
 * reads, for ever: a mark typed into the risk dialog AFTER the automatic
 * 15:31 write was stored and then silently ignored by every figure on screen.
 * A reader-side tiebreak would not fix it either — it would only move the
 * question to eleven call sites instead of the two writers.
 *
 * The shape is the one `lib/quotes/persist-mark.ts` and
 * `lib/import/mtm-bhavcopy.ts` already use, in ONE transaction so no reader
 * can observe the day with no mark at all. The live door keeps its own
 * skip-a-held-row rule, so a mark typed BEFORE the close still wins the day:
 * the user's number replaces the feed's, never the other way round.
 *
 * MONEY: `price` is REAL RUPEES — a per-unit price, invariant 1's documented
 * exception. Nothing here converts.
 */
export function writeTypedMark(mark: {
  symbol: string;
  tradingsymbol?: string | null;
  price: number;
  /** The IST day the mark belongs to (`todayIstIso()`), never a UTC one. */
  asOfDate: string;
}): void {
  // A mark is a price. Zero or a negative number is not one, and because this
  // write REPLACES the day's row, letting it through would delete a real mark
  // and print −100 % on every figure that reads it (the seam pass for fix wave
  // 3 did exactly that with a typed 0). The live door refuses `ltp <= 0` for
  // the same reason (invariant 6); the two typed doors check before calling,
  // and this throw is the backstop for any third caller.
  if (!Number.isFinite(mark.price) || mark.price <= 0) {
    throw new RangeError(`A mark is a price above zero; got ${String(mark.price)}.`);
  }
  const symbol = mark.symbol.trim().toUpperCase();
  db.transaction((tx) => {
    // A caller that does not know the tradingsymbol (the equity paste keys
    // only on the symbol) must not blank the one the feed recorded: the
    // manual provider answers a streaming key by tradingsymbol, so a NULL here
    // made the position unpriceable for the desk. Carry the held row's value.
    const held = tx
      .select({ tradingsymbol: mtmPrices.tradingsymbol })
      .from(mtmPrices)
      .where(and(eq(mtmPrices.symbol, symbol), eq(mtmPrices.asOfDate, mark.asOfDate)))
      .limit(1)
      .get();
    const tradingsymbol = mark.tradingsymbol === undefined ? (held?.tradingsymbol ?? null) : mark.tradingsymbol;
    tx.delete(mtmPrices).where(and(eq(mtmPrices.symbol, symbol), eq(mtmPrices.asOfDate, mark.asOfDate))).run();
    tx.insert(mtmPrices).values({ symbol, tradingsymbol, price: mark.price, asOfDate: mark.asOfDate }).run();
  });
}
