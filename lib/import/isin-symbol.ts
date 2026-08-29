/**
 * Resolving a CODED symbol to a real ticker through its ISIN.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data (the bundled
 * NSE index map is a static JSON snapshot, not a query).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Paytm Money's tradebook states the exchange SCRIP CODE in its `Script`
 * column — `216463`, `544866` — not a ticker. Every other surface in Vyuha
 * (sector analytics, the NSE index map, the tax pack, the user's own memory)
 * is keyed on the ticker, so a book imported as scrip codes is a book of
 * strangers. The one thing the file does carry on every row is the ISIN, and
 * an ISIN identifies the security unambiguously.
 *
 * So the code is not GUESSED into a ticker — it is looked up. THREE sources,
 * in strict order:
 *
 *   1. the user's own Instruments table — whatever they uploaded, and the only
 *      source that can know a security the exchanges list after our snapshot;
 *   2. the bundled ISIN→symbol snapshot (`lib/data/isin-symbols.json`) — every
 *      listed equity on both exchanges, main board and SME;
 *   3. the bundled index-constituent map (`lib/data/nse-index-map.json`) — the
 *      ~1,150 index members, kept as a fallback because it is built from a
 *      different set of downloads and so survives a stale or partial (2).
 *
 * When none of them knows the ISIN the code is KEPT as-is: a wrong ticker
 * would silently merge two companies' trades, and a visible number is a
 * question the user can answer, which a confident wrong answer is not.
 *
 * Why (2) had to exist: the index map covers index CONSTITUENTS, so a clean
 * install resolved 76 of the 215 distinct scrip codes in the owner's own Paytm
 * book (2026-08-30) and every SME name on the screen stayed a number. Those
 * are exactly the securities a trader is least likely to recognise by code.
 *
 * The substitution is always recorded in the trade's import notes, so the
 * ticker on screen never hides where it came from.
 */

import nseIndexMap from "@/lib/data/nse-index-map.json";
import isinSymbols from "@/lib/data/isin-symbols.json";
import type { NormalizedTrade } from "@/lib/engine/types";

/**
 * True when a "symbol" is really a numeric code rather than a ticker.
 *
 * All-digits is the whole test, deliberately: no NSE or BSE equity ticker is
 * numeric, and anything with a letter in it is either a real ticker or a
 * derivative name this module has no business rewriting.
 */
export function isCodedSymbol(s: string): boolean {
  return /^\d+$/.test(String(s ?? "").trim());
}

/** ISIN (upper) → SYMBOL, built once on first use from the bundled snapshot. */
let bundledIndex: Map<string, string> | null = null;

function bundled(): Map<string, string> {
  if (bundledIndex) return bundledIndex;
  const m = new Map<string, string>();
  const symbols = (nseIndexMap as { symbols?: Record<string, { isin?: string | null }> }).symbols ?? {};
  for (const [symbol, meta] of Object.entries(symbols)) {
    const isin = String(meta?.isin ?? "").trim().toUpperCase();
    // First writer wins: the map is keyed by symbol, so a duplicate ISIN would
    // mean two tickers for one security — keeping the first is stable across
    // rebuilds, and overwriting would make the answer depend on key order.
    if (isin && !m.has(isin)) m.set(isin, symbol);
  }
  bundledIndex = m;
  return m;
}

/** The exchange listing snapshot: ISIN (upper) → SYMBOL, straight off the file. */
const listed = (isinSymbols as { byIsin?: Record<string, string> }).byIsin ?? {};

/** When the bundled listing snapshot was taken. Shown wherever coverage matters. */
export const LISTED_SYMBOLS_AS_OF: string = (isinSymbols as { asOf?: string }).asOf ?? "";
/** How many listed securities the bundled snapshot carries. */
export const LISTED_SYMBOLS_COUNT: number = Object.keys(listed).length;

/**
 * Look one ISIN up in the bundled snapshots — the full exchange listing first,
 * the index-constituent map second.
 *
 * The index map stays in the chain rather than being replaced: it is built
 * from a different set of downloads, so it still answers when the listing
 * snapshot is stale, partial, or was rebuilt from an incomplete folder. Two
 * independent sources cost 200 KB and remove a single point of failure.
 */
export function bundledSymbolByIsin(isin: string): string | null {
  const key = String(isin ?? "").trim().toUpperCase();
  if (!key) return null;
  return listed[key] ?? bundled().get(key) ?? null;
}

/**
 * Replace coded symbols with real tickers, leaving everything else untouched.
 *
 * Returns COPIES — the parsed file is not mutated, so a preview and a commit
 * of the same parse produce identical rows (and therefore identical dedup
 * hashes, which are computed downstream from `tradingsymbol`).
 */
export function resolveCodedSymbols(
  trades: NormalizedTrade[],
  lookup: (isin: string) => string | null,
): NormalizedTrade[] {
  return trades.map((t) => {
    if (!isCodedSymbol(t.tradingsymbol) || !t.isin) return t;
    const found = lookup(t.isin);
    if (!found) return t;
    const symbol = found.trim().toUpperCase();
    if (!symbol) return t;
    return {
      ...t,
      tradingsymbol: symbol,
      importNotes: [
        ...(t.importNotes ?? []),
        `Paytm scrip code ${t.tradingsymbol} → ${symbol} via ISIN`,
      ],
    };
  });
}
