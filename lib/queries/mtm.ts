import "server-only";
import { db } from "@/lib/db";
import { mtmPrices } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

/** Latest manual/EOD MTM price per symbol (upper-cased keys). */
export function getMtmMap(): Map<string, number> {
  const rows = db.select().from(mtmPrices).orderBy(desc(mtmPrices.asOfDate)).all();
  const m = new Map<string, number>();
  for (const r of rows) {
    const key = r.symbol.toUpperCase();
    if (!m.has(key)) m.set(key, r.price); // first = latest by date
  }
  return m;
}

/**
 * Latest underlying SPOT price per symbol — only from rows that look like the
 * cash/equity underlying (tradingsymbol is NOT a derivative scrip). Used to judge
 * option moneyness for physical-settlement; derivative rows hold premiums, not spot.
 */
export function getSpotMap(): Map<string, number> {
  const rows = db.select().from(mtmPrices).orderBy(desc(mtmPrices.asOfDate)).all();
  const m = new Map<string, number>();
  for (const r of rows) {
    const ts = (r.tradingsymbol ?? "").trim().toUpperCase();
    if (ts.startsWith("OPT ") || ts.startsWith("FUT ")) continue; // skip option/future premium rows
    const key = r.symbol.toUpperCase();
    if (!m.has(key)) m.set(key, r.price);
  }
  return m;
}
