"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { KpiCard } from "@/components/kpi-card";
import { CountUp } from "@/components/ui/count-up";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { serializeTradesQuery } from "@/lib/domain/trades-query";
import { brokersWithNativeParser } from "@/lib/import/registry-meta";
import { EquityCurve, SegmentBars } from "./charts";
import { CalendarHeatmap } from "./calendar-heatmap";
import { Section, SectionStack } from "@/components/layout/section-stack";
import { inr, inrCompact, pct } from "@/lib/format";
import { exportRows as writeExport } from "@/lib/export";
import { Download } from "lucide-react";
import { PROFIT_FACTOR_TITLE, profitFactorRows, segmentEdgeRows, type SegmentEdgeRow } from "@/lib/domain/kpi-detail";
import { BROKERS, BROKER_LABELS, BUCKETS, BUCKET_LABELS, SEGMENTS, SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { defaultBucket, type Workspace } from "@/lib/domain/workspace";
import { rProvenanceFromKpis, rProvenanceLine } from "@/lib/analytics/win-loss";
import {
  isLotSegment, perLotSecondLine, perLotUnknownNote, rPerLotLabel,
  type PerLotAggregate,
} from "@/lib/analytics/per-lot";
import {
  dashboardQuery,
  type DashboardAggregate, type DashboardFilters, type DashExportRow, type DashRow,
} from "@/lib/analytics/dashboard-aggregate";

/** One dashboard row — kept as the component's name for the server's shape. */
export type DashTrade = DashRow;

export function DashboardClient({
  aggregate,
  monthlyBase,
  monthlyStretch,
  workspace = "both",
}: {
  /**
   * v4.7.0 C0 — every figure below, computed on the SERVER over the filters in
   * the URL (`dashboardAggregate`, lib/analytics/dashboard-aggregate.ts). No
   * trade row reaches this component; the export fetches its rows on click
   * from GET /api/dashboard/export.
   */
  aggregate: DashboardAggregate;
  /** null = no monthly target set (v4.4.0) — the ladder says so rather than
   *  measuring against the ₹4.25L / ₹5.1L it used to substitute. */
  monthlyBase: number | null;
  monthlyStretch: number | null;
  workspace?: Workspace;
}) {
  const router = useRouter();
  // The filters live in the URL, so the server can apply them. Workspace mode
  // still seeds the bucket (an absent `bucket` param IS `defaultBucket`), it
  // does not enforce it: "Both buckets" is `bucket=all`, and the control reads
  // back the choice it made. The controls show the OPTIMISTIC value while the
  // navigation is in flight and settle on the server's own `filters` after —
  // derived, never synced in an effect.
  const baseBucket = defaultBucket(workspace);
  const [pending, startTransition] = React.useTransition();
  const [shown, setShown] = React.useOptimistic(aggregate.filters);
  const setFilter = (key: keyof DashboardFilters, value: string) => {
    const next = { ...shown, [key]: value };
    startTransition(() => {
      setShown(next);
      router.replace(`/${dashboardQuery(next, baseBucket)}`, { scroll: false });
    });
  };

  // The figures and the popups speak for the filters they were computed under.
  const { bucket, segment } = aggregate.filters;
  const k = aggregate.kpis;
  const curve = aggregate.curve;

  /**
   * P&L the equity curve cannot plot.
   *
   * The curve is built from exit dates; the Net P&L KPI above it counts every
   * closed trade. A book imported from an aggregated broker P&L statement has
   * no per-trade dates, so the two can differ by lakhs — and a curve that
   * quietly ends far above the headline loss is worse than no curve at all.
   */
  const undatedNet = aggregate.undatedNet;
  const undatedCount = aggregate.undatedCount;
  const daily = aggregate.daily;
  // Closed trades the calendar can never show — surfaced, not silently dropped.
  const undatedClosed = aggregate.undatedCount;
  const segStats = aggregate.segStats;
  const segEdge = React.useMemo(() => segmentEdgeRows(segStats), [segStats]);

  /**
   * v4.4.0 D3 — the per-lot SECOND line, per F&O segment.
   *
   * Population: the exact rows the per-trade figure above it was taken over —
   * closed AND `edgeMeasurable` — so expectancy-per-lot × Σlots = the segment's
   * priced net to the paisa. Lots are whatever the SERVER resolved (`lots`,
   * `lotSource`); nothing is re-derived or re-priced here. Since v4.7.0 C0 the
   * server also aggregates them (`aggregate.perLot`: `perLotAggregateResolved`
   * and `rProvenanceCounts` over that population); this words the line.
   *
   * `rProvenanceLine` is computed over the SAME population and printed beside
   * the figures (design-review delta): on a cap-only segment "1R per lot" is a
   * per-segment cap divided by lots, not a planned risk.
   */
  const perLotBySegment = React.useMemo(() => {
    const out = new Map<string, { agg: PerLotAggregate; line: string; rProvLine: string }>();
    for (const [s, { agg, rProv }] of Object.entries(aggregate.perLot)) {
      if (!isLotSegment(s)) continue;
      const prov = rProvenanceLine(rProv);
      out.set(s, { agg, line: perLotSecondLine(agg, prov), rProvLine: prov });
    }
    return out;
  }, [aggregate.perLot]);

  /** The popups only speak per-lot when the filter names ONE F&O segment —
   *  a per-lot figure pooled across segments divides unlike lots. */
  const segPerLot = segment && isLotSegment(segment) ? perLotBySegment.get(segment) : undefined;
  const setupStats = aggregate.setupStats;

  // C4 — sparkline (last 30 equity points) + week-over-week net delta.
  const spark = aggregate.spark;
  const weekDelta = aggregate.weekDelta == null
    ? null
    : { value: aggregate.weekDelta, label: "vs prior wk", formatted: inrCompact(Math.abs(aggregate.weekDelta)) };

  // Drill-down inputs for the KPI popups (click any card).
  const dayStats = aggregate.dayStats;
  // Edge-measurable only, so this count IS `k.rCount` (v4.4.0 D2).
  const rStats = aggregate.rStats;

  /** Where the R denominators came from, over the SAME rows `k.avgR` averaged. */
  const rProv = React.useMemo(() => rProvenanceFromKpis(k), [k]);
  const rProvLine = rProvenanceLine(rProv);

  // monthly ladder (combined)
  const monthly = aggregate.monthly;

  const exportColumns = [
    { key: "sellDate", label: "Date" },
    { key: "symbol", label: "Symbol" },
    { key: "broker", label: "Broker" },
    { key: "segment", label: "Segment", value: (r: DashExportRow) => SEGMENT_LABELS[r.segment as Segment] ?? r.segment },
    { key: "bucket", label: "Bucket" },
    { key: "exchange", label: "Exchange" },
    { key: "grossPnl", label: "Gross" },
    { key: "chargesTotal", label: "Charges" },
    { key: "netPnl", label: "Net" },
    { key: "rMultiple", label: "R" },
  ];

  // ── First run ───────────────────────────────────────────────────────────
  // Branch on the UNFILTERED book. The old behaviour showed a brand-new user
  // five ₹0 KPIs and an empty-chart card whose copy said "widen the date
  // range or clear a filter" — blaming a filter that was never set, on a
  // database that was never filled, with no next step offered anywhere
  // (2026-08-10 audit: "the single worst first impression in the product").
  if (aggregate.bookCount === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <EmptyState
          variant="chart"
          title="Nothing journalled yet"
          hint={`Import a broker file and this screen comes alive — P&L, expectancy, the equity curve, the daily calendar. ${brokersWithNativeParser().length} brokers auto-detect; any other broker's CSV imports by mapping its columns once.`}
          action={
            <Button asChild size="sm">
              <Link href="/import">Import a broker file</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Filter bar */}
      <div className="sticky top-[69px] z-[5] -mx-6 flex flex-wrap items-center gap-2 border-b border-border bg-background/90 px-6 py-2 backdrop-blur">
        <Select value={shown.broker} onChange={(e) => setFilter("broker", e.target.value)} className="h-8 w-32">
          <option value="">All brokers</option>
          {BROKERS.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
        </Select>
        <Select value={shown.bucket} onChange={(e) => setFilter("bucket", e.target.value)} className="h-8 w-40">
          <option value="">Both buckets</option>
          {BUCKETS.map((b) => <option key={b} value={b}>{BUCKET_LABELS[b]}</option>)}
        </Select>
        <Select value={shown.segment} onChange={(e) => setFilter("segment", e.target.value)} className="h-8 w-44">
          <option value="">All segments</option>
          {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
        </Select>
        <Input type="date" value={shown.from} onChange={(e) => setFilter("from", e.target.value)} className="h-8 w-36" title="From" />
        <Input type="date" value={shown.to} onChange={(e) => setFilter("to", e.target.value)} className="h-8 w-36" title="To" />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground" aria-busy={pending}>{k.closedCount} closed · {k.openCount} open</span>
          <DashboardExport
            columns={exportColumns}
            disabled={aggregate.filteredCount === 0}
            query={dashboardQuery(aggregate.filters, "")}
          />
        </div>
      </div>

      {/* The cards below are user-movable (PAGE_SECTIONS.dashboard, Rearrange
          in the header); the filter bar above is a control over all of them
          and stays put. A grid pair is ONE section. The blocks keep their
          original indentation so this diff is the wrappers only. */}
      <SectionStack page="dashboard" className="space-y-5">
      <Section id="dash-kpis">
      {/* KPIs — count-up, sparkline, delta chip (C4) and click-through drill-downs */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label="Net P&L"
          value={<CountUp value={k.netPnl} />}
          valueClassName={k.netPnl >= 0 ? "text-profit" : "text-loss"}
          sub={`Gross ${inrCompact(k.grossPnl)}`}
          spark={spark}
          delta={weekDelta ?? undefined}
          detail={{
            title: "Net P&L — where it came from",
            summary: "Gross result minus every charge the engine computed for these trades.",
            rows: [
              { label: "Gross P&L", value: inr(k.grossPnl, { decimals: 0 }), tone: k.grossPnl >= 0 ? "profit" : "loss" },
              { label: "Total charges", value: `−${inr(k.charges, { decimals: 0 })}`, tone: "loss", hint: "brokerage, STT, GST, DP, MTF interest…" },
              { label: "Net P&L", value: inr(k.netPnl, { decimals: 0 }), tone: k.netPnl >= 0 ? "profit" : "loss" },
              // The date rows deep-link to that day's trades — the popup stops
              // being a dead end and becomes somewhere to go next.
              {
                label: "Best day", value: inr(dayStats.best, { decimals: 0 }), tone: "profit",
                hint: dayStats.bestDate ?? undefined,
                href: dayStats.bestDate ? `/trades${serializeTradesQuery({ from: dayStats.bestDate, to: dayStats.bestDate, realised: true })}` : undefined,
              },
              {
                label: "Worst day", value: inr(dayStats.worst, { decimals: 0 }), tone: "loss",
                hint: dayStats.worstDate ?? undefined,
                href: dayStats.worstDate ? `/trades${serializeTradesQuery({ from: dayStats.worstDate, to: dayStats.worstDate, realised: true })}` : undefined,
              },
              { label: "Closed / open", value: `${k.closedCount} / ${k.openCount}` },
            ],
            note: "Open positions contribute unrealised P&L on the trackers, not here — this is realised money only.",
            footerHref: "/trades",
            footerLabel: "Show me every trade",
          }}
        />
        <KpiCard
          label="Total charges"
          value={<CountUp value={k.charges} />}
          valueClassName="text-grad-gold"
          sub={k.chargePctOfGross == null ? "gross P&L is exactly zero" : `${pct(k.chargePctOfGross, 2)} of gross`}
          detail={{
            title: "Charges — the silent tax on your edge",
            summary: "Computed per broker × segment × exchange from your editable rate table.",
            rows: [
              { label: "Total charges", value: inr(k.charges, { decimals: 0 }), tone: "loss" },
              { label: "As % of gross P&L", value: pct(k.chargePctOfGross, 2), hint: "past ~30% costs are eating the edge" },
              { label: "Avg per closed trade", value: k.closedCount ? inr(k.charges / k.closedCount, { decimals: 0 }) : "—" },
              { label: "Gross P&L before charges", value: inr(k.grossPnl, { decimals: 0 }), tone: k.grossPnl >= 0 ? "profit" : "loss" },
              { label: "What you kept", value: inr(k.netPnl, { decimals: 0 }), tone: k.netPnl >= 0 ? "profit" : "loss" },
            ],
            note: "Charges & MTF Leak breaks this down by charge type and finds the biggest leak.",
          }}
        />
        <KpiCard
          label="Win rate"
          // The avgR pattern below: a null is a DASH, never a 0 and never a
          // `?? undefined` (kpi-card renders an EMPTY card for undefined).
          value={k.winRate == null ? "—" : <CountUp value={k.winRate * 100} decimals={1} format="plain" suffix="%" />}
          sub={k.winRate == null ? "no priced closed trade yet" : `${k.wins}W / ${k.losses}L`}
          detail={{
            title: "Win rate — and why it isn't the whole story",
            summary: "A low win rate with big winners beats a high win rate with big losers.",
            rows: [
              { label: "Wins", value: `${k.wins}`, tone: "profit" },
              { label: "Losses", value: `${k.losses}`, tone: "loss" },
              { label: "Win rate", value: pct(k.winRate == null ? null : k.winRate * 100, 1) },
              { label: "Average win", value: inr(k.avgWin, { decimals: 0 }), tone: "profit" },
              { label: "Average loss", value: inr(k.avgLoss, { decimals: 0 }), tone: "loss" },
              // `k.avgLoss !== 0` alone is TRUE on a null, and Math.abs(null / null)
              // printed "NaN×" on a book with no loser.
              { label: "Win / loss size ratio", value: k.avgWin != null && k.avgLoss != null && k.avgLoss !== 0 ? `${Math.abs(k.avgWin / k.avgLoss).toFixed(2)}×` : "—", hint: "how many losses one win pays for" },
            ],
            note: "Expectancy — win rate and win size together — is the number that actually compounds.",
          }}
        />
        <KpiCard
          label="Profit factor"
          value={k.profitFactor === Infinity ? "∞" : <CountUp value={k.profitFactor} decimals={2} format="plain" />}
          sub={`Expectancy ${inrCompact(k.expectancy)}`}
          detail={{
            title: PROFIT_FACTOR_TITLE,
            summary: "Above 1.0 you make money; below 1.0 the book bleeds whatever the win rate says.",
            rows: [
              // The exact two sums the headline divides (priced trades, net of
              // charges) — so the popup reproduces the number above it.
              ...profitFactorRows(k),
              // A null tone would paint a green "—".
              { label: "Expectancy / trade", value: inr(k.expectancy, { decimals: 0 }), tone: k.expectancy == null ? undefined : k.expectancy >= 0 ? "profit" : "loss" },
              // D3 — the second line: a derivative trade nobody sizes in trades.
              // All or dash: one unresolvable row dashes it and says how many.
              ...(segPerLot ? [{
                label: "Expectancy / lot",
                value: segPerLot.agg.expectancyPerLot == null ? "—" : inr(segPerLot.agg.expectancyPerLot, { decimals: 0 }),
                tone: segPerLot.agg.expectancyPerLot == null ? undefined : segPerLot.agg.expectancyPerLot >= 0 ? ("profit" as const) : ("loss" as const),
                hint: perLotUnknownNote(segPerLot.agg) ?? `lots from ${segPerLot.agg.sources.join(", ")}`,
              }] : []),
              { label: "Closed trades", value: `${k.closedCount}`, hint: k.closedCount < 20 ? "under ~20 trades this is mostly noise" : undefined },
            ],
          }}
        />
        <KpiCard
          label="Avg R"
          value={k.avgR == null ? "—" : <CountUp value={k.avgR} decimals={2} format="plain" suffix="R" />}
          sub={rProvLine || `Max DD ${inrCompact(k.maxDrawdown)}`}
          detail={{
            title: "Avg R — return per unit of risk",
            summary: "R normalises every trade to the risk you planned, so position size stops distorting the picture.",
            rows: [
              { label: "Average R", value: k.avgR == null ? "—" : `${k.avgR.toFixed(2)}R`, tone: (k.avgR ?? 0) >= 0 ? "profit" : "loss" },
              { label: "Trades with R recorded", value: `${k.rCount} of ${k.closedCount}`, hint: k.rCount < k.closedCount ? "set an SL so risk (and R) gets captured" : undefined },
              // Three-way, because "everything that is not plan-derived" is not
              // all cap: a risk you TYPED is neither, and it does not move when
              // the per-trade cap is edited (v4.4.0 D2).
              { label: "Where the R came from", value: rProvLine || "—", hint: rProv.cap > 0 ? "default-cap R measures P&L in cap units, not plan adherence" : undefined },
              // D3 — R per lot, beside where those Rs came from: a cap-only
              // segment's "1R per lot" is a cap ÷ lots, never a planned risk.
              ...(segPerLot ? [{
                label: "Risk per lot",
                value: rPerLotLabel(segPerLot.agg),
                hint: perLotUnknownNote(segPerLot.agg) ?? `${segPerLot.rProvLine || "—"} · lots from ${segPerLot.agg.sources.join(", ")}`,
              }] : []),
              { label: "Best R", value: rStats.best == null ? "—" : `${rStats.best.toFixed(2)}R`, tone: "profit" },
              { label: "Worst R", value: rStats.worst == null ? "—" : `${rStats.worst.toFixed(2)}R`, tone: "loss" },
              { label: "Max drawdown", value: inr(k.maxDrawdown, { decimals: 0 }), tone: "loss" },
              { label: "Streaks", value: `${k.maxWinStreak}W best · ${k.maxLossStreak}L worst` },
            ],
            note: "Positive avg R means your winners are bigger than the risk you took to get them.",
          }}
        />
      </section>
      </Section>

      <Section id="dash-equity-curve">
      {/* Equity curve + monthly ladder */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2 card-hero">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Equity curve {bucket && <span className="text-muted-foreground">· {BUCKET_LABELS[bucket as never]}</span>}</CardTitle>
            <Badge variant="secondary">Max DD {inrCompact(k.maxDrawdown)}</Badge>
          </CardHeader>
          <CardContent>
            {curve.length > 0 ? <EquityCurve data={curve} /> : <Empty />}
            {/* The space after </b> below lives INSIDE a string expression,
                not in JSX source whitespace: the React Compiler's Babel pass
                collapsed the newline-indent differently between the SSR and
                client outputs here, and the one-character disagreement threw a
                hydration mismatch that regenerated the whole tree on every
                dashboard load (caught by e2e, 2026-08-11, compiler-off
                bisect). An explicit string cannot be normalised two ways. */}
            {undatedCount > 0 && (
              <p className="mt-2 text-xs text-warning">
                {undatedCount} closed trades carry no exit date and cannot be plotted —{" "}
                <b>{inr(undatedNet, { decimals: 0 })}</b>
                {" of realised P&L sits outside this curve but inside the Net P&L above. Aggregated broker P&L files have no per-trade dates; a tradebook import does."}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Monthly target ladder (combined)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {monthly.length === 0 && <Empty />}
            {monthly.length > 0 && (monthlyBase == null || monthlyStretch == null || monthlyStretch <= 0) && (
              <p className="text-sm text-muted-foreground">Set a monthly target (base and stretch) in Settings → Risk rules to see each month against it.</p>
            )}
            {monthlyBase != null && monthlyStretch != null && monthlyStretch > 0 && monthly.map((m) => (
              <MonthLadder key={m.month} month={m.month} net={m.net} base={monthlyBase} stretch={monthlyStretch} />
            ))}
          </CardContent>
        </Card>
      </section>
      </Section>

      <Section id="dash-daily-calendar">
      {/* Calendar heatmap */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Daily P&L calendar</CardTitle>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="inline-block size-3 rounded" style={{ background: "color-mix(in oklab, var(--color-loss) 70%, transparent)" }} /> loss
            <span className="inline-block size-3 rounded" style={{ background: "color-mix(in oklab, var(--color-profit) 70%, transparent)" }} /> profit
          </div>
        </CardHeader>
        <CardContent>
          {/* Drill-down reuses the Trades deep link the KPI cards already use:
              from=to=<day> plus realised=1, so the rows shown are EXACTLY the
              population dailyPnl summed for that cell (closed trades only —
              an open position's charges would otherwise not reconcile).
              router.push, not window.location.href: a full-document
              navigation inside the Tauri shell reboots the whole app, and it
              also broke Back — nav-history tracks pathnames per client
              navigation, so the reload left it with nothing to return to. */}
          <CalendarHeatmap
            daily={daily}
            onPickDay={(d) => router.push(`/trades${serializeTradesQuery({ from: d, to: d, realised: true })}`)}
          />
          {undatedClosed > 0 && (
            <p className="mt-2 text-[0.6875rem] text-muted-foreground">
              <span className="text-warning">{undatedClosed} closed trade{undatedClosed === 1 ? "" : "s"} carry no exit
              date</span> and cannot appear on any day — typically rows from an aggregated P&amp;L import, which
              reports totals without dates. A transaction/tradebook import (Dhan GTR, Zerodha tradebook) carries real
              dates and fills this calendar. Open positions don&apos;t appear either: no exit, no realised P&amp;L.
            </p>
          )}
        </CardContent>
      </Card>
      </Section>

      <Section id="dash-by-segment">
      {/* By segment / setup */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Net P&L by segment</CardTitle></CardHeader>
          <CardContent>
            {segStats.length ? <SegmentBars data={segStats} labelFor={(kk) => SEGMENT_LABELS[kk as Segment] ?? kk} /> : <Empty />}
            {segEdge.length > 0 && <SegmentEdgeTable rows={segEdge} perLot={perLotBySegment} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Net P&L by setup tag</CardTitle></CardHeader>
          <CardContent>{setupStats.length ? <SegmentBars data={setupStats} labelFor={(kk) => kk} /> : <Empty />}</CardContent>
        </Card>
      </section>
      </Section>

      <Section id="dash-streaks">
      {/* Streaks + charge leak */}
      <section className="grid gap-4 sm:grid-cols-3">
        <KpiCard label="Current streak" value={k.currentStreak === 0 ? "—" : `${Math.abs(k.currentStreak)} ${k.currentStreak > 0 ? "wins" : "losses"}`} valueClassName={k.currentStreak > 0 ? "text-profit" : k.currentStreak < 0 ? "text-loss" : ""} sub={`Best ${k.maxWinStreak}W · Worst ${k.maxLossStreak}L`} />
        <KpiCard label="Avg win / loss" value={`${inrCompact(k.avgWin)} / ${inrCompact(k.avgLoss)}`} sub="per closed trade" />
        <KpiCard label="Charges leak" value={pct(k.chargePctOfGross, 2)} valueClassName="text-grad-gold" sub={`${inr(k.charges, { decimals: 0 })} paid`} />
      </section>
      </Section>
      </SectionStack>
    </div>
  );
}

/**
 * `ExportButtons`' two buttons, fed on the click (v4.7.0 C0): the rows are the
 * filtered book, read from GET /api/dashboard/export (a route handler + client
 * fetch — never a server action, AGENTS.md), so they never ride on the page.
 * Same filename, same columns, no note — the file is the one the old
 * in-memory export wrote. `query` is `dashboardQuery(filters, "")`: the
 * filters the figures were computed under, bucket already resolved.
 */
function DashboardExport({
  columns,
  disabled,
  query,
}: {
  columns: { key: string; label: string; value?: (r: DashExportRow) => string | number | null }[];
  disabled: boolean;
  query: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const run = async (format: "csv" | "xlsx") => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/dashboard/export${query}`, { cache: "no-store" });
      const body = (await res.json()) as { ok?: boolean; rows?: DashExportRow[] };
      if (!res.ok || !body.ok || !Array.isArray(body.rows)) throw new Error(`export ${res.status}`);
      await writeExport("vyuha-trades", columns, body.rows, format);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-1.5 print:hidden">
      {failed && <span className="text-xs text-loss" role="alert">Export failed — try again</span>}
      <Button size="sm" variant="outline" onClick={() => void run("csv")} disabled={disabled || busy}>
        <Download className="size-3.5" /> CSV
      </Button>
      <Button size="sm" variant="outline" onClick={() => void run("xlsx")} disabled={disabled || busy}>
        <Download className="size-3.5" /> XLSX
      </Button>
    </div>
  );
}

function MonthLadder({ month, net, base, stretch }: { month: string; net: number; base: number; stretch: number }) {
  const pct = Math.max(0, Math.min(100, (net / stretch) * 100));
  const basePct = (base / stretch) * 100;
  const label = new Date(month + "-01T00:00:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" });
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-medium tabular-nums ${net >= 0 ? "text-profit" : "text-loss"}`}>{inr(net, { decimals: 0 })}</span>
      </div>
      <div className="relative h-2 rounded-full bg-card-hover">
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-[-2px] w-px bg-warning" style={{ left: `${Math.min(100, basePct)}%` }} title={`base ${inrCompact(base)}`} />
        <div className="absolute inset-y-[-2px] right-0 w-px bg-foreground/40" title={`stretch ${inrCompact(stretch)}`} />
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground">
        <span>base {inrCompact(base)}</span>
        <span>stretch {inrCompact(stretch)}</span>
      </div>
    </div>
  );
}

/** Rendered only when the BOOK has trades but the filters emptied the view —
 *  the first-run branch above returns before any chart mounts, so this copy
 *  is finally always true when shown. */
function Empty() {
  return <EmptyState variant="chart" title="No data for these filters" hint="Widen the date range or clear a filter — closed trades power every chart here." />;
}

/**
 * v4.4.0 D6 — per-segment edge beside the segment bars: win rate · profit
 * factor · payoff · expectancy for the five DEPTH_SEGMENTS, from `groupBy`'s
 * own figures (`segmentEdgeRows`), so a row equals the KPI band under that
 * segment filter. FREE (OQ3): the segment filter already shows each segment's
 * PF unlicensed, and the dashboard is never gated (invariant 7).
 */
function SegmentEdgeTable({ rows, perLot }: { rows: SegmentEdgeRow[]; perLot: Map<string, { line: string }> }) {
  const tone = (v: number | null) => (v == null ? "text-muted-foreground" : v > 0 ? "text-profit" : v < 0 ? "text-loss" : "");
  return (
    <div className="mt-4 overflow-x-auto" data-testid="segment-edge-table">
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-muted-foreground">
            <th className="py-1 text-left font-medium">Segment</th>
            <th className="py-1 text-right font-medium">Trades</th>
            <th className="py-1 text-right font-medium">Win rate</th>
            <th className="py-1 text-right font-medium" title="Winners ÷ losers, after charges">Profit factor</th>
            <th className="py-1 text-right font-medium" title="Average win ÷ average loss">Payoff</th>
            <th className="py-1 text-right font-medium">Expectancy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.segment} className="border-t border-border">
              <td className="py-1">{r.label}</td>
              <td className="py-1 text-right" title={r.unpricedCount > 0 ? `${r.unpricedCount} unpriced — no cost basis, held out of every ratio` : undefined}>
                {r.pricedCount}
                {r.unpricedCount > 0 && <span className="text-warning"> +{r.unpricedCount}</span>}
              </td>
              <td className="py-1 text-right">{pct(r.winRate == null ? null : r.winRate * 100, 1)}</td>
              <td className="py-1 text-right" title={r.noLoserYet ? "No losing trade yet — nothing to divide by" : undefined}>
                {r.profitFactor != null ? r.profitFactor.toFixed(2) : r.noLoserYet ? <span className="text-muted-foreground">no losing trade yet</span> : "—"}
              </td>
              <td className="py-1 text-right">{r.payoff == null ? "—" : `${r.payoff.toFixed(2)}×`}</td>
              <td className={`py-1 text-right ${tone(r.expectancy)}`}>
                {inr(r.expectancy, { decimals: 0 })}
                {/* v4.4.0 D3 — the per-lot SECOND line, F&O rows only: a per-trade
                    figure on a derivative book says nothing until you know whether
                    that trade was one lot or eleven. `perLotSecondLine` is shared
                    with /reports/edge so the two surfaces cannot word it differently. */}
                {perLot.get(r.segment)?.line && (
                  <span className="block text-[0.65rem] font-normal text-muted-foreground" data-testid={`per-lot-${r.segment}`}>
                    {perLot.get(r.segment)!.line}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
