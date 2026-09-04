import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildContext, rankParsers } from "@/lib/import/detect";
import type { ParsedFile } from "@/lib/import/types";
import { parseDhanDividend, parseDhanLedger } from "@/lib/import/parsers/dhan-ledger";
import { fyOfDate } from "@/lib/analytics/ais";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * GOLDEN BOOKS — every redacted real export, end to end, with the numbers
 * PINNED.
 *
 * The fixtures under tests/fixtures/redacted/ named `<broker>-<report>-<window>`
 * are the owner's real exports run through scripts/fixtures/redact-broker-export.mjs
 * (three-row rule: every row kept, only identity tokenised; the script refuses
 * to write a copy whose detection or parse differs from the original). So what
 * is asserted here is what the app does with a REAL file, on every machine.
 *
 * Four legs per row, then a commit leg:
 *   1. detection routes to `parser` at ≥ `minScore` — under the fixture's own
 *      name, which carries the same broker fingerprint the real export's name
 *      does (`Stocks_PnL_…` → `groww-pnl-…`). Uncovered files are asserted
 *      HONESTLY: best score < 0.7 under both the own and a neutral name, so a
 *      future parser flips the row on purpose rather than by accident.
 *   2. SHAPE counts are EXACT (executions read, closed, open, opening sells) —
 *      frozen 2026-09-04. A change means the pairing changed; re-derive with a
 *      reason, never by copying the new number.
 *   3. Σ gross / net / charges within `tol` of the broker's own figure, or
 *      `reference: null` with the reason in `note` — never skipped.
 *   4. charges are conserved: a stated total equals Σ per-trade charges to
 *      ₹0.01 (or the file's own charge columns do), or the file carries none
 *      and the engine's estimate is what the commit pins.
 *   5. COMMIT: one account per row, `commitParsedFile`, select that account,
 *      and `tradeStatsOf(getJournalTrades())` must equal the pinned figures to
 *      the paisa — count = positions, open = open + opening sells (an opening
 *      sell is stored `isOpen`), and what the preview promised.
 *
 * `// DEFECT:` rows pin a parser's CURRENT wrong number so the fix flips them
 * red on purpose. They are listed for the orchestrator; nothing here fixes one.
 *
 * Dhan (owner ruling): the Global Transactions file is the BOOK and the
 * Realised P&L's four segment rows are the REFERENCE. Since 2026-09-04 the
 * GTR parser reads the 2026 `dd-mm-yyyy` date grammar, so the two GTR rows
 * carry the per-segment comparison: gross per segment against the Realised
 * P&L's segment row (equity carries the one opening sell's basis gap, pinned
 * to the paisa), the journal's charges = the broker's own per-row figures
 * conserved to the footer, and the ENGINE's estimate for the same rows pinned
 * beside the broker's figure. The P&L exports keep their segment rows too —
 * same reference, a second book.
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const r2 = (n: number) => Math.round(n * 100) / 100;

interface Segment {
  /** The broker's own segment row (Dhan Realised P&L: Gross P&L / Total Charges / Net P&L). */
  grossRef: number;
  chargesRef: number;
  netRef: number;
  /**
   * Σ Vyuha gross − the broker's segment gross, when the book legitimately
   * differs: the GTR's opening sell (basis unknown, invariant 6) is in the
   * broker's gross and not in ours. Pinned to the paisa, never a tolerance.
   */
  grossGap?: number;
  /**
   * Vyuha's engine estimate for the same rows. For a file that states no
   * per-row charges this is what the journal holds; for the GTR (which does)
   * it is computed on a copy with the broker's charges stripped, and
   * `fileCharges`/`fileNet` are what the journal holds. Frozen.
   */
  engineCharges: number;
  engineNet: number;
  fileCharges?: number;
  fileNet?: number;
}

interface Golden {
  file: string;
  /** Winning parser, or null when no parser may claim the file (honest row). */
  parser: string | null;
  minScore: number;
  /** Best claimant under the own name for an honest row (pinned so a new parser flips it). */
  honestBest?: string;
  /** frozen 2026-09-04 — a change means the pairing changed; re-derive with a reason. */
  shape: { sourceRows: number | null; closed: number; open: number; openingSells: number };
  reference: { net?: number; gross?: number; charges?: number; tol: number } | null;
  /**
   * How leg 4 proves charges: "stated" = the file states a total and per-row
   * charges (Σ rows = total to ₹0.01, or `leak` pins the current gap);
   * "columns" = per-row charges only (Σ rows = `reference.charges`, the file's
   * own column sums); "engine" = the file carries no charges at all.
   */
  charges: { mode: "stated" | "columns" | "engine"; leak?: number };
  /** Broker-stated totals the parser must carry in `reported`, as the file writes them. */
  reportedPins?: Record<string, number>;
  /** What the journal reads back after commit — to the paisa. Frozen 2026-09-04. */
  commit: { net: number; gross: number; charges: number };
  segments?: Partial<Record<"equity" | "fno" | "commodity", Segment>>;
  ledger?: { rows: number; opening: number | null; closing: number | null; mtfInterest: number; unclassified: number; sumAmount?: number };
  defect?: string;
  note: string;
}

const GOLDEN: Golden[] = [
  // ── Paytm Money ────────────────────────────────────────────────────────────
  {
    file: "paytm-tradebook-2026-04-01_2026-08-28.xlsx",
    parser: "paytm-tradebook", minScore: 0.95,
    shape: { sourceRows: 7544, closed: 693, open: 62, openingSells: 38 },
    reference: { charges: 1249096.81, tol: 0.05 },
    charges: { mode: "columns" },
    commit: { net: 16067049.23, gross: 17316146.03, charges: 1249096.8 },
    note: "7,544 executions, 281 ISINs, 35 securities relabelled ticker→BSE code. Charges = the file's six charge columns (Brokerage 58,654.30 + ETT 56,422.64 + GST 20,993.89 + STT 1,031,198.23 + SEBI 1,555.74 + Stamp 80,272.00 = 1,249,096.81; ours 1,249,096.80 after per-position rounding). No net reference: the tradebook states no P&L, and Paytm's Realized P&L (.xls, realised 21,371,252.64) includes lots bought from 22-Jan-2026, before this window — 38 opening sells here carry no basis.",
  },
  {
    file: "paytm-tradebook-2026-08-01_2026-08-18.xlsx",
    parser: "paytm-tradebook", minScore: 0.95,
    shape: { sourceRows: 414, closed: 92, open: 30, openingSells: 24 },
    reference: { charges: 198915.04, tol: 0.05 },
    charges: { mode: "columns" },
    commit: { net: 1183388.59, gross: 1382303.63, charges: 198915.04 },
    note: "The 414-execution export reconciled lot-by-lot against Paytm's own Realized P&L Detail in tests/private-reconciliation.test.ts (47 of 52 in-window ISINs within ₹25). Charges = the file's own columns, conserved to the paisa.",
  },
  {
    file: "paytm-equity-pnl-2026-04-01_2026-08-28.xls",
    parser: null, minScore: 0.7, honestBest: "generic-table",
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "Paytm Money Equity P&L (.xls, three stacked tables: Summary, Realized P&L Detail, Unrealized Transactions; realised 21,371,252.64). No parser until v3.9 — pinned at generic-table@0.05 so the v3.9 parser flips this row on purpose.",
  },
  {
    file: "paytm-equity-pnl-2026-08-01_2026-08-18.xls",
    parser: null, minScore: 0.7, honestBest: "generic-table",
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "Same layout, the window of the 414-execution tradebook; read directly (SheetJS) by tests/private-reconciliation.test.ts as the lot-level reference. Uncovered until v3.9.",
  },

  // ── Zerodha ────────────────────────────────────────────────────────────────
  {
    file: "zerodha-taxpnl-2024-04-01_2025-03-31.xlsx",
    parser: "zerodha", minScore: 1,
    shape: { sourceRows: 632, closed: 206, open: 0, openingSells: 0 },
    reference: { gross: -200260.75, charges: 34315.18, net: -234575.93, tol: 0.01 },
    charges: { mode: "columns" },
    // Re-pinned 2026-09-04: was 34,315.16 / −234,575.91 — the ₹0.02 was the per-position rounding leak, now conserved (residual on the last position).
    commit: { net: -234575.93, gross: -200260.75, charges: 34315.18 },
    note: "Console tax P&L FY24-25: 632 tradewise exits grouped per symbol + entry day + exit day into 206 positions (the parser's documented pairing). Gross = the F&O sheet's Options Realized Profit. Charges = the tradewise sheet's nine charge columns summed (34,315.18); the F&O sheet's head total 34,502.53 includes ₹187.35 of non-trade heads that belong to the ledger. Conserved to the paisa — the ₹0.02 of per-position rounding rides on the last position, and says so.",
  },
  {
    file: "zerodha-taxpnl-2025-04-01_2026-03-31.xlsx",
    parser: "zerodha", minScore: 1,
    shape: { sourceRows: 59, closed: 26, open: 0, openingSells: 0 },
    reference: { gross: -67517.25, charges: 3269.41, tol: 0.01 },
    charges: { mode: "columns" },
    // Re-pinned 2026-09-04: was 3,269.50 / −70,786.75 — ₹0.09 of per-position head rounding over 26 groups × 7 heads, now conserved to the columns' sum.
    commit: { net: -70786.66, gross: -67517.25, charges: 3269.41 },
    note: "FY25-26 tax P&L, 59 exits → 26 positions, all F&O. Charges equal the tradewise columns' sum (and the Console P&L's 3,269.4101) to the paisa; the ₹0.09 of rounding rides on the last position's largest head, noted on that trade. The NIFTY2540323750CE position entered 2025-03-28 sits here because its EXIT dates (2025-04-02/03) own the FY — proven in the combined-account block below.",
  },
  {
    file: "zerodha-console-pnl-2025-04-01_2026-03-31.xlsx",
    parser: "zerodha", minScore: 1,
    shape: { sourceRows: null, closed: 22, open: 0, openingSells: 0 },
    reference: { gross: -67517.25, tol: 0.01 },
    charges: { mode: "engine" },
    reportedPins: { charges: 3269.4101, realisedPnl: -67517.25, brokerage: 1340, sttCtt: 899, gst: 357.1643 },
    // DEFECT (by design until v3.9 reconciliation): the pinned charges are the ENGINE's
    // estimate, not the broker's. Zerodha states 3,269.41 for these very rows; the journal
    // holds 3,183.73, 85.68 under. Pinned so the number cannot drift, NOT because it is right.
    commit: { net: -70700.98, gross: -67517.25, charges: 3183.73 },
    note: "Console P&L for F&O FY25-26, 22 symbol rows, no dates (the report states none). Same book as the FY25-26 tax P&L: gross agrees to the paisa. The Summary's Charges 3,269.4101 and per-head table now travel in `reported` (pinned above); the rows state no charges, so the journal holds the engine's 3,183.73 — ₹85.68 under the broker, visible beside it rather than hidden.",
  },
  {
    file: "zerodha-tradebook-2026-04-01_2026-08-29.xlsx",
    parser: "zerodha", minScore: 1,
    shape: { sourceRows: 3530, closed: 64, open: 4, openingSells: 11 },
    reference: null,
    charges: { mode: "engine" },
    commit: { net: 751071.05, gross: 902987.4, charges: 151916.35 },
    note: "Equity tradebook, 3,530 fills / 58 symbols → 79 positions. No reference: a tradebook states no P&L and no charges (the engine's 151,916.35 is an estimate), and the Console P&L on this machine covers a different account and period.",
  },
  {
    file: "zerodha-tradebook-2026-04-01_2026-08-11.xlsx",
    parser: "zerodha", minScore: 1,
    shape: { sourceRows: 1554, closed: 15, open: 2, openingSells: 11 },
    reference: null,
    charges: { mode: "engine" },
    commit: { net: 470177.54, gross: 521783.6, charges: 51606.06 },
    note: "The 1,554-fill tradebook of tests/private-reconciliation.test.ts (28 positions, 11 opening sells with no P&L, fill times throughout). No reference for the same reason as the row above.",
  },

  // ── Dhan ───────────────────────────────────────────────────────────────────
  {
    file: "dhan-gtr-2026-04-01_2026-09-04-a1.csv",
    parser: "dhan-gtr", minScore: 0.98,
    shape: { sourceRows: 1431, closed: 1283, open: 2, openingSells: 1 },
    reference: { charges: 812563.17, tol: 0.01 },
    charges: { mode: "stated" },
    reportedPins: { grossPnl: -1093133.238, totalCharges: 812563.1735, netPnl: -1905696.411, brokerage: 278939.23 },
    commit: { net: -1906334.64, gross: -1093771.47, charges: 812563.17 },
    segments: {
      equity: { grossRef: -182651.1, chargesRef: 92379.85, netRef: -275030.96, grossGap: -638.22, fileCharges: 92380.88, fileNet: -275670.2, engineCharges: 88802.27, engineNet: -272091.59 },
      fno: { grossRef: -910662.66, chargesRef: 719326.91, netRef: -1629989.43, fileCharges: 719326.83, fileNet: -1629989.47, engineCharges: 452063.58, engineNet: -1362726.22 },
      commodity: { grossRef: 180.49, chargesRef: 855.48, netRef: -674.99, fileCharges: 855.46, fileNet: -674.97, engineCharges: 717.03, engineNet: -536.54 },
    },
    note: "THE BOOK (owner ruling): Global Transactions report, account 1 — 1,431 bill lines (dd-mm-yyyy dates, read since 2026-09-04) → 1,286 positions: 1,283 closed, 2 open, 1 opening sell (SBI Funds Management, 37 shares, basis unknown — the footer implies ₹574/share). No gross reference at file level because that opening sell is IN the broker's gross (−1,093,133.24) and not in ours (−1,093,771.47): the −638.22 gap is pinned on the equity segment. F&O ties to the Realised P&L's segment row within ₹0.02 and Commodities to the paisa. Charges are the broker's own per-row figures, conserved to the footer's Total Charges 812,563.17 (−₹0.05 of apportioning + footer rounding rides on the last position). Per segment the GTR's charges sit within ₹1.03 / ₹0.08 / ₹0.02 of the Realised P&L's rows — the two Dhan statements, not Vyuha. The ENGINE's estimate for the same rows (charges stripped, previewed) is pinned beside: 541,582.88 in total vs the broker's 812,563.17 — the engine's brokerage is the seeded plan (delivery ₹0, intraday min(₹20, 0.03%), F&O ₹20 per order at the default order count), not the ₹278,939.23 Dhan actually billed, and that plan gap is most of the difference. One commodity contract (OPT CRUDEOIL 09 Jun 2026 8000 PE) is placed on NSE by the report and classified at MCX, noted on the trade and in a warning — the rate table prices commodity contracts at MCX only, as the Realised P&L parser already assumes.",
  },
  {
    file: "dhan-gtr-2026-04-01_2026-09-03-a2.csv",
    parser: "dhan-gtr", minScore: 0.98,
    shape: { sourceRows: 209, closed: 174, open: 3, openingSells: 1 },
    reference: { charges: 81058.88, tol: 0.01 },
    charges: { mode: "stated" },
    reportedPins: { grossPnl: -152158.278, totalCharges: 81058.8768, netPnl: -233217.1548, brokerage: 24610.02 },
    commit: { net: -233883.18, gross: -152824.3, charges: 81058.88 },
    segments: {
      equity: { grossRef: -101171.29, chargesRef: 48311.04, netRef: -149482.29, grossGap: -665.98, fileCharges: 48489.06, fileNet: -150326.33, engineCharges: 50773.5, engineNet: -152610.77 },
      fno: { grossRef: -50987.04, chargesRef: 32569.85, netRef: -83556.88, fileCharges: 32569.82, fileNet: -83556.85, engineCharges: 14180.37, engineNet: -65167.4 },
    },
    note: "Global Transactions report, account 2 — 209 bill lines → 178 positions (174 closed, 3 open, 1 opening sell: the same SBI Funds Management allotment, −665.98 pinned on equity). F&O ties to the Realised P&L within ₹0.01. Charges conserved to the footer's 81,058.88 (+₹0.02 rides on the last position). Equity charges 48,489.06 vs the Realised P&L's 48,311.04 — the ₹178.02 is Dhan's two statements disagreeing (the P&L export's footer says 81,058.88, the Realised P&L 80,880.89), already noted on the P&L row. Engine estimate beside the broker's: 64,953.87 vs 81,058.88, same plan-brokerage reason as account 1. No commodity rows in this account.",
  },
  {
    file: "dhan-pnl-2026-04-01_2026-09-03-a1.xlsx",
    parser: "dhan-csv", minScore: 1,
    shape: { sourceRows: null, closed: 1011, open: 2, openingSells: 0 },
    reference: { gross: -1093133.24, tol: 0.05 },
    charges: { mode: "engine" },
    // DEFECT (by design until v3.9 reconciliation): the ENGINE's estimate stands in for
    // charges this file does not state — 719,936.21 against the broker's own 812,563.17,
    // with equity over-estimated ~3x (277,765.57 vs 92,379.85: no product column, so every
    // equity row is assumed delivery and pays delivery STT) and F&O under-estimated ~39%
    // (seeded plan brokerage, not the 278,939.23 Dhan billed). Frozen, not endorsed.
    commit: { net: -1813069.44, gross: -1093133.23, charges: 719936.21 },
    segments: {
      equity: { grossRef: -182651.1, chargesRef: 92379.85, netRef: -275030.96, engineCharges: 277765.57, engineNet: -460416.66 },
      fno: { grossRef: -910662.66, chargesRef: 719326.91, netRef: -1629989.43, engineCharges: 441500.81, engineNet: -1352163.44 },
      commodity: { grossRef: 180.49, chargesRef: 855.48, netRef: -674.99, engineCharges: 669.83, engineNet: -489.34 },
    },
    note: "P&L export, account 1: 1,013 scrip rows (2 open). Gross ties to its own footer (−1,093,133.24) and, per segment, to the Realised P&L's segment rows (same window, same book). NO net/charges reference: this file states no per-row charges, so what the journal holds is the engine's estimate — 719,936.21 against the broker's 812,563.17 (equity over-estimated 3×, F&O under-estimated 39%; the file has no product column, so equity defaults to delivery). The broker's own two files disagree with each other by ₹0.93 on charges.",
  },
  {
    file: "dhan-pnl-2026-04-01_2026-09-03-a2.xlsx",
    parser: "dhan-csv", minScore: 1,
    shape: { sourceRows: null, closed: 146, open: 3, openingSells: 0 },
    reference: { gross: -152158.28, tol: 0.05 },
    charges: { mode: "engine" },
    // DEFECT (by design until v3.9 reconciliation): engine estimate, not the broker's —
    // 165,564.67 against 81,058.88 (equity 151,668.54 vs 48,311.04, same delivery-STT
    // assumption as account 1). Frozen so it cannot drift, not because it is right.
    commit: { net: -317722.98, gross: -152158.31, charges: 165564.67 },
    segments: {
      equity: { grossRef: -101171.29, chargesRef: 48311.04, netRef: -149482.29, engineCharges: 151668.54, engineNet: -252839.81 },
      fno: { grossRef: -50987.04, chargesRef: 32569.85, netRef: -83556.88, engineCharges: 13896.13, engineNet: -64883.17 },
    },
    note: "P&L export, account 2: 149 rows (3 open). Footer gross −152,158.28; segment refs from the account-2 Realised P&L. Engine charges 165,564.67 vs the broker's 81,058.88 (this file) / 80,880.89 (Realised P&L) — Dhan's own two statements differ by ₹177.99.",
  },
  {
    file: "dhan-realised-pnl-2026-04-01_2026-09-03-a1.xls",
    parser: "dhan-realised-pnl", minScore: 1,
    shape: { sourceRows: 1011, closed: 1011, open: 0, openingSells: 0 },
    reference: { gross: -1093133.27, tol: 0.01 },
    charges: { mode: "engine" },
    // DEFECT (by design until v3.9 reconciliation): the per-scrip rows state no charges,
    // so the journal holds the engine's 719,935.15 against the broker's own segment rows'
    // 812,562.24 — equity 277,764.51 vs 92,379.85 (delivery STT assumed for every row).
    commit: { net: -1813068.42, gross: -1093133.27, charges: 719935.15 },
    segments: {
      equity: { grossRef: -182651.1, chargesRef: 92379.85, netRef: -275030.96, engineCharges: 277764.51, engineNet: -460415.61 },
      fno: { grossRef: -910662.66, chargesRef: 719326.91, netRef: -1629989.43, engineCharges: 441500.81, engineNet: -1352163.47 },
      commodity: { grossRef: 180.49, chargesRef: 855.48, netRef: -674.99, engineCharges: 669.83, engineNet: -489.34 },
    },
    note: "THE REFERENCE (owner ruling): four segment rows — Equity / Futures and Options / Commodities / Currency — with every charge head. Gross per segment ties to the paisa. The file's per-segment charges live in `reported` (broker 812,562.24 in total); the per-scrip rows carry none, so the journal's charges are the engine's — the gap per segment is pinned beside the broker's figure, not hidden. Currency row is all zeros. Kept as .xls (BIFF8).",
  },
  {
    file: "dhan-realised-pnl-2026-04-01_2026-09-03-a2.xls",
    parser: "dhan-realised-pnl", minScore: 1,
    shape: { sourceRows: 146, closed: 146, open: 0, openingSells: 0 },
    reference: { gross: -152158.33, tol: 0.01 },
    charges: { mode: "engine" },
    // DEFECT (by design until v3.9 reconciliation): engine estimate again — 165,410.93
    // against the broker's 80,880.89 (equity 151,514.80 vs 48,311.04). Frozen, not endorsed.
    commit: { net: -317569.26, gross: -152158.33, charges: 165410.93 },
    segments: {
      equity: { grossRef: -101171.29, chargesRef: 48311.04, netRef: -149482.29, engineCharges: 151514.8, engineNet: -252686.09 },
      fno: { grossRef: -50987.04, chargesRef: 32569.85, netRef: -83556.88, engineCharges: 13896.13, engineNet: -64883.17 },
    },
    note: "Account-2 Realised P&L: Equity and F&O only (Commodities and Currency rows are zero). Kept as .xls (BIFF8).",
  },
  {
    file: "dhan-ledger-2026-04-01_2026-09-03-a1.csv",
    parser: "dhan-ledger", minScore: 1,
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    ledger: { rows: 230, opening: 78735.13, closing: 998.31, mtfInterest: 10257.17, unclassified: 5 },
    note: "Ledger, account 1: not a trade source (the parser returns no trades by design and says so); the cash figures are pinned through parseDhanLedger — opening 78,735.13, closing 998.31, 9 MTF interest postings totalling 10,257.17, 5 narrations left for review.",
  },
  {
    file: "dhan-ledger-2026-04-01_2026-09-03-a2.csv",
    parser: "dhan-ledger", minScore: 1,
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    ledger: { rows: 121, opening: 0, closing: 8860.6, mtfInterest: 85632.19, unclassified: 7 },
    note: "Ledger, account 2: the opening-balance row is stamped 01-01-1970 (the epoch row) and the parser reads it as opening 0 with the first real posting on 2026-06-27; closing 8,860.60.",
  },
  {
    file: "dhan-dividend-2025-04-01_2026-03-31.csv",
    parser: "dhan-dividend", minScore: 1,
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    ledger: { rows: 1, opening: null, closing: null, mtfInterest: 0, unclassified: 0, sumAmount: 1250 },
    note: "Dividend payout report FY25-26: one row, ₹1,250 (2,500 × ₹0.50).",
  },

  // ── Groww ──────────────────────────────────────────────────────────────────
  {
    file: "groww-orders-2025-04-01_2026-03-31.xlsx",
    parser: "groww-orders", minScore: 0.95,
    shape: { sourceRows: 952, closed: 466, open: 1, openingSells: 16 },
    reference: null,
    charges: { mode: "engine" },
    commit: { net: -531351.44, gross: -429051.19, charges: 102300.25 },
    note: "Order history FY25-26, 952 executed orders → 483 positions. No reference: Groww's own P&L for the same year states realised −637,838 over LOTS, including ones bought before this window (16 opening sells here carry no basis, invariant 6), and its charges 152,274.81 include ₹45,891.62 of MTF interest and pledge fees the engine does not estimate from an order list.",
  },
  {
    file: "groww-pnl-2025-04-01_2026-03-31.xlsx",
    parser: "groww-xlsx", minScore: 0.95,
    shape: { sourceRows: null, closed: 490, open: 2, openingSells: 0 },
    reference: { gross: -637838, tol: 0.01 },
    charges: { mode: "engine" },
    commit: { net: -739596.5, gross: -637838, charges: 101758.5 },
    note: "Scrip-level P&L FY25-26 (Trade Level 491 realised rows + Scrip Level): gross ties to the file's Realised P&L. Under a NEUTRAL filename this file scores only 0.55 — the claim needs Groww's `stocks_pnl` filename, which the real export always has. Charges reference omitted: the file's 152,274.81 total includes MTF interest (45,891.62), DP and pledge heads; the scrip rows carry no charges, so the journal holds the engine's 101,758.50.",
  },

  // ── Angel One ──────────────────────────────────────────────────────────────
  {
    file: "angelone-trades-history-2026-04-01_2026-09-02.xlsx",
    parser: "angelone", minScore: 0.95,
    shape: { sourceRows: 24, closed: 8, open: 1, openingSells: 0 },
    reference: { charges: 157.79, tol: 0.01 },
    charges: { mode: "stated" },
    // Re-pinned 2026-09-04: was 157.76 / −10.72 — the ₹0.03 was never lost by the fold (the 24 rows sum to 157.76); Angel's summary is computed unrounded (GST 22.85 vs rows 22.84, SEBI 0.02 vs 0.00). Conserved to the stated Total Trade Charges, residual on the last contract.
    commit: { net: -10.75, gross: 147.04, charges: 157.79 },
    note: "Trades_History: 24 rows read, 17 trades stated, 9 positions (1 open). No P&L reference — the file states charges, not P&L. Charges equal the file's Total Trade Charges 157.79 (Total Charges 252.19 less 94.40 non-trade) to the paisa: the six quantity-0 per-order lines fold in losslessly, and the ₹0.03 by which Angel's own unrounded summary exceeds its rounded rows rides on the last contract, noted there.",
  },
  {
    file: "angelone-taxpnl-fy2026-27.xlsx",
    parser: "angelone-taxpnl", minScore: 0.95,
    shape: { sourceRows: null, closed: 9, open: 0, openingSells: 0 },
    reference: { net: -6.87, charges: 157.86, tol: 0.02 },
    charges: { mode: "columns" },
    commit: { net: -6.86, gross: 150.99, charges: 157.85 },
    note: "Tax P&L FY26-27: Net P&L −3.50 (equity) + −3.37 (options) = −6.87 stated; ours −6.86 (gross 150.99 − charges 157.85), ₹0.01 of per-row rounding. Charges reference = the summary cells 'Total Charges and Statutory' 4.24 (equity) + 145.62 (F&O) plus the separately stated Total STT 1 + 7 = 157.86; ours 157.85.",
  },
  {
    file: "angelone-profitloss-2026-08-01_2026-08-31.xlsx",
    parser: null, minScore: 0.7, honestBest: "angelone",
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "ProfitLoss_Statement (Equity P&L + F&O P&L summary sheets, 10 + 8 merged ranges). No parser: angelone scores 0.30 on the own name (name only, no header it recognises) and generic-table 0.05 neutral. Pinned so a parser flips it on purpose.",
  },
  {
    file: "angelone-statement-2026-08-01_2026-08-31.xlsx",
    parser: null, minScore: 0.7, honestBest: "angelone",
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "YourStatement (Broking Ledger + Charges sheets; opening 0, closing 1,417.56). No parser: 0.30 own name / 0.05 neutral.",
  },

  // ── Upstox ─────────────────────────────────────────────────────────────────
  {
    file: "upstox-realised-pnl-2026-08-28_2026-09-04.xlsx",
    parser: "upstox", minScore: 0.95,
    shape: { sourceRows: null, closed: 1, open: 0, openingSells: 0 },
    reference: { gross: -1.05, net: -4.28, charges: 3.23, tol: 0.01 },
    charges: { mode: "engine" },
    commit: { net: -4.28, gross: -1.05, charges: 3.23 },
    note: "The first POPULATED Upstox export (one realised row): gross −1.05, net −4.28, charges 3.23 as the broker states them. The parser carries no per-row charges, so the reference is met by the ENGINE's estimate — which lands on the broker's paisa here.",
  },
  {
    file: "upstox-trade-2026-08-28_2026-09-04.xlsx",
    parser: "upstox", minScore: 0.75,
    shape: { sourceRows: null, closed: 4, open: 0, openingSells: 0 },
    reference: null,
    charges: { mode: "engine" },
    commit: { net: -271.9, gross: -135.45, charges: 136.45 },
    note: "Trade report, 11 execution rows → 4 positions; the parser sets no `sourceRows`, so the screen cannot say '11 executions → 4 positions' for this file (noted, not pinned as a defect — no rule requires it). No reference: a trade report states neither P&L nor charges.",
  },
  {
    file: "upstox-ledger-2025-07-19_2026-09-04.xlsx",
    parser: null, minScore: 0.7, honestBest: "upstox",
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "Ledger (4 data rows, wallet/narration/debit/credit). No parser: upstox scores 0.30 on the own name (name only) and generic-table 0.05 neutral.",
  },
];

// ── Harness ──────────────────────────────────────────────────────────────────

let t: TempDb;
let commitMod: typeof import("@/lib/import/commit");
let tradesMod: typeof import("@/lib/queries/trades");

beforeAll(async () => {
  t = await openTempDb("golden-books", { seed: true });
  commitMod = await import("@/lib/import/commit");
  tradesMod = await import("@/lib/queries/trades");
});
afterAll(() => t?.cleanup());

function newAccount(id: number, name: string) {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

const family = (segment: string): "equity" | "fno" | "commodity" | "currency" =>
  /^eq_/.test(segment) ? "equity" : /commodity/.test(segment) ? "commodity" : /currency/.test(segment) ? "currency" : "fno";

const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));

GOLDEN.forEach((row, i) => {
  describe(row.file, () => {
    const bytes = fs.readFileSync(path.join(DIR, row.file));
    const own = buildContext(row.file, bytes);
    const neutral = buildContext("export" + path.extname(row.file), bytes);
    let parsed: ParsedFile | null = null;

    beforeAll(async () => {
      if (row.parser) parsed = await rankParsers(own)[0].parse(own);
    });

    it(`1 · detection routes to ${row.parser ?? "no parser (honest)"}`, () => {
      const best = rankParsers(own)[0];
      if (row.parser) {
        expect(best.sourceId).toBe(row.parser);
        expect(best.confidence).toBeGreaterThanOrEqual(row.minScore);
      } else {
        // Honest state: nothing may claim it, under either name.
        expect(best.sourceId).toBe(row.honestBest);
        expect(best.confidence).toBeLessThan(0.7);
        expect(rankParsers(neutral)[0].confidence).toBeLessThan(0.7);
      }
    });

    it("2 · shape is exact (frozen 2026-09-04)", () => {
      if (!parsed) {
        expect(row.shape).toEqual({ sourceRows: null, closed: 0, open: 0, openingSells: 0 });
        return;
      }
      const tr = parsed.trades;
      const openingSells = tr.filter((x) => x.basisUnknown).length;
      const open = tr.filter((x) => !x.basisUnknown && x.buyQty !== x.sellQty).length;
      expect({ sourceRows: parsed.sourceRows ?? null, closed: tr.length - open - openingSells, open, openingSells }).toEqual(row.shape);
    });

    it(`3 · ${row.reference ? "reference within tolerance" : "reference honestly null: " + row.note.slice(0, 60) + "…"}`, () => {
      if (!row.reference) {
        expect(row.reference).toBeNull();
        expect(row.note.length).toBeGreaterThan(40); // the reason is stated
        return;
      }
      const tr = parsed!.trades;
      const gross = sum(tr.map((x) => x.grossPnl));
      const perRow = sum(tr.map((x) => x.reportedCharges?.total ?? 0));
      // Parser-side when the file states per-row charges; otherwise the
      // journal's engine figures (pinned in `commit`) are the only net/charges.
      const side = perRow > 0 ? { gross, charges: perRow, net: r2(gross - perRow) } : { gross, charges: row.commit.charges, net: row.commit.net };
      const { tol } = row.reference;
      if (row.reference.gross != null) expect(Math.abs(side.gross - row.reference.gross)).toBeLessThanOrEqual(tol);
      if (row.reference.net != null) expect(Math.abs(side.net - row.reference.net)).toBeLessThanOrEqual(tol);
      if (row.reference.charges != null) expect(Math.abs(side.charges - row.reference.charges)).toBeLessThanOrEqual(tol);
    });

    it(`4 · charges conserved (${row.charges.mode})`, () => {
      if (!parsed) return expect(row.charges.mode).toBe("engine");
      const perRow = sum(parsed.trades.map((x) => x.reportedCharges?.total ?? 0));
      const stated = parsed.reported?.totalCharges ?? parsed.reported?.total ?? null;
      switch (row.charges.mode) {
        case "stated":
          expect(stated).not.toBeNull();
          // DEFECT rows pin the current leak exactly; a fix flips this red.
          // (`|| 0` folds a −0 from r2(−0.003) into 0 — toBe is Object.is.)
          expect(r2(stated! - perRow) || 0).toBe(row.charges.leak ?? 0);
          break;
        case "columns":
          expect(perRow).toBeGreaterThan(0);
          expect(Math.abs(perRow - row.reference!.charges!)).toBeLessThanOrEqual(row.reference!.tol);
          break;
        case "engine":
          expect(perRow).toBe(0); // the file carries no per-row charges — see `commit.charges`
          break;
      }
      // The broker's stated totals, carried as the file writes them.
      if (row.reportedPins) expect(parsed.reported).toMatchObject(row.reportedPins);
    });

    it("5 · commit lands in the journal to the paisa", () => {
      const acct = 1000 + i;
      newAccount(acct, row.file);
      if (!parsed) {
        expect(tradesMod.getJournalTrades()).toHaveLength(0);
        return;
      }
      const positions = row.shape.closed + row.shape.open + row.shape.openingSells;
      const preview = commitMod.previewParsedFile(parsed, null, acct);
      const res = commitMod.commitParsedFile(parsed, row.file, null, acct);
      expect(res.added).toBe(positions);
      expect(res.skipped).toBe(0);
      expect(res.shape).toMatchObject({ sourceRows: row.shape.sourceRows, positions, open: row.shape.open, openingSells: row.shape.openingSells });

      const stats = tradesMod.tradeStatsOf(tradesMod.getJournalTrades());
      expect(stats).toEqual({ count: positions, open: row.shape.open + row.shape.openingSells, ...row.commit });
      // …and it is exactly what the preview promised and what the parser summed.
      expect(stats.net).toBe(r2(preview.summary.netPnl));
      expect(stats.gross).toBe(r2(preview.summary.grossPnl));
      expect(stats.charges).toBe(r2(preview.summary.chargesTotal));
      expect(stats.gross).toBe(sum(parsed.trades.map((x) => x.grossPnl)));
    });

    if (row.segments) {
      it("6 · Dhan segments: gross ties to the broker's segment row; engine charges/net pinned beside the broker's", () => {
        const rows = tradesMod.getJournalTrades();
        const by: Record<string, { gross: number[]; charges: number[]; net: number[] }> = {};
        for (const r of rows) (by[family(r.segment)] ??= { gross: [], charges: [], net: [] }).gross.push(r.grossPnl);
        for (const r of rows) { by[family(r.segment)].charges.push(r.chargesTotal); by[family(r.segment)].net.push(r.netPnl); }
        // For a book whose charges are the broker's own (the GTR), the engine's
        // estimate is computed on a copy with those charges stripped, so the
        // rate table's view of the same rows is pinned beside the broker's.
        const engine: Record<string, { charges: number; net: number }> = {};
        if (Object.values(row.segments!).some((s) => s.fileCharges != null)) {
          const stripped = { ...parsed!, trades: parsed!.trades.map((x) => ({ ...x, reportedCharges: undefined })) };
          for (const r of commitMod.previewParsedFile(stripped, null, 1000 + i).rows) {
            const e = (engine[family(r.segment)] ??= { charges: 0, net: 0 });
            e.charges = r2(e.charges + r.chargesTotal);
            e.net = r2(e.net + r.netPnl);
          }
        }
        for (const [key, seg] of Object.entries(row.segments!) as Array<[keyof NonNullable<Golden["segments"]>, Segment]>) {
          const got = by[key];
          expect(got, `no ${key} rows`).toBeDefined();
          // Gross ties to the broker's segment row — after the pinned gap, where the book legitimately has one.
          expect(Math.abs(sum(got.gross) - (seg.grossRef + (seg.grossGap ?? 0)))).toBeLessThanOrEqual(0.05);
          if (seg.fileCharges != null) {
            expect(sum(got.charges)).toBe(seg.fileCharges);
            expect(sum(got.net)).toBe(seg.fileNet);
            expect(engine[key].charges).toBe(seg.engineCharges);
            expect(engine[key].net).toBe(seg.engineNet);
          } else {
            expect(sum(got.charges)).toBe(seg.engineCharges);
            expect(sum(got.net)).toBe(seg.engineNet);
          }
          // The reference itself is what the broker wrote, not a typed number.
          if (row.parser === "dhan-realised-pnl") {
            expect(parsed!.reported![`${key}.grossPnl`]).toBe(seg.grossRef);
            expect(parsed!.reported![`${key}.totalCharges`]).toBe(seg.chargesRef);
            expect(parsed!.reported![`${key}.netPnl`]).toBe(seg.netRef);
          }
          // Dhan's own row does not foot to the paisa: gross − total charges misses net by
          // ₹0.01 (equity) and ₹0.14 (F&O) on account 1, ₹0.04 (equity) on account 2.
          expect(Math.abs(r2(seg.grossRef - seg.chargesRef) - seg.netRef)).toBeLessThanOrEqual(0.15);
        }
        expect(by.currency).toBeUndefined(); // Vyuha has no currency segment; the row is zero in both files
        if (row.parser === "dhan-realised-pnl") {
          for (const k of ["grossPnl", "totalCharges", "netPnl"]) expect(parsed!.reported![`currency.${k}`]).toBe(0);
        }
      });
    }

    if (row.ledger) {
      it("6 · ledger figures pinned through the cash parser", () => {
        const L = /dividend/.test(row.file) ? parseDhanDividend(own.text!) : parseDhanLedger(own.text!);
        expect(L.rows).toHaveLength(row.ledger!.rows);
        expect(L.openingBalance).toBe(row.ledger!.opening);
        expect(L.rows[L.rows.length - 1]?.balance ?? null).toBe(row.ledger!.closing);
        expect(r2(L.mtfInterestTotal)).toBe(row.ledger!.mtfInterest);
        expect(L.unclassified).toHaveLength(row.ledger!.unclassified);
        if (row.ledger!.sumAmount != null) expect(sum(L.rows.map((r) => r.amount))).toBe(row.ledger!.sumAmount);
      });
    }
  });
});

describe("Zerodha: both tax P&Ls into ONE account — the exit date owns the FY", () => {
  const files = ["zerodha-taxpnl-2024-04-01_2025-03-31.xlsx", "zerodha-taxpnl-2025-04-01_2026-03-31.xlsx"];
  const batches: number[] = [];

  it("re-import of FY24-25 + FY25-26 reads 691 exits and books 232 positions", async () => {
    newAccount(2000, "zerodha-both-fys");
    let exits = 0;
    for (const f of files) {
      const ctx = buildContext(f, fs.readFileSync(path.join(DIR, f)));
      const parsed = await rankParsers(ctx)[0].parse(ctx);
      const res = commitMod.commitParsedFile(parsed, f, null, 2000);
      expect(res.skipped).toBe(0);
      exits += res.shape.sourceRows ?? 0;
      batches.push(res.batchId);
    }
    expect(exits).toBe(691); // 632 + 59 tradewise exits (owner ruling)
    const rows = tradesMod.getJournalTrades();
    expect(rows).toHaveLength(232); // 206 + 26 positions, none duplicated across the two files
    // Re-pinned 2026-09-04: 37,584.59 = 34,315.18 + 3,269.41, both files conserved to their columns (was 37,584.66).
    expect(tradesMod.tradeStatsOf(rows)).toEqual({ count: 232, open: 0, net: -305362.59, gross: -267778, charges: 37584.59 });
  });

  it("the NIFTY2540323750CE position entered 2025-03-28 lands in FY25-26 by its exit dates", () => {
    const nifty = tradesMod.getJournalTrades().filter((r) => r.tradingsymbol === "NIFTY2540323750CE");
    expect(nifty.map((r) => [r.buyDate, r.sellDate, fyOfDate(r.sellDate!)]).sort()).toEqual([
      ["2025-03-28", "2025-03-28", "2024-25"], // the same-day exit stays in FY24-25 — by exit date, not by entry
      ["2025-03-28", "2025-04-02", "2025-26"],
      ["2025-03-28", "2025-04-03", "2025-26"],
    ]);
    // …and each came from the file whose window holds its exit.
    const [fy2425, fy2526] = batches;
    for (const r of nifty) expect(r.importBatchId).toBe(fyOfDate(r.sellDate!) === "2024-25" ? fy2425 : fy2526);
  });
});
