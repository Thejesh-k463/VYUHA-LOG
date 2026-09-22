import etfList from "@/lib/data/etf-list.json";

/**
 * IS THIS AN ETF, AND IS IT EQUITY-ORIENTED? — from the bundled NSE list only.
 *
 * PURE (invariant 2): no DB, no React, no network. The snapshot is built on
 * the owner's machine by `scripts/build-etf-list.mjs` and refreshed manually
 * once per MINOR release (owner ruling T4, 2026-09-22).
 *
 * ── Why a class at all ────────────────────────────────────────────────────
 *
 * An ETF unit and an equity share share one segment (`eq_delivery`), so until
 * this existed every ETF was charged the equity-share delivery STT — 0.1% both
 * sides. The statute charges 0.001% on the SALE of an equity-oriented fund
 * unit and nothing at all on a gold / silver / debt / liquid / international
 * ETF (ruling R90, 06-ANSWERS "v4.3.0 wave-3 ruling"). The RATES still come
 * only from `charge_config` (invariant 3) — this module answers WHICH row,
 * never what the rate is.
 *
 * ── The resolution chain, and what it refuses to do ───────────────────────
 *
 * ISIN → exact symbol via `bySymbol` → nothing. A symbol is tried only when
 * the row states no ISIN or the ISIN is unknown: 156 of the 350 ISINs are
 * unknown to `isin-symbols.json` and a tradebook may state only a ticker.
 *
 * `null` means "the list does not say", NEVER "an ordinary share". An
 * INF-prefixed ISIN that is not on the list (the seven BSE-only Sensex ETFs,
 * SIF units, segregated portfolios) resolves to null here and Data Quality
 * names it; its STT stays the equity-share rate, and its tax head is blank
 * from wave 3b (dossier §F.2, invariant 6).
 *
 * An EMPTY or ABSENT snapshot must never fail anything — the
 * `isin-bundle-coverage` precedent. Every lookup then returns null and the app
 * prices exactly as it did before the list existed.
 */

export type EtfKind = "equity-oriented" | "other";

export interface EtfClassResult {
  /** The binary class the STT row keys on. */
  kind: EtfKind;
  /** The RAW `ETF Underlying` value NSE published: EQUITY / COMMODITY / DEBT / GLOBAL INDICES / Hybrid. */
  underlying: string;
  isin: string;
  symbol: string;
}

interface EtfRow {
  symbol?: string;
  underlying?: string;
  kind?: string;
}

interface EtfSnapshot {
  asOf?: string;
  provenance?: { url?: string; sha256?: string; rows?: number };
  byIsin?: Record<string, EtfRow>;
  bySymbol?: Record<string, string>;
}

// `unknown` first: tsc types the JSON literally (a 350-key object type), which
// is not comparable to the index signatures above — the isin-symbol.ts pattern.
const snapshot = etfList as unknown as EtfSnapshot;
const byIsin: Record<string, EtfRow> = snapshot.byIsin ?? {};
const bySymbol: Record<string, string> = snapshot.bySymbol ?? {};

/** When the bundled ETF list was published by NSE (its HTTP Last-Modified). */
export const ETF_LIST_AS_OF: string = snapshot.asOf ?? "";
/** The sha256 of the CSV this snapshot was built from — shown beside `asOf` (owner ruling T4). */
export const ETF_LIST_SHA256: string = snapshot.provenance?.sha256 ?? "";
/** Where the CSV came from. */
export const ETF_LIST_URL: string = snapshot.provenance?.url ?? "";
/** How many ETFs the bundled snapshot carries. */
export const ETF_LIST_COUNT: number = Object.keys(byIsin).length;

const clean = (s: string | null | undefined): string => String(s ?? "").trim().toUpperCase();

function result(isin: string, row: EtfRow | undefined): EtfClassResult | null {
  if (!row) return null;
  // A row whose kind is not one of the two known values is treated as absent:
  // the build refuses to emit one, so this can only be a hand-edited file.
  const kind = row.kind === "equity-oriented" || row.kind === "other" ? row.kind : null;
  if (!kind) return null;
  return { kind, underlying: String(row.underlying ?? ""), isin, symbol: clean(row.symbol) };
}

/**
 * The ETF class of a traded instrument, or null when the list does not say.
 * Never throws — an absent or empty snapshot simply answers null everywhere.
 */
export function etfClass(t: { isin?: string | null; symbol?: string | null }): EtfClassResult | null {
  const isin = clean(t.isin);
  if (isin) {
    const hit = result(isin, byIsin[isin]);
    if (hit) return hit;
  }
  const symbol = clean(t.symbol);
  if (symbol) {
    const viaSymbol = bySymbol[symbol];
    if (viaSymbol) return result(viaSymbol, byIsin[viaSymbol]);
  }
  return null;
}

/**
 * The `charge_config` segment that carries an ETF's STT.
 *
 * These two keys are RATE ROWS ONLY and are deliberately NOT members of the
 * `Segment` union that trades store: the preview-equals-save matrix, the seed's
 * `emit()` and /reports/broker-compare all enumerate segments from what trades
 * carry, and an ETF is still an `eq_delivery` / `eq_intraday` / `eq_mtf` trade.
 * Only STT/CTT is read from these rows; brokerage, DP, stamp, exchange, SEBI,
 * IPFT, the GST base and MTF interest all come from the trade's OWN product row.
 */
export const ETF_RATE_SEGMENTS = ["etf_equity", "etf_other"] as const;
export type EtfRateSegment = (typeof ETF_RATE_SEGMENTS)[number];

export function etfRateSegment(kind: EtfKind): EtfRateSegment {
  return kind === "equity-oriented" ? "etf_equity" : "etf_other";
}
