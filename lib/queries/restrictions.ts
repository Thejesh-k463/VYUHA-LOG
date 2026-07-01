import "server-only";
import { db } from "@/lib/db";
import { restrictedSecurities, trades } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
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

/** Open positions aggregated per underlying symbol (for matching restrictions). */
export function getHeldSymbols(): HeldSymbol[] {
  const rows = db.select().from(trades).where(eq(trades.isOpen, true)).all();
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
