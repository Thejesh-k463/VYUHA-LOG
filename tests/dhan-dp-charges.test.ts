/**
 * Dhan DP charges (`dp-charges.xls`) — the depository fees no other Dhan
 * export states.
 *
 * Fixtures are REDACTED copies of the owner's two real exports, produced by
 * `scripts/fixtures/redact-broker-export.mjs` (which refuses if detection or
 * parsing differs between the original and the copy). The owner's files
 * themselves are read in place, never copied.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { ParseContext } from "@/lib/import/types";
import {
  chargeCellsCoveredByMerge,
  detectDhanDpCharges,
  dpWindow,
  findDpHeader,
  parseDhanDpCharges,
  parseDhanDpChargesWorkbook,
} from "@/lib/import/parsers/dhan-dp-charges";
import { detectPdf } from "@/lib/import/parsers/pdf";
import { detectDhanRealisedPnl } from "@/lib/import/parsers/dhan-realised-pnl";
import { OWNER_DP_CHARGES, ownerContext, ownerFiles } from "./helpers/owner-broker-files";

const FIXTURE = path.join(__dirname, "fixtures/redacted/dhan-dp-charges-2026-04-01_2026-09-03.xls");
const ctxOf = (file: string, name = path.basename(file)): ParseContext => ({
  filename: name,
  buffer: fs.readFileSync(file),
});

describe("detection", () => {
  it("claims the redacted export on format alone, under a NEUTRAL filename", () => {
    // The named exception to the broker-name rule: this file names no broker
    // anywhere, so sheet + title + header carry the whole 0.9.
    expect(detectDhanDpCharges(ctxOf(FIXTURE, "export.xls"))).toBeCloseTo(0.9, 10);
  });

  it("adds 0.1 when the filename says dhan", () => {
    expect(detectDhanDpCharges(ctxOf(FIXTURE, "dhan-dp-charges.xls"))).toBeCloseTo(1, 10);
  });

  it("refuses a text container outright — this format is never a CSV", () => {
    expect(detectDhanDpCharges({ filename: "dp-charges.csv", text: "Sr.,Date,ISIN,Security Name,Quantity,Buy/Sell,Type of Transaction,Charges" })).toBe(0);
  });

  it("refuses a workbook with the right header but no DP Charges title", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Some other report"],
      ["Sr.", "Date", "ISIN", "Security Name", "Quantity", "Buy/Sell", "Type of Transaction", "Charges"],
      ["1", "23-Jul-2026", "INE062A01020", "A LIMITED", "1", "Sell", "Other Fees", "12.5"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "DP Charges");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectDhanDpCharges({ filename: "x.xlsx", buffer })).toBe(0);
  });

  it("stands down on its Dhan siblings, and they on it", () => {
    const ctx = ctxOf(FIXTURE);
    expect(detectDhanRealisedPnl(ctx)).toBe(0);
    // A PDF detector must never see a workbook.
    expect(detectPdf(ctx)).toBe(0);
  });
});

describe("the redacted export", () => {
  const parsed = parseDhanDpChargesWorkbook(ctxOf(FIXTURE));

  it("reads every printed line", () => {
    expect(parsed.rows).toHaveLength(173);
  });

  it("conserves charges to the paisa against the file's own Total", () => {
    expect(parsed.statedTotal).toBe(2492.5);
    expect(parsed.total).toBe(2492.5);
    expect(parsed.warnings.join(" ")).not.toMatch(/difference of/);
  });

  it("signs every charge NEGATIVE — a fee is money leaving the account", () => {
    expect(parsed.rows.every((r) => r.amount < 0)).toBe(true);
    expect(parsed.rows.every((r) => r.kind === "charge" && !r.unclassified)).toBe(true);
  });

  it("narrates a line with the broker's own words", () => {
    const r = parsed.rows[0]!;
    expect(r.date).toBe("2026-07-23");
    expect(r.narration).toMatch(/^DP charge · Other Fees · .+ · 1$/);
    expect(r.amount).toBe(-12.5);
  });

  it("reads the statement window out of the title cell", () => {
    expect(parsed.from).toBe("2026-04-01");
    expect(parsed.to).toBe("2026-09-03");
  });

  it("emits reference rows keyed by ISIN and dated, conserving the total", () => {
    expect(parsed.reference.length).toBeGreaterThan(0);
    expect(parsed.reference.every((r) => r.scope === "charge")).toBe(true);
    expect(parsed.reference.every((r) => /^INE|^IN\d/.test(r.key))).toBe(true);
    expect(parsed.reference.every((r) => r.asOf && /^\d{4}-\d{2}-\d{2}$/.test(r.asOf))).toBe(true);
    const sum = Math.round(parsed.reference.reduce((s, r) => s + r.figures.charges!, 0) * 100) / 100;
    expect(sum).toBe(2492.5);
  });

  it("aggregates lines that share an ISIN and a date, keeping every fee type", () => {
    const keys = parsed.reference.map((r) => `${r.key}|${r.asOf}`);
    expect(new Set(keys).size).toBe(keys.length);
    const merged = parsed.reference.find((r) => r.figures.charges! > 15);
    expect(merged).toBeTruthy();
    expect(merged!.note).toMatch(/Fees/);
  });

  it("proves no data row lost its Charges cell to a merge", () => {
    const wb = XLSX.read(fs.readFileSync(FIXTURE), { type: "buffer" });
    const ws = wb.Sheets["DP Charges"]!;
    const merges = (ws["!merges"] ?? []) as XLSX.Range[];
    expect(merges.length).toBe(352);
    // Rows 6..178 (0-based 5..177) are the 173 data rows; column 13 is Charges.
    const rowIdxs = Array.from({ length: 173 }, (_, i) => i + 5);
    expect(chargeCellsCoveredByMerge(ws, 13, rowIdxs)).toEqual([]);
    // The one merge that DOES touch column 13 is the title row's.
    expect(merges.filter((m) => m.s.c <= 13 && m.e.c >= 13).map((m) => m.s.r)).toEqual([0]);
  });

  it("finds the header by text, not by row number", () => {
    const wb = XLSX.read(fs.readFileSync(FIXTURE), { type: "buffer" });
    const rows = (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["DP Charges"]!, { header: 1, raw: false, defval: "" }) as unknown[][])
      .map((r) => r.map((c) => String(c ?? "")));
    const found = findDpHeader(rows)!;
    expect(found.at).toBe(4);
    expect(found.cols).toEqual({ sr: 0, date: 1, isin: 2, security: 3, qty: 9, side: 10, type: 11, charges: 13 });
    expect(dpWindow(rows.slice(0, 4))).toEqual({ from: "2026-04-01", to: "2026-09-03" });
  });
});

describe("as an import source", () => {
  const file = parseDhanDpCharges(ctxOf(FIXTURE));

  it("creates no trades and says why", () => {
    expect(file.trades).toEqual([]);
    expect(file.sourceId).toBe("dhan-dp-charges");
    expect(file.broker).toBe("dhan");
    expect(file.format).toBe("ledger");
    expect(file.warnings[0]).toMatch(/not trades/);
    expect(file.warnings[0]).toMatch(/Cash & Ledger/);
  });

  it("reports the total it read and the total the file states", () => {
    expect(file.reported).toEqual({ totalCharges: 2492.5, statedTotalCharges: 2492.5 });
    expect(file.sourceRows).toBe(173);
    expect(file.reference!.length).toBeGreaterThan(0);
  });
});

describe("conservation is checked, not assumed", () => {
  it("warns — and does not adjust — when the lines disagree with the Total", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["DP Charges | From 01-April-2026 to 03-September-2026"],
      ["Sr.", "Date", "ISIN", "Security Name", "Quantity", "Buy/Sell", "Type of Transaction", "Charges"],
      ["1", "23-Jul-2026", "INE062A01020", "A LIMITED", "1", "Sell", "Other Fees", "12.5"],
      ["", "", "", "", "", "", "Total", "99.99"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "DP Charges");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const parsed = parseDhanDpChargesWorkbook({ filename: "dhan-dp.xlsx", buffer });
    expect(parsed.total).toBe(12.5);
    expect(parsed.statedTotal).toBe(99.99);
    expect(parsed.warnings.join(" ")).toMatch(/₹12\.50 but the file's own Total says ₹99\.99/);
  });
});

describe("the owner's real exports", () => {
  const files = ownerFiles(OWNER_DP_CHARGES);
  it("both accounts' DP charge reports conserve their own Total", () => {
    if (files.length === 0) return; // not this machine
    expect(files.length).toBe(2);
    for (const f of files) {
      const { filename, bytes } = ownerContext(f);
      const parsed = parseDhanDpChargesWorkbook({ filename, buffer: bytes });
      expect(parsed.statedTotal).not.toBeNull();
      expect(parsed.total).toBe(parsed.statedTotal);
      expect(parsed.rows.length).toBeGreaterThan(0);
      // Claimed on format alone, under the neutral name the helper gives it.
      expect(detectDhanDpCharges({ filename, buffer: bytes })).toBeCloseTo(0.9, 10);
    }
  });
});

/**
 * The Total row: how it is FOUND, and the two shapes of it that state
 * nothing usable. `r.some(/^total$/)` matched the word anywhere on the row,
 * so a security or a transaction type called "Total" would have been read as
 * the footer and its charge dropped from the sum in silence.
 */
describe("finding the Total row", () => {
  const sheetOf = (rows: unknown[][]): Buffer => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "DP Charges");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  };
  const HEAD = ["Sr.", "Date", "ISIN", "Security Name", "Quantity", "Buy/Sell", "Type of Transaction", "Charges"];
  const TITLE = ["DP Charges | From 01-April-2026 to 03-September-2026"];

  it("a SECURITY called Total is a data row, not the footer", () => {
    const parsed = parseDhanDpChargesWorkbook({
      filename: "dhan-dp.xlsx",
      buffer: sheetOf([
        TITLE, HEAD,
        ["1", "23-Jul-2026", "INE062A01020", "Total", "1", "Sell", "Total", "12.5"],
        ["", "", "", "", "", "", "Total", "12.5"],
      ]),
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.total).toBe(12.5);
    expect(parsed.statedTotal).toBe(12.5);
    expect(parsed.warnings.join(" ")).not.toMatch(/difference of/);
  });

  it("two Total rows: the LAST is used, and the file is told it had two", () => {
    const parsed = parseDhanDpChargesWorkbook({
      filename: "dhan-dp.xlsx",
      buffer: sheetOf([
        TITLE, HEAD,
        ["1", "23-Jul-2026", "INE062A01020", "A LIMITED", "1", "Sell", "Other Fees", "12.5"],
        ["", "", "", "", "", "", "Total", "5.5"],
        ["2", "24-Jul-2026", "INE062A01020", "A LIMITED", "1", "Sell", "Other Fees", "7"],
        ["", "", "", "", "", "", "Total", "19.5"],
      ]),
    });
    expect(parsed.statedTotal).toBe(19.5);
    expect(parsed.warnings.join(" ")).toMatch(/more than one Total row; the LAST one/);
    expect(parsed.warnings.join(" ")).not.toMatch(/difference of/);
  });

  it("a Total row with no figure says conservation is UNCHECKED rather than nothing", () => {
    const parsed = parseDhanDpChargesWorkbook({
      filename: "dhan-dp.xlsx",
      buffer: sheetOf([
        TITLE, HEAD,
        ["1", "23-Jul-2026", "INE062A01020", "A LIMITED", "1", "Sell", "Other Fees", "12.5"],
        ["", "", "", "", "", "", "Total", ""],
      ]),
    });
    expect(parsed.statedTotal).toBeNull();
    expect(parsed.warnings.join(" ")).toMatch(/Total row with no figure in the Charges column/);
    expect(parsed.warnings.join(" ")).toMatch(/states no total, so conservation is unchecked/);
  });
});

/**
 * The format-only fingerprint is hijackable by construction: a rival broker
 * shipping the same eight headers would be imported as Dhan and priced at
 * Dhan's rates. The filename cannot vouch for a broker here — but it can veto
 * one, and so can a cell.
 */
describe("the rival-broker veto", () => {
  const buffer = fs.readFileSync(FIXTURE);
  it("refuses a file whose NAME says another broker", () => {
    for (const name of ["zerodha-dp-charges.xls", "GROWW_dp_charges.xls", "upstox-dp.xls", "paytm-dp-charges.xls", "AngelOne-dp.xls"]) {
      expect(detectDhanDpCharges({ filename: name, buffer }), name).toBe(0);
    }
    // …and still claims one that names nobody, or names Dhan.
    expect(detectDhanDpCharges({ filename: "export.xls", buffer })).toBeCloseTo(0.9, 10);
  });

  it("refuses a file whose TITLE ROW names another broker", () => {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets["DP Charges"]!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][];
    rows[0] = ["DP Charges | From 01-April-2026 to 03-September-2026", "Zerodha Broking Ltd"];
    const wb2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(rows.slice(0, 40)), "DP Charges");
    const bytes = XLSX.write(wb2, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectDhanDpCharges({ filename: "export.xlsx", buffer: bytes })).toBe(0);
  });

  /**
   * The veto region is the FILENAME, the SHEET NAMES and the TITLE/BANNER
   * rows ABOVE the header row — never the data grid. PAYTM (One 97) and
   * ANGELONE are listed companies: a Security Name is a HOLDING, not a
   * letterhead. Scanning every cell scored the owner's own file 0.
   */
  it("still claims the owner's own file when a SECURITY is named after a rival", () => {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const rows = (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["DP Charges"]!, {
      header: 1, raw: false, defval: "",
    }) as unknown[][]).slice(0, 200);
    const renamed: string[] = [];
    for (const name of ["ANGEL ONE LIMITED", "PAYTM", "ZERODHA", "GROWW", "UPSTOX"]) {
      const row = rows.find((r) => /^\d+$/.test(String(r[0] ?? "").trim()) && !renamed.includes(String(r[3])));
      if (row) { row[3] = name; renamed.push(name); }
    }
    expect(renamed).toHaveLength(5);
    const out = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(rows), "DP Charges");
    const bytes2 = XLSX.write(out, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectDhanDpCharges({ filename: "export.xlsx", buffer: bytes2 })).toBeGreaterThanOrEqual(0.9);
  });
});
