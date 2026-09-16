import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wave 2O — the SOURCE half of three fixes whose defects TypeScript cannot see.
 *
 * All three were `number` widened to `number | null`, and the compiler stays
 * silent at exactly the three places that matter:
 *   - a template literal (`${k.chargePctOfGross}%` prints "null%");
 *   - a `!== 0` guard over a nullable (`null !== 0` is TRUE, then `null / null`
 *     prints "NaN×");
 *   - a `?? undefined` handed to a `valueNum` prop, which renders an EMPTY card
 *     rather than a dash (`kpi-card.tsx:188` branches on `!== undefined` and
 *     falls through to `quietCurrency(value)`).
 * The behaviour of the pure functions is pinned in `tests/analytics.test.ts` and
 * `tests/share-card.test.ts`; what is pinned here is the shape of the READERS,
 * because each of them compiles happily while printing a fabricated figure.
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
/**
 * Comments are stripped before every source assertion, in both directions: a
 * comment quoting the old expression must not redden a pin, and a comment
 * quoting the new one must not satisfy it. Same helper as
 * `tests/live-keys.test.ts`.
 */
const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (rel: string) => stripComments(read(rel));
const EDGE = "app/reports/edge/page.tsx";
const CHARTS = "components/dashboard/charts.tsx";
const DASH = "components/dashboard/dashboard-client.tsx";
const LENSES = "components/lenses/lenses-client.tsx";

describe("D2 — /reports/edge measures every statistic over the PRICED trades", () => {
  const src = code(EDGE);
  /**
   * `EdgeTable` only. The SEGMENT DEPTH table further down the same page has its
   * own type (`SegmentDepthReport`, whose `count` IS its priced count and whose
   * `excluded` is stated beside it) and its own guarded rate — it is not a
   * GroupStat reader and nothing here applies to it.
   */
  const table = (() => {
    const from = src.indexOf("function EdgeTable(");
    expect(from).toBeGreaterThan(0);
    const next = src.indexOf("\nfunction ", from + 1);
    return src.slice(from, next === -1 ? undefined : next);
  })();

  it("the book reference rate sums pricedCount, never the closed count", () => {
    expect(table).toContain("rows.reduce((s, r) => s + r.pricedCount, 0)");
    expect(table, "Σ count was the all-closed denominator this fix removes").not.toContain(
      "rows.reduce((s, r) => s + r.count, 0)",
    );
  });

  it("the p-value, the interval and the correction set all use pricedCount", () => {
    expect(table).toContain("proportionPValue(r.wins, r.pricedCount, bookRate)");
    expect(table).toContain("wilsonInterval(r.wins, r.pricedCount)");
    expect(table, "a p-value on n = 0 is not a test — the row leaves the BY set").toContain(
      ".filter((r) => r.pricedCount > 0)",
    );
    expect(table).not.toMatch(/wilsonInterval\(r\.wins, r\.count\)/);
    expect(table).not.toMatch(/proportionPValue\(r\.wins, r\.count/);
  });

  it("a pricedCount-0 row shows a dash for the rate, the CI and the expectancy", () => {
    expect(table).toContain("const priced = r.pricedCount > 0;");
    expect(table, "pct() prints — on null; a raw .toFixed would print NaN%").toContain(
      "pct(r.winRate == null ? null : r.winRate * 100, 1)",
    );
    expect(table).not.toMatch(/\(r\.winRate \* 100\)\.toFixed/);
    // wilsonInterval(w, 0) is a FULL 0%-100% interval and rateVerdict calls n = 0
    // "no closed trades yet" — both false for a closed-but-unpriced slice.
    expect(table).toContain('"no priced trades in this slice"');
    expect(table).toMatch(/priced \? fmtIntervalPct\(wilsonInterval\(r\.wins, r\.pricedCount\)\) : "—"/);
    expect(table, "the local expectancy is the Kpis rule, not a third denominator").toContain(
      "priced ? r.pricedNet / r.pricedCount : null",
    );
    expect(table).not.toMatch(/r\.count \? r\.net \/ r\.count/);
    expect(table, "the multiplicity mark must not appear on an untested row").toContain(
      "bookRate != null && priced && !verdictFor.get(r.key)",
    );
  });

  it("the export carries the denominator beside the rate", () => {
    expect(src).toContain('{ key: "pricedCount", label: "Priced trades" }');
  });
});

describe("D2 — the dashboard's segment/setup bars read cash only", () => {
  it("SegmentBars keys on net and knows nothing about a win rate", () => {
    const src = code(CHARTS);
    const from = src.indexOf("export function SegmentBars");
    expect(from).toBeGreaterThan(0);
    const next = src.indexOf("export function", from + 1);
    const bars = src.slice(from, next === -1 ? undefined : next);
    expect(bars).toContain('dataKey="net"');
    expect(bars, "a null ratio can never reach this chart, so it needs no null branch").not.toMatch(
      /winRate|pricedCount|pricedNet/,
    );
  });
});

describe("D2 — a null win rate exports as a BLANK cell, never a 0", () => {
  it("through lib/export.ts's own serialiser, on the edge report's column shape", async () => {
    const { exportRows } = await import("@/lib/export");
    // lib/export.ts ends in a DOM download; the serialiser in front of it is what
    // this pins, so the anchor and the object URL are stubbed and the Blob read.
    const urlCtor = URL as unknown as { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
    const globals = globalThis as unknown as { document?: unknown };
    const priorCreate = urlCtor.createObjectURL;
    const priorRevoke = urlCtor.revokeObjectURL;
    const priorDoc = globals.document;
    let captured: Blob | null = null;
    urlCtor.createObjectURL = (b: Blob) => {
      captured = b;
      return "blob:wave2o";
    };
    urlCtor.revokeObjectURL = () => {};
    globals.document = {
      createElement: () => ({ click: () => {} }),
      body: { appendChild: () => {}, removeChild: () => {} },
    };
    try {
      await exportRows(
        "wave2o",
        [
          { key: "key", label: "Group" },
          { key: "pricedCount", label: "Priced trades" },
          { key: "winRate", label: "Win rate" },
        ],
        [
          { key: "ipo-flip", pricedCount: 0, winRate: null },
          { key: "breakout", pricedCount: 2, winRate: 0.5 },
        ],
        "csv",
      );
    } finally {
      urlCtor.createObjectURL = priorCreate;
      urlCtor.revokeObjectURL = priorRevoke;
      globals.document = priorDoc;
    }
    expect(captured, "the CSV blob").not.toBeNull();
    const csv = await (captured as unknown as Blob).text();
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("Group,Priced trades,Win rate");
    // The null is a blank; a real 0 denominator still prints 0 (invariant 6:
    // blank rather than 0 for what cannot be derived, not for what is zero).
    expect(lines[1]).toBe("ipo-flip,0,");
    expect(lines[2]).toBe("breakout,2,0.5");
  });
});

describe("D1 — the Kpis readers that the compiler cannot check", () => {
  const dash = code(DASH);
  const lenses = code(LENSES);

  it("the dashboard interpolates no RAW ratio into a template literal", () => {
    // `${null}%` is the string "null%" and TypeScript says nothing: the exact
    // class that regressed in 2L. A FORMATTED read (`${inrCompact(k.avgWin)}`)
    // is fine — lib/format prints "—" for null.
    expect(dash).not.toMatch(/\$\{k\.(chargePctOfGross|winRate|expectancy|avgWin|avgLoss)\b/);
    expect(dash, "a .toFixed on a nullable throws, it does not print 0").not.toContain(
      "(k.winRate * 100).toFixed",
    );
    expect(dash).toContain("pct(k.chargePctOfGross, 2)");
    expect(dash).toContain("pct(k.winRate == null ? null : k.winRate * 100, 1)");
  });

  it("the hero cards dash out rather than count up a null", () => {
    expect(dash, "the avgR pattern, never `?? undefined`").toContain(
      'k.winRate == null ? "—" : <CountUp',
    );
    expect(dash, "a null tone paints a green dash").toContain("k.expectancy == null ? undefined");
  });

  it("the two payoff cells guard BOTH sides before dividing", () => {
    // `avgLoss !== 0` is TRUE on null, and Math.abs(null / null) is NaN — the
    // "NaN×" the payoff cell printed on a book with no loser.
    expect(dash).toContain("k.avgWin != null && k.avgLoss != null && k.avgLoss !== 0");
    expect(lenses).toContain("edge.avgWin != null && edge.avgLoss != null && edge.avgLoss !== 0");
    for (const [name, src] of [[DASH, dash], [LENSES, lenses]] as const) {
      expect(src, `${name} must not divide on a !== 0 guard alone`).not.toMatch(
        /(?<!!= null && )\b\w+\.avgLoss !== 0/,
      );
    }
  });

  it("/lenses draws the dash from the NULL, not only from closedCount", () => {
    // `measurable={totals.closedCount > 0}` does not cover a closed book whose
    // every trade is unpriced — that row has a closed count and no rate.
    expect(lenses).toContain("pct(e.winRate == null ? null : e.winRate * 100, 0)");
    expect(lenses).not.toMatch(/\$\{\(e\.winRate \* 100\)\.toFixed/);
    expect(lenses).toContain("totals.closedCount > 0 && edge.winRate != null");
    expect(lenses).toContain("totals.closedCount > 0 && edge.expectancy != null");
  });

  it("no ratio reaches a valueNum prop as `?? undefined` — that renders an EMPTY card", () => {
    for (const [name, src] of [[DASH, dash], [LENSES, lenses]] as const) {
      expect(src, `${name}: kpi-card branches on !== undefined and falls through`).not.toMatch(
        /valueNum=\{[^}]*\?\? undefined/,
      );
    }
  });
});
