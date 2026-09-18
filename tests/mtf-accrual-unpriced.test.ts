import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
let commit: typeof import("@/lib/import/commit");

// Measured locally 2026-09-15: migrate + seed + the one dynamic import ~1.6 s,
// inside the 3 s local hook budget. The raised timeout is for the Windows runner
// (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("mtf-accrual-unpriced", { seed: true });
  ({ accrueMtfInterest } = await import("@/lib/jobs/mtf-accrual"));
  staged = await import("@/lib/queries/staged");
  commit = await import("@/lib/import/commit");
}, 120_000);
afterAll(() => t?.cleanup());

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
/** [funded, interest, charges, net] as stored. */
const funding = (id: number) => {
  const r = row(id);
  return [r.mtfFundedAmount, r.mtfInterest, r.chargesTotal, r.netPnl];
};

/** An OPEN Zerodha MTF buy leg, 1 Aug; the job below runs it to 20 Aug (19 days). */
const openMtf = (symbol: string, qty: number, mtfFundedAmount: number | null, broker = "zerodha") =>
  t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        broker,
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

// ===========================================================================
// v4.3.0 fix wave 2P — B2P-MTF-DATES (D1, D2, D3, D5)
// ===========================================================================

const r2 = (n: number) => Math.round(n * 100) / 100;
const legsOf = (id: number) => t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, id)).all();
/** Σ of the ladder's own per-leg charges, which the parent must equal (invariant 5). */
const ladderCharges = (id: number) => r2(legsOf(id).reduce((s, l) => s + l.chargesTotal, 0));
/** [interest, pledge, charges, net] as stored. */
const money = (id: number) => {
  const r = row(id);
  return [r.mtfInterest, r.pledgeCharges, r.chargesTotal, r.netPnl];
};

/**
 * D1 (mtf-staged#0, a SILENT WRONG NUMBER — OWNER RULING 2O row 1: "leave the closed
 * rows alone — no stored money on a closed trade moves without the owner's say-so").
 *
 * `updateManualTrade` hands a staged parent back to `rebuildStagedTrade` on every
 * save, notes included (D20), and the ladder billed a null principal NOTHING (Q-A)
 * — so a row closed BEFORE 4.3.0 with the old estimate stored (14 days on the 8,000
 * estimate: 44.80 of interest, 30 of pledge, 5.40 of GST on that pledge = ₹80.20)
 * was released by a save that touched only the notes: measured
 * {before:[44.8,166.53,833.47], after:[0,86.33,913.67]}. The ruling protects all
 * three heads. The rebuild now carries the STORED figures of a closed null-funded
 * ladder through every door (`mtfCarry`), apportioned across the legs so that
 * parent = Σ legs holds (invariant 5) and Σ shares is the stored figure to the
 * paisa (invariant 1).
 */
describe("D1 — a CLOSED staged null-funded row keeps the estimate it stored before 4.3.0, through every door", () => {
  const EXTRA = 80.2; // 44.80 interest + 30 pledge + 5.40 GST on the pledge
  /**
   * The finding's row: open 100 @100 on 1 Aug, converted, exited 100 @110 on 15 Aug
   * — CLOSED at 0 interest under 4.3.0 — then the pre-4.3.0 ladder's state written
   * over it: the estimate on the parent AND on the entry leg it billed it on.
   */
  const legacyClosedLadder = (symbol: string) => {
    const id = openMtf(symbol, 100, null);
    expect(staged.convertToStaged(id).ok).toBe(true);
    expect(staged.addLeg({ tradeId: id, kind: "exit", tradeDate: "2026-08-15", qty: 100, price: 110, direction: "long" }).ok).toBe(true);
    const fresh = row(id);
    expect([fresh.isOpen, fresh.mtfFundedAmount, fresh.mtfInterest, fresh.pledgeCharges]).toEqual([false, null, 0, 0]);
    expect(fresh.chargesTotal).toBe(ladderCharges(id));
    const entry = legsOf(id).find((l) => l.kind === "entry")!;
    t.db.update(t.schema.tradeLegs).set({ chargesTotal: r2(entry.chargesTotal + EXTRA) }).where(eq(t.schema.tradeLegs.id, entry.id)).run();
    t.db
      .update(t.schema.trades)
      .set({ mtfInterest: 44.8, pledgeCharges: 30, gst: r2(fresh.gst + 5.4), chargesTotal: r2(fresh.chargesTotal + EXTRA), netPnl: r2(fresh.netPnl - EXTRA) })
      .where(eq(t.schema.trades.id, id))
      .run();
    expect(row(id).chargesTotal, "the legacy state is internally consistent").toBe(ladderCharges(id));
    return id;
  };

  it("(1) a notes-only editor save moves nothing: interest, pledge, charges and net stand, parent = Σ legs", () => {
    const id = legacyClosedLadder("D1NOTES");
    const before = money(id);
    expect(before.slice(0, 2)).toEqual([44.8, 30]);

    const res = commit.updateManualTrade(id, { notes: "journal only" });
    expect([res.ok, res.message]).toEqual([true, "Trade updated."]);

    // THE assertion (on revert: [0, 0, before[2] − 80.2, before[3] + 80.2] — the
    // estimate released by a save that touched only the notes).
    expect(money(id), "a closed row's stored money moved on a notes-only save").toEqual(before);
    expect(row(id).chargesTotal).toBe(ladderCharges(id));
    expect(row(id).notes).toBe("journal only");
    // …and a second save is idempotent.
    expect(commit.updateManualTrade(id, { notes: "journal only, again" }).ok).toBe(true);
    expect(money(id)).toEqual(before);
  });

  it("(2) a leg NOTE edit on the same row moves nothing either", () => {
    const id = legacyClosedLadder("D1LEGNOTE");
    const before = money(id);
    const entry = legsOf(id).find((l) => l.kind === "entry")!;
    expect(staged.updateLeg(entry.id, { note: "why I bought" }, "long").ok).toBe(true);
    expect(money(id)).toEqual(before);
    expect(row(id).chargesTotal).toBe(ladderCharges(id));
  });

  it("(2b) a leg PRICE edit re-prices the statutory heads (the user's act) and keeps the carried interest and pledge", () => {
    const id = legacyClosedLadder("D1LEGPRICE");
    const before = row(id);
    const exit = legsOf(id).find((l) => l.kind === "exit")!;
    expect(staged.updateLeg(exit.id, { price: 120 }, "long").ok).toBe(true);
    const after = row(id);
    expect([after.mtfInterest, after.pledgeCharges], "the carry stays").toEqual([44.8, 30]);
    expect(after.grossPnl, "the fill really moved").toBe(2000);
    expect(after.sttCtt, "…and the statutory heads with it").not.toBe(before.sttCtt);
    expect(after.chargesTotal).toBe(ladderCharges(id));
  });

  it("(3) two job runs leave it untouched — a closed row is never selected", () => {
    const id = legacyClosedLadder("D1JOB");
    const before = money(id);
    expect(accrueMtfInterest("2026-08-20").updated).toBe(0);
    expect(accrueMtfInterest("2026-08-20").updated).toBe(0);
    expect(money(id)).toEqual(before);
  });

  it("(4) a closed null-funded row storing 0/0 gets no carry and stays 0", () => {
    const id = openMtf("D1ZERO", 100, null);
    expect(staged.convertToStaged(id).ok).toBe(true);
    expect(staged.addLeg({ tradeId: id, kind: "exit", tradeDate: "2026-08-15", qty: 100, price: 110, direction: "long" }).ok).toBe(true);
    const before = money(id);
    expect(before.slice(0, 2)).toEqual([0, 0]);
    expect(commit.updateManualTrade(id, { notes: "n" }).ok).toBe(true);
    expect(money(id)).toEqual(before);
  });

  it("(6) an OPEN legacy row closed by an exit leg is NOT protected: it closes at 0 (Q-A)", () => {
    const id = openMtf("D1OPENCLOSE", 100, null);
    expect(staged.convertToStaged(id).ok).toBe(true);
    const entry = legsOf(id)[0];
    t.db.update(t.schema.tradeLegs).set({ chargesTotal: 71.38 }).where(eq(t.schema.tradeLegs.id, entry.id)).run();
    t.db.update(t.schema.trades).set({ mtfInterest: 71.38, chargesTotal: 71.38, netPnl: -71.38 }).where(eq(t.schema.trades.id, id)).run();
    expect(staged.addLeg({ tradeId: id, kind: "exit", tradeDate: "2026-08-15", qty: 100, price: 110, direction: "long" }).ok).toBe(true);
    expect([row(id).isOpen, row(id).mtfInterest, row(id).pledgeCharges]).toEqual([false, 0, 0]);
    expect(row(id).chargesTotal).toBe(ladderCharges(id));
  });

  it("(7) convertToStaged on a CLOSED flat legacy null-funded row keeps closePosition's old estimate", () => {
    const id = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          broker: "zerodha", segment: "eq_mtf", symbol: "D1FLAT", tradingsymbol: "D1FLAT",
          buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1,
          sellQty: 100, avgSellPrice: 110, sellValue: 11000, sellDate: "2026-08-15", sellOrderCount: 1,
          isOpen: false, mtfFundedAmount: null, grossPnl: 1000,
          mtfInterest: 44.8, pledgeCharges: 30, gst: 5.4, chargesTotal: 166.53, netPnl: 833.47,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    expect(staged.convertToStaged(id).ok).toBe(true);
    // THE assertion (on revert: [0, 0] — the conversion released the estimate).
    expect([row(id).mtfInterest, row(id).pledgeCharges]).toEqual([44.8, 30]);
    expect(row(id).chargesTotal).toBe(ladderCharges(id));
    expect(row(id).isOpen).toBe(false);
  });
});

/**
 * D3 (mtf-staged#2, pre-existing) — a TIERED broker's slab is evaluated on the
 * row's whole stated principal, so a staged Dhan row stating 8,00,000 in two
 * same-day tranches bills (to the per-leg paisa rounding the ladder's header
 * accepts) what its flat twin bills through the job: 13.49%, not 12.49% twice.
 */
describe("D3 — a staged dhan row stating 8,00,000 in two same-day tranches ≡ its flat twin through the job", () => {
  it("Σ per-leg is within a paisa per extra tranche of the job's whole-leg figure (was ₹416.43 under)", () => {
    const laddered = openMtf("D3STAGED", 4000, 800000, "dhan");
    expect(staged.convertToStaged(laddered).ok).toBe(true);
    expect(staged.addLeg({ tradeId: laddered, kind: "entry", tradeDate: "2026-08-01", qty: 4000, price: 100, direction: "long" }).ok).toBe(true);
    const flat = openMtf("D3FLAT", 8000, 800000, "dhan");

    accrueMtfInterest("2026-08-20");

    expect(row(flat).mtfInterest, "the job: 8,00,000 × 13.49% × 19 ÷ 365").toBe(5617.75);
    // THE assertion (on revert: 5201.32 — each 4,00,000 share at the ≤5L slab).
    expect(row(laddered).mtfInterest).toBe(5617.76);
    expect(r2(Math.abs(row(laddered).mtfInterest - row(flat).mtfInterest))).toBeLessThanOrEqual(0.01);
    expect(row(laddered).chargesTotal).toBe(ladderCharges(laddered));
  });
});

/**
 * D5 (mtf-staged#4) — the job asked no leg-count question before rebuilding a
 * `staged` row: `validateLegs([])` returns no problem, so a staged-flagged row
 * with ZERO legs was rewritten from an EMPTY ladder on every /equity render
 * (`buyQty / buyValue / chargesTotal / netPnl → 0`). One predicate (`legCountOf`)
 * for the job and the six editor-side sites; such a row is left exactly as it is
 * and counted in D2's `skipped`.
 */
describe("D5 — a staged-flagged row with no legs is left exactly as it is, and counted as skipped", () => {
  it("the finding's row is byte-identical after the job", () => {
    const id = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          broker: "zerodha", segment: "eq_mtf", symbol: "D5NOLEGS", tradingsymbol: "D5NOLEGS", staged: true,
          buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1,
          isOpen: true, mtfFundedAmount: 5000, chargesTotal: 20, netPnl: -20,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const before = row(id);
    const shape = () => {
      const r = row(id);
      return [r.buyQty, r.buyValue, r.isOpen, r.chargesTotal, r.mtfFundedAmount];
    };
    expect(shape()).toEqual([100, 10000, true, 20, 5000]);

    const res = accrueMtfInterest("2026-08-20");

    // THE assertion (on revert: [0, 0, true, 0, 5000] — rewritten from an empty ladder).
    expect(shape()).toEqual([100, 10000, true, 20, 5000]);
    expect(row(id)).toEqual(before);
    expect(res.skipped, "the skip is observable").toBe(1);
  });
});

/**
 * D2 (mtf-staged#1, medium) — `findRates` THROWS when no eq_mtf epoch covers
 * `today` for a staged row's broker, and the staged branch had no try/catch (the
 * flat branch has one): the throw escaped `accrueMtfInterest`, /equity swallowed
 * it, and NO row after the failing one accrued — flat rows with a STATED
 * principal included — with nothing on screen. The staged branch now takes the
 * flat branch's guard: the row is left exactly as it is (accruing at a
 * neighbouring rate would invent a number, invariant 6), the loop continues, and
 * the skip is counted. LAST in this file: it deletes upstox's eq_mtf rates.
 */
describe("D2 — the job survives a staged row it cannot price, and every later row still accrues", () => {
  it("upstox-staged (no epoch) then zerodha-flat: no throw, zerodha 30.40, skipped + 1, the upstox row byte-identical", () => {
    const ups = openMtf("D2UPSTOX", 100, 4000, "upstox");
    expect(staged.convertToStaged(ups).ok).toBe(true);
    // A run while the epoch exists: the baseline skip count of this database.
    const baseline = accrueMtfInterest("2026-08-20");
    const upsBefore = row(ups);
    expect(upsBefore.mtfInterest).toBeGreaterThan(0);

    t.db
      .delete(t.schema.chargeConfig)
      .where(and(eq(t.schema.chargeConfig.broker, "upstox"), eq(t.schema.chargeConfig.segment, "eq_mtf")))
      .run();
    const zer = openMtf("D2ZERODHA", 100, 4000);

    // THE assertion (on revert: throws "No charge_config for upstox / default / eq_mtf / NSE"
    // and the zerodha row reads 0).
    let res: ReturnType<typeof accrueMtfInterest> | undefined;
    expect(() => { res = accrueMtfInterest("2026-08-20"); }).not.toThrow();
    expect(row(zer).mtfInterest, "the row AFTER the failing one still accrues").toBe(30.4);
    expect(res!.skipped).toBe(baseline.skipped + 1);
    expect(row(ups), "the unpriceable row is left exactly as it was").toEqual(upsBefore);
    // Idempotent: the same again.
    const again = accrueMtfInterest("2026-08-20");
    expect([again.updated, again.skipped]).toEqual([0, baseline.skipped + 1]);
  });
});
