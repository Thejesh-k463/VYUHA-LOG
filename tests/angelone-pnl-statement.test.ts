import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { buildContext } from "@/lib/import/detect";
import {
  detectAngelOnePnlStatement, parseAngelOnePnlStatement, parseAngelOnePnlStatementSource, fyOf,
} from "@/lib/import/parsers/angelone-pnl-statement";

/**
 * Angel One's ProfitLoss_Statement, against a REDACTED copy of the owner's
 * real export (Equity P&L: Delivery 1 row + Intraday 5 rows; F&O P&L: 3 rows;
 * every table with its own Total).
 *
 * This is the ONE parser allowed to claim on FORMAT alone — the file names no
 * broker anywhere. See the parser header for the owner ruling.
 */
const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const FILE = "angelone-profitloss-2026-08-01_2026-08-31.xlsx";
const bytes = () => fs.readFileSync(path.join(DIR, FILE));
const own = () => buildContext(FILE, bytes());
const neutral = () => buildContext("export.xlsx", bytes());

describe("detection: the FORMAT is the fingerprint, and nothing else is", () => {
  it("scores 0.9 under a NEUTRAL filename — the file names no broker at all", () => {
    expect(detectAngelOnePnlStatement(neutral())).toBe(0.9);
  });

  it("scores 1.0 under a filename naming Angel or the report", () => {
    expect(detectAngelOnePnlStatement(own())).toBe(1);
    expect(detectAngelOnePnlStatement(buildContext("ProfitLoss_Statement_X.xlsx", bytes()))).toBe(1);
  });

  it("proves the claim really is format-only: the word 'Angel' appears nowhere in the file", () => {
    const wb = XLSX.read(bytes(), { type: "buffer" });
    const text = wb.SheetNames.flatMap((n) => {
      const ws = wb.Sheets[n]!;
      return Object.keys(ws).filter((a) => a[0] !== "!" && ws[a]!.t === "s").map((a) => String(ws[a]!.v));
    }).join("\n");
    expect(/angel/i.test(text)).toBe(false);
  });

  it("REFUSES Angel's own tax P&L — different sheets, different file", () => {
    const ctx = buildContext("export.xlsx", fs.readFileSync(path.join(DIR, "angelone-taxpnl-fy2026-27.xlsx")));
    expect(detectAngelOnePnlStatement(ctx)).toBe(0);
  });

  it("REFUSES a workbook with only ONE of the two sheet names", () => {
    const wb = XLSX.read(bytes(), { type: "buffer" });
    const wb2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb2, wb.Sheets["Equity P&L"]!, "Equity P&L");
    const buf = XLSX.write(wb2, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectAngelOnePnlStatement(buildContext("export.xlsx", buf))).toBe(0);
  });

  it("REFUSES a TEXT container outright", () => {
    const wb = XLSX.read(bytes(), { type: "buffer" });
    const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]!)).join("\n");
    expect(detectAngelOnePnlStatement(buildContext("export.csv", Buffer.from(csv, "utf8")))).toBe(0);
  });
});

describe("the reference rows", () => {
  const parsed = () => parseAngelOnePnlStatement(own());

  it("reads 9 scrip rows across the three tables, keyed by SYMBOL (there is no ISIN column)", () => {
    const p = parsed();
    const scrips = p.reference.filter((r) => r.scope === "scrip");
    expect(scrips).toHaveLength(9);
    expect(scrips.filter((r) => r.note === "delivery")).toHaveLength(1);
    expect(scrips.filter((r) => r.note === "intraday")).toHaveLength(5);
    expect(scrips.filter((r) => r.note === "fno")).toHaveLength(3);
    expect(scrips.every((r) => r.isin === null)).toBe(true);
    expect(scrips.every((r) => r.key === r.symbol)).toBe(true);
  });

  it("leaves asOf EMPTY rather than inventing one — the statement carries no date column", () => {
    const p = parsed();
    expect(p.reference.every((r) => r.asOf === null)).toBe(true);
    expect(p.fy).toBe("2026-27");
    expect(p.reference.every((r) => r.fy === "2026-27")).toBe(true);
    expect(p.warnings.some((w) => /no date column on either sheet/.test(w))).toBe(true);
  });

  it("maps the delivery row's figures to the canonical names", () => {
    const d = parsed().reference.find((r) => r.scope === "scrip" && r.note === "delivery")!;
    expect(d.key).toBe("YESBANK");
    expect(d.figures).toMatchObject({ qty: 1, buyValue: 18.76, sellValue: 22.71, grossPnl: 3.95, netPnl: 3.8 });
    // Brokerage 0.12 + GST 0.02, every other charge column 0.
    expect(d.figures.totalCharges).toBe(0.14);
  });

  it("reads the F&O sheet's Buy price / Sell Price as VALUES, not per-unit levels", () => {
    const f = parsed().reference.filter((r) => r.scope === "scrip" && r.note === "fno");
    // 65 x 17.65 = 1147.25 — a total, not a price.
    expect(f[0]!.figures).toMatchObject({ qty: 65, buyValue: 1147.25, sellValue: 2138.5, grossPnl: 991.25, netPnl: 939.67 });
  });

  it("emits an fy total per table and a segment row per sheet", () => {
    const p = parsed();
    const fy = p.reference.filter((r) => r.scope === "fy");
    expect(fy.map((r) => r.note)).toEqual(["delivery", "intraday", "fno"]);
    expect(fy[0]!.figures.grossPnl).toBe(3.95);
    expect(fy[1]!.figures.grossPnl).toBe(-2.21);
    expect(fy[2]!.figures.grossPnl).toBe(149.25);

    const seg = p.reference.filter((r) => r.scope === "segment");
    expect(seg.map((r) => r.key)).toEqual(["equity", "fno"]);
    expect(seg[0]!.figures).toMatchObject({ grossPnl: 1.74, netPnl: -3.5 });
    expect(seg[1]!.figures).toMatchObject({ grossPnl: 149.25, netPnl: -3.37 });
  });

  it("reconciles the table totals against each sheet's own summary block", () => {
    // Equity: 3.95 + (-2.21) = 1.74, exactly the summary's Total Gross PnL.
    const p = parsed();
    expect(p.warnings.some((w) => /summary states a gross P&L/.test(w))).toBe(false);
  });

  it("WARNS when the summary and the tables disagree", () => {
    // Located by its own label, not by a cell address: this workbook's `!ref`
    // does not start at A1, so a hand-written address lands on the wrong row.
    const wb = XLSX.read(bytes(), { type: "buffer" });
    const m = Object.fromEntries(wb.SheetNames.map((n) => [
      n,
      (XLSX.utils.sheet_to_json(wb.Sheets[n]!, { header: 1, raw: false, defval: "" }) as unknown[][])
        .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "").trim()) : [])),
    ])) as Record<string, string[][]>;
    m["Equity P&L"]!.find((r) => /^Total Gross PnL$/i.test((r[0] ?? "").trim()))![1] = "99";
    const wb2 = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(m)) XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(rows), name);
    const buf = XLSX.write(wb2, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const p = parseAngelOnePnlStatement(buildContext("export.xlsx", buf));
    expect(p.warnings.some((w) => /Equity P&L: the summary states a gross P&L of Rs99 but the Delivery and Intraday totals sum to Rs1\.74/.test(w))).toBe(true);
  });

  it("says out loud that this file is a reference, not the book", () => {
    expect(parsed().warnings[0]).toMatch(/Angel's P&L statement is a reference; the book is Trades_History/);
  });
});

describe("the dropzone source", () => {
  it("emits NO trades and carries the reference rows", () => {
    const f = parseAngelOnePnlStatementSource(own());
    expect(f.trades).toHaveLength(0);
    expect(f.format).toBe("reference");
    expect(f.broker).toBe("angelone");
    expect(f.reference).toHaveLength(14); // 9 scrip + 3 fy + 2 segment
  });
});

describe("financial year", () => {
  it("runs April to March", () => {
    expect(fyOf("2026-08-31")).toBe("2026-27");
    expect(fyOf("2026-03-31")).toBe("2025-26");
    expect(fyOf(null)).toBeNull();
  });
});

/**
 * The one parser allowed to claim on FORMAT alone is, by construction, the
 * one a rival's identically-shaped file could hijack. The filename cannot
 * vouch for a broker here — but it can veto one, and so can a cell.
 */
describe("the rival-broker veto", () => {
  const FIX = path.join(process.cwd(), "tests", "fixtures", "redacted", "angelone-profitloss-2026-08-01_2026-08-31.xlsx");
  const bytes = () => fs.readFileSync(FIX);

  it("refuses a file whose NAME says another broker", () => {
    for (const name of ["zerodha-pnl.xlsx", "GROWW_ProfitLoss_Statement.xlsx", "upstox-pnl.xlsx", "paytm_pnl.xlsx", "Dhan_P&L.xlsx"]) {
      expect(detectAngelOnePnlStatement(buildContext(name, bytes())), name).toBe(0);
    }
    expect(detectAngelOnePnlStatement(buildContext("export.xlsx", bytes()))).toBeCloseTo(0.9, 10);
  });

  it("refuses a file whose CONTENT names another broker", () => {
    const wb = XLSX.read(bytes(), { type: "buffer" });
    const out = XLSX.utils.book_new();
    for (const n of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n]!, { header: 1, raw: false, defval: "" }) as unknown[][];
      if (n === wb.SheetNames[0]) rows.unshift(["Zerodha Broking Limited"]);
      XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(rows), n);
    }
    const buf = XLSX.write(out, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectAngelOnePnlStatement(buildContext("export.xlsx", buf))).toBe(0);
  });
});
