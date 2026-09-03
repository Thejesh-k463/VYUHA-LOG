/**
 * Dhan Realised P&L Report (`.xls`) — the golden book: per-segment charges,
 * every head broken out, plus per-segment detail blocks. Synthetic workbook in
 * the verified layout (2026-09-04); the owner's real files replayed in place
 * when present, including the MUTUAL STAND-DOWN matrix across every Dhan
 * detector and every Dhan file type.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildContext, importSources, rankParsers } from "@/lib/import/detect";
import { IMPORT_HELP_CARDS } from "@/lib/domain/import-help-content";
import { classify } from "@/lib/engine/classify";
import { detectDhanCsv } from "@/lib/import/parsers/dhan-csv";
import { detectDhanGtr } from "@/lib/import/parsers/dhan-gtr";
import { detectDhanDividend, detectDhanLedgerFile } from "@/lib/import/parsers/dhan-ledger";
import { detectDhanRealisedPnl, parseDhanRealisedPnl, parseTextMoney } from "@/lib/import/parsers/dhan-realised-pnl";
import { ownerContext, ownerFile, ownerFiles } from "./helpers/owner-broker-files";

const SUMMARY_HEADER = ["Segment", "", "", "", "Buy Value", "Sell Value", "Gross P&L", "Brokerage", "Exch. Charges", "SEBI Fees", "GST", "STT", "Stamp Duty", "Other Charges", "Total Charges", "Net P&L"];
const DETAIL_HEADER = ["Sr.", "Security Name", "", "", "ISIN", "Qty.", "Avg. Buy Price", "Buy Value", "Avg. Sell Price", "Sell Value", "Realised P&L", "Realised P&L%"];
const DASH = " -   ";

function workbook(opts: { marker?: boolean; sheet?: string } = {}): Buffer {
  const aoa: string[][] = [
    ["", "", "Realised Profit and Loss Report", "", "", "", "", "", "", "", "", "", "Name"],
    ["", "", "", "", "", "", "", "", "", "", "", "", "UCC"],
    ["", "", "", "", "", "", "", "", "", "", "", "", "Email ID"],
    [],
    ["", "", "", "", "", "", "", "", "", "", "", "", "Realised Profit and Loss Report"],
    [],
    [],
    SUMMARY_HEADER,
    ["Equity", "", "", "", " 1,00,000.00 ", " 1,01,000.00 ", " 1,000.00 ", " 20.00 ", " 3.50 ", " 0.10 ", " 4.23 ", " 100.00 ", " 15.00 ", "0.05 ", "142.88", "857.12 "],
    ["Futures and Options", "", "", "", " 8,840.00 ", " 5,512.00 ", "-3,328.00 ", " 40.00 ", " 1.20 ", " 0.01 ", " 7.42 ", " 3.00 ", " 0.00 ", "0.00 ", "51.63", "-3,379.63 "],
    ["Commodities", "", "", "", DASH, DASH, DASH, DASH, DASH, DASH, DASH, DASH, DASH, "0.00 ", "0.00", DASH],
    ["Currency", "", "", "", " 500.00 ", " 510.00 ", " 10.00 ", " 1.00 ", " 0.10 ", " 0.01 ", " 0.20 ", " 0.00 ", " 0.00 ", "0.00 ", "1.31", "8.69 "],
    [],
    ["Equity Segment"],
    DETAIL_HEADER,
    ["1", "Alpha Test Cables", "", "", "INE000A01001", "1000", " 100.00 ", " 1,00,000.00 ", " 101.00 ", " 1,01,000.00 ", " 1,000.00 ", " 1.00 ", "", "", "", "Generated on 03-09-2026"],
    [],
    ["F&O Segment"],
    DETAIL_HEADER,
    ["1", "OPT NIFTY 29 Sep 2026 24500 CE ", "", "", "-", "5200", " 1.70 ", " 8,840.00 ", " 1.06 ", " 5,512.00 ", "-3,328.00 ", "-37.65 "],
    [],
    ["Commodities Segment"],
    DETAIL_HEADER,
    [],
    ["Currency Segment"],
    DETAIL_HEADER,
    ["1", "USDINR 29 Sep 2026", "", "", "-", "1", " 500.00 ", " 500.00 ", " 510.00 ", " 510.00 ", " 10.00 ", " 2.00 "],
    [],
    ["This is a system generated report and thus does not require signature."],
    [],
    ["Notes:"],
    ["1. The calculation of P&L is based on the FIFO (First In First Out) method.  "],
    ...(opts.marker === false ? [] : [["Raise Securities Private Limited (formerly known as Moneylicious Securities Private Limited)"]]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), opts.sheet ?? "Realised P&L Report");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xls" }) as Buffer);
}

describe("parseTextMoney — Dhan writes money as text", () => {
  it("strips thousands separators and the trailing space; a dash is blank", () => {
    expect(parseTextMoney(" 1,23,456.78 ")).toBe(123456.78);
    expect(parseTextMoney(" 67,600,907.47 ")).toBe(67600907.47);
    expect(parseTextMoney("-101,171.29 ")).toBe(-101171.29);
    expect(parseTextMoney("-")).toBe(0);
    expect(parseTextMoney(" -   ")).toBe(0);
    expect(parseTextMoney("")).toBe(0);
    expect(parseTextMoney(undefined)).toBe(0);
    expect(parseTextMoney("(1,234.00)")).toBe(-1234);
    expect(parseTextMoney("abc")).toBe(0);
  });
});

describe("detection", () => {
  it("is registered, and claims the report at ≥ 0.9 under a neutral filename", () => {
    expect(importSources().map((s) => s.sourceId)).toContain("dhan-realised-pnl");
    const c = buildContext("export.xls", workbook());
    expect(detectDhanRealisedPnl(c)).toBeGreaterThanOrEqual(0.9);
    expect(rankParsers(c)[0].sourceId).toBe("dhan-realised-pnl");
  });

  it("needs the broker's name in the content — the summary header alone is not a claim", () => {
    expect(detectDhanRealisedPnl(buildContext("export.xls", workbook({ marker: false, sheet: "Sheet1" })))).toBe(0);
    // …but the trading name in a sheet name counts, like the P&L workbook's Dhan_P&L.
    expect(detectDhanRealisedPnl(buildContext("export.xls", workbook({ marker: false, sheet: "Dhan Realised" })))).toBeGreaterThanOrEqual(0.9);
  });

  it("the other Dhan detectors score 0 on it", () => {
    const c = buildContext("export.xls", workbook());
    expect(detectDhanCsv(c)).toBe(0);
    expect(detectDhanGtr(c)).toBe(0);
    expect(detectDhanLedgerFile(c)).toBe(0);
    expect(detectDhanDividend(c)).toBe(0);
  });

  it("the help card says: either the Global Transaction Report or this, never both", () => {
    const dhan = IMPORT_HELP_CARDS.find((c) => c.id === "dhan")!;
    expect(dhan.formats.map((f) => f.sourceId)).toContain("dhan-realised-pnl");
    expect(dhan.steps.join(" ")).toMatch(/EITHER the Global Transaction Report OR the Realised P&L report/);
    expect(dhan.steps.join(" ")).toMatch(/never both/);
  });
});

describe("parse", () => {
  const out = parseDhanRealisedPnl(buildContext("export.xls", workbook()));

  it("reads the segment summary into reported — per segment and in total", () => {
    expect(out.reported?.["equity.grossPnl"]).toBe(1000);
    expect(out.reported?.["equity.brokerage"]).toBe(20);
    expect(out.reported?.["equity.exchangeTxn"]).toBe(3.5);
    expect(out.reported?.["equity.sebi"]).toBe(0.1);
    expect(out.reported?.["equity.gst"]).toBe(4.23);
    expect(out.reported?.["equity.stt"]).toBe(100);
    expect(out.reported?.["equity.stamp"]).toBe(15);
    expect(out.reported?.["equity.otherCharges"]).toBe(0.05);
    expect(out.reported?.["equity.totalCharges"]).toBe(142.88);
    expect(out.reported?.["equity.netPnl"]).toBe(857.12);
    expect(out.reported?.["fno.netPnl"]).toBe(-3379.63);
    expect(out.reported?.["commodity.netPnl"]).toBe(0);
    expect(out.reported?.["currency.totalCharges"]).toBe(1.31);
    expect(out.reported?.grossPnl).toBe(-2318);
    expect(out.reported?.brokerage).toBe(61);
    expect(out.reported?.totalCharges).toBe(195.82);
    expect(out.reported?.netPnl).toBe(-2513.82);
  });

  it("emits closed lots per detail block, segment-tagged the way dhan-csv is", () => {
    expect(out.sourceRows).toBe(3);
    expect(out.trades).toHaveLength(2);
    const eq = out.trades[0];
    expect(eq.tradingsymbol).toBe("Alpha Test Cables");
    expect(eq.isin).toBe("INE000A01001");
    expect(eq.buyQty).toBe(1000);
    expect(eq.sellQty).toBe(1000);
    expect(eq.avgBuyPrice).toBe(100);
    expect(eq.buyValue).toBe(100000);
    expect(eq.avgSellPrice).toBe(101);
    expect(eq.sellValue).toBe(101000);
    expect(eq.grossPnl).toBe(1000);
    expect(eq.productHint).toBeNull();
    expect(eq.buyDate).toBeNull();
    expect(eq.sellDate).toBeNull();
    expect(classify({ tradingsymbol: eq.tradingsymbol, broker: "dhan" }).segment).toBe("eq_delivery");
    const fo = out.trades[1];
    expect(fo.tradingsymbol).toBe("OPT NIFTY 29 Sep 2026 24500 CE");
    expect(fo.isin).toBeNull();
    expect(fo.grossPnl).toBe(-3328);
    expect(classify({ tradingsymbol: fo.tradingsymbol, broker: "dhan" }).segment).toBe("index_option");
  });

  it("skips Currency rows with a warning, and carries the either/or rule", () => {
    const w = out.warnings.join(" ");
    expect(w).toMatch(/1 Currency-segment row skipped/);
    expect(w).toMatch(/EITHER the Global Transaction Report OR this report/);
    expect(w).toMatch(/no per-trade dates and no product column/);
  });
});

// ── The owner's real files: routing, values, and the mutual stand-down matrix ─
const REAL_REALISED = ownerFiles(/^realized_pnl-report.*\.xls$/);
const REAL_PNL = ownerFiles(/^Dhan_P&L_.*\.xlsx$/);
const REAL_LEDGER = ownerFiles(/^Dhan_Ledger_.*\.csv$/);
const REAL_DIVIDEND = ownerFile(/^Dhan_Dividend_.*\.csv$/);
const GTR_FIXTURE = path.join(process.cwd(), "tests", "fixtures", "dhan-gtr.csv");
const haveAll = REAL_REALISED.length >= 2 && REAL_PNL.length >= 2 && REAL_LEDGER.length >= 2 && !!REAL_DIVIDEND;

describe.skipIf(!haveAll)("the owner's real Dhan Realised P&L reports, read in place", () => {
  for (const file of REAL_REALISED) {
    it(`${path.basename(file)}: routes at ≥ 0.9, summary ties out, blocks found by text`, () => {
      const { filename, bytes } = ownerContext(file);
      const ranked = rankParsers(buildContext(filename, bytes));
      expect(ranked[0].sourceId).toBe("dhan-realised-pnl");
      expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.9);
      const out = parseDhanRealisedPnl(buildContext(filename, bytes));
      expect(out.trades.length).toBeGreaterThan(50);
      expect(out.trades.some((t) => /^OPT /.test(t.tradingsymbol))).toBe(true);
      expect(out.trades.filter((t) => t.isin).length).toBeGreaterThan(10);
      for (const seg of ["equity", "fno"]) {
        const r = out.reported!;
        // Gross − Total Charges = Net, per segment — within the broker's own
        // rounding (measured 2026-09-04: equity 3–4 paise on both real files;
        // F&O 1 paise on one account, 14 paise on the other). These are Dhan's
        // stated figures, read as-is; the tolerance describes them, not us.
        expect(Math.abs(r[`${seg}.grossPnl`] - r[`${seg}.totalCharges`] - r[`${seg}.netPnl`]), seg).toBeLessThan(0.2);
        // Every charge head sums to the segment's Total Charges — again within
        // the broker's rounding of the displayed heads (measured 2026-09-04:
        // 3 paise on equity, 7 paise on F&O).
        const heads = ["brokerage", "exchangeTxn", "sebi", "gst", "stt", "stamp", "otherCharges"].reduce((s, k) => s + r[`${seg}.${k}`], 0);
        expect(Math.abs(heads - r[`${seg}.totalCharges`]), seg).toBeLessThan(0.1);
      }
    });
  }

  it("the smaller account's stated segment figures", () => {
    const small = REAL_REALISED.find((f) => /ACCOUNT-2/i.test(f))!;
    const out = parseDhanRealisedPnl(buildContext("export.xls", fs.readFileSync(small)));
    expect(out.reported?.["equity.netPnl"]).toBe(-149482.29);
    expect(out.reported?.["equity.totalCharges"]).toBe(48311.04);
    expect(out.reported?.["fno.totalCharges"]).toBe(32569.85);
    expect(out.reported?.["fno.brokerage"]).toBe(17880);
    expect(out.reported?.["commodity.netPnl"]).toBe(0);
    expect(out.trades.filter((t) => t.importNotes?.[0]?.includes("Equity Segment"))).toHaveLength(94);
  });
});

describe.skipIf(!haveAll)("mutual stand-down — every Dhan detector on every Dhan file type", () => {
  const DETECTORS = {
    "dhan-gtr": detectDhanGtr,
    "dhan-csv": detectDhanCsv,
    "dhan-realised-pnl": detectDhanRealisedPnl,
    "dhan-ledger": detectDhanLedgerFile,
    "dhan-dividend": detectDhanDividend,
  } as const;
  const FILES: { file: string; owner: keyof typeof DETECTORS }[] = [
    { file: GTR_FIXTURE, owner: "dhan-gtr" },
    ...REAL_PNL.map((file) => ({ file, owner: "dhan-csv" as const })),
    ...REAL_REALISED.map((file) => ({ file, owner: "dhan-realised-pnl" as const })),
    ...REAL_LEDGER.map((file) => ({ file, owner: "dhan-ledger" as const })),
    { file: REAL_DIVIDEND!, owner: "dhan-dividend" },
  ];
  for (const f of FILES) {
    for (const [id, fn] of Object.entries(DETECTORS)) {
      const want = id === f.owner ? "≥ 0.9" : "0";
      it(`${id} on ${path.basename(f.file).slice(0, 24)} → ${want}`, () => {
        // Under the REAL filename too: "dhan" in the name must not resurrect a claim.
        for (const filename of ["export" + path.extname(f.file), path.basename(f.file)]) {
          const score = fn(buildContext(filename, fs.readFileSync(f.file)));
          if (id === f.owner) expect(score, filename).toBeGreaterThanOrEqual(0.9);
          else expect(score, filename).toBe(0);
        }
      });
    }
  }
});
