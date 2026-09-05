import "server-only";
import { db } from "@/lib/db";
import { instruments, instrumentIndices } from "@/lib/db/schema";
import { asc, inArray } from "drizzle-orm";
import {
  buildSectorMap,
  buildSectorResolution,
  taxonomyEntries,
  type SectorResolution,
  type SectorSources,
} from "@/lib/analytics/instruments";
import { bundledIsinBySymbol, bundledSymbolByIsin } from "@/lib/import/isin-symbol";
import nseIndexMap from "@/lib/data/nse-index-map.json";
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

/**
 * The bundled sources behind the sector chain. Reference data, not account
 * data — a sector is a fact about the market, not about one book.
 *
 *   user instruments.sector → taxonomy by ISIN (sector-map.json) → index map
 *
 * The taxonomy's ISINs are re-keyed to the ticker every other surface uses
 * through the listing snapshot (NSE wins a dual listing); an untagged user
 * row reaches the taxonomy through its own ISIN or the snapshot's.
 */
function sectorSources(): SectorSources {
  return {
    taxonomy: taxonomyEntries(),
    index: (nseIndexMap as { symbols?: SectorSources["index"] }).symbols ?? {},
    symbolByIsin: bundledSymbolByIsin,
    isinBySymbol: bundledIsinBySymbol,
  };
}

/**
 * symbol (upper) → sector, for every symbol the chain can classify: the
 * user's tagged instruments, every ISIN in the bundled taxonomy, and every
 * index constituent. Labels are canonical (aliases applied), so the legacy
 * "AUTOMOBILE" and the modern "Automobile and Auto Components" are one bucket.
 */
export function getSectorMap(): Map<string, string> {
  return buildSectorMap(getInstruments(), sectorSources());
}

/** Same chain, with WHERE each sector came from and how confident the source was. */
export function getSectorResolution(): Map<string, SectorResolution> {
  return buildSectorResolution(getInstruments(), sectorSources());
}

/** Coverage summary for the manager status line. */
export function getInstrumentMeta(): { count: number; withSector: number } {
  const rows = getInstruments();
  return { count: rows.length, withSector: rows.filter((r) => r.sector).length };
}

/**
 * ISIN (upper) → symbol, for the ISINs asked about. Reference data — not
 * account-scoped, the same as `getIndexMembershipMap` below: an instrument is
 * a fact about the market, not about one book.
 *
 * Exists because Paytm Money's tradebook states a numeric SCRIP CODE in place
 * of a ticker; the ISIN it does state is what turns that code back into a
 * symbol (lib/import/isin-symbol.ts). Chunked because SQLite caps the number
 * of bound parameters in one statement.
 */
export function getSymbolsByIsin(isins: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const wanted = [...new Set(isins.map((s) => String(s ?? "").trim().toUpperCase()).filter(Boolean))];
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    const rows = db
      .select({ symbol: instruments.symbol, isin: instruments.isin })
      .from(instruments)
      .where(inArray(instruments.isin, chunk))
      .all();
    for (const r of rows) {
      const key = String(r.isin ?? "").trim().toUpperCase();
      // First writer wins — two symbols on one ISIN would make the answer
      // depend on row order, and a stable wrong answer is easier to report
      // than an unstable one.
      if (key && r.symbol && !out.has(key)) out.set(key, r.symbol);
    }
  }
  return out;
}

/** SEBI-style size bucket, from NSE's own index membership (Q47). */
export type CapBand = "large" | "mid" | "small" | "micro";

/**
 * ISIN (upper) → cap band, for every symbol the bundled map can classify.
 *
 * Reference data, not account data — a company's size bucket is a fact about
 * the market. Read-only: a fresh Map each call, so a caller that mutates the
 * result cannot poison the bundled snapshot for the rest of the process.
 *
 * Keyed by ISIN because a ticker is not an identity (NSE reuses one across a
 * rename) and every caller that wants a cap band — positions, Atlas — already
 * carries the ISIN. "unclassified" symbols (in Nifty 200/500 but in none of the
 * four band-defining lists) are OMITTED rather than shipped as a band: an
 * absent key says "we do not know", which is the truth, and invariant 6 says
 * not to fabricate the alternative.
 *
 * The bands are effective-dated in the file itself (`sizeIndices[*]
 * .effective_at` / `.captured_at`, Q50) — this is the CURRENT classification,
 * never a point-in-time one, and any UI that shows it must say so.
 */
export function getCapBandMap(): Map<string, CapBand> {
  const out = new Map<string, CapBand>();
  const rows = (nseIndexMap as { symbols?: Record<string, { isin?: string | null; capBand?: string }> }).symbols ?? {};
  for (const v of Object.values(rows)) {
    const isin = String(v.isin ?? "").trim().toUpperCase();
    const band = v.capBand;
    if (!isin || !band || band === "unclassified") continue;
    if (band === "large" || band === "mid" || band === "small" || band === "micro") {
      // First writer wins, same as getSymbolsByIsin: a stable answer beats one
      // that depends on key order.
      if (!out.has(isin)) out.set(isin, band);
    }
  }
  return out;
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
