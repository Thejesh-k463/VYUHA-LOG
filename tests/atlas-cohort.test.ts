import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { alignToAnchor, modalAnchor } from "@/lib/atlas/anchor";
import { computeCohorts, cohortVerdict, excludedLine, thinCohortLine, type CohortRow } from "@/lib/atlas/cohort";
import { computeAtlasDaily } from "@/lib/atlas/compute-daily";
import type { ClassificationRef } from "@/lib/atlas/levels";
import { buildGapMap } from "@/lib/atlas/returns";
import { COHORT_MIN_COVERAGE_PPM, COHORT_MIN_PRICED, toSeries, type Bar, type Series } from "@/lib/atlas/types";

/**
 * The cohort view (v4.6.0 W5: Q51 #3–#7, AQ21, AQ26, AQ47, design review A4/A5).
 *
 *   fall-up     — industry under the width floor → the SECTOR cohort, and the
 *                 row says so and states the count it decided on.
 *   one level   — decided ONCE on 1m; 1w uses the same cohort (A4).
 *   width floor — ≥ 5 priced AND ≥ 60% of members priced, else "—" with the
 *                 AQ26 sentence.
 *   CA guard    — a split inside the window leaves the own return "—" with the
 *                 excluded date; and the SAME gap map the rotation uses gives
 *                 the SAME excluded set (A5 guard).
 *   verdict     — descriptive, never a rating (AQ47).
 */

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);
const N = 30;
const linear = (start: number, step: number, n = N) => Array.from({ length: n }, (_, i) => start + step * i);
function series(symbol: string, closes: number[]): Series {
  return { symbol, bars: closes.map((c, i) => ({ symbol, date: iso(i), high: c, low: c, close: c, volume: 1000 })) };
}
const ref = (sector: string, industry: string | null, source = "taxonomy"): ClassificationRef => ({ macro: null, sector, industry, basic: null, tier: "high", source });

// Six banks (a wide industry), three NBFCs (a thin one), all in Financial Services.
const BANKS = ["B1", "B2", "B3", "B4", "B5", "B6"];
const NBFC = ["N1", "N2", "N3"];
const REFS: Record<string, ClassificationRef> = {};
for (const b of BANKS) REFS[b] = ref("Financial Services", "Banks");
for (const n of NBFC) REFS[n] = ref("Financial Services", "Finance");
REFS.MYTAG = ref("Financial Services", null, "user");
const resolve = (s: string) => REFS[s] ?? null;

function universe(): Series[] {
  const out: Series[] = [];
  BANKS.forEach((b, i) => out.push(series(b, linear(100, i - 2)))); // slopes −2 … +3 per session
  NBFC.forEach((n, i) => out.push(series(n, linear(200, i + 1))));
  out.push(series("MYTAG", linear(50, 0.5)));
  return out;
}

const gapsOf = (s: Series[]) => buildGapMap(s);

describe("the level — industry, falling UP to sector (AQ21), decided once on 1m (A4)", () => {
  it("uses the industry cohort when it is wide enough, and states n of m priced", () => {
    const u = universe();
    const { rows } = computeCohorts(u, ["B1"], resolve, gapsOf(u));
    const row = rows[0];
    expect(row.level).toBe("industry");
    expect(row.group).toBe("Banks");
    expect(row.fellUp).toBe(false);
    expect(row.thin).toBe(false);
    expect(row.decidedOn).toEqual({ window: "1m", priced: 6, members: 6, coveragePpm: 1_000_000 });
    expect(row.windows["1m"].constituents).toBe(6);
    expect(row.windows["1m"].members).toBe(6);
    expect(row.windows["1m"].cohort?.denominator).toBe(6);
    // Both windows compare against the SAME cohort.
    expect(row.windows["1w"].members).toBe(6);
  });

  it("falls up to the sector when the industry has fewer than 5 priced, and says which count decided it", () => {
    const u = universe();
    const { rows } = computeCohorts(u, ["N1"], resolve, gapsOf(u));
    const row = rows[0];
    expect(row.classification.industry).toBe("Finance");
    expect(row.level).toBe("sector");
    expect(row.group).toBe("Financial Services");
    expect(row.fellUp).toBe(true);
    expect(row.thin).toBe(false);
    expect(row.decidedOn).toEqual({ window: "1m", priced: 10, members: 10, coveragePpm: 1_000_000 });
    expect(row.windows["1w"].members).toBe(10);
    expect(row.windows["1m"].members).toBe(10);
  });

  it("falls up on the COVERAGE floor too: 8 members with only 4 priced is 50%, under 60%", () => {
    const u = universe();
    // Four more banks listed ten sessions ago: a bar ON the anchor, but no 1m return.
    const young = (symbol: string): Series => ({
      symbol,
      bars: Array.from({ length: 10 }, (_, k) => ({ symbol, date: iso(N - 10 + k), high: 100 + k, low: 100 + k, close: 100 + k, volume: 1000 })),
    });
    u.push(young("B7"), young("B8"), young("B9"), young("B10"));
    for (const b of ["B7", "B8", "B9", "B10"]) REFS[b] = ref("Financial Services", "Banks");
    const aligned = alignToAnchor(u, modalAnchor(u)).aligned;
    expect(aligned.map((s) => s.symbol)).toContain("B7");
    // Banks: 10 members, 6 priced = 60% → the industry holds, at the floor exactly.
    const wide = computeCohorts(aligned, ["B1"], resolve, gapsOf(aligned)).rows[0];
    expect(wide.level).toBe("industry");
    expect(wide.decidedOn).toEqual({ window: "1m", priced: 6, members: 10, coveragePpm: 600_000 });
    // Drop two priced banks → 8 members, 4 priced = 50% → falls up to the sector
    // (12 members, 8 priced = 66.7%, ≥ 5 priced), and says so.
    const thinner = aligned.filter((s) => s.symbol !== "B5" && s.symbol !== "B6");
    const narrow = computeCohorts(thinner, ["B1"], resolve, gapsOf(thinner)).rows[0];
    expect(narrow.level).toBe("sector");
    expect(narrow.fellUp).toBe(true);
    expect(narrow.decidedOn).toEqual({ window: "1m", priced: 8, members: 12, coveragePpm: 666_667 });
    for (const b of ["B7", "B8", "B9", "B10"]) delete REFS[b];
  });

  it("a user-tagged symbol has no industry and compares against its sector without 'falling up'", () => {
    const u = universe();
    const row = computeCohorts(u, ["MYTAG"], resolve, gapsOf(u)).rows[0];
    expect(row.level).toBe("sector");
    expect(row.fellUp).toBe(false);
    expect(row.classification.source).toBe("user");
  });

  it("is '—' with the AQ26 sentence when no level meets the floor, and keeps the deepest level's count", () => {
    const u = universe().filter((s) => s.symbol.startsWith("N"));
    const row = computeCohorts(u, ["N1"], resolve, gapsOf(u)).rows[0];
    expect(row.thin).toBe(true);
    expect(row.level).toBe("industry");
    expect(row.thinLine).toBe("cohort too thin to compare (3 of 3 priced)");
    expect(row.verdict).toBe(row.thinLine);
    expect(row.windows["1m"].cohort).toBeNull();
    expect(row.windows["1m"].diff).toBeNull();
    expect(row.windows["1m"].own).not.toBeNull(); // the symbol's OWN return still prints
    expect(thinCohortLine(3, 41)).toBe("cohort too thin to compare (3 of 41 priced)");
    expect(COHORT_MIN_PRICED).toBe(5);
    expect(COHORT_MIN_COVERAGE_PPM).toBe(600_000);
  });
});

describe("the figures on the row", () => {
  it("own, cohort (median), diff, rank in cohort and percentile", () => {
    const u = universe();
    const { rows } = computeCohorts(u, ["B6", "B1"], resolve, gapsOf(u));
    const b6 = rows.find((r) => r.symbol === "B6")!; // the fastest riser
    const w = b6.windows["1m"];
    expect(w.own).not.toBeNull();
    expect(w.cohort!.value_ppm).not.toBeNull();
    expect(w.diff).toBe(w.own! - w.cohort!.value_ppm!);
    expect(w.rank).toEqual({ position: 1, of: 6 });
    expect(w.percentile).toBe(100);
    const b1 = rows.find((r) => r.symbol === "B1")!; // the fastest faller
    expect(b1.windows["1m"].rank).toEqual({ position: 6, of: 6 });
    expect(b1.windows["1m"].percentile).toBe(0);
    expect(rows.map((r) => r.symbol)).toEqual(["B1", "B6"]); // sorted
  });

  it("a held symbol with no bars on the anchor is unpriced, not zeroed", () => {
    const u = universe();
    const row = computeCohorts(u, ["GHOST"], resolve, gapsOf(u)).rows[0];
    expect(row.unpriced).toBe(true);
    expect(row.level).toBeNull();
    expect(row.windows["1m"].own).toBeNull();
    expect(row.verdict).toMatch(/no stored bars/);
  });
});

describe("the corporate-action guard (Q51 #6, A5)", () => {
  function withSplit(): Series[] {
    const u = universe();
    // B3 splits 1:5 ten sessions back — inside 1m, outside 1w.
    const closes = linear(500, 0);
    for (let i = N - 10; i < N; i++) closes[i] = 100 + (i - (N - 10));
    return u.map((s) => (s.symbol === "B3" ? series("B3", closes) : s));
  }

  it("leaves the own return '—' with the excluded date, only in the window that spans the gap", () => {
    const u = withSplit();
    const gaps = gapsOf(u);
    expect(gaps.get("B3")).toHaveLength(1);
    const row = computeCohorts(u, ["B3"], resolve, gaps).rows[0];
    expect(row.windows["1m"].own).toBeNull();
    expect(row.windows["1m"].ownExcluded?.date).toBe(iso(N - 10));
    expect(row.windows["1w"].own).not.toBeNull();
    expect(row.excluded?.date).toBe(iso(N - 10));
    expect(row.verdict).toBe(`excluded: unreconciled price gap on ${iso(N - 10)}`);
    expect(excludedLine({ date: "2026-07-14", ratioPpm: -800_000 })).toBe("excluded: unreconciled price gap on 2026-07-14");
  });

  it("drops the split symbol from its OWN cohort's constituents too", () => {
    const u = withSplit();
    const row = computeCohorts(u, ["B1"], resolve, gapsOf(u)).rows[0];
    expect(row.windows["1m"].constituents).toBe(5); // six banks, B3 excluded
    expect(row.windows["1w"].constituents).toBe(6);
  });

  it("GUARD: the rotation's exclusion set equals the cohort's exclusion set over one seeded book", () => {
    const u = withSplit();
    // A second split, in a different group, so the set has two members.
    const closes = linear(900, 0);
    for (let i = N - 3; i < N; i++) closes[i] = 300;
    const book = u.map((s) => (s.symbol === "N2" ? series("N2", closes) : s));
    const bars: Bar[] = book.flatMap((s) => s.bars);
    const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
    const daily = computeAtlasDaily(bars, (s) => (REFS[s] ? { sector: REFS[s].sector! } : null), {
      generatedAt: "2026-02-04T04:00:00.000Z",
      sha256,
      classificationOf: resolve,
    });
    const rotationExcluded = daily.payload!.market_pulse.performance.windows["1m"].corporateActionExcluded;
    expect(rotationExcluded).toEqual(["B3", "N2"]);

    // The cohort runs on the ALIGNED universe with the same builder (A5).
    const aligned = alignToAnchor(toSeries(bars), modalAnchor(toSeries(bars))).aligned;
    const cohorts = computeCohorts(aligned, aligned.map((s) => s.symbol), resolve, buildGapMap(aligned));
    expect(cohorts.excludedSymbols).toEqual(rotationExcluded);
  });
});

describe("the verdict is descriptive, never a rating (AQ47)", () => {
  const FORBIDDEN = /\b(buy|sell|money|flow|flows|flowing|risk-on|risk-off|reduce|good pick|bad pick|rating|score|strong buy|outperform|underperform|should|will)\b/i;

  function row(own: number | null, cohort: number | null, level: "industry" | "sector" = "industry"): CohortRow {
    const w = (key: "1w" | "1m") => ({
      key,
      sessions: key === "1w" ? 5 : 21,
      own,
      ownExcluded: null,
      cohort: cohort === null ? null : { value_ppm: cohort, numerator: cohort, denominator: 6, coverage_ppm: 1_000_000 },
      diff: own !== null && cohort !== null ? own - cohort : null,
      constituents: 6,
      members: 6,
      rank: null,
      percentile: null,
    });
    return {
      symbol: "X",
      classification: { sector: "S", industry: "I", source: "taxonomy" },
      level,
      fellUp: false,
      group: "I",
      decidedOn: { window: "1m", priced: 6, members: 6, coveragePpm: 1_000_000 },
      thin: false,
      thinLine: null,
      unpriced: false,
      windows: { "1w": w("1w"), "1m": w("1m") },
      excluded: null,
      verdict: "",
      statistic: "median",
    };
  }

  it("names what the price did against what the cohort did, over the decision window", () => {
    expect(cohortVerdict(row(50_000, -20_000))).toBe("rose while its industry fell over 1m");
    expect(cohortVerdict(row(-50_000, 20_000))).toBe("fell while its industry rose over 1m");
    expect(cohortVerdict(row(80_000, 20_000))).toBe("rose more than its industry over 1m");
    expect(cohortVerdict(row(10_000, 60_000))).toBe("rose less than its industry over 1m");
    expect(cohortVerdict(row(-10_000, -60_000))).toBe("fell less than its industry over 1m");
    expect(cohortVerdict(row(-90_000, -20_000))).toBe("fell more than its industry over 1m");
    expect(cohortVerdict(row(20_000, 18_000, "sector"))).toBe("moved with its sector over 1m");
    expect(cohortVerdict(row(null, 18_000))).toBe("not enough stored sessions for a comparison yet");
  });

  it("never uses a rating word, on any row of a real book", () => {
    const u = universe();
    const all = computeCohorts(u, u.map((s) => s.symbol), resolve, gapsOf(u)).rows;
    expect(all.length).toBe(u.length);
    for (const r of all) {
      expect(r.verdict, `${r.symbol}: "${r.verdict}"`).not.toMatch(FORBIDDEN);
      expect(r.verdict.length).toBeGreaterThan(0);
    }
    for (const v of [row(50_000, -20_000), row(-50_000, 20_000), row(80_000, 20_000), row(null, null)]) {
      expect(cohortVerdict(v)).not.toMatch(FORBIDDEN);
    }
  });
});
