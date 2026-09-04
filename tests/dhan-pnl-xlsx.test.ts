/**
 * Dhan P&L — the `.xlsx` twin of the CSV (verified on two real exports,
 * 2026-09-04): sheet `Dhan_P&L`, the identical twelve-column table, and the
 * footer as four label/value ROWS instead of the CSV's one eight-cell line.
 * The sheet NAME is the Dhan marker, so the same table under `Sheet1` is
 * never claimed.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildContext, rankParsers } from "@/lib/import/detect";
import { classify } from "@/lib/engine/classify";
import { detectDhanCsv, parseDhanCsv } from "@/lib/import/parsers/dhan-csv";
import { detectDhanGtr } from "@/lib/import/parsers/dhan-gtr";
import { detectDhanRealisedPnl } from "@/lib/import/parsers/dhan-realised-pnl";
import { detectDhanDividend, detectDhanLedgerFile } from "@/lib/import/parsers/dhan-ledger";
import { ownerContext, ownerFiles } from "./helpers/owner-broker-files";

const HEADER = ["Scrip Name", "Buy Qty.", "Avg. Buy Price", "Buy Value", "Sell Qty.", "Avg. Sell Price", "Sell Value", "Closing Price", "Realised P&L", "Realised P&L %", "Unrealised P&L", "Unrealised P&L %"];
const ROWS = [
  ["Alpha Test Industries", "10", "100.00", "1000.00", "10", "110.00", "1100.00", "0.00", "100.00", "10.00", "0.00", "0.00"],
  ["Beta Test Bank", "5", "50.00", "250.00", "0", "0.00", "0.00", "55.00", "0.00", "0.00", "25.00", "10.00"],
  ["OPT NIFTY 29 Sep 2026 24500 CE", "500", "1.70", "850.00", "500", "1.06", "530.00", "0.00", "-320.00", "-37.65", "0.00", "0.00"],
  ["FUT RELIANCE 29 Sep 2026", "100", "50.00", "5000.00", "100", "51.00", "5100.00", "0.00", "100.00", "2.00", "0.00", "0.00"],
];

function workbook(sheet: string, opts: { footer?: boolean; title?: boolean } = {}): Buffer {
  const aoa: string[][] = [
    ["", "", "", "", "", "", "Name"],
    ["", opts.title === false ? "" : "PnL report | From 01-04-2026 to 03-09-2026", "", "", "", "", "UCC"],
    ["", "", "", "", "", "", "Email"],
    ["", "", "", "", "", "", "Mobile"],
    [],
    HEADER,
    ...ROWS,
    [],
    ...(opts.footer === false ? [] : [["Net P&L", "-220.00"], ["Brokerage", "40.00"], ["Gross P&L", "-120.00"], ["Total Charges", "100.00"]]),
    [],
    ["NOTE : This sheet was downloaded at 9/3/2026 11:35 PM"],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

const CSV = [
  "PnL report,From 01-04-2026 to 03-09-2026",
  "Name,TESTUSER",
  "",
  HEADER.join(","),
  ...ROWS.map((r) => r.map((c) => `"${c}"`).join(",")),
  "",
  "Net P&L,-220.00,Brokerage,40.00,Gross P&L,-120.00,Total Charges,100.00",
  "",
  "NOTE : This sheet was downloaded at 9/3/2026 11:35 PM",
].join("\n");

describe("detection", () => {
  it("claims the Dhan_P&L sheet at ≥ 0.9 under a neutral filename", () => {
    const c = buildContext("export.xlsx", workbook("Dhan_P&L"));
    expect(detectDhanCsv(c)).toBeGreaterThanOrEqual(0.9);
    expect(rankParsers(c)[0].sourceId).toBe("dhan-csv");
  });

  it("does not claim the same table when nothing in the workbook names Dhan", () => {
    expect(detectDhanCsv(buildContext("export.xlsx", workbook("Sheet1")))).toBe(0);
    expect(detectDhanCsv(buildContext("pnl.xlsx", workbook("Sheet1", { title: false })))).toBe(0);
  });

  it("the same-container sibling stands down on the WORKBOOK", () => {
    // CONTAINER RULE: `buildContext` decodes `ctx.text` for `.csv`/`.txt` only.
    // `detectDhanGtr`/`detectDhanLedgerFile`/`detectDhanDividend` all open
    // `if (!text) return 0`, so against this `.xlsx` they scored 0 by
    // EXTENSION and asserted nothing about the workbook's content. Only
    // `detectDhanRealisedPnl` reads the binary container, so only it is
    // asserted here; the three text detectors are asserted against the
    // identical P&L content in its CSV container below.
    const c = buildContext("export.xlsx", workbook("Dhan_P&L"));
    expect(detectDhanRealisedPnl(c)).toBe(0);
  });

  it("the text-container siblings stand down on the same P&L content as CSV", () => {
    // Same table, same footer, same title line — a container these three can
    // actually read, so the refusal is decided by the content.
    const c = buildContext("export.csv", Buffer.from(CSV));
    expect(detectDhanCsv(c)).toBeGreaterThanOrEqual(0.4); // the owner still claims it
    expect(detectDhanGtr(c)).toBe(0);
    expect(detectDhanLedgerFile(c)).toBe(0);
    expect(detectDhanDividend(c)).toBe(0);
  });
});

describe("parse — parity with the CSV path", () => {
  it("emits the same trades as the CSV, footer lands in reported", () => {
    const x = parseDhanCsv(buildContext("export.xlsx", workbook("Dhan_P&L")));
    const c = parseDhanCsv(buildContext("export.csv", Buffer.from(CSV)));
    expect(x.trades).toHaveLength(4);
    const strip = (t: (typeof x.trades)[number]) => ({ ...t, sourceFile: null });
    expect(x.trades.map(strip)).toEqual(c.trades.map(strip));
    expect(x.reported).toEqual({ netPnl: -220, brokerage: 40, grossPnl: -120, totalCharges: 100 });
    expect(x.reported).toEqual(c.reported);
    expect(x.format).toBe("pnl");
  });

  it("F&O rows keep their OPT/FUT names, so the classifier gives them the F&O segment exactly as it does for the CSV", () => {
    const x = parseDhanCsv(buildContext("export.xlsx", workbook("Dhan_P&L")));
    const opt = x.trades.find((t) => t.tradingsymbol.startsWith("OPT "))!;
    const fut = x.trades.find((t) => t.tradingsymbol.startsWith("FUT "))!;
    expect(classify({ tradingsymbol: opt.tradingsymbol, broker: "dhan" }).segment).toBe("index_option");
    expect(classify({ tradingsymbol: fut.tradingsymbol, broker: "dhan" }).segment).toBe("future");
    expect(classify({ tradingsymbol: "Alpha Test Industries", broker: "dhan" }).segment).toBe("eq_delivery");
    expect(opt.productHint).toBeNull(); // no product column in either shape
  });

  it("a footer-less export still parses, with reported absent rather than zeroed", () => {
    const x = parseDhanCsv(buildContext("export.xlsx", workbook("Dhan_P&L", { footer: false })));
    expect(x.trades).toHaveLength(4);
    expect(x.reported).toBeUndefined();
  });
});

const REAL = ownerFiles(/^Dhan_P&L_.*\.xlsx$/);
describe.skipIf(REAL.length < 2)("the owner's real Dhan P&L workbooks, read in place", () => {
  for (const file of REAL) {
    it(`${path.basename(file).slice(0, 8)}…: routes to dhan-csv, footer read, F&O rows present`, () => {
      const { filename, bytes } = ownerContext(file);
      const ranked = rankParsers(buildContext(filename, bytes));
      expect(ranked[0].sourceId).toBe("dhan-csv");
      expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.9);
      const out = parseDhanCsv(buildContext(filename, bytes));
      expect(out.trades.length).toBeGreaterThan(50);
      expect(out.trades.some((t) => /^OPT /.test(t.tradingsymbol))).toBe(true);
      for (const k of ["netPnl", "brokerage", "grossPnl", "totalCharges"]) expect(out.reported?.[k], k).toBeTypeOf("number");
      // Net = Gross − Total Charges, to the paisa — the footer is internally consistent.
      expect(Math.abs(out.reported!.grossPnl - out.reported!.totalCharges - out.reported!.netPnl)).toBeLessThan(0.02);
    });
  }

  it("the smaller account's footer is the stated one", () => {
    const small = REAL.find((f) => /ACCOUNT-2/i.test(f));
    if (!small) return;
    const out = parseDhanCsv(buildContext("export.xlsx", fs.readFileSync(small)));
    expect(out.reported).toEqual({ netPnl: -233217.15, brokerage: 24610.02, grossPnl: -152158.28, totalCharges: 81058.88 });
  });
});
