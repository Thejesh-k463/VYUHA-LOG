import "server-only";
import { db } from "@/lib/db";
import { restrictedSecurities, trades } from "@/lib/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getSelectedAccountId } from "./accounts";
import type {
  RestrictedRow,
  HeldSymbol,
  RestrictionCategory,
} from "@/lib/analytics/restrictions";

/** Current restriction list (latest as-of first). */
export function getRestrictedList(): RestrictedRow[] {
  return db
    .select()
    .from(restrictedSecurities)
    .orderBy(desc(restrictedSecurities.asOfDate))
    .all()
    .map((r) => ({
      symbol: r.symbol,
      category: r.category as RestrictionCategory,
      stage: r.stage,
      note: r.note,
      asOfDate: r.asOfDate,
      source: r.source,
    }));
}

/**
 * Replace exactly the categories an uploaded file speaks for, atomically.
 *
 * NSE publishes surveillance data as SEPARATE files (the F&O ban list; the
 * REG_IND indicator file covering ASM/GSM/ESM), so a whole-table replace —
 * what the paste path does, documented on its own button — would make the
 * second upload of the day silently erase the first. Deleting only WHERE
 * category IN (…) lets ban + surveillance uploads and pasted circuit rows
 * coexist. Returns counts for the recap, which reports both.
 */
export function replaceRestrictionCategories(
  categories: RestrictionCategory[],
  rows: RestrictedRow[],
): { deleted: number; inserted: number } {
  let deleted = 0;
  db.transaction((tx) => {
    deleted = tx.delete(restrictedSecurities)
      .where(inArray(restrictedSecurities.category, categories))
      .run().changes;
    for (const r of rows) {
      tx.insert(restrictedSecurities)
        .values({
          symbol: r.symbol,
          category: r.category,
          stage: r.stage ?? null,
          note: r.note ?? null,
          asOfDate: r.asOfDate,
          source: r.source ?? null,
        })
        .run();
    }
  });
  return { deleted, inserted: rows.length };
}

/** Open positions aggregated per underlying symbol (for matching restrictions). */
export function getHeldSymbols(): HeldSymbol[] {
  const accountId = getSelectedAccountId();
  const rows = db.select().from(trades).where(accountId > 0
    ? and(eq(trades.isOpen, true), eq(trades.accountId, accountId))
    : eq(trades.isOpen, true)).all();
  const map = new Map<string, HeldSymbol>();
  for (const t of rows) {
    const key = t.symbol.toUpperCase();
    const cur = map.get(key) ?? { symbol: key, isOpen: false, isFno: false, qty: 0, segments: [] };
    cur.isOpen = cur.isOpen || t.isOpen;
    cur.isFno = cur.isFno || t.instrumentType === "option" || t.instrumentType === "future";
    cur.qty += Math.max(t.buyQty - t.sellQty, 0);
    if (!cur.segments.includes(t.segment)) cur.segments.push(t.segment);
    map.set(key, cur);
  }
  return [...map.values()];
}
