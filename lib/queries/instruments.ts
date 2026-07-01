import "server-only";
import { db } from "@/lib/db";
import { instruments } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import { buildSectorMap } from "@/lib/analytics/instruments";

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

/** symbol (upper) → sector, for instruments that carry a sector. */
export function getSectorMap(): Map<string, string> {
  return buildSectorMap(getInstruments());
}

/** Coverage summary for the manager status line. */
export function getInstrumentMeta(): { count: number; withSector: number } {
  const rows = getInstruments();
  return { count: rows.length, withSector: rows.filter((r) => r.sector).length };
}
