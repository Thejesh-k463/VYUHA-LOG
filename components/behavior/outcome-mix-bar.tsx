"use client";

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { OutcomeSlice } from "@/lib/analytics/options-seller";

/**
 * Outcome mix as ONE stacked horizontal bar — every seller contract lands in
 * exactly one outcome, so the bar is a true partition and its widths mean
 * something. Recharts (SVG) rather than canvas so it survives the print
 * palette; colours are literal hex from `OUTCOME_COLORS`, never `var()`,
 * because chart tokens must be parseable literals (tests/skin.test.ts).
 *
 * Props are plain data so a server component can render this directly.
 */
export function OutcomeMixBar({ slices, height = 28 }: { slices: OutcomeSlice[]; height?: number }) {
  const total = slices.reduce((s, o) => s + o.count, 0);
  if (!total) return null;
  const datum: Record<string, number | string> = { name: "mix" };
  for (const s of slices) datum[s.key] = s.count;
  return (
    <div className="space-y-2">
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={[datum]} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
            <XAxis type="number" hide domain={[0, total]} />
            <YAxis type="category" dataKey="name" hide />
            <Tooltip
              cursor={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-lg">
                    {payload.map((p) => {
                      const v = typeof p.value === "number" ? p.value : 0;
                      const slice = slices.find((s) => s.key === p.dataKey);
                      return (
                        <div key={String(p.dataKey)} className="flex items-center justify-between gap-3">
                          <span className="flex items-center gap-1.5 capitalize text-muted-foreground">
                            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: slice?.color }} />
                            {slice?.label ?? String(p.dataKey)}
                          </span>
                          <span className="tabular-nums">{v} · {Math.round((v / total) * 1000) / 10}%</span>
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            />
            {slices.filter((s) => s.count > 0).map((s, i, arr) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="mix"
                fill={s.color}
                isAnimationActive={false}
                radius={arr.length === 1 ? 4 : i === 0 ? [4, 0, 0, 4] : i === arr.length - 1 ? [0, 4, 4, 0] : 0}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-muted-foreground">
        {slices.filter((s) => s.count > 0).map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 capitalize">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label} <span className="tabular-nums text-foreground">{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
