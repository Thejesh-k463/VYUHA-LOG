import * as React from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Tiny dependency-free sparkline — pure SVG so it renders in server components. */
function Sparkline({ points, positive }: { points: number[]; positive: boolean }) {
  if (points.length < 2) return null;
  const w = 72;
  const h = 26;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const xy = points.map((p, i) => `${(i * step).toFixed(1)},${(h - 2 - ((p - min) / span) * (h - 4)).toFixed(1)}`);
  const color = positive ? "var(--color-profit)" : "var(--color-loss)";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <defs>
        <linearGradient id={`spark-${positive ? "p" : "n"}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${xy.join(" ")} ${w},${h}`} fill={`url(#spark-${positive ? "p" : "n"})`} />
      <polyline points={xy.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export interface KpiDelta {
  value: number; // signed change (display sign comes from this)
  label: string; // e.g. "vs last week"
  /** Formatted magnitude, e.g. "₹12.4K" — sign/arrow are added automatically. */
  formatted: string;
}

export function KpiCard({
  label,
  value,
  sub,
  valueClassName,
  icon,
  spark,
  delta,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClassName?: string;
  icon?: React.ReactNode;
  /** Optional trend series — rendered as a small area sparkline on the right. */
  spark?: number[];
  /** Optional ▲/▼ change chip under the value. */
  delta?: KpiDelta;
}) {
  const sparkPositive = spark && spark.length >= 2 ? spark[spark.length - 1] >= spark[0] : true;
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </div>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
        <div className={cn("mt-2 whitespace-nowrap font-mono text-[1.65rem] font-light leading-none tracking-tight tabular-nums", valueClassName)}>
          {value}
        </div>
        {spark && <Sparkline points={spark} positive={sparkPositive} />}
      </div>
      {delta && (
        <div className="mt-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
              delta.value > 0 && "bg-profit/10 text-profit",
              delta.value < 0 && "bg-loss/10 text-loss",
              delta.value === 0 && "bg-card-hover text-muted-foreground",
            )}
          >
            {delta.value > 0 ? "▲" : delta.value < 0 ? "▼" : "—"} {delta.formatted}
            <span className="font-normal text-muted-foreground">{delta.label}</span>
          </span>
        </div>
      )}
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}
