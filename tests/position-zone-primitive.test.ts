/**
 * Geometry of the position chart's entry→target / entry→stop fills.
 *
 * The chart itself cannot be asserted in a node test — there is no canvas and
 * no price scale. What CAN be wrong is the arithmetic between a paise level and
 * a y coordinate, and that is `zoneGeometry`, which takes the converter as an
 * argument. A fake converter with an exact inverse (`y = 3600 − rupees`) turns
 * every expectation below into an integer, so a wrong rectangle is a wrong
 * number rather than an eyeball judgement.
 *
 * The fixture is a real long: entry ₹2,850, target ₹3,350, stop ₹2,600, so
 * 1R is ₹250 and the ladder is ₹3,100 / ₹3,350 / ₹3,600.
 */
import { describe, expect, it } from "vitest";
import {
  LADDER_TICK_WIDTH,
  PAISE_PER_RUPEE,
  PositionZonePrimitive,
  zoneGeometry,
  type PositionZoneStyle,
  type ZoneLevels,
} from "@/components/charts/lw/position-zone-primitive";

/** ₹1 = 100 paise. Written out so the fixture reads as money, not as digits. */
const P = (rupees: number) => Math.round(rupees * PAISE_PER_RUPEE);

/** Exact, invertible, and inverted like a real price scale: up is a smaller y. */
const yOf = (rupees: number) => 3600 - rupees;

const FRAME = { x0: 40, x1: 640 };
const WIDTH = FRAME.x1 - FRAME.x0;

const LONG: ZoneLevels = { side: "long", entryP: P(2850), targetP: P(3350), stopP: P(2600) };

const STYLE: PositionZoneStyle = {
  reward: "rgba(18, 184, 134, 0.12)",
  risk: "rgba(224, 49, 49, 0.12)",
  ladder: "rgba(148, 163, 184, 0.55)",
  ladderText: "#94a3b8",
  font: "sans-serif",
};

describe("zoneGeometry — the two fills", () => {
  it("puts the reward zone between target and entry, and the risk zone between entry and stop", () => {
    const { rects } = zoneGeometry(LONG, yOf, FRAME);

    expect(rects.map((r) => r.kind)).toEqual(["reward", "risk"]);
    // ₹3,350 → y 250, ₹2,850 → y 750, ₹2,600 → y 1000.
    expect(rects[0]).toEqual({ kind: "reward", x: 40, y: 250, width: WIDTH, height: 500 });
    expect(rects[1]).toEqual({ kind: "risk", x: 40, y: 750, width: WIDTH, height: 250 });
  });

  it("converts paise to rupees EXACTLY ONCE, at the converter boundary", () => {
    const seen: number[] = [];
    zoneGeometry(LONG, (rupees) => {
      seen.push(rupees);
      return yOf(rupees);
    }, FRAME);

    // 285000 paise reaches the price scale as 2850 — not as 285000, not as 28.5.
    expect(seen).toContain(2850);
    expect(seen).toContain(3350);
    expect(seen).toContain(2600);
    expect(seen.every((r) => r < 10000)).toBe(true);
  });

  it("normalises a short's rectangles — height is never negative", () => {
    const short: ZoneLevels = { side: "short", entryP: P(2850), targetP: P(2400), stopP: P(3000) };
    const { rects } = zoneGeometry(short, yOf, FRAME);

    expect(rects[0]).toEqual({ kind: "reward", x: 40, y: 750, width: WIDTH, height: 450 });
    expect(rects[1]).toEqual({ kind: "risk", x: 40, y: 600, width: WIDTH, height: 150 });
    for (const r of rects) expect(r.height).toBeGreaterThan(0);
  });

  it("draws no band for a level it does not have — never a zero-price stand-in", () => {
    expect(zoneGeometry({ ...LONG, targetP: null }, yOf, FRAME).rects.map((r) => r.kind)).toEqual(["risk"]);
    expect(zoneGeometry({ ...LONG, stopP: null }, yOf, FRAME).rects.map((r) => r.kind)).toEqual(["reward"]);
    expect(zoneGeometry({ ...LONG, targetP: null, stopP: null }, yOf, FRAME).rects).toEqual([]);
  });

  it("draws nothing when entry is off-scale or the frame has no width", () => {
    expect(zoneGeometry(LONG, () => null, FRAME)).toEqual({ rects: [], ticks: [] });
    expect(zoneGeometry(LONG, yOf, { x0: 400, x1: 400 })).toEqual({ rects: [], ticks: [] });
  });
});

describe("zoneGeometry — the R ladder", () => {
  it("marks 1R, 2R and 3R above entry for a long", () => {
    const { ticks } = zoneGeometry(LONG, yOf, FRAME);

    // 1R = |2850 − 2600| = ₹250.
    expect(ticks.map((t) => t.r)).toEqual([1, 2, 3]);
    expect(ticks.map((t) => t.priceP)).toEqual([P(3100), P(3350), P(3600)]);
    expect(ticks.map((t) => t.y)).toEqual([500, 250, 0]);
    for (const t of ticks) {
      expect(t.x).toBe(FRAME.x0);
      expect(t.width).toBe(LADDER_TICK_WIDTH);
    }
  });

  it("runs the ladder DOWN from entry for a short", () => {
    const short: ZoneLevels = { side: "short", entryP: P(2850), targetP: null, stopP: P(3000) };
    const { ticks } = zoneGeometry(short, yOf, FRAME);

    expect(ticks.map((t) => t.priceP)).toEqual([P(2700), P(2550), P(2400)]);
  });

  it("has no ladder without a stop — no stop, no R (invariant 6)", () => {
    expect(zoneGeometry({ ...LONG, stopP: null }, yOf, FRAME).ticks).toEqual([]);
  });
});

describe("PositionZonePrimitive.update", () => {
  const zone = () =>
    new PositionZonePrimitive({ ...LONG, style: STYLE, entryX: FRAME.x0 });

  it("moves the risk rectangle and the ladder when the stop ratchets up", () => {
    const z = zone();
    expect(z.geometry(yOf, FRAME).rects[1]).toEqual({ kind: "risk", x: 40, y: 750, width: WIDTH, height: 250 });

    // A chandelier trail lifts the stop from ₹2,600 to ₹2,750: 1R becomes ₹100.
    z.update({ stopP: P(2750) });
    const after = z.geometry(yOf, FRAME);

    expect(after.rects[1]).toEqual({ kind: "risk", x: 40, y: 750, width: WIDTH, height: 100 });
    expect(after.ticks.map((t) => t.priceP)).toEqual([P(2950), P(3050), P(3150)]);
    // The reward zone is untouched by a stop move.
    expect(after.rects[0]).toEqual({ kind: "reward", x: 40, y: 250, width: WIDTH, height: 500 });
  });

  it("asks the chart to repaint instead of rebuilding itself", () => {
    const z = zone();
    let repaints = 0;
    z.attached({
      series: null as never,
      chart: null as never,
      requestUpdate: () => {
        repaints += 1;
      },
      horzScaleBehavior: null as never,
    });
    const viewsBefore = z.paneViews();

    z.update({ stopP: P(2750) });
    z.applyStyle({ ...STYLE, risk: "rgba(224, 49, 49, 0.2)" });

    expect(repaints).toBe(2);
    // Same array instance: the library caches pane views by reference.
    expect(z.paneViews()).toBe(viewsBefore);
  });

  it("clears its handles on detach so a removed chart is not repainted", () => {
    const z = zone();
    let repaints = 0;
    z.attached({ series: null as never, chart: null as never, requestUpdate: () => { repaints += 1; }, horzScaleBehavior: null as never });
    z.detached();
    z.update({ stopP: P(2750) });

    expect(repaints).toBe(0);
    expect(z.series).toBeNull();
  });
});

describe("PositionZonePrimitive.autoscaleInfo", () => {
  it("reserves room for 3R so the ladder is visible before price gets there", () => {
    const z = new PositionZonePrimitive({ ...LONG, style: STYLE });

    expect(z.autoscaleInfo()).toEqual({ priceRange: { minValue: 2600, maxValue: 3600 } });
  });

  it("stops at the levels that exist when the ladder is off", () => {
    const z = new PositionZonePrimitive({ ...LONG, style: STYLE, showLadder: false });

    expect(z.autoscaleInfo()).toEqual({ priceRange: { minValue: 2600, maxValue: 3350 } });
  });

  it("returns rupees, never paise — the price scale speaks rupees", () => {
    const z = new PositionZonePrimitive({ ...LONG, style: STYLE });
    const info = z.autoscaleInfo();

    expect(info?.priceRange?.maxValue).toBeLessThan(10000);
  });
});
