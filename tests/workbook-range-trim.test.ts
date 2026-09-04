import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { workbookOf } from "@/lib/import/types";

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
