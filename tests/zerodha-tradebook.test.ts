/**
 * Zerodha tradebook → FIFO positions.
 *
 * The branch under test used to sum a whole file per symbol and set
 * grossPnl = sellValue − buyValue, which booked every holding sold from
 * before the export window as 100 % profit and gave every position the FIRST
 * fill's date as both entry and exit. These tests pin the pairing instead.
 *
 * All inputs are synthetic: invented symbols, invented ISINs, no client
 * identifiers of any kind.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseZerodha } from "../lib/import/parsers/zerodha";

const ctx = (filename: string, text: string) => ({ filename, text, buffer: undefined });

/** The real Console tradebook layout: no Product column, a separate clock. */
const HEAD_NO_PRODUCT =
  "Symbol,ISIN,Trade Date,Exchange,Trade Type,Quantity,Price,Order Execution Time";

describe("Zerodha tradebook — FIFO pairing", () => {
  it("refuses to price a sell that has no matching buy in the file", () => {
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
ALPHATEST,INE000A01001,2026-04-21,NSE,sell,1200,316.25,2026-04-21 10:05:11
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    expect(out.trades).toHaveLength(1);
    const t = out.trades[0];
    expect(t.basisUnknown).toBe(true);
    expect(t.grossPnl).toBe(0); // NOT 379,500 — the cost basis is unknowable
    expect(t.buyQty).toBe(0);
    expect(t.buyValue).toBe(0);
    expect(t.sellQty).toBe(1200);
    expect(t.buyDate).toBeNull();
    expect(t.sellDate).toBe("2026-04-21");
    expect(out.warnings.some((w) => /no matching buy in this file/i.test(w))).toBe(true);
  });

  it("splits two round trips in one symbol into two positions with their own dates", () => {
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
BETATEST,INE000A01002,2026-04-01,NSE,buy,10,100,2026-04-01 09:20:00
BETATEST,INE000A01002,2026-04-02,NSE,sell,10,110,2026-04-02 14:30:00
BETATEST,INE000A01002,2026-04-05,NSE,buy,10,120,2026-04-05 09:45:00
BETATEST,INE000A01002,2026-04-06,NSE,sell,10,130,2026-04-06 15:10:00
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    expect(out.trades).toHaveLength(2);
    const [first, second] = out.trades;
    expect(first.buyDate).toBe("2026-04-01");
    expect(first.sellDate).toBe("2026-04-02");
    expect(first.grossPnl).toBe(100);
    expect(second.buyDate).toBe("2026-04-05");
    expect(second.sellDate).toBe("2026-04-06");
    expect(second.grossPnl).toBe(100);
    // The old aggregation produced ONE row, 20 bought / 20 sold, dated 04-01.
    expect(out.trades.some((t) => t.buyQty === 20)).toBe(false);
  });

  it("keeps the real holding period and derives delivery when nothing states it", () => {
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
GAMMATEST,INE000A01003,2026-04-01,NSE,buy,100,250,2026-04-01 11:14:28
GAMMATEST,INE000A01003,2026-04-10,NSE,sell,100,270,2026-04-10 13:02:04
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    expect(out.trades).toHaveLength(1);
    const t = out.trades[0];
    expect(t.buyDate).toBe("2026-04-01");
    expect(t.sellDate).toBe("2026-04-10");
    expect(t.productHint).toBe("delivery");
    expect(t.productDerived).toBe(true);
    expect(t.grossPnl).toBe(2000);
    expect(t.avgBuyPrice).toBe(250);
    expect(t.avgSellPrice).toBe(270);
  });

  it("derives intraday for a same-day round trip", () => {
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
DELTATEST,INE000A01004,2026-04-01,NSE,buy,50,80,2026-04-01 09:30:00
DELTATEST,INE000A01004,2026-04-01,NSE,sell,50,82,2026-04-01 11:45:00
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0].productHint).toBe("intraday");
    expect(out.trades[0].productDerived).toBe(true);
    expect(out.trades[0].buyDate).toBe("2026-04-01");
    expect(out.trades[0].sellDate).toBe("2026-04-01");
  });

  it("collapses a one-day scale-in/scale-out ladder into ONE intraday position", () => {
    // Legs are scrip-DAYS, not fills. Per-fill legs would emit one position
    // per sell fill — two "trades" where the trader took one.
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
SIGMATEST,INE000A01013,2026-04-01,NSE,buy,11,100,2026-04-01 09:21:00
SIGMATEST,INE000A01013,2026-04-01,NSE,buy,2,101,2026-04-01 09:22:00
SIGMATEST,INE000A01013,2026-04-01,NSE,buy,2,102,2026-04-01 09:23:00
SIGMATEST,INE000A01013,2026-04-01,NSE,sell,10,110,2026-04-01 14:30:00
SIGMATEST,INE000A01013,2026-04-01,NSE,sell,5,112,2026-04-01 15:05:00
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    expect(out.trades).toHaveLength(1);
    const t = out.trades[0];
    expect(t.productHint).toBe("intraday");
    expect(t.buyQty).toBe(15);
    expect(t.sellQty).toBe(15);
    expect(t.buyValue).toBe(11 * 100 + 2 * 101 + 2 * 102);
    expect(t.sellValue).toBe(10 * 110 + 5 * 112);
    expect(t.grossPnl).toBe(t.sellValue - t.buyValue);
    // Every individual fill survives, so the staged ladder is still rebuildable.
    expect(t.executions).toHaveLength(5);
    expect(t.executions!.filter((e) => e.side === "buy")).toHaveLength(3);
    expect(t.entryTime).toBe("09:21");
    expect(t.exitTime).toBe("15:05");
    expect(out.sourceRows).toBe(5); // fills read, not legs paired
    expect(out.warnings[0]).toMatch(/5 fills → 1 position \(FIFO per symbol \+ day\)/);
  });

  it("emits one closed position per sell DAY when a holding is exited in stages", () => {
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
OMEGATEST,INE000A01014,2026-04-01,NSE,buy,60,100,2026-04-01 09:20:00
OMEGATEST,INE000A01014,2026-04-01,NSE,buy,40,100,2026-04-01 09:25:00
OMEGATEST,INE000A01014,2026-04-08,NSE,sell,30,120,2026-04-08 10:00:00
OMEGATEST,INE000A01014,2026-04-08,NSE,sell,20,122,2026-04-08 11:00:00
OMEGATEST,INE000A01014,2026-04-15,NSE,sell,50,130,2026-04-15 10:00:00
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    expect(out.trades).toHaveLength(2); // two sell DAYS, not three sell fills
    expect(out.trades.map((t) => t.sellDate)).toEqual(["2026-04-08", "2026-04-15"]);
    expect(out.trades.map((t) => t.buyDate)).toEqual(["2026-04-01", "2026-04-01"]);
    expect(out.trades.map((t) => t.sellQty)).toEqual([50, 50]);
    expect(out.trades.every((t) => t.productHint === "delivery")).toBe(true);
    expect(out.sourceRows).toBe(5);
  });

  it("reads the fill clock from Order Execution Time, not the bare trade date", () => {
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
EPSITEST,INE000A01005,2026-04-01,NSE,buy,10,100,2026-04-01 11:14:28
EPSITEST,INE000A01005,2026-04-01,NSE,sell,10,101,2026-04-01 14:52:03
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    const t = out.trades[0];
    expect(t.entryTime).toBe("11:14");
    expect(t.exitTime).toBe("14:52");
    expect(t.executions?.map((e) => e.time)).toEqual(["11:14", "14:52"]);
  });

  it("reads dd-mm-yyyy trade dates as day-first", () => {
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
ZETATEST,INE000A01006,01-04-2026,NSE,buy,10,100,01-04-2026 09:20:00
ZETATEST,INE000A01006,10-04-2026,NSE,sell,10,105,10-04-2026 09:20:00
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    expect(out.trades[0].buyDate).toBe("2026-04-01");
    expect(out.trades[0].sellDate).toBe("2026-04-10");
  });

  it("refuses a row it cannot read rather than coercing it to zero", () => {
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
ETATEST,INE000A01007,not-a-date,NSE,buy,10,100,
ETATEST,INE000A01007,2026-04-01,NSE,buy,10,100,2026-04-01 09:20:00
ETATEST,INE000A01007,2026-04-02,NSE,sell,10,110,2026-04-02 09:20:00
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0].buyQty).toBe(10); // the unreadable buy is NOT counted
    expect(out.sourceRows).toBe(2);
    expect(out.warnings.some((w) => /refused rather than guessed/i.test(w))).toBe(true);
  });

  it("takes the product from the column when the export carries one", () => {
    const fixture = fs.readFileSync(
      path.join(process.cwd(), "tests", "fixtures", "zerodha-tradebook.csv"),
      "utf8",
    );
    const out = parseZerodha(ctx("zerodha-tradebook.csv", fixture));
    expect(out.trades).toHaveLength(3);
    for (const t of out.trades) {
      expect(t.productHint).toBe("delivery"); // stated CNC, not derived
      expect(t.productDerived).toBeFalsy();
      expect(t.basisUnknown).toBe(false);
      expect(t.exchangeHint).toBe("NSE");
    }
    const alpha = out.trades.find((t) => t.tradingsymbol === "E2EALPHA")!;
    expect(alpha.buyDate).toBe("2026-06-01");
    expect(alpha.sellDate).toBe("2026-06-10"); // was 2026-06-01 under aggregation
    expect(alpha.grossPnl).toBe(-1000);
    const beta = out.trades.find((t) => t.tradingsymbol === "E2EBETA")!;
    expect(beta.buyDate).toBe("2026-06-02");
    expect(beta.sellDate).toBe("2026-06-10");
    const gamma = out.trades.find((t) => t.tradingsymbol === "E2EGAMMA")!;
    expect(gamma.buyDate).toBe("2026-06-03");
    expect(gamma.sellDate).toBe("2026-06-11");
    expect(gamma.grossPnl).toBe(600);
  });

  it("conserves quantity and value through the pairing", () => {
    const csv = `Tradebook
${HEAD_NO_PRODUCT}
THETATEST,INE000A01008,2026-04-01,NSE,buy,30,100,2026-04-01 09:20:00
THETATEST,INE000A01008,2026-04-02,NSE,buy,20,110,2026-04-02 09:20:00
THETATEST,INE000A01008,2026-04-03,NSE,sell,40,120,2026-04-03 09:20:00
IOTATEST,INE000A01009,2026-04-03,NSE,sell,15,90,2026-04-03 10:00:00
`;
    const out = parseZerodha(ctx("zerodha-tradebook.csv", csv));
    expect(out.warnings.some((w) => /conservation check FAILED/i.test(w))).toBe(false);
    const buyQty = out.trades.reduce((s, t) => s + t.buyQty, 0);
    const sellQty = out.trades.reduce((s, t) => s + t.sellQty, 0);
    expect(buyQty).toBe(50); // 40 matched + 10 still open
    expect(sellQty).toBe(55); // 40 closed + 15 opening sell
    // Only the closed leg carries P&L.
    const pnl = out.trades.reduce((s, t) => s + t.grossPnl, 0);
    expect(pnl).toBe(40 * 120 - (30 * 100 + 10 * 110));
  });
});

describe("Zerodha Console P&L", () => {
  it("skips rows that bought nothing, sold nothing and are worth nothing", () => {
    const csv = `Zerodha Console
Brokerage - Z,100
Central GST - Z,18
Symbol,ISIN,Buy Quantity,Buy Value,Sell Quantity,Sell Value,Realized P&L
KAPPATEST,INE000A01010,100,10000,100,11000,1000
INE000A01011,,0,0,0,0,0
LAMBDATEST,INE000A01012,50,5000,50,5500,500
`;
    const out = parseZerodha(ctx("zerodha-pnl.csv", csv));
    expect(out.format).toBe("console");
    expect(out.trades.map((t) => t.tradingsymbol)).toEqual(["KAPPATEST", "LAMBDATEST"]);
  });
});
