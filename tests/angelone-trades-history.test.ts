/**
 * Angel One `Trades_History_<code>.xlsx` (verified on a real export,
 * 2026-09-04) — and the Zerodha misclaim it exposed.
 *
 * The file names no broker anywhere. `detectZerodha` claimed it at 0.50
 * because its header carries `Order ID` + `Trade ID`, a pair that detector
 * treated as Zerodha's alone; the existing Angel parser scored 0 because the
 * header sits on row 34 (past a 30-row scan) and calls the symbol column
 * `Scrip/Contract`. Now: Zerodha's ID pair needs something Zerodha writes
 * (`Auction`, `Order Execution Time`, the "Tradebook for …" preamble, or a
 * name), and Angel One recognises the layout by its FORMAT fingerprint.
 *
 * Synthetic workbook in the real layout; the real file replayed in place.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildContext, rankParsers } from "@/lib/import/detect";
import { classify } from "@/lib/engine/classify";
import { canonicalAngelContract, detectAngelOne, parseAngelOne, usDateToIso } from "@/lib/import/parsers/angelone-upstox";
import { detectZerodha } from "@/lib/import/parsers/zerodha";
import { ownerContext, ownerFile } from "./helpers/owner-broker-files";

const HEADER = ["Scrip/Contract", "Buy/Sell", "Buy Price", "Sell Price", "Quantity", "Brokerage", "GST", "STT", "Sebi Tax", "Exchange Turnover Charges", "Stamp Duty", "Other Charges", "IPFT Charges", "Order Type", "Segment", "Exchange", "Order ID", "Trade ID", "Date"];
const OPT = "OPTSTK ALPHATEST Sep 29 2026 1550.00 CE (BT)";

function workbook(sheet = "TradesAndCharges"): Buffer {
  const aoa: string[][] = [
    ["ClientCode", "TEST0001"],
    ["DateOfDownload", "2026-09-04"],
    [],
    ["Date Range"],
    ["StartDate", "EndDate"],
    ["2026-04-01 00:00:00.0", "2026-09-02 23:59:59.0"],
    [],
    ["Charges Summary"],
    ["Total Trades", "5"],
    ["Total Charges", "55.16"],
    ["Total Trade Charges", "50.16"],
    ["Total Non Trade Charges", "5"],
    [],
    ["Trade Charges"],
    ["Brokerage", "41.09"],
    ["GST", "7.58"],
    ["SEBI Tax", "0.01"],
    ["STT", "0.43"],
    ["Exchange Turnover Charges", "1.05"],
    ["Stamp Duty", "0"],
    ["Other Charges", "0"],
    ["IPFT Charges", "0"],
    [],
    ["Non Trade Charges"],
    ["DP Charges", "5"],
    ["Interest Charges", "0"],
    ["Monthly Account Maintenance Charges", "0"],
    ["Pledge Charges", "0"],
    ["Call And Trade Charges", "0"],
    ["Margin Shortfall Penalty", "0"],
    [],
    [],
    ["TradeBook And Charges"],
    HEADER,
    ["ALPHA TEST LTD", "Buy", "242.8", "", "7", "0.51", "0.1", "0", "0", "0.05", "0", "0", "0", "Intraday", "CAPITAL", "NSE", "1100000000000001", "204235149", "8/27/26 0:00"],
    ["ALPHA TEST LTD", "Sell", "", "243.34", "7", "0.51", "0.1", "0.43", "0", "0.05", "0", "0", "0", "Intraday", "CAPITAL", "NSE", "1100000000000002", "204334864", "8/27/26 0:00"],
    [OPT, "Buy", "2.2", "", "700", "0", "0.1", "0", "0", "0.55", "0", "0", "0", "Intraday", "FUTURES", "NSE", "2700000000000001", "274961", "8/27/26 0:00"],
    [OPT, "Sell", "", "1.6", "700", "0", "0.07", "0", "0.01", "0.4", "0", "0", "0", "Intraday", "FUTURES", "NSE", "2700000000000002", "330957", "8/27/26 0:00"],
    [OPT, "Buy", "0", "", "0", "20", "3.6", "0", "0", "0", "0", "0", "0", "Intraday", "FUTURES", "NSE", "2700000000000001", "", "8/27/26 0:00"],
    [OPT, "Sell", "", "0", "0", "20", "3.6", "0", "0", "0", "0", "0", "0", "Intraday", "FUTURES", "NSE", "2700000000000002", "", "8/27/26 0:00"],
    ["BETA TEST BANK", "Sell", "", "22.71", "1", "0.07", "0.01", "0", "0", "0", "0", "0", "0", "Delivery", "CAPITAL", "NSE", "1300000000000001", "602654204", "8/7/26 0:00"],
    [],
    ["NOTE: Data Accurate Till", "2026-09-02"],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

describe("detection", () => {
  it("Zerodha scores 0: the Order ID + Trade ID pair is not a Zerodha fingerprint on its own", () => {
    expect(detectZerodha(buildContext("export.xlsx", workbook()))).toBe(0);
    expect(detectZerodha(buildContext("Trades_History_TEST0001.xlsx", workbook()))).toBe(0);
  });

  it("Angel One claims it at ≥ 0.9 on the format fingerprint alone — the file never says 'Angel'", () => {
    const c = buildContext("export.xlsx", workbook());
    expect(detectAngelOne(c)).toBeGreaterThanOrEqual(0.9);
    expect(rankParsers(c)[0].sourceId).toBe("angelone");
  });

  it("the same header on a differently named sheet is not the fingerprint", () => {
    expect(detectAngelOne(buildContext("export.xlsx", workbook("Sheet1")))).toBe(0);
  });

  it("Zerodha still claims its own tradebook by its Auction / Order Execution Time columns", () => {
    const own = buildContext(
      "export.csv",
      Buffer.from("Symbol,ISIN,Trade Date,Exchange,Segment,Series,Trade Type,Auction,Quantity,Price,Trade ID,Order ID,Order Execution Time\nINFY,INE009A01021,2026-04-01,NSE,EQ,EQ,buy,FALSE,10,1500,1,1,2026-04-01T09:20:00\n"),
    );
    expect(detectZerodha(own)).toBeGreaterThanOrEqual(0.7);
    const ids = buildContext(
      "export.csv",
      Buffer.from("Symbol,ISIN,Trade Date,Exchange,Trade Type,Quantity,Price,Trade ID,Order ID\nINFY,INE009A01021,2026-04-01,NSE,buy,10,1500,1,1\n"),
    );
    expect(detectZerodha(ids)).toBe(0);
  });
});

describe("parse", () => {
  const out = parseAngelOne(buildContext("export.xlsx", workbook()));

  it("one position per contract + Order Type; prices read per side; dates from m/d/yy; no invented clock", () => {
    expect(out.format).toBe("tradebook");
    expect(out.sourceRows).toBe(7);
    expect(out.trades).toHaveLength(3);
    const alpha = out.trades.find((t) => t.tradingsymbol === "ALPHA TEST LTD")!;
    expect(alpha.buyQty).toBe(7);
    expect(alpha.avgBuyPrice).toBeCloseTo(242.8, 6);
    expect(alpha.sellQty).toBe(7);
    expect(alpha.avgSellPrice).toBeCloseTo(243.34, 6);
    expect(alpha.productHint).toBe("intraday");
    expect(alpha.exchangeHint).toBe("NSE");
    expect(alpha.buyDate).toBe("2026-08-27");
    expect(alpha.sellDate).toBe("2026-08-27");
    expect(alpha.entryTime).toBeNull();
    expect(alpha.exitTime).toBeNull();
    const beta = out.trades.find((t) => t.tradingsymbol === "BETA TEST BANK")!;
    expect(beta.productHint).toBe("delivery");
    expect(beta.sellDate).toBe("2026-08-07");
    expect(beta.buyQty).toBe(0);
  });

  it("charges are the broker's stated per-row figures, with the qty-0 per-order lines folded in", () => {
    const alpha = out.trades.find((t) => t.tradingsymbol === "ALPHA TEST LTD")!;
    expect(alpha.reportedCharges).toMatchObject({ brokerage: 1.02, gst: 0.2, sttCtt: 0.43, exchangeTxn: 0.1, total: 1.75 });
    const opt = out.trades.find((t) => t.tradingsymbol.startsWith("OPT "))!;
    expect(opt.executions).toHaveLength(2); // the two ₹20 brokerage lines are charges, not fills
    expect(opt.buyQty).toBe(700);
    expect(opt.sellQty).toBe(700);
    expect(opt.reportedCharges).toMatchObject({ brokerage: 40, gst: 7.37, sebi: 0.01, exchangeTxn: 0.95, total: 48.33 });
    const total = out.trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0);
    expect(Math.round(total * 100) / 100).toBe(50.16);
  });

  it("F&O contracts are rewritten to the classifier's grammar, and noted", () => {
    const opt = out.trades.find((t) => t.tradingsymbol.startsWith("OPT "))!;
    expect(opt.tradingsymbol).toBe("OPT ALPHATEST 29 Sep 2026 1550 CE");
    expect(opt.importNotes?.[0]).toMatch(/read as OPT ALPHATEST 29 Sep 2026 1550 CE/);
    expect(classify({ tradingsymbol: opt.tradingsymbol, broker: "angelone" }).segment).toBe("stock_option");
    expect(canonicalAngelContract("BSXOPT SENSEX Aug 27 2026 77600.00 CE (BT)")).toBe("OPT SENSEX 27 Aug 2026 77600 CE");
    expect(canonicalAngelContract("OPTIDX NIFTY Aug 25 2026 24150.00 PE (BT)")).toBe("OPT NIFTY 25 Aug 2026 24150 PE");
    expect(canonicalAngelContract("FUTSTK ALPHATEST Sep 29 2026")).toBe("FUT ALPHATEST 29 Sep 2026");
    expect(canonicalAngelContract("HFCL LIMITED")).toBe("HFCL LIMITED");
    expect(usDateToIso("8/27/26 0:00")).toBe("2026-08-27");
    expect(usDateToIso("2026-08-27 10:00")).toBe("2026-08-27");
  });

  it("the file's charges summary lands in reported, trade and non-trade kept apart", () => {
    expect(out.reported).toMatchObject({ totalTrades: 5, statedTotalCharges: 55.16, totalCharges: 50.16, nonTradeCharges: 5, brokerage: 41.09, dpCharges: 5 });
    expect(out.warnings.join(" ")).toMatch(/7 rows read, 2 of them per-order charge lines/);
    expect(out.warnings.join(" ")).toMatch(/non-trade charges/);
  });
});

const REAL = ownerFile(/^Trades_History_.*\.xlsx$/);
describe.skipIf(!REAL)("the owner's real Trades_History export, read in place", () => {
  it("Zerodha 0, Angel One ≥ 0.9, 24 rows, stated Total Charges 252.19", () => {
    const { filename, bytes } = ownerContext(REAL!);
    const c = buildContext(filename, bytes);
    expect(detectZerodha(c)).toBe(0);
    expect(detectAngelOne(c)).toBeGreaterThanOrEqual(0.9);
    expect(rankParsers(c)[0].sourceId).toBe("angelone");
    const out = parseAngelOne(buildContext(filename, fs.readFileSync(REAL!)));
    expect(out.sourceRows).toBe(24);
    expect(out.reported?.statedTotalCharges).toBe(252.19);
    expect(out.reported?.totalTrades).toBe(17);
    // Per-row charges sum to the file's own Total Trade Charges.
    const total = out.trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0);
    expect(Math.abs(total - out.reported!.totalCharges)).toBeLessThan(0.05);
    expect(out.trades.every((t) => t.buyDate == null || /^\d{4}-\d{2}-\d{2}$/.test(t.buyDate))).toBe(true);
    expect(out.trades.some((t) => /^OPT /.test(t.tradingsymbol))).toBe(true);
    expect(out.trades.some((t) => t.productHint === "delivery")).toBe(true);
  });
});
