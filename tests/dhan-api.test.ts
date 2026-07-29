import { describe, it, expect } from "vitest";
import {
  normalizeDhanPositions, productHintOf, exchangeOf, toParsedFile,
  type DhanPositionRow,
} from "@/lib/import/api/dhan";

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
