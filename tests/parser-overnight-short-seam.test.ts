import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildContext } from "@/lib/import/detect";
import { parseZerodha } from "@/lib/import/parsers/zerodha";
import { parseFyersTradebook } from "@/lib/import/parsers/fyers-tradebook";
import { parseNuvamaPnlReport } from "@/lib/import/parsers/nuvama-pnl-report";
import { parseGrowwOrders } from "@/lib/import/parsers/groww-orders";
import { parsePaytmTradebook } from "@/lib/import/parsers/paytm-tradebook";
import { parseDhanGtr } from "@/lib/import/parsers/dhan-gtr";
import { applyMapping, type ColumnMapping } from "@/lib/import/generic-map";
import { normalizeDhanTrades, type DhanTradeRow } from "@/lib/import/api/dhan";
import { OVERNIGHT_SHORT_NOTE } from "@/lib/import/pair-legs";
import type { NormalizedTrade } from "@/lib/engine/types";

/**
 * v4.6.0 W6 parser seam (contract D4, §3): a SYNTHETIC F&O tradebook with an
 * overnight short — sold 75 on 01 Sep (two fills), bought back 75 on 02 Sep —
 * through the REAL parsers. Each must emit ONE closed short row carrying:
 *   - its ladder (all three fills; Σ per side = 75, invariant 5),
 *   - entryTime = the first SELL fill, exitTime = the last BUY fill,
 *   - `side: 'short'`, a known basis, the overnight note;
 * and the Nuvama bill's stated heads must survive (the allocation used to
 * return null for every short shape and drop them to a bare total).
 *
 * Before W6 each of these read an opening sell (basis unknown, P&L 0) plus a
 * separate open long — LEDGER D-8.
 */

function expectOneClosedShort(trades: NormalizedTrade[], opts: { ladder: boolean; times: boolean }) {
  expect(trades.map((t) => [t.side, t.buyQty, t.sellQty, t.sellDate, t.buyDate, t.basisUnknown ?? false])).toEqual([
    ["short", 75, 75, "2026-09-01", "2026-09-02", false],
  ]);
  const t = trades[0];
  expect(t.grossPnl).toBe(t.sellValue - t.buyValue);
  expect(t.importNotes).toContain(OVERNIGHT_SHORT_NOTE);
  if (opts.ladder) {
    const ex = t.executions ?? [];
    const sum = (side: "buy" | "sell") => ex.filter((e) => e.side === side).reduce((s, e) => s + e.qty, 0);
    expect([ex.length, sum("sell"), sum("buy")]).toEqual([3, 75, 75]);
  }
  if (opts.times) expect([t.entryTime, t.exitTime]).toEqual(["09:20", "14:40"]);
}

describe("Zerodha tradebook — an overnight option short", () => {
  it("one closed short row with its ladder, entry = the sale, exit = the buy-back", () => {
    const csv = [
      "Symbol,ISIN,Exchange,Trade Type,Quantity,Price,Product,Trade Date,Order Execution Time",
      "NIFTY26SEP24500CE,,NFO,sell,50,120,NRML,2026-09-01,2026-09-01 09:20:00",
      "NIFTY26SEP24500CE,,NFO,sell,25,126,NRML,2026-09-01,2026-09-01 10:05:00",
      "NIFTY26SEP24500CE,,NFO,buy,75,90,NRML,2026-09-02,2026-09-02 14:40:00",
    ].join("\n");
    const parsed = parseZerodha(buildContext("tradebook-OVN.csv", Buffer.from(csv)));
    expectOneClosedShort(parsed.trades, { ladder: true, times: true });
    expect([parsed.trades[0].sellValue, parsed.trades[0].buyValue]).toEqual([9150, 6750]);
  });

  it("…and a cash-equity sell-then-next-day-buy is still an opening sell plus an open long", () => {
    const csv = [
      "Symbol,ISIN,Exchange,Trade Type,Quantity,Price,Product,Trade Date",
      "RELIANCE,INE002A01018,NSE,sell,10,3000,CNC,2026-09-01",
      "RELIANCE,INE002A01018,NSE,buy,10,2900,CNC,2026-09-02",
    ].join("\n");
    const parsed = parseZerodha(buildContext("tradebook-EQ.csv", Buffer.from(csv)));
    expect(parsed.trades.map((t) => [t.basisUnknown ?? false, t.buyQty, t.sellQty])).toEqual([[true, 0, 10], [false, 10, 0]]);
  });
});

describe("Fyers tradebook — an overnight option short", () => {
  it("one closed short row with its ladder, entry = the sale, exit = the buy-back", () => {
    const csv = [
      "Report Title,Tradebook report,,,,,,,,,",
      "Date Range,From 01/09/2026 to 02/09/2026,,,,,,,,,",
      ",,,,,,,,,,",
      "Symbol name,Symbol code,Date & time,Side,Product type,Qty,Traded price,Total value,Segment,Exchange order ID,OMS order ID",
      // Newest first, as the real export prints.
      'NIFTY26SEP24500CE,NIFTY 24500 CE,"02 Sep 2026, 02:40:00 PM",BUY,Overnight,75,90,"6,750.00",Derivatives,1300000000000003,2609020000003',
      'NIFTY26SEP24500CE,NIFTY 24500 CE,"01 Sep 2026, 10:05:00 AM",SELL,Overnight,25,126,"3,150.00",Derivatives,1300000000000002,2609010000002',
      'NIFTY26SEP24500CE,NIFTY 24500 CE,"01 Sep 2026, 09:20:00 AM",SELL,Overnight,50,120,"6,000.00",Derivatives,1300000000000001,2609010000001',
    ].join("\n");
    const parsed = parseFyersTradebook(buildContext("FYERS_tradebook_OVN.csv", Buffer.from(csv)));
    expectOneClosedShort(parsed.trades, { ladder: true, times: true });
    expect(parsed.warnings.some((w) => /could not be traced/.test(w))).toBe(false);
  });
});

describe("Nuvama P&L report — an overnight option short keeps the bill's heads", () => {
  it("one closed short row whose stated heads are the sum of the two day-legs' bills", () => {
    const pre = (title: string) => [
      ["Nuvama Wealth and Investment Limited"],
      [title],
      ["Period as on : 01-Sep-2026 to 22-Sep-2026"],
      ["Calculation Method : FIFO"],
    ];
    const HEADER = ["", "Isin", "Instrument", "TxnDate", "TxnType", "Action", "Quantity", "Price", "Brok", "STax/GST on Brokerage", "STT", "Stamp Duty", "Sebi Fees", "Txn Charges", "Tax on Txn Charges", "Other Charges", "Cumulative Quantity", "Net Charges", "Delete Flag"];
    const INST = "NIFTY-OPT-29Sep2026-CE-24500-NSE";
    // Sell day: brok 20, gst 3.6, stt 9.15, stamp 0, sebi 0.01, txn 3.25, tax on txn 0.59 → 36.60
    // Buy day:  brok 20, gst 3.6, stt 0,    stamp 0.2, sebi 0.01, txn 2.4, tax on txn 0.43 → 26.64
    const detail = [
      ...pre("Detail Realised"),
      HEADER,
      ["", "Total", "", "", "", "", "", "", 40, 7.2, 9.15, 0.2, 0.02, 5.65, 1.02, 0, "", 63.24, ""],
      ["", "", INST, "01-Sep-26", "NSE", "Sell", 75, 122, 20, 3.6, 9.15, 0, 0.01, 3.25, 0.59, 0, -75, 36.6, "False"],
      ["", "", INST, "02-Sep-26", "NSE", "Buy", 75, 90, 20, 3.6, 0, 0.2, 0.01, 2.4, 0.43, 0, 0, 26.64, "False"],
      ["DISCLAIMER"],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Nuvama Wealth and Investment Limited"], ["Summary"]]), "Summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), "Detail Realised");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...pre("Unrealised Details"), HEADER, ["DISCLAIMER"]]), "Unrealised Details");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Dividend"]]), "Dividend");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Understanding the Report"]]), "Understanding the Report");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const parsed = parseNuvamaPnlReport(buildContext("NUVAMA_PnL_Report_OVN.xlsx", buf));
    expectOneClosedShort(parsed.trades, { ladder: false, times: false });
    const rc = parsed.trades[0].reportedCharges!;
    // The heads of BOTH day-legs — not a bare total with every head at 0.
    expect([rc.brokerage, rc.gst, rc.sttCtt, rc.stampDuty, rc.sebi, rc.exchangeTxn, rc.total]).toEqual([40, 8.22, 9.15, 0.2, 0.02, 5.65, 63.24]);
    expect(parsed.warnings.some((w) => /could not be traced/.test(w))).toBe(false);
  });
});

// ── Fix wave (finding 6): the other four tradebook parsers + the Dhan API pull ──
//
// The same overnight short through Groww, Paytm, Dhan's Global Transaction
// Report, the generic column mapper and the Dhan API's trade-history pull —
// each the REAL parser. The fills are timed so that time-of-day alone would get
// the direction WRONG: the sales are at 13:20 and 14:05 on 01 Sep and the
// buy-back at 10:40 on 02 Sep, so the entry (the first SALE) is later in the
// day than the exit (the last BUY). A parser that took min/max of the times, or
// the first buy as the entry, reads 10:40 → 14:05. And a sale NO later buy
// covers stays the opening sell it always was.

const OVN = { entry: "13:20", exit: "10:40" } as const;
const SELL_1 = { qty: 50, price: 120, date: "2026-09-01", time: "13:20:00" };
const SELL_2 = { qty: 25, price: 126, date: "2026-09-01", time: "14:05:00" };
const BUY = { qty: 75, price: 90, date: "2026-09-02", time: "10:40:00" };
type Fill = typeof BUY;

function expectShort(trades: NormalizedTrade[], times: { entry: string; exit: string } | null) {
  expect(trades.map((t) => [t.side, t.buyQty, t.sellQty, t.sellDate, t.buyDate, t.basisUnknown ?? false])).toEqual([
    ["short", 75, 75, "2026-09-01", "2026-09-02", false],
  ]);
  const t = trades[0];
  expect([t.sellValue, t.buyValue, t.grossPnl]).toEqual([9150, 6750, 2400]);
  expect(t.importNotes).toContain(OVERNIGHT_SHORT_NOTE);
  if (times) expect([t.entryTime, t.exitTime]).toEqual([times.entry, times.exit]);
}

/** Every row an opening sell (one per sell leg — Groww's legs are orders), 75 sold between them. */
function expectOpeningSell(trades: NormalizedTrade[]) {
  expect(new Set(trades.map((t) => JSON.stringify([t.side, t.basisUnknown ?? false, t.buyQty, t.sellDate])))).toEqual(
    new Set([JSON.stringify(["short", true, 0, "2026-09-01"])]),
  );
  expect(trades.reduce((s, t) => s + t.sellQty, 0)).toBe(75);
  for (const t of trades) expect(t.importNotes ?? []).not.toContain(OVERNIGHT_SHORT_NOTE);
}

describe("Groww order history — an overnight option short", () => {
  const HEADER = ["Stock name", "Symbol", "ISIN", "Type", "Quantity", "Value", "Exchange", "Exchange Order Id", "Execution date and time", "Order status"];
  const row = (side: "Buy" | "Sell", f: Fill, id: string) =>
    ["NIFTY 24500 CE", "NIFTY26SEP24500CE", "", side, f.qty, f.qty * f.price, "NSE", id, `${f.date} ${f.time}`, "Executed"];
  const book = (rows: unknown[][]) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name"], ["Unique Client Code"], [], HEADER, ...rows]), "Sheet1");
    return { filename: "Stocks_Order_History_OVN.xlsx", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer };
  };

  it("one closed short, entry = the first sale, exit = the buy-back; an uncovered sale stays an opening sell", () => {
    expectShort(parseGrowwOrders(book([row("Sell", SELL_1, "X1"), row("Sell", SELL_2, "X2"), row("Buy", BUY, "X3")])).trades, OVN);
    expectOpeningSell(parseGrowwOrders(book([row("Sell", SELL_1, "X1"), row("Sell", SELL_2, "X2")])).trades);
  });
});

describe("Paytm Money tradebook — an overnight option short", () => {
  const HEADER = ["Date", "Script", "ISIN", "Exchange", "Product Type", "Type", "Quantity", "Price", "Brokerage", "ETT", "GST", "STT", "SEBI", "Stamp Duty", "Order Number", "Trade Number", "Trade Time"];
  const row = (side: "Buy" | "Sell", f: Fill, id: string) => {
    const [y, m, d] = f.date.split("-");
    return [`${d}-${m}-${y}`, "NIFTY26SEP24500CE", "", "NSE", "EQ", side, f.qty, f.price, 0, 0, 0, 0, 0, 0, `O${id}`, `T${id}`, f.time];
  };
  const book = (rows: unknown[][]) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["UCC"], ["Name"], ["PAN Number"], ["Period"], HEADER, ...rows]), "Sheet1");
    return { filename: "Paytm Money - Tradebook OVN.xlsx", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer };
  };

  it("one closed short, entry = the first sale, exit = the buy-back; an uncovered sale stays an opening sell", () => {
    expectShort(parsePaytmTradebook(book([row("Sell", SELL_1, "1"), row("Sell", SELL_2, "2"), row("Buy", BUY, "3")])).trades, OVN);
    expectOpeningSell(parsePaytmTradebook(book([row("Sell", SELL_1, "1"), row("Sell", SELL_2, "2")])).trades);
  });
});

describe("Dhan Global Transaction Report — an overnight option short (the report states no times)", () => {
  const HEADER = "Date,Scrip Name,Exchange,Bill No.,Buy Qty.,Buy Value,Sell Qty.,Sell Value,Brokerage,GST,STT,SEBI Fees,Stamp Duty,Txn. Charges,Oth. Charges,Gross Amount";
  const SCRIP = "OPT NIFTY 29 Sep 2026 24500 CE";
  // One bill line per scrip-day: the day's two sales are ONE line, as the report prints them.
  const SALE_DAY = `"01 Sep 2026 00:00:00","${SCRIP}","NSE","B1","0","0.00","75","9150.00","40.00","7.20","9.15","0.01","0.00","3.25","0.00","9090.39"`;
  const BUY_DAY = `"02 Sep 2026 00:00:00","${SCRIP}","NSE","B2","75","6750.00","0","0.00","20.00","3.60","0.00","0.01","0.20","2.40","0.00","-6776.21"`;
  const report = (lines: string[], gross: number, charges: number) => ({
    filename: "Dhan_GlobalTransction_Report_01-09-2026_02-09-2026.csv",
    text: [
      "Global transction report,From 01-09-2026 to 02-09-2026",
      "Name,TESTUSER",
      "UCC,TEST0001A",
      "",
      HEADER,
      ...lines,
      "",
      `Net P&L,${gross - charges},Brokerage,0,Gross P&L,${gross},Total Charges,${charges}`,
    ].join("\n"),
  });

  it("one closed short with the file's own dates and no invented times; an uncovered sale stays an opening sell", () => {
    const parsed = parseDhanGtr(report([SALE_DAY, BUY_DAY], 2400, 86.82));
    expectShort(parsed.trades, null);
    expect([parsed.trades[0].entryTime ?? null, parsed.trades[0].exitTime ?? null]).toEqual([null, null]);
    expectOpeningSell(parseDhanGtr(report([SALE_DAY], 0, 59.61)).trades);
  });
});

describe("generic column mapper — an overnight option short", () => {
  const headers = ["Date", "Time", "Symbol", "Type", "Qty", "Price"];
  const m: ColumnMapping = { date: 0, time: 1, tradingsymbol: 2, side: 3, qty: 4, price: 5 };
  const row = (side: "BUY" | "SELL", f: Fill) => [f.date, f.time, "NIFTY26SEP24500CE", side, String(f.qty), String(f.price)];
  const OPTS = { broker: "kotakneo" as const, filename: "kotak-ovn.csv" };

  it("one closed short, entry = the first sale, exit = the buy-back; an uncovered sale stays an opening sell", () => {
    expectShort(applyMapping(headers, [row("SELL", SELL_1), row("SELL", SELL_2), row("BUY", BUY)], m, OPTS).trades, OVN);
    expectOpeningSell(applyMapping(headers, [row("SELL", SELL_1), row("SELL", SELL_2)], m, OPTS).trades);
  });
});

describe("Dhan API trade-history pull — an overnight option short inside ONE pull", () => {
  // `normalizeDhanTrades` is the pure half of the pull (no live client needed):
  // a catch-up window spanning both days hands it every fill at once. A daily
  // pull that splits the sale and the buy-back across two pulls still files
  // them apart — LEDGER D-8, recorded, not built.
  const fill = (id: string, side: "BUY" | "SELL", f: Fill): DhanTradeRow => ({
    exchangeTradeId: id,
    orderId: `O-${id}`,
    transactionType: side,
    exchangeSegment: "NSE_FNO",
    productType: "MARGIN",
    tradingSymbol: "NIFTY-Sep2026-24500-CE",
    tradedQuantity: f.qty,
    tradedPrice: f.price,
    exchangeTime: `${f.date} ${f.time}`,
    drvExpiryDate: "2026-09-29",
    drvOptionType: "CALL",
    drvStrikePrice: 24500,
  });

  it("one closed short with its ladder, entry = the first sale, exit = the buy-back; an uncovered sale stays an opening sell", () => {
    const { trades } = normalizeDhanTrades([fill("S1", "SELL", SELL_1), fill("S2", "SELL", SELL_2), fill("B1", "BUY", BUY)]);
    expectShort(trades, OVN);
    const ex = trades[0].executions ?? [];
    const sum = (side: "buy" | "sell") => ex.filter((e) => e.side === side).reduce((s, e) => s + e.qty, 0);
    expect([ex.length, sum("sell"), sum("buy")]).toEqual([3, 75, 75]);
    expectOpeningSell(normalizeDhanTrades([fill("S1", "SELL", SELL_1), fill("S2", "SELL", SELL_2)]).trades);
  });
});
