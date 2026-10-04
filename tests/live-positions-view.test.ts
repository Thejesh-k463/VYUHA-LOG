import { describe, expect, it } from "vitest";
import {
  CORP_ACTION_LOOKBACK_DAYS,
  cohortConcentration,
  corpActionsFor,
  headerTotals,
  isoMinusDays,
  nearStop,
  partialOf,
  prevCloseOf,
  riskLensSummary,
  sinceClose,
  staleCount,
  stopChip,
  stopState,
  upcoming,
  type PositionViewRow,
} from "@/lib/live/positions-view";
import { portfolioHeat, type HeatView } from "@/lib/live/heat";

/**
 * The `/live` Positions tab's pure arithmetic (v4.7.0 wave C4). Integer paise
 * and ppm throughout; null where a denominator is missing (invariant 6). Every
 * function is exercised on the short side, with a null stop, unclassified rows,
 * zero deployed and an empty book.
 */

const TODAY = "2026-10-04";

const row = (over: Partial<PositionViewRow> = {}): PositionViewRow => ({
  id: 1,
  symbol: "TCS",
  side: "long",
  qty: 10,
  avgEntryP: 300_000, // ₹3,000
  investedP: 3_000_000, // ₹30,000
  markP: 310_000,
  markAsOf: "2026-10-04T10:00:00.000Z",
  unrealisedP: 100_000,
  holdingDays: 5,
  effectiveStopP: 280_000,
  effectiveStopSource: "planned",
  distanceToStopP: 30_000,
  distanceToStopAtrX100: 250,
  riskAtStopP: 200_000,
  stop: { kind: "no-stop" },
  industry: "IT - Software",
  sectorName: "Information Technology",
  partial: null,
  corpActions: [],
  prevCloseP: 305_000,
  resultsDate: null,
  expiry: null,
  ...over,
});

const heatOf = (rows: PositionViewRow[], capitalP: number | null, ceiling: number | null = null): HeatView =>
  portfolioHeat(
    rows.map((r) => ({ id: r.id, riskAtStopP: r.riskAtStopP, investedP: r.investedP, sector: null, sectorTier: null })),
    capitalP,
    ceiling,
  );

// ─── partialOf (D6) ───────────────────────────────────────────────────────────

describe("partialOf — what the PARENT row already booked, before charges", () => {
  it("long: closed = sellQty of buyQty, realised = (avgSell − avgBuy) × sellQty", () => {
    const p = partialOf({ side: "long", buyQty: 100, sellQty: 40, avgBuyPrice: 500, avgSellPrice: 550 });
    expect(p).toEqual({ bookedPpm: 400_000, closedQty: 40, realisedGrossP: 200_000 });
  });

  it("short: closed = buyQty of sellQty, and a cover BELOW the sale is a GAIN (sign mirrored)", () => {
    // Sold 100 @ ₹500, covered 40 @ ₹450 → +₹2,000 booked.
    const p = partialOf({ side: "short", buyQty: 40, sellQty: 100, avgBuyPrice: 450, avgSellPrice: 500 });
    expect(p).toEqual({ bookedPpm: 400_000, closedQty: 40, realisedGrossP: 200_000 });
    // A cover ABOVE the sale is a loss.
    const loss = partialOf({ side: "short", buyQty: 25, sellQty: 100, avgBuyPrice: 520, avgSellPrice: 500 });
    expect(loss?.realisedGrossP).toBe(-50_000);
  });

  it("multiplies the REAL levels and rounds the product once (invariant 1)", () => {
    // 1,000 × (₹123.456 − ₹100.001) = ₹23,455.00 exactly; rounding each level to
    // paise first would give 1,000 × (123.46 − 100.00) = ₹23,460.
    const p = partialOf({ side: "long", buyQty: 2000, sellQty: 1000, avgBuyPrice: 100.001, avgSellPrice: 123.456 });
    expect(p?.realisedGrossP).toBe(2_345_500);
  });

  it("is null when nothing is booked, when the row is not partially open, or an average is missing", () => {
    expect(partialOf({ side: "long", buyQty: 100, sellQty: 0, avgBuyPrice: 500, avgSellPrice: 0 })).toBeNull();
    expect(partialOf({ side: "short", buyQty: 0, sellQty: 100, avgBuyPrice: 0, avgSellPrice: 500 })).toBeNull();
    expect(partialOf({ side: "long", buyQty: 100, sellQty: 100, avgBuyPrice: 500, avgSellPrice: 550 })).toBeNull();
    expect(partialOf({ side: "long", buyQty: 100, sellQty: 40, avgBuyPrice: 500, avgSellPrice: 0 })).toBeNull();
    expect(partialOf({ side: "long", buyQty: 100, sellQty: 40, avgBuyPrice: null, avgSellPrice: 550 })).toBeNull();
  });

  it("a flat exit books zero, not minus zero", () => {
    const p = partialOf({ side: "short", buyQty: 10, sellQty: 20, avgBuyPrice: 500, avgSellPrice: 500 });
    expect(Object.is(p?.realisedGrossP, -0)).toBe(false);
    expect(p?.realisedGrossP).toBe(0);
  });
});

// ─── corpActionsFor / prevCloseOf (P5 / P7) ───────────────────────────────────

describe("corpActionsFor — recorded bonus/split, ex-date from 30 days back onward", () => {
  const actions = [
    { symbol: "tcs", type: "bonus", exDate: "2026-09-20", fromUnits: 1, toUnits: 1 },
    { symbol: "TCS", type: "split", exDate: "2026-11-02", fromUnits: 1, toUnits: 5 },
    { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, CORP_ACTION_LOOKBACK_DAYS), fromUnits: 2, toUnits: 1 },
    { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, CORP_ACTION_LOOKBACK_DAYS + 1), fromUnits: 1, toUnits: 2 },
    { symbol: "TCS", type: "dividend", exDate: "2026-10-10", fromUnits: null, toUnits: null },
    { symbol: "TCS", type: "bonus", exDate: "2026-10-10", fromUnits: null, toUnits: 2 },
    { symbol: "INFY", type: "bonus", exDate: "2026-10-10", fromUnits: 1, toUnits: 1 },
  ];

  it("keeps bonus/split for the symbol (case-insensitive), ascending, boundary inclusive", () => {
    expect(corpActionsFor(actions, "TCS", TODAY)).toEqual([
      { type: "split", exDate: "2026-09-04", fromUnits: 2, toUnits: 1 },
      { type: "bonus", exDate: "2026-09-20", fromUnits: 1, toUnits: 1 },
      { type: "split", exDate: "2026-11-02", fromUnits: 1, toUnits: 5 },
    ]);
  });

  it("never a dividend chip, never a ratio-less chip, never another symbol's", () => {
    const got = corpActionsFor(actions, "TCS", TODAY);
    expect(got.some((a) => (a.type as string) === "dividend")).toBe(false);
    expect(got.some((a) => a.exDate === "2026-10-10")).toBe(false);
    expect(corpActionsFor(actions, "WIPRO", TODAY)).toEqual([]);
  });

  it("isoMinusDays crosses month and year boundaries as dates", () => {
    expect(isoMinusDays("2026-03-01", 1)).toBe("2026-02-28");
    expect(isoMinusDays("2026-01-15", 30)).toBe("2025-12-16");
  });
});

describe("prevCloseOf — the last close strictly BEFORE today", () => {
  const bars = [
    { date: "2026-10-01", closeP: 100 },
    { date: "2026-10-03", closeP: 200 },
    { date: TODAY, closeP: 300 },
  ];
  it("skips today's own bar", () => expect(prevCloseOf(bars, TODAY)).toBe(200));
  it("is the newest bar when none is today's", () => expect(prevCloseOf(bars.slice(0, 2), TODAY)).toBe(200));
  it("is null with no earlier bar, or no bars", () => {
    expect(prevCloseOf([{ date: TODAY, closeP: 1 }], TODAY)).toBeNull();
    expect(prevCloseOf([], TODAY)).toBeNull();
  });
});

// ─── cohortConcentration (D4) ─────────────────────────────────────────────────

describe("cohortConcentration — share of DEPLOYED rupees per cohort", () => {
  const rows = [
    row({ id: 1, investedP: 6_000, industry: "Banks", sectorName: "Financial Services" }),
    row({ id: 2, investedP: 2_000, industry: null, sectorName: "Financial Services" }), // a user tag: sector-only
    row({ id: 3, investedP: 1_000, industry: "IT - Software", sectorName: "Information Technology" }),
    row({ id: 4, investedP: 1_000, industry: null, sectorName: null }), // unclassified
  ];

  it("Industry view: a row with no industry FALLS UP to its sector, labelled as a sector", () => {
    const v = cohortConcentration(rows, "industry");
    expect(v.nodes.map((n) => [n.group, n.level, n.deployedP, n.share.ppm])).toEqual([
      ["Banks", "industry", 6_000, 600_000],
      ["Financial Services", "sector", 2_000, 200_000],
      ["IT - Software", "industry", 1_000, 100_000],
      [null, null, 1_000, 100_000],
    ]);
    expect(v.fellUp).toBe(1);
    expect(v.classified).toBe(3);
    expect(v.total).toBe(4);
    expect(v.deployedP).toBe(10_000);
  });

  it("Sector view: groups by sector; Unclassified is its own node, last, never dropped", () => {
    const v = cohortConcentration(rows, "sector");
    expect(v.nodes.map((n) => [n.group, n.level, n.deployedP, n.constituents])).toEqual([
      ["Financial Services", "sector", 8_000, 2],
      ["Information Technology", "sector", 1_000, 1],
      [null, null, 1_000, 1],
    ]);
    expect(v.fellUp).toBe(0);
    const sum = v.nodes.reduce((s, n) => s + (n.share.ppm ?? 0), 0);
    expect(sum).toBe(1_000_000);
  });

  it("a sector label equal to an industry label is NOT merged with it", () => {
    const v = cohortConcentration(
      [row({ id: 1, investedP: 1, industry: "Power", sectorName: "Utilities" }), row({ id: 2, investedP: 1, industry: null, sectorName: "Power" })],
      "industry",
    );
    expect(v.nodes).toHaveLength(2);
  });

  it("zero deployed: every share is null (no denominator), never an even split", () => {
    const v = cohortConcentration([row({ investedP: 0 })], "industry");
    expect(v.nodes[0].share).toEqual({ ppm: null, denominator: null });
  });

  it("an empty book is an empty view", () => {
    expect(cohortConcentration([], "sector")).toEqual({ level: "sector", nodes: [], classified: 0, fellUp: 0, total: 0, deployedP: 0 });
  });

  it("all unclassified: one null node", () => {
    const v = cohortConcentration([row({ industry: null, sectorName: null })], "industry");
    expect(v.nodes.map((n) => n.group)).toEqual([null]);
    expect(v.classified).toBe(0);
  });
});

// ─── headerTotals (D5) ────────────────────────────────────────────────────────

describe("headerTotals — deployed / heat / unrealised and the partials line", () => {
  const rows = [
    row({ id: 1, investedP: 3_000_000, unrealisedP: 100_000, avgEntryP: 300_000, partial: { bookedPpm: 500_000, closedQty: 10, realisedGrossP: 50_000 } }),
    row({ id: 2, investedP: 1_000_000, unrealisedP: -40_000, riskAtStopP: null, effectiveStopP: null }),
    row({ id: 3, investedP: 1_000_000, unrealisedP: null, markP: null }),
  ];

  it("sums deployed and the MARKED rows' unrealised, and counts the unmarked", () => {
    const h = headerTotals(rows, null);
    expect(h.deployedP).toBe(5_000_000);
    expect(h.unrealisedP).toBe(60_000);
    expect(h.unmarked).toBe(1);
    expect(h.rows).toBe(3);
  });

  it("free (heat null): every capital-relative figure is null", () => {
    const h = headerTotals(rows, null);
    expect(h.deployedPpm).toBeNull();
    expect(h.unrealisedOnCapitalPpm).toBeNull();
    expect(h.heatPpm).toBeNull();
    expect(h.ceilingPpm).toBeNull();
  });

  it("Pro: % of capital from the heat strip's own capital", () => {
    const heat = heatOf(rows, 10_000_000, 60_000);
    const h = headerTotals(rows, heat);
    expect(h.deployedPpm).toBe(500_000);
    expect(h.unrealisedOnCapitalPpm).toBe(6_000);
    expect(h.heatPpm).toBe(heat.heatPpm);
    expect(h.ceilingPpm).toBe(60_000);
  });

  it("realised on partials: Σ before-charges figure over the booked quantity's entry cost", () => {
    const h = headerTotals(rows, null);
    expect(h.realisedPartialP).toBe(50_000);
    expect(h.partials).toBe(1);
    // ₹500 on 10 × ₹3,000 = 1.6667% → 16_666 ppm (truncated)
    expect(h.realisedPartialPpm).toBe(16_666);
  });

  it("no partials: null, not 0", () => {
    const h = headerTotals([row()], null);
    expect(h.realisedPartialP).toBeNull();
    expect(h.realisedPartialPpm).toBeNull();
  });

  it("an empty book: zero deployed, null unrealised", () => {
    const h = headerTotals([], null);
    expect(h.deployedP).toBe(0);
    expect(h.unrealisedP).toBeNull();
    expect(h.unmarked).toBe(0);
  });

  it("no capital on a Pro heat view: % figures still null", () => {
    const h = headerTotals(rows, heatOf(rows, null));
    expect(h.deployedPpm).toBeNull();
    expect(h.heatPpm).toBeNull();
  });
});

// ─── staleCount ───────────────────────────────────────────────────────────────

describe("staleCount — marks older than the newest", () => {
  it("counts rows behind the newest asOf; undated marks are counted apart", () => {
    const s = staleCount([
      row({ id: 1, markAsOf: "2026-10-04T10:00:05.000Z" }),
      row({ id: 2, markAsOf: "2026-10-04T10:00:00.000Z" }),
      row({ id: 3, markAsOf: "2026-10-04T09:00:00.000Z" }),
      row({ id: 4, markAsOf: null }),
      row({ id: 5, markAsOf: null, markP: null }),
    ]);
    expect(s).toEqual({ stale: 2, newestAsOf: "2026-10-04T10:00:05.000Z", undated: 1 });
  });

  it("compares instants, not strings, across offsets", () => {
    // 21:00 at +06:00 is 15:00Z — OLDER than 16:00Z, though it sorts later as a string.
    const s = staleCount([row({ id: 1, markAsOf: "2026-10-04T21:00:00+06:00" }), row({ id: 2, markAsOf: "2026-10-04T16:00:00.000Z" })]);
    expect(s.newestAsOf).toBe("2026-10-04T16:00:00.000Z");
    expect(s.stale).toBe(1);
  });

  it("an empty book / nothing dated", () => {
    expect(staleCount([])).toEqual({ stale: 0, newestAsOf: null, undated: 0 });
    expect(staleCount([row({ markAsOf: null })])).toEqual({ stale: 0, newestAsOf: null, undated: 1 });
  });
});

// ─── stopState / stopChip / nearStop (D7, P4) ─────────────────────────────────

describe("stopState — at entry / at risk / locked in, by side", () => {
  it("long", () => {
    expect(stopState(row({ side: "long", avgEntryP: 1000, effectiveStopP: 900 }))).toBe("at-risk");
    expect(stopState(row({ side: "long", avgEntryP: 1000, effectiveStopP: 1000 }))).toBe("at-entry");
    expect(stopState(row({ side: "long", avgEntryP: 1000, effectiveStopP: 1100 }))).toBe("locked-in");
  });
  it("short is mirrored", () => {
    expect(stopState(row({ side: "short", avgEntryP: 1000, effectiveStopP: 1100 }))).toBe("at-risk");
    expect(stopState(row({ side: "short", avgEntryP: 1000, effectiveStopP: 1000 }))).toBe("at-entry");
    expect(stopState(row({ side: "short", avgEntryP: 1000, effectiveStopP: 900 }))).toBe("locked-in");
  });
  it("null with no stop", () => expect(stopState(row({ effectiveStopP: null }))).toBeNull());
});

describe("stopChip — stored sources only", () => {
  it("a recorded trailing SL is 'trailing' with NO parameters", () => {
    const c = stopChip(row({ effectiveStopSource: "trailing" }), 22, 3000);
    expect(c).toEqual({ kind: "trailing", label: "trailing" });
    expect(c!.label).not.toMatch(/\d/);
  });
  it("a recorded planned SL is 'manual', whatever the tree says", () => {
    expect(stopChip(row({ effectiveStopSource: "planned", stop: { kind: "gated", source: "atr" } }), 21, 2000)).toEqual({ kind: "manual", label: "manual" });
  });
  it("ATR n × k from the stored length and multiplier (permille / 1000)", () => {
    const r = row({ effectiveStopSource: null, effectiveStopP: null, stop: { kind: "gated", source: "atr" } });
    expect(stopChip(r, 21, 2000)).toEqual({ kind: "atr", label: "ATR 21 × 2" });
    expect(stopChip(r, 14, 2500)).toEqual({ kind: "atr", label: "ATR 14 × 2.5" });
    expect(stopChip(r, 14, null)).toEqual({ kind: "atr", label: "ATR" });
  });
  it("structure and percent; Pro computed shapes read the same source", () => {
    expect(stopChip(row({ effectiveStopSource: null, stop: { kind: "gated", source: "structure" } }), 21, 2000)?.label).toBe("structure");
    expect(stopChip(row({ effectiveStopSource: null, stop: { kind: "error", code: "stop-wrong-side", source: "percent" } }), 21, 2000)?.label).toBe("%");
  });
  it("no stop → null", () => {
    expect(stopChip(row({ effectiveStopSource: null, stop: { kind: "risk-not-set" } }), 21, 2000)).toBeNull();
    expect(stopChip(row({ effectiveStopSource: null, stop: { kind: "no-stop" } }), 21, 2000)).toBeNull();
    expect(stopChip(row({ effectiveStopSource: null, stop: { kind: "gated", source: null } }), 21, 2000)).toBeNull();
  });
});

describe("nearStop — within 1 ATR", () => {
  it("≤ 100 is near (inclusive), above is not, null is not", () => {
    expect(nearStop({ distanceToStopAtrX100: 100 })).toBe(true);
    expect(nearStop({ distanceToStopAtrX100: 101 })).toBe(false);
    expect(nearStop({ distanceToStopAtrX100: -20 })).toBe(true); // already through the stop
    expect(nearStop({ distanceToStopAtrX100: null })).toBe(false);
  });
});

// ─── sinceClose (P7) ──────────────────────────────────────────────────────────

describe("sinceClose — marks only, both at today's stops", () => {
  const rows = [
    // long 10 @ ₹3,000, prev close ₹3,050, now ₹3,100, stop ₹2,800
    row({ id: 1, qty: 10, investedP: 3_000_000, prevCloseP: 305_000, markP: 310_000, effectiveStopP: 280_000, distanceToStopAtrX100: 250 }),
    // short 5 @ ₹1,000, prev close ₹980, now ₹1,010, stop ₹1,050
    row({ id: 2, side: "short", qty: 5, investedP: 500_000, prevCloseP: 98_000, markP: 101_000, effectiveStopP: 105_000, distanceToStopAtrX100: 80 }),
    // opened today — no previous close of its own
    row({ id: 3, holdingDays: 0, prevCloseP: 50_000, markP: 51_000 }),
    // no stop
    row({ id: 4, qty: 1, investedP: 100_000, prevCloseP: 100_000, markP: 110_000, effectiveStopP: null, distanceToStopAtrX100: null }),
    // no previous close
    row({ id: 5, prevCloseP: null }),
  ];

  it("unrealised at the previous close vs now, over rows priced at both", () => {
    const s = sinceClose(rows, null);
    expect(s.compared).toBe(3);
    // long: 10×305000−3000000 = 50000; short: 500000−5×98000 = 10000; id4: 0
    expect(s.unrealisedAtCloseP).toBe(60_000);
    // long: 100000; short: 500000−505000 = −5000; id4: 10000
    expect(s.unrealisedNowP).toBe(105_000);
    expect(s.unrealisedChangeP).toBe(45_000);
  });

  it("give-back from the price to TODAY's stop, short mirrored, rows with a stop only", () => {
    const s = sinceClose(rows, null);
    // long: 10×(305000−280000)=250000 then 10×(310000−280000)=300000
    // short: 5×(105000−98000)=35000 then 5×(105000−101000)=20000
    expect(s.givesBackAtCloseP).toBe(285_000);
    expect(s.givesBackNowP).toBe(320_000);
  });

  it("free: give-back over capital is null; Pro: floored ppm of capital", () => {
    expect(sinceClose(rows, null).givesBackNowPpm).toBeNull();
    const s = sinceClose(rows, heatOf(rows, 10_000_000));
    expect(s.givesBackNowPpm).toBe(32_000);
    expect(s.givesBackAtClosePpm).toBe(28_500);
  });

  it("lists rows opened today and rows near the stop; never claims a stop moved", () => {
    const s = sinceClose(rows, null);
    expect(s.openedToday).toEqual([3]);
    expect(s.nearStop).toEqual([2]);
    expect(s.stopEditsTracked).toBe(false);
  });

  it("an empty book: nulls, not zeros", () => {
    const s = sinceClose([], null);
    expect(s).toMatchObject({ compared: 0, unrealisedAtCloseP: null, unrealisedNowP: null, unrealisedChangeP: null, givesBackAtCloseP: null, givesBackNowP: null });
  });

  it("a price through the stop gives back 0, never a negative", () => {
    const s = sinceClose([row({ prevCloseP: 270_000, markP: 260_000, effectiveStopP: 280_000 })], null);
    expect(s.givesBackAtCloseP).toBe(0);
    expect(s.givesBackNowP).toBe(0);
  });
});

// ─── upcoming (D8) ────────────────────────────────────────────────────────────

describe("upcoming — dated events on the book, today onward", () => {
  it("results, recorded bonus/split and a STORED expiry; past dates dropped; one event per scrip", () => {
    const ev = upcoming(
      [
        row({ id: 1, symbol: "TCS", resultsDate: "2026-10-09", corpActions: [{ type: "split", exDate: "2026-10-20", fromUnits: 1, toUnits: 5 }, { type: "bonus", exDate: "2026-09-30", fromUnits: 1, toUnits: 1 }] }),
        row({ id: 2, symbol: "TCS", resultsDate: "2026-10-09" }),
        row({ id: 3, symbol: "NIFTY", resultsDate: null, expiry: TODAY }),
        row({ id: 4, symbol: "INFY", resultsDate: "2026-10-01" }),
      ],
      TODAY,
    );
    expect(ev.map((e) => [e.kind, e.date, e.symbol, e.rowIds, e.fromUnits, e.toUnits])).toEqual([
      ["expiry", TODAY, "NIFTY", [3], null, null],
      ["results", "2026-10-09", "TCS", [1, 2], null, null],
      ["split", "2026-10-20", "TCS", [1], 1, 5],
    ]);
  });
  it("an empty book / nothing dated", () => {
    expect(upcoming([], TODAY)).toEqual([]);
    expect(upcoming([row({ resultsDate: "not-a-date" })], TODAY)).toEqual([]);
  });
});

// ─── riskLensSummary (D8) ─────────────────────────────────────────────────────

describe("riskLensSummary — the collapsed line and the ranked list", () => {
  const rows = [
    row({ id: 1, symbol: "AAA", side: "long", qty: 10, avgEntryP: 1000, markP: 1200, effectiveStopP: 900, riskAtStopP: 1000, distanceToStopAtrX100: 300 }),
    row({ id: 2, symbol: "BBB", side: "short", qty: 10, avgEntryP: 1000, markP: 900, effectiveStopP: 950, riskAtStopP: -500, distanceToStopAtrX100: 50 }),
    row({ id: 3, symbol: "CCC", side: "long", qty: 4, avgEntryP: 1000, markP: 1500, effectiveStopP: 1000, riskAtStopP: 0, distanceToStopAtrX100: 400 }),
    row({ id: 4, symbol: "DDD", effectiveStopP: null, riskAtStopP: null, distanceToStopAtrX100: null }),
    row({ id: 5, symbol: "EEE", side: "long", qty: 1, avgEntryP: 1000, markP: null, effectiveStopP: 500, riskAtStopP: 500, distanceToStopAtrX100: null }),
  ];

  it("counts with-risk / locked-in / at-entry / excluded from the LEVELS", () => {
    const s = riskLensSummary(rows, null);
    expect([s.withRisk, s.lockedIn, s.atEntry, s.excluded]).toEqual([2, 1, 1, 1]);
    expect(s.heatPpm).toBeNull();
  });

  it("ranks by give-back from the mark (short mirrored), unmarked last; no-stop rows are not ranked", () => {
    const s = riskLensSummary(rows, null);
    // AAA long: 10 × (1200 − 900) = 3000; CCC: 4 × (1500 − 1000) = 2000;
    // BBB short: 10 × (950 − 900) = 500 (the stop is ABOVE the mark); EEE unmarked.
    expect(s.ranked.map((r) => [r.symbol, r.givesBackP, r.state])).toEqual([
      ["AAA", 3000, "at-risk"],
      ["CCC", 2000, "at-entry"],
      ["BBB", 500, "locked-in"],
      ["EEE", null, "at-risk"],
    ]);
  });

  it("heat share is the row's max(risk, 0) over Σ — a locked-in row takes no slice", () => {
    const s = riskLensSummary(rows, null);
    const share = Object.fromEntries(s.ranked.map((r) => [r.symbol, r.heatSharePpm]));
    expect(share).toEqual({ AAA: 666_666, BBB: 0, CCC: 0, EEE: 333_333 });
  });

  it("free (riskAtStopP nulled on the wire): no heat share at all, counts still from levels", () => {
    const free = rows.map((r) => ({ ...r, riskAtStopP: null }));
    const s = riskLensSummary(free, null);
    expect(s.ranked.every((r) => r.heatSharePpm === null)).toBe(true);
    expect(s.withRisk).toBe(2);
  });

  it("Pro: the heat figure is the strip's own", () => {
    const heat = heatOf(rows, 100_000);
    expect(riskLensSummary(rows, heat).heatPpm).toBe(heat.heatPpm);
  });

  it("an empty book", () => {
    expect(riskLensSummary([], null)).toEqual({ heatPpm: null, openRiskP: null, withRisk: 0, lockedIn: 0, atEntry: 0, excluded: 0, ranked: [] });
  });

  // C4 fix 2: the share is of the rows the lens was GIVEN (a filtered view), so
  // the lens states that Σ itself — the figure the card prints the share against.
  it("openRiskP is Σ max(risk, 0) over the rows given, and share × openRiskP = the row's risk", () => {
    const s = riskLensSummary(rows, null);
    expect(s.openRiskP).toBe(1500); // AAA 1000 + EEE 500; BBB locked in, CCC at entry
    for (const r of s.ranked) {
      const risk = Math.max(rows.find((x) => x.id === r.id)!.riskAtStopP ?? 0, 0);
      expect(Math.abs((r.heatSharePpm! * s.openRiskP!) / 1_000_000 - risk), r.symbol).toBeLessThan(1);
    }
    // A subset (one account filtered in): its own Σ, never the whole book's.
    const sub = riskLensSummary(rows.filter((r) => r.id === 1), heatOf(rows, 100_000));
    expect(sub.openRiskP).toBe(1000);
    expect(sub.ranked[0].heatSharePpm).toBe(1_000_000);
  });

  it("openRiskP: null on the free wire, 0 for an entitled book with no stop risk", () => {
    expect(riskLensSummary(rows.map((r) => ({ ...r, riskAtStopP: null })), null).openRiskP).toBeNull();
    const noStops = rows.filter((r) => r.id === 4);
    expect(riskLensSummary(noStops, heatOf(noStops, 100_000)).openRiskP).toBe(0);
  });
});
