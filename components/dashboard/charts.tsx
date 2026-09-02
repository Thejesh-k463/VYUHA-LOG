"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EquityPoint, GroupStat } from "@/lib/analytics/metrics";
import { inrCompact, inr } from "@/lib/format";

const axis = { fontSize: 10, fill: "var(--color-muted-foreground)" };

interface ChartTooltipPayloadItem {
  dataKey?: string | number;
  name?: string;
  value?: number;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: ChartTooltipPayloadItem[];
  label?: string | number;
  fmt?: (value: number) => string;
}

function ChartTooltip({ active, payload, label, fmt }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-lg">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground capitalize">{p.name}</span>
          <span className="tabular-nums">{fmt && p.value != null ? fmt(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

export function EquityCurve({ data }: { data: EquityPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => inrCompact(v)} />
        {/* C3 — crosshair cursor. The 700ms mount draw-in was retired
            (2026-08-29): force-dynamic routes remount charts on every
            navigation, so the sweep replayed each visit and cost main-thread
            time exactly when the page should feel settled. */}
        <Tooltip
          content={<ChartTooltip fmt={(v: number) => inr(v, { decimals: 0 })} />}
          cursor={{ stroke: "var(--color-muted)", strokeDasharray: "4 3", strokeWidth: 1 }}
        />
        <ReferenceLine y={0} stroke="var(--color-border)" />
        <Area isAnimationActive={false} type="monotone" dataKey="cum" name="Cumulative" stroke="var(--color-primary)" strokeWidth={2} fill="url(#eq)" />
        <Area isAnimationActive={false} type="monotone" dataKey="drawdown" name="Drawdown" stroke="var(--color-loss)" strokeWidth={1} fill="var(--color-loss)" fillOpacity={0.12} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export interface UnderwaterPoint {
  date: string;
  ddPct: number; // drawdown as a NEGATIVE percentage (0 at highs)
}

/** Underwater curve — how deep below the running peak the equity sat, day by day. */
export function UnderwaterCurve({ data }: { data: UnderwaterPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="uw" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-loss)" stopOpacity={0.05} />
            <stop offset="100%" stopColor="var(--color-loss)" stopOpacity={0.45} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}%`} />
        <Tooltip content={<ChartTooltip fmt={(v: number) => `${v.toFixed(2)}%`} />} />
        <ReferenceLine y={0} stroke="var(--color-border)" />
        <Area isAnimationActive={false} type="monotone" dataKey="ddPct" name="Drawdown" stroke="var(--color-loss)" strokeWidth={1.5} fill="url(#uw)" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export interface CapitalPoint {
  date: string;
  equity: number | null;
  active: number | null;
}

/** Goal reference lines drawn over the capital chart, keyed to their series. */
export interface CapitalTargets {
  equity?: number | null;
  active?: number | null;
}

/** Capital checkpoints over time (from capital_snapshots) — stepped, per bucket. */
export function CapitalGrowth({ data, targets }: { data: CapitalPoint[]; targets?: CapitalTargets }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis
          tick={axis}
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v) => inrCompact(v)}
          // The domain must reach an above-history target, or the goal line
          // clips off the top of the chart and quietly disappears.
          domain={[
            "auto",
            (dataMax: number) => Math.max(dataMax, targets?.equity ?? 0, targets?.active ?? 0),
          ]}
        />
        {/* Goal lines wear their SERIES' colour (CSS variables — print-safe via
            the @media print palette, same rule as every recharts stroke here),
            dashed so a target reads as an aim, not a reading. */}
        {targets?.equity != null && targets.equity > 0 && (
          <ReferenceLine
            y={targets.equity}
            stroke="var(--color-primary)"
            strokeDasharray="6 4"
            label={{ value: `Equity goal ${inrCompact(targets.equity)}`, position: "insideTopRight", fill: "var(--color-primary)", fontSize: 10 }}
          />
        )}
        {targets?.active != null && targets.active > 0 && (
          <ReferenceLine
            y={targets.active}
            stroke="var(--color-accent)"
            strokeDasharray="6 4"
            label={{ value: `F&O goal ${inrCompact(targets.active)}`, position: "insideBottomRight", fill: "var(--color-accent)", fontSize: 10 }}
          />
        )}
        <Tooltip content={<ChartTooltip fmt={(v: number) => inr(v, { decimals: 0 })} />} />
        <Area isAnimationActive={false} type="stepAfter" dataKey="equity" name="Equity" connectNulls stroke="var(--color-primary)" strokeWidth={2} fill="var(--color-primary)" fillOpacity={0.08} dot={{ r: 3 }} />
        {/* --color-accent, NOT --color-profit: this series is CAPITAL, and the
            palette's own law reserves the P&L green for P&L (globals.css §
            colour roles; 2026-08-10 audit). Equity=teal, F&O=violet — the same
            pairing the analytics screens use. */}
        <Area isAnimationActive={false} type="stepAfter" dataKey="active" name="Trade F&O" connectNulls stroke="var(--color-accent)" strokeWidth={2} fill="var(--color-accent)" fillOpacity={0.08} dot={{ r: 3 }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function SegmentBars({ data, labelFor }: { data: GroupStat[]; labelFor: (k: string) => string }) {
  const rows = data.map((d) => ({ ...d, label: labelFor(d.key) }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 34)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={(v) => inrCompact(v)} />
        <YAxis type="category" dataKey="label" tick={axis} tickLine={false} axisLine={false} width={110} />
        <Tooltip content={<ChartTooltip fmt={(v: number) => inr(v, { decimals: 0 })} />} cursor={{ fill: "var(--color-card-hover)" }} />
        <ReferenceLine x={0} stroke="var(--color-border)" />
        <Bar isAnimationActive={false} dataKey="net" name="Net P&L" radius={[0, 3, 3, 0]}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.net >= 0 ? "var(--color-profit)" : "var(--color-loss)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
