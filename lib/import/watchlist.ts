/**
 * Watchlist file extraction + canonicalisation (PURE, no DB/React).
 *
 * A session plan's watchlist can arrive as a .txt list, any broker's CSV/XLSX,
 * or a flat-text PDF. This module turns each of those into CANDIDATE symbols —
 * never committed directly: the client shows them for confirmation and the
 * save path canonicalises them. The honesty rules mirror the import pipeline:
 *
 *   - A table column is claimed only when its values LOOK like tickers; when
 *     two columns qualify, the caller gets both and asks (a question beats a
 *     confident wrong answer — same rule as the generic column mapper).
 *   - PDF text is flat text, never "table structure": tokens are extracted as
 *     candidates and the caller MUST require explicit user confirmation.
 *   - Canonicalisation resolves through the caller-supplied alias/ISIN maps
 *     and otherwise KEEPS the symbol as typed — unknown is not refused and
 *     never guessed into something else.
 */

import { isCodedSymbol } from "./isin-symbol";
import { resolveTicker } from "@/lib/analytics/aliases";

/** Ticker-ish: 2–30 chars of A-Z 0-9 & . -, containing at least one letter. */
const TICKER_RE = /^[A-Z0-9][A-Z0-9&.\-]{1,29}$/;
/** ISO 6166 ISIN, e.g. INE009A01021. */
export const ISIN_RE = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;

export function looksLikeTicker(raw: string): boolean {
  const t = raw.trim().toUpperCase();
  if (!TICKER_RE.test(t)) return false;
  // A pure number is a price/qty/scrip-code, not a ticker to auto-claim.
  if (/^[\d.\-]+$/.test(t)) return false;
  return /[A-Z]/.test(t);
}

/**
 * Words a flat-text PDF is full of that are never the ticker the user meant.
 * Heuristic only — everything extracted from a PDF is confirmed by the user.
 */
const PDF_STOPWORDS = new Set([
  "THE", "AND", "FOR", "WITH", "FROM", "THIS", "THAT", "ARE", "NOT", "YOU",
  "ALL", "ANY", "PER", "OF", "ON", "IN", "TO", "AT", "BY", "AS", "IS", "OR",
  "NSE", "BSE", "MCX", "LTD", "LIMITED", "INC", "PVT", "EQ", "FUT", "OPT",
  "CE", "PE", "DATE", "TIME", "PRICE", "QTY", "BUY", "SELL", "TOTAL", "NET",
  "OPEN", "HIGH", "LOW", "CLOSE", "VOLUME", "CHANGE", "SYMBOL", "SCRIP",
  "STOCK", "STOCKS", "NAME", "WATCHLIST", "LIST", "PAGE", "RS", "INR",
  "CMP", "LTP", "TARGET", "SL", "STOPLOSS", "AVG", "VALUE", "AMOUNT",
]);

export interface WatchlistExtraction {
  /** Candidate symbols in file order, deduped, upper-cased. */
  symbols: string[];
  /** True when the source cannot vouch for structure (PDF flat text). */
  requiresConfirmation: boolean;
  /** Set when more than one table column plausibly holds the tickers. */
  ambiguousColumns?: { header: string; index: number; symbols: string[] }[];
  note?: string;
}

const dedupe = (list: string[]): string[] => [...new Set(list.map((s) => s.trim().toUpperCase()).filter(Boolean))];

/**
 * A .txt watchlist: comma / space / newline / semicolon separated. The user
 * wrote every token on purpose, so anything token-shaped is kept — including
 * numeric scrip codes and ISINs, which the save path knows how to resolve.
 */
export function parseWatchlistText(text: string): WatchlistExtraction {
  const symbols = dedupe(
    text.split(/[\s,;]+/).filter((t) => /^[A-Z0-9][A-Z0-9&.\-]{0,29}$/i.test(t.trim())),
  );
  return { symbols, requiresConfirmation: false };
}

/**
 * Pick the ticker column out of a parsed table (headers + string rows).
 *
 * A column qualifies when ≥60% of its non-empty values look like tickers.
 * A header named symbol/scrip/ticker/instrument/stock breaks a tie on its
 * own; otherwise two qualifying columns are returned as candidates for the
 * user to choose between.
 */
export function extractTickerColumn(headers: string[], rows: string[][]): WatchlistExtraction {
  const width = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  if (width === 0 || rows.length === 0) {
    return { symbols: [], requiresConfirmation: false, note: "No table rows found in this file." };
  }

  const columns = Array.from({ length: width }, (_, i) => {
    const values = rows.map((r) => String(r[i] ?? "").trim()).filter(Boolean);
    const tickerish = values.filter((v) => looksLikeTicker(v));
    const header = String(headers[i] ?? "").trim();
    return {
      index: i,
      header,
      symbols: dedupe(tickerish),
      score: values.length ? tickerish.length / values.length : 0,
      headerNamed: /symbol|scrip|ticker|instrument|stock/i.test(header),
    };
  });

  // A one-column file IS the watchlist — no scoring question to ask.
  if (width === 1) {
    const only = columns[0];
    return { symbols: only.symbols, requiresConfirmation: false };
  }

  const qualifying = columns.filter((c) => c.score >= 0.6 && c.symbols.length > 0);
  if (qualifying.length === 0) {
    return { symbols: [], requiresConfirmation: false, note: "No column in this file looks like a list of tickers." };
  }
  if (qualifying.length === 1) {
    return { symbols: qualifying[0].symbols, requiresConfirmation: false };
  }
  const named = qualifying.filter((c) => c.headerNamed);
  if (named.length === 1) {
    return { symbols: named[0].symbols, requiresConfirmation: false };
  }
  return {
    symbols: [],
    requiresConfirmation: true,
    ambiguousColumns: qualifying.map(({ header, index, symbols }) => ({ header: header || `Column ${index + 1}`, index, symbols })),
    note: "More than one column looks like tickers — pick the one that holds the watchlist.",
  };
}

/**
 * Candidate ticker tokens out of flat PDF text. This NEVER claims table
 * structure — the result is a suggestion list the user must confirm.
 */
export function extractTickerTokensFromText(text: string, cap = 200): WatchlistExtraction {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const raw of text.split(/[\s,;|]+/)) {
    const t = raw.trim().replace(/^[([{'"]+|[)\]}'".:]+$/g, "").toUpperCase();
    if (!looksLikeTicker(t) || PDF_STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    symbols.push(t);
    if (symbols.length >= cap) break;
  }
  return {
    symbols,
    requiresConfirmation: true,
    note: "Pulled from flat PDF text, not a table — confirm each symbol before adding it.",
  };
}

export interface CanonicaliseSources {
  /** alias (upper) → canonical ticker (upper), from the user's alias table. */
  aliasMap: Map<string, string>;
  /** ISIN (upper) → ticker, resolved chain: instruments → bundled snapshots. */
  isinLookup: (isin: string) => string | null;
}

/**
 * Resolve one watchlist entry to its canonical ticker.
 *
 *   ISIN        → looked up (instruments first, bundled snapshots behind it)
 *   broker name → alias table
 *   scrip code  → KEPT: a bare code carries no ISIN to look up, and a guessed
 *                 ticker would silently merge two companies (isin-symbol.ts)
 *   unknown     → KEPT as typed — never refused, never guessed
 */
export function canonicaliseWatchlistSymbol(raw: string, sources: CanonicaliseSources): string {
  const up = raw.trim().toUpperCase();
  if (!up) return up;
  if (ISIN_RE.test(up)) {
    const found = sources.isinLookup(up);
    return found ? found.trim().toUpperCase() : up;
  }
  if (isCodedSymbol(up)) return up;
  return resolveTicker(up, sources.aliasMap);
}

/** Canonicalise a whole list, preserving order and de-duplicating post-resolution. */
export function canonicaliseWatchlist(symbols: string[], sources: CanonicaliseSources): string[] {
  return dedupe(symbols.map((s) => canonicaliseWatchlistSymbol(s, sources)));
}
