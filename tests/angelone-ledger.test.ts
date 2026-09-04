import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { buildContext } from "@/lib/import/detect";
import { detectAngelOneLedger, parseAngelOneLedger, classifyAngelRow } from "@/lib/import/parsers/angelone-ledger";

/**
 * The Angel One account statement, against a REDACTED copy of the owner's
 * real export (Broking Ledger: 8 data rows over 2026-08-01 -> 2026-08-31;
 * Charges: four stacked tables, only the DP one populated).
 */
const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const FILE = "angelone-statement-2026-08-01_2026-08-31.xlsx";
const bytes = () => fs.readFileSync(path.join(DIR, FILE));
const own = () => buildContext(FILE, bytes());
const neutral = () => buildContext("export.xlsx", bytes());

/** The workbook as editable string matrices, keyed by sheet name. */
function matrices(): Record<string, string[][]> {
  const wb = XLSX.read(bytes(), { type: "buffer" });
  return Object.fromEntries(wb.SheetNames.map((n) => [
    n,
    (XLSX.utils.sheet_to_json(wb.Sheets[n]!, { header: 1, raw: false, defval: "" }) as unknown[][])
      .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "").trim()) : [])),
  ]));
}

function rebuild(m: Record<string, string[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(m)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("detection: 'Angelone charge' is the in-content name", () => {
  it("scores 0.9 under a NEUTRAL filename", () => {
    expect(detectAngelOneLedger(neutral())).toBe(0.9);
  });

  it("scores 1.0 when the filename names Angel too", () => {
    expect(detectAngelOneLedger(own())).toBe(1);
  });

  it("claims the zero-data-row copy of the same layout — its header IS readable", () => {
    const ctx = buildContext("export.xlsx", fs.readFileSync(path.join(DIR, "YourStatement_TEST0000.xlsx")));
    expect(detectAngelOneLedger(ctx)).toBe(0.9);
  });

  it("REFUSES a ledger-shaped workbook that names no broker", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Transaction Details"],
      ["Transaction", "Date", "Segment", "Voucher", "Debit", "Credit", "Running Balance"],
      ["Trades Executed", "2026-08-07 00:00:00", "nsecm", "1", "", "22.63", "22.63"],
    ]), "Broking Ledger");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(detectAngelOneLedger(buildContext("export.xlsx", buf))).toBe(0);
  });

  it("REFUSES a TEXT container outright", () => {
    const wb = XLSX.read(bytes(), { type: "buffer" });
    const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]!)).join("\n");
    expect(detectAngelOneLedger(buildContext("export.csv", Buffer.from(csv, "utf8")))).toBe(0);
  });

  it("REFUSES Angel's own P&L statement — a different file with no ledger header", () => {
    const ctx = buildContext("export.xlsx", fs.readFileSync(path.join(DIR, "angelone-profitloss-2026-08-01_2026-08-31.xlsx")));
    expect(detectAngelOneLedger(ctx)).toBe(0);
  });
});

describe("the Broking Ledger, row by row", () => {
  const parsed = () => parseAngelOneLedger(own());

  it("reads 8 rows, signs them from debit/credit, and dates them ISO", () => {
    const p = parsed();
    expect(p.rows).toHaveLength(8);
    expect(p.openingBalance).toBe(0);
    expect(p.from).toBe("2026-08-07");
    expect(p.to).toBe("2026-08-27");
    expect(p.rows.map((r) => r.amount)).toEqual([22.63, -70.8, -23.6, 939.67, -0.68, 1500, -943.04, -6.62]);
  });

  it("classifies every transaction type the file uses", () => {
    expect(parsed().rows.map((r) => r.kind)).toEqual([
      "realised_pnl", "charge", "charge", "realised_pnl", "realised_pnl", "deposit", "realised_pnl", "realised_pnl",
    ]);
    expect(parsed().unclassified).toHaveLength(0);
  });

  it("proves the running balance CHAINS from the stated opening balance", () => {
    const p = parsed();
    expect(p.warnings).toContain("The running balance chains through all 8 rows from the stated opening balance of Rs0.");
    expect(p.rows[p.rows.length - 1]!.balance).toBe(1417.56);
  });

  it("names the FIRST break when the chain is broken", () => {
    // Corrupt the DP Charges line's running balance. Located by its own
    // content, not by a cell address: this workbook's `!ref` does not start
    // at A1, so a hand-written address lands on the wrong row.
    const m = matrices();
    const row = m["Broking Ledger"]!.find((r) => /^DP Charges$/i.test((r[0] ?? "").trim()))!;
    row[6] = "-999";
    const p = parseAngelOneLedger(buildContext("export.xlsx", rebuild(m)));
    const broke = p.warnings.filter((w) => /running balance breaks first/.test(w));
    expect(broke).toHaveLength(1);
    expect(broke[0]).toMatch(/2026-08-11/);
  });
});

describe("the Charges sheet: four stacked tables, found by TITLE", () => {
  it("emits reference rows keyed by table name, with the row's own date", () => {
    const p = parseAngelOneLedger(own());
    const dp = p.reference.filter((r) => r.key === "dp");
    expect(p.reference).toHaveLength(1); // only the DP table carries a row
    expect(dp[0]!.scope).toBe("charge");
    expect(dp[0]!.asOf).toBe("2026-08-10");
    expect(dp[0]!.fy).toBe("2026-27");
    expect(dp[0]!.isin).toBe("INE528G01035");
    expect(dp[0]!.figures.amount).toBe(23.6);
    expect(dp[0]!.figures.depositoryCharge).toBe(3.5);
    expect(dp[0]!.figures.brokerCharge).toBe(16.5);
    expect(dp[0]!.figures.gst).toBe(3.6);
  });

  it("emits the charge row as a LedgerRow too — but NEVER inside `rows`", () => {
    // The Rs23.60 DP charge is already in the Broking Ledger (2026-08-11) and
    // the running balance chains through it exactly once. Adding the charge
    // table's copy (dated 2026-08-10) would debit the account twice for one
    // charge, and the importer's date+amount de-duplication would not catch
    // it because the two dates differ.
    const p = parseAngelOneLedger(own());
    expect(p.chargeRows).toHaveLength(1);
    expect(p.chargeRows[0]!.kind).toBe("charge");
    expect(p.chargeRows[0]!.amount).toBe(-23.6);
    expect(p.rows.some((r) => r.date === "2026-08-10")).toBe(false);
    expect(p.rows.filter((r) => r.amount === -23.6)).toHaveLength(1);
    expect(p.warnings.some((w) => /debit the account twice for one charge/.test(w))).toBe(true);
  });

  it("finds each table by its title even when an earlier table grows", () => {
    // The four tables are stacked, so a row added to the DP table pushes
    // every later header down. Locating them by fixed row index is the defect
    // this asserts against.
    const wb = XLSX.read(bytes(), { type: "buffer" });
    const ws = wb.Sheets["Charges"]!;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }) as unknown[][];
    const extra = ["ACME", "INE000000001", "2026-08-12T00:00:00+05:30", "2", "3.5", "16.5", "3.6", "23.6"];
    rows.splice(14, 0, extra);
    const wb2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(
      XLSX.utils.sheet_to_json(wb.Sheets["Broking Ledger"]!, { header: 1, raw: false, defval: "" }) as unknown[][],
    ), "Broking Ledger");
    XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(rows), "Charges");
    const buf = XLSX.write(wb2, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const p = parseAngelOneLedger(buildContext("export.xlsx", buf));
    expect(p.reference.filter((r) => r.key === "dp")).toHaveLength(2);
    expect(p.reference.map((r) => r.asOf)).toContain("2026-08-12");
  });
});

describe("transaction classification", () => {
  it("reads Angel's transaction type, not a narration guess", () => {
    expect(classifyAngelRow("Funds Added", 1500).kind).toBe("deposit");
    expect(classifyAngelRow("Trades Executed", 22.63).kind).toBe("realised_pnl");
    expect(classifyAngelRow("Account Maintenance charge", -70.8).kind).toBe("charge");
    expect(classifyAngelRow("DP Charges", -23.6).kind).toBe("charge");
  });
});
