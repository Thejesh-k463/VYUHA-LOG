import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// Pure, or client modules whose graph is pure — no DB in any of them, so static
// imports are safe before openTempDb() (AGENTS.md Testing).
import {
  PAYOFF_POINTS,
  buildStrategies,
  payoffSeries,
  type OptionLeg,
  type PositionedLeg,
  type StrategyGroup,
} from "@/lib/analytics/strategies";
import { CATALOGUE, getStrategyDef, type StrategyDef } from "@/lib/analytics/strategy-catalogue";
import { customName, withholdForFree, withoutPayoff } from "@/components/strategies/strategy-copy";
import { PayoffChartOfLegs } from "@/components/reports/payoff-chart";
import { StrategiesClient } from "@/components/strategies/strategies-client";

/**
 * /strategies — WHAT CROSSES THE WIRE (v4.8.0 wave P3).
 *
 * The page used to serialise the 61-point payoff series of every open structure
 * (~2.5 KB each; 626 structures and a 6.0 MB document on the perf book) for a
 * chart that mounts only on approach and a card that never read it. The series
 * is now computed in the browser by `payoffSeries(legs, breakevens)` — the same
 * pure function the engine calls — and `withoutPayoff` drops the field before
 * the payload. Three things are pinned here, each red with its hunk reverted:
 *
 *  1. THE POINTS DID NOT MOVE. `HEAD_SERIES_DIGEST` was measured on the
 *     UNMODIFIED engine (180dd3c, the series still computed inline in
 *     `computeStrategy`) over the fixture below, BEFORE the extraction — so this
 *     is the old code's answer, not the new function agreeing with itself. The
 *     chart component is rendered too, through a recharts stand-in, and what it
 *     hands `AreaChart` is held to the same digest.
 *  2. THE SERIES IS NOT IN THE PAYLOAD. The real server page, over a real temp
 *     database: no `payoff` key anywhere in the props a client component
 *     receives, and the bytes measured before and after.
 *  3. A FREE BUILD'S PAYLOAD LOSES ONE FIELD AND GAINS NONE (invariant 7, and
 *     the free-wire rule of app/live/page.tsx). The chart's inputs are `legs`
 *     and `breakevens`, which `withholdForFree` has never touched; the field
 *     lists a free payload carried before and carries now are written out below
 *     and compared exactly.
 *
 * ONE temp database for the file. The server page is imported DYNAMICALLY after
 * `openTempDb()` sets VYUHA_DB_PATH.
 */

// `PageHeader` → `BackButton` → `useRouter`; a framework stub, not a seam half.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/strategies",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
}));

// The licence is the INPUT VARIABLE: the same real page is run on both.
const ent = vi.hoisted(() => ({ pro: true }));
vi.mock("@/lib/queries/license", () => ({
  getEntitlement: () => ({ state: ent.pro ? "trial" : "unlicensed", pro: ent.pro, payload: null, trialDaysLeft: ent.pro ? 7 : 0 }),
}));

// recharts draws nothing without a measured size (`ResponsiveContainer` starts
// at -1 × -1), so the series the chart is HANDED is read off a stand-in: the
// container passes its child through and `AreaChart` prints its `data`.
vi.mock("recharts", async () => {
  const R = await import("react");
  const nothing = () => null;
  return {
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => R.createElement(R.Fragment, null, children),
    AreaChart: ({ data }: { data: unknown }) => R.createElement("figure", { "data-points": JSON.stringify(data) }),
    Area: nothing,
    CartesianGrid: nothing,
    ReferenceLine: nothing,
    Tooltip: nothing,
    XAxis: nothing,
    YAxis: nothing,
  };
});

const ROOT = path.resolve(__dirname, "..");
// The `render-windowing.test.ts` stripper: prose describing a mechanism must
// never stand in for the mechanism.
const source = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** What a value looks like after the server→client boundary. */
const overTheWire = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sha256 = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/* ═══════════════════════════════════════════════════════════════════════════
   1 — the points did not move
   ═══════════════════════════════════════════════════════════════════════════ */

const EXPIRIES = ["2026-09-24", "2026-10-29", "2026-11-26"];

/** Legs for one catalogue pattern — `tests/seams-v43-wave2.test.ts`'s builder, for EVERY pattern. */
function legsFor(def: StrategyDef, patternIndex: number, symbol: string): PositionedLeg[] {
  return def.patterns[patternIndex].legs.map((l, i): PositionedLeg =>
    l.kind === "UL"
      ? { symbol, expiry: null, kind: "UL", strike: 0, side: l.side, qty: 75 * l.qtyRatio, premium: 1000 }
      : {
          symbol,
          expiry: EXPIRIES[l.expiryRank],
          kind: l.kind,
          optionType: l.kind,
          strike: 1000 + 100 * (l.strikeRank as number),
          side: l.side,
          qty: 75 * l.qtyRatio,
          premium: 30 + 4 * i,
        },
  );
}

const opt = (symbol: string, over: Partial<PositionedLeg>): PositionedLeg => ({
  symbol,
  expiry: "2026-09-24",
  kind: "CE",
  optionType: "CE",
  strike: 24000,
  side: "long",
  qty: 75,
  premium: 100,
  ...over,
});
const ul = (symbol: string, over: Partial<PositionedLeg>): PositionedLeg => ({
  symbol,
  expiry: null,
  kind: "UL",
  strike: 0,
  side: "long",
  qty: 75,
  premium: 24000,
  ...over,
});

/**
 * EVERY STRUCTURE KIND: each pattern of each of the catalogue's rows, plus the
 * shapes no row covers. The order and every number here are part of the digest
 * — changing one is re-measuring, and needs the old engine to do it honestly.
 */
function fixtureLegs(): PositionedLeg[] {
  const legs: PositionedLeg[] = [];
  for (const def of CATALOGUE) {
    def.patterns.forEach((_, pi) => legs.push(...legsFor(def, pi, `${def.id}#${pi}`)));
  }
  legs.push(
    // A breakeven beyond the chart's right edge: the range stretches past it.
    opt("FAROTM", { strike: 20000, premium: 4000, qty: 50 }),
    // Paise premiums and a large quantity.
    opt("IDEA", { strike: 10, premium: 0.45, qty: 40000 }),
    // Unnamed, one expiry.
    opt("ODD", {}),
    opt("ODD", { strike: 24500, qty: 150 }),
    opt("ODD", { strike: 25000, qty: 25 }),
    // Unnamed across two expiries: the per-expiry split.
    opt("SPLIT", { premium: 180 }),
    opt("SPLIT", { strike: 24500, side: "short", premium: 60 }),
    opt("SPLIT", { kind: "PE", optionType: "PE", strike: 23000, expiry: "2026-10-29", premium: 95.35, qty: 150 }),
    opt("SPLIT", { kind: "PE", optionType: "PE", strike: 22000, expiry: "2026-10-29", premium: 41.2, qty: 25 }),
    // An undated future under a short call (P14), and a short future under a short put.
    ul("UNDATED", { expiryUnknown: true, contractMonth: "2026-09" }),
    opt("UNDATED", { strike: 24500, side: "short", expiry: "2026-10-29", premium: 180 }),
    ul("SHORTFUT", { side: "short", expiry: "2026-09-24", premium: 1432.65, qty: 400 }),
    opt("SHORTFUT", { kind: "PE", optionType: "PE", strike: 1400, side: "short", premium: 22.4, qty: 400 }),
  );
  return legs;
}

/**
 * sha256 of `JSON.stringify(groups.map((g) => [g.key, g.payoff]))` over
 * `buildStrategies(fixtureLegs())`, MEASURED AT 180dd3c (v4.7.0 + docs) with
 * `lib/analytics/strategies.ts` unmodified — 56 groups, 94,882 bytes of series.
 */
const HEAD_SERIES_DIGEST = "fa5ddc645ffeae53cb309a86d65c07e1aaacc5bd02b32db715c764e6527e3d53";

/** The points `PayoffChartOfLegs` hands `AreaChart`, read off the rendered stand-in. */
function drawnPoints(legs: readonly OptionLeg[], breakevens: readonly number[]): unknown {
  const html = renderToStaticMarkup(React.createElement(PayoffChartOfLegs, { legs, breakevens, spot: null }));
  const m = /data-points="([^"]*)"/.exec(html);
  if (!m) throw new Error("the chart rendered no AreaChart");
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

describe("payoffSeries draws exactly the points the engine drew inline", () => {
  const groups = buildStrategies(fixtureLegs());

  it("the fixture holds every catalogue row, the unnamed cases and the stretched range — otherwise the digest proves little", () => {
    expect(groups).toHaveLength(56);
    const named = new Set(groups.map((g) => g.strategyId).filter((id) => id !== null));
    expect([...named].sort()).toEqual(CATALOGUE.map((d) => d.id).sort());
    expect(groups.filter((g) => g.strategyId === null).map((g) => g.key)).toEqual(expect.arrayContaining(["ODD", "SPLIT|2026-10-29"]));
    // FAROTM: 20000 CE bought at 4,000 breaks even at 24,000, past maxK + pad.
    const far = groups.find((g) => g.key === "FAROTM")!;
    expect(far.breakevens).toEqual([24000]);
    expect(payoffSeries(far.legs, far.breakevens)[PAYOFF_POINTS - 1].price).toBe(25200);
  });

  it("from the two fields that cross the wire, to the paisa: the digest measured on the unmodified engine", () => {
    const series = groups.map((g) => [g.key, payoffSeries(overTheWire(g.legs), overTheWire(g.breakevens))]);
    expect(series.every(([, s]) => (s as unknown[]).length === 61)).toBe(true);
    expect(sha256(series), "a point moved: the chart no longer draws what it drew before P3").toBe(HEAD_SERIES_DIGEST);
  });

  it("the engine's own `payoff` is the same call — one function, not two that agree today", () => {
    expect(sha256(groups.map((g) => [g.key, g.payoff]))).toBe(HEAD_SERIES_DIGEST);
    for (const g of groups) expect(payoffSeries(g.legs, g.breakevens), g.key).toEqual(g.payoff);
  });

  it("the CHART is handed those points — read off what PayoffChartOfLegs passes to AreaChart", () => {
    const drawn = groups.map((g) => [g.key, drawnPoints(overTheWire(g.legs), overTheWire(g.breakevens))]);
    expect(sha256(drawn), "the chart component draws a different series").toBe(HEAD_SERIES_DIGEST);
  });

  it("the breakevens' order and duplicates do not matter — only their maximum is read", () => {
    const far = groups.find((g) => g.key === "FAROTM")!;
    expect(payoffSeries(far.legs, [3, 24000, 24000, 7])).toEqual(far.payoff);
    // …and a breakeven INSIDE the range leaves the grid alone.
    const spread = groups.find((g) => g.key === "bull-call-spread#0")!;
    expect(payoffSeries(spread.legs, [])).toEqual(spread.payoff);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2 + 3 — the real page's payload, on both licences
   ═══════════════════════════════════════════════════════════════════════════ */

let t: TempDb;
let page: typeof import("@/app/strategies/page");

beforeAll(async () => {
  t = await openTempDb("strategies-payload", { seed: true });
  page = await import("@/app/strategies/page");

  const row = (over: Record<string, unknown>) => tradeRow({ accountId: 1, isOpen: true, ...over });
  const option = (symbol: string, optionType: "CE" | "PE", strike: number, over: Record<string, unknown>) =>
    row({ symbol, instrumentType: "option", optionType, strike, expiry: "2027-03-25", ...over });
  t.db
    .insert(t.schema.trades)
    .values([
      // NIFTY — a 1×2 call ratio spread: named by the catalogue and NOT one of
      // the sixteen pre-4.3 names, so a free build must not receive its name.
      option("NIFTY", "CE", 24000, { buyQty: 75, avgBuyPrice: 100 }),
      option("NIFTY", "CE", 24500, { sellQty: 150, avgSellPrice: 40 }),
      // SBIN — a bull call spread: legacy-free, the name stays on a free build.
      option("SBIN", "CE", 800, { buyQty: 750, avgBuyPrice: 24 }),
      option("SBIN", "CE", 850, { sellQty: 750, avgSellPrice: 9 }),
      // INFY — a protective put over a holding: a UL leg on the wire.
      option("INFY", "PE", 1500, { buyQty: 400, avgBuyPrice: 30 }),
      row({ symbol: "INFY", instrumentType: "equity", buyQty: 400, avgBuyPrice: 1450 }),
      // IDEA — one long call at a paise premium and a large quantity.
      option("IDEA", "CE", 10, { buyQty: 40000, avgBuyPrice: 0.45 }),
    ])
    .run();
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
  // Raised timeout: this hook migrates and seeds one temp database and imports
  // the server page — ~3.5 s locally (the whole file ran in 4.0 s, 2026-10-05),
  // and the Windows CI runner is > 15× slower on SQLite-file work (AGENTS.md).
}, 60_000);

afterAll(() => t?.cleanup());
afterEach(() => {
  ent.pro = true;
});

type Elem = { type: unknown; props: Record<string, unknown> };
const isElem = (n: unknown): n is Elem => React.isValidElement(n);

function findElem(node: unknown, pick: (e: Elem) => boolean): Elem | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findElem(n, pick);
      if (hit) return hit;
    }
    return null;
  }
  if (!isElem(node)) return null;
  if (pick(node)) return node;
  return findElem(node.props.children, pick);
}

/** A value as props carry it: an element is its own props, all the way down. */
function wireOf(value: unknown): unknown {
  if (isElem(value)) return wireOf(value.props);
  if (Array.isArray(value)) return value.map(wireOf);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, wireOf(v)]));
  }
  return value;
}

type Group = Record<string, unknown> & { key: string; symbol: string; legs: OptionLeg[]; breakevens: number[]; ulLegs: OptionLeg[] };
type ChartProps = { legs: OptionLeg[]; breakevens: number[]; spot: number | null } & Record<string, unknown>;

/** The props the page hands its client island, on one licence. */
function clientProps(pro: boolean) {
  ent.pro = pro;
  const el = findElem(page.default(), (e) => e.type === StrategiesClient);
  ent.pro = true;
  if (!el) throw new Error("the strategies page no longer renders <StrategiesClient>");
  const groups = el.props.groups as Group[];
  const charts = el.props.charts as Record<string, unknown>;
  const chartOf = (key: string): ChartProps => {
    const chart = findElem(charts[key], (e) => e.type === PayoffChartOfLegs);
    if (!chart) throw new Error(`no payoff chart for ${key}`);
    return chart.props as ChartProps;
  };
  return { props: el.props, groups, chartOf, wire: JSON.stringify(wireOf(el.props)) };
}

/** Every key at any depth of a serialised value. */
function keysIn(json: string): Set<string> {
  const out = new Set<string>();
  JSON.parse(json, (k, v) => {
    if (k !== "" && !/^\d+$/.test(k)) out.add(k);
    return v;
  });
  return out;
}

/** The fields of one group in the payload BEFORE P3 (180dd3c) — `StrategyGroup` + `proWithheld`. */
const GROUP_FIELDS_BEFORE = [
  "key", "symbol", "expiry", "name", "legs", "netPremium", "isCredit", "maxProfit", "maxLoss", "breakevens", "payoff",
  "strategyId", "displayName", "legacyFree", "expiries", "nearestExpiry", "capLabel", "notComputed", "ulLegs", "proWithheld",
];
/** …and now: the same list less the series. Nothing is added. */
const GROUP_FIELDS_NOW = GROUP_FIELDS_BEFORE.filter((f) => f !== "payoff");
/**
 * The four-card fixture's `groups` + `charts`, in JSON bytes, measured 2026-10-05
 * (`…Once` = every shared array counted once, as the RSC payload states it).
 * Deterministic for this fixture; a new group field moves `now` and `before`
 * together and is re-measured here on purpose.
 */
const MEASURED_BYTES = { now: 3766, nowOnce: 2822, before: 17149, beforeOnce: 9948, series: 7086 };
/** The fields of one leg as app/strategies/page.tsx builds it — unchanged by P3. */
const LEG_FIELDS = ["symbol", "expiry", "kind", "optionType", "strike", "side", "qty", "premium", "expiryUnknown", "contractMonth"];

describe("the page no longer ships the series (Pro build)", () => {
  it("the fixture is the page's own: four cards, one of each case", () => {
    const { groups } = clientProps(true);
    expect(groups.map((g) => [g.symbol, g.strategyId])).toEqual([
      ["IDEA", "long-call"],
      ["INFY", "protective-put"],
      ["NIFTY", "call-ratio-spread"],
      ["SBIN", "bull-call-spread"],
    ]);
  });

  it("no group carries `payoff`, and the word is no key anywhere in the client's props", () => {
    const { groups, wire } = clientProps(true);
    for (const g of groups) expect(Object.keys(g), g.key).not.toContain("payoff");
    expect(keysIn(wire).has("payoff"), "a payoff series is back in the payload").toBe(false);
    // The series under another name is the same regression: no array of price/pnl points at all.
    expect(wire).not.toContain('"pnl"');
  });

  it("each chart is handed the group's OWN legs and breakevens — the same arrays, so the payload states them once", () => {
    const { groups, chartOf } = clientProps(true);
    for (const g of groups) {
      const chart = chartOf(g.key);
      expect(Object.keys(chart).sort(), g.key).toEqual(["breakevens", "legs", "spot"]);
      expect(chart.legs, `${g.key}: a copy of the legs is a second copy on the wire`).toBe(g.legs);
      expect(chart.breakevens, g.key).toBe(g.breakevens);
    }
  });

  it("…and from them the browser draws the engine's series for the page's own legs", () => {
    const { groups, chartOf } = clientProps(true);
    for (const g of groups) {
      const chart = overTheWire(chartOf(g.key));
      const [engine] = buildStrategies(g.legs as PositionedLeg[]);
      expect(drawnPoints(chart.legs, chart.breakevens), g.key).toEqual(engine.payoff);
    }
    // IDEA 10 CE at 0.45 breaks even at 10.45, inside 10 + 50: the padded range, to the rupee.
    expect(payoffSeries(groups[0].legs, groups[0].breakevens)[PAYOFF_POINTS - 1]).toEqual({ price: 60, pnl: 1982000 });
  });

  it("the bytes: `groups` + `charts` are a fraction of what they were with the series in them", () => {
    const { groups, chartOf } = clientProps(true);
    const bytes = (v: unknown) => JSON.stringify(v).length;
    const seriesOf = (g: Group) => payoffSeries(g.legs, g.breakevens);
    // NOW, as the page builds it. JSON has no references, so the legs each chart
    // shares with its group are counted TWICE here; the RSC payload states them once.
    const now = bytes({ groups, charts: groups.map((g) => chartOf(g.key)) });
    const nowOnce = bytes({ groups, charts: groups.map((g) => ({ spot: chartOf(g.key).spot })) });
    // BEFORE (180dd3c), rebuilt field for field: the series in the group, and the
    // same array handed to the chart as `data` beside the breakevens and the spot.
    const was = groups.map((g) => ({ ...g, payoff: seriesOf(g) }));
    const before = bytes({ groups: was, charts: was.map((g) => ({ data: g.payoff, breakevens: g.breakevens, spot: chartOf(g.key).spot })) });
    const beforeOnce = bytes({ groups: was, charts: was.map((g) => ({ spot: chartOf(g.key).spot })) });
    const series = groups.reduce((n, g) => n + bytes(seriesOf(g)), 0);

    // Each array counted once, the whole difference is the series and its key.
    expect(beforeOnce - nowOnce).toBe(series + groups.length * ',"payoff":'.length);
    expect({ now, nowOnce, before, beforeOnce, series }).toEqual(MEASURED_BYTES);
    expect(nowOnce).toBeLessThan(beforeOnce / 3);
    expect(now).toBeLessThan(before / 4);
  });
});

describe("a free build's payload loses one field and gains none (invariant 7)", () => {
  it("every group carries exactly the fields it carried before, less `payoff`", () => {
    const { groups } = clientProps(false);
    expect(groups).toHaveLength(4);
    for (const g of groups) expect(Object.keys(g).sort(), g.key).toEqual([...GROUP_FIELDS_NOW].sort());
    expect(GROUP_FIELDS_BEFORE.filter((f) => !GROUP_FIELDS_NOW.includes(f))).toEqual(["payoff"]);
    expect(GROUP_FIELDS_NOW.filter((f) => !GROUP_FIELDS_BEFORE.includes(f))).toEqual([]);
  });

  it("every leg carries only the fields the page has always built, and the chart is handed nothing else", () => {
    const { groups, chartOf } = clientProps(false);
    for (const g of groups) {
      for (const l of [...g.legs, ...g.ulLegs]) {
        expect(Object.keys(l).filter((k) => !LEG_FIELDS.includes(k)), g.key).toEqual([]);
      }
      const chart = chartOf(g.key);
      expect(Object.keys(chart).sort(), g.key).toEqual(["breakevens", "legs", "spot"]);
      // The chart's inputs ARE the group's own fields — nothing reaches the browser through the chart alone.
      expect(chart.legs).toBe(g.legs);
      expect(chart.breakevens).toBe(g.breakevens);
    }
  });

  it("the withheld name and id are nowhere in the SERIALISED props — groups, charts, shelf and picker together", () => {
    const ratio = getStrategyDef("call-ratio-spread")!;
    expect(ratio.legacyFree, "the fixture must be a shape a free build is denied").toBe(false);
    const pro = clientProps(true);
    expect(pro.wire, "the control: a Pro build's payload does carry the name").toContain(ratio.name);
    expect(pro.wire).toContain('"strategyId":"call-ratio-spread"');

    const free = clientProps(false);
    expect(free.props.pro).toBe(false);
    expect(free.props.picker).toBeNull();
    expect(free.wire).not.toContain("call-ratio-spread");
    expect(free.wire).not.toContain(ratio.name);
    const nifty = free.groups.find((g) => g.symbol === "NIFTY")!;
    expect([nifty.strategyId, nifty.displayName, nifty.name, nifty.proWithheld]).toEqual([null, customName(2), customName(2), true]);
    // A legacy-free name is still there (a release never takes one away).
    expect(free.groups.find((g) => g.symbol === "SBIN")!.displayName).toBe(getStrategyDef("bull-call-spread")!.name);
  });

  it("a free payload differs from a Pro one ONLY in what withholdForFree substitutes — no key a Pro payload lacks", () => {
    const pro = clientProps(true);
    const free = clientProps(false);
    expect([...keysIn(free.wire)].filter((k) => !keysIn(pro.wire).has(k)), "a key only the free payload carries").toEqual([]);
    const differing = (a: Group, b: Group) => Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
    expect(free.groups.map((g, i) => [g.symbol, differing(g, pro.groups[i])])).toEqual([
      ["IDEA", []],
      // A protective put is a 4.3 shape, withheld; so is the ratio spread. Their legs and figures are untouched.
      ["INFY", ["displayName", "name", "proWithheld", "strategyId"]],
      ["NIFTY", ["displayName", "name", "proWithheld", "strategyId"]],
      ["SBIN", []],
    ]);
  });

  it("the payoff curve stays free: a free build's chart draws the very series a Pro build's does", () => {
    const pro = clientProps(true);
    const free = clientProps(false);
    for (const g of free.groups) {
      const mine = overTheWire(free.chartOf(g.key));
      const theirs = overTheWire(pro.chartOf(g.key));
      const drawn = drawnPoints(mine.legs, mine.breakevens);
      expect(drawn, g.key).toEqual(drawnPoints(theirs.legs, theirs.breakevens));
      expect(drawn, g.key).toEqual(buildStrategies(g.legs as PositionedLeg[])[0].payoff);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The pure halves, and the wiring
   ═══════════════════════════════════════════════════════════════════════════ */

describe("withoutPayoff — one field out, nothing else moved", () => {
  const built: StrategyGroup[] = buildStrategies(fixtureLegs());

  it("drops `payoff` and keeps every other field by reference, on both licences", () => {
    for (const pro of [true, false]) {
      const screen = withholdForFree(built, pro);
      const wire = withoutPayoff(screen);
      expect(wire).toHaveLength(screen.length);
      wire.forEach((w, i) => {
        const { payoff, ...rest } = screen[i];
        expect(payoff).toHaveLength(PAYOFF_POINTS);
        expect(w, screen[i].key).toEqual(rest);
        expect("payoff" in w, screen[i].key).toBe(false);
        expect(w.legs, "a copied leg array is serialised twice").toBe(screen[i].legs);
        expect(w.breakevens).toBe(screen[i].breakevens);
      });
    }
  });

  it("the whole fixture: 94,882 bytes of series leave the groups, and what is left still draws them", () => {
    const screen = withholdForFree(built, false);
    const wire = withoutPayoff(screen);
    const before = JSON.stringify(screen).length;
    const now = JSON.stringify(wire).length;
    expect(JSON.stringify(built.map((g) => g.payoff)).length).toBe(94882);
    // 94,882 is the 56 series as ONE array: less its two brackets and 55 commas, plus each group's own key.
    expect(before - now).toBe(94882 - 2 - (built.length - 1) + built.length * '"payoff":,'.length);
    expect(now, `now ${now} B, before ${before} B`).toBeLessThan(before / 3);
    const redrawn = overTheWire(wire).map((g) => [g.key, payoffSeries(g.legs, g.breakevens)]);
    expect(sha256(redrawn)).toBe(HEAD_SERIES_DIGEST);
  });
});

describe("the wiring, on comment-stripped source", () => {
  const pageSrc = source("app/strategies/page.tsx");
  const chartSrc = source("components/reports/payoff-chart.tsx");

  it("the page drops the series AFTER the withholding, and hands the chart legs — never a series", () => {
    expect(pageSrc).toContain("withoutPayoff(withholdForFree(built, pro))");
    expect(pageSrc).toContain("<PayoffChartOfLegs legs={g.legs} breakevens={g.breakevens}");
    expect(pageSrc, "the page reads a payoff series again").not.toMatch(/\.payoff\b/);
    expect(pageSrc, "the chart is handed a `data` series again").not.toMatch(/\bdata=\{/);
  });

  it("the chart computes its points with the engine's own function, derived at render", () => {
    expect(chartSrc).toContain("payoffSeries(legs, breakevens)");
    // No state, no effect, no fetch: the series is derived from the props (AGENTS.md).
    for (const banned of ["useEffect", "useState", "fetch("]) expect(chartSrc, banned).not.toContain(banned);
  });

  it("the engine has ONE sampler: computeStrategy calls payoffSeries and keeps no loop of its own", () => {
    const engine = source("lib/analytics/strategies.ts");
    expect(engine).toContain("const payoff = payoffSeries(legs, breakevens);");
    expect(engine.match(/Array\.from\(\{ length: /g), "a second sampling loop").toHaveLength(1);
    expect(PAYOFF_POINTS).toBe(61);
  });
});
