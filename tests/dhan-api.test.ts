import { describe, it, expect } from "vitest";
import {
  normalizeDhanPositions, productHintOf, exchangeOf, toParsedFile,
  canonicalDerivativeName, markOf,
  type DhanPositionRow,
} from "@/lib/import/api/dhan";
import { classify } from "@/lib/engine/classify";

const row = (p: Partial<DhanPositionRow>): DhanPositionRow => ({
  tradingSymbol: "TCS",
  positionType: "LONG",
  exchangeSegment: "NSE_EQ",
  productType: "CNC",
  buyAvg: 0, buyQty: 0, sellAvg: 0, sellQty: 0, netQty: 0,
  ...p,
});

describe("productHintOf — the whole reason this integration exists", () => {
  it("maps MTF, which no Dhan FILE can express", () => {
    expect(productHintOf("MTF")).toBe("mtf");
    expect(productHintOf("mtf")).toBe("mtf");
  });

  it("maps the products a file could already infer", () => {
    expect(productHintOf("CNC")).toBe("delivery");
    expect(productHintOf("INTRADAY")).toBe("intraday");
  });

  it("treats cover and bracket orders as intraday — they cannot be anything else", () => {
    expect(productHintOf("CO")).toBe("intraday");
    expect(productHintOf("BO")).toBe("intraday");
  });

  it("returns null for MARGIN and unknown types, leaving the symbol to decide", () => {
    // MARGIN is the F&O carry-forward product; the classifier reads the segment
    // off the symbol, and an equity hint would only fight it.
    expect(productHintOf("MARGIN")).toBeNull();
    expect(productHintOf("SOMETHING_NEW")).toBeNull();
  });
});

describe("exchangeOf", () => {
  it("maps the segment prefixes Dhan actually sends", () => {
    expect(exchangeOf("NSE_EQ")).toBe("NSE");
    expect(exchangeOf("NSE_FNO")).toBe("NSE");
    expect(exchangeOf("BSE_EQ")).toBe("BSE");
    expect(exchangeOf("MCX_COMM")).toBe("MCX");
  });

  it("returns null rather than guessing on an unknown segment", () => {
    expect(exchangeOf("XYZ_ABC")).toBeNull();
    expect(exchangeOf("")).toBeNull();
  });
});

describe("normalizeDhanPositions", () => {
  const TODAY = "2026-07-29";

  it("marks an MTF position as MTF, with a note saying it was STATED not inferred", () => {
    const [t] = normalizeDhanPositions(
      [row({ tradingSymbol: "TATASTEEL", productType: "MTF", buyQty: 500, buyAvg: 160, netQty: 500 })],
      TODAY,
    );
    expect(t.productHint).toBe("mtf");
    expect(t.buyValue).toBe(80000);
    expect(t.importNotes?.join(" ")).toMatch(/stated by the Dhan API as MTF/i);
  });

  it("treats a same-day round trip as CLOSED and dates both legs today", () => {
    const [t] = normalizeDhanPositions(
      [row({ productType: "INTRADAY", buyQty: 100, buyAvg: 3300, sellQty: 100, sellAvg: 3345, netQty: 0, realizedProfit: 4500 })],
      TODAY,
    );
    expect(t.buyDate).toBe(TODAY);
    expect(t.sellDate).toBe(TODAY);
    expect(t.grossPnl).toBe(4500);
    expect(t.productHint).toBe("intraday");
  });

  it("leaves an open position without a sell date", () => {
    const [t] = normalizeDhanPositions(
      [row({ productType: "CNC", buyQty: 40, buyAvg: 3345.8, netQty: 40, unrealizedProfit: 6122 })],
      TODAY,
    );
    expect(t.sellDate).toBeNull();
    expect(t.buyDate).toBe(TODAY);
    expect(t.unrealisedPnl).toBe(6122);
    expect(t.grossPnl).toBe(0);
  });

  it("prefers the BROKER'S realised profit over our own subtraction", () => {
    // Dhan nets charges and averages its own way; its number is authoritative.
    const [t] = normalizeDhanPositions(
      [row({ buyQty: 10, buyAvg: 100, sellQty: 10, sellAvg: 110, netQty: 0, realizedProfit: 97.5 })],
      TODAY,
    );
    expect(t.grossPnl).toBe(97.5); // not the naive 100
  });

  it("falls back to the legs when realisedProfit is absent", () => {
    const [t] = normalizeDhanPositions(
      [row({ buyQty: 10, buyAvg: 100, sellQty: 10, sellAvg: 110, netQty: 0 })],
      TODAY,
    );
    expect(t.grossPnl).toBe(100);
  });

  it("skips rows where nothing was traded", () => {
    expect(normalizeDhanPositions([row({ buyQty: 0, sellQty: 0 })], TODAY)).toHaveLength(0);
  });

  it("never sets an execution time — the endpoint carries only aggregates", () => {
    const out = normalizeDhanPositions([row({ buyQty: 1, buyAvg: 10, netQty: 1 })], TODAY);
    expect(out[0].entryTime).toBeNull();
    expect(out[0].exitTime).toBeNull();
  });

  it("handles an empty book without throwing", () => {
    expect(normalizeDhanPositions([], TODAY)).toEqual([]);
  });
});

// Values in this block are from a REAL /v2/positions payload (2026-08-26, the
// first live pull that ever returned F&O fills). That pull found the defect
// these tests pin: the API's hyphenated symbols fell through parseInstrumentName
// to the equity branch, so ten option positions were charged equity STT.
describe("canonicalDerivativeName — F&O names built from Dhan's STATED drv* fields", () => {
  it("builds the canonical OPT name for a stock option (real row)", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "BANKINDIA-Sep2026-155-CE", exchangeSegment: "NSE_FNO", productType: "MARGIN",
        drvExpiryDate: "2026-09-29 14:30:00", drvOptionType: "CALL", drvStrikePrice: 155.0,
      })),
    ).toBe("OPT BANKINDIA 29 Sep 2026 155 CE");
  });

  it("builds the canonical OPT name for a BSE index option (real row)", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "SENSEX-Aug2026-77300-PE", exchangeSegment: "BSE_FNO", productType: "INTRADAY",
        drvExpiryDate: "2026-08-27 15:30:00", drvOptionType: "PUT", drvStrikePrice: 77300.0,
      })),
    ).toBe("OPT SENSEX 27 Aug 2026 77300 PE");
  });

  it("builds a FUT name when the row has an expiry but no option type", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "NIFTY-Sep2026-FUT", exchangeSegment: "NSE_FNO", productType: "MARGIN",
        drvExpiryDate: "2026-09-29 14:30:00", drvOptionType: "NA", drvStrikePrice: 0,
      })),
    ).toBe("FUT NIFTY 29 Sep 2026");
  });

  it("keeps a fractional strike fractional and an integer strike bare", () => {
    const base = {
      exchangeSegment: "NSE_FNO", drvExpiryDate: "2026-09-29 14:30:00", drvOptionType: "CALL" as const,
    };
    expect(
      canonicalDerivativeName(row({ ...base, tradingSymbol: "X-CE", drvStrikePrice: 88.5 })),
    ).toBe("OPT X 29 Sep 2026 88.5 CE");
    expect(
      canonicalDerivativeName(row({ ...base, tradingSymbol: "X-CE", drvStrikePrice: 78200.0 })),
    ).toBe("OPT X 29 Sep 2026 78200 CE");
  });

  it("returns null for an equity row — Dhan's sentinels are 0001-01-01 / NA / 0 (real row)", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "GAJA", exchangeSegment: "NSE_EQ", productType: "INTRADAY",
        drvExpiryDate: "0001-01-01", drvOptionType: "NA", drvStrikePrice: 0.0,
      })),
    ).toBeNull();
  });

  it("returns null rather than guessing when an F&O row states no usable expiry", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "BANKINDIA-Sep2026-155-CE", exchangeSegment: "NSE_FNO",
        drvExpiryDate: "0001-01-01", drvOptionType: "CALL", drvStrikePrice: 155,
      })),
    ).toBeNull();
  });

  it("the canonical name actually classifies as an option with the right exchange", () => {
    const name = canonicalDerivativeName(row({
      tradingSymbol: "SENSEX-Aug2026-78200-CE", exchangeSegment: "BSE_FNO",
      drvExpiryDate: "2026-08-27 15:30:00", drvOptionType: "CALL", drvStrikePrice: 78200,
    }))!;
    const cls = classify({ tradingsymbol: name, exchangeHint: exchangeOf("BSE_FNO"), productHint: null });
    expect(cls.instrumentType).toBe("option");
    expect(cls.segment).toBe("index_option");
    expect(cls.exchange).toBe("BSE");
    expect(cls.expiry).toBe("2026-08-27");
    expect(cls.strike).toBe(78200);
    expect(cls.optionType).toBe("CE");
  });
});

describe("markOf — the broker's own mark for an open position", () => {
  it("reproduces Dhan's displayed LTP from entry ± unrealised/qty (real rows)", () => {
    // Dhan's UI showed LTP 1.30 / 2.90 / 38.25 for these exact positions.
    expect(markOf(row({ buyAvg: 1.7, buyQty: 5200, netQty: 5200, unrealizedProfit: -2080 }))).toBe(1.3);
    expect(markOf(row({ buyAvg: 2.85, buyQty: 1275, netQty: 1275, unrealizedProfit: 63.75 }))).toBe(2.9);
    expect(markOf(row({ buyAvg: 41.2, buyQty: 175, netQty: 175, unrealizedProfit: -516.25 }))).toBe(38.25);
  });

  it("derives a short position's mark from the SELL side", () => {
    expect(markOf(row({ sellAvg: 50, sellQty: 100, netQty: -100, unrealizedProfit: 500 }))).toBe(45);
  });

  it("returns null for a closed position and when no unrealised figure is stated", () => {
    expect(markOf(row({ buyQty: 100, sellQty: 100, netQty: 0, unrealizedProfit: 0 }))).toBeNull();
    expect(markOf(row({ buyQty: 100, netQty: 100, unrealizedProfit: undefined }))).toBeNull();
  });
});

describe("normalizeDhanPositions — derivatives (the 2026-08-26 defect, end to end)", () => {
  const TODAY = "2026-08-26";

  it("commits an option under its canonical name with the broker's mark", () => {
    const [t] = normalizeDhanPositions(
      [row({
        tradingSymbol: "BANKINDIA-Sep2026-155-CE", exchangeSegment: "NSE_FNO", productType: "MARGIN",
        buyAvg: 1.7, buyQty: 5200, netQty: 5200, unrealizedProfit: -2080,
        drvExpiryDate: "2026-09-29 14:30:00", drvOptionType: "CALL", drvStrikePrice: 155,
      })],
      TODAY,
    );
    expect(t.tradingsymbol).toBe("OPT BANKINDIA 29 Sep 2026 155 CE");
    expect(t.closingPrice).toBe(1.3);
    expect(t.unrealisedPnl).toBe(-2080);
    expect(t.importNotes).toBeNull();
  });

  it("keeps the raw name and SAYS SO when an F&O row's stated facts are incomplete", () => {
    const [t] = normalizeDhanPositions(
      [row({
        tradingSymbol: "MYSTERY-THING", exchangeSegment: "NSE_FNO", productType: "MARGIN",
        buyAvg: 10, buyQty: 1, netQty: 1,
        drvExpiryDate: "0001-01-01", drvOptionType: "NA", drvStrikePrice: 0,
      })],
      TODAY,
    );
    expect(t.tradingsymbol).toBe("MYSTERY-THING");
    expect(t.importNotes?.join(" ")).toMatch(/stated no usable expiry\/strike/i);
  });

  it("leaves an equity symbol untouched", () => {
    const [t] = normalizeDhanPositions(
      [row({ tradingSymbol: "GAJA", exchangeSegment: "NSE_EQ", productType: "INTRADAY",
        buyAvg: 176.41, buyQty: 850, sellAvg: 173.84, sellQty: 850, netQty: 0,
        drvExpiryDate: "0001-01-01", drvOptionType: "NA", drvStrikePrice: 0 })],
      TODAY,
    );
    expect(t.tradingsymbol).toBe("GAJA");
    expect(t.closingPrice).toBeNull();
  });
});

describe("toParsedFile", () => {
  const TODAY = "2026-07-29";

  it("says plainly when MTF was found, and that it needed no confirming", () => {
    const trades = normalizeDhanPositions(
      [row({ productType: "MTF", buyQty: 500, buyAvg: 160, netQty: 500 })],
      TODAY,
    );
    const p = toParsedFile(trades);
    expect(p.broker).toBe("dhan");
    expect(p.warnings.join(" ")).toMatch(/1 position is MTF according to Dhan itself/i);
    expect(p.warnings.join(" ")).toMatch(/need no confirmation/i);
  });

  it("says so when there is no MTF, rather than staying silent", () => {
    const trades = normalizeDhanPositions([row({ productType: "CNC", buyQty: 1, buyAvg: 10, netQty: 1 })], TODAY);
    expect(toParsedFile(trades).warnings.join(" ")).toMatch(/No MTF positions/i);
  });

  it("explains an empty pull instead of looking broken", () => {
    expect(toParsedFile([]).warnings.join(" ")).toMatch(/current trading day/i);
  });
});
