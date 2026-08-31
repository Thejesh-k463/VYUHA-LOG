"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { RBucket } from "@/lib/analytics/win-loss";

/**
 * Winners-vs-losers charts. Recharts, not canvas: these can reach paper, and
 * the print palette re-themes SVG through the CSS custom properties referenced
 * below (the repo's chart convention — see components/dashboard/charts.tsx).
 */

const axis = { fontSize: 10, fill: "var(--color-muted-foreground)" };

/**
 * Win rate vs payoff against the breakeven curve w = 1/(1+p). Everything above
 * the curve made money per trade before position sizing; the reference lines at
 * payoff 1 and win rate 50% are the quadrant axes the verdict uses.
 */
export function QuadrantScatter({ payoff, winRatePct }: { payoff: number; winRatePct: number }) {
  const xMax = Math.max(3, Math.ceil(payoff * 1.5));
  const curve: { p: number; be: number }[] = [];
  for (let p = 0.05; p <= xMax + 1e-9; p += 0.05) {
    curve.push({ p: Math.round(p * 100) / 100, be: Math.round((100 / (1 + p)) * 100) / 100 });
  }
  const book = [{ p: Math.round(payoff * 100) / 100, w: Math.round(winRatePct * 100) / 100 }];

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={curve} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
        <XAxis
          type="number"
          dataKey="p"
          domain={[0, xMax]}
          tick={axis}
          tickLine={false}
          axisLine={false}
          label={{ value: "payoff (avg win ÷ avg loss)", position: "insideBottom", offset: -2, fontSize: 10, fill: "var(--color-muted-foreground)" }}
        />
        <YAxis
          type="number"
          domain={[0, 100]}
          tick={axis}
          tickLine={false}
          axisLine={false}
          width={36}
          tickFormatter={(v) => `${v}%`}
        />
        <Tooltip
          cursor={{ stroke: "var(--color-muted)", strokeDasharray: "4 3", strokeWidth: 1 }}
          contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 11 }}
        />
        <ReferenceLine x={1} stroke="var(--color-border)" strokeDasharray="4 3" />
        <ReferenceLine y={50} stroke="var(--color-border)" strokeDasharray="4 3" />
        <Line isAnimationActive={false} type="monotone" dataKey="be" name="breakeven w = 1/(1+p)" stroke="var(--color-muted-foreground)" strokeWidth={1.5} dot={false} />
        <Scatter data={book} dataKey="w" name="your book" fill="var(--color-primary)" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/**
 * R distribution split by PROVENANCE. The two series measure different things
 * and are labelled so: plan-derived R is adherence to a recorded stop;
 * default-cap R is just net P&L over the per-trade cap and says nothing about
 * a plan. The caller renders the explainer line beside this chart.
 */
export function RHistogram({ buckets }: { buckets: RBucket[] }) {
  const data = buckets.map((b) => ({ label: b.label, plan: b.plan, defaultCap: b.defaultCap }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={{ ...axis, fontSize: 9 }} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={48} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: "var(--color-card-hover)", opacity: 0.4 }}
          contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 11 }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar isAnimationActive={false} dataKey="plan" name="plan-derived R" fill="var(--color-primary)" radius={[2, 2, 0, 0]} />
        <Bar isAnimationActive={false} dataKey="defaultCap" name="default-cap R" fill="var(--color-warning)" fillOpacity={0.7} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
