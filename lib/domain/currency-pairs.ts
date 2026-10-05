/**
 * The currency-derivative underlyings Vyuha does not price (v4.7.0 release audit, owner answers Q2 + Q4).
 *
 * WHY A LIST AND NOT THE EXCHANGE: no stored trade carries a currency venue — `EXCHANGES` in
 * `lib/domain/constants.ts` is NSE / BSE / MCX, and the Kite and Zerodha importers used to fold CDS into NSE — so
 * a USDINR future is stored as an NSE `future` whose `symbol` is the pair. The stored `symbol` is the one field every
 * source agrees on (the reviewer's `classify()` probe: USDINR / EURUSD / USDJPY / JPYINR / GBPINR futures and options,
 * monthly, weekly and decimal-strike, all classify with symbol = the pair).
 *
 * TWO READERS, ONE LIST: the Telegram alert gate skips a position whose symbol is here (so "currency positions are
 * never checked" is true for alerts), and the Kite / Zerodha importers refuse a row whose symbol is here where the file
 * states no segment. Match the stored symbol EXACTLY, upper-cased — never a tradingsymbol prefix ("USDINR26OCTFUT"
 * starts with the pair, and so might an equity ticker one day).
 *
 * Pure: no DB, no React (AGENTS.md invariant 2).
 */
export const CURRENCY_PAIRS: readonly string[] = [
  "USDINR",
  "EURINR",
  "GBPINR",
  "JPYINR",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
] as const;

const SET = new Set(CURRENCY_PAIRS);

/** PURE. Is this stored underlying symbol a currency pair? Exact match after trim + upper-case. */
export function isCurrencyPair(symbol: string | null | undefined): boolean {
  return SET.has(String(symbol ?? "").trim().toUpperCase());
}
