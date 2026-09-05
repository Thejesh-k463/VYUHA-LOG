import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { VIRTUAL_THRESHOLD } from "@/components/live/tracker-client";
import { DESK_CHART_BARS, DESK_CHART_SYMBOLS, SPARK_SESSIONS } from "@/components/live/load-desk";

/**
 * `/live` against the render budget, in the family of `tests/render-windowing.test.ts`.
 *
 * The v3.4.0 pass found six routes over budget, and fixed five of them by
 * refusing to put rows nobody looks at into the DOM. `/live` is the first new
 * table since, and its spec §8 budget is 50 and 100 open positions — with a
 * detail pane, a sparkline per row and (Pro) a chart. Every one of those
 * mechanisms is a single prop or a single call that a refactor can delete with
 * nothing going red: `perf:sweep` is not in CI and `/live` has no e2e spec.
 *
 * So these are SOURCE guards, deliberately shallow: they assert the mechanism
 * is still wired, not that it is fast. What proves it is fast is
 * `npm run perf:seed && npm run perf:sweep`.
 *
 * Every match runs on comment-stripped source (v3.7.0 found three guards in
 * this family passing against reverted code because prose describing a
 * mechanism stood in for the mechanism).
 */

const root = path.resolve(__dirname, "..");
const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (p: string) => stripComments(readFileSync(path.join(root, p), "utf8"));

const TRACKER = "components/live/tracker-client.tsx";
const PAGE = "app/live/page.tsx";

describe("the /live table is windowed beyond the threshold", () => {
  it("windows at 40 rows — under both budget sizes in spec §8", () => {
    expect(VIRTUAL_THRESHOLD).toBe(40);
    expect(VIRTUAL_THRESHOLD).toBeLessThan(50);
    expect(VIRTUAL_THRESHOLD).toBeLessThan(100);
  });

  it("the virtualiser is wired to the visible rows and to a scroll element", () => {
    const src = read(TRACKER);
    expect(src).toContain("useVirtualizer({");
    expect(src).toContain("count: visible.length");
    expect(src).toContain("getScrollElement:");
    expect(src).toContain("visible.length > VIRTUAL_THRESHOLD");
  });

  it("renders the virtual items, not the whole list, once windowed", () => {
    const src = read(TRACKER);
    expect(src).toContain("virtualizer.getVirtualItems()");
    // The windowed branch must be the one that decides what is rendered — a
    // `windowed` flag that only draws spacer rows is the exact bug this catches.
    expect(src).toMatch(/windowed\s*\?\s*virtualizer\.getVirtualItems\(\)/);
    expect(src).toContain("virtualizer.getTotalSize()");
  });

  it("the guard can fire: a de-windowed render fails the same predicate", () => {
    // A guard nobody has seen go red is a guard nobody has tested.
    const reverted = "{visible.map((r) => (<Row key={r.id} row={r} />))}";
    expect(/windowed\s*\?\s*virtualizer\.getVirtualItems\(\)/.test(reverted)).toBe(false);
    expect(reverted.includes("useVirtualizer({")).toBe(false);
  });
});

describe("nothing on the route maps over every position unbounded", () => {
  it("the server page hands the payload over whole — it does not render a row", () => {
    const src = read(PAGE);
    expect(src).toContain("<TrackerClient");
    // One `.map` here is one server-rendered node per position, outside the
    // window and impossible to virtualise from the client.
    expect(src).not.toMatch(/\.map\(/);
    expect(src).not.toMatch(/data\.rows/);
  });

  it("the client's unwindowed maps are over identity and summary lists, never rows", () => {
    const src = read(TRACKER);
    const maps = [...src.matchAll(/([A-Za-z0-9_.]+)\.map\(/g)].map((m) => m[1]);
    // `rows.map` is allowed only to derive the account-id set; every other
    // list-of-positions map must go through `visible` in the windowed branch.
    const overRows = maps.filter((m) => /^(rows|data\.rows|visible)$/.test(m));
    expect(overRows.sort(), `maps found: ${maps.join(", ")}`).toEqual(["rows", "visible"]);
    expect(src).toContain("new Set(rows.map((r) => r.accountId))");
    // The one `visible.map` is the un-windowed branch's index list, guarded by
    // `windowed` — i.e. at most VIRTUAL_THRESHOLD rows.
    expect(src).toMatch(/:\s*visible\.map\(\(_, i\) => i\)/);
  });

  it("the sector rail states a cap instead of listing every sector", () => {
    expect(read(TRACKER)).toContain("concentration.slice(0, 5)");
  });
});

describe("the payload itself is capped, and the cap is stated", () => {
  it("bars ship per symbol under a declared ceiling", () => {
    expect(DESK_CHART_BARS).toBe(120);
    expect(DESK_CHART_SYMBOLS).toBe(60);
    expect(SPARK_SESSIONS).toBe(30);
    expect(SPARK_SESSIONS).toBeLessThan(DESK_CHART_BARS);
  });

  it("the loader trims to those caps and reports that it trimmed (invariant 6)", () => {
    const src = read("components/live/load-desk.ts");
    expect(src).toContain("chartSymbols.slice(0, DESK_CHART_SYMBOLS)");
    expect(src).toContain("all.slice(-DESK_CHART_BARS)");
    expect(src).toContain("trimmed");
  });

  it("the chart panel is code-split and never server-rendered", () => {
    const src = read(TRACKER);
    // A 20 KB canvas panel in the first payload is paid for by every user who
    // never opens a row.
    expect(src).toMatch(/dynamic\(\s*\(\) => import\("\.\/position-chart-panel"\)/);
    expect(src).toContain("ssr: false");
    expect(src).not.toContain("position-chart-panel.placeholder");
  });
});
