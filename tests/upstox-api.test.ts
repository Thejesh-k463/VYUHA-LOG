import { describe, expect, it } from "vitest";
import * as upstox from "@/lib/import/api/upstox";
import {
  canonicalUpstoxSymbol,
  exchangeOf,
  isDerivativeExchange,
  isinOf,
  normalizeUpstoxTrades,
  productHintOf,
  stripSeriesSuffix,
  toParsedFile,
  type UpstoxTradeRow,
} from "@/lib/import/api/upstox";
import { classify } from "@/lib/engine/classify";

/**
 * Rows in this file are from the REAL get-trades-for-day payload of
 * 2026-08-28 (11 fills across NSE/NFO/BFO, products D/I/MTF) — the first
 * native Upstox pull ever made. The traps these tests pin were all found in
 * that payload, not in the docs.
 */

const TODAY = "2026-08-28";

const fill = (over: Partial<UpstoxTradeRow> = {}): UpstoxTradeRow => ({
  exchange: "NSE",
  product: "D",
  tradingsymbol: "PRECWIRE-EQ",
  trading_symbol: "PRECWIRE-EQ",
  instrument_token: "NSE_EQ|INE372C01037",
  transaction_type: "BUY",
  quantity: 3,
  average_price: 443.3,
  order_timestamp: "2026-08-28 11:55:42",
  exchange_timestamp: "2026-08-28 17:25:42",
  ...over,
});

describe("mapping tables — verified against the live payload", () => {
  it("single-letter products map for equity; MTF arrives as the literal string", () => {
    expect(productHintOf("D", false)).toBe("delivery");
    expect(productHintOf("I", false)).toBe("intraday");
    expect(productHintOf("MTF", false)).toBe("mtf");
    expect(productHintOf("X", false)).toBeNull();
  });

  it("derivatives always hint null — Upstox labels an option CARRY as 'D'", () => {
    // Real row: NIFTY2690124350CE carried product "D" (their NRML); a
    // delivery hint on an option would only fight the classifier.
    expect(productHintOf("D", true)).toBeNull();
    expect(productHintOf("I", true)).toBeNull();
  });

  it("exchanges fold to the three the app knows", () => {
    expect(exchangeOf("NSE")).toBe("NSE");
    expect(exchangeOf("NFO")).toBe("NSE");
    expect(exchangeOf("BFO")).toBe("BSE");
    expect(exchangeOf("MCX_FO")).toBe("MCX");
    expect(exchangeOf("SOMETHING")).toBeNull();
  });

  it("derivative exchanges are NFO/BFO/MCX — currency stays out", () => {
    expect(isDerivativeExchange("NFO")).toBe(true);
    expect(isDerivativeExchange("BFO")).toBe(true);
    expect(isDerivativeExchange("NSE")).toBe(false);
    expect(isDerivativeExchange("CDS")).toBe(false);
  });

  it("the equity instrument_token carries the ISIN; F&O tokens do not", () => {
    expect(isinOf("NSE_EQ|INE372C01037")).toBe("INE372C01037");
    expect(isinOf("BSE_FO|859025")).toBeNull();
    expect(isinOf(undefined)).toBeNull();
  });

  it("NSE series suffixes strip so symbols line up across sources", () => {
    expect(stripSeriesSuffix("EBGNG-EQ")).toBe("EBGNG");
    expect(stripSeriesSuffix("PRECWIRE")).toBe("PRECWIRE");
  });
});

describe("canonicalUpstoxSymbol — the compact WEEKLY format, from real contracts", () => {
  it("parses the live payload's three option symbols", () => {
    // NIFTY2690124350CE = NIFTY, 2026, month 9, day 01 — 01 Sep 2026.
    expect(canonicalUpstoxSymbol("NIFTY2690124350CE", "NFO")).toBe("OPT NIFTY 01 Sep 2026 24350 CE");
    expect(canonicalUpstoxSymbol("NIFTY2690124000PE", "NFO")).toBe("OPT NIFTY 01 Sep 2026 24000 PE");
    expect(canonicalUpstoxSymbol("SENSEX2690378300CE", "BFO")).toBe("OPT SENSEX 03 Sep 2026 78300 CE");
  });

  it("reads the O/N/D month codes for Oct–Dec", () => {
    expect(canonicalUpstoxSymbol("NIFTY26O0724500CE", "NFO")).toBe("OPT NIFTY 07 Oct 2026 24500 CE");
    expect(canonicalUpstoxSymbol("NIFTY26D2924500PE", "NFO")).toBe("OPT NIFTY 29 Dec 2026 24500 PE");
  });

  it("REFUSES the monthly format — it states no expiry day, and calendars are not guessed", () => {
    expect(canonicalUpstoxSymbol("NIFTY26SEP24000CE", "NFO")).toBeNull();
    expect(canonicalUpstoxSymbol("NIFTY26SEPFUT", "NFO")).toBeNull();
  });

  it("never reshapes a symbol off the derivative exchanges", () => {
    expect(canonicalUpstoxSymbol("PRECWIRE-EQ", "NSE")).toBeNull();
  });

  it("the canonical name classifies as an index option on the right exchange", () => {
    const name = canonicalUpstoxSymbol("SENSEX2690378300CE", "BFO")!;
    const cls = classify({ tradingsymbol: name, exchangeHint: exchangeOf("BFO"), productHint: null });
    expect(cls.instrumentType).toBe("option");
    expect(cls.segment).toBe("index_option");
    expect(cls.exchange).toBe("BSE");
    expect(cls.expiry).toBe("2026-09-03");
    expect(cls.strike).toBe(78300);
  });
});

describe("normalizeUpstoxTrades — the 2026-08-28 live book, end to end", () => {
  it("aggregates the real MTF round trip and keeps the stated MTF product", () => {
    const { trades } = normalizeUpstoxTrades(
      [
        fill({ tradingsymbol: "EBGNG-EQ", trading_symbol: "EBGNG-EQ", product: "MTF", instrument_token: "NSE_EQ|INE18JU01028", transaction_type: "SELL", quantity: 5, average_price: 620.6, order_timestamp: "2026-08-28 11:53:57" }),
        fill({ tradingsymbol: "EBGNG-EQ", trading_symbol: "EBGNG-EQ", product: "MTF", instrument_token: "NSE_EQ|INE18JU01028", transaction_type: "BUY", quantity: 3, average_price: 621.9, order_timestamp: "2026-08-28 11:52:13" }),
        fill({ tradingsymbol: "EBGNG-EQ", trading_symbol: "EBGNG-EQ", product: "MTF", instrument_token: "NSE_EQ|INE18JU01028", transaction_type: "BUY", quantity: 2, average_price: 621.85, order_timestamp: "2026-08-28 11:52:13" }),
      ],
      TODAY,
    );
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.tradingsymbol).toBe("EBGNG");
    expect(t.isin).toBe("INE18JU01028");
    expect(t.productHint).toBe("mtf");
    expect(t.buyQty).toBe(5);
    expect(t.avgBuyPrice).toBe(621.88);
    expect(t.buyValue).toBe(3109.4);
    expect(t.grossPnl).toBe(r2(3103 - 3109.4));
  });

  it("reads times from order_timestamp, NEVER exchange_timestamp (the +05:30 trap)", () => {
    const { trades } = normalizeUpstoxTrades(
      [
        fill({ tradingsymbol: "SENSEX2690378300CE", trading_symbol: "SENSEX2690378300CE", exchange: "BFO", product: "I", instrument_token: "BSE_FO|859025", quantity: 20, average_price: 90.05, order_timestamp: "2026-08-28 11:46:39", exchange_timestamp: "2026-08-28 17:16:39" }),
        fill({ tradingsymbol: "SENSEX2690378300CE", trading_symbol: "SENSEX2690378300CE", exchange: "BFO", product: "I", instrument_token: "BSE_FO|859025", transaction_type: "SELL", quantity: 20, average_price: 90.8, order_timestamp: "2026-08-28 11:49:32", exchange_timestamp: "2026-08-28 17:19:32" }),
      ],
      TODAY,
    );
    const t = trades[0]!;
    expect(t.tradingsymbol).toBe("OPT SENSEX 03 Sep 2026 78300 CE");
    expect(t.entryTime).toBe("11:46");
    expect(t.exitTime).toBe("11:49");
    expect(t.productHint).toBeNull();
    expect(t.exchangeHint).toBe("BSE");
  });

  it("keeps the raw name and SAYS SO for a monthly-format derivative symbol", () => {
    const { trades, notes } = normalizeUpstoxTrades(
      [fill({ tradingsymbol: "NIFTY26SEP24000CE", trading_symbol: "NIFTY26SEP24000CE", exchange: "NFO", product: "D" })],
      TODAY,
    );
    expect(trades[0]!.tradingsymbol).toBe("NIFTY26SEP24000CE");
    expect(notes.join(" ")).toMatch(/does not parse as a weekly option/i);
  });

  it("refuses a fill with no readable side, quantity or price — counted, never coerced", () => {
    const { trades, refused } = normalizeUpstoxTrades(
      [fill({ quantity: 0 }), fill({ transaction_type: "??" }), fill({ average_price: 0 })],
      TODAY,
    );
    expect(trades).toHaveLength(0);
    expect(refused).toBe(3);
  });
});

describe("warnings say what a pull can and cannot know", () => {
  it("an empty book explains itself", () => {
    const p = toParsedFile({ trades: [], refused: 0, notes: [] });
    expect(p.warnings.join(" ")).toMatch(/CURRENT trading day/i);
  });

  it("a real pull states the verified mapping and surfaces refusals and notes", () => {
    const r = normalizeUpstoxTrades([fill()], TODAY);
    const p = toParsedFile({ ...r, refused: 2, notes: ["note about a symbol"] });
    expect(p.warnings.join(" ")).toMatch(/verified against a live trade book/i);
    expect(p.warnings.join(" ")).toMatch(/2 fills .*refused/i);
    expect(p.warnings.join(" ")).toMatch(/note about a symbol/);
    expect(p.broker).toBe("upstox");
  });
});

describe("read-only by surface", () => {
  it("the module exports no order, funds or modification capability", () => {
    expect(Object.keys(upstox).sort()).toEqual([
      "canonicalUpstoxSymbol",
      "exchangeOf",
      "fetchUpstoxTrades",
      "isDerivativeExchange",
      "isinOf",
      "normalizeUpstoxTrades",
      "productHintOf",
      "stripSeriesSuffix",
      "toParsedFile",
      "upstoxImportSource",
    ]);
  });
});

const r2 = (n: number) => Math.round(n * 100) / 100;
