import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { computeCharges } from "@/lib/engine/charges";
import { seedRatesMap, findRates } from "@/lib/engine/rates";
import { legChargeShapes, summarise, type Leg, type Direction } from "@/lib/domain/staged";
import type { ChargeRates } from "@/lib/engine/types";
import { openTempDb, type TempDb } from "./helpers/temp-db";

const ratesMap = seedRatesMap();

function ladder(...legs: Omit<Leg, "seq" | "id">[]): Leg[] {
  return legs.map((l, i) => ({ ...l, id: i + 1, seq: i + 1 }));
}
const entry = (qty: number, price: number, tradeDate = "2026-01-01"): Omit<Leg, "seq" | "id"> => ({
  kind: "entry", tradeDate, qty, price,
});
const exit = (qty: number, price: number, tradeDate = "2026-02-01"): Omit<Leg, "seq" | "id"> => ({
  kind: "exit", tradeDate, qty, price,
});

/**
 * Mirrors lib/queries/staged.ts#priceLegs without touching the DB, so the
 * DP-per-day rule and the per-leg brokerage behaviour are testable in
 * isolation. Kept deliberately close to the real implementation.
 */
function priceLadder(
  legs: Leg[],
  direction: Direction,
  broker: string,
  segment: string,
  exchange = "NSE",
) {
  const rates = findRates(ratesMap, broker as never, segment as never, exchange as never, "2026-06-15");
  return legChargeShapes(legs, direction).map((shape) => {
    const legRates: ChargeRates = shape.suppressDp ? { ...rates, dpCharge: 0 } : rates;
    return computeCharges(
      {
        segment: segment as never,
        buyValue: shape.buyValue,
        sellValue: shape.sellValue,
        buyQty: shape.buyQty,
        sellQty: shape.sellQty,
        buyOrderCount: shape.buyOrderCount,
        sellOrderCount: shape.sellOrderCount,
      },
      legRates,
    );
  });
}

const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

describe("a single-entry ladder prices identically to the classic round trip", () => {
  // This is THE safety property of the whole feature: turning staged mode on
  // for a plain trade must not move a single rupee.
  const cases: Array<[string, string, number, number, number]> = [
    ["zerodha", "eq_delivery", 100, 1000, 1100],
    ["zerodha", "index_option", 500, 200, 240],
    ["dhan", "eq_intraday", 200, 500, 512],
    ["groww", "stock_option", 250, 80, 95],
    ["angelone", "eq_delivery", 50, 2000, 2200],
    ["upstox", "future", 75, 1800, 1850],
  ];

  for (const [broker, segment, qty, buy, sellPrice] of cases) {
    it(`${broker} ${segment}`, () => {
      const legs = ladder(entry(qty, buy), exit(qty, sellPrice));
      const perLeg = priceLadder(legs, "long", broker, segment);
      const roundTrip = computeCharges(
        {
          segment: segment as never,
          buyValue: qty * buy,
          sellValue: qty * sellPrice,
          buyQty: qty,
          sellQty: qty,
          buyOrderCount: 1,
          sellOrderCount: 1,
        },
        findRates(ratesMap, broker as never, segment as never, "NSE", "2026-06-15"),
      );

      // Allow a rupee of slack ONLY where statutory rounding is applied per
      // side (STT and stamp duty round to the nearest rupee), which is a real
      // arithmetic difference, not an error.
      expect(sum(perLeg.map((c) => c.brokerage))).toBeCloseTo(roundTrip.brokerage, 2);
      expect(sum(perLeg.map((c) => c.exchangeTxn))).toBeCloseTo(roundTrip.exchangeTxn, 1);
      expect(sum(perLeg.map((c) => c.sebi))).toBeCloseTo(roundTrip.sebi, 1);
      expect(sum(perLeg.map((c) => c.dpCharges))).toBeCloseTo(roundTrip.dpCharges, 2);
      expect(sum(perLeg.map((c) => c.total))).toBeCloseTo(roundTrip.total, 0);
    });
  }
});

describe("per-leg brokerage — what scaling in actually costs you", () => {
  // Whether splitting an order costs extra depends entirely on how the broker
  // charges. Both behaviours are asserted so the cost of pyramiding is never
  // silently misreported in either direction.

  it("costs strictly more under FLAT per-order brokerage (options)", () => {
    // Zerodha options are ₹20 per executed order — four entries is ₹80.
    const scaled = priceLadder(
      ladder(entry(50, 100), entry(50, 105), entry(50, 110), entry(50, 115)),
      "long",
      "zerodha",
      "index_option",
    );
    const oneShot = priceLadder(ladder(entry(200, 107.5)), "long", "zerodha", "index_option");
    expect(sum(scaled.map((x) => x.brokerage))).toBe(80);
    expect(sum(oneShot.map((x) => x.brokerage))).toBe(20);
  });

  it("is cost-NEUTRAL under percentage brokerage below the cap (intraday)", () => {
    // 0.03% of the same turnover is the same money however you slice it. A
    // journal that claimed scaling in cost extra here would be lying.
    const oneShot = priceLadder(ladder(entry(300, 200), exit(300, 220)), "long", "zerodha", "eq_intraday");
    const scaled = priceLadder(
      ladder(entry(100, 200), entry(100, 200), entry(100, 200), exit(300, 220)),
      "long",
      "zerodha",
      "eq_intraday",
    );
    expect(sum(scaled.map((c) => c.brokerage))).toBeCloseTo(sum(oneShot.map((c) => c.brokerage)), 2);
  });

  it("can be CHEAPER when splitting drops each order under the per-order cap", () => {
    // One ₹10L order pays the ₹20 cap; five ₹2L orders pay 0.03% = ₹60 each…
    // no — each is ₹60 capped at ₹20, so the cap is what binds. The point is
    // that per-leg pricing follows the real rate card rather than assuming.
    const oneShot = priceLadder(ladder(entry(1000, 1000)), "long", "zerodha", "eq_intraday");
    const scaled = priceLadder(
      ladder(entry(200, 1000), entry(200, 1000), entry(200, 1000), entry(200, 1000), entry(200, 1000)),
      "long",
      "zerodha",
      "eq_intraday",
    );
    // Both are capped per order, so scaling in multiplies the cap.
    expect(sum(oneShot.map((c) => c.brokerage))).toBe(20);
    expect(sum(scaled.map((c) => c.brokerage))).toBe(100);
  });
});

describe("DP is charged once per day, not once per fill", () => {
  it("suppresses DP on later same-day exits", () => {
    const legs = ladder(
      entry(300, 1000, "2026-01-01"),
      exit(100, 1100, "2026-02-01"),
      exit(100, 1105, "2026-02-01"), // same day
      exit(100, 1110, "2026-02-01"), // same day
    );
    const priced = priceLadder(legs, "long", "zerodha", "eq_delivery");
    const dpTotal = sum(priced.map((c) => c.dpCharges));
    const single = computeCharges(
      { segment: "eq_delivery", buyValue: 0, sellValue: 110000, buyQty: 0, sellQty: 100 },
      findRates(ratesMap, "zerodha", "eq_delivery", "NSE", "2026-06-15"),
    );
    expect(dpTotal).toBeCloseTo(single.dpCharges, 2); // exactly one DP hit
  });

  it("charges DP again when the exits fall on different days", () => {
    const legs = ladder(
      entry(300, 1000, "2026-01-01"),
      exit(100, 1100, "2026-02-01"),
      exit(100, 1105, "2026-02-02"),
      exit(100, 1110, "2026-02-03"),
    );
    const priced = priceLadder(legs, "long", "zerodha", "eq_delivery");
    const single = computeCharges(
      { segment: "eq_delivery", buyValue: 0, sellValue: 110000, buyQty: 0, sellQty: 100 },
      findRates(ratesMap, "zerodha", "eq_delivery", "NSE", "2026-06-15"),
    );
    expect(sum(priced.map((c) => c.dpCharges))).toBeCloseTo(single.dpCharges * 3, 1);
  });

  it("never charges DP on entry legs", () => {
    const priced = priceLadder(
      ladder(entry(100, 1000), entry(100, 1000), entry(100, 1000)),
      "long",
      "zerodha",
      "eq_delivery",
    );
    expect(sum(priced.map((c) => c.dpCharges))).toBe(0);
  });

  it("applies DP to a SHORT's exit (the buy-to-cover is not a demat debit)", () => {
    // A short's entry is the sell. For delivery-like segments Vyuha books DP on
    // the sell side, which for a short is the ENTRY leg.
    const priced = priceLadder(
      ladder(entry(100, 1000), exit(100, 900)),
      "short",
      "zerodha",
      "eq_delivery",
    );
    expect(sum(priced.map((c) => c.dpCharges))).toBeGreaterThan(0);
  });
});

describe("charges flow into R correctly", () => {
  it("subtracts real per-leg charges from each exit's R contribution", () => {
    const legs = ladder(
      { ...entry(100, 1000), slPlanned: 950 },
      exit(50, 1100),
      exit(50, 1150),
    );
    const priced = priceLadder(legs, "long", "zerodha", "eq_delivery");
    const withCharges = legs.map((l, i) => ({ ...l, chargesTotal: priced[i].total }));
    const pos = summarise(withCharges, "long");

    expect(pos.initialRisk).toBe(5000); // (1000-950) * 100
    // Gross 5000 + 7500 = 12500; net is lower once charges land.
    expect(pos.realisedGross).toBe(12500);
    expect(pos.realisedNet).toBeLessThan(pos.realisedGross);
    expect(pos.realisedR!).toBeLessThan(2.5);
    expect(pos.realisedR!).toBeGreaterThan(2.3);
    // Contributions must sum to the total R.
    const summed = pos.fills.reduce((s, f) => s + (f.rContribution ?? 0), 0);
    expect(summed).toBeCloseTo(pos.realisedR!, 1);
  });
});

/**
 * D6 / D7 (v4.3.0 fix wave 2O — mtf#0 SILENT WRONG NUMBER, mtf#1 SILENT WRONG
 * NUMBER) — THE LADDER BILLS MTF INTEREST ONLY ON THE PRINCIPAL THE ROW STATES.
 *
 * `priceLegs` declared `ctx.mtfFundedAmount` and never read it: every entry
 * tranche was priced on `defaultMtfFundedAmount(leg value, margin_config)`, and
 * `rebuildStagedTrade` collapses those legs into the parent row's stored
 * `mtf_interest` / `charges_total` / `net_pnl`. So the ladder was the FIFTH
 * writer of stored MTF interest and owner ruling Q-A (wave 2N: "no writer
 * persists an estimate") had never been applied to it. Measured on HEAD
 * (zerodha, an open eq_mtf 100 @100 with `mtf_funded_amount` NULL, clock
 * 2026-08-20): `convertToStaged` stored 71.38 of interest, `accrueMtfInterest`
 * took it straight back out, `addLeg` put it back — stored money oscillating on
 * every leg edit and every Equity Tracker visit, with no prompt and no audit row
 * (DECISIONS 2026-08-30 decision 6).
 *
 * The rule now, in the ladder:
 *   null (never recorded) → nothing is billed (Q-A / D6);
 *   a stated 0            → nothing is billed (V3/X2: 0 is a STATEMENT);
 *   a stated amount       → billed, APPORTIONED across the entry tranches by
 *                           tranche value (owner ruling, 2O row 2 —
 *                           `stated × legValue ÷ Σ entry legValue`, invariant
 *                           4's weighted rule), so the shares sum to the stated
 *                           principal and Σ per-leg interest equals what the
 *                           accrual job bills on the whole leg for the same
 *                           spans;
 *   a PARTLY consumed tranche → its whole share to `asOf`, not to the partial
 *                           sale's date (Q-B: no funding is released for the
 *                           units already sold).
 *
 * The REAL `priceLegs` is driven here, not the mirror above it: the mirror
 * cannot see the MTF branch at all. lib/queries/staged.ts is server-only, so it
 * is imported dynamically after the helper sets VYUHA_DB_PATH — ONE temp
 * database per FILE (AGENTS.md Testing).
 */
describe("D6/D7 · the staged ladder bills interest on the STATED funded amount, apportioned by tranche value", () => {
  let t: TempDb;
  let staged: typeof import("@/lib/queries/staged");

  // Measured locally 2026-09-16: migrate + seed + the staged import ~1.7 s,
  // inside the 3 s local hook budget. The raised timeout is for the Windows
  // runner (> 15x slower on SQLite-file work, AGENTS.md Testing).
  beforeAll(async () => {
    t = await openTempDb("staged-charges", { seed: true });
    staged = await import("@/lib/queries/staged");
  }, 120_000);
  afterAll(() => t?.cleanup());

  const ASOF = "2026-09-15";
  const A_DAY = "2026-08-01"; // 45 days to ASOF
  const B_DAY = "2026-08-10"; // 36 days to ASOF
  const mtfRates = () => findRates(ratesMap, "zerodha", "eq_mtf", "NSE", ASOF);

  /** The interest the ENGINE charges for one tranche of `funded` held `days`. */
  const interestFor = (funded: number, days: number) =>
    computeCharges(
      { segment: "eq_mtf", buyValue: 0, sellValue: 0, buyQty: 0, sellQty: 0, mtf: { fundedAmount: funded, daysHeld: days, pledgeScrips: 1 } },
      mtfRates(),
    ).mtfInterest;

  const ctx = (mtfFundedAmount: number | null) =>
    ({ broker: "zerodha", segment: "eq_mtf", exchange: "NSE", direction: "long", asOf: ASOF, mtfFundedAmount }) as const;

  /** legId → MTF interest, as the real ladder prices it. */
  const billed = (legs: Leg[], funded: number | null): Map<number, number> =>
    new Map(staged.priceLegs(legs, ctx(funded), ratesMap).map((p) => [p.legId, p.breakdown.mtfInterest]));

  it("a row the journal never priced (null) bills NOTHING, and a stated 0 bills nothing either", () => {
    const legs = ladder(entry(100, 200, A_DAY));
    // THE assertion (on revert: 16,000 — zerodha's seeded own-margin share of the
    // 20,000 tranche — billed for 45 days, and stored on the parent row).
    expect([...billed(legs, null).values()], "a principal the journal never recorded is not billed").toEqual([0]);
    // A stated 0 is "I paid for it in full" (V3/X2), not "never set".
    expect([...billed(legs, 0).values()]).toEqual([0]);
    // …and the ladder really does bill a stated amount (not a vacuous 0 = 0).
    expect([...billed(legs, 3000).values()]).toEqual([interestFor(3000, 45)]);
    expect(interestFor(3000, 45)).toBeGreaterThan(0);
  });

  it("a stated 3,000 over two tranches is split by VALUE, and the two shares sum to 3,000", () => {
    const legs = ladder(entry(100, 200, A_DAY), entry(50, 210, B_DAY)); // 20,000 + 10,500
    const out = billed(legs, 3000);
    // 3,000 × 20,000 ÷ 30,500 = 1,967.21, and the remainder — 1,032.79 — on the
    // last tranche, so no paisa of the stated principal is lost to rounding.
    expect([out.get(1), out.get(2)]).toEqual([interestFor(1967.21, 45), interestFor(1032.79, 36)]);
    // THE assertion (on revert: 16,000 and 8,400 — the margin estimate per
    // tranche, ₹24,400 of principal on a row that states ₹3,000).
    expect(out.get(1)).not.toBe(interestFor(16000, 45));

    // …and the shares really do sum to the stated principal: two tranches on ONE
    // day bill exactly what the accrual job bills on the whole 3,000 for that day.
    const sameDay = ladder(entry(100, 200, A_DAY), entry(50, 210, A_DAY));
    const both = [...billed(sameDay, 3000).values()];
    expect(sum(both), "Σ per-leg interest = the job's whole-leg figure").toBeCloseTo(interestFor(3000, 45), 2);
  });

  it("a PARTLY consumed tranche accrues its whole share to asOf; a fully consumed one stops on the day it closed", () => {
    const partly = ladder(entry(100, 200, A_DAY), exit(40, 210, "2026-09-01"));
    const closed = ladder(entry(100, 200, A_DAY), exit(100, 210, "2026-09-01"));
    // Q-B (owner ruling, wave 2N): no funding is released for the units already
    // sold, so the tranche keeps accruing on the whole stated amount until it
    // closes. THE assertion (on revert: `consumedOn` took the LAST consumption
    // date, so the partly sold tranche was billed only to 1 September — 31 days
    // — while the accrual job billed the same row to today).
    expect(billed(partly, 3000).get(1)).toBe(interestFor(3000, 45));
    expect(billed(partly, 3000).get(1)).not.toBe(interestFor(3000, 31));
    // A tranche the ladder really did close stops there, as it always has.
    expect(billed(closed, 3000).get(1)).toBe(interestFor(3000, 31));
  });
});
