import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { detectPaytmTradebook, parsePaytmTradebook } from "@/lib/import/parsers/paytm-tradebook";

/**
 * Paytm Money TRADEBOOK. Header layout VERIFIED against a real export (four
 * metadata rows, header on row 5, per-execution charges); the sample carried
 * no data rows, so value behaviour is asserted on SYNTHETIC rows under the
 * real headers. First real import should be reconciled against a contract
 * note once — the DECISIONS.md entry for this parser says why it exists at
 * all despite the unpublished-format rule.
 */

const HEADER = [
  "Date", "Script", "ISIN", "Exchange", "Product Type", "Type", "Quantity", "Price",
  "Brokerage", "ETT", "GST", "STT", "SEBI", "Stamp Duty", "Order Number", "Trade Number", "Trade Time",
];

function wb(rows: unknown[][], withUcc = true): Buffer {
  const meta = withUcc ? [["UCC"], ["Name"], ["PAN Number"], ["Period"]] : [[]];
  const ws = XLSX.utils.aoa_to_sheet([...meta, HEADER, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, ws, "Sheet1");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const ctx = (buffer: Buffer, filename = "export.xlsx") => ({ filename, buffer });

const row = (over: Partial<Record<string, unknown>> = {}): unknown[] => {
  const d: Record<string, unknown> = {
    Date: "01-07-2026", Script: "ACME", ISIN: "INE000000001", Exchange: "NSE",
    "Product Type": "Delivery", Type: "Buy", Quantity: 10, Price: 150,
    Brokerage: 2.5, ETT: 0.5, GST: 0.54, STT: 1.5, SEBI: 0.01, "Stamp Duty": 0.23,
    "Order Number": "O1", "Trade Number": "T1", "Trade Time": "10:15:00",
    ...over,
  };
  return HEADER.map((h) => d[h]);
};

describe("detection", () => {
  it("claims on the UCC label + Script/ETT header under a neutral filename", () => {
    expect(detectPaytmTradebook(ctx(wb([row()])))).toBeGreaterThanOrEqual(0.7);
  });

  it("refuses the bare table without the UCC label or a Paytm filename", () => {
    expect(detectPaytmTradebook(ctx(wb([row()], false)))).toBe(0);
  });

  it("accepts a Paytm-named file without the label", () => {
    expect(detectPaytmTradebook(ctx(wb([row()], false), "Paytm Money - Tradebook.xlsx"))).toBeGreaterThan(0);
  });
});

describe("values (synthetic rows)", () => {
  it("aggregates executions per Script and SUMS the broker's stated charges", () => {
    const p = parsePaytmTradebook(ctx(wb([
      row(),
      row({ Quantity: 5, Price: 152, "Trade Time": "11:00:00", Brokerage: 1.25, GST: 0.27 }),
      row({ Type: "Sell", Quantity: 15, Price: 160, "Trade Time": "14:45:00", Date: "03-07-2026" }),
    ])));
    expect(p.trades).toHaveLength(1);
    const t = p.trades[0];
    expect(t.buyQty).toBe(15);
    expect(t.sellQty).toBe(15);
    expect(t.buyValue).toBe(10 * 150 + 5 * 152);
    // Charges: stated per execution, summed — never computed.
    expect(t.reportedCharges!.brokerage).toBe(2.5 + 1.25 + 2.5);
    expect(t.reportedCharges!.gst).toBe(Math.round((0.54 + 0.27 + 0.54) * 100) / 100);
    expect(t.reportedCharges!.total).toBeGreaterThan(0);
    // Fills survive for the staged ladder; times come from Trade Time.
    expect(t.executions).toHaveLength(3);
    expect(t.entryTime).toBe("10:15");
    expect(t.exitTime).toBe("14:45");
    expect(t.buyDate).toBe("2026-07-01");
    expect(t.sellDate).toBe("2026-07-03");
  });

  it("maps Product Type onto the product hint", () => {
    const p = parsePaytmTradebook(ctx(wb([
      row(),
      row({ Script: "ZETA", "Product Type": "Intraday" }),
      row({ Script: "MARG", "Product Type": "Margin Trade Funding" }),
    ])));
    const by = (s: string) => p.trades.find((t) => t.tradingsymbol === s)!;
    expect(by("ACME").productHint).toBe("delivery");
    expect(by("ZETA").productHint).toBe("intraday");
    expect(by("MARG").productHint).toBe("mtf");
  });

  it("keeps different product types of one scrip apart — an MTF and a delivery position are not one trade", () => {
    const p = parsePaytmTradebook(ctx(wb([row(), row({ "Product Type": "Margin" })])));
    expect(p.trades).toHaveLength(2);
  });

  it("refuses a row with no readable side rather than guessing", () => {
    const p = parsePaytmTradebook(ctx(wb([row({ Type: "??" })])));
    expect(p.trades).toHaveLength(0);
    expect(p.warnings.join(" ")).toMatch(/refused/i);
  });

  it("says its charges are stated, not computed", () => {
    const p = parsePaytmTradebook(ctx(wb([row()])));
    expect(p.warnings.join(" ")).toMatch(/broker's own per-execution figures/i);
  });
});
