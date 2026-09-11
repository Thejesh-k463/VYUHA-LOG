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
    parser: "paytm-realised-pnl", minScore: 0.9,
    shape: { sourceRows: 918, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "Paytm Money Equity P&L (.xls, three stacked tables: Summary, Realized P&L Detail, Unrealized Transactions; realised 21,371,252.64). FLIPPED 2026-09-04: the v3.9 `paytm-realised-pnl` parser claims it, as the honest row said a parser one day would. It is a REFERENCE source, not a book — 918 stated lot lines become 703 broker-stated reference figures and ZERO trades, so every trade count and every commit figure is legitimately 0. The realised total is Paytm's, over lots bought before this window; Vyuha's own book for the same period is the tradebook row above.",
  },
  {
    file: "paytm-equity-pnl-2026-08-01_2026-08-18.xls",
    parser: "paytm-realised-pnl", minScore: 0.9,
    shape: { sourceRows: 124, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "Same layout, the window of the 414-execution tradebook; read directly (SheetJS) by tests/private-reconciliation.test.ts as the lot-level reference. FLIPPED 2026-09-04 to `paytm-realised-pnl`: 124 stated lot lines → 102 reference figures, no trades, so the shape and commit figures are zero by design and not by omission.",
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
    // holds 3,193.75, 75.66 under. Pinned so the number cannot drift, NOT because it is right.
    // C-8: charges 3,183.73 → 3,193.75, net −70,700.98 → −70,711.00; vs Zerodha's stated 3,269.41 CLOSER (−85.68 → −75.66) — no dates, so priced today at NSE FA73061's option rate.
    commit: { net: -70711, gross: -67517.25, charges: 3193.75 },
    note: "Console P&L for F&O FY25-26, 22 symbol rows, no dates (the report states none). Same book as the FY25-26 tax P&L: gross agrees to the paisa. The Summary's Charges 3,269.4101 and per-head table now travel in `reported` (pinned above); the rows state no charges, so the journal holds the engine's 3,193.75 — ₹75.66 under the broker, visible beside it rather than hidden.",
  },
  {
    file: "zerodha-tradebook-2026-04-01_2026-08-29.xlsx",
    parser: "zerodha", minScore: 1,
    shape: { sourceRows: 3530, closed: 64, open: 4, openingSells: 11 },
    reference: null,
    charges: { mode: "engine" },
    // C-8: charges 151,916.35 → 152,074.08, net 751,071.05 → 750,913.32; no broker-stated charges — NSE cash from 1 Mar 2026 is FA73061's Rs 306.99 + IPFT 0.01/crore (was 297 + 0.01).
    // R71 (4.3.0): charges 152,074.08 → 152,143.88, net 750,913.32 → 750,843.52, gross unchanged — a row's exchange is now the venue of most of its OWN turnover, not its security's first leg: 5 rows NSE → BSE, 3 BSE → NSE (NSE/BSE 52/27 → 50/29).
    commit: { net: 750843.52, gross: 902987.4, charges: 152143.88 },
    note: "Equity tradebook, 3,530 fills / 58 symbols → 79 positions. No reference: a tradebook states no P&L and no charges (the engine's 152,143.88 is an estimate), and the Console P&L on this machine covers a different account and period.",
  },
  {
    file: "zerodha-tradebook-2026-04-01_2026-08-11.xlsx",
    parser: "zerodha", minScore: 1,
    shape: { sourceRows: 1554, closed: 15, open: 2, openingSells: 11 },
    reference: null,
    charges: { mode: "engine" },
    // C-8: charges 51,606.06 → 51,650.91, net 470,177.54 → 470,132.69; no broker-stated charges — NSE cash from 1 Mar 2026 at FA73061's rate.
    // R71 (4.3.0): charges 51,650.91 → 51,614.70, net 470,132.69 → 470,168.90, gross unchanged — the row's own venue: 1 row NSE → BSE, 2 BSE → NSE (21/7 → 22/6).
    commit: { net: 470168.9, gross: 521783.6, charges: 51614.7 },
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
      // C-8: engine 88,802.27 → 89,094.55 (net −272,091.59 → −272,383.87) vs the file's 92,380.88, CLOSER; its exchange line is +0.07 vs the Realised P&L's 7,610.05 (was −247.93).
      equity: { grossRef: -182651.1, chargesRef: 92379.85, netRef: -275030.96, grossGap: -638.22, fileCharges: 92380.88, fileNet: -275670.2, engineCharges: 89094.55, engineNet: -272383.87 },
      // C-8: engine 452,063.58 → 453,210.04 (net −1,362,726.22 → −1,363,872.68) vs the file's 719,326.83, CLOSER; exchange line −0.13 vs the Realised P&L's 117,806.31 (was −971.88).
      fno: { grossRef: -910662.66, chargesRef: 719326.91, netRef: -1629989.43, fileCharges: 719326.83, fileNet: -1629989.47, engineCharges: 453210.04, engineNet: -1363872.68 },
      commodity: { grossRef: 180.49, chargesRef: 855.48, netRef: -674.99, fileCharges: 855.46, fileNet: -674.97, engineCharges: 717.03, engineNet: -536.54 },
    },
    note: "THE BOOK (owner ruling): Global Transactions report, account 1 — 1,431 bill lines (dd-mm-yyyy dates, read since 2026-09-04) → 1,286 positions: 1,283 closed, 2 open, 1 opening sell (SBI Funds Management, 37 shares, basis unknown — the footer implies ₹574/share). No gross reference at file level because that opening sell is IN the broker's gross (−1,093,133.24) and not in ours (−1,093,771.47): the −638.22 gap is pinned on the equity segment. F&O ties to the Realised P&L's segment row within ₹0.02 and Commodities to the paisa. Charges are the broker's own per-row figures, conserved to the footer's Total Charges 812,563.17 (−₹0.05 of apportioning + footer rounding rides on the last position). Per segment the GTR's charges sit within ₹1.03 / ₹0.08 / ₹0.02 of the Realised P&L's rows — the two Dhan statements, not Vyuha. The ENGINE's estimate for the same rows (charges stripped, previewed) is pinned beside: 543,021.62 in total vs the broker's 812,563.17 — the engine's brokerage is the seeded plan (delivery ₹0, intraday min(₹20, 0.03%), F&O ₹20 per order at the default order count), not the ₹278,939.23 Dhan actually billed, and that plan gap is most of the difference. One commodity contract (OPT CRUDEOIL 09 Jun 2026 8000 PE) is placed on NSE by the report and classified at MCX, noted on the trade and in a warning — the rate table prices commodity contracts at MCX only, as the Realised P&L parser already assumes.",
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
      // C-8: engine 50,773.50 → 50,932.89 (net −152,610.77 → −152,770.16) vs the file's 48,489.06, FURTHER (+2,284.44 → +2,443.83): the engine already overshot this equity book on its other heads (pre-existing, not diagnosed here); its exchange line is +4.08 vs the Realised P&L's 4,146.81 (was −130.99).
      equity: { grossRef: -101171.29, chargesRef: 48311.04, netRef: -149482.29, grossGap: -665.98, fileCharges: 48489.06, fileNet: -150326.33, engineCharges: 50932.89, engineNet: -152770.16 },
      // C-8: engine 14,180.37 → 14,206.14 (net −65,167.40 → −65,193.17) vs the file's 32,569.82, CLOSER; exchange line +0.01 vs the Realised P&L's 3,342.23 (was −21.85).
      fno: { grossRef: -50987.04, chargesRef: 32569.85, netRef: -83556.88, fileCharges: 32569.82, fileNet: -83556.85, engineCharges: 14206.14, engineNet: -65193.17 },
    },
    note: "Global Transactions report, account 2 — 209 bill lines → 178 positions (174 closed, 3 open, 1 opening sell: the same SBI Funds Management allotment, −665.98 pinned on equity). F&O ties to the Realised P&L within ₹0.01. Charges conserved to the footer's 81,058.88 (+₹0.02 rides on the last position). Equity charges 48,489.06 vs the Realised P&L's 48,311.04 — the ₹178.02 is Dhan's two statements disagreeing (the P&L export's footer says 81,058.88, the Realised P&L 80,880.89), already noted on the P&L row. Engine estimate beside the broker's: 65,139.03 vs 81,058.88, same plan-brokerage reason as account 1. No commodity rows in this account.",
  },
  {
    file: "dhan-pnl-2026-04-01_2026-09-03-a1.xlsx",
    parser: "dhan-csv", minScore: 1,
    shape: { sourceRows: null, closed: 1011, open: 2, openingSells: 0 },
    reference: { gross: -1093133.24, tol: 0.05 },
    charges: { mode: "engine" },
    // DEFECT (by design until v3.9 reconciliation): the ENGINE's estimate stands in for
    // charges this file does not state — 721,374.93 against the broker's own 812,563.17,
    // with equity over-estimated ~3x (278,057.84 vs 92,379.85: no product column, so every
    // equity row is assumed delivery and pays delivery STT) and F&O under-estimated ~38%
    // (seeded plan brokerage, not the 278,939.23 Dhan billed). Frozen, not endorsed.
    // C-8: charges 719,936.21 → 721,374.93, net −1,813,069.44 → −1,814,508.16; vs the broker's 812,563.17 CLOSER overall.
    commit: { net: -1814508.16, gross: -1093133.23, charges: 721374.93 },
    segments: {
      // C-8: engine 277,765.57 → 278,057.84 (net −460,416.66 → −460,708.93) vs 92,379.85, FURTHER: the product-less export charges delivery STT on every equity row (pre-existing); the exchange line itself is +0.77 vs the Realised P&L's 7,610.05 (was −246.95).
      equity: { grossRef: -182651.1, chargesRef: 92379.85, netRef: -275030.96, engineCharges: 278057.84, engineNet: -460708.93 },
      // C-8: engine 441,500.81 → 442,647.26 (net −1,352,163.44 → −1,353,309.89) vs 719,326.91, CLOSER; exchange line −0.21 (was −971.92).
      fno: { grossRef: -910662.66, chargesRef: 719326.91, netRef: -1629989.43, engineCharges: 442647.26, engineNet: -1353309.89 },
      commodity: { grossRef: 180.49, chargesRef: 855.48, netRef: -674.99, engineCharges: 669.83, engineNet: -489.34 },
    },
    note: "P&L export, account 1: 1,013 scrip rows (2 open). Gross ties to its own footer (−1,093,133.24) and, per segment, to the Realised P&L's segment rows (same window, same book). NO net/charges reference: this file states no per-row charges, so what the journal holds is the engine's estimate — 721,374.93 against the broker's 812,563.17 (equity over-estimated 3×, F&O under-estimated 39%; the file has no product column, so equity defaults to delivery). The broker's own two files disagree with each other by ₹0.93 on charges.",
  },
  {
    file: "dhan-pnl-2026-04-01_2026-09-03-a2.xlsx",
    parser: "dhan-csv", minScore: 1,
    shape: { sourceRows: null, closed: 146, open: 3, openingSells: 0 },
    reference: { gross: -152158.28, tol: 0.05 },
    charges: { mode: "engine" },
    // DEFECT (by design until v3.9 reconciliation): engine estimate, not the broker's —
    // 165,749.95 against 81,058.88 (equity 151,828.01 vs 48,311.04, same delivery-STT
    // assumption as account 1). Frozen so it cannot drift, not because it is right.
    // C-8: charges 165,564.67 → 165,749.95, net −317,722.98 → −317,908.26; vs 81,058.88 FURTHER, the equity delivery-STT assumption below.
    commit: { net: -317908.26, gross: -152158.31, charges: 165749.95 },
    segments: {
      // C-8: engine 151,668.54 → 151,828.01 (net −252,839.81 → −252,999.28) vs 48,311.04, FURTHER: delivery STT on every equity row (pre-existing); exchange line +4.71 vs the Realised P&L's 4,146.81 (was −130.37).
      equity: { grossRef: -101171.29, chargesRef: 48311.04, netRef: -149482.29, engineCharges: 151828.01, engineNet: -252999.28 },
      // C-8: engine 13,896.13 → 13,921.94 (net −64,883.17 → −64,908.98) vs 32,569.85, CLOSER; exchange line +0.01 (was −21.87).
      fno: { grossRef: -50987.04, chargesRef: 32569.85, netRef: -83556.88, engineCharges: 13921.94, engineNet: -64908.98 },
    },
    note: "P&L export, account 2: 149 rows (3 open). Footer gross −152,158.28; segment refs from the account-2 Realised P&L. Engine charges 165,749.95 vs the broker's 81,058.88 (this file) / 80,880.89 (Realised P&L) — Dhan's own two statements differ by ₹177.99.",
  },
  {
    file: "dhan-realised-pnl-2026-04-01_2026-09-03-a1.xls",
    parser: "dhan-realised-pnl", minScore: 1,
    shape: { sourceRows: 1011, closed: 1011, open: 0, openingSells: 0 },
    reference: { gross: -1093133.27, tol: 0.01 },
    charges: { mode: "engine" },
    // DEFECT (by design until v3.9 reconciliation): the per-scrip rows state no charges,
    // so the journal holds the engine's 721,373.87 against the broker's own segment rows'
    // 812,562.24 — equity 278,056.78 vs 92,379.85 (delivery STT assumed for every row).
    // C-8: charges 719,935.15 → 721,373.87, net −1,813,068.42 → −1,814,507.14; vs 812,562.24 CLOSER overall.
    commit: { net: -1814507.14, gross: -1093133.27, charges: 721373.87 },
    segments: {
      // C-8: engine 277,764.51 → 278,056.78 (net −460,415.61 → −460,707.88) vs 92,379.85, FURTHER: delivery STT on every equity row (pre-existing); exchange line +0.72 vs this file's 7,610.05 (was −247.00).
      equity: { grossRef: -182651.1, chargesRef: 92379.85, netRef: -275030.96, engineCharges: 278056.78, engineNet: -460707.88 },
      // C-8: engine 441,500.81 → 442,647.26 (net −1,352,163.47 → −1,353,309.92) vs 719,326.91, CLOSER; exchange line −0.21 vs 117,806.31 (was −971.92).
      fno: { grossRef: -910662.66, chargesRef: 719326.91, netRef: -1629989.43, engineCharges: 442647.26, engineNet: -1353309.92 },
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
    // DEFECT (by design until v3.9 reconciliation): engine estimate again — 165,596.05
    // against the broker's 80,880.89 (equity 151,674.11 vs 48,311.04). Frozen, not endorsed.
    // C-8: charges 165,410.93 → 165,596.05, net −317,569.26 → −317,754.38; vs 80,880.89 FURTHER, the equity delivery-STT assumption below.
    commit: { net: -317754.38, gross: -152158.33, charges: 165596.05 },
    segments: {
      // C-8: engine 151,514.80 → 151,674.11 (net −252,686.09 → −252,845.40) vs 48,311.04, FURTHER: delivery STT on every equity row (pre-existing); exchange line +0.69 vs this file's 4,146.81 (was −134.26).
      equity: { grossRef: -101171.29, chargesRef: 48311.04, netRef: -149482.29, engineCharges: 151674.11, engineNet: -252845.4 },
      // C-8: engine 13,896.13 → 13,921.94 (net −64,883.17 → −64,908.98) vs 32,569.85, CLOSER; exchange line +0.01 vs 3,342.23 (was −21.87).
      fno: { grossRef: -50987.04, chargesRef: 32569.85, netRef: -83556.88, engineCharges: 13921.94, engineNet: -64908.98 },
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
    file: "dhan-dp-charges-2026-04-01_2026-09-03.xls",
    parser: "dhan-dp-charges", minScore: 0.9,
    shape: { sourceRows: 173, closed: 0, open: 0, openingSells: 0 },
    reference: null,
    charges: { mode: "stated" },
    reportedPins: { totalCharges: 2492.5 },
    commit: { net: 0, gross: 0, charges: 0 },
    note: "DP charges (depository fees), account 1: 173 printed lines folded to 91 broker-stated (ISIN, date) reference figures and ZERO trades — a DP fee is not a trade, so the shape and every commit figure are zero by design. Charges are conserved the reference way: the sum of the 91 figures' `charges` equals the file's own Total row, 2,492.50, which the parser carries as `reported.totalCharges` (and `statedTotalCharges`). No P&L reference: the file states none.",
  },
  {
    file: "dhan-holdings-2026-07-01.xlsx",
    parser: "dhan-holdings", minScore: 0.9,
    shape: { sourceRows: 1, closed: 0, open: 0, openingSells: 0 },
    reference: null,
    charges: { mode: "engine" },
    reportedPins: { valuation: 1293.9, statedValuation: 1293.9, statedSecurities: 1 },
    commit: { net: 0, gross: 0, charges: 0 },
    note: "Demat holding summary as at 2026-07-01: one holding row → one broker-stated holding figure, valuation 1,293.90 as the file states it. It imports no trades — a holding is a position Vyuha did not see opened — so the shape carries only `sourceRows: 1` and every commit figure is zero. No charges anywhere in the file.",
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
    // C-8: charges 102,300.25 → 102,706.37, net −531,351.44 → −531,757.56; no charges reference (an order list states none) — FY25-26 NSE cash now carries IPFT Rs 10/crore to Feb 2026, FA73061's rate in March.
    // R71 (4.3.0): charges 102,706.37 → 102,671.60, net −531,757.56 → −531,722.79, gross unchanged — the row's own venue: 26 rows NSE → BSE, 30 BSE → NSE (411/72 → 415/68).
    commit: { net: -531722.79, gross: -429051.19, charges: 102671.6 },
    note: "Order history FY25-26, 952 executed orders → 483 positions. No reference: Groww's own P&L for the same year states realised −637,838 over LOTS, including ones bought before this window (16 opening sells here carry no basis, invariant 6), and its charges 152,274.81 include ₹45,891.62 of MTF interest and pledge fees the engine does not estimate from an order list.",
  },
  {
    file: "groww-pnl-2025-04-01_2026-03-31.xlsx",
    parser: "groww-xlsx", minScore: 0.95,
    shape: { sourceRows: null, closed: 490, open: 2, openingSells: 0 },
    reference: { gross: -637838, tol: 0.01 },
    charges: { mode: "engine" },
    // C-8: charges 101,758.50 → 102,229.63, net −739,596.50 → −740,067.63; Groww states exchange 12,327.49 + IPFT 347.69 = 12,675.18, and the engine's exchange line moved 11,854.95 → 12,254.13, CLOSER (−820.23 → −421.05).
    commit: { net: -740067.63, gross: -637838, charges: 102229.63 },
    note: "Scrip-level P&L FY25-26 (Trade Level 491 realised rows + Scrip Level): gross ties to the file's Realised P&L. Under a NEUTRAL filename this file scores only 0.55 — the claim needs Groww's `stocks_pnl` filename, which the real export always has. Charges reference omitted: the file's 152,274.81 total includes MTF interest (45,891.62), DP and pledge heads; the scrip rows carry no charges, so the journal holds the engine's 102,229.63.",
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
    parser: "angelone-pnl-statement", minScore: 0.9,
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "ProfitLoss_Statement (Equity P&L + F&O P&L summary sheets, 10 + 8 merged ranges). FLIPPED 2026-09-04 to the v3.9 `angelone-pnl-statement` parser, exactly as the honest row anticipated. It is a broker-stated P&L REFERENCE: 14 stated figures, zero trades — Angel states summary P&L, not the executions behind it — so no shape and no commit figure can be anything but zero.",
  },
  {
    file: "angelone-statement-2026-08-01_2026-08-31.xlsx",
    parser: "angelone-ledger", minScore: 0.9,
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "YourStatement (Broking Ledger + Charges sheets; opening 0, closing 1,417.56). FLIPPED 2026-09-04 to the v3.9 `angelone-ledger` parser: cash postings plus the Charges sheet as ONE broker-stated reference figure, and no trades — so the shape, the commit figures and the charge conservation are all zero because this file is a statement, not a book.",
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
    // C-8: charges 136.45 → 136.47, net −271.90 → −271.92; no broker-stated charges (a trade report states none) — NSE cash at FA73061's rate.
    commit: { net: -271.92, gross: -135.45, charges: 136.47 },
    note: "Trade report, 11 execution rows → 4 positions; the parser sets no `sourceRows`, so the screen cannot say '11 executions → 4 positions' for this file (noted, not pinned as a defect — no rule requires it). No reference: a trade report states neither P&L nor charges.",
  },
  {
    file: "upstox-ledger-2025-07-19_2026-09-04.xlsx",
    parser: "upstox-ledger", minScore: 0.9,
    shape: { sourceRows: null, closed: 0, open: 0, openingSells: 0 },
    reference: null, charges: { mode: "engine" }, commit: { net: 0, gross: 0, charges: 0 },
    note: "Ledger (4 data rows, wallet/narration/debit/credit). FLIPPED 2026-09-04: the v3.9 `upstox-ledger` parser claims it and feeds the Cash & Ledger screen. It reads cash postings, never trades — no positions, no P&L, no charges on any trade — so every figure below is zero because the file is not a book. The parser sets no `sourceRows` (it counts ledger lines, not executions), so that stays null.",
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
      // A REFERENCE source states charges but books no trades (Dhan DP charges
      // — a depository fee belongs to no position). Its conservation is the
      // same question asked of the rows it DOES emit: the broker-stated
      // figures. Without this branch a zero-trade stated file would have to
      // pin its whole total as a "leak", which reads as a defect and is the
      // opposite of the truth.
      const carried = parsed.trades.length > 0
        ? perRow
        : sum((parsed.reference ?? []).map((r) => r.figures.charges ?? r.figures.totalCharges ?? 0));
      switch (row.charges.mode) {
        case "stated":
          expect(stated).not.toBeNull();
          // DEFECT rows pin the current leak exactly; a fix flips this red.
          // (`|| 0` folds a −0 from r2(−0.003) into 0 — toBe is Object.is.)
          expect(r2(stated! - carried) || 0).toBe(row.charges.leak ?? 0);
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
    // The 7,544-row Paytm book commits ~800 positions into a temp DB; the 5 s
    // default timed out once under load (v3.8 gate). Heavy by design, not slow.
    }, 120_000);

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

// ── The EXCHANGE LINE against the broker's own stated exchange figure (C-8) ──
//
// Owner ruling (06-ANSWERS "v4.3.0 C-8 ruling", last row): C-8 was accepted on
// THIS evidence. The engine prices the file's own rows (any stated charges
// stripped); its exchange transaction charge + IPFT is set against the exchange
// figure the broker states for the same rows. A total can move away from the
// broker's while this line moves onto it (other heads overshoot), so these pins
// hold the line — and each goes red if the pre-C-8 flat rates come back.
interface ExchangeLine {
  file: string;
  family: "equity" | "fno";
  /** Engine head(s) compared. Dhan states ONE exchange figure, IPFT inside it. */
  head: "txn+ipft" | "txn" | "ipft";
  /** Dhan: the Realised P&L's own segment row; otherwise the rows' own charge columns. */
  source: "segment" | "rows";
  /** The engine's figure, to the paisa. */
  engine: number;
  /** The broker's figure, as the file states it. */
  stated: number;
  /** |engine − stated| bound — or, for an unexplained gap, `gap` pins it exactly. */
  tol?: number;
  gap?: number;
}

const EXCHANGE_LINE: ExchangeLine[] = [
  // Dhan Realised P&L (THE REFERENCE, owner ruling). Before C-8: −247.00 / −971.92 / −134.26 / −21.87.
  { file: "dhan-realised-pnl-2026-04-01_2026-09-03-a1.xls", family: "equity", head: "txn+ipft", source: "segment", engine: 7610.77, stated: 7610.05, tol: 1 },
  { file: "dhan-realised-pnl-2026-04-01_2026-09-03-a1.xls", family: "fno", head: "txn+ipft", source: "segment", engine: 117806.1, stated: 117806.31, tol: 1 },
  { file: "dhan-realised-pnl-2026-04-01_2026-09-03-a2.xls", family: "equity", head: "txn+ipft", source: "segment", engine: 4147.5, stated: 4146.81, tol: 1 },
  { file: "dhan-realised-pnl-2026-04-01_2026-09-03-a2.xls", family: "fno", head: "txn+ipft", source: "segment", engine: 3342.24, stated: 3342.23, tol: 1 },
  // Zerodha FY24-25 crosses the 1 Apr 2024 and 1 Oct 2024 boundaries and states txn and IPFT per row.
  // Before C-8 the engine's txn was ~7,595.6 (−1,605) and its IPFT ~0 (Rs 0.01/crore, not Rs 50).
  // The txn residual (+19.80, 0.22%) is NOT explained; the bound states it rather than hiding it.
  { file: "zerodha-taxpnl-2024-04-01_2025-03-31.xlsx", family: "fno", head: "txn", source: "rows", engine: 9220.99, stated: 9201.19, tol: 20 },
  { file: "zerodha-taxpnl-2024-04-01_2025-03-31.xlsx", family: "fno", head: "ipft", source: "rows", engine: 108.4, stated: 108.18, tol: 0.25 },
  // Paytm August, EXPLAINED (R71, 4.3.0 — was +441.49 "unexplained", engine 9,965.17). Each row is now priced at the
  // venue of most of its OWN turnover (11 rows BSE → NSE), and the remaining +117.91 is measured per venue against the
  // file's own ETT column: NSE fills bill 307.00/crore (engine per fill 6,994.93 vs 6,995.25, −0.32); BSE fills bill
  // 350.31/crore against the seeded 375 (+178.20 on ₹7.22 crore); and −59.97 is the one-row limit — a row whose legs
  // span both venues is priced at ONE (engine per row 9,641.59 vs per fill 9,701.56). Pinned exactly so it cannot drift.
  { file: "paytm-tradebook-2026-08-01_2026-08-18.xlsx", family: "equity", head: "txn+ipft", source: "rows", engine: 9641.59, stated: 9523.68, gap: 117.91 },
];

describe("the exchange line against the broker's own stated exchange figure (C-8)", () => {
  const parsedOf = new Map<string, Promise<ParsedFile>>();
  const parse = (file: string) => {
    if (!parsedOf.has(file)) {
      const ctx = buildContext(file, fs.readFileSync(path.join(DIR, file)));
      parsedOf.set(file, Promise.resolve(rankParsers(ctx)[0].parse(ctx)));
    }
    return parsedOf.get(file)!;
  };

  it.each(EXCHANGE_LINE)("$file · $family · $head", async (l) => {
    const parsed = await parse(l.file);
    const fams = commitMod.previewParsedFile(parsed, null, 1).rows.map((r) => family(r.segment));
    const trades = parsed.trades.filter((_, i) => fams[i] === l.family);
    const stripped = { ...parsed, reported: {}, trades: trades.map((x) => ({ ...x, reportedCharges: undefined })) };
    const c = commitMod.previewParsedFile(stripped, null, 1).reconciliation!.computed;
    const engine = r2(l.head === "txn" ? c.exchangeTxn : l.head === "ipft" ? c.ipft : c.exchangeTxn + c.ipft);
    const stated =
      l.source === "segment"
        ? parsed.reported![`${l.family}.exchangeTxn`]
        : sum(trades.map((x) => (l.head === "ipft" ? 0 : x.reportedCharges?.exchangeTxn ?? 0) + (l.head === "txn" ? 0 : x.reportedCharges?.ipft ?? 0)));
    expect(stated).toBe(l.stated);
    expect(engine).toBe(l.engine);
    if (l.gap != null) expect(r2(engine - stated) || 0).toBe(l.gap);
    else expect(Math.abs(engine - stated)).toBeLessThanOrEqual(l.tol!);
    // Measured 38–247 ms locally (a parse plus two previews of up to 1,011 rows); the
    // Windows runner is >15× slower (AGENTS.md § Testing), so the 5 s default has no headroom.
  }, 60_000);
});

// R71 (v4.3.0), the audit's own example pinned at POSITION level: ISIN
// INE0OWZ01020 on 2026-08-06 opens with a ₹20.59L BSE buy, then ₹63.43L of NSE
// buys and ₹66.15L of NSE sells. The scrip-day took its FIRST fill's exchange,
// so both same-day round trips were stored as BSE and the engine's cross-check
// priced NSE turnover at BSE's rate.
describe("R71: a round trip filled on NSE is priced at NSE even when its day opened on BSE", () => {
  it("INE0OWZ01020 · 2026-08-06: the closed rows are NSE and their computed exchange line is NSE's", async () => {
    const file = "paytm-tradebook-2026-08-01_2026-08-18.xlsx";
    const ctx = buildContext(file, fs.readFileSync(path.join(DIR, file)));
    const parsed = await rankParsers(ctx)[0].parse(ctx);
    const day = parsed.trades.filter((x) => x.isin === "INE0OWZ01020" && x.buyDate === "2026-08-06" && x.sellDate === "2026-08-06");
    expect(day).toHaveLength(2);
    const line = (trades: ParsedFile["trades"]) => {
      const pv = commitMod.previewParsedFile({ ...parsed, reported: {}, trades: trades.map((x) => ({ ...x, reportedCharges: undefined })) }, null, 1);
      const c = pv.reconciliation!.computed;
      return { exchanges: pv.rows.map((r) => r.exchange), txn: r2(c.exchangeTxn + c.ipft) };
    };
    const got = line(day);
    const atNse = line(day.map((x) => ({ ...x, exchangeHint: "NSE" as const })));
    const atBse = line(day.map((x) => ({ ...x, exchangeHint: "BSE" as const })));
    expect(got.exchanges).toEqual(["NSE", "NSE"]);
    expect(got.txn).toBe(atNse.txn);
    expect(got.txn).toBeLessThan(atBse.txn); // BSE's seeded rate is the higher one — the old figure
    // A parse plus three previews of two rows; the 5 s default has no headroom on the Windows runner (AGENTS.md § Testing).
  }, 60_000);
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
