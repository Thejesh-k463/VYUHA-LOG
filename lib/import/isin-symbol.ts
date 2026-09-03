/**
 * Resolving a CODED symbol to a real ticker through its ISIN — and, since
 * v3.8, the other things the exchanges' listing files know about a security:
 * its name, its board, its BSE scrip code and its series.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data (the bundled
 * snapshots are static JSON, not queries).
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
 *   2. the bundled listing snapshot (`lib/data/isin-symbols.json`) — every
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
 * ── Two identity rules (v3.8) ─────────────────────────────────────────────
 *
 *   • A BSE CODE is looked up by the CODE, never by BSE's ticker. FOCUS, HSIL
 *     and KALYANI are different companies on NSE and on BSE; the code is what
 *     BSE keeps unique, so `symbolByBseCode("543312")` answers from the row
 *     that carries 543312 and nothing else.
 *   • NSE WINS an ISIN collision. The build script writes NSE's ticker for a
 *     dual-listed security and still attaches BSE's code to that row, so a
 *     BSE-coded file lands on the NSE symbol every other surface is keyed on.
 *
 * A name search is offered for the "which company is this?" question, and it
 * returns EVERY match: "Technocrat" is Marc Technocrats (NSE Emerge, MARC)
 * and Technocrats Plasma Systems (BSE, 544877) — two companies, two ISINs —
 * so a single answer would be the silent merge this module exists to prevent.
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

// ---------------------------------------------------------------------------
// The listing snapshot
// ---------------------------------------------------------------------------

export type ListingBoard = "nse" | "sme" | "bse";

/** One snapshot row, positionally: [SYMBOL, NAME, BOARD, BSE_CODE, SERIES]. */
export type ListingTuple = readonly [string, string, string, string, string];

export interface Listing {
  isin: string;
  symbol: string;
  name: string | null;
  board: ListingBoard;
  /** BSE's numeric scrip code — present on BSE-only rows AND on dual listings. */
  bseCode: string | null;
  /** NSE series (EQ/BE/SM/ST…) or BSE group (A/B/M/MT…) for a BSE-only row. */
  series: string | null;
}

export interface ListingLookup {
  count: number;
  listingByIsin(isin: string): Listing | null;
  symbolByIsin(isin: string): string | null;
  nameByIsin(isin: string): string | null;
  /** Keyed on BSE's CODE (see the header) — never on BSE's ticker. */
  listingByBseCode(code: string): Listing | null;
  symbolByBseCode(code: string): string | null;
  /** SYMBOL → ISIN. Where a ticker exists on more than one board (FOCUS),
   *  the NSE main board wins, then Emerge, then BSE — the same precedence
   *  the snapshot itself was built with. */
  isinBySymbol(symbol: string): string | null;
  /** Case-insensitive substring match over company names; every hit, NSE
   *  rows first. Never collapses to one answer. */
  searchByName(query: string, limit?: number): Listing[];
}

const BOARD_RANK: Record<ListingBoard, number> = { nse: 0, sme: 1, bse: 2 };
const asBoard = (b: string): ListingBoard => (b === "sme" || b === "bse" ? b : "nse");

/**
 * Build the lookup over a `byIsin` table of the snapshot's shape. Exported so
 * tests can hand it a synthetic table; the module-level instance below wraps
 * the bundled file. Every secondary index is built lazily on first use —
 * the import path (`commit.ts`) only ever needs `symbolByIsin`.
 */
export function createListingLookup(byIsin: Record<string, ListingTuple>): ListingLookup {
  const toListing = (isin: string, t: ListingTuple): Listing => ({
    isin,
    symbol: t[0],
    name: t[1] || null,
    board: asBoard(t[2]),
    bseCode: t[3] || null,
    series: t[4] || null,
  });
  const key = (s: string) => String(s ?? "").trim().toUpperCase();

  let byCode: Map<string, string> | null = null; // BSE code → ISIN
  let bySymbol: Map<string, string> | null = null; // SYMBOL → ISIN (best board)
  const codes = () => {
    if (byCode) return byCode;
    byCode = new Map();
    for (const [isin, t] of Object.entries(byIsin)) if (t[3]) byCode.set(t[3], isin);
    return byCode;
  };
  const symbols = () => {
    if (bySymbol) return bySymbol;
    bySymbol = new Map();
    for (const [isin, t] of Object.entries(byIsin)) {
      const prior = bySymbol.get(t[0]);
      if (!prior || BOARD_RANK[asBoard(t[2])] < BOARD_RANK[asBoard(byIsin[prior][2])]) bySymbol.set(t[0], isin);
    }
    return bySymbol;
  };

  const listingByIsin = (isin: string): Listing | null => {
    const k = key(isin);
    const t = k ? byIsin[k] : undefined;
    return t ? toListing(k, t) : null;
  };
  const listingByBseCode = (code: string): Listing | null => {
    const c = String(code ?? "").trim();
    if (!/^\d+$/.test(c)) return null;
    const isin = codes().get(c);
    return isin ? toListing(isin, byIsin[isin]) : null;
  };

  return {
    count: Object.keys(byIsin).length,
    listingByIsin,
    symbolByIsin: (isin) => listingByIsin(isin)?.symbol ?? null,
    nameByIsin: (isin) => listingByIsin(isin)?.name ?? null,
    listingByBseCode,
    symbolByBseCode: (code) => listingByBseCode(code)?.symbol ?? null,
    isinBySymbol: (symbol) => {
      const s = key(symbol);
      return s ? (symbols().get(s) ?? null) : null;
    },
    searchByName: (query, limit = 20) => {
      const q = String(query ?? "").trim().toLowerCase();
      if (!q) return [];
      const hits: Listing[] = [];
      for (const [isin, t] of Object.entries(byIsin)) {
        if (t[1].toLowerCase().includes(q)) hits.push(toListing(isin, t));
      }
      hits.sort((a, b) => BOARD_RANK[a.board] - BOARD_RANK[b.board] || a.symbol.localeCompare(b.symbol));
      return hits.slice(0, Math.max(0, limit));
    },
  };
}

/** The exchange listing snapshot, straight off the file. */
// `unknown` first: tsc types the JSON literally (string[] per row), and a
// 5,700-key literal type is not "comparable" to the tuple index signature.
const snapshot = isinSymbols as unknown as { asOf?: string; byIsin?: Record<string, ListingTuple> };
const listing = createListingLookup(snapshot.byIsin ?? {});

/** When the bundled listing snapshot was taken. Shown wherever coverage matters. */
export const LISTED_SYMBOLS_AS_OF: string = snapshot.asOf ?? "";
/** How many listed securities the bundled snapshot carries. */
export const LISTED_SYMBOLS_COUNT: number = listing.count;

// ---------------------------------------------------------------------------
// The index-constituent map, as the independent second source
// ---------------------------------------------------------------------------

/** ISIN (upper) → SYMBOL, built once on first use from the bundled index map. */
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
  return listing.symbolByIsin(key) ?? bundled().get(key) ?? null;
}

/** The reverse of `bundledSymbolByIsin`: SYMBOL → ISIN, listing first (NSE
 *  main board beats Emerge beats BSE), index map second. */
export function bundledIsinBySymbol(symbol: string): string | null {
  const key = String(symbol ?? "").trim().toUpperCase();
  if (!key) return null;
  const fromListing = listing.isinBySymbol(key);
  if (fromListing) return fromListing;
  const meta = (nseIndexMap as { symbols?: Record<string, { isin?: string | null }> }).symbols?.[key];
  const isin = String(meta?.isin ?? "").trim().toUpperCase();
  return isin || null;
}

/** The exchange's company name for an ISIN, from the listing snapshot only. */
export function nameByIsin(isin: string): string | null {
  return listing.nameByIsin(isin);
}

/** Everything the listing snapshot knows about an ISIN. */
export function listingByIsin(isin: string): Listing | null {
  return listing.listingByIsin(isin);
}

/** BSE scrip code → the ticker every other surface is keyed on (NSE's where
 *  the security is dual-listed). Keyed on the CODE — see the header. */
export function symbolByBseCode(code: string): string | null {
  return listing.symbolByBseCode(code);
}

/** BSE scrip code → the full listing row. */
export function listingByBseCode(code: string): Listing | null {
  return listing.listingByBseCode(code);
}

/** Every listing whose company name contains the query. */
export function searchListingsByName(query: string, limit = 20): Listing[] {
  return listing.searchByName(query, limit);
}

// ---------------------------------------------------------------------------
// Coded-symbol substitution
// ---------------------------------------------------------------------------

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
