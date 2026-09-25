/**
 * computeAtlasDaily — one session of market context, from stored bars only.
 *
 * PURE (AGENTS.md invariant 2). No DB, no React, no `node:*`, no `fetch`, no
 * `Date.now()`. The clock (`generatedAt`), the hash (`sha256`) and the sector
 * lookup (`sectorOf`) are passed in, so the same bars always produce the same
 * bytes and a golden test can assert it.
 *
 * Row shaping follows `drizzle/0065_atlas-daily.sql` (owned by W0) exactly:
 * ratios are ppm INTEGERS in `value_ppm`, and a COUNT metric puts its count in
 * `numerator` and leaves `value_ppm` NULL rather than dressing a count up as a
 * ratio. `denominator` 0 means the figure itself is NULL, never 0.
 *
 * Nothing here computes a proprietary score, and nothing here needs a network
 * host: it reads the bhavcopy bars the user already imported.
 */
import { alignToAnchor, modalAnchor, sessionCalendar, truncateTo, type AnchorAlignment } from "./anchor";
import { computeBreadth, type BreadthResult } from "./breadth";
import {
  classificationCoverage,
  computeGroupBreadth,
  computeGroupReturns,
  computeGroupTable,
  groupBySector,
  turnoverOf,
  volumeSplit,
  type ClassificationCoverage,
  type GroupBreadthRow,
  type GroupReturnRow,
  type GroupTableRow,
  type GroupingResult,
  type VolumeSplitResult,
} from "./groups";
import { computeHighLow, type HighLowOptions, type HighLowResult } from "./high-low";
import { buildLedger, shortfallLine, type HistoryShortfall, type MetricDenominator, type StalenessLedger } from "./ledger";
import { groupByLabel, groupByLevel, type ClassificationRef } from "./levels";
import { classifyRegime, DEFAULT_REGIME_THRESHOLDS, type RegimeResult, type RegimeThresholds } from "./regime";
import { buildGapMap, computeReturns, computeYtd, type CaGap, type ReturnWindowResult, type YtdResult } from "./returns";
import { computeRelativeStrength, rsiExtremes, type RsResult, type RsiExtremesResult } from "./rs";
import { computeSmaBreadthSet, type SmaBreadthResult } from "./sma-breadth";
import { computeVolumeExpansion, type VolumeResult } from "./volume";
import {
  CA_GAP_THRESHOLD_PPM,
  COVERAGE_FLOOR_PPM,
  DEFAULT_STATISTIC,
  HISTORY_SESSIONS,
  RETURN_WINDOWS,
  ROTATION_WINDOW,
  SMA_PERIODS,
  SPEC_VERSION,
  VOLUME_BASELINE,
  toSeries,
  type Bar,
  type ExclusionReason,
  type IsoDate,
  type CountMetric,
  type Metric,
  type ReturnWindowKey,
  type SectorRef,
  type Series,
  type Statistic,
} from "./types";

export const ROTATION_CAVEAT = "Current classification, not point-in-time.";

export interface AtlasOptions {
  /** The caller's clock. Pure modules never read one. */
  generatedAt: string;
  /** Injected hash — `node:crypto` may not be imported here (invariant 2). */
  sha256: (input: string) => string;
  sourceMode?: "bhavcopy_local" | "imported_file";
  specVersion?: string;
  /** Caller-supplied eligibility (ETFs, index rows, non-equity series). */
  isEligible?: (symbol: string) => boolean;
  regimeThresholds?: RegimeThresholds;
  /** AQ44 / A9: below this coverage an input may not vote. Defaults to `COVERAGE_FLOOR_PPM`. */
  coverageFloorPpm?: number;
  historySessions?: number;
  caThresholdPpm?: number;
  highLow?: HighLowOptions;
  volumeBaseline?: number;
  smaPeriods?: readonly number[];
  returnWindows?: { key: ReturnWindowKey; sessions: number }[];
  rotationWindow?: { key: ReturnWindowKey; sessions: number };
  /**
   * v4.6.0 W5 — the levels-aware classification (macro / sector / industry /
   * basic). When absent, `sectorOf` is lifted to a sector-only ref, so a legacy
   * caller still gets the sector table and an empty industry table.
   */
  classificationOf?: (symbol: string) => ClassificationRef | null;
  /** AMFI's cap band per symbol (ruling U2), or null when unbanded. Absent ⇒ no cap table. */
  capBandOf?: (symbol: string) => string | null;
  /** The group statistic (AQ18). Median by default; the mean is persisted beside it either way. */
  statistic?: Statistic;
}

export interface AtlasHistoryEntry {
  as_of: IsoDate;
  advancing: number;
  declining: number;
  unchanged: number;
  advance_pct_ppm: number | null;
  above_sma_ppm: Record<number, number | null>;
  new_highs: number;
  new_lows: number;
  net_high_low: number | null;
  volume_expansion_median_ppm: number | null;
  returns_ppm: Record<string, number | null>;
}

export interface AtlasPayload {
  spec_version: string;
  as_of: IsoDate | null;
  generated_at: string;
  source_mode: string;
  input_checksum: string;
  universe: {
    submitted: number;
    included: number;
    excluded: number;
    exclusion_counts: Partial<Record<ExclusionReason, number>>;
    anchor: IsoDate | null;
    anchor_policy: string;
    anchor_coverage: number;
    anchor_coverage_ppm: number;
    truncated: number;
  };
  classification: ClassificationCoverage;
  market_pulse: {
    breadth: BreadthResult;
    moving_average_breadth: Record<number, SmaBreadthResult>;
    new_high_low: HighLowResult;
    performance: { windows: Record<ReturnWindowKey, ReturnWindowResult>; ytd: YtdResult };
    volume: VolumeResult;
  };
  regime: RegimeResult;
  rotation: {
    window: { key: ReturnWindowKey; sessions: number };
    caveat: string;
    sectors: GroupReturnRow[];
    breadth: GroupBreadthRow[];
  };
  /**
   * v4.6.0 W5 (atlas-core/2.0.0). The whole breadth family per SECTOR, per
   * INDUSTRY and per AMFI CAP BAND (AQ5/AQ6/AQ8), plus the universe-level
   * additions: relative strength (AQ9), RSI extremes and the volume split
   * (AQ5). `statistic` names which group statistic `groups.*.returns[w].statistic`
   * carries; the mean sits beside it under `.mean` (AQ18).
   */
  statistic: Statistic;
  groups: {
    sector: GroupTableRow[];
    industry: GroupTableRow[];
    cap: GroupTableRow[];
    /** Symbols with no label at each level — stated, never bucketed. */
    unclassified: { sector: number; industry: number; cap: number };
  };
  relative_strength: {
    eligible: number;
    priced: number;
    medians: Record<string, number | null>;
    windows: readonly number[];
    weights: readonly number[];
    floors: RsResult["floors"];
    ineligible: RsResult["ineligible"];
  };
  rsi: Omit<RsiExtremesResult, "bySymbol">;
  volume_split: VolumeSplitResult;
  history: AtlasHistoryEntry[];
  ledger: StalenessLedger;
  warnings: string[];
}

export interface AtlasDailyRow {
  as_of: IsoDate;
  generated_at: string;
  spec_version: string;
  source_mode: string;
  input_checksum: string;
  universe_included: number;
  universe_excluded: number;
  anchor_coverage: number;
  anchor_coverage_ppm: number;
  payload_json: string;
}

export interface AtlasMetricRow {
  as_of: IsoDate;
  metric: string;
  /** `cap` = AMFI's band (v4.6.0 W5); the column is free text, no schema change (lib/db/schema.ts). */
  group_kind: "market" | "sector" | "industry" | "index" | "cap";
  group_name: string;
  /** NULL for a count metric, and NULL whenever the denominator is empty. */
  value_ppm: number | null;
  numerator: number | null;
  denominator: number | null;
  coverage_ppm: number | null;
  insufficient_history: number;
}

export interface AtlasStalenessRow {
  as_of: IsoDate;
  symbol: string;
  reason: ExclusionReason;
  last_seen_date: string | null;
  sessions_behind: number;
}

export interface AtlasDailyResult {
  /** `null` when there is not one usable bar — an empty screen, not a zeroed one. */
  daily: AtlasDailyRow | null;
  metrics: AtlasMetricRow[];
  staleness: AtlasStalenessRow[];
  ledger: StalenessLedger;
  payload: AtlasPayload | null;
  alignment: AnchorAlignment;
}

/** The canonical input string: sorted `(symbol,date,close,volume)`, one row per line. */
export function checksumInput(bars: Bar[]): string {
  const lines: string[] = [];
  for (const s of toSeries(bars)) {
    for (const b of s.bars) {
      lines.push(`${s.symbol},${b.date},${b.close},${b.volume ?? ""}`);
    }
  }
  lines.sort();
  return lines.join("\n");
}

/** A ratio row: `value_ppm` carries the figure, `numerator` its own arithmetic. */
function ratioRow(
  as_of: IsoDate,
  metric: string,
  m: Metric,
  insufficient: number,
  group_kind: AtlasMetricRow["group_kind"] = "market",
  group_name = "*",
): AtlasMetricRow {
  const empty = m.denominator <= 0;
  return {
    as_of,
    metric,
    group_kind,
    group_name,
    value_ppm: m.value_ppm,
    numerator: empty ? null : m.numerator,
    denominator: empty ? null : m.denominator,
    coverage_ppm: empty ? null : m.coverage_ppm,
    insufficient_history: insufficient,
  };
}

/** A count row: `value_ppm` stays NULL — a count is not a ratio (0065 header). */
function countRow(
  as_of: IsoDate,
  metric: string,
  m: CountMetric,
  insufficient: number,
  group_kind: AtlasMetricRow["group_kind"] = "market",
  group_name = "*",
): AtlasMetricRow {
  const empty = m.denominator <= 0 || m.value === null;
  return {
    as_of,
    metric,
    group_kind,
    group_name,
    value_ppm: null,
    numerator: empty ? null : m.value,
    denominator: empty ? null : m.denominator,
    coverage_ppm: empty ? null : m.coverage_ppm,
    insufficient_history: insufficient,
  };
}

/** A count published beside the share it came from, so it keeps that denominator. */
function asCount(count: number, from: Metric): CountMetric {
  if (from.denominator <= 0) return { value: null, denominator: 0, coverage_ppm: 0, reason: from.reason };
  return { value: count, denominator: from.denominator, coverage_ppm: from.coverage_ppm };
}

/** One session of Atlas context. See the module header for the purity contract. */
export function computeAtlasDaily(
  bars: Bar[],
  sectorOf: (symbol: string) => SectorRef | null,
  opts: AtlasOptions,
): AtlasDailyResult {
  const specVersion = opts.specVersion ?? SPEC_VERSION;
  const sourceMode = opts.sourceMode ?? "bhavcopy_local";
  const smaPeriods = opts.smaPeriods ?? SMA_PERIODS;
  const windows = opts.returnWindows ?? RETURN_WINDOWS;
  const rotationWindow = opts.rotationWindow ?? ROTATION_WINDOW;
  const volumeBaseline = opts.volumeBaseline ?? VOLUME_BASELINE;
  const historySessions = opts.historySessions ?? HISTORY_SESSIONS;
  const caThreshold = opts.caThresholdPpm ?? CA_GAP_THRESHOLD_PPM;
  const statistic = opts.statistic ?? DEFAULT_STATISTIC;
  const coverageFloorPpm = opts.coverageFloorPpm ?? COVERAGE_FLOOR_PPM;
  const classificationOf: (symbol: string) => ClassificationRef | null =
    opts.classificationOf ??
    ((symbol) => {
      const ref = sectorOf(symbol);
      return ref && ref.sector ? { macro: null, sector: ref.sector, industry: null, basic: null, tier: ref.tier, source: ref.source } : null;
    });
  const input_checksum = opts.sha256(checksumInput(bars));

  const all = toSeries(bars);
  const eligible: Series[] = [];
  const nonEquity: string[] = [];
  for (const s of all) {
    if (opts.isEligible && !opts.isEligible(s.symbol)) nonEquity.push(s.symbol);
    else eligible.push(s);
  }

  const anchor = modalAnchor(eligible);
  const alignment = alignToAnchor(eligible, anchor);
  const aligned = alignment.aligned;
  const included = aligned.length;

  // Corporate-action guard — ONE map for every consumer (design review A5).
  // The market baseline inside `buildGapMap` is the universe's own median move
  // that session, so a limit-down day for everything is not read as a split
  // for every symbol.
  const gapsBySymbol: Map<string, CaGap[]> = buildGapMap(aligned, caThreshold);
  const caEntries: { symbol: string; date: IsoDate; ratioPpm: number }[] = [];
  for (const [symbol, gaps] of gapsBySymbol) {
    const worst = gaps.reduce((a, b) => (Math.abs(b.ratioPpm) > Math.abs(a.ratioPpm) ? b : a));
    caEntries.push({ symbol, date: worst.date, ratioPpm: worst.ratioPpm });
  }
  caEntries.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  const breadth = computeBreadth(aligned, included);
  const sma = computeSmaBreadthSet(aligned, smaPeriods, included);
  const highLow = computeHighLow(aligned, included, opts.highLow);
  const returns = computeReturns(aligned, included, gapsBySymbol, windows, statistic);
  const year = anchor ? Number(anchor.slice(0, 4)) : NaN;
  const ytd = Number.isFinite(year)
    ? computeYtd(aligned, year, included, gapsBySymbol, statistic)
    : computeYtd([], 0, included, gapsBySymbol, statistic);
  const volume = computeVolumeExpansion(aligned, included, volumeBaseline);

  // v4.6.0 W5 — the universe-level additions.
  const rs = computeRelativeStrength(aligned, {}, gapsBySymbol);
  const rsi = rsiExtremes(aligned, included);
  const split = volumeSplit(aligned, included);
  const universeTurnover = turnoverOf(aligned);

  const grouping = groupBySector(aligned, sectorOf);
  const rotation = computeGroupReturns(grouping, rotationWindow, gapsBySymbol, statistic);
  const groupBreadth = computeGroupBreadth(grouping);
  const classification = classificationCoverage(grouping, included);

  // The three group tables (AQ5/AQ6/AQ8), one arithmetic (`computeGroupTable`).
  const tableCtx = {
    gapsBySymbol,
    windows,
    year: Number.isFinite(year) ? year : null,
    smaPeriods,
    highLow: opts.highLow,
    volumeBaseline,
    rs,
    universeTurnoverRupees: universeTurnover.rupees,
    statistic,
  };
  const sectorGrouping: GroupingResult = groupByLevel(aligned, "sector", classificationOf);
  const industryGrouping: GroupingResult = groupByLevel(aligned, "industry", classificationOf);
  const capGrouping: GroupingResult = opts.capBandOf
    ? groupByLabel(aligned, opts.capBandOf, "cap")
    : { level: "cap", groups: [], unclassified: aligned.map((s) => s.symbol) };
  const groupTables = {
    sector: computeGroupTable(sectorGrouping, tableCtx),
    industry: computeGroupTable(industryGrouping, tableCtx),
    cap: computeGroupTable(capGrouping, tableCtx),
    unclassified: {
      sector: sectorGrouping.unclassified.length,
      industry: industryGrouping.unclassified.length,
      cap: capGrouping.unclassified.length,
    },
  };

  const regime = classifyRegime(
    { aboveSma50: sma[50]?.metric ?? null, netHighLow: highLow.netHighLow },
    opts.regimeThresholds ?? DEFAULT_REGIME_THRESHOLDS,
    coverageFloorPpm,
  );

  const history = computeHistory(aligned, {
    sessions: historySessions,
    smaPeriods,
    windows,
    volumeBaseline,
    highLow: opts.highLow,
    gapsBySymbol,
  });

  // ---- ledger -------------------------------------------------------------
  const denominators: MetricDenominator[] = [
    { metric: "advance_pct_ppm", denominator: breadth.counts.valid, coverage_ppm: breadth.advancing.coverage_ppm, insufficient_history: breadth.insufficient.length },
    { metric: "new_high_pct_ppm", denominator: highLow.newHighs.denominator, coverage_ppm: highLow.newHighs.coverage_ppm, insufficient_history: highLow.insufficient.length },
    { metric: "volume_expansion_median_ppm", denominator: volume.medianExpansion.denominator, coverage_ppm: volume.medianExpansion.coverage_ppm, insufficient_history: volume.insufficient.length },
    { metric: "ytd_ppm", denominator: ytd.metric.denominator, coverage_ppm: ytd.metric.coverage_ppm, insufficient_history: ytd.insufficient.length },
    { metric: "classification_coverage_ppm", denominator: classification.classified.denominator, coverage_ppm: classification.classified.coverage_ppm, insufficient_history: classification.unclassified.length },
  ];
  const shortfalls: HistoryShortfall[] = [];
  const deepest = aligned.reduce((n, s) => Math.max(n, s.bars.length), 0);
  for (const p of smaPeriods) {
    const r = sma[p];
    denominators.push({
      metric: `above_sma${p}_pct_ppm`,
      denominator: r.metric.denominator,
      coverage_ppm: r.metric.coverage_ppm,
      insufficient_history: r.insufficient.length,
    });
    if (r.insufficient.length > 0) {
      shortfalls.push({ metric: `above_sma${p}_pct_ppm`, needsSessions: p, youHaveSessions: deepest, line: shortfallLine(p, deepest) });
    }
  }
  for (const w of windows) {
    const r = returns[w.key];
    denominators.push({
      metric: `return_${w.key}_ppm`,
      denominator: r.metric.denominator,
      coverage_ppm: r.metric.coverage_ppm,
      insufficient_history: r.insufficient.length,
    });
    if (r.insufficient.length > 0) {
      shortfalls.push({ metric: `return_${w.key}_ppm`, needsSessions: w.sessions + 1, youHaveSessions: deepest, line: shortfallLine(w.sessions + 1, deepest) });
    }
  }
  if (highLow.insufficient.length > 0) {
    const need = opts.highLow?.minSessions ?? 20;
    shortfalls.push({ metric: "new_high_pct_ppm", needsSessions: need, youHaveSessions: deepest, line: shortfallLine(need, deepest) });
  }
  if (volume.insufficient.length > 0) {
    shortfalls.push({
      metric: "volume_expansion_median_ppm",
      needsSessions: volumeBaseline + 1,
      youHaveSessions: deepest,
      line: shortfallLine(volumeBaseline + 1, deepest),
    });
  }

  const ledger = buildLedger({
    asOf: anchor,
    generatedAt: opts.generatedAt,
    specVersion,
    inputChecksum: input_checksum,
    anchorCoverage: alignment.coverage,
    anchorTotal: alignment.total,
    truncated: alignment.truncated,
    stale: alignment.stale,
    nonEquity,
    insufficientHistory: breadth.insufficient,
    corporateAction: caEntries,
    denominators,
    shortfalls,
  });

  if (anchor === null) {
    return { daily: null, metrics: [], staleness: [], ledger, payload: null, alignment };
  }

  const warnings: string[] = [ROTATION_CAVEAT, ...shortfalls.map((s) => `${s.metric}: ${s.line}`)];
  if (caEntries.length > 0) {
    warnings.push(`Excluded from return windows: ${caEntries.length} symbol(s) with an unreconciled price gap.`);
  }

  const exclusion_counts: Partial<Record<ExclusionReason, number>> = {};
  for (const e of ledger.exclusions) exclusion_counts[e.reason] = e.count;

  const payload: AtlasPayload = {
    spec_version: specVersion,
    as_of: anchor,
    generated_at: opts.generatedAt,
    source_mode: sourceMode,
    input_checksum,
    universe: {
      submitted: all.length,
      included,
      excluded: all.length - included,
      exclusion_counts,
      anchor,
      anchor_policy: ledger.anchor.policy,
      anchor_coverage: alignment.coverage,
      anchor_coverage_ppm: ledger.anchor.coverage_ppm,
      truncated: alignment.truncated.length,
    },
    classification,
    market_pulse: {
      breadth,
      moving_average_breadth: sma,
      new_high_low: highLow,
      performance: { windows: returns, ytd },
      volume,
    },
    regime,
    rotation: { window: rotationWindow, caveat: ROTATION_CAVEAT, sectors: rotation, breadth: groupBreadth },
    statistic,
    groups: groupTables,
    relative_strength: {
      eligible: rs.eligible,
      priced: rs.priced,
      medians: rs.medians,
      windows: rs.windows,
      weights: rs.weights,
      floors: rs.floors,
      ineligible: rs.ineligible,
    },
    rsi: { low: rsi.low, high: rsi.high, valid: rsi.valid, insufficient: rsi.insufficient, thresholds: rsi.thresholds },
    volume_split: split,
    history,
    ledger,
    warnings,
  };

  const insufficientBreadth = breadth.insufficient.length;
  const metrics: AtlasMetricRow[] = [
    ratioRow(anchor, "advance_pct_ppm", breadth.advancing, insufficientBreadth),
    ratioRow(anchor, "decline_pct_ppm", breadth.declining, insufficientBreadth),
    ratioRow(anchor, "unchanged_pct_ppm", breadth.unchanged, insufficientBreadth),
    countRow(anchor, "advancing_count", asCount(breadth.counts.advancing, breadth.advancing), insufficientBreadth),
    countRow(anchor, "declining_count", asCount(breadth.counts.declining, breadth.declining), insufficientBreadth),
    countRow(anchor, "unchanged_count", asCount(breadth.counts.unchanged, breadth.unchanged), insufficientBreadth),
  ];
  for (const p of smaPeriods) {
    metrics.push(ratioRow(anchor, `above_sma${p}_pct_ppm`, sma[p].metric, sma[p].insufficient.length));
  }
  metrics.push(
    ratioRow(anchor, "new_high_pct_ppm", highLow.newHighs, highLow.insufficient.length),
    ratioRow(anchor, "new_low_pct_ppm", highLow.newLows, highLow.insufficient.length),
    countRow(anchor, "new_high_count", asCount(highLow.counts.highs, highLow.newHighs), highLow.insufficient.length),
    countRow(anchor, "new_low_count", asCount(highLow.counts.lows, highLow.newLows), highLow.insufficient.length),
    countRow(anchor, "net_high_low", highLow.netHighLow, highLow.insufficient.length),
  );
  for (const w of windows) {
    const r = returns[w.key];
    metrics.push(ratioRow(anchor, `return_${w.key}_ppm`, r.metric, r.insufficient.length));
  }
  metrics.push(
    ratioRow(anchor, "ytd_ppm", ytd.metric, ytd.insufficient.length),
    ratioRow(anchor, "volume_expansion_median_ppm", volume.medianExpansion, volume.insufficient.length),
    ratioRow(anchor, "volume_expanding_pct_ppm", volume.expandingShare, volume.insufficient.length),
    ratioRow(anchor, "classification_coverage_ppm", classification.classified, classification.unclassified.length),
  );
  for (const row of rotation) {
    metrics.push(
      ratioRow(anchor, `rotation_${row.window}_ppm`, row.metric, row.insufficient.length, "sector", row.group),
    );
  }
  for (const row of groupBreadth) {
    metrics.push(
      ratioRow(anchor, "group_advance_pct_ppm", row.advancing, row.breadth.insufficient.length, "sector", row.group),
    );
  }

  // v4.6.0 W5 — the universe additions and the three group tables. Names per
  // the W5 contract §6; `group_kind` is `sector` | `industry` | `cap`.
  metrics.push(
    countRow(anchor, "rsi_low_count", rsi.low, rsi.insufficient.length),
    countRow(anchor, "rsi_high_count", rsi.high, rsi.insufficient.length),
    ratioRow(anchor, "volume_adv_share_ppm", split.advancingShare, split.noVolume.length),
    countRow(
      anchor,
      "rs_eligible_count",
      { value: rs.priced === 0 ? null : rs.eligible, denominator: rs.priced, coverage_ppm: included > 0 ? Math.round((rs.priced * 1_000_000) / included) : 0 },
      rs.priced - rs.eligible,
    ),
  );
  const kinds: [AtlasMetricRow["group_kind"], GroupTableRow[]][] = [
    ["sector", groupTables.sector],
    ["industry", groupTables.industry],
    ["cap", groupTables.cap],
  ];
  for (const [kind, table] of kinds) {
    for (const row of table) {
      const g = row.group;
      for (const w of windows) {
        const r = row.returns[w.key];
        if (!r) continue;
        metrics.push(
          ratioRow(anchor, `group_return_median_${w.key}`, r.median, r.insufficient.length, kind, g),
          ratioRow(anchor, `group_return_mean_${w.key}`, r.mean, r.insufficient.length, kind, g),
        );
      }
      metrics.push(
        ratioRow(anchor, "group_ytd_ppm", row.ytd.median, row.ytd.insufficient.length, kind, g),
        ratioRow(anchor, "group_ytd_mean_ppm", row.ytd.mean, row.ytd.insufficient.length, kind, g),
        ratioRow(anchor, "group_rs_ppm", row.rs, row.members - row.rsEligible, kind, g),
        countRow(anchor, "group_rsi_low_count", row.rsiLow, 0, kind, g),
        countRow(anchor, "group_rsi_high_count", row.rsiHigh, 0, kind, g),
        countRow(anchor, "group_new_high_count", asCount(row.newHighs.numerator, row.newHighs), 0, kind, g),
        countRow(anchor, "group_new_low_count", asCount(row.newLows.numerator, row.newLows), 0, kind, g),
        countRow(anchor, "group_net_high_low", row.netHighLow, 0, kind, g),
        ratioRow(anchor, "group_turnover_share_ppm", row.turnoverShare, 0, kind, g),
        ratioRow(anchor, "group_volume_expansion_median_ppm", row.volumeExpansion, 0, kind, g),
        ratioRow(anchor, "group_volume_adv_share_ppm", row.volumeAdvancingShare, 0, kind, g),
      );
      for (const p of smaPeriods) {
        metrics.push(ratioRow(anchor, `group_above_sma${p}_pct_ppm`, row.aboveSma[p], 0, kind, g));
      }
    }
  }

  const staleness: AtlasStalenessRow[] = [];
  for (const e of ledger.exclusions) {
    for (const s of e.symbols) {
      staleness.push({
        as_of: anchor,
        symbol: s.symbol,
        reason: e.reason,
        last_seen_date: s.lastSeen ?? null,
        sessions_behind: s.sessionsBehind ?? 0,
      });
    }
  }

  const daily: AtlasDailyRow = {
    as_of: anchor,
    generated_at: opts.generatedAt,
    spec_version: specVersion,
    source_mode: sourceMode,
    input_checksum,
    universe_included: included,
    universe_excluded: all.length - included,
    anchor_coverage: alignment.coverage,
    anchor_coverage_ppm: ledger.anchor.coverage_ppm,
    payload_json: JSON.stringify(payload),
  };

  return { daily, metrics, staleness, ledger, payload, alignment };
}

interface HistoryOptions {
  sessions: number;
  smaPeriods: readonly number[];
  windows: { key: ReturnWindowKey; sessions: number }[];
  volumeBaseline: number;
  highLow?: HighLowOptions;
  gapsBySymbol: Map<string, CaGap[]>;
}

/**
 * A11 — the replay. PRICE-DERIVED metrics only (A1-A7): sector rotation is
 * deliberately absent because `sector-map.json` carries one clock, so a
 * backdated sector row would be survivorship-biased (04 section 4.2).
 */
export function computeHistory(aligned: Series[], opts: HistoryOptions): AtlasHistoryEntry[] {
  const calendar = sessionCalendar(aligned);
  const dates = calendar.slice(Math.max(0, calendar.length - opts.sessions));
  const out: AtlasHistoryEntry[] = [];
  for (const date of dates) {
    const slice = truncateTo(aligned, date).filter((s) => s.bars[s.bars.length - 1].date === date);
    const base = slice.length;
    const breadth = computeBreadth(slice, base);
    const sma = computeSmaBreadthSet(slice, opts.smaPeriods, base);
    const hl = computeHighLow(slice, base, opts.highLow);
    const vol = computeVolumeExpansion(slice, base, opts.volumeBaseline);
    const rets = computeReturns(slice, base, opts.gapsBySymbol, opts.windows);
    const above: Record<number, number | null> = {};
    for (const p of opts.smaPeriods) above[p] = sma[p].metric.value_ppm;
    const returns_ppm: Record<string, number | null> = {};
    for (const w of opts.windows) returns_ppm[w.key] = rets[w.key].metric.value_ppm;
    out.push({
      as_of: date,
      advancing: breadth.counts.advancing,
      declining: breadth.counts.declining,
      unchanged: breadth.counts.unchanged,
      advance_pct_ppm: breadth.advancing.value_ppm,
      above_sma_ppm: above,
      new_highs: hl.counts.highs,
      new_lows: hl.counts.lows,
      net_high_low: hl.netHighLow.value,
      volume_expansion_median_ppm: vol.medianExpansion.value_ppm,
      returns_ppm,
    });
  }
  return out;
}
