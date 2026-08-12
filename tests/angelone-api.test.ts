import { describe, expect, it } from "vitest";
import * as angelone from "@/lib/import/api/angelone";
import { normalizeAngelTrades, productHintOf, exchangeOf, toParsedFile, type AngelTradeRow } from "@/lib/import/api/angelone";

/**
 * Angel One SmartAPI source. The row shape is INFERRED from the published
 * docs (candidate field names, defensive reads); these tests pin the MAPPING
 * so a live response either fits or is refused visibly — never coerced.
 */

const TODAY = "2026-08-12";

const fill = (over: Partial<AngelTradeRow> = {}): AngelTradeRow => ({
  tradingsymbol: "ACME-EQ",
  exchange: "NSE",
  producttype: "DELIVERY",
  transactiontype: "BUY",
  fillsize: "10",
  fillprice: "150.5",
  filltime: "10:15:33",
  ...over,
});

describe("normalizeAngelTrades", () => {
  it("aggregates a same-day round trip per symbol + product, fills preserved", () => {
    const { trades, refused } = normalizeAngelTrades(
      [fill(), fill({ fillsize: 5, fillprice: 151 }), fill({ transactiontype: "SELL", fillsize: 15, fillprice: 155, filltime: "14:45:01" })],
      TODAY,
    );
    expect(refused).toBe(0);
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.broker).toBe("angelone");
    expect(t.buyQty).toBe(15);
    expect(t.sellQty).toBe(15);
    expect(t.buyValue).toBe(10 * 150.5 + 5 * 151);
    expect(t.grossPnl).toBe(Math.round((15 * 155 - t.buyValue) * 100) / 100);
    expect(t.buyDate).toBe(TODAY);
    expect(t.sellDate).toBe(TODAY);
    expect(t.entryTime).toBe("10:15");
    expect(t.exitTime).toBe("14:45");
    expect(t.executions).toHaveLength(3);
  });

  it("keeps different products of one symbol apart — MTF and delivery are not one trade", () => {
    const { trades } = normalizeAngelTrades([fill(), fill({ producttype: "INTRADAY" })], TODAY);
    expect(trades).toHaveLength(2);
  });

  it("an unclosed buy stays open — no sell date is invented", () => {
    const { trades } = normalizeAngelTrades([fill()], TODAY);
    expect(trades[0].sellQty).toBe(0);
    expect(trades[0].sellDate).toBeNull();
    expect(trades[0].grossPnl).toBe(0);
  });

  it("accepts the camelCase field variants the docs also show", () => {
    const { trades } = normalizeAngelTrades(
      [{ tradingSymbol: "ZETA-EQ", exchange: "BSE", productType: "INTRADAY", transactionType: "SELL", fillSize: 7, fillPrice: 99, fillTime: "09:30:00" }],
      TODAY,
    );
    expect(trades).toHaveLength(1);
    expect(trades[0].tradingsymbol).toBe("ZETA-EQ");
    expect(trades[0].sellQty).toBe(7);
    expect(trades[0].exchangeHint).toBe("BSE");
  });

  it("refuses a fill with no readable side, quantity or price — counted, never coerced", () => {
    const { trades, refused } = normalizeAngelTrades(
      [fill({ fillsize: 0 }), fill({ transactiontype: "??" }), fill({ fillprice: "" })],
      TODAY,
    );
    expect(trades).toHaveLength(0);
    expect(refused).toBe(3);
  });
});

describe("mapping tables", () => {
  it("product hints mirror the Dhan source's reasoning", () => {
    expect(productHintOf("DELIVERY")).toBe("delivery");
    expect(productHintOf("MTF")).toBe("mtf");
    expect(productHintOf("INTRADAY")).toBe("intraday");
    expect(productHintOf("BO")).toBe("intraday");
    // The F&O carry product: the classifier reads the segment off the symbol.
    expect(productHintOf("CARRYFORWARD")).toBeNull();
    expect(productHintOf("MARGIN")).toBeNull();
    expect(productHintOf(undefined)).toBeNull();
  });

  it("exchanges fold to the three the app knows, null otherwise", () => {
    expect(exchangeOf("NSE")).toBe("NSE");
    expect(exchangeOf("NFO")).toBe("NSE");
    expect(exchangeOf("BFO")).toBe("BSE");
    expect(exchangeOf("MCX")).toBe("MCX");
    expect(exchangeOf("SOMETHING")).toBeNull();
  });
});

describe("warnings say what a pull can and cannot know", () => {
  it("an empty book explains itself instead of looking broken", () => {
    const p = toParsedFile([], 0);
    expect(p.warnings.join(" ")).toMatch(/CURRENT trading day/i);
  });
  it("a real pull flags the inferred mapping and the refused count", () => {
    const { trades } = normalizeAngelTrades([fill()], TODAY);
    const p = toParsedFile(trades, 2);
    expect(p.warnings.join(" ")).toMatch(/inferred from Angel One's documentation/i);
    expect(p.warnings.join(" ")).toMatch(/2 fills .*refused/i);
  });
});

describe("read-only by surface", () => {
  it("the module exports no order, funds or modification capability", () => {
    // The whole security argument for unattended sync is that this code path
    // CANNOT trade. That is enforced by the module surface, and this pin
    // makes adding an order method a CI failure instead of a review comment.
    expect(Object.keys(angelone).sort()).toEqual([
      "angelOneImportSource",
      "angelOneLogin",
      "exchangeOf",
      "fetchAngelTradeBook",
      "normalizeAngelTrades",
      "productHintOf",
      "toParsedFile",
    ]);
  });
});
