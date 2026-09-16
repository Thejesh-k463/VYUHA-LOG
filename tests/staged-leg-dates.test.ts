import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { Leg } from "@/lib/domain/staged";

/**
 * G-G3-1 (v4.3.0 fix wave 2M) — the staged ladder prices off a leg date the
 * CALENDAR has, or it refuses the fill.
 *
 * Measured on HEAD 8ff4288 (the guard's own probe), angelone eq_mtf, entry
 * 100 @200 on 2026-08-20:
 *
 *   leg date '2026-08-20'  → charges 286.87, MTF interest 192.33   (honest)
 *   leg date '2026-02-31'  → charges 1544.40, interest 1449.86 — `new Date` rolls
 *       the impossible day to 3 March and the ladder bills seven months, then
 *       STORES it on the parent row. A silent wrong number.
 *   leg date 'not-a-date' / '31-08-2026' → days NaN → charges NaN → the INSERT
 *       threw `NOT NULL constraint failed: trade_legs.charges_total_paise`, the
 *       server action 500d instead of answering {ok:false}, AND the leg row was
 *       left behind against an unchanged parent — the half-applied ladder
 *       `addLeg`'s own doc comment promises never happens (invariant 5).
 *
 * The fix is one rule in two places: `validateLegs` (pure) refuses a date
 * `normalizeDate` cannot read, before any write; `priceLegs` resolves BOTH ends
 * of every tranche through the same calendar before counting a day.
 *
 * ONE temp database per FILE (AGENTS.md Testing); lib/queries/staged.ts is
 * server-only, so it is imported dynamically after the helper sets the path.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let staged: typeof import("@/lib/queries/staged");
let loadRatesMap: typeof import("@/lib/engine/rates-db").loadRatesMap;
let findRates: typeof import("@/lib/engine/rates").findRates;
let computeCharges: typeof import("@/lib/engine/charges").computeCharges;
let todayIstIso: typeof import("@/lib/domain/trading-day").todayIstIso;

const ENTRY_DAY = "2026-08-20";

// Measured locally 2026-09-16: migrate + seed + the staged/engine imports ~1.6 s,
// inside the 3 s local hook budget. The raised timeout is for the Windows runner
// (> 15x slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("staged-leg-dates", { seed: true });
  staged = await import("@/lib/queries/staged");
  ({ loadRatesMap } = await import("@/lib/engine/rates-db"));
  ({ findRates } = await import("@/lib/engine/rates"));
  ({ computeCharges } = await import("@/lib/engine/charges"));
  ({ todayIstIso } = await import("@/lib/domain/trading-day"));
}, 120_000);
afterAll(() => t?.cleanup());

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
const legsOf = (id: number) =>
  t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, id)).all().sort((a, b) => a.seq - b.seq);

let seq = 0;
/** What the seeded row RECORDS as broker-funded (D6/D7, wave 2O: the ladder bills
 *  interest on the stated principal and on nothing else). */
const FUNDED = 15000;
/** An open angelone eq_mtf position, 100 @200 bought on 2026-08-20, ₹15,000 of it
 *  broker-funded, staged. */
function stagedMtf(): number {
  const sym = `LEGDATE${++seq}`;
  const id = t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        broker: "angelone",
        bucket: "equity",
        segment: "eq_mtf",
        instrumentType: "equity",
        exchange: "NSE",
        symbol: sym,
        tradingsymbol: sym,
        buyQty: 100,
        avgBuyPrice: 200,
        buyValue: 20000,
        buyDate: ENTRY_DAY,
        buyOrderCount: 1,
        sellQty: 0,
        avgSellPrice: 0,
        sellValue: 0,
        sellDate: null,
        sellOrderCount: 0,
        isOpen: true,
        mtfFundedAmount: FUNDED,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;
  expect(staged.convertToStaged(id).ok, "the seed converts to a ladder").toBe(true);
  return id;
}

describe("G-G3-1 · addLeg refuses a date the calendar does not have, and writes NOTHING", () => {
  it.each([
    ["2026-02-31", "the impossible day that used to bill seven months of interest"],
    ["not-a-date", "the value that used to throw a NOT NULL constraint"],
    ["", "a fill with no date at all"],
  ])("tradeDate %j (%s): {ok:false}, no leg row, parent untouched", (bad) => {
    const id = stagedMtf();
    const before = row(id);
    const legsBefore = legsOf(id);

    // THE assertion. Before the fix this either stored a wrong number or THREW
    // `NOT NULL constraint failed: trade_legs.charges_total_paise` after the
    // INSERT had already landed.
    const res = staged.addLeg({ tradeId: id, kind: "entry", tradeDate: bad, qty: 50, price: 210, direction: "long" });
    expect(res.ok).toBe(false);
    expect(res.message).toBe(
      `The entry date “${bad}” is not a real calendar day — enter it as a day that exists, for example 2026-06-15. Nothing was changed.`,
    );

    // Invariant 5: no orphan leg, and the parent still describes the ladder.
    expect(legsOf(id)).toEqual(legsBefore);
    expect(legsOf(id)).toHaveLength(1);
    expect(row(id)).toEqual(before);
  });

  it("a day-first date the calendar DOES have is accepted, and STORED as the ISO day", () => {
    const id = stagedMtf();
    const res = staged.addLeg({ tradeId: id, kind: "entry", tradeDate: "31-08-2026", qty: 50, price: 210, direction: "long" });
    expect([res.ok, res.message]).toEqual([true, "Entry added."]);
    // One column, one convention — `sortLegs` orders these as strings.
    expect(legsOf(id).map((l) => l.tradeDate)).toEqual([ENTRY_DAY, "2026-08-31"]);
    // The parent holds the aggregate of both fills (invariant 5).
    expect([row(id).buyQty, row(id).buyValue]).toEqual([150, 30500]);
    expect(row(id).buyDate).toBe(ENTRY_DAY);
  });

  it("updateLeg refuses the same date the same way, and the stored fill does not move", () => {
    const id = stagedMtf();
    const leg = legsOf(id)[0];
    const res = staged.updateLeg(leg.id, { tradeDate: "2026-02-31" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("2026-02-31");
    expect(legsOf(id)[0]).toEqual(leg);
    // …and a readable day-first edit lands as ISO.
    expect(staged.updateLeg(leg.id, { tradeDate: "21-08-2026" }).ok).toBe(true);
    expect(legsOf(id)[0].tradeDate).toBe("2026-08-21");
  });

  /**
   * Found by the test above, pre-existing and unrelated to the date rule except
   * that a date-only patch is what exposes it: `leg_edit` passed the PATCH as its
   * `after` against a four-column `before`, which is the key-set asymmetry
   * lib/audit.ts exists to make impossible. Outside production it THREW
   * `AuditShapeError` — after the row had already been written and the ladder
   * rebuilt, so the leg edit landed and the action still failed.
   */
  it("the leg_edit audit entry states ONE key list on both sides, with the date it really wrote", () => {
    const id = stagedMtf();
    const leg = legsOf(id)[0];
    expect(staged.updateLeg(leg.id, { tradeDate: "22-08-2026", qty: 80 }).ok).toBe(true);

    const entry = t.db.select().from(t.schema.auditLog).all().filter((a) => a.action === "leg_edit").at(-1)!;
    const before = entry.beforeJson as Record<string, unknown>;
    const after = entry.afterJson as Record<string, unknown>;
    expect(Object.keys(before).sort()).toEqual(Object.keys(after).sort());
    expect([before.tradeDate, after.tradeDate]).toEqual([ENTRY_DAY, "2026-08-22"]);
    expect([before.qty, after.qty]).toEqual([100, 80]);
    // A column the patch never mentioned reads the same on both sides, so the
    // diff view cannot render a change that never happened.
    expect(after.note).toEqual(before.note);
  });
});

/**
 * D4 (v4.3.0 fix wave 2M, the seam round) — a REGRESSION this wave introduced.
 *
 * `convertToStaged` copies the PARENT's own dates onto the legs it seeds. Wave 2M
 * wrote `normalizeDate(t.buyDate) ?? today`, so a legacy row whose stored buy date
 * is not a calendar day was converted with {ok:true} and "Staged mode enabled." —
 * and its first leg AND its parent `buy_date` were silently re-dated to TODAY
 * (probe: `buyDate="2026-02-31" -> parent.buyDate="2026-09-16"`). The moved day
 * changes the tax pack's financial year, the MTF day count and the holding period.
 *
 * At HEAD only a NULL fell back to today. The conversion now REFUSES a non-null
 * date it cannot read, in the same sentence `validateLegs` and the trade editor
 * state, BEFORE it inserts anything — it can, because nothing is written until
 * both dates resolve, so invariant 5's half-applied ladder is not the cost here.
 * A NULL date still seeds today (HEAD's behaviour, unchanged).
 */
describe("D4 · convertToStaged refuses a stored date the calendar does not have, and writes NOTHING", () => {
  const refusal = (label: string, raw: string) =>
    `The ${label} “${raw}” is not a real calendar day — enter it as a day that exists, for example 2026-06-15. Nothing was changed.`;

  /** A plain (unstaged, leg-less) delivery row, dated however the caller says. */
  function legacyRow(over: Record<string, unknown>): number {
    const sym = `D4LEG${++seq}`;
    return t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          symbol: sym,
          tradingsymbol: sym,
          buyQty: 100,
          avgBuyPrice: 200,
          buyValue: 20000,
          buyOrderCount: 1,
          sellQty: 0,
          avgSellPrice: 0,
          sellValue: 0,
          sellDate: null,
          sellOrderCount: 0,
          isOpen: true,
          ...over,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
  }

  it.each([
    ["2026-02-31", "the impossible day the probe re-dated to today"],
    ["not-a-date", "text that states no day at all"],
    ["", "a stored blank, which `validateLegs` also refuses by name"],
  ])("buy date %j (%s): {ok:false}, no leg, the parent row byte-identical", (bad) => {
    const id = legacyRow({ buyDate: bad });
    const before = row(id);

    // THE assertion. Before the fix: {ok:true, "Staged mode enabled."} with the
    // leg and the parent both dated today.
    const res = staged.convertToStaged(id);
    expect([res.ok, res.message]).toEqual([false, refusal("buy date", bad)]);

    // Invariant 5: nothing inserted, nothing updated, staged mode still off.
    expect(legsOf(id)).toEqual([]);
    expect(row(id)).toEqual(before);
    expect(row(id).staged).toBeFalsy();
    expect(row(id).buyDate).toBe(bad);
  });

  it("a stored day-first buy date the calendar DOES have converts, and lands as the ISO day", () => {
    const id = legacyRow({ buyDate: "31-08-2026" });
    expect([staged.convertToStaged(id).ok, legsOf(id).map((l) => l.tradeDate)]).toEqual([true, ["2026-08-31"]]);
    // The parent holds the aggregate the ladder rebuilt (invariant 5).
    expect(row(id).buyDate).toBe("2026-08-31");
  });

  it("a NULL buy date still seeds today — the undated row's long-standing behaviour", () => {
    const id = legacyRow({ buyDate: null });
    const today = todayIstIso();
    expect([staged.convertToStaged(id).ok, legsOf(id).map((l) => l.tradeDate)]).toEqual([true, [today]]);
    expect(row(id).buyDate).toBe(today);
  });

  it("a SHORT row is refused on its sell date — the column the entry leg would copy", () => {
    const id = legacyRow({
      buyQty: 0,
      avgBuyPrice: 0,
      buyValue: 0,
      buyDate: null,
      buyOrderCount: 0,
      sellQty: 100,
      avgSellPrice: 200,
      sellValue: 20000,
      sellDate: "2026-02-31",
      sellOrderCount: 1,
    });
    const before = row(id);
    const res = staged.convertToStaged(id);
    expect([res.ok, res.message]).toEqual([false, refusal("sell date", "2026-02-31")]);
    expect(legsOf(id)).toEqual([]);
    expect(row(id)).toEqual(before);
  });

  it("a CLOSED long with a good buy date and an unreadable sell date is refused on the sell date", () => {
    const id = legacyRow({
      buyDate: ENTRY_DAY,
      sellQty: 100,
      avgSellPrice: 210,
      sellValue: 21000,
      sellDate: "2026-02-31",
      sellOrderCount: 1,
      isOpen: false,
    });
    const before = row(id);
    const res = staged.convertToStaged(id);
    expect([res.ok, res.message]).toEqual([false, refusal("sell date", "2026-02-31")]);
    // Not even the ENTRY leg, whose own date was fine: both dates resolve before
    // the first INSERT, so a refusal leaves no half-applied ladder.
    expect(legsOf(id)).toEqual([]);
    expect(row(id)).toEqual(before);
  });
});

describe("G-G3-1 · the ladder bills the days the dates really are", () => {
  /**
   * MTF interest the engine charges for ONE open tranche of `funded` principal
   * held `days` days.
   *
   * D6/D7 (wave 2O): the principal is the one the ROW STATES, apportioned across
   * the entry tranches by value — it is no longer
   * `defaultMtfFundedAmount(leg value, margin_config)`, which made the ladder the
   * fifth writer of an estimate into stored money (owner ruling Q-A). The DATE
   * rule this describe exists for is unchanged, so the seed now states a funded
   * amount; a row that states none bills nothing, which the last case pins.
   */
  const interestFor = (funded: number, value: number, qty: number, days: number, asOf: string) => {
    const rates = findRates(loadRatesMap(), "angelone", "eq_mtf", "NSE", asOf);
    return computeCharges(
      {
        segment: "eq_mtf",
        buyValue: value,
        sellValue: 0,
        buyQty: qty,
        sellQty: 0,
        buyOrderCount: 1,
        sellOrderCount: 0,
        mtf: { fundedAmount: funded, daysHeld: days, pledgeScrips: 1 },
      },
      rates,
    ).mtfInterest;
  };
  const daysTo = (from: string, to: string) =>
    Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86400000));

  it("a second entry added day-first stores the interest its RESOLVED day earns — to the paisa", () => {
    const id = stagedMtf();
    expect(staged.addLeg({ tradeId: id, kind: "entry", tradeDate: "31-08-2026", qty: 50, price: 210, direction: "long" }).ok).toBe(true);

    const asOf = todayIstIso();
    // D7 (wave 2O): the row states 15,000, split by tranche value across
    // 20,000 + 10,500 = 30,500 — 9,836.07 on the first tranche and the
    // remainder, 5,163.93, on the second, so the two shares sum to the 15,000
    // the row states (owner ruling, 2O row 2).
    const expected =
      Math.round((interestFor(9836.07, 20000, 100, daysTo(ENTRY_DAY, asOf), asOf) + interestFor(5163.93, 10500, 50, daysTo("2026-08-31", asOf), asOf)) * 100) / 100;

    // THE assertion: the stored figure is the one the two REAL holding periods
    // earn. Before the fix this row could not be written at all (NaN charges).
    expect(row(id).mtfInterest).toBe(expected);
    expect(expected, "the ladder really does bill interest (not a vacuous 0 = 0)").toBeGreaterThan(0);
  });

  it("the same ladder entered ISO and day-first stores the same money", () => {
    const iso = stagedMtf();
    const dmy = stagedMtf();
    expect(staged.addLeg({ tradeId: iso, kind: "entry", tradeDate: "2026-08-31", qty: 50, price: 210, direction: "long" }).ok).toBe(true);
    expect(staged.addLeg({ tradeId: dmy, kind: "entry", tradeDate: "31-08-2026", qty: 50, price: 210, direction: "long" }).ok).toBe(true);
    const figures = (id: number) => [row(id).chargesTotal, row(id).mtfInterest, row(id).netPnl];
    expect(figures(dmy)).toEqual(figures(iso));
  });

  /**
   * `priceLegs` is the read half of the rule, and the only half a LEGACY row can
   * still reach: a leg dated before this wave can hold anything. Both ends of
   * each tranche are resolved through the one calendar, so an unreadable date
   * counts ZERO days — it never rolls forward into money (invariant 6).
   */
  it("priceLegs resolves both ends: an impossible leg date bills no days, a day-first one bills its real days", () => {
    const asOf = "2026-09-15";
    const map = loadRatesMap();
    const leg = (tradeDate: string): Leg[] => [{ id: 1, kind: "entry", seq: 1, tradeDate, qty: 100, price: 200 }];
    const ctx = { broker: "angelone", segment: "eq_mtf", exchange: "NSE", direction: "long", asOf, mtfFundedAmount: FUNDED } as const;
    const interest = (tradeDate: string) => staged.priceLegs(leg(tradeDate), ctx, map)[0].breakdown.mtfInterest;

    const honest = interest(ENTRY_DAY);
    expect(honest).toBeGreaterThan(0);
    // …and it is billed on the 15,000 the row STATES, not on the margin-config
    // estimate for the 20,000 tranche (D6/D7, wave 2O — mtf#0/mtf#1).
    expect(honest).toBe(interestFor(FUNDED, 20000, 100, daysTo(ENTRY_DAY, asOf), asOf));
    // '2026-02-31' rolled to 3 March and billed 1449.86 against this 192.33.
    expect(interest("2026-02-31")).toBe(0);
    // 'not-a-date' was NaN, which is what reached the NOT NULL column.
    expect(interest("not-a-date")).toBe(0);
    // …and the day-first form of the SAME day bills the same money as the ISO one.
    expect(interest("20-08-2026")).toBe(honest);

    // D6 — a row that states NO principal bills nothing, on a date the calendar
    // has. On revert: 192.33 of interest from the margin table, written into the
    // parent row's stored money and taken back out by the accrual job on the next
    // /equity render (mtf#0's oscillation).
    const unstated = { ...ctx, mtfFundedAmount: null };
    expect(staged.priceLegs(leg(ENTRY_DAY), unstated, map)[0].breakdown.mtfInterest).toBe(0);
    // …and the pledge fee goes with it: the engine gates both on the same
    // `fundedAmount > 0`, so an unpriced row is billed exactly like a stated 0.
    expect(staged.priceLegs(leg(ENTRY_DAY), unstated, map)[0].breakdown.pledgeCharges).toBe(0);
  });
});
