import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { trimSheetRanges, workbookOf } from "@/lib/import/types";

/**
 * A BIFF8 (.xls) export can declare its used range as the WHOLE sheet
 * (`A1:Q65536` on Dhan's DP-charges file — 1,400 real cells). Every detector
 * that flattens with `sheet_to_json({ defval: "" })` then materialises 65,536
 * rows, and ranking runs a dozen detectors: 3.7 s on a 91 KB file on an idle
 * laptop, a 10 s hook timeout under load (W1 gate, 2026-09-04). `workbookOf`
 * trims each sheet's `!ref` to its populated bounding box once, on the
 * memoised workbook, so nothing a parser SEES changes except the phantom
 * trailing rows.
 */
const FIX = path.join("tests", "fixtures", "redacted", "dhan-dp-charges-2026-04-01_2026-09-03.xls");

describe("workbookOf trims a declared-whole-sheet range", () => {
  if (!fs.existsSync(FIX)) return;
  const buffer = fs.readFileSync(FIX);

  it("SheetJS alone reports the phantom range — the fixture really is inflated", () => {
    const ws = XLSX.read(buffer, { type: "buffer" }).Sheets["DP Charges"];
    expect(XLSX.utils.decode_range(ws["!ref"]!).e.r).toBeGreaterThan(10_000);
  });

  it("through workbookOf the range ends at the last populated row", () => {
    const wb = workbookOf({ filename: "x.xls", buffer });
    const ws = wb.Sheets["DP Charges"];
    const range = XLSX.utils.decode_range(ws["!ref"]!);
    expect(range.e.r).toBeLessThan(400);
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: "" });
    expect(rows.length).toBeLessThan(400);
    // The last populated cell survives: the footer row is still there.
    expect(rows.some((r) => r.some((c) => String(c).startsWith("Total")))).toBe(true);
  });
});

/**
 * The two sheets `workbookOf`'s own fixture cannot show, built by hand
 * because no real export has yet been seen with either shape — and both are
 * the difference between "trimmed" and "not trimmed at all".
 */
describe("trimSheetRanges on the shapes the real fixture does not have", () => {
  const wbWith = (ws: XLSX.WorkSheet): XLSX.WorkBook => ({ SheetNames: ["S"], Sheets: { S: ws } });

  it("a sheet whose ONLY content is merges is trimmed to the merge bounds, not left at A1:Q65536", () => {
    const ws: XLSX.WorkSheet = {
      "!ref": "A1:Q65536",
      "!merges": [{ s: { r: 0, c: 0 }, e: { r: 2, c: 5 } }],
    };
    trimSheetRanges(wbWith(ws));
    expect(ws["!ref"]).toBe("A1:F3");
    // And the point of the whole function: no 65,536-row materialisation.
    expect(XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" }).length).toBeLessThan(10);
  });

  it("a sheet with neither cells nor merges collapses to its own first cell", () => {
    const ws: XLSX.WorkSheet = { "!ref": "A1:Q65536" };
    trimSheetRanges(wbWith(ws));
    expect(ws["!ref"]).toBe("A1"); // SheetJS encodes a single-cell range as "A1"
  });

  it("NEVER expands: a cell outside the declared range cannot widen it", () => {
    // B2 is declared; Z9 exists in the object but the file said A1:B2. The
    // range only ever shrinks, so a reader is never handed columns the file
    // did not declare.
    const ws: XLSX.WorkSheet = { "!ref": "A1:B2", A1: { t: "s", v: "a" }, Z9: { t: "s", v: "z" } };
    trimSheetRanges(wbWith(ws));
    const r = XLSX.utils.decode_range(ws["!ref"]!);
    expect(r.e.c).toBeLessThanOrEqual(1);
    expect(r.e.r).toBeLessThanOrEqual(1);
  });
});
