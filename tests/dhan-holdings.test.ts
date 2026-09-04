/**
 * Dhan demat holding summary — a position statement, never a transaction.
 *
 * The fixture is a REDACTED copy of the owner's real export, produced by
 * `scripts/fixtures/redact-broker-export.mjs`; the owner's file is read in
 * place, never copied.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { ParseContext } from "@/lib/import/types";
import {
  detectDhanHoldings,
  findHoldingHeader,
  parseDhanHoldings,
  parseDhanHoldingsWorkbook,
  parseHoldingDate,
} from "@/lib/import/parsers/dhan-holdings";
import { detectDhanRealisedPnl } from "@/lib/import/parsers/dhan-realised-pnl";
import { detectDhanDpCharges } from "@/lib/import/parsers/dhan-dp-charges";
import { OWNER_DHAN_HOLDINGS, ownerContext, ownerFiles } from "./helpers/owner-broker-files";

const FIXTURE = path.join(__dirname, "fixtures/redacted/dhan-holdings-2026-07-01.xlsx");
const ctxOf = (name = path.basename(FIXTURE)): ParseContext => ({ filename: name, buffer: fs.readFileSync(FIXTURE) });

const HEADER = ["Scrip Name", "ISIN Code", "Free Holding", "Locked In", "Safe Keep", "MTF Pledge", "Margin Pledge", "CUSA Pledge", "Closing Price", "Valuation"];
function workbook(rows: unknown[][], sheet = "Dhan_Demat_Holding"): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("detection", () => {
  it("claims the export: the sheet NAMES the broker and the header is the format", () => {
    // 0.90 format+identity, +0.05 `Holding summary` title, +0.05 filename.
    expect(detectDhanHoldings(ctxOf())).toBeCloseTo(1, 10);
    expect(detectDhanHoldings(ctxOf("export.xlsx"))).toBeCloseTo(0.95, 10);
  });

  it("refuses the same table on a sheet that does not name Dhan", () => {
    const buffer = workbook([["Holding summary | For 01-07-2026"], HEADER, ["X", "INE002A01018", "1", "0", "0", "0", "0", "0", "1", "1"]], "Sheet1");
    expect(detectDhanHoldings({ filename: "holdings.xlsx", buffer })).toBe(0);
  });

  it("refuses a text container", () => {
    expect(detectDhanHoldings({ filename: "h.csv", text: HEADER.join(",") })).toBe(0);
  });

  it("stands down on its siblings, and they on it", () => {
    expect(detectDhanRealisedPnl(ctxOf())).toBe(0);
    expect(detectDhanDpCharges(ctxOf())).toBe(0);
  });
});

describe("the statement date", () => {
  it("comes from the file's own date CELL, not the filename", () => {
    const parsed = parseDhanHoldingsWorkbook(ctxOf("export.xlsx"));
    expect(parsed.asOf).toBe("2026-07-01");
    expect(parsed.asOfSource).toBe("cell");
  });

  it("falls back to the filename's _dd-mm-yyyy when the sheet states none", () => {
    const buffer = workbook([["Holding summary"], HEADER, ["X", "INE002A01018", "1", "0", "0", "0", "0", "0", "1", "1"]]);
    const parsed = parseDhanHoldingsWorkbook({ filename: "Dhan_Demat_Holding_01-07-2026.xlsx", buffer });
    expect(parsed.asOf).toBe("2026-07-01");
    expect(parsed.asOfSource).toBe("filename");
  });

  it("warns when the cell and the filename disagree, and trusts the sheet", () => {
    const parsed = parseDhanHoldingsWorkbook({ filename: "Dhan_Demat_Holding_02-08-2026.xlsx", buffer: fs.readFileSync(FIXTURE) });
    expect(parsed.asOf).toBe("2026-07-01");
    expect(parsed.warnings.join(" ")).toMatch(/dated 2026-07-01 but the filename says 2026-08-02/);
  });

  it("reads day-first, and REFUSES only the genuinely ambiguous order", () => {
    expect(parseHoldingDate("01-07-2026")).toBe("2026-07-01");
    expect(parseHoldingDate("13-07-2026")).toBe("2026-07-13"); // 13 can only be a day
    expect(parseHoldingDate("07-13-2026")).toBeNull(); // month 13, day 7 — ambiguous
  });
});

describe("the redacted export", () => {
  const parsed = parseDhanHoldingsWorkbook(ctxOf());

  it("emits reference rows scoped `holding`, keyed by ISIN, dated", () => {
    expect(parsed.reference).toHaveLength(1);
    const r = parsed.reference[0]!;
    expect(r.scope).toBe("holding");
    expect(r.key).toBe("INE002A01018");
    expect(r.isin).toBe("INE002A01018");
    expect(r.asOf).toBe("2026-07-01");
    expect(r.figures).toEqual({ qty: 1, freeQty: 1, mtfPledgeQty: 0, closingPrice: 1293.9, valuation: 1293.9 });
    expect(r.note).toBe("qty = free + locked-in + safe keep + MTF pledge + margin pledge + CUSA pledge");
  });

  it("conserves valuation against the footer and counts the securities", () => {
    expect(parsed.statedValuation).toBe(1293.9);
    expect(parsed.valuation).toBe(1293.9);
    expect(parsed.statedCount).toBe(1);
    expect(parsed.warnings.join(" ")).not.toMatch(/difference of|could be read/);
  });

  it("finds the header by text", () => {
    const wb = XLSX.read(fs.readFileSync(FIXTURE), { type: "buffer" });
    const rows = (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Dhan_Demat_Holding"]!, { header: 1, raw: false, defval: "" }) as unknown[][])
      .map((r) => r.map((c) => String(c ?? "")));
    expect(findHoldingHeader(rows)!.at).toBe(5);
  });
});

describe("the qty formula counts every bucket, not just the free stock", () => {
  it("adds locked, safe keep and all three pledges", () => {
    const buffer = workbook([
      ["Holding summary | For 01-07-2026"],
      HEADER,
      ["ACME", "INE111A01011", "10", "2", "3", "4", "5", "6", "100.00", "3000.00"],
      [],
      ["Valuation", "3000.00"],
      ["Total Number of Securities", "1"],
    ]);
    const parsed = parseDhanHoldingsWorkbook({ filename: "Dhan_Demat_Holding_01-07-2026.xlsx", buffer });
    const f = parsed.reference[0]!.figures;
    expect(f.qty).toBe(30); // 10 + 2 + 3 + 4 + 5 + 6 — pledged stock is still owned
    expect(f.freeQty).toBe(10);
    expect(f.mtfPledgeQty).toBe(4);
  });

  it("warns when the rows do not add up to the footer valuation", () => {
    const buffer = workbook([
      ["Holding summary | For 01-07-2026"],
      HEADER,
      ["ACME", "INE111A01011", "10", "0", "0", "0", "0", "0", "100.00", "1000.00"],
      ["Valuation", "9999.00"],
      ["Total Number of Securities", "2"],
    ]);
    const parsed = parseDhanHoldingsWorkbook({ filename: "Dhan_Demat_Holding_01-07-2026.xlsx", buffer });
    expect(parsed.warnings.join(" ")).toMatch(/₹1000\.00 but the file's own Valuation says ₹9999\.00/);
    expect(parsed.warnings.join(" ")).toMatch(/says it holds 2 securities but 1 row could be read/);
  });
});

describe("as an import source", () => {
  const file = parseDhanHoldings(ctxOf());
  it("creates no trades and no ledger — a holding is not a transaction", () => {
    expect(file.trades).toEqual([]);
    expect(file.sourceId).toBe("dhan-holdings");
    expect(file.format).toBe("holdings");
    expect(file.reference).toHaveLength(1);
    expect(file.warnings[0]).toMatch(/states positions, not transactions/);
    expect(file.reported).toEqual({ valuation: 1293.9, statedValuation: 1293.9, statedSecurities: 1 });
  });
});

describe("the owner's real export", () => {
  it("parses in place and conserves its own valuation", () => {
    const files = ownerFiles(OWNER_DHAN_HOLDINGS);
    if (files.length === 0) return; // not this machine
    const { filename, bytes } = ownerContext(files[0]!);
    const parsed = parseDhanHoldingsWorkbook({ filename, buffer: bytes });
    expect(parsed.asOfSource).toBe("cell");
    expect(parsed.valuation).toBe(parsed.statedValuation);
    expect(parsed.reference.length).toBe(parsed.statedCount);
    expect(detectDhanHoldings({ filename, buffer: bytes })).toBeCloseTo(0.95, 10);
  });
});
