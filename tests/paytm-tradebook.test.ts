import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { detectPaytmTradebook, parsePaytmTradebook } from "@/lib/import/parsers/paytm-tradebook";

/**
 * Paytm Money TRADEBOOK.
 *
 * Layout VERIFIED against a real 414-execution export (four metadata rows,
 * header on row 5, per-execution charges). Three behaviours of that export are
 * what these synthetic rows reproduce, because they are what the parser had to
 * be rewritten around:
 *
 *   - `Script` is a numeric SCRIP CODE, not a ticker.
 *   - `Product Type` reads `EQ` on every row — the SEGMENT, not the product.
 *   - STT and stamp duty are booked once per SCRIP-DAY, on one row of that
 *     day, so the delivery/intraday signature exists per scrip-day and not
 *     per fill.
 *
 * The rates the signature is read against are the statutory ones: delivery
 * charges 0.10% STT on both legs and 0.015% stamp duty on the buy; intraday
 * charges 0.025% STT on the sell and 0.003% stamp duty.
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
    // The real export's defaults: a numeric scrip code, "EQ" as the product
    // column, no trade time and trade number 0.
    Date: "03-08-2026", Script: "216463", ISIN: "INE000000001", Exchange: "NSE",
    "Product Type": "EQ", Type: "Buy", Quantity: 100, Price: 200,
    Brokerage: 20, ETT: 6, GST: 4.68, STT: 0, SEBI: 0.02, "Stamp Duty": 0,
    "Order Number": "O1", "Trade Number": "0", "Trade Time": "",
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

// ── (a) delivery, derived from the scrip-day's own STT and stamp duty ───────
describe("delivery signature (scrip-day)", () => {
  const parsed = parsePaytmTradebook(ctx(wb([
    // Two buys on one day; Paytm books the day's STT and stamp on ONE of them.
    row({ Quantity: 40, Brokerage: 8, ETT: 2.4, GST: 1.87, SEBI: 0.01, "Trade Time": "10:15:00" }),
    row({ Quantity: 60, Brokerage: 12, ETT: 3.6, GST: 2.81, SEBI: 0.01, "Trade Time": "10:20:00",
      STT: 20, "Stamp Duty": 3 }), // 0.10% and 0.015% of the day's ₹20,000 buy
    row({ Date: "04-08-2026", Type: "Sell", Quantity: 100, Price: 210, "Trade Time": "14:45:00",
      Brokerage: 20, ETT: 6.3, GST: 4.73, STT: 21, SEBI: 0.02, "Stamp Duty": 0 }),
  ])));

  it("pairs the day's fills into one closed position", () => {
    expect(parsed.trades).toHaveLength(1);
    const t = parsed.trades[0];
    expect(t.buyQty).toBe(100);
    expect(t.sellQty).toBe(100);
    expect(t.buyValue).toBe(20000);
    expect(t.sellValue).toBe(21000);
    expect(t.grossPnl).toBe(1000);
    expect(t.buyDate).toBe("2026-08-03");
    expect(t.sellDate).toBe("2026-08-04");
    expect(t.basisUnknown).toBe(false);
  });

  it("reads DELIVERY out of the charges and says the product was derived", () => {
    const t = parsed.trades[0];
    expect(t.productHint).toBe("delivery");
    expect(t.productDerived).toBe(true);
    expect((t.importNotes ?? []).join(" ")).toMatch(/derived from the day's STT and stamp duty/i);
  });

  it("keeps every fill and its time for the ladder", () => {
    const t = parsed.trades[0];
    expect(t.executions).toHaveLength(3);
    expect(t.entryTime).toBe("10:15");
    expect(t.exitTime).toBe("14:45");
  });
});

// ── (b) intraday, from a same-day round trip's 0.025% sell-side STT ─────────
describe("intraday signature (same scrip-day)", () => {
  it("reads INTRADAY from the sell-side STT and the 0.003% stamp duty", () => {
    const p = parsePaytmTradebook(ctx(wb([
      row({ Date: "05-08-2026", Script: "544866", "Stamp Duty": 0.6 }),
      row({ Date: "05-08-2026", Script: "544866", Type: "Sell", Quantity: 100, Price: 205,
        STT: 5.13, "Stamp Duty": 0 }),
    ])));
    expect(p.trades).toHaveLength(1);
    const t = p.trades[0];
    expect(t.productHint).toBe("intraday");
    expect(t.productDerived).toBe(true);
    expect(t.grossPnl).toBe(500);
    expect(t.buyDate).toBe("2026-08-05");
    expect(t.sellDate).toBe("2026-08-05");
  });
});

// ── (c) a sell with no purchase in the window ──────────────────────────────
describe("opening sell", () => {
  const p = parsePaytmTradebook(ctx(wb([
    row({ Date: "06-08-2026", Script: "777777", Type: "Sell", Quantity: 50, Price: 300, STT: 15 }),
  ])));

  it("reports NO P&L for a holding whose cost is not in the file", () => {
    expect(p.trades).toHaveLength(1);
    const t = p.trades[0];
    expect(t.buyQty).toBe(0);
    expect(t.sellQty).toBe(50);
    expect(t.sellValue).toBe(15000);
    expect(t.grossPnl).toBe(0);
    expect(t.basisUnknown).toBe(true);
  });

  it("says so in a warning rather than leaving a silent zero", () => {
    expect(p.warnings.join(" ")).toMatch(/sold without a matching purchase/i);
  });
});

// ── (d) charges: the broker's own figures, apportioned and conserved ────────
describe("charge apportionment", () => {
  // Two identical closed positions in different scrips, so each takes exactly
  // half of the file's charges and the arithmetic is checkable by hand.
  // Two scrips means two ISINs: pairing is by ISIN (2026-09-04), so two codes
  // sharing the fixture's default ISIN would be ONE security, not two.
  const legPair = (script: string, isin: string) => [
    row({ Script: script, ISIN: isin, STT: 20, "Stamp Duty": 3 }),
    row({ Date: "04-08-2026", Script: script, ISIN: isin, Type: "Sell", Quantity: 100, Price: 210,
      Brokerage: 20, ETT: 6.3, GST: 4.73, STT: 21, SEBI: 0.02, "Stamp Duty": 0 }),
  ];
  const p = parsePaytmTradebook(ctx(wb([...legPair("216463", "INE000000001"), ...legPair("544866", "INE000000002")])));

  // Stated by the file, summed by hand from the rows above.
  const FILE = { brokerage: 80, exchangeTxn: 24.6, gst: 18.82, sttCtt: 82, sebi: 0.08, stampDuty: 6 };
  const FILE_TOTAL = 211.5;

  it("gives every position a share and loses nothing on the way", () => {
    expect(p.trades).toHaveLength(2);
    const sum = (f: (c: Record<string, number>) => number) =>
      p.trades.reduce((s, t) => s + f(t.reportedCharges as unknown as Record<string, number>), 0);
    expect(sum((c) => c.total)).toBeCloseTo(FILE_TOTAL, 2);
    for (const [k, v] of Object.entries(FILE)) {
      expect(sum((c) => c[k])).toBeCloseTo(v, 2);
    }
  });

  it("says the charges are stated, not computed", () => {
    expect(p.warnings.join(" ")).toMatch(/broker's own per-execution figures/i);
  });

  it("says how the product was decided", () => {
    expect(p.warnings.join(" ")).toMatch(/paired FIFO per scrip/i);
    expect(p.warnings.join(" ")).toMatch(/Product Type column says EQ/i);
  });
});

// ── (e) the numeric scrip code, explained on the trade itself ──────────────
describe("numeric scrip code", () => {
  it("carries a note saying the code is not a ticker and how to resolve it", () => {
    const p = parsePaytmTradebook(ctx(wb([
      row({ STT: 20, "Stamp Duty": 3 }),
      row({ Date: "04-08-2026", Type: "Sell", Quantity: 100, Price: 210, STT: 21 }),
    ])));
    expect(p.trades[0].tradingsymbol).toBe("216463");
    expect((p.trades[0].importNotes ?? []).join(" ")).toMatch(
      /numeric scrip code, not a ticker.*Instruments list/i,
    );
  });

  it("leaves a lettered symbol alone", () => {
    const p = parsePaytmTradebook(ctx(wb([row({ Script: "ACME" })])));
    expect((p.trades[0].importNotes ?? []).join(" ")).not.toMatch(/scrip code/i);
  });
});

// ── (f) a stated product beats the derived one, and keeps its own book ─────
describe("stated Product Type", () => {
  it("keeps a stated MTF position apart from an EQ position in the same scrip", () => {
    const p = parsePaytmTradebook(ctx(wb([
      row({ STT: 20, "Stamp Duty": 3 }),
      row({ "Product Type": "MTF", Quantity: 50, STT: 10, "Stamp Duty": 1.5 }),
    ])));
    expect(p.trades).toHaveLength(2);
    const mtf = p.trades.find((t) => t.productHint === "mtf")!;
    expect(mtf).toBeDefined();
    expect(mtf.buyQty).toBe(50);
    // Stated, therefore NOT derived — a reported fact must not wear derived clothes.
    expect(mtf.productDerived).toBe(false);
    const eq = p.trades.find((t) => t.productHint !== "mtf")!;
    expect(eq.buyQty).toBe(100);
    expect(eq.productDerived).toBe(true);
  });

  it("still maps an explicit Intraday column onto the hint", () => {
    const p = parsePaytmTradebook(ctx(wb([row({ Script: "ZETA", "Product Type": "Intraday" })])));
    expect(p.trades[0].productHint).toBe("intraday");
    expect(p.trades[0].productDerived).toBe(false);
  });
});

// ── (g) and (h) — what the UI is told about the file itself ────────────────
describe("file-level reporting", () => {
  it("reports the executions READ, so pairing does not look like rows going missing", () => {
    const p = parsePaytmTradebook(ctx(wb([
      row({ STT: 20, "Stamp Duty": 3 }),
      row({ Date: "04-08-2026", Type: "Sell", Quantity: 100, Price: 210, STT: 21 }),
      row({ Date: "05-08-2026", Script: "544866", Quantity: 50, STT: 10, "Stamp Duty": 1.5 }),
    ])));
    expect(p.sourceRows).toBe(3);
    expect(p.trades.length).toBeLessThan(p.sourceRows!);
  });

  it("refuses a row with no readable side rather than guessing", () => {
    const p = parsePaytmTradebook(ctx(wb([row({ Type: "??" })])));
    expect(p.trades).toHaveLength(0);
    expect(p.warnings.join(" ")).toMatch(/refused/i);
  });

  it("refuses a row it cannot date — FIFO cannot place an undated fill", () => {
    const p = parsePaytmTradebook(ctx(wb([row({ Date: "" })])));
    expect(p.trades).toHaveLength(0);
    expect(p.warnings.join(" ")).toMatch(/refused/i);
  });
});
