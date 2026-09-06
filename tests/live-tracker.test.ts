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
// The desk's own pure halves, so the keyboard/sort interaction (F5) is driven
// rather than described: `visibleRows` IS the list the screen renders, and
// `applyTicks` IS the fold a frame goes through.
import { focusedIndex, visibleRows } from "@/components/live/tracker-client";
import { nextIndex } from "@/components/live/desk-keys";
import type { DeskRow } from "@/components/live/desk-types";
import { applyTicks, mergeTicks } from "@/lib/live/apply-ticks";

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
    // `scrollPaddingStart` alone is only half the frame. The <thead> is IN
    // FLOW inside the scroll box and precedes the tbody, so item 0's DOM
    // offset is `theadHeight + item.start` while virtual-core believes it is
    // `item.start`. `getOffsetForIndex(…,"auto")` then computes
    // `toOffset = item.start - scrollPaddingStart`, which is short by one
    // header height in BOTH directions: `start` parks the row 2h below the
    // top, `end` clips its bottom h px. `scrollMargin` is the option that
    // tells virtual-core where the list actually begins.
    expect(src, "the virtualiser is not told the <thead> sits above the list, so item 0 is off by one header").toMatch(
      /scrollMargin:\s*theadHeight/,
    );
  });

  it("the top spacer is content-relative, because scrollMargin makes item.start absolute", () => {
    // With `scrollMargin: theadHeight`, `item.start` is measured from the
    // scroll element, not from the tbody — the first rendered index k sits at
    // `theadHeight + 44k`. The spacer <tr> lives INSIDE the tbody, after the
    // header, so it must be 44k. Leaving item.start raw adds the header height
    // a second time and every rendered row drifts 40 px low.
    expect(src, "the top spacer still uses the absolute item.start and double-counts the <thead>").toMatch(
      /getVirtualItems\(\)\[0\]\?\.start \?\? theadHeight\) - theadHeight/,
    );
  });

  it("the bottom spacer subtracts the same height from the last item's end", () => {
    // `getTotalSize()` is `end - scrollMargin + paddingEnd` (virtual-core
    // index.js:~1082) — already content-relative — while `last.end` became
    // absolute. Subtracting one from the other leaves the tbody h px short,
    // so the final rows can never be scrolled fully into view.
    expect(src, "the bottom spacer mixes an absolute end with a content-relative total size").toMatch(
      /getVirtualItems\(\)\.at\(-1\)\?\.end \?\? theadHeight\) - theadHeight/,
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

/**
 * FW-1 — the desk really holds the stream `GET /api/live/stream` serves.
 *
 * v4.1 shipped the route with NO consumer: `tracker-client.tsx` contained no
 * `EventSource` at all, so with the OpenAlgo bridge selected the desk's prices
 * moved only on a server render — while the disclosure (items 2 and 5),
 * PRIVACY item 3, the help page and the Settings slider all described a 1–5 s
 * refresh "while the Live Desk is open".
 *
 * WHAT IS ASSERTED WHERE, since fix wave 2. The LIFECYCLE — backoff spacing,
 * the hidden-tab release, the unmount teardown, "stopped is terminal for this
 * connection", the close-of-session reconnect — moved to
 * `lib/live/stream-link.ts` and is DRIVEN, with a fake EventSource and fake
 * timers, in `tests/live-stream-link.test.ts`. It had to: a source regex is
 * satisfied by a line that is never reached, and three of the six findings
 * this wave fixes were live underneath these guards while they reported green.
 * What is left here is the wiring only this file can be wrong about — which
 * route is opened, for which provider, on which DEPENDENCIES, and that nothing
 * the stream carries becomes state of its own.
 */
describe("the Live Desk consumes the SSE stream (FW-1)", () => {
  const stripComments = (raw: string) =>
    raw.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const src = stripComments(
    readFileSync(path.resolve(__dirname, "..", "components/live/tracker-client.tsx"), "utf8"),
  );
  const linkSrc = stripComments(readFileSync(path.resolve(__dirname, "..", "lib/live/stream-link.ts"), "utf8"));

  it("opens ONE EventSource, on the route the server serves", () => {
    expect(src.match(/new EventSource\(/g) ?? [], "one desk, one stream").toHaveLength(1);
    expect(src).toMatch(/new EventSource\("\/api\/live\/stream"\)/);
  });

  it("opens it ONLY when the effective provider streams", () => {
    // `eod` and `manual` report `streaming: false` and the route never starts
    // them, so a stream opened for either holds a request open that can never
    // carry a tick — and would let the strip say "Live" over a stored close.
    expect(src).toMatch(/const streaming = feed\.streaming;/);
    expect(src, "the effect runs before checking that the provider streams").toMatch(
      /if \(!streaming\) return;/,
    );
  });

  it("re-opens on an account switch, and on nothing that is merely a new object (F4)", () => {
    // The route resolves `getSelectedAccountId()` and captures its key set ONCE
    // per request, and `account-switcher.tsx` only calls `router.refresh()` —
    // this component stays MOUNTED, deliberately (a `key` on <TrackerClient>
    // would drop every in-memory tick and the focus on every switch). So the
    // effect has to notice by itself. The KEY's own behaviour is
    // `tests/live-stream-link.test.ts`; what only this file can show is that
    // the effect really depends on it.
    expect(src, "the stream stays on the OLD account's symbols after a switch").toMatch(
      /\}, \[streaming, streamKey\]\);/,
    );
    expect(src).toMatch(/streamKeyOf\(data\.selectedAccountId, wireRows\)/);
    expect(src, "a `feed` or `data` dependency re-opens the stream on every server render").not.toMatch(
      /\}, \[streaming, (feed|data)\]\);/,
    );
  });

  it("hands the lifecycle to the link, and gives it the browser's own edges", () => {
    expect(src).toMatch(/createStreamLink\(\{/);
    for (const edge of [
      /createSource: \(\) => new EventSource\("\/api\/live\/stream"\)/,
      /isHidden: \(\) => document\.visibilityState === "hidden"/,
      /setTimer: \(fn, ms\) => setTimeout\(fn, ms\)/,
      /clearTimer: \(id\) => clearTimeout\(id\)/,
    ]) {
      expect(src, `an injected edge is missing: ${edge}`).toMatch(edge);
    }
  });

  it("closes on unmount, and closes the object it opened", () => {
    expect(src, "the effect returns no cleanup").toMatch(
      /return \(\) => \{[\s\S]*?close\(\);[\s\S]*?link\.destroy\(\);[\s\S]*?\};/,
    );
    expect(linkSrc, "the link must close the source it created").toMatch(/source\?\.close\(\)/);
  });

  it("releases the stream while the tab is hidden, and takes the listener with it", () => {
    // The disclosure promises the feed stops when the desk closes; a hidden
    // tab holding an open request is stricter than that promise, and costs a
    // background tab nothing. `tests/seams-v41-fix.test.ts` S5a pins the same
    // two lines against the disclosure's own words.
    expect(src).toMatch(/document\.visibilityState === "hidden"/);
    expect(src).toMatch(/document\.addEventListener\("visibilitychange", onVisibility\)/);
    expect(src).toMatch(/document\.removeEventListener\("visibilitychange", onVisibility\)/);
  });

  it("backs off rather than hammering a bridge that has gone away", () => {
    // The SPACING is driven in tests/live-stream-link.test.ts; this is only
    // that the one implementation of it is where the desk gets it from.
    expect(linkSrc).toMatch(/RECONNECT_BASE_MS \* 2 \*\* \(retry - 1\)/);
    // A browser that is still CONNECTING is already retrying on the route's own
    // jittered `retry:` hint; a second timer would double the rate.
    expect(linkSrc).toMatch(/source\.readyState === SOURCE_CONNECTING/);
  });

  it("folds ticks in through the PURE helper, and holds them in memory only", () => {
    expect(src).toMatch(/applyTicks\(wireRows, ticks\)/);
    expect(src).toMatch(/mergeTicks\(prev, batch\)/);
    expect(linkSrc).toMatch(/parseTickFrame\(raw\)/);
    // Owner answer Q25: ticks never reach the journal from the client. The one
    // persisted mark per day is written SERVER-side (`persist-mark.ts`).
    expect(src, "the desk must not POST a tick anywhere").not.toMatch(/fetch\(/);
    expect(linkSrc, "the link must not POST a tick anywhere").not.toMatch(/fetch\(/);
  });

  it("batches to one commit per animation frame", () => {
    expect(src).toMatch(/requestAnimationFrame\(fn\)/);
    expect(src).toMatch(/cancelAnimationFrame\(id\)/);
    expect(linkSrc).toMatch(/env\.schedulePaint\(flush\)/);
  });

  it("keeps the desk's rows DERIVED — no tick is copied into state as a row", () => {
    // A `setState` that copies `data.rows` is how a payload and a screen drift,
    // and a `setState` in an effect keyed on other state is what broke the
    // Trades filter outright under the React Compiler (AGENTS.md).
    expect(src).toMatch(/const rows = React\.useMemo\(\(\) => applyTicks\(wireRows, ticks\), \[wireRows, ticks\]\);/);
    expect(src, "rows must not be held in local state").not.toMatch(/useState.*\bwireRows\b/);
  });

  it("announces the LINK once, and never a price per row (F7)", () => {
    // `aria-live="polite"` sat on every Mark <td>. With the stream really
    // connected that is one announcement per row per tick — a 40-row desk is a
    // screen reader that never stops talking. One region, on the strip, whose
    // text changes only when the PHASE does.
    expect([...src.matchAll(/aria-live=/g)], "more than one live region on the desk").toHaveLength(1);
    expect(src).toMatch(/<span className="sr-only" aria-live="polite" data-testid="live-stream-announce">/);
    expect(src, "the Mark cell is a live region again").not.toMatch(/tabular-nums" aria-live/);
    expect(src, "the announcement must not carry the frame age or a price").toMatch(
      /LIVE_STREAM_COPY\.announce\[link\.phase\]/,
    );
  });
});

/**
 * F5 — the keyboard focus is an IDENTITY, and the list under it moves.
 *
 * `visible` re-sorts on every rows change, the default sort is `unrealisedP`
 * DESC, and `applyTicks` rewrites `unrealisedP` on every tick — so with focus
 * held as an INDEX, a tick that flipped two rows' P&L order moved the highlight
 * to the other row, and Enter / `l` then acted on it. The Sizing Lab was handed
 * the wrong position from a keystroke aimed at the right one.
 *
 * Driven through the desk's OWN pure halves — `visibleRows` (its filter and its
 * sort) and `applyTicks` (the real tick fold) — because the component itself
 * cannot be rendered here: this suite is `environment: "node"` and the project
 * ships no jsdom.
 */
describe("a tick that re-sorts the desk does not move the focused row (F5)", () => {
  const deskRow = (id: number, symbol: string, markP: number): DeskRow =>
    ({
      id,
      accountId: 1,
      accountName: "Main",
      symbol,
      tradingsymbol: symbol,
      exchange: "NSE",
      side: "long",
      qty: 100,
      avgEntryP: 100_000,
      investedP: 10_000_000,
      markP,
      staleness: "delayed",
      markAsOf: "2026-09-07T09:59:00.000Z",
      dayChangePpm: null,
      // The field the sort reads, and the field applyTicks rewrites.
      unrealisedP: 100 * markP - 10_000_000,
      unrealisedPctPpm: null,
      effectiveStopP: null,
      targetP: null,
      distanceToStopP: null,
      distanceToStopPpm: null,
      distanceToTargetP: null,
      distanceToTargetPpm: null,
      distanceToStopAtrX100: null,
      atrP3: null,
      riskAmountP: null,
      openRPpm: null,
    }) as unknown as DeskRow;

  /** One quote on the wire, in the map the desk holds its ticks in. */
  const tickTo = (symbol: string, ltp: number) =>
    mergeTicks(new Map(), [
      {
        key: { symbol, exchange: "NSE" as const, tradingsymbol: symbol },
        ltp,
        prevClose: null,
        asOf: "2026-09-07T10:00:00.000Z",
        staleness: "delayed" as const,
      },
    ]);

  const SORT = { key: "unrealisedP", dir: -1 } as const;
  const view = { accountFilter: null, query: "", sort: SORT };

  it("the list really does reorder under a tick — the premise, first", () => {
    const rows = [deskRow(1, "AAA", 101_000), deskRow(2, "BBB", 120_000)];
    const before = visibleRows(rows, view);
    expect(before.map((r) => r.id), "BBB is ahead on P&L").toEqual([2, 1]);

    const ticked = applyTicks(rows, tickTo("AAA", 900_000));
    const after = visibleRows(ticked, view);
    expect(after.map((r) => r.id), "the tick did not change the order — the test proves nothing").toEqual([1, 2]);
  });

  it("focus keyed on the ROW stays on that row across the re-sort", () => {
    const rows = [deskRow(1, "AAA", 101_000), deskRow(2, "BBB", 120_000)];
    const before = visibleRows(rows, view);
    const focusId = before[0].id; // the user pressed j once: BBB
    expect(focusedIndex(before, focusId), "a stored POSITION is not the focused row").toBe(0);

    const after = visibleRows(applyTicks(rows, tickTo("AAA", 900_000)), view);
    const idx = focusedIndex(after, focusId);
    expect(idx, "the row moved down the list").toBe(1);
    expect(after[idx].id, "Enter and `l` act on the row the user focused").toBe(focusId);
    expect(after[idx].symbol).toBe("BBB");
    // The bug, stated: the index the old model kept now points at the OTHER row.
    expect(after[0].id).not.toBe(focusId);
  });

  it("a filter that excludes the focused row reports -1, which j reads as 'from the top'", () => {
    const rows = [deskRow(1, "AAA", 101_000), deskRow(2, "BBB", 120_000)];
    const filtered = visibleRows(rows, { ...view, query: "aaa" });
    expect(filtered.map((r) => r.id)).toEqual([1]);
    expect(focusedIndex(filtered, 2), "a focused row that is filtered away is nowhere").toBe(-1);
    expect(nextIndex(focusedIndex(filtered, 2), filtered.length, 1)).toBe(0);
    expect(focusedIndex(filtered, null)).toBe(-1);
  });
});

/**
 * FW-1 — the once-a-day connect prompt (owner answer Q24).
 *
 * Q24 asked for it ON THE DESK, once a day. `LIVE_FEED_COPY.connect` existed
 * but rendered only on the Settings card, every time the feed was unhealthy,
 * with no day-keyed state at all.
 */
describe("the connect prompt is day-keyed and lives on the desk (FW-1)", () => {
  const stripComments = (raw: string) =>
    raw.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const src = stripComments(
    readFileSync(path.resolve(__dirname, "..", "components/live/tracker-client.tsx"), "utf8"),
  );

  it("keys the dismissal on the payload's own IST day, not on a client clock", () => {
    expect(src).toMatch(/connectPromptKey\(data\.today\)/);
    expect(src, "a client `new Date()` here is a hydration mismatch and a wrong day at 00:05 IST").not.toMatch(
      /connectPromptKey\(new Date/,
    );
  });

  it("reads and writes the dismissal through the project's storage helpers", () => {
    expect(src).toMatch(/useStoredValue\(promptKey\)/);
    expect(src).toMatch(/writeStored\(promptKey, connectPromptDismissal\(\)\)/);
    expect(src, "localStorage must not be touched directly (hydration)").not.toMatch(/localStorage\./);
  });

  it("shows only for the states a reconnection fixes", () => {
    expect(src).toMatch(/showConnectPrompt\(\{ providerId: feed\.providerId, healthState: feed\.healthState \}/);
  });
});
