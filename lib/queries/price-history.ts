import "server-only";
import { db } from "@/lib/db";
import { priceHistory } from "@/lib/db/schema";
import { asc, desc, eq } from "drizzle-orm";

/** Latest close per symbol from price_history (upper-cased keys). */
export function getLatestCloseMap(): Map<string, number> {
  const rows = db.select().from(priceHistory).orderBy(desc(priceHistory.date)).all();
  const m = new Map<string, number>();
  for (const r of rows) {
    const key = r.symbol.toUpperCase();
    if (!m.has(key)) m.set(key, r.close); // first seen = latest by date
  }
  return m;
}

/** Date-sorted close series for one symbol (ascending). */
export function getCloseHistory(symbol: string): { date: string; close: number }[] {
  return db
    .select({ date: priceHistory.date, close: priceHistory.close })
    .from(priceHistory)
    .where(eq(priceHistory.symbol, symbol.toUpperCase()))
    .orderBy(asc(priceHistory.date))
    .all();
}

/** Coverage summary for the UI status line. */
export function getPriceHistoryMeta(): { symbols: number; rows: number; lastDate: string | null } {
  const rows = db.select({ symbol: priceHistory.symbol, date: priceHistory.date }).from(priceHistory).all();
  const symbols = new Set(rows.map((r) => r.symbol.toUpperCase()));
  const lastDate = rows.reduce<string | null>((mx, r) => (mx == null || r.date > mx ? r.date : mx), null);
  return { symbols: symbols.size, rows: rows.length, lastDate };
}
