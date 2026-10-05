// PURE — no DB, no React (invariant 2). The dashboard's whole-book maths, run
// ONCE on the server over the rows `getDashboardTrades()` already reads, so the
// page ships this aggregate instead of every row.
//
// v4.7.0 wave C0 (LEDGER L-51 / D-16): `/` serialised all 25,001 `DashTrade`
// rows of the perf book — 13.1 MB of HTML — so the client could filter them
// and run the same maths below. Every function here is the client's former
// `useMemo` body MOVED, not rewritten: same helpers, same order of operations,
// same float sums, so the numbers on screen are identical to the paisa
// (`tests/dashboard-aggregate.test.ts` runs the old client maths beside this
// over a 3-account book and every filter combination).
//
// The filters that used to be client state are now the page's search params
// (`parseDashboardFilters` / `dashboardQuery`), so the server can apply them.

import {
  computeKpis, equityCurve, dailyPnl, bySegment, bySetup, edgeMeasurable,
  type AnalyticsTrade, type EquityPoint, type GroupStat, type Kpis,
} from "./metrics";
import { isLotSegment, perLotAggregateResolved, type PerLotAggregate } from "./per-lot";
import { provenanceRowOf, rProvenanceCounts, type RProvenanceCounts } from "./win-loss";
import { BROKERS, BUCKETS, SEGMENTS } from "@/lib/domain/constants";

/** One dashboard row — the shape `getDashboardTrades()` (lib/queries/trades.ts) returns. */
export interface DashRow extends AnalyticsTrade {
  symbol: string;
  exchange: string;
  /** v4.4.0 D3 — the "1R = X per lot" numerator (stored risk, rupees). */
  riskAmount?: number | null;
  /** Lots resolved SERVER-side by getDashboardTrades; null = the book cannot say. */
  lots?: number | null;
  lotSource?: string | null;
}

/** The five dashboard filters; "" = no filter on that axis. */
export interface DashboardFilters {
  broker: string;
  bucket: string;
  segment: string;
  from: string;
  to: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const oneOf = (v: string, allowed: readonly string[]) => (allowed.includes(v) ? v : "");

/** The URL value for "Both buckets" when the workspace default is ONE bucket. */
export const ALL_BUCKETS_PARAM = "all";

type RawParams = Record<string, string | string[] | undefined>;

/**
 * Search params → filters. Every value is checked against the vocabulary the
 * select offers, so a hand-typed URL can only ever widen to "no filter". An
 * ABSENT bucket is the workspace default (`defaultBucket`) — the seed the old
 * client state used — and `bucket=all` is an explicit "Both buckets".
 */
export function parseDashboardFilters(sp: RawParams, defaultBucket: string): DashboardFilters {
  const get = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] ?? "" : v ?? "").trim();
  };
  const rawBucket = get("bucket");
  const bucket = rawBucket === ALL_BUCKETS_PARAM
    ? ""
    : rawBucket === ""
      ? oneOf(defaultBucket, BUCKETS as readonly string[])
      : oneOf(rawBucket, BUCKETS as readonly string[]);
  const date = (k: string) => (ISO_DATE.test(get(k)) ? get(k) : "");
  return {
    broker: oneOf(get("broker"), BROKERS as readonly string[]),
    bucket,
    segment: oneOf(get("segment"), SEGMENTS as readonly string[]),
    from: date("from"),
    to: date("to"),
  };
}

/** Untrusted filters (the export call) → the same vocabulary; an unknown value is dropped. */
export function sanitizeDashboardFilters(f: Partial<Record<keyof DashboardFilters, unknown>> | null | undefined): DashboardFilters {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const date = (v: unknown) => (ISO_DATE.test(s(v)) ? s(v) : "");
  return {
    broker: oneOf(s(f?.broker), BROKERS as readonly string[]),
    bucket: oneOf(s(f?.bucket), BUCKETS as readonly string[]),
    segment: oneOf(s(f?.segment), SEGMENTS as readonly string[]),
    from: date(f?.from),
    to: date(f?.to),
  };
}

/** Filters → the `/` query string ("" when every filter is at its default). */
export function dashboardQuery(f: DashboardFilters, defaultBucket: string): string {
  const p = new URLSearchParams();
  if (f.broker) p.set("broker", f.broker);
  if (f.bucket !== defaultBucket) p.set("bucket", f.bucket || ALL_BUCKETS_PARAM);
  if (f.segment) p.set("segment", f.segment);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** The client's former `filtered` memo, verbatim. */
export function filterDashRows<T extends DashRow>(trades: readonly T[], f: DashboardFilters): T[] {
  const { broker, bucket, segment, from, to } = f;
  return trades.filter((t) => {
    if (broker && t.broker !== broker) return false;
    if (bucket && t.bucket !== bucket) return false;
    if (segment && t.segment !== segment) return false;
    const d = t.sellDate ?? t.buyDate;
    if (from && d && d < from) return false;
    if (to && d && d > to) return false;
    return true;
  });
}

/** The per-lot inputs for ONE F&O segment; the client words the line (`perLotSecondLine`). */
export interface PerLotSegment {
  agg: PerLotAggregate;
  /** R provenance over the SAME population the per-lot figures divide. */
  rProv: RProvenanceCounts;
}

/**
 * Everything the dashboard renders, for one filter state. No per-trade row
 * crosses the wire: every array here is bounded by distinct dates, months,
 * segments or setup tags — never by the trade count.
 */
export interface DashboardAggregate {
  /** The filters these figures were computed under (the controls' committed state). */
  filters: DashboardFilters;
  /** Rows in the UNFILTERED book — the first-run branch. */
  bookCount: number;
  /** Rows under the filters — enables the export. */
  filteredCount: number;
  kpis: Kpis;
  curve: EquityPoint[];
  /** Closed trades with no exit date: the curve and the calendar cannot place them. */
  undatedCount: number;
  undatedNet: number;
  /** date → realised net (insertion order = `dailyPnl`'s, which the day stats tie-break on). */
  daily: Record<string, number>;
  segStats: GroupStat[];
  setupStats: GroupStat[];
  /** Keyed by F&O segment; only segments with a closed, priced row. */
  perLot: Record<string, PerLotSegment>;
  /** Last 30 equity points' cumulative value. */
  spark: number[];
  /** Rounded this-week minus prior-week net; null when no dated day. */
  weekDelta: number | null;
  dayStats: { best: number; worst: number; bestDate: string | null; worstDate: string | null };
  rStats: { count: number; best: number | null; worst: number | null };
  monthly: { month: string; net: number }[];
}

export function dashboardAggregate(book: readonly DashRow[], f: DashboardFilters): DashboardAggregate {
  const filtered = filterDashRows(book, f);

  const kpis = computeKpis(filtered);
  const curve = equityCurve(filtered);

  const undated = filtered.filter((t) => !t.isOpen && !t.sellDate);
  const undatedNet = undated.reduce((s, t) => s + t.netPnl, 0);
  const daily = Object.fromEntries(dailyPnl(filtered)) as Record<string, number>;

  const perLot: Record<string, PerLotSegment> = {};
  const segs = new Set(filtered.map((t) => t.segment).filter(isLotSegment));
  for (const s of segs) {
    const pop = filtered.filter((t) => t.segment === s && !t.isOpen && edgeMeasurable(t));
    if (pop.length === 0) continue;
    const agg = perLotAggregateResolved(pop.map((t) => ({
      lots: t.lots ?? null,
      lotSource: t.lotSource ?? null,
      netPnl: t.netPnl,
      riskAmount: t.riskAmount ?? null,
      rMultiple: t.rMultiple,
    })));
    perLot[s] = { agg, rProv: rProvenanceCounts(pop.map(provenanceRowOf)) };
  }

  const spark = curve.slice(-30).map((p) => p.cum);

  // v4.7.0 release audit M-B2: the cut-offs are IST CALENDAR DATES, worked in
  // UTC so no machine time zone can move them. The client body this moved from
  // built a LOCAL midnight and read it back through toISOString(), which in IST
  // (UTC+5:30) is the previous UTC day — "this week" ran eight days and took the
  // day exactly seven back from the prior week. The P&L days are already IST
  // dates (sale dates), so date-string arithmetic is the whole job.
  const weekDelta = (() => {
    const dates = Object.keys(daily).sort();
    if (dates.length === 0) return null;
    const [y, m, dd] = dates[dates.length - 1].split("-").map(Number);
    const cutoff = (d: number) => new Date(Date.UTC(y, m - 1, dd - d)).toISOString().slice(0, 10);
    const wk1 = cutoff(7);
    const wk2 = cutoff(14);
    let thisWeek = 0;
    let lastWeek = 0;
    for (const [d, v] of Object.entries(daily)) {
      if (d > wk1) thisWeek += v;
      else if (d > wk2) lastWeek += v;
    }
    return Math.round(thisWeek - lastWeek);
  })();

  const dayStats = (() => {
    const entries = Object.entries(daily);
    if (entries.length === 0) return { best: 0, worst: 0, bestDate: null as string | null, worstDate: null as string | null };
    let best = entries[0];
    let worst = entries[0];
    for (const e of entries) {
      if (e[1] > best[1]) best = e;
      if (e[1] < worst[1]) worst = e;
    }
    return { best: best[1], worst: worst[1], bestDate: best[0], worstDate: worst[0] };
  })();

  // Edge-measurable only, so this count IS `kpis.rCount` (v4.4.0 D2).
  const rs = filtered
    .filter((t) => !t.isOpen && t.rMultiple != null && edgeMeasurable(t))
    .map((t) => t.rMultiple as number);
  const rStats = {
    count: rs.length,
    best: rs.length ? Math.max(...rs) : null,
    worst: rs.length ? Math.min(...rs) : null,
  };

  const m = new Map<string, number>();
  for (const [d, v] of Object.entries(daily)) {
    const key = d.slice(0, 7);
    m.set(key, (m.get(key) ?? 0) + v);
  }
  const monthly = [...m.entries()].sort().map(([month, net]) => ({ month, net }));

  return {
    filters: { ...f },
    bookCount: book.length,
    filteredCount: filtered.length,
    kpis,
    curve,
    undatedCount: undated.length,
    undatedNet,
    daily,
    segStats: bySegment(filtered),
    setupStats: bySetup(filtered),
    perLot,
    spark,
    weekDelta,
    dayStats,
    rStats,
    monthly,
  };
}

/** The export's columns — the only per-trade fields that cross the wire, and only on a click. */
export type DashExportRow = Pick<DashRow,
  "sellDate" | "symbol" | "broker" | "segment" | "bucket" | "exchange" | "grossPnl" | "chargesTotal" | "netPnl" | "rMultiple">;

export function dashboardExportRows(book: readonly DashRow[], f: DashboardFilters): DashExportRow[] {
  return filterDashRows(book, f).map((t) => ({
    sellDate: t.sellDate,
    symbol: t.symbol,
    broker: t.broker,
    segment: t.segment,
    bucket: t.bucket,
    exchange: t.exchange,
    grossPnl: t.grossPnl,
    chargesTotal: t.chargesTotal,
    netPnl: t.netPnl,
    rMultiple: t.rMultiple,
  }));
}
