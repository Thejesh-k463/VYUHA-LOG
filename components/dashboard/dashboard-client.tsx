"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { KpiCard } from "@/components/kpi-card";
import { ExportButtons } from "@/components/ui/export-button";
import { EquityCurve, SegmentBars } from "./charts";
import { CalendarHeatmap } from "./calendar-heatmap";
import {
  computeKpis, equityCurve, dailyPnl, bySegment, bySetup,
  type AnalyticsTrade,
} from "@/lib/analytics/metrics";
import { inr, inrCompact, num } from "@/lib/format";
import { BROKERS, BROKER_LABELS, BUCKETS, BUCKET_LABELS, SEGMENTS, SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";

export interface DashTrade extends AnalyticsTrade {
  symbol: string;
  exchange: string;
}

export function DashboardClient({
  trades,
  monthlyBase,
  monthlyStretch,
}: {
  trades: DashTrade[];
  monthlyBase: number;
  monthlyStretch: number;
}) {
  const [broker, setBroker] = React.useState("");
  const [bucket, setBucket] = React.useState("");
  const [segment, setSegment] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  const filtered = React.useMemo(() => {
    return trades.filter((t) => {
      if (broker && t.broker !== broker) return false;
      if (bucket && t.bucket !== bucket) return false;
      if (segment && t.segment !== segment) return false;
      const d = t.sellDate ?? t.buyDate;
      if (from && d && d < from) return false;
      if (to && d && d > to) return false;
      return true;
    });
  }, [trades, broker, bucket, segment, from, to]);

  const k = React.useMemo(() => computeKpis(filtered), [filtered]);
  const curve = React.useMemo(() => equityCurve(filtered), [filtered]);
  const daily = React.useMemo(() => Object.fromEntries(dailyPnl(filtered)), [filtered]);
  const segStats = React.useMemo(() => bySegment(filtered), [filtered]);
  const setupStats = React.useMemo(() => bySetup(filtered), [filtered]);

  // monthly ladder (combined)
  const monthly = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const [d, v] of Object.entries(daily)) {
      const key = d.slice(0, 7);
      m.set(key, (m.get(key) ?? 0) + v);
    }
    return [...m.entries()].sort().map(([month, net]) => ({ month, net }));
  }, [daily]);

  const exportColumns = [
    { key: "sellDate", label: "Date" },
    { key: "symbol", label: "Symbol" },
    { key: "broker", label: "Broker" },
    { key: "segment", label: "Segment", value: (r: DashTrade) => SEGMENT_LABELS[r.segment as Segment] ?? r.segment },
    { key: "bucket", label: "Bucket" },
    { key: "exchange", label: "Exchange" },
    { key: "grossPnl", label: "Gross" },
    { key: "chargesTotal", label: "Charges" },
    { key: "netPnl", label: "Net" },
    { key: "rMultiple", label: "R" },
  ];

  return (
    <div className="space-y-5">
      {/* Filter bar */}
      <div className="sticky top-[57px] z-[5] -mx-6 flex flex-wrap items-center gap-2 border-b border-border bg-background/90 px-6 py-2 backdrop-blur">
        <Select value={broker} onChange={(e) => setBroker(e.target.value)} className="h-8 w-32">
          <option value="">All brokers</option>
          {BROKERS.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
        </Select>
        <Select value={bucket} onChange={(e) => setBucket(e.target.value)} className="h-8 w-40">
          <option value="">Both buckets</option>
          {BUCKETS.map((b) => <option key={b} value={b}>{BUCKET_LABELS[b]}</option>)}
        </Select>
        <Select value={segment} onChange={(e) => setSegment(e.target.value)} className="h-8 w-44">
          <option value="">All segments</option>
          {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36" title="From" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36" title="To" />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{k.closedCount} closed · {k.openCount} open</span>
          <ExportButtons filename="vyuha-trades" columns={exportColumns} rows={filtered} />
        </div>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Net P&L" value={inr(k.netPnl, { decimals: 0 })} valueClassName={k.netPnl >= 0 ? "text-profit" : "text-loss"} sub={`Gross ${inrCompact(k.grossPnl)}`} />
        <KpiCard label="Total charges" value={inr(k.charges, { decimals: 0 })} valueClassName="text-warning" sub={`${k.chargePctOfGross}% of gross`} />
        <KpiCard label="Win rate" value={`${(k.winRate * 100).toFixed(1)}%`} sub={`${k.wins}W / ${k.losses}L`} />
        <KpiCard label="Profit factor" value={k.profitFactor === Infinity ? "∞" : k.profitFactor.toFixed(2)} sub={`Expectancy ${inrCompact(k.expectancy)}`} />
        <KpiCard label="Avg R" value={k.avgR == null ? "—" : `${k.avgR.toFixed(2)}R`} sub={`Max DD ${inrCompact(k.maxDrawdown)}`} />
      </section>

      {/* Equity curve + monthly ladder */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Equity curve {bucket && <span className="text-muted-foreground">· {BUCKET_LABELS[bucket as never]}</span>}</CardTitle>
            <Badge variant="secondary">Max DD {inrCompact(k.maxDrawdown)}</Badge>
          </CardHeader>
          <CardContent>
            {curve.length > 0 ? <EquityCurve data={curve} /> : <Empty />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Monthly target ladder (combined)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {monthly.length === 0 && <Empty />}
            {monthly.map((m) => (
              <MonthLadder key={m.month} month={m.month} net={m.net} base={monthlyBase} stretch={monthlyStretch} />
            ))}
          </CardContent>
        </Card>
      </section>

      {/* Calendar heatmap */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Daily P&L calendar</CardTitle>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="inline-block size-3 rounded" style={{ background: "color-mix(in oklab, var(--color-loss) 70%, transparent)" }} /> loss
            <span className="inline-block size-3 rounded" style={{ background: "color-mix(in oklab, var(--color-profit) 70%, transparent)" }} /> profit
          </div>
        </CardHeader>
        <CardContent><CalendarHeatmap daily={daily} /></CardContent>
      </Card>

      {/* By segment / setup */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Net P&L by segment</CardTitle></CardHeader>
          <CardContent>{segStats.length ? <SegmentBars data={segStats} labelFor={(kk) => SEGMENT_LABELS[kk as Segment] ?? kk} /> : <Empty />}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Net P&L by setup tag</CardTitle></CardHeader>
          <CardContent>{setupStats.length ? <SegmentBars data={setupStats} labelFor={(kk) => kk} /> : <Empty />}</CardContent>
        </Card>
      </section>

      {/* Streaks + charge leak */}
      <section className="grid gap-4 sm:grid-cols-3">
        <KpiCard label="Current streak" value={k.currentStreak === 0 ? "—" : `${Math.abs(k.currentStreak)} ${k.currentStreak > 0 ? "wins" : "losses"}`} valueClassName={k.currentStreak > 0 ? "text-profit" : k.currentStreak < 0 ? "text-loss" : ""} sub={`Best ${k.maxWinStreak}W · Worst ${k.maxLossStreak}L`} />
        <KpiCard label="Avg win / loss" value={`${inrCompact(k.avgWin)} / ${inrCompact(k.avgLoss)}`} sub="per closed trade" />
        <KpiCard label="Charges leak" value={`${k.chargePctOfGross}%`} valueClassName="text-warning" sub={`${inr(k.charges, { decimals: 0 })} paid`} />
      </section>
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

function Empty() {
  return <div className="py-8 text-center text-sm text-muted-foreground">No data for the current filters.</div>;
}
