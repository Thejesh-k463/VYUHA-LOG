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
        <Tooltip content={<ChartTooltip fmt={(v: number) => inr(v, { decimals: 0 })} />} />
        <ReferenceLine y={0} stroke="var(--color-border)" />
        <Area isAnimationActive={false} type="monotone" dataKey="cum" name="Cumulative" stroke="var(--color-primary)" strokeWidth={2} fill="url(#eq)" />
        <Area isAnimationActive={false} type="monotone" dataKey="drawdown" name="Drawdown" stroke="var(--color-loss)" strokeWidth={1} fill="var(--color-loss)" fillOpacity={0.12} />
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
