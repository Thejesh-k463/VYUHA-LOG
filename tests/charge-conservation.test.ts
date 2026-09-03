import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext, rankParsers } from "@/lib/import/detect";
import type { ParsedFile } from "@/lib/import/types";

/**
 * Charges are conserved to the paisa against the broker's own total, on the
 * three real exports where the golden-book harness found them leaking
 * (2026-09-04):
 *
 *   Angel One Trades_History   Σ rows 157.76 vs stated Total Trade Charges 157.79
 *   Zerodha tax P&L FY25-26    Σ positions 3,269.50 vs the columns' 3,269.41
 *   Zerodha tax P&L FY24-25    Σ positions 34,315.16 vs the columns' 34,315.18
 *
 * …and the Zerodha Console P&L, which STATES Charges 3,269.4101 in its
 * Summary block and whose parser carried none of it.
 *
 * The rule in every parser is the Paytm one: the residual rides on the LAST
 * position, on one head so its heads still sum to its total, and that
 * position says so in an import note. Every other position is untouched.
 */

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));
const HEADS = ["brokerage", "gst", "sttCtt", "sebi", "stampDuty", "exchangeTxn", "ipft"] as const;

async function parse(file: string): Promise<ParsedFile> {
  const ctx = buildContext(file, fs.readFileSync(path.join(DIR, file)));
  return rankParsers(ctx)[0].parse(ctx);
}
const perRow = (p: ParsedFile) => sum(p.trades.map((t) => t.reportedCharges?.total ?? 0));
const carriers = (p: ParsedFile) => p.trades.filter((t) => t.importNotes?.some((n) => /^Carries ₹/.test(n)));

describe("Angel One Trades_History — conserved to the file's Total Trade Charges", () => {
  it("Σ per-trade charges = 157.79 (was 157.76), the ₹0.03 on the last contract, said there", async () => {
    const p = await parse("angelone-trades-history-2026-04-01_2026-09-02.xlsx");
    expect(p.reported?.totalCharges).toBe(157.79);
    // THE assertion: reverting the residual reads 157.76.
    expect(perRow(p)).toBe(157.79);
    const c = carriers(p);
    expect(c).toHaveLength(1);
    expect(c[0]).toBe(p.trades[p.trades.length - 1]);
    expect(c[0].importNotes!.join(" ")).toMatch(/Carries ₹0\.03 .*157\.79/);
    // The heads follow the summary's own per-head figures (GST 22.85, SEBI 0.02), not a guess.
    expect(sum(p.trades.map((t) => t.reportedCharges?.gst ?? 0))).toBe(22.85);
    expect(sum(p.trades.map((t) => t.reportedCharges?.sebi ?? 0))).toBe(0.02);
  });
});

describe("Zerodha tax P&L — conserved to the tradewise charge columns", () => {
  it.each([
    ["zerodha-taxpnl-2025-04-01_2026-03-31.xlsx", 3269.41, -0.09],
    ["zerodha-taxpnl-2024-04-01_2025-03-31.xlsx", 34315.18, 0.02],
  ])("%s → Σ positions %s, residual %s on the last position", async (file, total, residual) => {
    const p = await parse(file);
    // THE assertion: reverting the residual reads 3,269.50 / 34,315.16.
    expect(perRow(p)).toBe(total);
    const c = carriers(p);
    expect(c).toHaveLength(1);
    expect(c[0]).toBe(p.trades[p.trades.length - 1]);
    expect(c[0].importNotes!.join(" ")).toContain(`Carries ₹${residual.toFixed(2)}`);
    // Every position's heads still add to its total, and no head went negative.
    for (const t of p.trades) {
      const b = t.reportedCharges!;
      expect(r2(HEADS.reduce((s, k) => s + (b[k] ?? 0), 0))).toBe(b.total);
      for (const k of HEADS) expect(b[k] ?? 0).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("Zerodha Console P&L — the Summary's stated charges travel in `reported`", () => {
  it("carries Charges 3,269.4101, Realized P&L and the per-head table; per-row charges stay the engine's", async () => {
    const p = await parse("zerodha-console-pnl-2025-04-01_2026-03-31.xlsx");
    // THE assertion: reverting readConsoleSummary leaves `reported` undefined.
    expect(p.reported?.charges).toBe(3269.4101);
    expect(p.reported).toMatchObject({
      realisedPnl: -67517.25, unrealisedPnl: 0, brokerage: 1340, exchangeTxn: 634.1337, sttCtt: 899, sebi: 1.8221, stampDuty: 29, ipft: 8.2901,
    });
    // The three GST heads fold into one, as the tradewise parser does.
    expect(p.reported?.gst).toBe(357.1643);
    // The per-head table foots to the stated total (Zerodha's own arithmetic).
    const heads = ["brokerage", "exchangeTxn", "clearing", "gst", "sttCtt", "sebi", "stampDuty", "ipft"];
    expect(r2(heads.reduce((s, k) => s + (p.reported![k] ?? 0), 0))).toBe(3269.41);
    expect(perRow(p)).toBe(0);
    expect(p.warnings.join(" ")).toMatch(/states ₹3,269\.41 of charges in total but none per row/);
  });
});
