/**
 * A8 / A9 / A12 — the group return (the MEDIAN of the constituents — every
 * member counts once — since atlas-core/2.0.0, owner ruling AQ18; the mean is persisted beside it
 * under its own name), group breadth, classification coverage. The grouping
 * key is whatever the caller's resolution returned for the symbol (user tag >
 * taxonomy > index label); this module never resolves a label itself, it is
 * handed a lookup. `groupByLevel` (levels.ts) is the general form; this file's
 * `groupBySector` delegates to it at level "sector".
 *
 * Every row publishes its CONSTITUENT COUNT and its COVERAGE over the group's
 * members, because "Pharma +3.1%" computed from 2 of 41 constituents is a
 * different claim from the same number over 39 of 41.
 *
 * Current classification only. `sector-map.json` carries ONE clock (`asOf`)
 * and no per-row `effective_at`, so a historical replay of these rows would be
 * survivorship-biased — which is why A11 replays price metrics only.
 */
import { computeBreadth, type BreadthResult } from "./breadth";
import { computeHighLow, type HighLowOptions } from "./high-low";
import { groupByLevel } from "./levels";
import { computeReturns, computeYtd, type CaGap } from "./returns";
import { groupRs, rsiExtremes, type RsResult, type RsiOptions } from "./rs";
import { computeSmaBreadthSet } from "./sma-breadth";
import {
  DEFAULT_STATISTIC,
  GROUP_MIN_COMPUTE,
  GROUP_MIN_RANK,
  meanMetric,
  roundPpm,
  shareMetric,
  type ClassificationLevel,
  type CountMetric,
  type Metric,
  type ReturnWindowKey,
  type SectorRef,
  type Series,
  type Statistic,
} from "./types";
import { computeVolumeExpansion } from "./volume";

export interface GroupMembers {
  group: string;
  members: Series[];
  /** Tier counts (`user` / taxonomy confidence / `index`) for the row's badge. */
  tiers: Record<string, number>;
}

export interface GroupingResult {
  /** Which level (or "cap" for the AMFI band) the groups are keyed on; absent for a legacy caller. */
  level?: ClassificationLevel | "cap";
  groups: GroupMembers[];
  unclassified: string[];
}

/** Group an anchor-aligned universe by resolved sector, ascending by name. Delegates to `groupByLevel`. */
export function groupBySector(series: Series[], sectorOf: (symbol: string) => SectorRef | null): GroupingResult {
  return groupByLevel(series, "sector", (symbol) => {
    const ref = sectorOf(symbol);
    if (!ref || !ref.sector) return null;
    return { macro: null, sector: ref.sector, industry: null, basic: null, tier: ref.tier, source: ref.source };
  });
}

export interface GroupReturnRow {
  group: string;
  window: ReturnWindowKey;
  sessions: number;
  /** The group statistic (median by default, AQ18) of the valid constituent returns. */
  metric: Metric;
  /** Constituents that produced a return. */
  constituents: number;
  /** Members of the group at the anchor. */
  members: number;
  tiers: Record<string, number>;
  corporateActionExcluded: string[];
  insufficient: string[];
}

/** A8 for one window under `statistic`. Coverage is over the group's own membership, not the market. */
export function computeGroupReturns(
  grouping: GroupingResult,
  window: { key: ReturnWindowKey; sessions: number },
  gapsBySymbol: Map<string, CaGap[]> = new Map(),
  statistic: Statistic = DEFAULT_STATISTIC,
): GroupReturnRow[] {
  const rows: GroupReturnRow[] = [];
  for (const g of grouping.groups) {
    const per = computeReturns(g.members, g.members.length, gapsBySymbol, [window], statistic)[window.key];
    rows.push({
      group: g.group,
      window: window.key,
      sessions: window.sessions,
      metric: per.metric,
      constituents: per.metric.denominator,
      members: g.members.length,
      tiers: g.tiers,
      corporateActionExcluded: per.corporateActionExcluded,
      insufficient: per.insufficient,
    });
  }
  return rows;
}

export interface GroupBreadthRow {
  group: string;
  /** A9: advancing / (advancing + declining + unchanged) valid constituents. */
  advancing: Metric;
  breadth: BreadthResult;
  members: number;
  tiers: Record<string, number>;
}

/** A9 per group. */
export function computeGroupBreadth(grouping: GroupingResult): GroupBreadthRow[] {
  return grouping.groups.map((g) => {
    const breadth = computeBreadth(g.members, g.members.length);
    return { group: g.group, advancing: breadth.advancing, breadth, members: g.members.length, tiers: g.tiers };
  });
}

export interface ClassificationCoverage {
  /** A12: classified share of the anchor-aligned universe. */
  classified: Metric;
  groups: number;
  unclassified: string[];
  tiers: Record<string, number>;
}

/** A12 — how much of the universe the bundled map could name, and from where. */
export function classificationCoverage(grouping: GroupingResult, universe: number): ClassificationCoverage {
  const tiers: Record<string, number> = {};
  let classified = 0;
  for (const g of grouping.groups) {
    classified += g.members.length;
    for (const [tier, n] of Object.entries(g.tiers)) tiers[tier] = (tiers[tier] ?? 0) + n;
  }
  return {
    classified: shareMetric(classified, universe, universe),
    groups: grouping.groups.length,
    unclassified: grouping.unclassified,
    tiers,
  };
}

/** The market-wide equal-weighted mean of a set of group values, for a rotation summary. */
export function meanOfGroups(rows: GroupReturnRow[]): Metric {
  const values = rows.map((r) => r.metric.value_ppm).filter((v): v is number => v !== null);
  return meanMetric(values, rows.length);
}

// ---------------------------------------------------------------------------
// v4.6.0 W5 — the breadth family per group / per band (AQ5, AQ8) and the two
// volume shares (AQ9: "turnover share", never the word money).
// ---------------------------------------------------------------------------

export interface VolumeSplitResult {
  /** Σ volume of advancers over Σ volume of advancers + decliners. */
  advancingShare: Metric;
  advancingVolume: number;
  decliningVolume: number;
  /** Symbols with a direction AND a volume on the anchor bar. */
  valid: number;
  /** Symbols with a direction but no volume — stated, never counted as 0. */
  noVolume: string[];
}

/** The volume split adv/dec over an anchor-aligned set (AQ5). Unchanged symbols carry no side. */
export function volumeSplit(series: Series[], coverageBase: number): VolumeSplitResult {
  let adv = 0;
  let dec = 0;
  let valid = 0;
  const noVolume: string[] = [];
  for (const s of series) {
    const n = s.bars.length;
    if (n < 2) continue;
    const last = s.bars[n - 1];
    const move = last.close - s.bars[n - 2].close;
    if (move === 0) continue;
    if (last.volume === null || last.volume === undefined) {
      noVolume.push(s.symbol);
      continue;
    }
    valid++;
    if (move > 0) adv += last.volume;
    else dec += last.volume;
  }
  const total = adv + dec;
  const share: Metric =
    total > 0
      ? {
          value_ppm: roundPpm((adv * 1_000_000) / total),
          numerator: Math.round(adv),
          denominator: Math.round(total),
          coverage_ppm: coverageBase > 0 ? roundPpm((valid * 1_000_000) / coverageBase) : 0,
        }
      : { value_ppm: null, numerator: 0, denominator: 0, coverage_ppm: 0, reason: valid === 0 ? "no_baseline" : "empty_denominator" };
  return { advancingShare: share, advancingVolume: adv, decliningVolume: dec, valid, noVolume: noVolume.sort() };
}

/** Σ close × volume on the anchor bar; symbols without a volume are counted, not zeroed. */
export function turnoverOf(series: Series[]): { rupees: number; withVolume: number; noVolume: number } {
  let rupees = 0;
  let withVolume = 0;
  let noVolume = 0;
  for (const s of series) {
    const last = s.bars[s.bars.length - 1];
    if (!last || last.volume === null || last.volume === undefined) {
      noVolume++;
      continue;
    }
    withVolume++;
    rupees += last.close * last.volume;
  }
  return { rupees, withVolume, noVolume };
}

/**
 * "Turnover share": the group's Σ(close × volume) over the universe's, on the
 * anchor bar. The numerator and denominator are RUPEES rounded to the rupee,
 * the coverage is the share of the group's members that carried a volume.
 */
export function turnoverShare(members: Series[], universeTurnoverRupees: number): Metric {
  const t = turnoverOf(members);
  if (!(universeTurnoverRupees > 0) || t.withVolume === 0) {
    return { value_ppm: null, numerator: 0, denominator: 0, coverage_ppm: 0, reason: t.withVolume === 0 ? "no_baseline" : "empty_denominator" };
  }
  return {
    value_ppm: roundPpm((t.rupees * 1_000_000) / universeTurnoverRupees),
    numerator: Math.round(t.rupees),
    denominator: Math.round(universeTurnoverRupees),
    coverage_ppm: members.length > 0 ? roundPpm((t.withVolume * 1_000_000) / members.length) : 0,
  };
}

export interface GroupTableContext {
  gapsBySymbol: Map<string, CaGap[]>;
  windows: { key: ReturnWindowKey; sessions: number }[];
  /** The anchor's calendar year for YTD, or null when there is no anchor. */
  year: number | null;
  smaPeriods: readonly number[];
  highLow?: HighLowOptions;
  volumeBaseline: number;
  rsi?: RsiOptions;
  rs: RsResult;
  /** Σ close × volume over the aligned universe, for the turnover share. */
  universeTurnoverRupees: number;
  statistic: Statistic;
  minCompute?: number;
  minRank?: number;
}

export interface GroupTableRow {
  group: string;
  members: number;
  /** Constituents with a return on the 1m window (or the last window configured) — "n of m priced". */
  priced: number;
  tiers: Record<string, number>;
  /** True at `GROUP_MIN_COMPUTE` members; below it every figure is null with `insufficient_members`. */
  computable: boolean;
  /** True at `GROUP_MIN_RANK` priced constituents — the leaderboard floor (AQ26). */
  rankable: boolean;
  /** Per window: the MEDIAN and the MEAN, both persisted so the toggle is a read (AQ18). */
  returns: Record<string, { median: Metric; mean: Metric; constituents: number; corporateActionExcluded: string[]; insufficient: string[] }>;
  ytd: { median: Metric; mean: Metric; insufficient: string[]; corporateActionExcluded: string[] };
  /** Median of member rs (rs.ts); reason `insufficient_members` under 3 eligible. */
  rs: Metric;
  rsEligible: number;
  breadth: BreadthResult;
  aboveSma: Record<number, Metric>;
  /** Share metrics: `numerator` is the count of highs / lows, `denominator` the constituents with a window. */
  newHighs: Metric;
  newLows: Metric;
  netHighLow: CountMetric;
  /** Constituents at a new high over the priced constituents ("industries at 52-week high" column, AQ6). */
  atHighShare: Metric;
  highLowLabel: string;
  rsiLow: CountMetric;
  rsiHigh: CountMetric;
  rsiThresholds: { period: number; low: number; high: number };
  volumeExpansion: Metric;
  volumeAdvancingShare: Metric;
  turnoverShare: Metric;
}

const nullMetric = (reason: Metric["reason"]): Metric => ({ value_ppm: null, numerator: 0, denominator: 0, coverage_ppm: 0, reason });
const nullCount = (reason: CountMetric["reason"]): CountMetric => ({ value: null, denominator: 0, coverage_ppm: 0, reason });

/**
 * The whole breadth family for every group of a grouping (AQ5 per group, AQ8
 * per band). One function so the sector table, the industry table and the
 * cap-band ladder are the same arithmetic and cannot disagree with each other
 * or with the universe tiles.
 */
export function computeGroupTable(grouping: GroupingResult, ctx: GroupTableContext): GroupTableRow[] {
  const minCompute = ctx.minCompute ?? GROUP_MIN_COMPUTE;
  const minRank = ctx.minRank ?? GROUP_MIN_RANK;
  const pricedWindow = ctx.windows.find((w) => w.key === "1m") ?? ctx.windows[ctx.windows.length - 1];
  const rows: GroupTableRow[] = [];
  for (const g of grouping.groups) {
    const m = g.members;
    const n = m.length;
    const computable = n >= minCompute;

    const returns: GroupTableRow["returns"] = {};
    let priced = 0;
    for (const w of ctx.windows) {
      if (!computable) {
        returns[w.key] = { median: nullMetric("insufficient_members"), mean: nullMetric("insufficient_members"), constituents: 0, corporateActionExcluded: [], insufficient: [] };
        continue;
      }
      // Both statistics over the SAME constituent set: the exclusions and the
      // insufficient list do not depend on the statistic, so they are read once.
      const med = computeReturns(m, n, ctx.gapsBySymbol, [w], "median")[w.key];
      const mean = computeReturns(m, n, ctx.gapsBySymbol, [w], "mean")[w.key];
      returns[w.key] = {
        median: med.metric,
        mean: mean.metric,
        constituents: med.metric.denominator,
        corporateActionExcluded: med.corporateActionExcluded,
        insufficient: med.insufficient,
      };
      if (pricedWindow && w.key === pricedWindow.key) priced = med.metric.denominator;
    }

    const ytdStat = computable && ctx.year !== null ? computeYtd(m, ctx.year, n, ctx.gapsBySymbol, "median") : null;
    const ytdMean = computable && ctx.year !== null ? computeYtd(m, ctx.year, n, ctx.gapsBySymbol, "mean") : null;

    const breadth = computable ? computeBreadth(m, n) : null;
    const sma = computable ? computeSmaBreadthSet(m, ctx.smaPeriods, n) : null;
    const hl = computable ? computeHighLow(m, n, ctx.highLow) : null;
    const rsi = computable ? rsiExtremes(m, n, ctx.rsi) : null;
    const vol = computable ? computeVolumeExpansion(m, n, ctx.volumeBaseline) : null;
    const split = computable ? volumeSplit(m, n) : null;

    const aboveSma: Record<number, Metric> = {};
    for (const p of ctx.smaPeriods) aboveSma[p] = sma ? sma[p].metric : nullMetric("insufficient_members");

    let rsEligible = 0;
    for (const s of m) if (ctx.rs.bySymbol.get(s.symbol)?.eligible) rsEligible++;

    rows.push({
      group: g.group,
      members: n,
      priced,
      tiers: g.tiers,
      computable,
      rankable: computable && priced >= minRank,
      returns,
      ytd: {
        median: ytdStat ? ytdStat.metric : nullMetric(computable ? "no_anchor" : "insufficient_members"),
        mean: ytdMean ? ytdMean.metric : nullMetric(computable ? "no_anchor" : "insufficient_members"),
        insufficient: ytdStat?.insufficient ?? [],
        corporateActionExcluded: ytdStat?.corporateActionExcluded ?? [],
      },
      rs: computable ? groupRs(m, ctx.rs, minCompute) : nullMetric("insufficient_members"),
      rsEligible,
      breadth: breadth ?? computeBreadth([], 0),
      aboveSma,
      newHighs: hl ? hl.newHighs : nullMetric("insufficient_members"),
      newLows: hl ? hl.newLows : nullMetric("insufficient_members"),
      netHighLow: hl ? hl.netHighLow : nullCount("insufficient_members"),
      atHighShare: hl ? shareMetric(hl.counts.highs, hl.counts.valid, n, hl.counts.valid === 0 ? "insufficient_history" : undefined) : nullMetric("insufficient_members"),
      highLowLabel: hl ? hl.label : "",
      rsiLow: rsi ? rsi.low : nullCount("insufficient_members"),
      rsiHigh: rsi ? rsi.high : nullCount("insufficient_members"),
      rsiThresholds: rsi ? rsi.thresholds : rsiExtremes([], 0, ctx.rsi).thresholds,
      volumeExpansion: vol ? vol.medianExpansion : nullMetric("insufficient_members"),
      volumeAdvancingShare: split ? split.advancingShare : nullMetric("insufficient_members"),
      turnoverShare: computable ? turnoverShare(m, ctx.universeTurnoverRupees) : nullMetric("insufficient_members"),
    });
  }
  return rows;
}
