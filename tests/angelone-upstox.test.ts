import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import {
  detectAngelOne,
  parseAngelOne,
  detectUpstox,
  parseUpstox,
} from "../lib/import/parsers/angelone-upstox";
import { detectParser, buildContext } from "../lib/import/detect";

const ctx = (filename: string, text: string) => ({ filename, text, buffer: undefined });

// Angel One tradebook — banner rows above the header, "Buy/Sell" side column.
const ANGEL_TRADEBOOK = `Angel One Limited
Trade Book Report,,,,
Client Code,A12345,,,
Symbol,Exchange,Product,Buy/Sell,Quantity,Price,Trade Date
RELIANCE,NSE,DELIVERY,BUY,10,2900,2026-06-02
RELIANCE,NSE,DELIVERY,SELL,10,2950,2026-06-10
TCS,NSE,INTRADAY,BUY,5,3800,2026-06-03
TCS,NSE,INTRADAY,SELL,5,3780,2026-06-03
`;

// Upstox P&L report — aggregated per scrip, ₹ symbols and commas in numbers.
const UPSTOX_PNL = `Upstox Securities
Realised P&L Statement,,,,,
Scrip Name,ISIN,Exchange,Buy Quantity,Buy Value,Sell Quantity,Sell Value,Realised P&L
INFY,INE009A01021,NSE,"20","₹30,000","20","₹31,500","₹1,500"
WIPRO,INE075A01022,NSE,"50","₹25,000","50","₹24,000","-₹1,000"
`;

describe("Angel One parser", () => {
  it("detects its own tradebook and ignores foreign files", () => {
    expect(detectAngelOne(ctx("angelone-tradebook.csv", ANGEL_TRADEBOOK))).toBeGreaterThan(0.5);
    expect(detectAngelOne(ctx("random.csv", "a,b,c\n1,2,3"))).toBe(0);
  });

  it("aggregates executions into round-trips with product hints", () => {
    const out = parseAngelOne(ctx("angelone-tradebook.csv", ANGEL_TRADEBOOK));
    expect(out.broker).toBe("angelone");
    expect(out.format).toBe("tradebook");
    expect(out.trades).toHaveLength(2);

    const ril = out.trades.find((t) => t.tradingsymbol === "RELIANCE")!;
    expect(ril.buyQty).toBe(10);
    expect(ril.avgBuyPrice).toBe(2900);
    expect(ril.sellQty).toBe(10);
    expect(ril.avgSellPrice).toBe(2950);
    expect(ril.grossPnl).toBe(500); // (2950-2900) × 10
    expect(ril.productHint).toBe("delivery");
    expect(ril.exchangeHint).toBe("NSE");
    expect(ril.buyDate).toBe("2026-06-02");
    expect(ril.sellDate).toBe("2026-06-10");

    const tcs = out.trades.find((t) => t.tradingsymbol === "TCS")!;
    expect(tcs.productHint).toBe("intraday");
    expect(tcs.grossPnl).toBe(-100);
  });

  it("splits the same symbol across different products", () => {
    const mixed = `Symbol,Product,Buy/Sell,Quantity,Price
RELIANCE,DELIVERY,BUY,10,2900
RELIANCE,INTRADAY,BUY,5,2910
`;
    const out = parseAngelOne(ctx("angelone.csv", mixed));
    expect(out.trades).toHaveLength(2);
    expect(out.trades.map((t) => t.productHint).sort()).toEqual(["delivery", "intraday"]);
  });
});

describe("Upstox parser", () => {
  it("detects its own P&L report", () => {
    expect(detectUpstox(ctx("upstox-pnl.csv", UPSTOX_PNL))).toBeGreaterThan(0.5);
  });

  it("reads aggregated rows, stripping ₹ and commas", () => {
    const out = parseUpstox(ctx("upstox-pnl.csv", UPSTOX_PNL));
    expect(out.broker).toBe("upstox");
    expect(out.format).toBe("pnl-report");
    expect(out.trades).toHaveLength(2);

    const infy = out.trades.find((t) => t.tradingsymbol === "INFY")!;
    expect(infy.buyQty).toBe(20);
    expect(infy.buyValue).toBe(30000);
    expect(infy.sellValue).toBe(31500);
    expect(infy.grossPnl).toBe(1500);
    expect(infy.avgBuyPrice).toBe(1500); // derived: 30000/20
    expect(infy.isin).toBe("INE009A01021");

    const wipro = out.trades.find((t) => t.tradingsymbol === "WIPRO")!;
    expect(wipro.grossPnl).toBe(-1000);
  });

  it("returns a clear warning when no header is recognizable", () => {
    const out = parseUpstox(ctx("upstox.csv", "just,some\nrandom,data"));
    expect(out.trades).toHaveLength(0);
    expect(out.warnings[0]).toMatch(/header/i);
  });
});

describe("parser registry routing", () => {
  it("routes each broker's file to its own parser", () => {
    const angel = detectParser(buildContext("angelone-tradebook.csv", Buffer.from(ANGEL_TRADEBOOK)));
    expect(angel?.sourceId).toBe("angelone");
    const upstox = detectParser(buildContext("upstox-pnl.csv", Buffer.from(UPSTOX_PNL)));
    expect(upstox?.sourceId).toBe("upstox");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Upstox's REAL report layouts (VERIFIED 2026-08-20 against three real exports
// in tests/fixtures/private/). All three carried ZERO data rows, so the column
// map below is verified and the data rows here are synthetic.
//
// Two things about these files defeat naive detection, and both are reproduced
// exactly: the filenames name no broker at all (trade_…, realizedPnL_…,
// ledger_…), and the only occurrence of "Upstox" above the header is the legal
// entity banner in A1. Reading only the header row scored 0 on both reports,
// which then fell to the generic mapper — and it picked a label row out of the
// preamble as the header.
// ─────────────────────────────────────────────────────────────────────────────

const UPSTOX_BANNER: unknown[][] = [
  ["UPSTOX SECURITIES PRIVATE LIMITED"],
  ["(Formerly EPX Uptech Private Limited)"],
  ["Dealing Office: 30th Floor, Sunshine Tower, Senapati Bapat Marg, Dadar (W), Mumbai 400013"],
  [""],
  ["UCC", "TEST0000"],
  ["Name", "TEST CLIENT"],
  ["PAN", "AAAAA0000A"],
];
const UPSTOX_FOOTER: unknown[][] = [
  ["From 19-Jul-2025, our Broking operations were transitioned from RKSV Commodities India Pvt. Ltd. to Upstox Securities Pvt. Ltd."],
];

const xlsxBuf = (matrix: unknown[][], sheet: string): Buffer => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), sheet);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};

/** Sheet "TRADE" — header on row index 10, one F&O row among the equity rows. */
const UPSTOX_TRADE_MATRIX: unknown[][] = [
  ...UPSTOX_BANNER,
  ["Report Time Period", "13-08-2026 To 20-08-2026"],
  ["Generated On", "2026-08-20 00:17:22"],
  [""],
  ["Date", "Company", "Amount", "Exchange", "Segment", "Scrip Code", "Instrument Type", "Strike Price", "Expiry", "Trade Num", "Trade Time", "Side", "Quantity", "Price"],
  ["13-08-2026", "ACME", "1000", "NSE", "EQ", "500001", "EQ", "", "", "T1", "09:20:15", "BUY", "10", "100"],
  ["14-08-2026", "ACME", "1050", "NSE", "EQ", "500001", "EQ", "", "", "T2", "14:05:00", "SELL", "10", "105"],
  ["13-08-2026", "NIFTY", "1837500", "NSE", "FO", "", "FUTIDX", "0", "28-08-2026", "T3", "10:31:00", "BUY", "75", "24500"],
  [""],
  ...UPSTOX_FOOTER,
];

/** Sheet "REALIZED_PNL" — header on row index 21, under three summary blocks. */
const UPSTOX_PNL_MATRIX: unknown[][] = [
  ...UPSTOX_BANNER,
  ["Segment", "EQ"],
  ["Report Time Period", "13-08-2026 To 20-08-2026"],
  ["Generated On", "2026-08-20 00:16:13"],
  [""],
  ["P&L Summary"],
  ["Description", "Amount"],
  ["Gross P&L", "0"],
  ["Net P&L", "0"],
  [""],
  ["Charges"],
  ["Description", "Amount"],
  ["TOTAL", "0"],
  [""],
  ["Realised P&L Details"],
  ["Scrip Name ", "Scrip Code", "Symbol", "ISIN", "Scrip Opt", "Qty", "Buy Date", "Buy Rate", "Buy Amt", "Sell Date", "Sell Rate", "Sell Amt", "Days", "Total PL", "Short Term", "Long Term", "Speculation", "Turn Over"],
  ["ACME LIMITED", "500001", "ACME", "INE000000001", "EQ", "10", "13-08-2026", "100", "1000", "14-08-2026", "105", "1050", "1", "50", "50", "0", "0", "2050"],
  ["ZETA LIMITED", "500002", "ZETA", "INE000000002", "EQ", "5", "15-08-2026", "200", "1000", "15-08-2026", "190", "950", "0", "-50", "0", "0", "-50", "1950"],
  [""],
  ...UPSTOX_FOOTER,
];

/** Sheet "LEDGER_V3" — a banner and a wallet line, and NO column header at all. */
const UPSTOX_LEDGER_MATRIX: unknown[][] = [
  ...UPSTOX_BANNER,
  ["Wallet", "TRADING"],
  [""],
  ...UPSTOX_FOOTER,
];

const UPSTOX_TRADE_FILE = "trade_20260813_20260820_TEST0000.xlsx";
const UPSTOX_PNL_FILE = "realizedPnL_EQ_13-08-2026_To_20-08-2026_TEST0000.xlsx";
const UPSTOX_LEDGER_FILE = "ledger_13-08-2026_To_20-08-2026_TEST0000.xlsx";

const upstoxTrade = () => buildContext(UPSTOX_TRADE_FILE, xlsxBuf(UPSTOX_TRADE_MATRIX, "TRADE"));
const upstoxPnl = () => buildContext(UPSTOX_PNL_FILE, xlsxBuf(UPSTOX_PNL_MATRIX, "REALIZED_PNL"));
const upstoxLedger = () => buildContext(UPSTOX_LEDGER_FILE, xlsxBuf(UPSTOX_LEDGER_MATRIX, "LEDGER_V3"));

describe("Upstox real report layouts", () => {
  it("claims both reports on the A1 banner, though neither the filename nor the header names the broker", () => {
    expect(UPSTOX_TRADE_FILE).not.toMatch(/upstox|rksv/i);
    expect(UPSTOX_PNL_FILE).not.toMatch(/upstox|rksv/i);
    expect(detectUpstox(upstoxTrade())).toBeGreaterThanOrEqual(0.7);
    expect(detectUpstox(upstoxPnl())).toBeGreaterThanOrEqual(0.7);
  });

  it("still refuses a file that names no broker, and another broker's file", () => {
    const noName = xlsxBuf(
      [
        ["Some Broking Private Limited"],
        ["UCC", "TEST0000"],
        [""],
        ["Date", "Company", "Exchange", "Side", "Quantity", "Price"],
        ["13-08-2026", "ACME", "NSE", "BUY", "10", "100"],
      ],
      "Sheet1",
    );
    expect(detectUpstox(buildContext("export_20260820.xlsx", noName))).toBe(0);
    expect(detectAngelOne(buildContext("export_20260820.xlsx", noName))).toBe(0);
    expect(detectUpstox(buildContext("angelone-tradebook.csv", Buffer.from(ANGEL_TRADEBOOK)))).toBe(0);
  });

  it("detectAngelOne scores 0 on both Upstox reports", () => {
    expect(detectAngelOne(upstoxTrade())).toBe(0);
    expect(detectAngelOne(upstoxPnl())).toBe(0);
  });

  it("the ledger carries no header row at all, so nobody claims it", () => {
    expect(detectUpstox(upstoxLedger())).toBe(0);
    expect(detectAngelOne(upstoxLedger())).toBe(0);
  });

  it("parses the trade report into round-trips, timed from its own Trade Time column", () => {
    const out = parseUpstox(upstoxTrade());
    expect(out.broker).toBe("upstox");
    expect(out.format).toBe("tradebook");
    expect(out.trades).toHaveLength(2);

    const acme = out.trades.find((t) => t.tradingsymbol === "ACME")!;
    expect(acme.buyQty).toBe(10);
    expect(acme.avgBuyPrice).toBe(100);
    expect(acme.sellQty).toBe(10);
    expect(acme.avgSellPrice).toBe(105);
    expect(acme.grossPnl).toBe(50);
    expect(acme.exchangeHint).toBe("NSE");
    expect(acme.buyDate).toBe("13-08-2026");
    expect(acme.sellDate).toBe("14-08-2026");
    // The date cell carries no clock at all — the time is a separate column.
    expect(acme.entryTime).toBe("09:20");
    expect(acme.exitTime).toBe("14:05");
    expect(acme.executions?.map((e) => e.time)).toEqual(["09:20", "14:05"]);
    expect(acme.importNotes ?? null).toBeNull();
  });

  it("flags an F&O row instead of inventing a tradingsymbol for it", () => {
    const nifty = parseUpstox(upstoxTrade()).trades.find((t) => t.tradingsymbol === "NIFTY")!;
    expect(nifty.tradingsymbol).toBe("NIFTY"); // Company verbatim — no grammar invented
    expect(nifty.importNotes?.[0]).toMatch(/F&O row: instrument type FUTIDX/);
    expect(nifty.importNotes?.[0]).toMatch(/expiry 28-08-2026/);
    expect(nifty.importNotes?.[0]).toMatch(/unverified/i);
  });

  it("maps both legs' dates, amounts and P&L out of the realised-P&L report", () => {
    const out = parseUpstox(upstoxPnl());
    expect(out.format).toBe("pnl-report");
    expect(out.trades).toHaveLength(2);

    const acme = out.trades.find((t) => t.tradingsymbol === "ACME")!;
    // "Symbol" beat "Scrip Name" ("ACME LIMITED") for the tradingsymbol.
    expect(acme.isin).toBe("INE000000001");
    expect(acme.buyDate).toBe("13-08-2026");
    expect(acme.sellDate).toBe("14-08-2026");
    expect(acme.buyQty).toBe(10);
    expect(acme.buyValue).toBe(1000); // Buy Amt
    expect(acme.sellValue).toBe(1050); // Sell Amt
    expect(acme.avgBuyPrice).toBe(100); // Buy Rate
    expect(acme.avgSellPrice).toBe(105); // Sell Rate
    expect(acme.grossPnl).toBe(50); // Total PL
  });

  it("derives the product from the tax-bucket columns, and says that it derived it", () => {
    const out = parseUpstox(upstoxPnl());
    const acme = out.trades.find((t) => t.tradingsymbol === "ACME")!;
    const zeta = out.trades.find((t) => t.tradingsymbol === "ZETA")!;

    expect(acme.productHint).toBe("delivery"); // Short Term ≠ 0
    expect(zeta.productHint).toBe("intraday"); // Speculation ≠ 0
    expect(zeta.grossPnl).toBe(-50);
    for (const t of [acme, zeta]) {
      expect(t.productDerived).toBe(true);
      expect(t.importNotes?.[0]).toMatch(/Speculation \/ Short Term \/ Long Term/);
    }
  });
});

// The real exports are gitignored (they carry a real UCC and PAN), so this
// block runs only on a machine that has them. It proves the one thing the
// synthetic fixtures above cannot: that they still mirror the real files.
const PRIVATE_DIR = path.join(process.cwd(), "tests", "fixtures", "private");
const REAL_UPSTOX = {
  trade: path.join(PRIVATE_DIR, "Upstox trade report (schema-only).xlsx"),
  pnl: path.join(PRIVATE_DIR, "Upstox realizedPnL (schema-only).xlsx"),
  ledger: path.join(PRIVATE_DIR, "Upstox ledger (schema-only).xlsx"),
};
const haveRealUpstox = Object.values(REAL_UPSTOX).every((p) => fs.existsSync(p));

describe.skipIf(!haveRealUpstox)("the REAL Upstox exports (private, zero data rows)", () => {
  // The stored copies were RENAMED by hand for readability ("Upstox trade
  // report (schema-only).xlsx"), which would hand the detector the broker name
  // for free — exactly the evidence under test. So each real workbook is fed in
  // under the filename Upstox itself emits, which names no broker.
  const real = (p: string, asName: string) => buildContext(asName, fs.readFileSync(p));
  const trade = () => real(REAL_UPSTOX.trade, UPSTOX_TRADE_FILE);
  const pnl = () => real(REAL_UPSTOX.pnl, UPSTOX_PNL_FILE);
  const ledger = () => real(REAL_UPSTOX.ledger, UPSTOX_LEDGER_FILE);

  it("claims both reports on content alone, and leaves the ledger alone", () => {
    expect(detectUpstox(trade())).toBeGreaterThanOrEqual(0.7);
    expect(detectUpstox(pnl())).toBeGreaterThanOrEqual(0.7);
    expect(detectUpstox(ledger())).toBe(0);
    expect(detectAngelOne(trade())).toBe(0);
    expect(detectAngelOne(pnl())).toBe(0);
    expect(detectAngelOne(ledger())).toBe(0);
  });

  it("parses to zero trades without throwing (the account had no trades)", () => {
    expect(parseUpstox(trade()).format).toBe("tradebook");
    expect(parseUpstox(trade()).trades).toHaveLength(0);
    expect(parseUpstox(pnl()).format).toBe("pnl-report");
    expect(parseUpstox(pnl()).trades).toHaveLength(0);
  });
});
