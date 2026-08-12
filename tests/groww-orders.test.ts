import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { detectGrowwOrders, parseGrowwOrders, parseOrderDate } from "@/lib/import/parsers/groww-orders";

/**
 * Groww stocks ORDER HISTORY. The header layout is VERIFIED against a real
 * export (docs/BROKER_FORMATS.md); the sample carried no data rows, so every
 * value-level behaviour here is asserted against SYNTHETIC rows under the
 * real headers. First real import should be reconciled by hand once.
 */

const HEADER = [
  "Stock name", "Symbol", "ISIN", "Type", "Quantity", "Value",
  "Exchange", "Exchange Order Id", "Execution date and time", "Order status",
];

function wb(rows: unknown[][], withUcc = true): Buffer {
  const meta = withUcc ? [["Name"], ["Unique Client Code"], []] : [[]];
  const ws = XLSX.utils.aoa_to_sheet([...meta, HEADER, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, ws, "Sheet1");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const ctx = (buffer: Buffer, filename = "export.xlsx") => ({ filename, buffer });

const row = (over: Partial<Record<string, unknown>> = {}): unknown[] => {
  const d: Record<string, unknown> = {
    "Stock name": "Acme Industries", Symbol: "ACME", ISIN: "INE000000001", Type: "Buy",
    Quantity: 10, Value: 1500, Exchange: "NSE", "Exchange Order Id": "X1",
    "Execution date and time": "2026-07-01 10:15:00", "Order status": "Executed",
    ...over,
  };
  return HEADER.map((h) => d[h]);
};

describe("detection needs the fingerprint, not just the shape", () => {
  it("claims a file with the Unique Client Code label even under a neutral filename", () => {
    expect(detectGrowwOrders(ctx(wb([row()])))).toBeGreaterThanOrEqual(0.7);
  });

  it("refuses the same table without the label or a Groww filename", () => {
    // The header set alone is column SHAPE — the exact evidence class that
    // once let this file import as Zerodha in the other direction.
    expect(detectGrowwOrders(ctx(wb([row()], false)))).toBe(0);
  });

  it("accepts a named file without the label", () => {
    expect(detectGrowwOrders(ctx(wb([row()], false), "Stocks_Order_History_X.xlsx"))).toBeGreaterThan(0);
  });
});

describe("values (synthetic rows)", () => {
  it("derives price as Value ÷ Quantity — the file has no price column", () => {
    const p = parseGrowwOrders(ctx(wb([row()])));
    expect(p.trades).toHaveLength(1);
    expect(p.trades[0].avgBuyPrice).toBe(150);
    expect(p.trades[0].buyValue).toBe(1500);
  });

  it("pairs a same-day round trip into one intraday position", () => {
    const p = parseGrowwOrders(ctx(wb([
      row(),
      row({ Type: "Sell", Value: 1600, "Execution date and time": "2026-07-01 14:30:00" }),
    ])));
    expect(p.trades).toHaveLength(1);
    const t = p.trades[0];
    expect(t.productHint).toBe("intraday");
    expect(t.grossPnl).toBe(100);
    expect(t.entryTime).toBe("10:15");
    expect(t.exitTime).toBe("14:30");
    expect(t.productDerived).toBe(true);
  });

  it("a cross-day close is delivery, with real entry and exit dates", () => {
    const p = parseGrowwOrders(ctx(wb([
      row(),
      row({ Type: "Sell", Value: 1600, "Execution date and time": "2026-07-08 11:00:00" }),
    ])));
    expect(p.trades[0].productHint).toBe("delivery");
    expect(p.trades[0].buyDate).toBe("2026-07-01");
    expect(p.trades[0].sellDate).toBe("2026-07-08");
  });

  it("ignores non-executed orders and says how many", () => {
    const p = parseGrowwOrders(ctx(wb([row(), row({ "Order status": "Cancelled" })])));
    expect(p.trades).toHaveLength(1);
    expect(p.warnings.join(" ")).toMatch(/1 Cancelled/);
  });

  it("refuses a row with a zero quantity rather than inventing a free trade", () => {
    const p = parseGrowwOrders(ctx(wb([row({ Quantity: 0 })])));
    expect(p.trades).toHaveLength(0);
    expect(p.warnings.join(" ")).toMatch(/refused/i);
  });

  it("a sell with no matching buy is flagged basis-unknown, not booked as all profit", () => {
    const p = parseGrowwOrders(ctx(wb([row({ Type: "Sell", Value: 2000 })])));
    expect(p.trades[0].basisUnknown).toBe(true);
    expect(p.trades[0].grossPnl).toBe(0);
  });

  it("reports source lines so '2 lines → 1 trade' reads as pairing, not loss", () => {
    const p = parseGrowwOrders(ctx(wb([row(), row({ Type: "Sell", Value: 1600 })])));
    expect(p.sourceRows).toBe(2);
    expect(p.trades).toHaveLength(1);
  });

  it("always warns that the file carries no charges", () => {
    const p = parseGrowwOrders(ctx(wb([row()])));
    expect(p.warnings.join(" ")).toMatch(/no charges/i);
  });
});

describe("date reading", () => {
  it("accepts the formats Indian broker exports actually use", () => {
    expect(parseOrderDate("2026-07-01 10:15:00")).toBe("2026-07-01");
    expect(parseOrderDate("01-07-2026 10:15")).toBe("2026-07-01");
    expect(parseOrderDate("01/07/2026")).toBe("2026-07-01");
    expect(parseOrderDate("1 Jul 2026")).toBe("2026-07-01");
    expect(parseOrderDate("garbage")).toBeNull();
  });
});
