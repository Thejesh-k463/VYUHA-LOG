import { describe, expect, it } from "vitest";
import {
  applyMapping,
  readNumber,
  readProduct,
  readSide,
  shapeOf,
  suggestMapping,
  validateMapping,
  type ColumnMapping,
} from "@/lib/import/generic-map";

const OPTS = { broker: "kotakneo" as const, filename: "kotak.csv" };

describe("readNumber — refuses rather than coerces", () => {
  it("reads the shapes Indian brokers actually emit", () => {
    expect(readNumber("1,234.50")).toBe(1234.5);
    expect(readNumber("₹1,23,456")).toBe(123456);
    expect(readNumber("  42 ")).toBe(42);
    expect(readNumber("0")).toBe(0);
  });

  it("reads all three negative conventions", () => {
    expect(readNumber("-500")).toBe(-500);
    expect(readNumber("(500)")).toBe(-500);
    expect(readNumber("500-")).toBe(-500);
  });

  it("returns NULL, never 0, for anything that is not a number", () => {
    // This is the whole point: a mis-mapped column must not become a real
    // trade for zero shares at zero rupees.
    for (const junk of ["", "-", "N/A", "RELIANCE", "abc", "12abc", null, undefined]) {
      expect(readNumber(junk), String(junk)).toBeNull();
    }
  });
});

describe("readSide", () => {
  it("accepts every word brokers use", () => {
    for (const b of ["B", "buy", "BOUGHT", "Purchase", "P"]) expect(readSide(b)).toBe("buy");
    for (const s of ["S", "sell", "SOLD", "Sale", "SL"]) expect(readSide(s)).toBe("sell");
  });

  it("prefers sell when a cell mentions both — 'buy/sell' must not read as buy", () => {
    expect(readSide("buy/sell")).toBe("sell");
  });

  it("is null for anything unrecognisable", () => {
    expect(readSide("")).toBeNull();
    expect(readSide("XYZ")).toBeNull();
  });
});

describe("readProduct", () => {
  it("maps every broker's vocabulary onto the canonical hint", () => {
    expect(readProduct("CNC")).toBe("delivery");
    expect(readProduct("Delivery")).toBe("delivery");
    expect(readProduct("MIS")).toBe("intraday");
    expect(readProduct("Intraday")).toBe("intraday");
    expect(readProduct("MTF")).toBe("mtf");
    expect(readProduct("Margin Trade Funding")).toBe("mtf");
  });

  it("is null when the file says nothing useful", () => {
    expect(readProduct("")).toBeNull();
    expect(readProduct("NRML")).toBeNull();
  });
});

describe("suggestMapping", () => {
  it("finds the obvious columns in a tradebook header", () => {
    const headers = ["Trade Date", "Symbol", "Trade Type", "Quantity", "Price", "Exchange"];
    const m = suggestMapping(headers);
    expect(m.date).toBe(0);
    expect(m.tradingsymbol).toBe(1);
    expect(m.side).toBe(2);
    expect(m.qty).toBe(3);
    expect(m.price).toBe(4);
    expect(m.exchange).toBe(5);
  });

  it("does not let the generic 'price' matcher steal a buy/sell price column", () => {
    // The bug this prevents: "Buy Price" matching /price/ for the executions
    // `price` field, leaving avgBuyPrice unmapped on a P&L file.
    const headers = ["Scrip Name", "Buy Qty", "Buy Price", "Sell Qty", "Sell Price"];
    const m = suggestMapping(headers);
    expect(m.tradingsymbol).toBe(0);
    expect(m.buyQty).toBe(1);
    expect(m.avgBuyPrice).toBe(2);
    expect(m.sellQty).toBe(3);
    expect(m.avgSellPrice).toBe(4);
  });

  it("never assigns one column to two fields", () => {
    const headers = ["Date", "Symbol", "Qty", "Price", "Type", "P&L", "Charges"];
    const m = suggestMapping(headers);
    const used = Object.values(m).filter((v): v is number => v !== undefined);
    expect(new Set(used).size).toBe(used.length);
  });

  it("leaves fields unmapped rather than inventing a column", () => {
    const m = suggestMapping(["Foo", "Bar", "Baz"]);
    expect(m.tradingsymbol).toBeUndefined();
    expect(m.qty).toBeUndefined();
  });
});

describe("validateMapping / shapeOf", () => {
  it("a side column means execution shape", () => {
    expect(shapeOf({ side: 2 })).toBe("executions");
    expect(shapeOf({ buyQty: 1 })).toBe("roundtrip");
  });

  it("reports exactly which required fields are still missing", () => {
    const check = validateMapping({ side: 0, tradingsymbol: 1 });
    expect(check.ok).toBe(false);
    expect(check.shape).toBe("executions");
    expect(check.missing).toEqual(expect.arrayContaining(["qty", "price", "date"]));
  });

  it("passes when the active shape's requirements are met", () => {
    expect(validateMapping({ tradingsymbol: 0, side: 1, qty: 2, price: 3, date: 4 }).ok).toBe(true);
    expect(validateMapping({ tradingsymbol: 0, buyQty: 1, avgBuyPrice: 2, sellQty: 3, avgSellPrice: 4 }).ok).toBe(true);
  });

  it("does not demand round-trip fields of an execution file, or vice versa", () => {
    const exec = validateMapping({ tradingsymbol: 0, side: 1, qty: 2, price: 3, date: 4 });
    expect(exec.missing).not.toContain("avgBuyPrice");
    const rt = validateMapping({ tradingsymbol: 0, buyQty: 1, avgBuyPrice: 2, sellQty: 3, avgSellPrice: 4 });
    expect(rt.missing).not.toContain("date");
  });
});

describe("applyMapping — execution shape", () => {
  const headers = ["Date", "Symbol", "Type", "Qty", "Price"];
  const m: ColumnMapping = { date: 0, tradingsymbol: 1, side: 2, qty: 3, price: 4 };

  it("pairs a buy and a later sell into ONE closed trade", () => {
    const rows = [
      ["06-07-2026", "GMBREW", "BUY", "650", "100"],
      ["07-07-2026", "GMBREW", "SELL", "650", "110"],
    ];
    const r = applyMapping(headers, rows, m, OPTS);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.tradingsymbol).toBe("GMBREW");
    expect(t.buyQty).toBe(650);
    expect(t.sellQty).toBe(650);
    expect(t.buyDate).toBe("2026-07-06");
    expect(t.sellDate).toBe("2026-07-07");
    expect(t.grossPnl).toBe(6500);
    expect(t.broker).toBe("kotakneo");
  });

  it("aggregates laddered fills per scrip-day — ONE position, not one per fill", () => {
    // SME books fill 11 + 2 + 2 + 3 shares at a time; pairLegs emits one
    // closed position per SELL leg, so raw fills would report ~10x the
    // positions the trader took. Fills must merge into one leg per
    // symbol|date|side before pairing (same as the Zerodha tradebook parser).
    const rows = [
      ["06-07-2026", "SMESTK", "BUY", "11", "100"],
      ["06-07-2026", "SMESTK", "BUY", "2", "101"],
      ["06-07-2026", "SMESTK", "BUY", "2", "102"],
      ["06-07-2026", "SMESTK", "BUY", "3", "103"],
      ["07-07-2026", "SMESTK", "SELL", "18", "110"],
    ];
    const r = applyMapping(headers, rows, m, OPTS);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.buyQty).toBe(18);
    expect(t.sellQty).toBe(18);
    expect(t.buyValue).toBe(1815); // 11×100 + 2×101 + 2×102 + 3×103
    expect(t.avgBuyPrice).toBe(100.83); // weighted, not any single fill's price
    expect(t.grossPnl).toBe(165); // 18×110 − 1815
    expect(t.buyDate).toBe("2026-07-06");
    expect(t.sellDate).toBe("2026-07-07");
  });

  it("laddered SELL fills on one day also close as one position", () => {
    const rows = [
      ["06-07-2026", "SMESTK", "BUY", "18", "100"],
      ["07-07-2026", "SMESTK", "SELL", "10", "110"],
      ["07-07-2026", "SMESTK", "SELL", "8", "111"],
    ];
    const r = applyMapping(headers, rows, m, OPTS);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].sellQty).toBe(18);
    expect(r.trades[0].sellValue).toBe(1988); // 10×110 + 8×111
    expect(r.trades[0].avgSellPrice).toBe(110.44);
  });

  it("a sell with no buy is flagged basis-unknown, not scored as pure profit", () => {
    // The IPO-allotment case. Reporting 100% gain because buyValue is 0 would
    // be a fabrication — pairLegs marks it and the caller excludes it.
    const r = applyMapping(headers, [["07-07-2026", "IPOSTK", "SELL", "10", "500"]], m, OPTS);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].basisUnknown).toBe(true);
    expect(r.trades[0].grossPnl).toBe(0);
  });

  it("leftover buys stay open with no sell date", () => {
    const rows = [
      ["06-07-2026", "TCS", "BUY", "10", "3000"],
      ["07-07-2026", "TCS", "SELL", "4", "3100"],
    ];
    const r = applyMapping(headers, rows, m, OPTS);
    const open = r.trades.find((t) => t.sellQty === 0);
    expect(open).toBeDefined();
    expect(open!.buyQty).toBe(6);
    expect(open!.sellDate).toBeNull();
  });

  it("SKIPS a row whose quantity is not a number, and says so", () => {
    const rows = [
      ["06-07-2026", "TCS", "BUY", "10", "3000"],
      ["06-07-2026", "TCS", "BUY", "N/A", "3000"],
    ];
    const r = applyMapping(headers, rows, m, OPTS);
    expect(r.skipped).toBe(1);
    expect(r.trades[0].buyQty).toBe(10); // the bad row contributed nothing
    expect(r.warnings.join(" ")).toMatch(/skipped/i);
  });

  it("skips undated rows and names the accepted date formats", () => {
    const r = applyMapping(headers, [["not a date", "TCS", "BUY", "1", "10"]], m, OPTS);
    expect(r.skipped).toBe(1);
    expect(r.warnings.join(" ")).toMatch(/dd-MMM-yyyy/);
  });

  it("accepts dd-MMM-yyyy, which Kotak and Paytm use", () => {
    const rows = [
      ["06-Jul-2026", "TCS", "BUY", "1", "10"],
      ["07-Jul-2026", "TCS", "SELL", "1", "12"],
    ];
    const r = applyMapping(headers, rows, m, OPTS);
    expect(r.trades[0].buyDate).toBe("2026-07-06");
    expect(r.trades[0].sellDate).toBe("2026-07-07");
  });

  it("carries trade times through when a time column is mapped", () => {
    const h2 = [...headers, "Time"];
    const m2 = { ...m, time: 5 };
    const rows = [
      ["06-07-2026", "TCS", "BUY", "1", "10", "09:20:11"],
      ["06-07-2026", "TCS", "SELL", "1", "12", "14:05:00"],
    ];
    const r = applyMapping(h2, rows, m2, OPTS);
    expect(r.trades[0].entryTime).toBe("09:20");
    expect(r.trades[0].exitTime).toBe("14:05");
  });

  it("adopts a product only when the whole file agrees on one", () => {
    const h2 = [...headers, "Product"];
    const mixed = [
      ["06-07-2026", "A", "BUY", "1", "10", "CNC"],
      ["06-07-2026", "B", "BUY", "1", "10", "MIS"],
    ];
    expect(applyMapping(h2, mixed, { ...m, product: 5 }, OPTS).trades[0].productHint).toBeNull();

    const uniform = [
      ["06-07-2026", "A", "BUY", "1", "10", "MTF"],
      ["07-07-2026", "A", "SELL", "1", "12", "MTF"],
    ];
    expect(applyMapping(h2, uniform, { ...m, product: 5 }, OPTS).trades[0].productHint).toBe("mtf");
  });
});

describe("applyMapping — round-trip shape", () => {
  const headers = ["Scrip", "Buy Qty", "Buy Price", "Sell Qty", "Sell Price", "P&L"];
  const m: ColumnMapping = { tradingsymbol: 0, buyQty: 1, avgBuyPrice: 2, sellQty: 3, avgSellPrice: 4, grossPnl: 5 };

  it("builds one trade per row with values derived from qty x price", () => {
    const r = applyMapping(headers, [["RELIANCE", "10", "2400", "10", "2500", "1000"]], m, OPTS);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.buyValue).toBe(24000);
    expect(t.sellValue).toBe(25000);
    expect(t.grossPnl).toBe(1000);
  });

  it("trusts the broker's stated P&L over one derived from averages", () => {
    // Averages hide part-fill rounding; the broker's own figure does not.
    const r = applyMapping(headers, [["X", "3", "100.333", "3", "110.667", "31"]], m, OPTS);
    expect(r.trades[0].grossPnl).toBe(31);
  });

  it("derives P&L when the file does not state it", () => {
    const noPnl = { ...m, grossPnl: undefined };
    const r = applyMapping(headers, [["X", "10", "100", "10", "110"]], noPnl, OPTS);
    // 10 × 110 − 10 × 100
    expect(r.trades[0].grossPnl).toBe(100);
  });

  it("skips blank and subtotal rows without inventing trades", () => {
    const rows = [
      ["RELIANCE", "10", "2400", "10", "2500", "1000"],
      ["", "", "", "", "", ""],
      ["Total", "", "", "", "", "1000"],
    ];
    const r = applyMapping(headers, rows, m, OPTS);
    expect(r.trades).toHaveLength(1);
    expect(r.skipped).toBe(2);
  });
});

describe("applyMapping — refuses an incomplete mapping outright", () => {
  it("imports nothing and names what is missing", () => {
    const r = applyMapping(["A", "B"], [["x", "y"]], { tradingsymbol: 0 }, OPTS);
    expect(r.trades).toHaveLength(0);
    expect(r.skipped).toBe(1);
    expect(r.warnings[0]).toMatch(/Mapping incomplete/);
  });
});
