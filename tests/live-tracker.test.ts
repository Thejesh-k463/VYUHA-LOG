import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeTrackerRow,
  dayChangePpm,
  highDistance,
  holdingDays,
  latestAtrP3,
  ppmFloor,
  ppmTrunc,
  productOf,
  rvolRatio,
  wilderAtrSeriesP3,
} from "@/lib/live/tracker-row";
import type { Bar, LivePosition, Mark, TrackerContext } from "@/lib/live/types";

/**
 * Live Desk tracker row — spec §2.1–2.3.
 *
 * Every fixture is INTEGER PAISE (invariant 1). ₹2,500.00 is 250_000, and no
 * assertion in this file compares a float. The null rules get their own
 * describe block because they are the point of the feature: a desk that prints
 * 0 where it means "you have not told me your capital" is worse than one that
 * prints nothing (invariant 6).
 */

const bar = (date: string, closeP: number, o: Partial<Bar> = {}): Bar => ({
  date,
  openP: o.openP ?? closeP,
  highP: o.highP ?? closeP,
  lowP: o.lowP ?? closeP,
  closeP,
  volume: o.volume ?? 1000,
});

/** n sessions of a flat ₹100.00 close, so a window is long enough to be valid. */
const flatBars = (n: number, closeP = 10_000): Bar[] =>
  Array.from({ length: n }, (_, i) => bar(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, closeP));

const position = (over: Partial<LivePosition> = {}): LivePosition => ({
  id: 1,
  accountId: 1,
  symbol: "TCS",
  tradingsymbol: "TCS",
  segment: "eq_delivery",
  instrumentType: "equity",
  side: "long",
  qty: 100,
  avgEntryP: 250_000, // ₹2,500.00
  entryDate: "2026-08-01",
  slPlannedP: null,
  trailingSlP: null,
  targetPlannedP: null,
  riskAmountP: null,
  lotSize: 1,
  sector: "IT",
  sectorTier: "user",
  ...over,
});

const mark = (markP: number | null): Mark => ({ markP, staleness: markP === null ? null : "eod", asOf: "2026-09-04" });

const ctx = (over: Partial<TrackerContext> = {}): TrackerContext => ({
  today: "2026-09-05",
  capitalP: null,
  ...over,
});

describe("ppm helpers", () => {
  it("returns null, never 0 or Infinity, when the denominator is missing", () => {
    expect(ppmTrunc(1_000, null)).toBeNull();
    expect(ppmTrunc(1_000, 0)).toBeNull();
    expect(ppmFloor(1_000, null)).toBeNull();
    expect(ppmFloor(1_000, 0)).toBeNull();
  });

  it("truncates signed ratios toward zero, so neither direction is exaggerated", () => {
    // −1.5 ppm of a 2-paise base: trunc keeps −1, floor would say −2.
    expect(ppmTrunc(-3, 2_000_000)).toBe(-1);
    expect(ppmFloor(-3, 2_000_000)).toBe(-2);
  });

  it("stays exact past 2^53 by doing the arithmetic in BigInt", () => {
    // ₹1 crore position, 1% gain: numerator × 1e6 = 1e17, well past 9.007e15.
    const pnlP = 10_000_000; // ₹1,00,000.00
    const investedP = 1_000_000_000; // ₹1,00,00,000.00
    expect(ppmTrunc(pnlP, investedP)).toBe(10_000); // exactly 1%
    // A ₹100 crore notional still lands on an exact integer, not a rounded float.
    expect(ppmTrunc(1_000_000_000, 100_000_000_000)).toBe(10_000);
  });
});

describe("productOf", () => {
  it("maps each known segment to its broker product", () => {
    expect(productOf("eq_delivery", "equity")).toBe("CNC");
    expect(productOf("eq_intraday", "equity")).toBe("MIS");
    expect(productOf("eq_mtf", "equity")).toBe("MTF");
    expect(productOf("stock_option", "option")).toBe("NRML");
    expect(productOf("future", "future")).toBe("NRML");
  });

  it("never guesses: an unknown segment renders raw", () => {
    expect(productOf("eq_something_new", "equity")).toBe("raw");
  });
});

describe("bar-series primitives", () => {
  it("day change is null with fewer than 2 stored sessions", () => {
    expect(dayChangePpm([])).toBeNull();
    expect(dayChangePpm([bar("2026-09-04", 10_000)])).toBeNull();
  });

  it("day change is (close[t] − close[t−1]) / close[t−1] in ppm", () => {
    expect(dayChangePpm([bar("2026-09-03", 10_000), bar("2026-09-04", 10_150)])).toBe(15_000); // +1.5%
  });

  it("Wilder ATR needs len + 1 sessions and is null below that", () => {
    expect(latestAtrP3(flatBars(21), 21)).toBeNull();
    expect(latestAtrP3(flatBars(22), 21)).not.toBeNull();
  });

  it("Wilder ATR is exact on a constant-range series", () => {
    // Every bar: high 10_100, low 9_900, close 10_000 → true range 200 paise.
    const bars = Array.from({ length: 30 }, (_, i) =>
      bar(`2026-01-${String(i + 1).padStart(2, "0")}`, 10_000, { highP: 10_100, lowP: 9_900 }),
    );
    // 200 paise × 1000 = 200_000 in P3 units, and Wilder smoothing of a
    // constant is that constant.
    expect(latestAtrP3(bars, 14)).toBe(200_000);
    expect(wilderAtrSeriesP3(bars, 14)[13]).toBeNull(); // index len-1 has no value yet
    expect(wilderAtrSeriesP3(bars, 14)[14]).toBe(200_000);
  });

  it("RVOL excludes the current bar from its own baseline", () => {
    const bars = flatBars(21).map((b, i) => ({ ...b, volume: i === 20 ? 4_000 : 1_000 }));
    const r = rvolRatio(bars, 20);
    // Baseline is the 20 PRIOR bars only: mean 1_000, so RVOL = 4.0.
    expect(r.denominator).toBe(1_000);
    expect(r.ppm).toBe(4_000_000);
  });

  it("RVOL is null with fewer than lookback + 1 sessions, and publishes no denominator", () => {
    const r = rvolRatio(flatBars(20), 20);
    expect(r.ppm).toBeNull();
    expect(r.denominator).toBeNull();
  });

  it("52w distance is labelled 52w ONLY with a full 252 sessions", () => {
    expect(highDistance(flatBars(251)).label).toBe("251d");
    expect(highDistance(flatBars(252)).label).toBe("52w");
    expect(highDistance(flatBars(400)).label).toBe("52w");
  });

  it("52w distance is negative below the high and 0 at it", () => {
    const bars = [...flatBars(10), bar("2026-02-01", 9_000, { highP: 9_000 })];
    bars[5] = bar("2026-01-06", 10_000, { highP: 12_000 });
    expect(highDistance(bars).ppm).toBe(ppmTrunc(9_000 - 12_000, 12_000));
    expect(highDistance(flatBars(10)).ppm).toBe(0);
  });

  it("holding days is null when the entry date is unknown", () => {
    expect(holdingDays(null, "2026-09-05")).toBeNull();
    expect(holdingDays("2026-09-01", "2026-09-05")).toBe(4);
  });
});

describe("computeTrackerRow — the arithmetic", () => {
  it("unrealised P&L is qty × (mark − entry), in paise", () => {
    const row = computeTrackerRow(position(), mark(260_000), ctx());
    expect(row.unrealisedP).toBe(100 * (260_000 - 250_000)); // ₹10,000.00
    expect(row.investedP).toBe(25_000_000);
  });

  it("shorts mirror the P&L", () => {
    const row = computeTrackerRow(position({ side: "short" }), mark(240_000), ctx());
    expect(row.unrealisedP).toBe(100 * (250_000 - 240_000));
  });

  it("rounds qty × average ONCE, so the desk's unrealised equals the journal's (M5)", () => {
    // 1,000 shares at a weighted average of ₹123.456, marked at ₹130.
    // The journal (lib/analytics/positions.ts) multiplies the REAL average and
    // rounds the product: 1000 × 123.456 = ₹1,23,456 invested, ₹6,544 open.
    // Re-rounding the per-unit level first (12_346 paise) loses ₹4 a lot —
    // invariant 1 keeps per-unit prices REAL for exactly this reason.
    const investedP = Math.round(1000 * 123.456 * 100); // 12_345_600
    const row = computeTrackerRow(
      position({ qty: 1000, avgEntryP: Math.round(123.456 * 100), investedP }),
      mark(13_000),
      ctx(),
    );
    expect(row.investedP).toBe(12_345_600);
    expect(row.unrealisedP).toBe(654_400);
    expect(row.unrealisedP).not.toBe(654_000);
  });

  it("risk at stop is measured from the same invested value, not a re-rounded level", () => {
    const investedP = Math.round(1000 * 123.456 * 100);
    const row = computeTrackerRow(
      position({ qty: 1000, avgEntryP: Math.round(123.456 * 100), investedP, slPlannedP: 12_000 }),
      mark(13_000),
      ctx(),
    );
    expect(row.riskAtStopP).toBe(12_345_600 - 1000 * 12_000);
  });

  it("carries the FROZEN risk amount onto the row, so the panel cannot re-derive R (invariant 4)", () => {
    expect(computeTrackerRow(position({ riskAmountP: 100_000 }), mark(260_000), ctx()).riskAmountP).toBe(100_000);
    expect(computeTrackerRow(position(), mark(260_000), ctx()).riskAmountP).toBeNull();
  });

  it("unrealised % uses INVESTED VALUE as the denominator, never capital", () => {
    const row = computeTrackerRow(position(), mark(260_000), ctx({ capitalP: 100_000_000 }));
    // 1_000_000 paise on 25_000_000 invested = 4%, regardless of capital.
    expect(row.unrealisedPctPpm).toBe(40_000);
    const richer = computeTrackerRow(position(), mark(260_000), ctx({ capitalP: 900_000_000 }));
    expect(richer.unrealisedPctPpm).toBe(40_000);
  });

  it("risk at stop is qty × (entry − stop) and exists before any quote", () => {
    const row = computeTrackerRow(position({ slPlannedP: 240_000 }), mark(null), ctx());
    expect(row.riskAtStopP).toBe(100 * 10_000); // ₹10,000.00
  });

  it("a trailing stop supersedes the planned one, and the row says which", () => {
    const row = computeTrackerRow(position({ slPlannedP: 240_000, trailingSlP: 245_000 }), mark(260_000), ctx());
    expect(row.effectiveStopP).toBe(245_000);
    expect(row.effectiveStopSource).toBe("trailing");
    expect(computeTrackerRow(position({ slPlannedP: 240_000 }), mark(260_000), ctx()).effectiveStopSource).toBe("planned");
  });

  it("distance to stop and target are signed in the position's favour", () => {
    const row = computeTrackerRow(position({ slPlannedP: 240_000, targetPlannedP: 280_000 }), mark(260_000), ctx());
    expect(row.distanceToStopP).toBe(20_000); // ₹200.00 above the stop
    expect(row.distanceToTargetP).toBe(20_000); // ₹200.00 below the target
    const short = computeTrackerRow(
      position({ side: "short", slPlannedP: 260_000, targetPlannedP: 240_000 }),
      mark(250_000),
      ctx(),
    );
    expect(short.distanceToStopP).toBe(10_000);
    expect(short.distanceToTargetP).toBe(10_000);
  });

  it("stop distance in ATR units is (distance × 1000 × 100) / atrP3", () => {
    const bars = Array.from({ length: 30 }, (_, i) =>
      bar(`2026-01-${String(i + 1).padStart(2, "0")}`, 250_000, { highP: 251_000, lowP: 249_000 }),
    );
    const row = computeTrackerRow(position({ slPlannedP: 246_000 }), mark(250_000), ctx({ bars, atrLength: 14 }));
    expect(row.atrP3).toBe(2_000_000); // 2_000 paise of range
    expect(row.distanceToStopAtrX100).toBe(200); // 4_000 paise = 2.00 ATR
  });

  it("open R is unrealised / riskAmount in ppm", () => {
    const row = computeTrackerRow(position({ riskAmountP: 500_000 }), mark(260_000), ctx());
    expect(row.openRPpm).toBe(2_000_000); // +2.0R
  });

  it("% of capital carries the denominator it used", () => {
    const row = computeTrackerRow(position({ slPlannedP: 240_000 }), mark(260_000), ctx({ capitalP: 100_000_000 }));
    expect(row.pctOfCapital.denominator).toBe(100_000_000);
    expect(row.pctOfCapital.ppm).toBe(10_000); // ₹10,000 risk on ₹10,00,000 = 1%
  });
});

describe("computeTrackerRow — every null rule (invariant 6)", () => {
  it("no mark ⇒ null P&L, null %, null distances — never 0", () => {
    const row = computeTrackerRow(position({ slPlannedP: 240_000, targetPlannedP: 280_000 }), mark(null), ctx());
    expect(row.unrealisedP).toBeNull();
    expect(row.unrealisedPctPpm).toBeNull();
    expect(row.distanceToStopP).toBeNull();
    expect(row.distanceToStopPpm).toBeNull();
    expect(row.distanceToTargetP).toBeNull();
    expect(row.distanceToTargetPpm).toBeNull();
  });

  it("no riskAmount ⇒ null R, NOT 0 — R is frozen at first entry (invariant 4)", () => {
    const row = computeTrackerRow(position({ riskAmountP: null, slPlannedP: 240_000 }), mark(260_000), ctx());
    expect(row.openRPpm).toBeNull();
    expect(row.openRPpm).not.toBe(0);
  });

  it("no capital ⇒ null % of capital, NOT 0, and a null denominator", () => {
    const row = computeTrackerRow(position({ slPlannedP: 240_000 }), mark(260_000), ctx({ capitalP: null }));
    expect(row.pctOfCapital.ppm).toBeNull();
    expect(row.pctOfCapital.ppm).not.toBe(0);
    expect(row.pctOfCapital.denominator).toBeNull();
  });

  it("capital of 0 is treated as unconfigured, not as a zero base", () => {
    const row = computeTrackerRow(position({ slPlannedP: 240_000 }), mark(260_000), ctx({ capitalP: 0 }));
    expect(row.pctOfCapital.ppm).toBeNull();
    expect(row.pctOfCapital.denominator).toBeNull();
  });

  it("no stop ⇒ null risk at stop and null ATR distance", () => {
    const row = computeTrackerRow(position(), mark(260_000), ctx({ bars: flatBars(30) }));
    expect(row.riskAtStopP).toBeNull();
    expect(row.distanceToStopAtrX100).toBeNull();
    expect(row.effectiveStopSource).toBeNull();
  });

  it("too little history ⇒ null day change, null ATR, null RVOL — with the count published", () => {
    const row = computeTrackerRow(position({ slPlannedP: 240_000 }), mark(260_000), ctx({ bars: flatBars(1) }));
    expect(row.dayChangePpm).toBeNull();
    expect(row.atrP3).toBeNull();
    expect(row.rvol.ppm).toBeNull();
    expect(row.atrSessions).toBe(1);
    expect(row.highDistance.label).toBe("1d");
  });

  it("no bars at all ⇒ nulls everywhere the bars were needed, and no throw", () => {
    const row = computeTrackerRow(position(), mark(null), ctx());
    expect(row.dayChangePpm).toBeNull();
    expect(row.atrP3).toBeNull();
    expect(row.rvol.ppm).toBeNull();
    expect(row.highDistance.ppm).toBeNull();
    expect(row.highDistance.sessions).toBe(0);
  });

  it("carries accountId, so the desk can group by book without a retrofit", () => {
    expect(computeTrackerRow(position({ accountId: 7 }), mark(null), ctx()).accountId).toBe(7);
  });
});

/**
 * The expanded panel's own arithmetic, lifted OUT of React so it can be tested.
 *
 * M2: the panel used to INFER `side` from the stop and the target
 * (`deriveSide()`), so a short with no stop and no target rendered as a long —
 * every figure on the summary strip sign-flipped, silently. `side` is now the
 * row's own field, passed in as a prop, and this is the case that proves it.
 *
 * M3: Open R is `unrealised / riskAmountP` — R FROZEN AT FIRST ENTRY
 * (invariant 4) — never `unrealised / (entry − today's stop)`. The two disagree
 * the moment a trail moves, and the row and the panel then print different Rs.
 */
describe("panel arithmetic (lib/live/panel-math)", () => {
  it("a SHORT with no stop and no target loses money when the mark rises (M2)", async () => {
    const { panelStats } = await import("@/lib/live/panel-math");
    const s = panelStats({ side: "short", qty: 100, entryP: 250_000, markP: 260_000, riskAmountP: null, stopP: null });
    expect(s.unrealisedP, "a short marked above entry is a LOSS").toBe(-1_000_000);
    expect(s.unrealisedP).toBeLessThan(0);
    // With no risk recorded there is no R, and no stop means nothing at risk.
    expect(s.openR).toBeNull();
    expect(s.atRiskP).toBeNull();
  });

  it("the same position as a long is the mirror, so the sign is `side` and nothing else", async () => {
    const { panelStats } = await import("@/lib/live/panel-math");
    const s = panelStats({ side: "long", qty: 100, entryP: 250_000, markP: 260_000, riskAmountP: null, stopP: null });
    expect(s.unrealisedP).toBe(1_000_000);
  });

  it("Open R comes from the FROZEN risk amount, never from today's stop (M3)", async () => {
    const { panelStats } = await import("@/lib/live/panel-math");
    // Entry ₹250, 100 shares, ₹1,000 of risk recorded at entry ⇒ 1R = ₹10/sh.
    // The trail has since moved to ₹255, which would make a re-derived R ₹5/sh
    // and print +2.0R on the same ₹1,000 of open profit.
    const s = panelStats({ side: "long", qty: 100, entryP: 25_000, markP: 26_000, riskAmountP: 100_000, stopP: 25_500 });
    expect(s.openR).toBe(1);
    expect(s.unrealisedP).toBe(100_000);
  });

  it("Open R is null — never 0 — when no risk was recorded at entry (invariant 4)", async () => {
    const { panelStats } = await import("@/lib/live/panel-math");
    const s = panelStats({ side: "long", qty: 100, entryP: 25_000, markP: 26_000, riskAmountP: null, stopP: 25_500 });
    expect(s.openR).toBeNull();
    expect(s.openR).not.toBe(0);
  });

  it("₹ at risk clamps at 0 once the mark has passed the stop, on both sides", async () => {
    const { panelStats } = await import("@/lib/live/panel-math");
    const long = panelStats({ side: "long", qty: 100, entryP: 25_000, markP: 26_000, riskAmountP: null, stopP: 25_500 });
    expect(long.atRiskP).toBe(100 * (26_000 - 25_500));
    const through = panelStats({ side: "long", qty: 100, entryP: 25_000, markP: 25_000, riskAmountP: null, stopP: 25_500 });
    expect(through.atRiskP).toBe(0);
    const short = panelStats({ side: "short", qty: 100, entryP: 25_000, markP: 24_000, riskAmountP: null, stopP: 24_500 });
    expect(short.atRiskP).toBe(100 * (24_500 - 24_000));
  });

  it("takes the invested value from the row, so the panel and the table agree (M5)", async () => {
    const { panelStats } = await import("@/lib/live/panel-math");
    // The same 1,000 shares at ₹123.456 the row test uses. Multiplying the
    // rounded level here would print ₹6,540 on the panel and ₹6,544 in the
    // table for one position, which is a defect the user can see.
    const s = panelStats({
      side: "long",
      qty: 1000,
      entryP: Math.round(123.456 * 100),
      investedP: Math.round(1000 * 123.456 * 100),
      markP: 13_000,
      riskAmountP: null,
      stopP: null,
    });
    expect(s.unrealisedP).toBe(654_400);
  });

  it("R per share is the frozen amount divided by the open quantity", async () => {
    const { frozenRiskPerShareP } = await import("@/lib/live/panel-math");
    expect(frozenRiskPerShareP(100_000, 100)).toBe(1_000);
    expect(frozenRiskPerShareP(null, 100)).toBeNull();
    expect(frozenRiskPerShareP(100_000, 0)).toBeNull();
    expect(frozenRiskPerShareP(0, 100)).toBeNull();
  });
});

/**
 * U-1 — j/k must land the focused row where the user can see it.
 *
 * The table's scroll element is a `max-h-[60vh] overflow-auto` box and the
 * <thead> is `sticky top-0` INSIDE it, so the top band of that box is
 * permanently covered. Neither scroller knows that: virtual-core's
 * `align:"auto"` scrolled to `item.start` and the DOM path called
 * `scrollIntoView({block:"nearest"})`, and both put the focused row exactly one
 * header-height below the visible area — the user pressed j and saw nothing
 * move, or saw the row they had just left.
 *
 * A SOURCE guard, in the family of `tests/live-pro-gate.test.ts`: the failure
 * is a scroll offset in a jsdom-less client component, so what can be held to
 * account here is that the correction is wired on BOTH paths from ONE measured
 * height.
 */
describe("keyboard navigation clears the sticky header (U-1)", () => {
  const stripComments = (raw: string) =>
    raw.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const src = stripComments(
    readFileSync(path.resolve(__dirname, "..", "components/live/tracker-client.tsx"), "utf8"),
  );

  it("the virtualiser is told how much of its viewport the header covers", () => {
    expect(src, "the windowed path still scrolls the row to the top of the box, under the <thead>").toMatch(
      /scrollPaddingStart:\s*theadHeight/,
    );
    expect(src, "a zero scroll padding is the original bug with a name on it").not.toMatch(
      /scrollPaddingStart:\s*0\s*,/,
    );
  });

  it("that height is MEASURED from the <thead>, with a stated fallback", () => {
    expect(src, "the <thead> is not measured, so the padding is a guess").toMatch(/<thead ref=\{theadRef\}/);
    expect(src).toMatch(/offsetHeight \|\| THEAD_HEIGHT_FALLBACK/);
  });

  it("the non-windowed path corrects for the SAME height after scrollIntoView", () => {
    // `scrollIntoView({block:"nearest"})` stays — `tests/live-route-budget.ts`
    // pins it as the DOM path, and it is a no-op for a row already in view.
    // What it cannot know is that the top band of the box is covered, so the
    // correction is applied straight after it, from the one measured height.
    expect(src).toMatch(/scrollIntoView\(\{\s*block:\s*"nearest"/);
    expect(src, "the DOM path must compute scrollTop itself to clear the header").toMatch(
      /box\.scrollTop = rowTop - theadHeight/,
    );
    expect(src, "the correction must read the MEASURED height, not a literal").not.toMatch(
      /rowTop - \d+/,
    );
  });
});
