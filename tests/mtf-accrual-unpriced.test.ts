import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * M1 (v4.3.0 wave 2L, seam round; pre-existing) — the daily MTF accrual job
 * (lib/jobs/mtf-accrual.ts) PERSISTED its own estimate: `fundedChanged =
 * t.mtfFundedAmount == null` forced an UPDATE of `mtf_funded_amount` with
 * `defaultMtfFundedAmount(buyValue, ownMarginPct)`. app/equity/page.tsx runs the
 * job on every render, so the FIRST visit to the Equity Tracker turned an open
 * MTF row the journal never priced into a STATED funded amount at the margin
 * default (measured 2026-09-15: null -> 4,000 on a 5,000 buy; null -> 8,000 on a
 * 10,000 buy). After that, mtfDrift's `mtfFundedAmount == null` exclusion (wave
 * 2L L2) and `unpricedMtfPositions` could never fire for that row, and the drift
 * card compared the requirement against a margin the journal never recorded —
 * a fabricated figure stated as the journal's own (invariant 6).
 *
 * The job now NEVER writes mtf_funded_amount. Interest for a null-funded row is
 * still accrued on the estimate, exactly as before (the interest column is an
 * estimate the UI already labels), and chargesTotal/netPnl bookkeeping is
 * unchanged — the figures pinned below are the ones the job produced BEFORE the
 * change. A STATED amount (0 included, V3/X2) is read as today and never
 * overwritten.
 *
 * ONE temp database per FILE (AGENTS.md Testing); lib/jobs/mtf-accrual reaches
 * lib/db, so it is imported dynamically after the helper sets VYUHA_DB_PATH.
 */

let t: TempDb;
let accrueMtfInterest: typeof import("@/lib/jobs/mtf-accrual").accrueMtfInterest;

// Measured locally 2026-09-15: migrate + seed + the one dynamic import ~1.6 s,
// inside the 3 s local hook budget. The raised timeout is for the Windows runner
// (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("mtf-accrual-unpriced", { seed: true });
  ({ accrueMtfInterest } = await import("@/lib/jobs/mtf-accrual"));
}, 120_000);
afterAll(() => t?.cleanup());

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
/** [funded, interest, charges, net] as stored. */
const funding = (id: number) => {
  const r = row(id);
  return [r.mtfFundedAmount, r.mtfInterest, r.chargesTotal, r.netPnl];
};

/** An OPEN Zerodha MTF buy leg, 1 Aug; the job below runs it to 20 Aug (19 days). */
const openMtf = (symbol: string, qty: number, mtfFundedAmount: number | null) =>
  t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        broker: "zerodha",
        segment: "eq_mtf",
        symbol,
        tradingsymbol: symbol,
        buyQty: qty,
        avgBuyPrice: 100,
        buyValue: qty * 100,
        buyDate: "2026-08-01",
        buyOrderCount: 1,
        sellOrderCount: 0,
        isOpen: true,
        mtfFundedAmount,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;

describe("M1 — the daily accrual job accrues interest but never states a funded amount the journal never recorded", () => {
  it("an unpriced (null) row: the same interest as before, and the funded amount is STILL null", () => {
    const id = openMtf("ACCUNPRICED", 100, null);
    expect(row(id).mtfFundedAmount, "unstated, not 0").toBeNull();

    accrueMtfInterest("2026-08-20");

    // THE assertion (on revert: funded 8,000 — Zerodha's seeded own-margin share
    // of the 10,000 buy — is STATED on the row, and every reader that tests
    // `mtfFundedAmount == null` stops seeing it as unpriced).
    expect(row(id).mtfFundedAmount, "the job priced a position the journal never priced").toBeNull();
    // The interest arithmetic and the charges/net bookkeeping are UNCHANGED:
    // the estimate is still what interest accrues on (19 days on 8,000).
    expect(funding(id)).toEqual([null, 60.8, 60.8, -60.8]);
  });

  it("a stated 0 (the whole position from own capital) stays 0 and accrues nothing", () => {
    const id = openMtf("ACCSTATED0", 100, 0);
    accrueMtfInterest("2026-08-20");
    expect(funding(id)).toEqual([0, 0, 0, 0]);
  });

  it("a stated 16,000 on a 30,000 buy accrues on 16,000, not on the 24,000 estimate", () => {
    const id = openMtf("ACCSTATED16K", 300, 16000);
    accrueMtfInterest("2026-08-20");
    // 19 days on the STATED 16,000 (the estimate for this leg would be 24,000,
    // Zerodha's 20% own margin on 30,000, and 182.4 of interest).
    expect(funding(id)).toEqual([16000, 121.6, 121.6, -121.6]);
  });

  it("a second run on the same day changes nothing and reports nothing updated", () => {
    const ids = [openMtf("ACCIDEM", 100, null), openMtf("ACCIDEM0", 100, 0), openMtf("ACCIDEM16K", 300, 16000)];
    accrueMtfInterest("2026-08-20");
    const before = ids.map(funding);
    const second = accrueMtfInterest("2026-08-20");
    expect(second.updated, "nothing to write on a re-run").toBe(0);
    expect(ids.map(funding)).toEqual(before);
    expect(before).toEqual([
      [null, 60.8, 60.8, -60.8],
      [0, 0, 0, 0],
      [16000, 121.6, 121.6, -121.6],
    ]);
  });
});
