import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseDhanGtr, readGtr } from "@/lib/import/parsers/dhan-gtr";
import { parsePaytmTradebook } from "@/lib/import/parsers/paytm-tradebook";
import { parseAngelOne, usDateToIso } from "@/lib/import/parsers/angelone-upstox";
import { parseTextMoney } from "@/lib/import/parsers/dhan-realised-pnl";
import { findRates, seedRatesMap } from "@/lib/engine/rates";
import { computeCharges } from "@/lib/engine/charges";

/**
 * v3.8.0 fix wave — the money-and-pairing findings.
 *
 * Every case here was a WRONG NUMBER a user could read off the screen without
 * anything looking broken: a skipped line's whole charge bill folded onto an
 * unrelated symbol and called "rounding"; a US-ordered file read half-backwards
 * and half-skipped; a blank ISIN cell splitting one holding into an open
 * position and a phantom opening sell; a commodity contract recorded on a venue
 * the broker never traded it on; a date stored as month 27; and `Dr`/`Cr`
 * money reading as zero.
 */

// ── Dhan GTR fixtures ────────────────────────────────────────────────────────

const GTR_HEADER =
  "Date,Scrip Name,Exchange,Bill No.,Buy Qty.,Buy Value,Sell Qty.,Sell Value," +
  "Brokerage,GST,STT,SEBI Fees,Stamp Duty,Txn. Charges,Oth. Charges,Gross Amount";

function gtr(dataLines: string[], footer: string): string {
  return [
    "Global transction report,From 01-07-2026 to 31-07-2026",
    "Name,TESTUSER",
    "",
    GTR_HEADER,
    ...dataLines,
    "",
    footer,
    "",
    "NOTE : This sheet was downloaded at 7/31/2026 12:03 AM",
  ].join("\n");
}

const ctxOf = (text: string) => ({ filename: "Dhan_GlobalTransction_Report.csv", text });

/**
 * Four readable bill lines (two closed positions, ₹387.78 of charges between
 * them) plus ONE line the date grammar refuses, carrying ₹238.85 of its own.
 * The footer states the whole file: 387.78 + 238.85 = 626.63.
 */
const SKIPPED_LINE_BOOK = gtr(
  [
    "01 Jul 2026 00:00:00,ZENSAR,NSE,B1,10,10000.00,0,0.00,100.00,18.00,10.00,0.10,0.15,0.62,0.00,-10128.87",
    "02 Jul 2026 00:00:00,ZENSAR,NSE,B2,0,0.00,10,11000.00,100.00,18.00,11.00,0.11,0.00,0.68,0.00,10870.21",
    "03 Jul 2026 00:00:00,PARAS DEFENCE,NSE,B3,5,5000.00,0,0.00,50.00,9.00,5.00,0.05,0.08,0.31,0.00,-5064.44",
    "04 Jul 2026 00:00:00,PARAS DEFENCE,NSE,B4,0,0.00,5,5300.00,50.00,9.00,5.30,0.05,0.00,0.33,0.00,5235.32",
    "13-13-2026 00:00,SKIPPED SCRIP,NSE,B5,1,1000.00,0,0.00,200.00,36.00,2.00,0.02,0.15,0.68,0.00,-1238.85",
  ],
  "Net P&L,912.22,Brokerage,300.00,Gross P&L,1300.00,Total Charges,626.63",
);

describe("MUST-FIX 1 · a skipped line's charges are never folded onto another symbol", () => {
  const p = parseDhanGtr(ctxOf(SKIPPED_LINE_BOOK));
  const totals = p.trades.map((t) => t.reportedCharges?.total ?? 0);
  const sum = Math.round(totals.reduce((a, b) => a + b, 0) * 100) / 100;

  it("reads the four dated lines into two positions and skips the fifth", () => {
    expect(p.trades).toHaveLength(2);
    expect(p.warnings.some((w) => /1 line skipped: date not recognised/.test(w))).toBe(true);
  });

  it("leaves the positions' own charges exactly as the report states them", () => {
    // 387.78 = the four readable lines. 626.63 would mean the skipped line's
    // ₹238.85 was folded in as "rounding".
    expect(Math.abs(sum - 387.78)).toBeLessThanOrEqual(0.05);
    expect(Math.max(...totals)).toBeLessThan(300);
  });

  it("calls no position's charges 'rounding'", () => {
    const notes = p.trades.flatMap((t) => t.importNotes ?? []);
    expect(notes.some((n) => /rounding/i.test(n))).toBe(false);
  });

  it("warns instead, naming the amount and how many lines it belongs to", () => {
    const w = p.warnings.find((x) => /238\.85/.test(x));
    expect(w).toBeDefined();
    expect(w!).toMatch(/1 skipped line/);
  });

  it("still folds a genuine paisa-level residual, so the common case is unchanged", () => {
    // Same book, footer 4 paise higher than the rows — inside the tolerance
    // summarisePairing derives (2 positions → the ₹0.05 floor).
    const near = gtr(
      SKIPPED_LINE_BOOK.split("\n").filter((l) => /^0[1-4] Jul/.test(l)),
      "Net P&L,912.22,Brokerage,300.00,Gross P&L,1300.00,Total Charges,387.82",
    );
    const q = parseDhanGtr(ctxOf(near));
    const s = q.trades.reduce((a, t) => a + (t.reportedCharges?.total ?? 0), 0);
    expect(Math.round(s * 100) / 100).toBe(387.82);
    expect(q.trades.flatMap((t) => t.importNotes ?? []).some((n) => /rounding/i.test(n))).toBe(true);
  });
});

describe("MUST-FIX 2 · a month-first file is refused whole, not read half-backwards", () => {
  // US order: 07/01/2026 reads as a valid dd-mm date (wrongly, as 7 Jan) while
  // 07/13/2026 is refused. A genuine day-first file can never do both.
  const ambiguous = gtr(
    [
      "07/01/2026 00:00,ZENSAR,NSE,B1,10,10000.00,0,0.00,100.00,18.00,10.00,0.10,0.15,0.62,0.00,-10128.87",
      "07/13/2026 00:00,ZENSAR,NSE,B2,0,0.00,10,11000.00,100.00,18.00,11.00,0.11,0.00,0.68,0.00,10870.21",
      "07/22/2026 00:00,PARAS DEFENCE,NSE,B3,5,5000.00,0,0.00,50.00,9.00,5.00,0.05,0.08,0.31,0.00,-5064.44",
    ],
    "Net P&L,912.22,Brokerage,250.00,Gross P&L,1300.00,Total Charges,240.00",
  );
  const p = parseDhanGtr(ctxOf(ambiguous));

  it("imports nothing rather than dating 1 of 3 lines backwards", () => {
    expect(readGtr(ambiguous).ambiguousDates).toBe(true);
    expect(p.trades).toHaveLength(0);
  });

  it("says why, and asks for the file", () => {
    expect(p.warnings.join(" ")).toMatch(/ambiguous/i);
    expect(p.warnings.join(" ")).toMatch(/please report this file/i);
  });

  it("a genuine day-first numeric file is untouched", () => {
    const dayFirst = gtr(
      [
        "01-07-2026 00:00,ZENSAR,NSE,B1,10,10000.00,0,0.00,100.00,18.00,10.00,0.10,0.15,0.62,0.00,-10128.87",
        "13-07-2026 00:00,ZENSAR,NSE,B2,0,0.00,10,11000.00,100.00,18.00,11.00,0.11,0.00,0.68,0.00,10870.21",
      ],
      "Net P&L,741.34,Brokerage,200.00,Gross P&L,1000.00,Total Charges,258.66",
    );
    const q = readGtr(dayFirst);
    expect(q.ambiguousDates).toBe(false);
    expect(q.rows.map((r) => r.date)).toEqual(["2026-07-01", "2026-07-13"]);
  });
});

// ── SHOULD-FIX 3 · Paytm blank ISIN cell ─────────────────────────────────────

const PAYTM_HEADER = [
  "Date", "Script", "ISIN", "Exchange", "Product Type", "Type", "Quantity", "Price",
  "Brokerage", "ETT", "GST", "STT", "SEBI", "Stamp Duty", "Order Number", "Trade Number", "Trade Time",
];

function paytmBook(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([["UCC"], ["Name"], ["PAN Number"], ["Period"], [], PAYTM_HEADER, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, ws, "Sheet1");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const paytmRow = (over: Record<string, unknown>): unknown[] => {
  const d: Record<string, unknown> = {
    Date: "03-08-2026", Script: "TESTCO", ISIN: "INE000000001", Exchange: "NSE",
    "Product Type": "EQ", Type: "Buy", Quantity: 100, Price: 200,
    Brokerage: 20, ETT: 6, GST: 4.68, STT: 20, SEBI: 0.02, "Stamp Duty": 3,
    "Order Number": "O1", "Trade Number": "1", "Trade Time": "",
    ...over,
  };
  return PAYTM_HEADER.map((h) => d[h]);
};

describe("SHOULD-FIX 3 · a sell whose ISIN cell is blank stays with its buy", () => {
  const p = parsePaytmTradebook({
    filename: "export.xlsx",
    buffer: paytmBook([
      paytmRow({ Date: "03-08-2026", Type: "Buy", Quantity: 100, Price: 200 }),
      paytmRow({ Date: "05-08-2026", Type: "Sell", Quantity: 100, Price: 210, ISIN: "" }),
    ]),
  });

  it("is one closed position, not an open buy plus an opening sell", () => {
    expect(p.trades).toHaveLength(1);
    expect(p.trades[0].basisUnknown).toBeFalsy();
    expect(p.trades[0].buyQty).toBe(100);
    expect(p.trades[0].sellQty).toBe(100);
  });

  it("keeps the real ₹1,000 gain", () => {
    expect(p.trades[0].grossPnl).toBe(1000);
    expect(p.trades[0].isin).toBe("INE000000001");
  });

  it("says it bridged the blank cell", () => {
    expect(p.warnings.some((w) => /left the ISIN cell blank/i.test(w))).toBe(true);
  });

  it("never bridges a label the file maps to two ISINs — a ticker is not an identity", () => {
    const q = parsePaytmTradebook({
      filename: "export.xlsx",
      buffer: paytmBook([
        paytmRow({ Script: "DUP", ISIN: "INE000000001", Type: "Buy" }),
        paytmRow({ Script: "DUP", ISIN: "INE000000002", Type: "Buy" }),
        paytmRow({ Script: "DUP", ISIN: "", Type: "Sell", Date: "05-08-2026" }),
      ]),
    });
    // The blank-ISIN sell keys on the label alone, so it is its own book.
    expect(q.trades.filter((t) => t.basisUnknown).length).toBe(1);
  });
});

// ── SHOULD-FIX 4 · commodity off MCX: priced at MCX, recorded where it traded ─

describe("SHOULD-FIX 4 · a commodity contract the report places on NSE", () => {
  const p = parseDhanGtr(
    ctxOf(
      gtr(
        [
          "01 Jul 2026 00:00:00,OPT CRUDEOIL 09 Jun 2026 8000 PE,NSE,B1,1,8000.00,0,0.00,20.00,3.60,0.00,0.01,0.08,0.83,0.00,-8024.52",
          "02 Jul 2026 00:00:00,OPT CRUDEOIL 09 Jun 2026 8000 PE,NSE,B2,0,0.00,1,8500.00,20.00,3.60,0.85,0.01,0.00,0.88,0.00,8474.66",
        ],
        "Net P&L,450.14,Brokerage,40.00,Gross P&L,500.00,Total Charges,49.86",
      ),
    ),
  );

  it("records the venue the broker states", () => {
    expect(p.trades).toHaveLength(1);
    expect(p.trades[0].exchangeHint).toBe("NSE");
  });

  it("says which rates priced it", () => {
    const notes = (p.trades[0].importNotes ?? []).join(" ");
    expect(notes).toMatch(/Recorded on NSE/);
    expect(notes).toMatch(/MCX commodity rates/);
  });

  it("prices it at the MCX rates rather than refusing the whole import", () => {
    const map = seedRatesMap();
    const nse = findRates(map, "dhan", "commodity_option", "NSE", "2026-07-02");
    const mcx = findRates(map, "dhan", "commodity_option", "MCX", "2026-07-02");
    expect(nse).toBe(mcx); // the MCX row of charge_config, not a hard-coded rate
    const input = {
      segment: "commodity_option" as const,
      buyValue: 8000, sellValue: 8500, buyQty: 1, sellQty: 1,
    };
    expect(computeCharges(input, nse).total).toBe(computeCharges(input, mcx).total);
  });

  it("still refuses a segment that has no rates anywhere", () => {
    expect(() => findRates(seedRatesMap(), "dhan", "eq_delivery", "MCX", "2026-07-02")).toThrow(
      /No charge_config/,
    );
  });
});

// ── SHOULD-FIX 5 · Angel One / Upstox US dates ───────────────────────────────

describe("SHOULD-FIX 5 · usDateToIso refuses a date no calendar holds", () => {
  it("reads the real m/d/yy cells", () => {
    expect(usDateToIso("8/27/26 0:00")).toBe("2026-08-27");
    expect(usDateToIso("12/31/2026")).toBe("2026-12-31");
    expect(usDateToIso("2026-08-27T00:00:00")).toBe("2026-08-27");
  });

  it("refuses month 27 instead of composing 2026-27-08", () => {
    expect(usDateToIso("27/08/26")).toBeNull();
    expect(usDateToIso("13/01/2026")).toBeNull();
    expect(usDateToIso("1/32/2026")).toBeNull();
  });

  it("leaves a grammar it does not claim for the committer", () => {
    expect(usDateToIso("27-08-2026")).toBe("27-08-2026");
    expect(usDateToIso(null)).toBeNull();
  });
});

// ── NOTE 6 · Dr / Cr / Unicode minus ─────────────────────────────────────────

describe("NOTE 6 · parseTextMoney reads the notations the exports actually use", () => {
  it("still reads what it always read", () => {
    expect(parseTextMoney(" 1,23,456.78 ")).toBe(123456.78);
    expect(parseTextMoney("(1,234.00)")).toBe(-1234);
    expect(parseTextMoney("-")).toBe(0);
    expect(parseTextMoney("")).toBe(0);
    expect(parseTextMoney("junk")).toBe(0);
  });

  it("reads Dr as money out and Cr as money in, instead of zero", () => {
    expect(parseTextMoney("1,234.00 Dr")).toBe(-1234);
    expect(parseTextMoney("1,234.00 Cr")).toBe(1234);
    expect(parseTextMoney("1,234.00 DR.")).toBe(-1234);
    expect(parseTextMoney("Cr 1,234.00")).toBe(1234);
  });

  it("reads the Unicode minus Excel writes", () => {
    expect(parseTextMoney("−1,234.00")).toBe(-1234);
    expect(parseTextMoney("‒1234")).toBe(-1234);
  });
});

// ── FIX PASS 2 ───────────────────────────────────────────────────────────────
//
// The three defects the second audit found — the two GTR rulings replayed on
// Angel One's Trades_History, and one corrupt Dhan cell refusing a clean file.

const ANGEL_HEADER = [
  "Scrip/Contract", "Buy/Sell", "Buy Price", "Sell Price", "Quantity", "Brokerage", "GST", "STT",
  "Sebi Tax", "Exchange Turnover Charges", "Stamp Duty", "Other Charges", "IPFT Charges",
  "Order Type", "Segment", "Exchange", "Order ID", "Trade ID", "Date",
];

/** Angel One's Trades_History layout: a charges summary, then the table. */
function angelBook(rows: string[][], summary: { total: string; brokerage: string; gst: string; stt: string; sebi: string; exch: string }): Buffer {
  const aoa: string[][] = [
    ["ClientCode", "TEST0001"],
    ["DateOfDownload", "2026-09-04"],
    [],
    ["Charges Summary"],
    ["Total Trades", "2"],
    ["Total Charges", summary.total],
    ["Total Trade Charges", summary.total],
    ["Total Non Trade Charges", "0"],
    [],
    ["Trade Charges"],
    ["Brokerage", summary.brokerage],
    ["GST", summary.gst],
    ["SEBI Tax", summary.sebi],
    ["STT", summary.stt],
    ["Exchange Turnover Charges", summary.exch],
    ["Stamp Duty", "0"],
    ["Other Charges", "0"],
    ["IPFT Charges", "0"],
    [],
    ["TradeBook And Charges"],
    ANGEL_HEADER,
    ...rows,
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "TradesAndCharges");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

const angelRow = (scrip: string, side: "Buy" | "Sell", price: string, qty: string, brokerage: string, gst: string, stt: string, exch: string, date: string): string[] => [
  scrip, side, side === "Buy" ? price : "", side === "Sell" ? price : "", qty,
  brokerage, gst, stt, "0", exch, "0", "0", "0", "Delivery", "CAPITAL", "NSE", "1", "2", date,
];

const angelCtx = (buf: Buffer) => ({ filename: "Trades_History_TEST0001.xlsx", buffer: buf });

describe("FIX PASS 2 · MUST-FIX 1 — Angel One day-first exports are refused whole, not half-read", () => {
  // `27/08/26` names no month; `05/08/26` reads cleanly as 5 August under the
  // m/d/yy grammar and is really 5 August under d/m/yy — one of the two is a
  // lie and the file does not say which.
  const out = parseAngelOne(angelCtx(angelBook(
    [
      angelRow("ALPHA TEST LTD", "Buy", "242.80", "7", "0.51", "0.10", "0", "0.05", "27/08/26 0:00"),
      angelRow("ALPHA TEST LTD", "Sell", "243.34", "7", "0.51", "0.10", "0.43", "0.05", "27/08/26 0:00"),
      angelRow("BETA TEST BANK", "Sell", "22.71", "1", "0.07", "0.01", "0", "0", "05/08/26 0:00"),
    ],
    { total: "1.83", brokerage: "1.09", gst: "0.21", stt: "0.43", sebi: "0", exch: "0.10" },
  )));

  it("imports nothing rather than reading the readable half backwards", () => {
    expect(out.trades).toHaveLength(0);
  });

  it("says exactly one thing, and names the ambiguity and its sample", () => {
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/dates are ambiguous/);
    expect(out.warnings[0]).toMatch(/27\/08\/26/);
    expect(out.warnings[0]).toMatch(/day-first/);
  });
});

describe("FIX PASS 2 · MUST-FIX 1 — a dropped Angel One row's charges are never folded as 'rounding'", () => {
  // `8/32/26` names no day, so BETA is dropped — but the summary still counts
  // its ₹100.00 brokerage and ₹0.12 GST. Folding that onto ALPHA would put
  // one contract's money on another and call the ₹100.12 rounding.
  const out = parseAngelOne(angelCtx(angelBook(
    [
      angelRow("ALPHA TEST LTD", "Buy", "242.80", "7", "0.51", "0.10", "0", "0.05", "8/27/26 0:00"),
      angelRow("ALPHA TEST LTD", "Sell", "243.34", "7", "0.51", "0.10", "0.43", "0.05", "8/27/26 0:00"),
      angelRow("BETA TEST BANK", "Sell", "22.71", "1", "100.00", "0.12", "0", "0", "8/32/26 0:00"),
    ],
    { total: "101.87", brokerage: "101.02", gst: "0.32", stt: "0.43", sebi: "0", exch: "0.10" },
  )));
  const alpha = out.trades.find((t) => t.tradingsymbol === "ALPHA TEST LTD");

  it("reads the dated contract and drops the undated row", () => {
    expect(out.trades).toHaveLength(1);
    expect(alpha).toBeDefined();
  });

  it("leaves ALPHA's charges exactly as the file states them", () => {
    expect(alpha!.reportedCharges).toMatchObject({ brokerage: 1.02, gst: 0.2, sttCtt: 0.43, exchangeTxn: 0.1, total: 1.75 });
    expect(alpha!.importNotes?.some((n) => /rounding/i.test(n)) ?? false).toBe(false);
  });

  it("warns that the gap was NOT folded, naming the amount and the cap", () => {
    const w = out.warnings.find((x) => /NOT folded/.test(x));
    expect(w).toBeDefined();
    expect(w!).toMatch(/100\.12/);
    expect(w!).toMatch(/₹0\.05/);
    expect(w!).toMatch(/skipped for an unreadable date/);
  });
});

// ── FIX PASS 2 · SHOULD-FIX 2 — one corrupt cell is not a month-first file ──

const DAY_FIRST_NUMERIC_BOOK = gtr(
  [
    "01-07-2026 00:00,ZENSAR,NSE,B1,10,10000.00,0,0.00,100.00,18.00,10.00,0.10,0.15,0.62,0.00,-10128.87",
    "02-07-2026 00:00,ZENSAR,NSE,B2,0,0.00,10,11000.00,100.00,18.00,11.00,0.11,0.00,0.68,0.00,10870.21",
    "03-07-2026 00:00,PARAS DEFENCE,NSE,B3,5,5000.00,0,0.00,50.00,9.00,5.00,0.05,0.08,0.31,0.00,-5064.44",
    "04-07-2026 00:00,PARAS DEFENCE,NSE,B4,0,0.00,5,5300.00,50.00,9.00,5.30,0.05,0.00,0.33,0.00,5235.32",
    "32-01-2026 00:00,CORRUPT CELL,NSE,B5,1,1000.00,0,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,-1000.00",
  ],
  "Net P&L,912.22,Brokerage,300.00,Gross P&L,1300.00,Total Charges,387.78",
);

describe("FIX PASS 2 · SHOULD-FIX 2 — a day out of range is a skipped line, not an ambiguous file", () => {
  const read = readGtr(DAY_FIRST_NUMERIC_BOOK);
  const out = parseDhanGtr(ctxOf(DAY_FIRST_NUMERIC_BOOK));

  it("only a month token above 12 is evidence of month-first ordering", () => {
    expect(read.ambiguousDates).toBe(false);
    expect(read.rows).toHaveLength(4);
    expect(read.rows[0].date).toBe("2026-07-01");
  });

  it("imports the file minus the corrupt line", () => {
    expect(out.trades).toHaveLength(2);
    expect(out.trades.map((t) => t.tradingsymbol).sort()).toEqual(["PARAS DEFENCE", "ZENSAR"]);
  });

  it("names the skipped line and claims nothing about month-first ordering", () => {
    expect(out.warnings.some((w) => /1 line skipped: date not recognised \(first sample: "32-01-2026/.test(w))).toBe(true);
    expect(out.warnings.join(" ")).not.toMatch(/month-first/);
    expect(out.warnings.join(" ")).not.toMatch(/Nothing was imported/);
  });
});

// ── FIX PASS 2 · SHOULD-FIX 3 — two signs in one money cell is unreadable ────

describe("FIX PASS 2 · SHOULD-FIX 3 — parseTextMoney never multiplies two signs together", () => {
  it("refuses a Dr/Cr tag beside an explicit sign, instead of flipping it", () => {
    expect(parseTextMoney("-1,234.00 Dr")).toBe(0);
    expect(parseTextMoney("(1,234.00) Cr")).toBe(0);
    expect(parseTextMoney("Dr 12 Cr")).toBe(0);
  });

  it("still reads every notation the real exports do carry", () => {
    expect(parseTextMoney("1,234.00 Dr")).toBe(-1234);
    expect(parseTextMoney("Cr 1,234.00")).toBe(1234);
    expect(parseTextMoney("−1,234.00")).toBe(-1234);
    expect(parseTextMoney("(1,234.00)")).toBe(-1234);
  });
});
