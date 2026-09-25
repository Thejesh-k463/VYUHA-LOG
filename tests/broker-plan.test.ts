import { describe, expect, it } from "vitest";
import {
  epochSpans,
  findRates,
  mtfInterestOver,
  planSpans,
  plansFor,
  resolvePlan,
  resolvePlanAcross,
  seedRatesMap,
  type PlanAccount,
} from "@/lib/engine/rates";
import { computeCharges } from "@/lib/engine/charges";
import { buildChargeConfigSeed } from "@/lib/db/seed-data";
import type { Exchange, Segment } from "@/lib/domain/constants";

/**
 * WAVE U (v4.5.0) — WHICH PLAN PRICES A TRADE, the pure half.
 *
 * Upstox is the second broker in `charge_config` to sell more than one pricing
 * plan (Kotak Neo was the first), and the first whose paid tier the owner is
 * actually on. That made a rule that had never been exercised load-bearing:
 * `findRates` has taken a `plan` argument since v3.0, and until this wave every
 * single call site passed the default. Everything asserted here is the RULE
 * (`lib/engine/rates.ts`, pure, invariant 2); the READ — which account, what it
 * states — is `lib/queries/broker-plan.ts` and is swept in
 * tests/broker-plan-db.test.ts, and the preview-equals-save half is in
 * tests/preview-equals-save-matrix.test.ts.
 *
 * Every figure below comes from the seed under test, never from a literal
 * copied out of it, EXCEPT the four the owner's sources state (₹20 → ₹30 flat,
 * 2.5% and 0.1% caps, 14.60% p.a., ₹20 DP) — those are the facts the seed is
 * supposed to encode, so pinning them is the point.
 */

const map = seedRatesMap();
const seed = buildChargeConfigSeed();

/** Every (segment, exchange) `charge_config` prices for a broker+plan. */
const combosOf = (broker: string, plan: string) =>
  [...new Set(seed.filter((r) => r.broker === broker && r.plan === plan).map((r) => `${r.segment}|${r.exchange}`))].sort();

const PLUS: PlanAccount = { broker: "upstox", brokerPlan: "plus", brokerPlanFrom: null };

// ---------------------------------------------------------------------------
// 1 — what the seed states about Upstox Basic and Upstox Plus
// ---------------------------------------------------------------------------

describe("1 · the Upstox rate cards the seed emits", () => {
  const on = "2026-08-28";
  const basic = (segment: Segment, exchange: Exchange = "NSE") => findRates(map, "upstox", segment, exchange, on);
  const plus = (segment: Segment, exchange: Exchange = "NSE") => findRates(map, "upstox", segment, exchange, on, "plus");

  it("Plus is a real second plan on file, labelled, and free to subscribe to (owner ruling U3)", () => {
    expect(plansFor(map, "upstox")).toEqual(["default", "plus"]);
    expect(plus("index_option").planLabel).toBe("Upstox Plus");
    // U3 verbatim: "No subscription charges, just few changes to other fees they
    // charge." The ₹10/order premium IS the price of the tier, so amortising a
    // monthly fee nobody is billed would overstate its cost in the very report
    // that exists to compare cost. D4 keys the "· paid" badge off this field.
    expect(plus("index_option").subscriptionMonthly).toBe(0);
    expect(basic("index_option").subscriptionMonthly).toBe(0);
  });

  it("F&O brokerage: ₹20 flat on Basic, ₹30 flat on Plus, no percentage either side", () => {
    for (const seg of ["index_option", "stock_option", "future"] as Segment[]) {
      expect([basic(seg).brokerageFlat, basic(seg).brokeragePct, basic(seg).brokerageCap], seg).toEqual([20, 0, null]);
      expect([plus(seg).brokerageFlat, plus(seg).brokeragePct, plus(seg).brokerageCap], seg).toEqual([30, 0, null]);
    }
    for (const seg of ["commodity_future", "commodity_option"] as Segment[]) {
      expect(basic(seg, "MCX").brokerageFlat, seg).toBe(20);
      expect(plus(seg, "MCX").brokerageFlat, seg).toBe(30);
    }
  });

  it("equity brokerage: the CAP moves ₹20 → ₹30, the percentage does not move at all (D2)", () => {
    // D2 (2026-09-22): delivery and MTF are "₹20 or 2.5%, whichever is LOWER"
    // — upstox.com/help-center/t-248665. Only INTRADAY is the 0.1% form. The
    // seed had all three at 0.1%, which under-billed every delivery order below
    // ₹20,000. Upstox's own Plus page says the caps are identical across plans.
    for (const seg of ["eq_delivery", "eq_mtf"] as Segment[]) {
      expect([basic(seg).brokeragePct, basic(seg).brokerageCap], seg).toEqual([0.025, 20]);
      expect([plus(seg).brokeragePct, plus(seg).brokerageCap], seg).toEqual([0.025, 30]);
      expect(basic(seg).brokerageFlat, seg).toBeNull();
      expect(plus(seg).brokerageFlat, seg).toBeNull();
    }
    expect([basic("eq_intraday").brokeragePct, basic("eq_intraday").brokerageCap]).toEqual([0.001, 20]);
    expect([plus("eq_intraday").brokeragePct, plus("eq_intraday").brokerageCap]).toEqual([0.001, 30]);
  });

  it("the DP charge is ₹20 on both plans, GST-bearing, with no minimum (D3, owner ruling U2)", () => {
    // upstox.com/brokerage-charges: "₹ 20.0 per scrip per day only on sell".
    // A paid plan inherits every head it does not restate, so Plus's DP is
    // Basic's — asserted, because `emit` falling through is the mechanism.
    for (const seg of ["eq_delivery", "eq_mtf"] as Segment[]) {
      expect([basic(seg).dpCharge, basic(seg).dpGstApplicable, basic(seg).dpMinValue, basic(seg).dpPct], seg).toEqual([20, true, 0, 0]);
      expect([plus(seg).dpCharge, plus(seg).dpGstApplicable, plus(seg).dpMinValue, plus(seg).dpPct], seg).toEqual([20, true, 0, 0]);
    }
  });

  it("MTF interest: 18.25% p.a. on Basic, 14.60% on Plus, both published, neither a literal in logic", () => {
    // Plus: "₹20 per ₹50,000 borrowed per day" = 0.04%/day × 365 = 14.60%.
    // Basic: ₹20 per ₹40,000 = 0.05%/day = 18.25%. Invariant 3 — the figure is
    // a RATE ROW, so this reads it back out of the seeded card.
    expect(plus("eq_mtf").mtfInterestAnnual).toBe(0.146);
    expect(basic("eq_mtf").mtfInterestAnnual).toBe(0.1825);
    expect([basic("eq_mtf").mtfRateUnknown, plus("eq_mtf").mtfRateUnknown]).toEqual([false, false]);
  });

  it("every statutory head is Basic's: a plan is a BROKERAGE tier, never a tax rate (invariant 3)", () => {
    for (const [segment, exchange] of combosOf("upstox", "plus").map((c) => c.split("|") as [Segment, Exchange])) {
      const b = findRates(map, "upstox", segment, exchange, on);
      const p = findRates(map, "upstox", segment, exchange, on, "plus");
      const heads = (r: typeof b) => [r.sttPct, r.sttSide, r.exchangeTxnPct, r.sebiPct, r.stampPct, r.ipftPct, r.gstPct];
      expect(heads(p), `${segment}/${exchange}`).toEqual(heads(b));
    }
  });
});

// ---------------------------------------------------------------------------
// 2 — the plan prices EVERY combo, not just the ones somebody remembered
// ---------------------------------------------------------------------------

describe("2 · every (segment, exchange) Upstox trades resolves under `plus`", () => {
  it("Plus covers exactly the combos Basic covers, and findRates answers on every one", () => {
    const basicCombos = combosOf("upstox", "default");
    expect(combosOf("upstox", "plus")).toEqual(basicCombos);
    // Re-pinned 2026-09-22 (v4.5.0 wave 3a, ruling R90): 13 → 17. The seed emits the two ETF STT
    // RATE ROWS under EVERY plan, not only "default" — `findRates` keys on the plan, so a missing
    // `upstox|plus|etf_equity|NSE` row would send a Plus account's ETF sale back to the
    // equity-share rate SILENTLY (the overlay falls back rather than throwing). So Plus gains the
    // same 4 combos Basic does (etf_equity/etf_other × NSE/BSE) and the two sets still match
    // exactly — which is the property this case is actually for.
    expect(basicCombos.length).toBe(17);
    for (const c of basicCombos) {
      const [segment, exchange] = c.split("|") as [Segment, Exchange];
      // Would THROW if the plan were missing an epoch covering the date — the
      // failure mode that aborts a whole import, so it is swept, not sampled.
      for (const on of ["2000-01-03", "2016-06-01", "2024-10-01", "2026-04-01", "2026-09-22"]) {
        const r = findRates(map, "upstox", segment, exchange, on, "plus");
        expect([r.broker, r.plan, r.segment, r.exchange], `${c} on ${on}`).toEqual(["upstox", "plus", segment, exchange]);
      }
    }
  });

  it("Plus's epochs tile history exactly as Basic's do — same boundaries, one open row", () => {
    for (const c of combosOf("upstox", "plus")) {
      const [segment, exchange] = c.split("|");
      const rowsOf = (plan: string) =>
        seed
          .filter((r) => r.broker === "upstox" && r.plan === plan && r.segment === segment && r.exchange === exchange)
          .map((r) => [r.effectiveFrom ?? "1970-01-01", r.effectiveTo ?? null])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      expect(rowsOf("plus"), c).toEqual(rowsOf("default"));
      expect(rowsOf("plus").filter(([, to]) => to == null), c).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — resolvePlan's four guards, one at a time
// ---------------------------------------------------------------------------

describe("3 · resolvePlan: four guards, each falsified on its own", () => {
  const ON = "2026-08-28";

  it("guard 1 — an account that states no plan (or states 'default') prices at default", () => {
    expect(resolvePlan(null, "upstox", ON, map)).toBe("default");
    expect(resolvePlan(undefined, "upstox", ON, map)).toBe("default");
    expect(resolvePlan({ broker: "upstox", brokerPlan: null }, "upstox", ON, map)).toBe("default");
    expect(resolvePlan({ broker: "upstox", brokerPlan: "  " }, "upstox", ON, map)).toBe("default");
    expect(resolvePlan({ broker: "upstox", brokerPlan: "default" }, "upstox", ON, map)).toBe("default");
    // …and the control: with the guard satisfied it really does resolve.
    expect(resolvePlan(PLUS, "upstox", ON, map)).toBe("plus");
  });

  it("guard 2 — the account's broker must BE the trade's broker; a foreign row never throws", () => {
    // Design review item 2: an upstox/plus account holding a Zerodha row must
    // not ask charge_config for `zerodha | plus`, which would throw and abort a
    // whole import. This is the guard that keeps a mixed book importable.
    expect(resolvePlan(PLUS, "zerodha", ON, map)).toBe("default");
    expect(resolvePlan(PLUS, null, ON, map)).toBe("default");
    expect(resolvePlan(PLUS, undefined, ON, map)).toBe("default");
    expect(resolvePlan({ broker: null, brokerPlan: "plus" }, "upstox", ON, map)).toBe("default");
    expect(() => resolvePlan(PLUS, "zerodha", ON, map)).not.toThrow();
    // …and the resolved plan is a key `findRates` can actually serve, which is
    // the whole reason the guard exists.
    expect(() => findRates(map, "zerodha", "eq_delivery", "NSE", ON, resolvePlan(PLUS, "zerodha", ON, map))).not.toThrow();
    expect(() => findRates(map, "zerodha", "eq_delivery", "NSE", ON, "plus")).toThrow();
    // Case and padding are the account's, not the rule's.
    expect(resolvePlan({ broker: " UPSTOX ", brokerPlan: "plus" }, "Upstox", ON, map)).toBe("plus");
  });

  it("guard 3 — a plan key charge_config does not hold prices at default rather than throwing", () => {
    // A plan name left behind by an older build, or a row the user deleted.
    expect(resolvePlan({ broker: "upstox", brokerPlan: "pro-max" }, "upstox", ON, map)).toBe("default");
    expect(resolvePlan({ broker: "dhan", brokerPlan: "plus" }, "dhan", ON, map)).toBe("default");
    expect(() => resolvePlan({ broker: "dhan", brokerPlan: "plus" }, "dhan", ON, map)).not.toThrow();
  });

  it("guard 4 — a date before `brokerPlanFrom` is Basic; blank means ALWAYS (owner ruling U1)", () => {
    const from = { ...PLUS, brokerPlanFrom: "2026-08-01" };
    expect(resolvePlan(from, "upstox", "2026-07-31", map)).toBe("default");
    expect(resolvePlan(from, "upstox", "2026-08-01", map)).toBe("plus"); // inclusive
    expect(resolvePlan(from, "upstox", "2026-08-02", map)).toBe("plus");
    // U1: the owner is on Plus for the whole history, so blank = always.
    expect(resolvePlan({ ...PLUS, brokerPlanFrom: "" }, "upstox", "1999-01-01", map)).toBe("plus");
    expect(resolvePlan({ ...PLUS, brokerPlanFrom: null }, "upstox", "1999-01-01", map)).toBe("plus");
    // The date argument is read through the same dd-mm-yyyy tolerance the rest
    // of this module uses (a Groww row is priced before normalizeDate runs).
    expect(resolvePlan(from, "upstox", "31-07-2026", map)).toBe("default");
    expect(resolvePlan(from, "upstox", "02-08-2026", map)).toBe("plus");
  });
});

// ---------------------------------------------------------------------------
// 4 — planSpans and mtfInterestOver
// ---------------------------------------------------------------------------

describe("4 · planSpans tiles the holding period and splits at broker_plan_from", () => {
  const CUT = "2026-08-01";
  const acct: PlanAccount = { broker: "upstox", brokerPlan: "plus", brokerPlanFrom: CUT };

  it("a period wholly on one side of the cut is ONE span (the common case is untouched)", () => {
    expect(planSpans(acct, "upstox", "2026-06-01", "2026-07-01", map)).toEqual([{ plan: "default", from: "2026-06-01", to: "2026-07-01" }]);
    expect(planSpans(acct, "upstox", "2026-08-01", "2026-09-01", map)).toEqual([{ plan: "plus", from: "2026-08-01", to: "2026-09-01" }]);
    expect(planSpans(null, "upstox", "2026-06-01", "2026-09-01", map)).toEqual([{ plan: "default", from: "2026-06-01", to: "2026-09-01" }]);
    expect(planSpans(acct, "zerodha", "2026-06-01", "2026-09-01", map)).toEqual([{ plan: "default", from: "2026-06-01", to: "2026-09-01" }]);
  });

  it("a period that straddles the cut is TWO spans that tile [from, to) exactly, split AT the cut", () => {
    const spans = planSpans(acct, "upstox", "2026-07-15", "2026-08-20", map);
    expect(spans).toEqual([
      { plan: "default", from: "2026-07-15", to: CUT },
      { plan: "plus", from: CUT, to: "2026-08-20" },
    ]);
    // Tiling: oldest first, abutting, no overlap, same endpoints as the whole.
    expect(spans[0].to).toBe(spans[1].from);
    expect([spans[0].from, spans[spans.length - 1].to]).toEqual(["2026-07-15", "2026-08-20"]);
    // An empty or inverted period yields nothing, exactly as epochSpans does.
    expect(planSpans(acct, "upstox", "2026-08-20", "2026-08-20", map)).toEqual([]);
    expect(planSpans(acct, "upstox", "2026-08-20", "2026-07-15", map)).toEqual([]);
  });

  it("mtfInterestOver = Basic days × Basic rate + Plus days × Plus rate, to the paisa", () => {
    const t = { broker: "upstox", exchange: "NSE" };
    const funded = 100_000;
    const from = "2026-07-15";
    const to = "2026-08-20";
    const basicRate = findRates(map, "upstox", "eq_mtf", "NSE", from).mtfInterestAnnual;
    const plusRate = findRates(map, "upstox", "eq_mtf", "NSE", to, "plus").mtfInterestAnnual;
    expect(basicRate).not.toBe(plusRate); // else the split proves nothing

    // Day counts from the engine's OWN span walk, so this asserts the split and
    // not a second implementation of a calendar.
    const days = (plan: string, a: string, b: string) =>
      epochSpans(map, "upstox", "eq_mtf", "NSE" as Exchange, a, b, plan).reduce((s, x) => s + x.days, 0);
    const basicDays = days("default", from, CUT);
    const plusDays = days("plus", CUT, to);
    expect(basicDays + plusDays).toBe(days("default", from, to)); // the split loses no day

    const expected = Math.round(((funded * basicRate * basicDays) / 365 + (funded * plusRate * plusDays) / 365) * 100) / 100;
    expect(mtfInterestOver(map, t, funded, acct, from, to)).toBe(expected);
    // …and it is NOT either single-plan figure, so a half-applied split reddens.
    expect(mtfInterestOver(map, t, funded, acct, from, to)).not.toBe(mtfInterestOver(map, t, funded, null, from, to));
    expect(mtfInterestOver(map, t, funded, acct, from, to)).not.toBe(mtfInterestOver(map, t, funded, { ...acct, brokerPlanFrom: null }, from, to));
  });

  it("a book on no plan accrues precisely what it accrued before plans existed", () => {
    const t = { broker: "upstox", exchange: "NSE" };
    const legacy = epochSpans(map, "upstox", "eq_mtf", "NSE" as Exchange, "2026-06-01", "2026-09-01").reduce(
      (s, x) => s + (50_000 * x.rates.mtfInterestAnnual * x.days) / 365,
      0,
    );
    expect(mtfInterestOver(map, t, 50_000, null, "2026-06-01", "2026-09-01")).toBe(Math.round(legacy * 100) / 100);
  });
});

// ---------------------------------------------------------------------------
// 14a — resolvePlanAcross: unanimity or nothing
// ---------------------------------------------------------------------------

describe("14a · resolvePlanAcross — a view has one honest plan or none", () => {
  const ON = "2026-08-28";
  const basicUpstox: PlanAccount = { broker: "upstox", brokerPlan: null, brokerPlanFrom: null };
  const zerodha: PlanAccount = { broker: "zerodha", brokerPlan: null, brokerPlanFrom: null };

  it("one account in view = that account's plan", () => {
    expect(resolvePlanAcross([PLUS], "upstox", ON, map)).toBe("plus");
    expect(resolvePlanAcross([basicUpstox], "upstox", ON, map)).toBe("default");
  });

  it("several accounts on the broker that AGREE = that plan", () => {
    expect(resolvePlanAcross([PLUS, { ...PLUS }, zerodha], "upstox", ON, map)).toBe("plus");
  });

  it("accounts on the broker that DISAGREE = default — invariant 6, never a fabricated answer", () => {
    expect(resolvePlanAcross([PLUS, basicUpstox], "upstox", ON, map)).toBe("default");
    // …including disagreement created only by the DATE, which is the subtle one.
    expect(resolvePlanAcross([{ ...PLUS, brokerPlanFrom: "2026-09-01" }, PLUS], "upstox", ON, map)).toBe("default");
  });

  it("no account on the broker at all = default (an empty view invents nothing)", () => {
    expect(resolvePlanAcross([], "upstox", ON, map)).toBe("default");
    expect(resolvePlanAcross([zerodha], "upstox", ON, map)).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// 16 — the owner's own 2026-08-28 option day
// ---------------------------------------------------------------------------

describe("16 · the owner's 2026-08-28 option day: Plus costs exactly ₹10 an order more", () => {
  /**
   * The three contracts of the Upstox trade report fixture (pinned to the fill
   * in tests/golden-books.test.ts), priced here by the ENGINE on both cards.
   *
   * What is asserted is the DIFFERENCE — 6 orders × ₹10 × 1.18 GST — because
   * that is what the plan is: Upstox's own Plus page says the flat fee per order
   * goes ₹20 → ₹30 and nothing else moves. The ABSOLUTE engine figure is NOT
   * pinned to the owner's ledger: there is a residual of about ₹1 from
   * statutory rounding. Each position here has ONE sell order, so per-order and
   * per-position are the same thing: the engine rounds STT once per position
   * (4 + 3 + 3 = ₹10), while the ledger's ₹9 is ONE rounding for the whole
   * contract note. Sized and ACCEPTED in v4.6.0 W7 (owner answer Q2; DECISIONS
   * 2026-09-25) and pinned to that cause by the last case below — never folded
   * into the plan difference, which would make the plan look wrong when it is right.
   */
  const CONTRACTS = [
    { segment: "index_option" as Segment, exchange: "NSE" as Exchange, buyQty: 65, buyValue: 65 * 38, sellQty: 65, sellValue: 65 * 36.7 },
    { segment: "index_option" as Segment, exchange: "NSE" as Exchange, buyQty: 65, buyValue: 65 * 32.3, sellQty: 65, sellValue: 65 * 31.4 },
    { segment: "index_option" as Segment, exchange: "BSE" as Exchange, buyQty: 20, buyValue: 20 * 90.05, sellQty: 20, sellValue: 20 * 90.8 },
  ];
  const ON = "2026-08-28";
  const ORDERS = CONTRACTS.length * 2; // one buy order and one sell order each

  const bill = (plan: string) =>
    Math.round(
      CONTRACTS.reduce((s, c) => {
        const r = findRates(map, "upstox", c.segment, c.exchange, ON, plan);
        return s + computeCharges({ ...c, buyOrderCount: 1, sellOrderCount: 1, mtf: null }, r).total;
      }, 0) * 100,
    ) / 100;

  it("Plus − Basic = orders × ₹10 × GST, exactly", () => {
    const basic = bill("default");
    const plus = bill("plus");
    const gst = findRates(map, "upstox", "index_option", "NSE", ON).gstPct;
    expect(gst).toBe(0.18);
    expect(Math.round((plus - basic) * 100) / 100).toBe(Math.round(ORDERS * 10 * (1 + gst) * 100) / 100);
    expect(Math.round((plus - basic) * 100) / 100).toBe(70.8);
  });

  it("…and Plus lands within ₹2 of the ₹226.57 the owner's own Upstox ledger debited that day", () => {
    // MEASURED, not pinned: the ledger's single F&O bill for 28-08-2026 is
    // ₹354.57, of which ₹128.00 is the options' gross, leaving ₹226.57 of
    // charges (tests/golden-books.test.ts derives the same figure from the
    // committed ledger fixture). Basic was ₹69.81 short of it — almost exactly
    // the ₹70.80 above, which is what identified Plus in the first place.
    const plus = bill("plus");
    const basic = bill("default");
    expect(Math.abs(plus - 226.57), `plus billed ${plus}`).toBeLessThanOrEqual(2);
    expect(Math.abs(basic - 226.57), `basic billed ${basic}`).toBeGreaterThan(2);
  });

  it("…and the ~₹1 residual IS the day's STT rounded once on the contract note vs per row (v4.6.0 W7, accepted)", () => {
    // From the rate card, never a literal: each contract's STT unrounded, then
    // rounded per row (what the engine books) and once for the day (the note).
    const raw = CONTRACTS.map((c) => {
      const r = findRates(map, "upstox", c.segment, c.exchange, ON, "plus");
      const base = r.sttSide === "both" ? c.buyValue + c.sellValue : r.sttSide === "buy" ? c.buyValue : r.sttSide === "sell" ? c.sellValue : 0;
      return r.sttPct * base;
    });
    const perRow = raw.reduce((s, v) => s + Math.round(v), 0);
    const once = Math.round(raw.reduce((s, v) => s + v, 0));
    const delta = perRow - once;
    expect(delta, `per row ${perRow} vs once ${once}`).toBe(1);
    // What is left after the STT rounding is SEBI/GST paisa, nothing more.
    const plus = bill("plus");
    expect(Math.abs(plus - 226.57 - delta), `plus billed ${plus}`).toBeLessThanOrEqual(0.02);
  });
});

// ---------------------------------------------------------------------------
// 10 — the plan control is offered only where there is a question to ask
// ---------------------------------------------------------------------------

describe("10 · which brokers get a plan picker is DERIVED, never a broker name", () => {
  it("plansFor names every plan on file for a broker, 'default' first, and nothing for an unknown one", () => {
    expect(plansFor(map, "upstox")).toEqual(["default", "plus"]);
    expect(plansFor(map, "zerodha")).toEqual(["default"]);
    expect(plansFor(map, "dhan")).toEqual(["default"]);
    expect(plansFor(map, "not-a-broker")).toEqual([]);
    // The brokers with a question to ask are exactly those with >1 plan — the
    // derivation `brokerPlanOptions` (and so the account editor) runs on.
    const multi = [...new Set(seed.map((r) => r.broker))].filter((b) => plansFor(map, b).length > 1).sort();
    // v4.6.0 W9: Fyers (Standard / Prime) and Nuvama (Lite Plus / Elite) joined the two-plan brokers.
    expect(multi).toEqual(["fyers", "kotakneo", "nuvama", "upstox"]);
  });
});
