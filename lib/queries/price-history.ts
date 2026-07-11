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

/** Per-symbol daily-return series for a set of tickers (P1.2 VaR/beta inputs). */
export function getReturnsMap(symbols: string[]): Map<string, { date: string; ret: number }[]> {
  const out = new Map<string, { date: string; ret: number }[]>();
  for (const raw of symbols) {
    const sym = raw.toUpperCase();
    if (out.has(sym)) continue;
    const closes = getCloseHistory(sym);
    if (closes.length < 2) continue;
    const rets: { date: string; ret: number }[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1].close > 0) rets.push({ date: closes[i].date, ret: closes[i].close / closes[i - 1].close - 1 });
    }
    out.set(sym, rets);
  }
  return out;
}

/** Date-sorted OHLC bars per symbol (ascending) for a set of tickers (MAE/MFE). */
export function getBarsMap(
  symbols: string[],
): Map<string, { date: string; high: number | null; low: number | null; close: number }[]> {
  const out = new Map<string, { date: string; high: number | null; low: number | null; close: number }[]>();
  for (const raw of symbols) {
    const sym = raw.toUpperCase();
    if (out.has(sym)) continue;
    const bars = db
      .select({ date: priceHistory.date, high: priceHistory.high, low: priceHistory.low, close: priceHistory.close })
      .from(priceHistory)
      .where(eq(priceHistory.symbol, sym))
      .orderBy(asc(priceHistory.date))
      .all();
    if (bars.length > 0) out.set(sym, bars);
  }
  return out;
}

/** Coverage summary for the UI status line. */
export function getPriceHistoryMeta(): { symbols: number; rows: number; lastDate: string | null } {
  const rows = db.select({ symbol: priceHistory.symbol, date: priceHistory.date }).from(priceHistory).all();
  const symbols = new Set(rows.map((r) => r.symbol.toUpperCase()));
  const lastDate = rows.reduce<string | null>((mx, r) => (mx == null || r.date > mx ? r.date : mx), null);
  return { symbols: symbols.size, rows: rows.length, lastDate };
}
