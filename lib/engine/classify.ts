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
 * Parse a Dhan-style derivative name or a plain equity name.
 *   OPT <SYMBOL> <DD Mon YYYY> <STRIKE> <CE|PE>
 *   FUT <SYMBOL> <DD Mon YYYY>
 *   anything else -> equity (symbol = trimmed name)
 * Parsing works from the END so multi-token symbols still resolve.
 */
export function parseInstrumentName(raw: string): ParsedInstrument {
  const name = raw.trim().replace(/\s+/g, " ");
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
