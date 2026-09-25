/**
 * The cohort view — "stock pick, or sector ride?" per open equity position
 * (v4.6.0 W5: Q51 #3–#7, owner rulings AQ21 / AQ26 / AQ47, design review A4/A5).
 *
 * The cohort node is the symbol's INDUSTRY, falling UP to its SECTOR when the
 * industry cohort is too thin: fewer than `COHORT_MIN_PRICED` priced
 * constituents OR under `COHORT_MIN_COVERAGE_PPM` of its membership priced.
 * The level is chosen ONCE per symbol, on the 1m window (the stricter of the
 * two), and BOTH windows use it — one row must never compare against two
 * cohorts (A4). The row states the level and the count it was decided on.
 *
 * Every window figure goes through `gapsBySymbol`: a split inside the window
 * leaves the symbol's own return "—" with "excluded: unreconciled price gap on
 * <date>", and the cohort's own constituents are filtered by the same map
 * through `computeReturns`, so the rotation table and this row exclude the
 * same set (the guard test pins it).
 *
 * The verdict is DESCRIPTIVE — "rose while its industry fell" — never a
 * rating, never a verb about the future (AQ47). The forbidden words are
 * pinned in tests/atlas-cohort.test.ts.
 *
 * PURE: no DB, no React, no clock. Runs on the ALIGNED universe, never raw series.
 */
import { cohortLevelsFor, groupByLevel, type ClassificationRef } from "./levels";
import type { GroupMembers } from "./groups";
import { computeReturns, gapInWindow, symbolReturnPpm, type CaGap } from "./returns";
import {
  COHORT_MIN_COVERAGE_PPM,
  COHORT_MIN_PRICED,
  DEFAULT_STATISTIC,
  roundPpm,
  type Metric,
  type ReturnWindowKey,
  type Series,
  type Statistic,
} from "./types";

export type CohortWindowKey = Extract<ReturnWindowKey, "1w" | "1m">;
export type CohortLevel = "industry" | "sector";

export const COHORT_WINDOWS: { key: CohortWindowKey; sessions: number }[] = [
  { key: "1w", sessions: 5 },
  { key: "1m", sessions: 21 },
];

/** The window on which the level is decided (A4: the stricter of the two). */
export const COHORT_DECISION_WINDOW: CohortWindowKey = "1m";

/** |diff| under this is "moved with": half a percent. A PROPOSAL, not a measurement. */
export const COHORT_FLAT_PPM = 5_000;

export interface CohortWindow {
  key: CohortWindowKey;
  sessions: number;
  /** The symbol's own return, ppm; null without depth or when excluded. */
  own: number | null;
  /** The gap that excluded the symbol's own return, when one did. */
  ownExcluded: CaGap | null;
  /** The cohort's return under `statistic`; null when the cohort is too thin (see `thin`). */
  cohort: Metric | null;
  /** `own − cohort`, ppm; null whenever either side is null. */
  diff: number | null;
  /** Constituents that produced a return ("14 of 17 priced"). */
  constituents: number;
  members: number;
  /** Rank of the symbol among the priced constituents, 1 = best; null when it is not priced. */
  rank: { position: number; of: number } | null;
  /** Share of priced constituents the symbol beat, whole percent; null under two priced. */
  percentile: number | null;
}

export interface CohortRow {
  symbol: string;
  classification: { sector: string | null; industry: string | null; source: string | null };
  /** The level the row USED, or null when the symbol has no classification. */
  level: CohortLevel | null;
  /** True when industry existed but was too thin and the row fell up to sector. */
  fellUp: boolean;
  group: string | null;
  /** The count the level was decided on — printed on the row (A4). */
  decidedOn: { window: CohortWindowKey; priced: number; members: number; coveragePpm: number } | null;
  /** True when NO level met the width floor; every `cohort` is null and `thinLine` says why. */
  thin: boolean;
  thinLine: string | null;
  /** True when the symbol has no bars on the anchor at all. */
  unpriced: boolean;
  windows: Record<CohortWindowKey, CohortWindow>;
  /** The first gap that excluded a window, for the row's exclusion sentence. */
  excluded: CaGap | null;
  verdict: string;
  statistic: Statistic;
}

export interface CohortOptions {
  statistic?: Statistic;
  minPriced?: number;
  minCoveragePpm?: number;
  windows?: { key: CohortWindowKey; sessions: number }[];
}

export interface CohortResult {
  rows: CohortRow[];
  /** Held symbols whose own return was excluded by the guard in ANY window. */
  excludedSymbols: string[];
  floors: { minPriced: number; minCoveragePpm: number };
  statistic: Statistic;
}

interface LevelGroups {
  industry: Map<string, GroupMembers>;
  sector: Map<string, GroupMembers>;
}

function indexGroups(aligned: Series[], resolve: (symbol: string) => ClassificationRef | null): LevelGroups {
  const toMap = (level: CohortLevel) => {
    const m = new Map<string, GroupMembers>();
    for (const g of groupByLevel(aligned, level, resolve).groups) m.set(g.group, g);
    return m;
  };
  return { industry: toMap("industry"), sector: toMap("sector") };
}

function windowFor(
  key: CohortWindowKey,
  sessions: number,
  own: Series | undefined,
  members: Series[] | null,
  gapsBySymbol: Map<string, CaGap[]>,
  statistic: Statistic,
  thin: boolean,
): CohortWindow {
  let ownPpm: number | null = null;
  let ownExcluded: CaGap | null = null;
  if (own) {
    const gaps = gapsBySymbol.get(own.symbol) ?? [];
    if (gapInWindow(own, sessions, gaps)) {
      const n = own.bars.length;
      const from = own.bars[n - 1 - sessions].date;
      ownExcluded = gaps.find((g) => g.date > from) ?? gaps[gaps.length - 1];
    } else {
      ownPpm = symbolReturnPpm(own, sessions);
    }
  }

  if (!members) {
    return { key, sessions, own: ownPpm, ownExcluded, cohort: null, diff: null, constituents: 0, members: 0, rank: null, percentile: null };
  }

  const per = computeReturns(members, members.length, gapsBySymbol, [{ key, sessions }], statistic)[key];
  const priced: { symbol: string; ppm: number }[] = [];
  for (const m of members) {
    if (per.corporateActionExcluded.includes(m.symbol)) continue;
    const r = symbolReturnPpm(m, sessions);
    if (r !== null) priced.push({ symbol: m.symbol, ppm: r });
  }
  priced.sort((a, b) => b.ppm - a.ppm || (a.symbol < b.symbol ? -1 : 1));
  const position = own ? priced.findIndex((p) => p.symbol === own.symbol) : -1;
  const rank = position >= 0 ? { position: position + 1, of: priced.length } : null;
  const percentile =
    rank && rank.of > 1 ? roundPpm(((rank.of - rank.position) / (rank.of - 1)) * 100) : null;

  const cohort = thin ? null : per.metric;
  return {
    key,
    sessions,
    own: ownPpm,
    ownExcluded,
    cohort,
    diff: ownPpm !== null && cohort && cohort.value_ppm !== null ? ownPpm - cohort.value_ppm : null,
    constituents: per.metric.denominator,
    members: members.length,
    rank,
    percentile,
  };
}

/** "cohort too thin to compare (3 of 41 priced)" — the AQ26 sentence, one place. */
export function thinCohortLine(priced: number, members: number): string {
  return `cohort too thin to compare (${priced} of ${members} priced)`;
}

/** "excluded: unreconciled price gap on 2026-07-14" — the Q51 #6 sentence, one place. */
export function excludedLine(gap: CaGap): string {
  return `excluded: unreconciled price gap on ${gap.date}`;
}

/**
 * Cohort rows for the held symbols. `aligned` is the anchor-aligned universe
 * (A5), `resolve` the levels-aware classification, `gapsBySymbol` the ONE gap
 * map every other consumer uses.
 */
export function computeCohorts(
  aligned: Series[],
  held: string[],
  resolve: (symbol: string) => ClassificationRef | null,
  gapsBySymbol: Map<string, CaGap[]>,
  opts: CohortOptions = {},
): CohortResult {
  const statistic = opts.statistic ?? DEFAULT_STATISTIC;
  const minPriced = opts.minPriced ?? COHORT_MIN_PRICED;
  const minCoveragePpm = opts.minCoveragePpm ?? COHORT_MIN_COVERAGE_PPM;
  const windows = opts.windows ?? COHORT_WINDOWS;
  const decision = windows.find((w) => w.key === COHORT_DECISION_WINDOW) ?? windows[windows.length - 1];

  const bySymbol = new Map(aligned.map((s) => [s.symbol, s]));
  const groups = indexGroups(aligned, resolve);
  const rows: CohortRow[] = [];
  const excludedSymbols = new Set<string>();

  for (const raw of [...new Set(held.map((h) => h.toUpperCase()))].sort()) {
    const own = bySymbol.get(raw);
    const ref = resolve(raw);
    const classification = {
      sector: ref?.sector ?? null,
      industry: ref?.industry ?? null,
      source: ref?.source ?? null,
    };

    // Decide the level ONCE, on the decision window (A4).
    let level: CohortLevel | null = null;
    let members: Series[] | null = null;
    let decidedOn: CohortRow["decidedOn"] = null;
    let thin = false;
    let fellUp = false;
    const candidates = cohortLevelsFor(ref);
    const measure = (cand: CohortLevel) => {
      const label = (cand === "industry" ? ref?.industry : ref?.sector) ?? "";
      const candMembers = groups[cand].get(label)?.members ?? [];
      const per = computeReturns(candMembers, candMembers.length, gapsBySymbol, [decision], statistic)[decision.key];
      const priced = per.metric.denominator;
      const coveragePpm = candMembers.length > 0 ? roundPpm((priced * 1_000_000) / candMembers.length) : 0;
      return { members: candMembers, decidedOn: { window: decision.key, priced, members: candMembers.length, coveragePpm } };
    };
    for (const cand of candidates) {
      const m = measure(cand);
      if (m.decidedOn.priced >= minPriced && m.decidedOn.coveragePpm >= minCoveragePpm) {
        level = cand;
        members = m.members;
        decidedOn = m.decidedOn;
        fellUp = cand === "sector" && candidates[0] === "industry";
        break;
      }
    }
    if (level === null && candidates.length > 0) {
      // Nothing met the floor: the row keeps the DEEPEST level it tried so the
      // sentence can name the count, and every cohort figure stays null.
      thin = true;
      level = candidates[0];
      const m = measure(level);
      members = m.members;
      decidedOn = m.decidedOn;
    }
    const group = level ? (level === "industry" ? ref!.industry : ref!.sector) : null;

    const out = {} as Record<CohortWindowKey, CohortWindow>;
    let excluded: CaGap | null = null;
    for (const w of windows) {
      const cw = windowFor(w.key, w.sessions, own, members, gapsBySymbol, statistic, thin);
      out[w.key] = cw;
      if (cw.ownExcluded && !excluded) excluded = cw.ownExcluded;
    }
    if (excluded) excludedSymbols.add(raw);

    const row: CohortRow = {
      symbol: raw,
      classification,
      level,
      fellUp,
      group,
      decidedOn,
      thin,
      thinLine: thin && decidedOn ? thinCohortLine(decidedOn.priced, decidedOn.members) : null,
      unpriced: !own,
      windows: out,
      excluded,
      verdict: "",
      statistic,
    };
    row.verdict = cohortVerdict(row);
    rows.push(row);
  }

  return { rows, excludedSymbols: [...excludedSymbols].sort(), floors: { minPriced, minCoveragePpm }, statistic };
}

/**
 * The plain-words verdict. Descriptive only: what the price did against what
 * its cohort did over the decision window (1m), falling back to 1w when 1m has
 * no figure. Never a rating, never a recommendation (AQ47).
 */
export function cohortVerdict(row: CohortRow): string {
  if (row.unpriced) return "no stored bars for this symbol on the anchor session";
  if (row.excluded) return excludedLine(row.excluded);
  if (!row.level) return "no classification for this symbol — nothing to compare against";
  if (row.thin && row.thinLine) return row.thinLine;
  const pick = row.windows[COHORT_DECISION_WINDOW]?.own !== null && row.windows[COHORT_DECISION_WINDOW]?.cohort?.value_ppm != null
    ? row.windows[COHORT_DECISION_WINDOW]
    : Object.values(row.windows).find((w) => w.own !== null && w.cohort?.value_ppm != null);
  if (!pick || pick.own === null || !pick.cohort || pick.cohort.value_ppm === null) {
    return "not enough stored sessions for a comparison yet";
  }
  const own = pick.own;
  const cohort = pick.cohort.value_ppm;
  const diff = own - cohort;
  const noun = row.level;
  const window = pick.key;
  if (Math.abs(diff) < COHORT_FLAT_PPM) return `moved with its ${noun} over ${window}`;
  if (own > 0 && cohort < 0) return `rose while its ${noun} fell over ${window}`;
  if (own < 0 && cohort > 0) return `fell while its ${noun} rose over ${window}`;
  if (own >= 0 && cohort >= 0) return diff > 0 ? `rose more than its ${noun} over ${window}` : `rose less than its ${noun} over ${window}`;
  return diff > 0 ? `fell less than its ${noun} over ${window}` : `fell more than its ${noun} over ${window}`;
}
