import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { detectAngelOneTaxPnl, parseAngelOneTaxPnl, scanSections, flexDate } from "@/lib/import/parsers/angelone-taxpnl";

/**
 * Angel One TAX P&L. Sheet layout and section columns VERIFIED against a real
 * export; the sample carried no data rows, so value behaviour is asserted on
 * SYNTHETIC rows under the real section titles and headers.
 */

const EQ_SHEET = "Equity+Bonds+SGB Trade Details";
const DV_SHEET = "Derivatives Trade Details";

function book(sheets: Record<string, unknown[][]>, summaryA1 = "Angel One Limited (formerly known as Angel Broking Limited)"): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[summaryA1], ["Client Basic Information"]]), "Summary");
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const ctx = (buffer: Buffer, filename = "statement.xlsx") => ({ filename, buffer });

const DELIVERY_HEADER = [
  "ISIN", "Scrip Name", "Qty", "Buy Date", "Sell Date", "Avg Buy Price", "Buy Value",
  "Avg Sell Price", "Sell Value", "Cost Of Acquisition", "Charges and Statutory", "STT", "Net Profit/Loss",
];

describe("detection", () => {
  it("claims on 'Angel One Limited' in Summary!A1 under any filename", () => {
    expect(detectAngelOneTaxPnl(ctx(book({})))).toBeGreaterThanOrEqual(0.9);
  });

  it("refuses a workbook whose Summary names no broker and whose sheets are ordinary", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["My Statement"]]), "Summary");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectAngelOneTaxPnl(ctx(buf))).toBe(0);
  });
});

describe("the section scanner", () => {
  it("cuts a sheet with several independently-headed sub-tables", () => {
    const m = [
      ["Equity P&L Summary"], ["Net P&L", "0"], [],
      ["Intraday (Speculation)"],
      ["ISIN", "Scrip Name", "Qty", "Transaction Date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Charges and Statutory", "STT", "Taxable P&L"],
      ["INE1", "ACME", "10", "01-07-2026", "100", "1000", "101", "1010", "5", "2", "3"],
      [],
      ["Delivery P&L"],
      DELIVERY_HEADER,
      ["INE2", "ZETA", "5", "01-06-2026", "15-06-2026", "200", "1000", "220", "1100", "1000", "6", "1", "93"],
    ].map((r) => r.map(String));
    const sections = scanSections(m);
    expect([...sections.keys()].sort()).toEqual(["delivery", "intraday"]);
    expect(sections.get("intraday")!.rows).toHaveLength(1);
    expect(sections.get("delivery")!.rows).toHaveLength(1);
  });

  it("skips Total footer rows inside a section", () => {
    const m = [
      ["Delivery P&L"], DELIVERY_HEADER,
      ["INE2", "ZETA", "5", "01-06-2026", "15-06-2026", "200", "1000", "220", "1100", "1000", "6", "1", "93"],
      ["Total", "", "", "", "", "", "1000", "", "1100", "", "6", "1", "93"],
    ].map((r) => r.map(String));
    expect(scanSections(m).get("delivery")!.rows).toHaveLength(1);
  });
});

describe("values (synthetic rows)", () => {
  const equity = (extra: unknown[][] = []) => [
    ["Intraday (Speculation)"],
    ["ISIN", "Scrip Name", "Qty", "Transaction Date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Charges and Statutory", "STT", "Taxable P&L"],
    ["INE1", "ACME", "10", "01-07-2026", "100", "1000", "102", "1020", "5", "2", "13"],
    [],
    ["Delivery P&L"],
    DELIVERY_HEADER,
    ["INE2", "ZETA", "5", "01-06-2026", "15-06-2026", "200", "1000", "220", "1100", "1000", "6", "1", "93"],
    [],
    ...extra,
  ];

  it("intraday and delivery sections carry their hints, dates and stated charges", () => {
    const p = parseAngelOneTaxPnl(ctx(book({ [EQ_SHEET]: equity() })));
    expect(p.trades).toHaveLength(2);

    const intra = p.trades.find((t) => t.tradingsymbol === "ACME")!;
    expect(intra.productHint).toBe("intraday");
    expect(intra.buyDate).toBe("2026-07-01");
    expect(intra.sellDate).toBe("2026-07-01");
    // Charges are the broker's own: Charges-and-Statutory + STT stated apart.
    expect(intra.reportedCharges).toMatchObject({ sttCtt: 2, total: 7 });

    const del = p.trades.find((t) => t.tradingsymbol === "ZETA")!;
    expect(del.productHint).toBe("delivery");
    expect(del.buyDate).toBe("2026-06-01");
    expect(del.sellDate).toBe("2026-06-15");
    expect(del.grossPnl).toBe(100);
  });

  it("tags a delivery row MTF when Qty Breakup covers its whole quantity, and only notes a partial", () => {
    const p = parseAngelOneTaxPnl(ctx(book({
      [EQ_SHEET]: equity([
        ["Qty Breakup"],
        ["ISIN", "Scrip Name", "Total Qty", "DP Qty", "Pool Qty", "CUSPA Qty", "MTF Qty", "Pledge Qty"],
        ["INE2", "ZETA", "5", "0", "0", "0", "5", "0"],
        ["INE1", "ACME", "10", "8", "0", "0", "2", "0"],
      ]),
    })));
    const del = p.trades.find((t) => t.tradingsymbol === "ZETA")!;
    expect(del.productHint).toBe("mtf"); // full cover — the file states it
    const intra = p.trades.find((t) => t.tradingsymbol === "ACME")!;
    expect(intra.productHint).toBe("intraday"); // partial cover never re-tags
    expect((intra.importNotes ?? []).join(" ")).toMatch(/2 of 10 as MTF/);
  });

  it("refuses transfer transactions and counts them out loud", () => {
    const p = parseAngelOneTaxPnl(ctx(book({
      [EQ_SHEET]: [
        ["Transfer Transactions"],
        DELIVERY_HEADER.map((h) => (h === "Sell Date" ? "Transfer Date" : h)),
        ["INE3", "MOVED", "7", "01-05-2026", "10-05-2026", "50", "350", "60", "420", "350", "0", "0", "70"],
      ],
    })));
    expect(p.trades).toHaveLength(0);
    expect(p.warnings.join(" ")).toMatch(/1 transfer transaction NOT imported/i);
  });

  it("an Open Sell row is basis-unknown, an Open Holdings row is a live position with unrealised P&L", () => {
    const p = parseAngelOneTaxPnl(ctx(book({
      [EQ_SHEET]: [
        ["Open Sell"],
        ["ISIN", "Scrip Name", "Quantity", "Sell Date", "Avg Sell Price", "Sell Value", "Charges and Statutory", "STT"],
        ["INE4", "GONE", "3", "02-07-2026", "500", "1500", "2", "1"],
        [],
        ["Open Holdings as of 31/03/2026"],
        ["ISIN", "Scrip Name", "Quantity", "Avg Buy Price", "Buy Value", "Charges and Statutory", "STT", "Closing rate", "Turnover"],
        ["INE5", "HELD", "10", "90", "900", "3", "0", "100", "1000"],
      ],
    })));
    const gone = p.trades.find((t) => t.tradingsymbol === "GONE")!;
    expect(gone.basisUnknown).toBe(true);
    expect(gone.buyQty).toBe(0);
    const held = p.trades.find((t) => t.tradingsymbol === "HELD")!;
    expect(held.sellQty).toBe(0);
    expect(held.closingPrice).toBe(100);
    expect(held.unrealisedPnl).toBe(100); // 10 × 100 − 900
  });

  it("derivatives synthesize the classifier's own grammar from the structured columns", () => {
    const p = parseAngelOneTaxPnl(ctx(book({
      [DV_SHEET]: [
        ["Options"],
        ["Segment", "Symbol Name", "Expiry date", "Strike Price", "Option Type", "Qty", "Buy Date", "Sell date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Total Charges and Statutory", "STT", "Taxable P&L", "Turnover"],
        ["NFO", "NIFTY", "26-06-2026", "24500", "CE", "75", "10-06-2026", "12-06-2026", "100", "7500", "120", "9000", "20", "5", "1475", "16500"],
        [],
        ["Futures"],
        ["Segment", "Symbol Name", "Expiry date", "Qty", "Buy Date", "Sell date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Total Charges and Statutory", "STT", "Taxable P&L", "Turnover"],
        ["NFO", "BANKNIFTY", "31-07-2026", "15", "01-07-2026", "05-07-2026", "50000", "750000", "50500", "757500", "150", "80", "7270", "1507500"],
      ],
    })));
    const opt = p.trades.find((t) => t.tradingsymbol.startsWith("OPT"))!;
    expect(opt.tradingsymbol).toBe("OPT NIFTY 26 Jun 2026 24500 CE");
    const fut = p.trades.find((t) => t.tradingsymbol.startsWith("FUT"))!;
    expect(fut.tradingsymbol).toBe("FUT BANKNIFTY 31 Jul 2026");
    expect(fut.reportedCharges).toMatchObject({ sttCtt: 80, total: 230 });
  });

  it("flags the charge-column semantics as unverified until a live file confirms them", () => {
    const p = parseAngelOneTaxPnl(ctx(book({ [EQ_SHEET]: equity() })));
    expect(p.warnings.join(" ")).toMatch(/not been verified against an account with real activity/i);
  });
});

describe("flexDate", () => {
  it("reads the formats the export could plausibly carry", () => {
    expect(flexDate("2026-06-26")).toBe("2026-06-26");
    expect(flexDate("26-06-2026")).toBe("2026-06-26");
    expect(flexDate("26/06/2026")).toBe("2026-06-26");
    expect(flexDate("26 Jun 2026")).toBe("2026-06-26");
    expect(flexDate("26-Jun-2026")).toBe("2026-06-26");
    expect(flexDate("")).toBeNull();
  });
});
