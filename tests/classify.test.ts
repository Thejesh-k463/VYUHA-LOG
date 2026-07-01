import { describe, it, expect } from "vitest";
import { classify, parseInstrumentName } from "@/lib/engine/classify";
import { loadDhan, loadGroww } from "./fixtures-loader";

describe("parseInstrumentName", () => {
  it("parses Dhan OPT names (symbol, expiry, strike, type)", () => {
    expect(parseInstrumentName("OPT INOXWIND 30 Jun 2026 80 PE")).toEqual({
      kind: "option",
      symbol: "INOXWIND",
      expiry: "2026-06-30",
      strike: 80,
      optionType: "PE",
    });
  });

  it("parses decimal strikes", () => {
    const p = parseInstrumentName("OPT TATASTEEL 30 Jun 2026 187.5 PE");
    expect(p.strike).toBe(187.5);
    expect(p.symbol).toBe("TATASTEEL");
  });

  it("parses FUT names", () => {
    expect(parseInstrumentName("FUT CRUDEOIL 19 Jun 2026")).toEqual({
      kind: "future",
      symbol: "CRUDEOIL",
      expiry: "2026-06-19",
      strike: null,
      optionType: null,
    });
  });

  it("treats a plain name as equity", () => {
    const p = parseInstrumentName("Himadri Speciality Chemical");
    expect(p.kind).toBe("equity");
    expect(p.symbol).toBe("Himadri Speciality Chemical");
  });
});

describe("classify — segment & bucket rules (§4)", () => {
  it("index options → index_option / active; NSE vs BSE underlyings", () => {
    expect(classify({ tradingsymbol: "OPT NIFTY 09 Jun 2026 22800 PE" })).toMatchObject({
      segment: "index_option",
      bucket: "active",
      exchange: "NSE",
      symbol: "NIFTY",
    });
    expect(classify({ tradingsymbol: "OPT SENSEX 11 Jun 2026 72000 PE" })).toMatchObject({
      segment: "index_option",
      exchange: "BSE",
    });
    expect(classify({ tradingsymbol: "OPT BANKNIFTY 30 Jun 2026 54000 PE" })).toMatchObject({
      segment: "index_option",
      exchange: "NSE",
    });
  });

  it("commodity options → commodity_option / active / MCX", () => {
    expect(classify({ tradingsymbol: "OPT CRUDEOIL 09 Jun 2026 8000 PE" })).toMatchObject({
      segment: "commodity_option",
      bucket: "active",
      exchange: "MCX",
    });
  });

  it("stock options → stock_option / active / NSE", () => {
    expect(classify({ tradingsymbol: "OPT RELIANCE 30 Jun 2026 1380 CE" })).toMatchObject({
      segment: "stock_option",
      bucket: "active",
      exchange: "NSE",
      optionType: "CE",
    });
  });

  it("equity splits by product hint", () => {
    expect(classify({ tradingsymbol: "ITC", productHint: "delivery" })).toMatchObject({
      segment: "eq_delivery",
      bucket: "equity",
    });
    expect(classify({ tradingsymbol: "ITC", productHint: "intraday" })).toMatchObject({
      segment: "eq_intraday",
      bucket: "active",
    });
    expect(classify({ tradingsymbol: "ITC", productHint: "mtf" })).toMatchObject({
      segment: "eq_mtf",
      bucket: "equity",
    });
  });

  it("equity with no hint defaults to delivery", () => {
    expect(classify({ tradingsymbol: "TATAMOTORS" }).segment).toBe("eq_delivery");
  });
});

describe("classify — every sample row classifies", () => {
  it("Dhan rows: 79 index, 36 stock, 1 commodity option, 6 equity", () => {
    const { trades } = loadDhan();
    const counts: Record<string, number> = {};
    for (const t of trades) {
      const c = classify({
        tradingsymbol: t.tradingsymbol,
        broker: t.broker,
        productHint: t.productHint,
      });
      counts[c.segment] = (counts[c.segment] ?? 0) + 1;
      // every option carries parsed fields
      if (c.instrumentType === "option") {
        expect(c.optionType === "CE" || c.optionType === "PE").toBe(true);
        expect(c.expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(typeof c.strike).toBe("number");
      }
    }
    expect(trades.length).toBe(122);
    expect(counts.index_option).toBe(79);
    expect(counts.stock_option).toBe(36);
    expect(counts.commodity_option).toBe(1);
    expect(counts.eq_delivery).toBe(6);
  });

  it("Groww rows: 85 intraday, 45 delivery (42 closed + 3 open)", () => {
    const { trades } = loadGroww();
    const counts: Record<string, number> = {};
    for (const t of trades) {
      const c = classify({
        tradingsymbol: t.tradingsymbol,
        broker: t.broker,
        productHint: t.productHint,
      });
      counts[c.segment] = (counts[c.segment] ?? 0) + 1;
      expect(c.instrumentType).toBe("equity");
    }
    expect(counts.eq_intraday).toBe(85);
    expect(counts.eq_delivery).toBe(45);
    expect(trades.length).toBe(130);
  });
});
