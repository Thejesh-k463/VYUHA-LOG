import "server-only";
import { db } from "@/lib/db";
import { instruments, instrumentIndices } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import { buildSectorMap } from "@/lib/analytics/instruments";
import { INDEX_UNDERLYINGS } from "@/lib/domain/constants";

export interface InstrumentDisplay {
  id: number;
  symbol: string;
  name: string | null;
  sector: string | null;
  lotSize: number | null;
  isin: string | null;
}

export function getInstruments(): InstrumentDisplay[] {
  return db
    .select()
    .from(instruments)
    .orderBy(asc(instruments.symbol))
    .all()
    .map((r) => ({ id: r.id, symbol: r.symbol, name: r.name, sector: r.sector, lotSize: r.lotSize, isin: r.isin }));
}

/**
 * Market lots for the index UNDERLYINGS only, for the calculator's picker.
 *
 * A tiny fixed set — passed as a server prop from app/calculator/page.tsx
 * rather than a GET route (the free-typed-symbol space that justified
 * /api/mtf-margin's fetch does not exist here). The user's fo_mktlots.csv
 * upload lands in this table, so a row here beats the bundled snapshot in
 * lib/domain/index-contracts.ts.
 */
export function getIndexLotSizes(): Record<string, { lotSize: number; asOf: string }> {
  const wanted = new Set<string>(INDEX_UNDERLYINGS);
  const out: Record<string, { lotSize: number; asOf: string }> = {};
  for (const r of db.select().from(instruments).all()) {
    if (wanted.has(r.symbol) && r.lotSize != null && r.lotSize > 0) {
      // updatedAt dates the user's upload — the caption says WHEN the number
      // was last refreshed, same courtesy the bundled snapshot gets.
      out[r.symbol] = { lotSize: r.lotSize, asOf: r.updatedAt.slice(0, 10) };
    }
  }
  return out;
}

/** symbol (upper) → sector, for instruments that carry a sector. */
export function getSectorMap(): Map<string, string> {
  return buildSectorMap(getInstruments());
}

/** Coverage summary for the manager status line. */
export function getInstrumentMeta(): { count: number; withSector: number } {
  const rows = getInstruments();
  return { count: rows.length, withSector: rows.filter((r) => r.sector).length };
}

/** symbol (upper) → thematic index names. Reference data — not account-scoped. */
export function getIndexMembershipMap(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of db.select().from(instrumentIndices).all()) {
    const cur = out.get(r.symbol) ?? [];
    cur.push(r.indexName);
    out.set(r.symbol, cur);
  }
  return out;
}
