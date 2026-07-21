"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { KpiCard } from "@/components/kpi-card";
import { CountUp } from "@/components/ui/count-up";
import { EmptyState } from "@/components/ui/empty-state";
import { ExportButtons } from "@/components/ui/export-button";
import { EquityCurve, SegmentBars } from "./charts";
import { CalendarHeatmap } from "./calendar-heatmap";
import {
  computeKpis, equityCurve, dailyPnl, bySegment, bySetup,
  type AnalyticsTrade,
} from "@/lib/analytics/metrics";
import { inr, inrCompact } from "@/lib/format";
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

  // C4 — sparkline (last 30 equity points) + week-over-week net delta.
  const spark = React.useMemo(() => curve.slice(-30).map((p) => p.cum), [curve]);
  const weekDelta = React.useMemo(() => {
    const dates = Object.keys(daily).sort();
    if (dates.length === 0) return null;
    const latest = new Date(dates[dates.length - 1] + "T00:00:00");
    const cutoff = (d: number) => {
      const x = new Date(latest);
      x.setDate(x.getDate() - d);
      return x.toISOString().slice(0, 10);
    };
    const wk1 = cutoff(7);
    const wk2 = cutoff(14);
    let thisWeek = 0;
    let lastWeek = 0;
    for (const [d, v] of Object.entries(daily)) {
      if (d > wk1) thisWeek += v;
      else if (d > wk2) lastWeek += v;
    }
    const value = Math.round(thisWeek - lastWeek);
    return { value, label: "vs prior wk", formatted: inrCompact(Math.abs(value)) };
  }, [daily]);

  // Drill-down inputs for the KPI popups (click any card).
  const dayStats = React.useMemo(() => {
    const entries = Object.entries(daily);
    if (entries.length === 0) return { best: 0, worst: 0, bestDate: null as string | null, worstDate: null as string | null };
    let best = entries[0];
    let worst = entries[0];
    for (const e of entries) {
      if (e[1] > best[1]) best = e;
      if (e[1] < worst[1]) worst = e;
    }
    return { best: best[1], worst: worst[1], bestDate: best[0], worstDate: worst[0] };
  }, [daily]);

  const { grossWins, grossLosses } = React.useMemo(() => {
    let w = 0;
    let l = 0;
    for (const t of filtered) {
      if (t.isOpen) continue;
      if (t.netPnl > 0) w += t.netPnl;
      else if (t.netPnl < 0) l += t.netPnl;
    }
    return { grossWins: w, grossLosses: l };
  }, [filtered]);

  const rStats = React.useMemo(() => {
    const rs = filtered.filter((t) => !t.isOpen && t.rMultiple != null).map((t) => t.rMultiple as number);
    return {
      count: rs.length,
      best: rs.length ? Math.max(...rs) : null,
      worst: rs.length ? Math.min(...rs) : null,
    };
  }, [filtered]);

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

      {/* KPIs — count-up, sparkline, delta chip (C4) and click-through drill-downs */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
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
              { label: "Best day", value: inr(dayStats.best, { decimals: 0 }), tone: "profit", hint: dayStats.bestDate ?? undefined },
              { label: "Worst day", value: inr(dayStats.worst, { decimals: 0 }), tone: "loss", hint: dayStats.worstDate ?? undefined },
              { label: "Closed / open", value: `${k.closedCount} / ${k.openCount}` },
            ],
            note: "Open positions contribute unrealised P&L on the trackers, not here — this is realised money only.",
          }}
        />
        <KpiCard
          label="Total charges"
          value={<CountUp value={k.charges} />}
          valueClassName="text-warning"
          sub={`${k.chargePctOfGross}% of gross`}
          detail={{
            title: "Charges — the silent tax on your edge",
            summary: "Computed per broker × segment × exchange from your editable rate table.",
            rows: [
              { label: "Total charges", value: inr(k.charges, { decimals: 0 }), tone: "loss" },
              { label: "As % of gross P&L", value: `${k.chargePctOfGross}%`, hint: "past ~30% costs are eating the edge" },
              { label: "Avg per closed trade", value: k.closedCount ? inr(k.charges / k.closedCount, { decimals: 0 }) : "—" },
              { label: "Gross P&L before charges", value: inr(k.grossPnl, { decimals: 0 }), tone: k.grossPnl >= 0 ? "profit" : "loss" },
              { label: "What you kept", value: inr(k.netPnl, { decimals: 0 }), tone: k.netPnl >= 0 ? "profit" : "loss" },
            ],
            note: "Charges & MTF Leak breaks this down by charge type and finds the biggest leak.",
          }}
        />
        <KpiCard
          label="Win rate"
          value={<CountUp value={k.winRate * 100} decimals={1} format="plain" suffix="%" />}
          sub={`${k.wins}W / ${k.losses}L`}
          detail={{
            title: "Win rate — and why it isn't the whole story",
            summary: "A low win rate with big winners beats a high win rate with big losers.",
            rows: [
              { label: "Wins", value: `${k.wins}`, tone: "profit" },
              { label: "Losses", value: `${k.losses}`, tone: "loss" },
              { label: "Win rate", value: `${(k.winRate * 100).toFixed(1)}%` },
              { label: "Average win", value: inr(k.avgWin, { decimals: 0 }), tone: "profit" },
              { label: "Average loss", value: inr(k.avgLoss, { decimals: 0 }), tone: "loss" },
              { label: "Win / loss size ratio", value: k.avgLoss !== 0 ? `${Math.abs(k.avgWin / k.avgLoss).toFixed(2)}×` : "—", hint: "how many losses one win pays for" },
            ],
            note: "Expectancy — win rate and win size together — is the number that actually compounds.",
          }}
        />
        <KpiCard
          label="Profit factor"
          value={k.profitFactor === Infinity ? "∞" : <CountUp value={k.profitFactor} decimals={2} format="plain" />}
          sub={`Expectancy ${inrCompact(k.expectancy)}`}
          detail={{
            title: "Profit factor — gross wins ÷ gross losses",
            summary: "Above 1.0 you make money; below 1.0 the book bleeds whatever the win rate says.",
            rows: [
              { label: "Gross winnings", value: inr(grossWins, { decimals: 0 }), tone: "profit" },
              { label: "Gross losses", value: `−${inr(Math.abs(grossLosses), { decimals: 0 })}`, tone: "loss" },
              { label: "Profit factor", value: k.profitFactor === Infinity ? "∞" : k.profitFactor.toFixed(2), tone: k.profitFactor >= 1 ? "profit" : "loss" },
              { label: "Expectancy / trade", value: inr(k.expectancy, { decimals: 0 }), tone: k.expectancy >= 0 ? "profit" : "loss" },
              { label: "Closed trades", value: `${k.closedCount}`, hint: k.closedCount < 20 ? "under ~20 trades this is mostly noise" : undefined },
            ],
          }}
        />
        <KpiCard
          label="Avg R"
          value={k.avgR == null ? "—" : <CountUp value={k.avgR} decimals={2} format="plain" suffix="R" />}
          sub={`Max DD ${inrCompact(k.maxDrawdown)}`}
          detail={{
            title: "Avg R — return per unit of risk",
            summary: "R normalises every trade to the risk you planned, so position size stops distorting the picture.",
            rows: [
              { label: "Average R", value: k.avgR == null ? "—" : `${k.avgR.toFixed(2)}R`, tone: (k.avgR ?? 0) >= 0 ? "profit" : "loss" },
              { label: "Trades with R recorded", value: `${rStats.count} of ${k.closedCount}`, hint: rStats.count < k.closedCount ? "set an SL so risk (and R) gets captured" : undefined },
              { label: "Best R", value: rStats.best == null ? "—" : `${rStats.best.toFixed(2)}R`, tone: "profit" },
              { label: "Worst R", value: rStats.worst == null ? "—" : `${rStats.worst.toFixed(2)}R`, tone: "loss" },
              { label: "Max drawdown", value: inr(k.maxDrawdown, { decimals: 0 }), tone: "loss" },
              { label: "Streaks", value: `${k.maxWinStreak}W best · ${k.maxLossStreak}L worst` },
            ],
            note: "Positive avg R means your winners are bigger than the risk you took to get them.",
          }}
        />
      </section>

      {/* Equity curve + monthly ladder */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2 card-hero">
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
  return <EmptyState variant="chart" title="No data for these filters" hint="Widen the date range or clear a filter — closed trades power every chart here." />;
}
