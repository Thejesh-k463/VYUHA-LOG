import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { parsePaytmTradebook } from "@/lib/import/parsers/paytm-tradebook";
import { corroborate, inferProduct, splitMixedRow } from "@/lib/import/product-signature";

/**
 * Product by SIGNATURE on a Paytm scrip-day (2026-09-04).
 *
 * Of the 83 same-day round trips in the real 7,544-execution export, 34 are
 * intraday by Paytm's own charges and 49 are genuine CNC delivery — stamp
 * duty 0.015% on the buy AND STT 0.1% of buy PLUS sell. A scrip-day whose
 * stamp duty sits between the two rates is part-and-part, and
 * `splitMixedRow` solves it exactly (FIFO agreed on 34 of 34).
 */

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "redacted", "paytm-tradebook-v3.xlsx");
const v3 = () => ({ filename: "paytm-tradebook-v3.xlsx", buffer: fs.readFileSync(FIXTURE) });

const HEADER = [
  "Date", "Script", "ISIN", "Exchange", "Product Type", "Type", "Quantity", "Price",
  "Brokerage", "ETT", "GST", "STT", "SEBI", "Stamp Duty", "Order Number", "Trade Number", "Trade Time",
];
function wb(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([["UCC"], ["Name"], ["PAN Number"], ["Period"], [], HEADER, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, ws, "Sheet1");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const row = (over: Partial<Record<string, unknown>> = {}): unknown[] => {
  const d: Record<string, unknown> = {
    Date: "16-06-2026", Script: "MIXCO", ISIN: "INE0MIX01019", Exchange: "NSE",
    "Product Type": "EQ", Type: "Buy", Quantity: 100, Price: 100,
    Brokerage: 20, ETT: 1, GST: 3.78, STT: 0, SEBI: 0.02, "Stamp Duty": 0,
    "Order Number": "O1", "Trade Number": "1", "Trade Time": "10:00:00",
    ...over,
  };
  return HEADER.map((h) => d[h]);
};
const parse = (rows: unknown[][]) => parsePaytmTradebook({ filename: "export.xlsx", buffer: wb(rows) });

/** The file's own charge total, summed from the sheet independently of the parser. */
function sheetCharges(buffer: Buffer): number {
  const book = XLSX.read(buffer, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]!], { header: 1, raw: false, defval: "" }) as string[][];
  const h = rows.findIndex((r) => r.includes("Script"));
  const cols = ["Brokerage", "ETT", "GST", "STT", "SEBI", "Stamp Duty"].map((c) => rows[h].indexOf(c));
  return rows.slice(h + 1).reduce((s, r) => s + cols.reduce((a, c) => a + Number(r[c] || 0), 0), 0);
}
const chargesOf = (trades: { reportedCharges?: { total?: number } | null }[]) =>
  trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0);

describe("corroborate() on a two-sided delivery row", () => {
  // 500 @50 bought and 500 @52 sold the same day, charged as CNC delivery:
  // stamp 3.75 (0.015% of 25,000), STT 51 (0.1% of 25,000 + 26,000).
  const sig = { buyValue: 25000, sellValue: 26000, stt: 51, stampDuty: 3.75 };

  it("reads the stamp duty as delivery", () => {
    expect(inferProduct(sig)).toBe("delivery");
  });

  it("uses buy PLUS sell as the STT base — delivery STT is levied on both legs", () => {
    expect(corroborate(sig, "delivery")).toBe(true);
  });

  it("still corroborates a one-sided delivery row and a two-sided intraday row", () => {
    expect(corroborate({ buyValue: 25000, sellValue: 0, stt: 25, stampDuty: 3.75 }, "delivery")).toBe(true);
    expect(corroborate({ buyValue: 0, sellValue: 26000, stt: 26, stampDuty: 0 }, "delivery")).toBe(true);
    expect(corroborate({ buyValue: 25000, sellValue: 26000, stt: 6.5, stampDuty: 0.75 }, "intraday")).toBe(true);
  });

  it("does not corroborate intraday-rate STT against a delivery verdict", () => {
    expect(corroborate({ buyValue: 25000, sellValue: 26000, stt: 6.5, stampDuty: 3.75 }, "delivery")).toBe(false);
  });
});

describe("a same-day round trip charged as delivery (fixture v3, CNCDAY)", () => {
  const p = parsePaytmTradebook(v3());
  const c = p.trades.find((t) => t.isin === "INE0CNC01017")!;

  it("stays delivery, and says the STT corroborates it", () => {
    expect(c.buyDate).toBe("2026-06-24");
    expect(c.sellDate).toBe("2026-06-24");
    expect(c.productHint).toBe("delivery");
    expect(c.productDerived).toBe(true);
    expect((c.importNotes ?? []).join(" ")).toMatch(/bought and sold the same day but held as delivery — stamp duty 0.015% and STT 0.1% — both match delivery/);
  });

  it("is counted in the file-level warning", () => {
    expect(p.warnings.join(" ")).toMatch(/1 scrip-day with both a buy and a sell was charged as delivery/);
  });
});

describe("a mixed scrip-day is split by its stamp duty (fixture v3, MIXCO)", () => {
  const p = parsePaytmTradebook(v3());
  const b = p.trades.filter((t) => t.isin === "INE0MIX01019");

  it("becomes an intraday pair and a delivery position", () => {
    expect(b).toHaveLength(2);
    const intraday = b.find((t) => t.productHint === "intraday")!;
    const delivery = b.find((t) => t.productHint === "delivery")!;
    expect(intraday.buyQty).toBe(600);
    expect(intraday.sellQty).toBe(600);
    expect(intraday.buyDate).toBe("2026-06-16");
    expect(intraday.sellDate).toBe("2026-06-16");
    expect(intraday.grossPnl).toBe(600);
    expect(delivery.buyQty).toBe(400);
    expect(delivery.sellQty).toBe(400);
    expect(delivery.buyDate).toBe("2026-06-16");
    expect(delivery.sellDate).toBe("2026-07-20");
    expect(delivery.grossPnl).toBe(4000);
  });

  it("puts the intraday value within 1% of what the signature derived", () => {
    const sig = splitMixedRow({ buyValue: 100000, sellValue: 60600, stt: 55.15, stampDuty: 7.8 })!;
    const intraday = b.find((t) => t.productHint === "intraday")!;
    expect(Math.abs(intraday.buyValue - sig.intradayValue) / sig.intradayValue).toBeLessThan(0.01);
  });

  it("says so on both halves and in the warnings", () => {
    for (const t of b) {
      expect((t.importNotes ?? []).join(" ")).toMatch(/600 of 1000 bought were squared off the same day and 400 carried — split derived from Paytm's own stamp duty \(~40% delivery\)/);
    }
    expect(p.warnings.join(" ")).toMatch(/1 scrip-day mixed intraday and delivery — split/);
  });

  it("conserves the file's charges to the paisa across the split", () => {
    expect(Math.abs(chargesOf(p.trades) - sheetCharges(v3().buffer))).toBeLessThanOrEqual(0.01 + 1e-9);
  });
});

describe("quantity rounding and the null-split fallback", () => {
  it("rounds the delivery quantity to the nearest whole share and caps intraday at what was sold", () => {
    // 333 bought @100, 200 sold same day. Stamp for 133 delivery + 200 intraday:
    // 0.00015 × 13,300 + 0.00003 × 20,000 = 1.995 + 0.6 = 2.595 → fraction 0.3994.
    // 333 × 0.3994 = 132.99 → 133 delivery, 200 intraday.
    const p = parse([
      row({ Quantity: 333, STT: 13.3, "Stamp Duty": 2.595 }),
      row({ Type: "Sell", Quantity: 200, Price: 101, STT: 5.05 }),
    ]);
    const intraday = p.trades.find((t) => t.productHint === "intraday")!;
    const open = p.trades.find((t) => t.productHint !== "intraday")!;
    expect(intraday.buyQty).toBe(200);
    expect(intraday.sellQty).toBe(200);
    expect(open.buyQty).toBe(133);
    expect(open.sellQty).toBe(0);
  });

  it("keeps the whole day as one book when the split is nonsense", () => {
    // Stamp duty ABOVE the delivery rate: inferProduct says "unknown", not
    // mixed — nothing to split, today's behaviour.
    const p = parse([
      row({ Quantity: 1000, STT: 60, "Stamp Duty": 40 }),
      row({ Type: "Sell", Quantity: 400, Price: 101, STT: 10.1 }),
    ]);
    expect(p.trades.filter((t) => t.productHint === "intraday")).toHaveLength(0);
    expect(p.trades.reduce((s, t) => s + t.buyQty, 0)).toBe(1000);
    expect(p.warnings.join(" ")).not.toMatch(/mixed intraday and delivery/);
  });

  it("conserves charges when a book has many positions — the rounding remainder lands on the largest slice", () => {
    const rows: unknown[][] = [];
    for (let i = 0; i < 40; i++) {
      const isin = `INE0T${String(i).padStart(2, "0")}01019`;
      rows.push(row({ Script: `T${i}`, ISIN: isin, Quantity: 100 + i, Price: 100, STT: 10 + i * 0.1, "Stamp Duty": 1.5 + i * 0.015,
        Brokerage: 20.3333, ETT: 1.0101, GST: 3.7777, SEBI: 0.0101 }));
      rows.push(row({ Script: `T${i}`, ISIN: isin, Date: "17-06-2026", Type: "Sell", Quantity: 100 + i, Price: 101, STT: 10.1 + i * 0.1,
        Brokerage: 20.3333, ETT: 1.0101, GST: 3.7777, SEBI: 0.0101 }));
    }
    const buffer = wb(rows);
    const p = parsePaytmTradebook({ filename: "export.xlsx", buffer });
    expect(p.trades).toHaveLength(40);
    expect(Math.abs(chargesOf(p.trades) - sheetCharges(buffer))).toBeLessThanOrEqual(0.01 + 1e-9);
  });
});
