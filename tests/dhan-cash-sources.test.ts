/**
 * Dhan's two CASH files — the ledger and the dividend payout report — as
 * registered import sources (2026-09-04).
 *
 * Before this, neither was registered, so through the dropzone `dhan-csv`
 * claimed both at 0.30 on the word "dhan" in the FILENAME alone — the
 * misclaim class AGENTS.md forbids. Now each has a source that names it and
 * says where it goes, every Dhan detector stands down on its siblings'
 * headers, and the ledger parser survives the real export's quirks: the
 * OPENING BALANCE row pinned at the top, dated 01-01-1970 on one account,
 * with the opening figure in the CREDIT column and Net Balance at 0.
 *
 * Fixtures are hand-made in the real header layout with invented data.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext, importSources, rankParsers } from "@/lib/import/detect";
import { IMPORT_HELP_CARDS } from "@/lib/domain/import-help-content";
import { detectDhanCsv } from "@/lib/import/parsers/dhan-csv";
import { detectDhanGtr } from "@/lib/import/parsers/dhan-gtr";
import { detectDhanRealisedPnl } from "@/lib/import/parsers/dhan-realised-pnl";
import {
  detectDhanDividend,
  detectDhanLedger,
  detectDhanLedgerFile,
  parseDhanCashFile,
  parseDhanDividend,
  parseDhanDividendSource,
  parseDhanLedger,
  parseDhanLedgerSource,
} from "@/lib/import/parsers/dhan-ledger";
import { ownerContext, ownerFile, ownerFiles } from "./helpers/owner-broker-files";

const fixture = (f: string) => fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", f), "utf8");
const LEDGER = fixture("dhan-ledger.csv");
const DIVIDEND = fixture("dhan-dividend.csv");
const GTR = fixture("dhan-gtr.csv");
const PNL = fixture("dhan-pnl.csv");
const ctx = (filename: string, text: string) => ({ filename, text, buffer: Buffer.from(text, "utf8") });

describe("registration — the PDF pattern", () => {
  it("both cash sources are registered, and their parse imports no trades", () => {
    const ids = importSources().map((s) => s.sourceId);
    expect(ids).toContain("dhan-ledger");
    expect(ids).toContain("dhan-dividend");
    const led = parseDhanLedgerSource(ctx("Dhan_Ledger_x.csv", LEDGER));
    expect(led.trades).toEqual([]);
    expect(led.warnings[0]).toMatch(/Cash & Ledger screen/);
    expect(led.warnings[0]).toMatch(/4 entries, 2026-04-02 → 2026-04-15/);
    const div = parseDhanDividendSource(ctx("Dhan_Dividend_x.csv", DIVIDEND));
    expect(div.trades).toEqual([]);
    expect(div.warnings[0]).toMatch(/Cash & Ledger screen/);
    for (const s of importSources().filter((x) => x.sourceId === "dhan-ledger" || x.sourceId === "dhan-dividend")) {
      expect(s.label, s.sourceId).toMatch(/Cash & Ledger/);
      expect(s.label, s.sourceId).toMatch(/does not import trades/);
    }
  });

  it("the Dhan help card lists both, and says they go to Cash & Ledger", () => {
    const dhan = IMPORT_HELP_CARDS.find((c) => c.id === "dhan")!;
    const ids = dhan.formats.map((f) => f.sourceId);
    expect(ids).toContain("dhan-ledger");
    expect(ids).toContain("dhan-dividend");
    expect(dhan.steps.join(" ")).toMatch(/Cash & Ledger screen/);
  });
});

describe("detection — every Dhan CSV detector stands down on its siblings", () => {
  it("the ledger routes to dhan-ledger at ≥ 0.9, even under a neutral filename", () => {
    expect(detectDhanLedgerFile(ctx("export.csv", LEDGER))).toBeGreaterThanOrEqual(0.9);
    const top = rankParsers(buildContext("export.csv", Buffer.from(LEDGER)))[0];
    expect(top.sourceId).toBe("dhan-ledger");
  });

  it("dhan-csv returns 0 when the ledger header is present — filename notwithstanding", () => {
    // THE regression: "dhan" in the filename used to be worth 0.30 on its own.
    expect(detectDhanCsv(ctx("Dhan_Ledger_01-04-2026_03-09-2026.csv", LEDGER))).toBe(0);
    expect(detectDhanCsv(ctx("Dhan_Dividend_payout.csv", DIVIDEND))).toBe(0);
  });

  it("dhan-ledger returns 0 on the GTR and P&L headers", () => {
    expect(detectDhanLedgerFile(ctx("Dhan_GTR.csv", GTR))).toBe(0);
    expect(detectDhanLedgerFile(ctx("Dhan_PnL.csv", PNL))).toBe(0);
    expect(detectDhanLedger(GTR)).toBe(0);
    expect(detectDhanLedger(PNL)).toBe(0);
    expect(detectDhanLedgerFile(ctx("Dhan_Dividend.csv", DIVIDEND))).toBe(0);
  });

  it("the dividend report routes to dhan-dividend and nobody else", () => {
    expect(detectDhanDividend(ctx("export.csv", DIVIDEND))).toBeGreaterThanOrEqual(0.9);
    expect(detectDhanDividend(ctx("x.csv", LEDGER))).toBe(0);
    expect(detectDhanDividend(ctx("x.csv", GTR))).toBe(0);
    expect(detectDhanDividend(ctx("x.csv", PNL))).toBe(0);
    expect(rankParsers(buildContext("export.csv", Buffer.from(DIVIDEND)))[0].sourceId).toBe("dhan-dividend");
  });

  it("a ledger from a broker that is not Dhan is not claimed by dhan-ledger", () => {
    const other = "Date,Particulars,Debit,Credit,Running Balance\n01 Jul 2026,Opening Balance,0.00,150000.00,150000.00\n03 Jul 2026,Net obligation,2645.76,0.00,147354.24\n";
    expect(detectDhanLedgerFile(ctx("statement.csv", other))).toBe(0);
    // The Cash & Ledger uploader, where the user vouches for the file, still reads it.
    expect(detectDhanLedger(other)).toBeGreaterThan(0);
  });
});

describe("parseDhanLedger — the real export's quirks", () => {
  it("survives the epoch-dated OPENING BALANCE row, reads the opening from the credit column, emits no 1970 entry", () => {
    const out = parseDhanLedger(LEDGER);
    expect(out.rows.map((r) => r.date)).not.toContain("1970-01-01");
    expect(out.from).toBe("2026-04-02");
    expect(out.to).toBe("2026-04-15");
    expect(out.rows).toHaveLength(4);
    expect(out.openingBalance).toBe(78735.13);
    expect(out.mtfInterestTotal).toBe(412.5);
    expect(out.rows.map((r) => r.kind)).toEqual(["deposit", "mtf_interest", "realised_pnl", "dividend"]);
  });

  it("without the footer, the marker row's credit column still yields the opening balance", () => {
    const noFooter = LEDGER.split("\n").filter((l) => !/^Opening Balance,/.test(l)).join("\n");
    expect(parseDhanLedger(noFooter).openingBalance).toBe(78735.13);
  });

  it("prefers the Narration column over the terse Description", () => {
    const out = parseDhanLedger(LEDGER);
    expect(out.rows[0].narration).toBe("Money added to your Trading Account");
  });
});

describe("parseDhanDividend → ledger rows of the dividend kind", () => {
  it("reads dd-Mon-yy dates, positive amounts, and checks the file's own total", () => {
    const out = parseDhanDividend(DIVIDEND);
    expect(out.source).toBe("dhan-dividend");
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r.date).sort()).toEqual(["2025-08-05", "2026-02-18"]);
    expect(out.rows.every((r) => r.kind === "dividend" && !r.unclassified && r.amount > 0)).toBe(true);
    expect(out.rows[0].amount).toBe(1250);
    expect(out.rows[0].narration).toMatch(/Alpha Test Pharma/);
    expect(out.from).toBe("2025-08-05");
    expect(out.to).toBe("2026-02-18");
    expect(out.warnings.join(" ")).not.toMatch(/states Total Dividend/);
  });

  it("reports a mismatch between the rows and Total Dividend Earned instead of hiding it", () => {
    const out = parseDhanDividend(DIVIDEND.replace("Total Dividend Earned,1550", "Total Dividend Earned,1600"));
    expect(out.warnings.join(" ")).toMatch(/states Total Dividend Earned ₹1,600 but its rows sum to ₹1,550/);
  });

  it("the Cash & Ledger door dispatches on the verified header", () => {
    expect(parseDhanCashFile(DIVIDEND).source).toBe("dhan-dividend");
    expect(parseDhanCashFile(LEDGER).source).toBe("dhan-ledger");
  });
});

const REAL_LEDGERS = ownerFiles(/^Dhan_Ledger_.*\.csv$/);
const REAL_DIVIDEND = ownerFile(/^Dhan_Dividend_.*\.csv$/);
describe.skipIf(REAL_LEDGERS.length === 0 || !REAL_DIVIDEND)("the owner's real Dhan cash files, read in place", () => {
  for (const file of REAL_LEDGERS) {
    it(`real ledger ${path.basename(file).replace(/_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{4}/, "")}: routes to dhan-ledger, parses, never emits the epoch row`, () => {
      const { filename, bytes } = ownerContext(file);
      const ranked = rankParsers(buildContext(filename, bytes));
      expect(ranked[0].sourceId).toBe("dhan-ledger");
      expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.9);
      const text = bytes.toString("utf8");
      expect(detectDhanCsv({ filename: path.basename(file), text })).toBe(0);
      expect(detectDhanGtr({ filename, text })).toBe(0);
      expect(detectDhanRealisedPnl({ filename, text })).toBe(0);
      expect(detectDhanDividend({ filename, text })).toBe(0);
      const out = parseDhanLedger(text);
      expect(out.rows.length).toBeGreaterThan(0);
      expect(out.rows.map((r) => r.date)).not.toContain("1970-01-01");
      expect(out.from! >= "2026-01-01").toBe(true);
      expect(out.openingBalance).not.toBeNull();
    });
  }

  it("real dividend report: routes to dhan-dividend and reconciles to its own total", () => {
    const { filename, bytes } = ownerContext(REAL_DIVIDEND!);
    const ranked = rankParsers(buildContext(filename, bytes));
    expect(ranked[0].sourceId).toBe("dhan-dividend");
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.9);
    const text = bytes.toString("utf8");
    expect(detectDhanCsv({ filename: path.basename(REAL_DIVIDEND!), text })).toBe(0);
    expect(detectDhanLedgerFile({ filename, text })).toBe(0);
    const out = parseDhanDividend(text);
    expect(out.rows.length).toBeGreaterThan(0);
    expect(out.warnings.join(" ")).not.toMatch(/states Total Dividend/);
  });
});
