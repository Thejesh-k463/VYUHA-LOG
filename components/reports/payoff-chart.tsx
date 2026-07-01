"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { inr, inrCompact } from "@/lib/format";

const axis = { fontSize: 10, fill: "var(--color-muted-foreground)" };

interface TipProps {
  active?: boolean;
  payload?: { value?: number }[];
  label?: string | number;
}

function Tip({ active, payload, label }: TipProps) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value ?? 0;
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-lg">
      <div className="mb-1 font-medium">@ {inrCompact(Number(label))}</div>
      <div className={v >= 0 ? "text-profit" : "text-loss"}>{inr(v, { decimals: 0 })}</div>
    </div>
  );
}

export function PayoffChart({
  data,
  breakevens = [],
  spot,
}: {
  data: { price: number; pnl: number }[];
  breakevens?: number[];
  spot?: number | null;
}) {
  const max = Math.max(...data.map((d) => d.pnl), 0);
  const min = Math.min(...data.map((d) => d.pnl), 0);
  const off = max <= 0 ? 0 : min >= 0 ? 1 : max / (max - min);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="pfFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset={off} stopColor="var(--color-profit)" stopOpacity={0.32} />
            <stop offset={off} stopColor="var(--color-loss)" stopOpacity={0.32} />
          </linearGradient>
          <linearGradient id="pfLine" x1="0" y1="0" x2="0" y2="1">
            <stop offset={off} stopColor="var(--color-profit)" stopOpacity={1} />
            <stop offset={off} stopColor="var(--color-loss)" stopOpacity={1} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="price"
          type="number"
          domain={["dataMin", "dataMax"]}
          tick={axis}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => inrCompact(v)}
          minTickGap={40}
        />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => inrCompact(v)} />
        <Tooltip content={<Tip />} />
        <ReferenceLine y={0} stroke="var(--color-border)" />
        {breakevens.map((b) => (
          <ReferenceLine
            key={b}
            x={b}
            stroke="var(--color-muted-foreground)"
            strokeDasharray="2 2"
            label={{ value: Math.round(b), fontSize: 9, fill: "var(--color-muted-foreground)", position: "top" }}
          />
        ))}
        {spot != null ? (
          <ReferenceLine
            x={spot}
            stroke="var(--color-accent)"
            strokeDasharray="4 2"
            label={{ value: "spot", fontSize: 9, fill: "var(--color-accent)", position: "insideTopRight" }}
          />
        ) : null}
        <Area isAnimationActive={false} type="linear" dataKey="pnl" stroke="url(#pfLine)" strokeWidth={2} fill="url(#pfFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
