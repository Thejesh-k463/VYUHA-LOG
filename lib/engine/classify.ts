import {
  BSE_INDEX_UNDERLYINGS,
  COMMODITY_UNDERLYINGS,
  INDEX_UNDERLYINGS,
} from "@/lib/domain/constants";
import type { Exchange, OptionType } from "@/lib/domain/constants";
import type { Classification, ClassifyInput, ParsedInstrument } from "./types";

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const INDEX_SET = new Set<string>(INDEX_UNDERLYINGS);
const BSE_INDEX_SET = new Set<string>(BSE_INDEX_UNDERLYINGS);
const COMMODITY_SET = new Set<string>(COMMODITY_UNDERLYINGS);

function toIso(day: string, mon: string, year: string): string | null {
  const mm = MONTHS[mon.toLowerCase().slice(0, 3)];
  if (!mm) return null;
  const dd = day.padStart(2, "0");
  if (dd.length !== 2 || year.length !== 4) return null;
  return `${year}-${mm}-${dd}`;
}

/**
 * NSE/BSE compact contract grammar — the tradingsymbol format Zerodha, Upstox
 * and the exchanges themselves emit (pinned against a real Zerodha tax P&L,
 * 693 F&O rows, 2026-09-01):
 *   Monthly option: UNDERLYING YY MMM STRIKE CE|PE   TVSMOTOR25APR2480CE
 *   Weekly option:  UNDERLYING YY M DD STRIKE CE|PE  NIFTY2540323750CE
 *                   (M is 1-9 for Jan-Sep, then O, N, D)
 *   Future:         UNDERLYING YY MMM FUT            NIFTY25APRFUT
 *
 * The underlying is matched lazily so digit-leading tickers (360ONE) still
 * split correctly — the regex engine grows it only until YY+month parses.
 * Strikes may carry decimals (currency contracts). A plain equity ticker
 * cannot match: the tail requires two year digits AND a month token AND a
 * numeric strike before CE/PE, which no listed ticker satisfies.
 */
const COMPACT_MONTHLY_OPT = /^([A-Z0-9&-]+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+(?:\.\d+)?)(CE|PE)$/;
const COMPACT_WEEKLY_OPT = /^([A-Z0-9&-]+?)(\d{2})([1-9OND])(0[1-9]|[12]\d|3[01])(\d+(?:\.\d+)?)(CE|PE)$/;
const COMPACT_FUT = /^([A-Z0-9&-]+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)FUT$/;

const WEEKLY_MONTH: Record<string, string> = {
  "1": "01", "2": "02", "3": "03", "4": "04", "5": "05", "6": "06",
  "7": "07", "8": "08", "9": "09", O: "10", N: "11", D: "12",
};

/** 2-digit contract years are all post-2000; NSE listed no F&O before 2000. */
const century = (yy: string) => `20${yy}`;

function parseCompactName(name: string): ParsedInstrument | null {
  // Compact names never contain spaces; requiring the derivative tail first
  // keeps every plain equity ticker out of the regex engine entirely.
  if (name.includes(" ") || !/\d/.test(name) || !/(?:CE|PE|FUT)$/.test(name)) return null;

  const w = COMPACT_WEEKLY_OPT.exec(name);
  if (w) {
    return {
      kind: "option",
      symbol: w[1],
      expiry: `${century(w[2])}-${WEEKLY_MONTH[w[3]]}-${w[4]}`,
      strike: Number(w[5]),
      optionType: w[6] as OptionType,
    };
  }
  const m = COMPACT_MONTHLY_OPT.exec(name);
  if (m) {
    return {
      kind: "option",
      symbol: m[1],
      // The monthly symbol states only year + month; the expiry DAY is a rule
      // of the exchange calendar, and that rule changed twice in 2025. Null is
      // the honest answer — inventing "last Thursday" fabricates a date.
      expiry: null,
      strike: Number(m[4]),
      optionType: m[5] as OptionType,
    };
  }
  const f = COMPACT_FUT.exec(name);
  if (f) {
    return { kind: "future", symbol: f[1], expiry: null, strike: null, optionType: null };
  }
  return null;
}

/**
 * Parse a Dhan-style derivative name, an exchange-compact name, or a plain
 * equity name.
 *   OPT <SYMBOL> <DD Mon YYYY> <STRIKE> <CE|PE>
 *   FUT <SYMBOL> <DD Mon YYYY>
 *   NSE/BSE compact contracts (see parseCompactName above)
 *   anything else -> equity (symbol = trimmed name)
 * Dhan-style parsing works from the END so multi-token symbols still resolve.
 */
export function parseInstrumentName(raw: string): ParsedInstrument {
  const name = raw.trim().replace(/\s+/g, " ");

  const compact = parseCompactName(name.toUpperCase());
  if (compact) return compact;

  const tokens = name.split(" ");
  const prefix = tokens[0]?.toUpperCase();

  if (prefix === "OPT" && tokens.length >= 6) {
    const last = tokens.length - 1;
    const ot = tokens[last]?.toUpperCase();
    if (ot === "CE" || ot === "PE") {
      const strike = Number(tokens[last - 1]);
      const expiry = toIso(tokens[last - 4], tokens[last - 3], tokens[last - 2]);
      const symbol = tokens.slice(1, last - 4).join(" ").toUpperCase();
      if (symbol && Number.isFinite(strike)) {
        return { kind: "option", symbol, expiry, strike, optionType: ot as OptionType };
      }
    }
  }

  if (prefix === "FUT" && tokens.length >= 5) {
    const last = tokens.length - 1;
    const expiry = toIso(tokens[last - 2], tokens[last - 1], tokens[last]);
    const symbol = tokens.slice(1, last - 2).join(" ").toUpperCase();
    if (symbol) {
      return { kind: "future", symbol, expiry, strike: null, optionType: null };
    }
  }

  return { kind: "equity", symbol: name, expiry: null, strike: null, optionType: null };
}

function underlyingExchange(symbol: string): Exchange {
  if (COMMODITY_SET.has(symbol)) return "MCX";
  if (BSE_INDEX_SET.has(symbol)) return "BSE";
  return "NSE";
}

/**
 * Auto-classify an instrument into bucket / segment / instrument_type / exchange
 * and (for derivatives) symbol, expiry, strike, option_type. Pure & deterministic.
 * Manual overrides are applied separately at import time.
 */
export function classify(input: ClassifyInput): Classification {
  const parsed = parseInstrumentName(input.tradingsymbol);

  // ---- Options ----
  if (parsed.kind === "option") {
    const isIndex = INDEX_SET.has(parsed.symbol);
    const isCommodity = COMMODITY_SET.has(parsed.symbol);
    const segment = isIndex
      ? "index_option"
      : isCommodity
        ? "commodity_option"
        : "stock_option";
    return {
      bucket: "active",
      segment,
      instrumentType: "option",
      exchange: input.exchangeHint ?? underlyingExchange(parsed.symbol),
      symbol: parsed.symbol,
      expiry: parsed.expiry,
      strike: parsed.strike,
      optionType: parsed.optionType,
    };
  }

  // ---- Futures ----
  if (parsed.kind === "future") {
    const isCommodity = COMMODITY_SET.has(parsed.symbol);
    return {
      bucket: "active",
      segment: isCommodity ? "commodity_future" : "future",
      instrumentType: "future",
      exchange: input.exchangeHint ?? underlyingExchange(parsed.symbol),
      symbol: parsed.symbol,
      expiry: parsed.expiry,
      strike: null,
      optionType: null,
    };
  }

  // ---- Equity (split by product hint) ----
  const hint = input.productHint ?? "delivery";
  if (hint === "intraday") {
    return equityClass("eq_intraday", "active", parsed.symbol, input.exchangeHint);
  }
  if (hint === "mtf") {
    return equityClass("eq_mtf", "equity", parsed.symbol, input.exchangeHint);
  }
  return equityClass("eq_delivery", "equity", parsed.symbol, input.exchangeHint);
}

function equityClass(
  segment: "eq_delivery" | "eq_mtf" | "eq_intraday",
  bucket: "equity" | "active",
  symbol: string,
  exchangeHint?: Exchange | null,
): Classification {
  return {
    bucket,
    segment,
    instrumentType: "equity",
    exchange: exchangeHint ?? "NSE",
    symbol,
    expiry: null,
    strike: null,
    optionType: null,
  };
}
