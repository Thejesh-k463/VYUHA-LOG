// v4.7.0 C3 — the Sizing Lab's journal Kelly, pure half (lib/analytics/journal-kelly.ts).
// Design: VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/C3-DESIGN-2026-10-04.md (K1–K7, D1–D12).
// The fail signatures pinned here are the design's "What WRONG looks like" list:
// a payoff filled from cap-unit R, a refusal carrying a payoff key, a slice list
// sorted by n, and the Lab's book slice disagreeing with the Clinic's book cell.
import { describe, it, expect } from "vitest";
import { edgeClinic, KELLY_MIN_N, type ClinicTrade } from "@/lib/analytics/edge-clinic";
import { journalKelly, journalKellySlices, allViewRefusal, type JournalKellyResult } from "@/lib/analytics/journal-kelly";

const TODAY = "2026-10-04";

let nextId = 1;
function trade(p: Partial<ClinicTrade>): ClinicTrade {
  return {
    id: nextId++,
    segment: "eq_intraday",
    buyQty: 10,
    sellQty: 10,
    side: "long",
    buyDate: "2026-01-05",
    sellDate: "2026-01-05",
    entryTime: null,
    exitTime: null,
    isOpen: false,
    grossPnl: 0,
    chargesTotal: 20,
    netPnl: 0,
    rMultiple: 0,
    riskAmount: 1000,
    riskSource: "set",
    rPlan: false,
    slPlanned: null,
    trailingSl: null,
    avgBuyPrice: 100,
    avgSellPrice: 100,
    setupTag: null,
    ruleViolations: null,
    entryDte: null,
    lotSize: null,
    ...p,
  };
}

/** The ISO day `i` days after 2025-01-01. */
const dayPlus = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
/** A deterministic, non-degenerate R series with winners and losers (mean ≈ +0.3). */
const rAt = (i: number) => (((i * 37) % 23) - 9) / 7 + 0.3;

function book(n: number, base: Partial<ClinicTrade>, start: number, r: (i: number) => number = rAt): ClinicTrade[] {
  return Array.from({ length: n }, (_, i) =>
    trade({ ...base, rMultiple: r(start + i), netPnl: r(start + i) * 1000, buyDate: dayPlus(start + i), sellDate: dayPlus(start + i) }),
  );
}

const ALL = { window: "all" as const, today: TODAY };
const REFUSAL_KEYS = ["n", "need", "of", "ok", "reason"];

describe("the floor is 30 trades with a real risk, per ACTIVE slice (K2, K4)", () => {
  const ts = [...book(30, { setupTag: "A" }, 0), ...book(12, { setupTag: "B" }, 30)];

  it("the whole account qualifies while a narrowed 12-trade setup refuses", () => {
    const whole = journalKelly(ts, ALL);
    expect(whole.ok).toBe(true);
    expect(whole).toMatchObject({ n: 42, of: 42, label: "Whole account" });
    const b = journalKelly(ts, { ...ALL, segment: "eq_intraday", setup: "B" });
    expect(b).toEqual({ ok: false, reason: "below-floor", n: 12, of: 12, need: 30 });
    expect(KELLY_MIN_N).toBe(30);
  });

  it("exactly 30 fills, 29 refuses", () => {
    expect(journalKelly(book(29, {}, 0), ALL)).toMatchObject({ ok: false, reason: "below-floor", n: 29 });
    expect(journalKelly(book(30, {}, 0), ALL)).toMatchObject({ ok: true, n: 30 });
  });
});

describe("the sample excludes cap-unit R (K1) and basis-less sales", () => {
  it("an all-cap book refuses with n 0 of M — never a payoff from cap units", () => {
    const r = journalKelly(book(60, { riskSource: "cap" }, 0), ALL);
    expect(r).toEqual({ ok: false, reason: "below-floor", n: 0, of: 60, need: 30 });
  });

  it("cap rows and basis-less equity sales are counted in `of`, never in `n`", () => {
    const ts = [
      ...book(31, {}, 0),
      ...book(40, { riskSource: "cap" }, 31, () => 5),
      ...book(4, { segment: "eq_delivery", avgBuyPrice: 0 }, 71, () => 9),
    ];
    const r = journalKelly(ts, ALL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.n, r.of]).toEqual([31, 75]);
    // The cap rows' +5 R and the basis-less +9 R would drag the win rate up; they are not in it.
    const realOnly = journalKelly(book(31, {}, 0), ALL);
    expect(realOnly.ok && [realOnly.winPpm, realOnly.payoffPpm]).toEqual([r.winPpm, r.payoffPpm]);
  });
});

describe("refusals are typed and carry NO win-rate or payoff key (D5)", () => {
  const refusals: [string, JournalKellyResult][] = [
    ["below-floor", journalKelly(book(5, {}, 0), ALL)],
    ["all-cap", journalKelly(book(40, { riskSource: "cap" }, 0), ALL)],
    ["no-losing-trades", journalKelly(book(35, {}, 0, () => 1.5), ALL)],
    ["all-view", allViewRefusal()],
  ];
  it.each(refusals)("%s: only ok / reason / n / of / need", (_name, r) => {
    expect(r.ok).toBe(false);
    expect(Object.keys(r).sort()).toEqual(REFUSAL_KEYS);
    for (const k of ["winPpm", "payoffPpm", "p", "b"]) expect(k in r, k).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/winPpm|payoffPpm/);
  });

  it("every R > 0 → no-losing-trades (b is +∞: no payoff can be stated)", () => {
    expect(journalKelly(book(35, {}, 0, () => 1.5), ALL)).toEqual({ ok: false, reason: "no-losing-trades", n: 35, of: 35, need: 30 });
  });

  it("zero winners fills p 0 / payoff 0 and marks it (K7): supportsSizingUp false, no ceiling", () => {
    const r = journalKelly(book(30, {}, 0, (i) => -0.5 - (i % 3) / 10), ALL);
    expect(r).toMatchObject({ ok: true, n: 30, p: 0, b: 0, winPpm: 0, payoffPpm: 0, supportsSizingUp: false, halfKellyLowerBound: null });
  });
});

describe("the 12-month window (D6): exit day within the 365 days ending today, inclusive", () => {
  // today 2026-10-04 → the window is 2025-10-05 .. 2026-10-04.
  const at = (sellDate: string) => trade({ rMultiple: 1, sellDate, buyDate: sellDate });
  const ts = [
    at("2025-10-04"), // one day too old
    at("2025-10-05"), // first day in
    at("05-10-2025"), // the 4.2.x DD-MM-YYYY shape, read through the engine's dayOf — in
    at("2026-10-04"), // today — in
    at("2026-10-05"), // after today — out
    trade({ rMultiple: 1, sellDate: null, buyDate: "2026-01-01" }), // no exit day — out of a dated window
  ];

  it("counts the boundary days exactly", () => {
    const twelve = journalKellySlices(ts, { window: "12m", today: TODAY })[0];
    expect([twelve.n, twelve.of]).toEqual([3, 3]);
    const all = journalKellySlices(ts, ALL)[0];
    expect([all.n, all.of]).toEqual([6, 6]);
    expect(journalKelly(ts, { window: "12m", today: TODAY })).toMatchObject({ ok: false, n: 3, of: 3 });
  });

  it("a narrowed window can refuse while all dates qualify", () => {
    const old = book(40, {}, 0); // 2025-01-01 .. 2025-02-09, all older than 12 months on 2026-10-04
    expect(journalKelly(old, ALL).ok).toBe(true);
    expect(journalKelly(old, { window: "12m", today: TODAY })).toEqual({ ok: false, reason: "below-floor", n: 0, of: 0, need: 30 });
  });
});

describe("the slice list (D7): fixed order, never by f or n", () => {
  // Inserted out of order, with the counts arranged so a sort by n would differ.
  const ts = [
    ...book(3, { segment: "index_option", setupTag: "zeta" }, 0),
    ...book(50, { segment: "eq_intraday", setupTag: "ORB" }, 3),
    ...book(2, { segment: "eq_intraday", setupTag: null }, 53),
    ...book(7, { segment: "eq_delivery", setupTag: "Base" }, 55),
    ...book(9, { segment: "eq_intraday", setupTag: "Gap" }, 62),
  ];

  it("book, then segments in SEGMENTS order, then segment × setup by segment then setup", () => {
    expect(journalKellySlices(ts, ALL).map((s) => s.key)).toEqual([
      "all|all",
      "eq_delivery|all",
      "eq_intraday|all",
      "index_option|all",
      "eq_delivery|setup:Base",
      "eq_intraday|setup:Gap",
      "eq_intraday|setup:ORB",
      "eq_intraday|setup:untagged",
      "index_option|setup:zeta",
    ]);
  });

  it("each slice carries its own n / of; the first is the whole account (the default)", () => {
    const s = journalKellySlices(ts, ALL);
    expect(s[0]).toMatchObject({ kind: "book", segment: null, setup: null, label: "Whole account", n: 71, of: 71 });
    expect(s.find((x) => x.key === "eq_intraday|setup:untagged")).toMatchObject({ kind: "setup", setup: "untagged", n: 2 });
    // A null setupTag reads under the Clinic's own "untagged" key.
    expect(journalKelly(ts, { ...ALL, segment: "eq_intraday", setup: "untagged" })).toMatchObject({ n: 2 });
  });

  it("the list is drawn from the whole book: the 12-month window keeps every slice, at 0 of 0", () => {
    const s = journalKellySlices(ts, { window: "12m", today: TODAY });
    expect(s).toHaveLength(9);
    expect(s.every((x) => x.n === 0 && x.of === 0)).toBe(true);
  });
});

describe("one Kelly: the Lab's book slice IS the Clinic's book cell (D1, D4)", () => {
  const ts = [
    ...book(45, { setupTag: "A" }, 0),
    ...book(20, { riskSource: "cap" }, 45, () => 4),
    ...book(25, { segment: "eq_delivery", setupTag: "B" }, 65, (i) => rAt(i * 3)),
    trade({ rMultiple: 2, isOpen: true }),
  ];

  it("n, p, pLo, b, bLo, the point Kelly and the ceiling agree to the bit, window all", () => {
    const cell = edgeClinic(ts, { today: TODAY }).cells.find((c) => c.key === "all|all")!;
    const lab = journalKelly(ts, ALL);
    expect(lab.ok).toBe(true);
    if (!lab.ok) return;
    const s = cell.sizing!;
    expect([lab.n, lab.p, lab.pLo, lab.b, lab.bLo, lab.kellyPoint, lab.halfKellyLowerBound]).toEqual([
      s.n, s.p, s.pLo, s.b, s.bLo, s.kellyPoint, s.halfKellyLowerBound,
    ]);
    expect(lab.n).toBe(cell.sizingSample.withRisk);
  });

  it("a segment slice agrees with the Clinic's segment cell", () => {
    const cell = edgeClinic(ts, { today: TODAY }).cells.find((c) => c.key === "eq_intraday|all")!;
    const lab = journalKelly(ts, { ...ALL, segment: "eq_intraday" });
    expect(lab.ok && [lab.n, lab.p, lab.b, lab.halfKellyLowerBound]).toEqual([cell.sizing!.n, cell.sizing!.p, cell.sizing!.b, cell.sizing!.halfKellyLowerBound]);
  });

  it("deterministic, and blind to input order (the engine's chronological order, ties by id)", () => {
    const a = journalKelly(ts, ALL);
    expect(journalKelly(ts, ALL)).toEqual(a);
    expect(journalKelly([...ts].reverse(), ALL)).toEqual(a);
  });
});
