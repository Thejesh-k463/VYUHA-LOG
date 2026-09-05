import "server-only";
import { eodQuoteFromBars, type StoredBar } from "./mapping";
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
 * EodBhavcopyProvider — the DEFAULT provider, and it makes no network request
 * at all.
 *
 * v4.0 is EOD-only (owner ruling). The bhavcopy already lands in
 * `price_history` through the opt-in end-of-day download
 * (`lib/jobs/auto-mtm.ts`) or a pasted file; this provider only READS those
 * stored rows, through the existing query layer
 * (`lib/queries/price-history.ts` `getBarsMap` / `getPriceHistoryMeta`). So
 * turning the Live Desk on adds ZERO outbound hosts — the "no fifth thing"
 * sentence in `docs/client/PRIVACY.md` stays literally true, and
 * `tests/quotes-egress-guard.test.ts` holds it there.
 *
 * `dayOpen` and `volume` come back `null`: `getBarsMap()` projects
 * (date, high, low, close) only, and widening that projection means editing a
 * query file this wave does not own. A null is honest; a fabricated open is
 * not (invariant 6). v4.1 can add the two columns to the projection and this
 * file needs no change — the pure mapper already carries them.
 *
 * SERVER-ONLY, with the query module imported LAZILY so that importing the
 * registry never binds the SQLite connection ahead of `tests/helpers/temp-db.ts`.
 */

/** Injected in tests; the default reads `price_history`. */
export type BarsReader = (symbols: string[]) => Promise<Map<string, StoredBar[]>>;
export type CoverageReader = () => Promise<{ symbols: number; rows: number; lastDate: string | null }>;

export const EOD_CAPABILITIES: ProviderCapabilities = {
  id: "eod",
  label: "End-of-day (bhavcopy already on this machine)",
  streaming: false,
  maxSubscriptions: 0,
  minSnapshotIntervalMs: 0,
  depth: 0,
  segments: ["NSE", "BSE"],
  staleness: "eod",
  requiresDailyAuth: false,
  egressDescription:
    "None at quote time. Reads bhavcopy rows already stored on this machine; those rows arrive only through the opt-in end-of-day download from nsearchives.nseindia.com you switch on in Settings.",
};

async function readBarsFromDb(symbols: string[]): Promise<Map<string, StoredBar[]>> {
  const { getBarsMap } = await import("@/lib/queries/price-history");
  return getBarsMap(symbols);
}

async function readCoverageFromDb() {
  const { getPriceHistoryMeta } = await import("@/lib/queries/price-history");
  return getPriceHistoryMeta();
}

export function createEodBhavcopyProvider(
  readBars: BarsReader = readBarsFromDb,
  readCoverage: CoverageReader = readCoverageFromDb,
): QuoteProvider {
  return {
    id: "eod",
    capabilities: EOD_CAPABILITIES,

    async snapshot(keys: readonly QuoteKey[]): Promise<QuoteMap> {
      const out: QuoteMap = new Map();
      if (keys.length === 0) return out;
      // The bhavcopy is the CASH market: derivatives have no row and are simply
      // absent from the map, which is what the desk's "no mark" state is for.
      const bars = await readBars(keys.map((k) => k.symbol.trim().toUpperCase()));
      for (const key of keys) {
        const series = bars.get(key.symbol.trim().toUpperCase());
        if (!series || series.length === 0) continue;
        const quote = eodQuoteFromBars(key, series);
        if (quote) out.set(quoteKeyId(key), quote);
      }
      return out;
    },

    // An end-of-day file does not tick. Emitting nothing is the honest shape.
    subscribe(): Unsubscribe {
      return () => {};
    },

    async health(): Promise<ProviderHealth> {
      try {
        const meta = await readCoverage();
        if (meta.rows === 0 || meta.lastDate == null) {
          return {
            ok: false,
            reason: "No end-of-day prices are stored yet — import a bhavcopy, or switch on the daily download in Settings.",
          };
        }
        return { ok: true, reason: `End of day · ${meta.lastDate} · ${meta.symbols} symbols` };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : "The journal database could not be read." };
      }
    },
  };
}
