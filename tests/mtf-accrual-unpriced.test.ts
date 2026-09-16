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
 * The job now NEVER writes mtf_funded_amount.
 *
 * Q-A (OWNER RULING, v4.3.0 wave 2N — mtf-accrual#0/#1) — AND IT NO LONGER
 * ACCRUES ON THE ESTIMATE EITHER. Using `defaultMtfFundedAmount(buyValue,
 * margin_config)` on every render meant a broker's own-margin % edit (POST
 * /api/margin, a settings-baseline restore, a backup restore) retroactively
 * restated the stored charges_total and net_pnl of every unpriced holding —
 * measured [null, 60.8, 60.8, -60.8] -> [null, 38, 38, -38] on the same day, no
 * prompt, no audit row, which is the very thing this job's per-epoch design
 * exists to prevent (DECISIONS 2026-08-30 decision 6). A row with no recorded
 * funded amount accrues NOTHING; an estimate already stored is released once.
 * A STATED amount (0 included, V3/X2) is read as today and never overwritten.
 *
 * ONE temp database per FILE (AGENTS.md Testing); lib/jobs/mtf-accrual reaches
 * lib/db, so it is imported dynamically after the helper sets VYUHA_DB_PATH.
 */

let t: TempDb;
let accrueMtfInterest: typeof import("@/lib/jobs/mtf-accrual").accrueMtfInterest;
let staged: typeof import("@/lib/queries/staged");

// Measured locally 2026-09-15: migrate + seed + the one dynamic import ~1.6 s,
// inside the 3 s local hook budget. The raised timeout is for the Windows runner
// (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("mtf-accrual-unpriced", { seed: true });
  ({ accrueMtfInterest } = await import("@/lib/jobs/mtf-accrual"));
  staged = await import("@/lib/queries/staged");
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
  it("an unpriced (null) row: the funded amount is STILL null, and NOTHING accrues on it (Q-A)", () => {
    const id = openMtf("ACCUNPRICED", 100, null);
    expect(row(id).mtfFundedAmount, "unstated, not 0").toBeNull();

    accrueMtfInterest("2026-08-20");

    // THE assertion (on revert: funded 8,000 — Zerodha's seeded own-margin share
    // of the 10,000 buy — is STATED on the row, and every reader that tests
    // `mtfFundedAmount == null` stops seeing it as unpriced).
    expect(row(id).mtfFundedAmount, "the job priced a position the journal never priced").toBeNull();
    // PIN MOVED (Q-A): on revert, [null, 60.8, 60.8, -60.8] — 19 days billed on
    // an 8,000 principal nothing in the journal states, and re-billed at a
    // different figure on the next margin-config edit.
    expect(funding(id)).toEqual([null, 0, 0, 0]);
  });

  /**
   * Q-A's release half. A row that already carries an estimate the job wrote
   * under the old rule loses it ONCE, and its chargesTotal / netPnl come back
   * with it — otherwise a permanent 60.80 of interest on an imaginary principal
   * sits in the book with no writer that can ever remove it.
   */
  it("an estimate already in the row's stored money is released ONCE, then the row is left alone", () => {
    const id = openMtf("ACCRELEASE", 100, null);
    // The state the old job left behind: 19 days on the 8,000 estimate.
    t.db
      .update(t.schema.trades)
      .set({ mtfInterest: 60.8, chargesTotal: 60.8, netPnl: -60.8 })
      .where(eq(t.schema.trades.id, id))
      .run();

    const first = accrueMtfInterest("2026-08-20");
    // THE assertion (on revert: the row keeps 60.8 and the job re-bills it).
    expect(funding(id)).toEqual([null, 0, 0, 0]);
    expect(first.updated, "the release is a write").toBeGreaterThan(0);

    // …and only once: the second run has nothing to do.
    const second = accrueMtfInterest("2026-08-20");
    expect(funding(id)).toEqual([null, 0, 0, 0]);
    expect(second.updated).toBe(0);
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
      [null, 0, 0, 0],
      [0, 0, 0, 0],
      [16000, 121.6, 121.6, -121.6],
    ]);
  });
});

/**
 * D6 (v4.3.0 fix wave 2O — mtf#0, a SILENT WRONG NUMBER) — A STAGED ROW'S
 * CHARGES HAVE EXACTLY ONE WRITER: THE LADDER.
 *
 * The staged ladder (`lib/queries/staged.ts#priceLegs` → `rebuildStagedTrade`)
 * was the FIFTH writer of stored `mtf_interest`, and this job had no `staged`
 * filter, so the two doors took turns: measured on HEAD (zerodha eq_mtf 100 @100,
 * `mtf_funded_amount` NULL, clock 2026-08-20) `convertToStaged` stored 71.38 of
 * interest, this job released it, `addLeg` billed it again, the next /equity
 * render released it again — stored money oscillating with no prompt and no audit
 * row (DECISIONS 2026-08-30 decision 6).
 *
 * And the release itself broke invariant 5: the job patches the PARENT row only,
 * so the design review's probe read parent 71.38 against legs 218.58 on a legacy
 * ladder (147.20 released from the parent alone, the legs left carrying it). The
 * job therefore skips a `staged` row in BOTH branches and re-prices it through
 * `rebuildStagedTrade`, which writes the legs and the parent in one transaction —
 * so parent = Σ legs at every step of the walk below.
 *
 * The owner ruled (2O row 1) that CLOSED staged rows priced before 4.3.0 KEEP
 * their earlier estimate: the job never selects a closed row, so nothing here
 * touches them.
 */
describe("D6 — the accrual job never patches a staged parent; the ladder prices it", () => {
  /** Σ of the ladder's own per-leg charges, which the parent must equal (invariant 5). */
  const legCharges = (id: number) =>
    Math.round(
      t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, id)).all()
        .reduce((s, l) => s + l.chargesTotal, 0) * 100,
    ) / 100;
  const parentCharges = (id: number) => row(id).chargesTotal;

  it("convert → accrue → addLeg → accrue on an UNPRICED row: [null, 0] at every step, parent = Σ legs at every step", () => {
    const id = openMtf("D6WALK", 100, null);
    const seen: Array<[number | null, number, boolean]> = [];
    const step = () => seen.push([row(id).mtfFundedAmount, row(id).mtfInterest, parentCharges(id) === legCharges(id)]);

    expect(staged.convertToStaged(id).ok).toBe(true);
    step();
    accrueMtfInterest("2026-08-20");
    step();
    expect(staged.addLeg({ tradeId: id, kind: "entry", tradeDate: "2026-08-05", qty: 50, price: 102, direction: "long" }).ok).toBe(true);
    step();
    accrueMtfInterest("2026-08-20");
    step();

    // THE assertion (on revert: [[null, 71.38, …], [null, 0, …], [null, >0, …],
    // [null, 0, …]] — the row alternating between 71.38 and 0 on every leg edit
    // and every Equity Tracker visit).
    expect(seen, "an unpriced staged row bills nothing, and nothing oscillates").toEqual([
      [null, 0, true],
      [null, 0, true],
      [null, 0, true],
      [null, 0, true],
    ]);
  });

  it("a LEGACY open staged row carrying the old estimate is released through the ladder — legs AND parent together", () => {
    const id = openMtf("D6LEGACY", 100, null);
    expect(staged.convertToStaged(id).ok).toBe(true);
    // The state a version before 4.3.0 left behind: the estimate on the parent
    // AND on the leg the ladder priced.
    const leg = t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, id)).all()[0];
    t.db.update(t.schema.tradeLegs).set({ chargesTotal: 71.38 }).where(eq(t.schema.tradeLegs.id, leg.id)).run();
    t.db.update(t.schema.trades).set({ mtfInterest: 71.38, chargesTotal: 71.38, netPnl: -71.38 }).where(eq(t.schema.trades.id, id)).run();

    accrueMtfInterest("2026-08-20");

    // THE assertion (on revert: the job zeroes the PARENT's interest and charges
    // and leaves the leg at 71.38 — the design review's probed 71.38 vs 218.58,
    // invariant 5 broken by the release itself).
    const after = row(id);
    expect([after.mtfFundedAmount, after.mtfInterest], "the estimate is out of the row").toEqual([null, 0]);
    expect(parentCharges(id), "parent = Σ legs after the release").toBe(legCharges(id));
    // The 71.38 of interest really did leave the stored money: what is left is the
    // ladder's own brokerage and statutory charges on the tranche, and the net
    // moves with them.
    expect(parentCharges(id)).toBeLessThan(71.38);
    expect(after.netPnl).toBe(Math.round((after.grossPnl - parentCharges(id)) * 100) / 100);
    // …and it is idempotent: a second run states nothing to do.
    expect(accrueMtfInterest("2026-08-20").updated).toBe(0);
  });

  it("a STAGED row that STATES its funding is billed the LADDER's apportioned figure, not the job's whole-leg one", () => {
    // ONE tranche: the two doors agree to the paisa, which is the property owner
    // ruling 2O row 2 asks for — 4,000 × 14.6% × 19 days ÷ 365 = 30.40.
    const single = openMtf("D6STATED1", 100, 4000);
    expect(staged.convertToStaged(single).ok).toBe(true);
    accrueMtfInterest("2026-08-20");
    expect(funding(single).slice(0, 2), "Σ per-leg interest = the job's whole-leg figure").toEqual([4000, 30.4]);
    expect(parentCharges(single)).toBe(legCharges(single));

    // TWO tranches, ten days apart: the ladder bills each tranche for its OWN
    // days on its OWN share of the stated 4,000 — 10,000 + 5,100 of tranche value,
    // so 2,649.01 held 19 days (20.13) and the remainder 1,350.99 held 10 (5.40) —
    // which is LESS than the 30.40 this job bills on the whole amount from the
    // earliest buy date.
    const laddered = openMtf("D6STATED2", 100, 4000);
    expect(staged.convertToStaged(laddered).ok).toBe(true);
    expect(staged.addLeg({ tradeId: laddered, kind: "entry", tradeDate: "2026-08-10", qty: 50, price: 102, direction: "long" }).ok).toBe(true);

    accrueMtfInterest("2026-08-20");

    // THE assertion (on revert: 30.40 — the job re-bills the whole stated amount
    // from `agg.buyDate` over the ladder's per-tranche figure, so the parent no
    // longer equals Σ legs and one row states two answers).
    expect(row(laddered).mtfInterest, "the job did not overwrite the ladder").toBeCloseTo(25.53, 2);
    expect(row(laddered).mtfInterest).not.toBe(30.4);
    expect(parentCharges(laddered)).toBe(legCharges(laddered));
    // …and re-running the job changes nothing (the ladder is idempotent).
    expect(accrueMtfInterest("2026-08-20").updated).toBe(0);
  });
});
