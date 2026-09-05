import "server-only";
import { manualQuoteFromMark, type StoredMark } from "./mapping";
import {
  quoteKeyId,
  type ProviderCapabilities,
  type ProviderHealth,
  type QuoteKey,
  type QuoteMap,
  type QuoteProvider,
  type Unsubscribe,
} from "./types";

/**
 * ManualMarkProvider — the marks the user typed, read back as quotes.
 *
 * WHERE THE MARKS LIVE, and why this file does not invent a table: a typed
 * mark is already persisted in `mtm_prices` (schema.ts:666, "manual / EOD
 * price entry"), written by `app/api/positions/risk/route.ts:60-65` from the
 * risk dialog and by the bhavcopy paste panel, and read back by
 * `deriveOpenPositions()` through `getMtmMap()` with the precedence
 * `mtm[symbol] → mtm[tradingsymbol] → trades.closingPrice`. v4.0 adds no
 * storage for marks; W0's migration `0064` extends `risk_config` only. So this
 * provider READS the existing table and writes nothing — the write path stays
 * the existing `/api/positions/*` routes, which already audit and revalidate.
 *
 * It reads `mtm_prices` directly rather than through `lib/queries/mtm.ts`
 * because `getMtmMap()` projects the price away from its `as_of_date`, and
 * `asOf` on a Quote must be when the price was true at the source (03D §1.2).
 * `lib/queries/mtm.ts` belongs to no wave in v4.0, so the same
 * "latest as_of_date wins" rule is repeated here rather than edited there;
 * fold the two together when a wave owns that file.
 *
 * SERVER-ONLY, and `@/lib/db` is imported LAZILY inside the reader: a static
 * import would bind the SQLite connection at module-import time and break
 * `tests/helpers/temp-db.ts` for every test that so much as touches the
 * registry.
 */

export interface ManualMarkRow {
  symbol: string;
  tradingsymbol: string | null;
  price: number;
  asOfDate: string;
}

/** Injected in tests; the default reads `mtm_prices`. */
export type ManualMarkReader = () => Promise<ManualMarkRow[]>;

export const MANUAL_CAPABILITIES: ProviderCapabilities = {
  id: "manual",
  label: "My typed marks",
  streaming: false,
  maxSubscriptions: 0,
  minSnapshotIntervalMs: 0,
  depth: 0,
  segments: ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"],
  staleness: "manual",
  requiresDailyAuth: false,
  egressDescription: "None. Reads only the marks you typed, from the database on this machine.",
};

async function readManualMarksFromDb(): Promise<ManualMarkRow[]> {
  const { db } = await import("@/lib/db");
  const { mtmPrices } = await import("@/lib/db/schema");
  const { desc } = await import("drizzle-orm");
  return db
    .select({
      symbol: mtmPrices.symbol,
      tradingsymbol: mtmPrices.tradingsymbol,
      price: mtmPrices.price,
      asOfDate: mtmPrices.asOfDate,
    })
    .from(mtmPrices)
    .orderBy(desc(mtmPrices.asOfDate))
    .all();
}

/** Latest mark per symbol AND per tradingsymbol — same precedence as `getMtmMap()`. */
export function indexMarks(rows: readonly ManualMarkRow[]): {
  bySymbol: Map<string, StoredMark>;
  byTradingsymbol: Map<string, StoredMark>;
} {
  const bySymbol = new Map<string, StoredMark>();
  const byTradingsymbol = new Map<string, StoredMark>();
  for (const r of rows) {
    // Rows arrive newest-first, so the FIRST row seen for a key is the latest.
    const sym = r.symbol.trim().toUpperCase();
    if (sym && !bySymbol.has(sym)) bySymbol.set(sym, { price: r.price, asOfDate: r.asOfDate });
    const ts = (r.tradingsymbol ?? "").trim().toUpperCase();
    if (ts && !byTradingsymbol.has(ts)) byTradingsymbol.set(ts, { price: r.price, asOfDate: r.asOfDate });
  }
  return { bySymbol, byTradingsymbol };
}

export function createManualProvider(read: ManualMarkReader = readManualMarksFromDb): QuoteProvider {
  return {
    id: "manual",
    capabilities: MANUAL_CAPABILITIES,

    async snapshot(keys: readonly QuoteKey[]): Promise<QuoteMap> {
      const out: QuoteMap = new Map();
      if (keys.length === 0) return out;
      const { bySymbol, byTradingsymbol } = indexMarks(await read());
      for (const key of keys) {
        const mark =
          bySymbol.get(key.symbol.trim().toUpperCase()) ??
          byTradingsymbol.get((key.tradingsymbol ?? key.symbol).trim().toUpperCase());
        // No mark is not a zero mark — the symbol is simply absent from the map
        // and the desk renders "—" (invariant 6).
        if (mark) out.set(quoteKeyId(key), manualQuoteFromMark(key, mark));
      }
      return out;
    },

    // Nothing pushes a number the user has to type. Reporting streaming:false
    // and emitting nothing is the honest shape; the UI never says "live".
    subscribe(): Unsubscribe {
      return () => {};
    },

    async health(): Promise<ProviderHealth> {
      try {
        const rows = await read();
        return rows.length > 0
          ? { ok: true }
          : { ok: false, reason: "No marks entered yet — type one on a position, or import a bhavcopy." };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : "The journal database could not be read." };
      }
    },
  };
}
