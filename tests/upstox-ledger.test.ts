import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { buildContext } from "@/lib/import/detect";
import {
  detectUpstoxLedger, parseUpstoxLedger, dateFormatEvidence, classifyUpstoxRow, money,
} from "@/lib/import/parsers/upstox-ledger";

/**
 * The Upstox ledger, against a REDACTED copy of the owner's real export
 * (4 data rows, 2025-07-19 -> 2026-09-04). See the parser header for the
 * verified layout.
 */
const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const FILE = "upstox-ledger-2025-07-19_2026-09-04.xlsx";
const bytes = () => fs.readFileSync(path.join(DIR, FILE));
const own = () => buildContext(FILE, bytes());
const neutral = () => buildContext("export.xlsx", bytes());

function sheet(matrix: unknown[][], name: string): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const HEADER = ["Wallet", "Trade Date", "Settlement Date", "Exchange", "Segment", "Type", "Narration", "Debit", "Credit", "Closing Balance"];

describe("detection: the claim is carried by CONTENT, not by the filename", () => {
  it("scores 0.9 under a NEUTRAL filename — Upstox's real exports name nobody", () => {
    expect(detectUpstoxLedger(neutral())).toBe(0.9);
  });

  it("scores 1.0 under its own filename (broker word + 'ledger')", () => {
    expect(detectUpstoxLedger(own())).toBe(1);
  });

  it("REFUSES the same export with no header row — it could not read a single line of it", () => {
    // tests/fixtures/redacted/upstox-ledger.xlsx: banner present, sheet
    // LEDGER_V3 present, header row absent. A banner-only rule would claim a
    // file this parser cannot read, and the detection matrix pins it as
    // "never claimed by a broker parser".
    const ctx = buildContext("export.xlsx", fs.readFileSync(path.join(DIR, "upstox-ledger.xlsx")));
    expect(detectUpstoxLedger(ctx)).toBe(0);
  });

  it("REFUSES a TEXT container outright, so no score is decided by an extension", () => {
    const wb = XLSX.read(bytes(), { type: "buffer" });
    const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]!)).join("\n");
    expect(detectUpstoxLedger(buildContext("export.csv", Buffer.from(csv, "utf8")))).toBe(0);
  });

  it("REFUSES a ledger-shaped workbook that names no broker", () => {
    const buf = sheet([
      ["SOME OTHER BROKER PRIVATE LIMITED"], [],
      HEADER,
      ["Trading", "28-08-2026", "28-08-2026", "NSE", "EQ", "Order", "BILL POSTING", "10.00", "–", "90.00"],
    ], "Statement");
    expect(detectUpstoxLedger(buildContext("export.xlsx", buf))).toBe(0);
  });
});

describe("the owner's real ledger, row by row", () => {
  const parsed = () => parseUpstoxLedger(own());

  it("reads 4 rows, signs them from debit/credit, and keeps exchange/segment/type/narration", () => {
    const p = parsed();
    expect(p.rows).toHaveLength(4);
    expect(p.from).toBe("2026-08-28");
    expect(p.to).toBe("2026-08-28");
    expect(p.rows.map((r) => r.amount)).toEqual([2500, -4.28, -354.57, -78.44]);
    expect(p.rows[1]!.narration).toContain("NSE");
    expect(p.rows[1]!.narration).toContain("EQ");
    expect(p.rows[1]!.narration).toContain("Order");
    expect(p.rows[1]!.narration).toContain("BILL POSTING");
    expect(p.rows.map((r) => r.balance)).toEqual([2500, 2495.72, 2141.15, 2062.71]);
  });

  it("classifies every row — and books the MTF WALLET TRANSFER as an adjustment, not as interest", () => {
    // THE trap: "Transferred amount to MTF account" contains "MTF", and
    // `classifyNarration` reads that word as MTF financing interest. It is a
    // wallet transfer; the account paid no interest here.
    const p = parsed();
    expect(p.rows.map((r) => r.kind)).toEqual(["deposit", "realised_pnl", "realised_pnl", "adjustment"]);
    expect(p.mtfInterestTotal).toBe(0);
    expect(p.unclassified).toHaveLength(0);
  });

  it("checks the file's own Total row and reports conservation", () => {
    const p = parsed();
    // Total row: debit 437.29, credit 2,500.00, closing 2,062.71.
    expect(p.warnings.some((w) => /4 ledger row\(s\) read \(Rs2500 in, Rs437\.29 out\)/.test(w))).toBe(true);
    expect(p.warnings.some((w) => /Total row states/.test(w))).toBe(false);
  });

  it("skips the Total row rather than importing it as an entry", () => {
    expect(parsed().rows.some((r) => /total/i.test(r.narration))).toBe(false);
  });

  it("proves the dates are day-first from the file itself", () => {
    expect(parsed().warnings).toContain("Dates read as dd-mm-yyyy, confirmed by 4 row(s) whose day exceeds 12.");
  });
});

describe("money cells", () => {
  it("reads a formatted rupee cell and treats the EN DASH as empty, not as text", () => {
    expect(money("₹2,500.00")).toBe(2500);
    expect(money("–")).toBe(0);
    expect(money("")).toBe(0);
    expect(money("₹4.28")).toBe(4.28);
  });
});

describe("the date-format question is answered, never guessed", () => {
  it("REFUSES a month-first file rather than transposing every date", () => {
    const e = dateFormatEvidence(["08-28-2026", "09-30-2026"]);
    expect(e.refusal).toMatch(/month-first/);
  });

  it("says 'undetectable by construction' when every day is 12 or less", () => {
    const e = dateFormatEvidence(["01-02-2026", "03-04-2026"]);
    expect(e.refusal).toBeNull();
    expect(e.warning).toMatch(/undetectable by construction/);
  });

  it("a whole ledger of ambiguous dates parses, but SAYS the format is unproven", () => {
    const buf = sheet([
      ["UPSTOX SECURITIES PRIVATE LIMITED"], [],
      HEADER,
      ["Trading", "01-02-2026", "01-02-2026", "NSE", "EQ", "Order", "BILL POSTING", "₹10.00", "–", "₹90.00"],
    ], "LEDGER_V3");
    const p = parseUpstoxLedger(buildContext("export.xlsx", buf));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.date).toBe("2026-02-01");
    expect(p.warnings.some((w) => /undetectable by construction/.test(w))).toBe(true);
  });

  it("a month-first ledger yields NO rows and says why", () => {
    const buf = sheet([
      ["UPSTOX SECURITIES PRIVATE LIMITED"], [],
      HEADER,
      ["Trading", "08-28-2026", "08-28-2026", "NSE", "EQ", "Order", "BILL POSTING", "₹10.00", "–", "₹90.00"],
    ], "LEDGER_V3");
    const p = parseUpstoxLedger(buildContext("export.xlsx", buf));
    expect(p.rows).toHaveLength(0);
    expect(p.warnings.join(" ")).toMatch(/month-first/);
  });
});

describe("conservation against the Total row is reported, not hidden", () => {
  it("warns when the stated debit total disagrees with the rows", () => {
    const buf = sheet([
      ["UPSTOX SECURITIES PRIVATE LIMITED"], [],
      HEADER,
      ["Trading", "28-08-2026", "28-08-2026", "NSE", "EQ", "Order", "BILL POSTING", "₹10.00", "–", "₹90.00"],
      ["", "", "", "", "", "", "Total", "₹99.00", "–", "₹90.00"],
    ], "LEDGER_V3");
    const p = parseUpstoxLedger(buildContext("export.xlsx", buf));
    expect(p.rows).toHaveLength(1);
    expect(p.warnings.some((w) => /states Rs99 debited but its rows sum to Rs10/.test(w))).toBe(true);
  });
});

describe("row classification", () => {
  it("reads the Type column before the narration", () => {
    expect(classifyUpstoxRow("Fund transfer", "Funds added to your trading wallet", 2500).kind).toBe("deposit");
    expect(classifyUpstoxRow("Fund transfer", "Funds withdrawn", -500).kind).toBe("withdrawal");
    expect(classifyUpstoxRow("Order", "BILL POSTING", -4.28).kind).toBe("realised_pnl");
    expect(classifyUpstoxRow("Journal voucher", "Transferred amount to MTF account", -78.44).kind).toBe("adjustment");
  });
});
