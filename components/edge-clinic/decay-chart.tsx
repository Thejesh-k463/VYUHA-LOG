"use client";

import { Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { DECAY_CHART_HEIGHT } from "./decay-chart-height";

/**
 * v4.8.0 F1 — the decay card's small line (owner-picked design "N1"): the engine's
 * rolling-mean trace, the usual mean as a dashed level, and — only when the CUSUM
 * alarmed — the stretch from the alarm trade in the loss colour behind a dashed
 * marker. recharts, not canvas: the Clinic report prints, and the print palette
 * re-themes SVG through the CSS custom properties below (AGENTS.md, "Charts that
 * reach paper stay recharts"). No colour is written any other way.
 *
 * It draws; it decides nothing. Whether the cell alarmed, and from which trade, is
 * the engine's `decay.cusum` — the card passes `splitAt` or null.
 */

export interface DecayChartRow {
  /** Trade number (1-based) — the last trade of the window this point averages. */
  t: number;
  /** The mean on the stretch before `splitAt` (the whole line when nothing alarmed). */
  usual: number | null;
  /** The mean on the stretch from `splitAt` on; null everywhere when nothing alarmed. */
  recent: number | null;
}

/**
 * The trace as chart rows, split into two series at trade `splitAt` (null = one
 * series). The two series must MEET, or the line shows a gap: a trace point at
 * exactly `splitAt` belongs to both; when the down-sampled trace has none, one
 * joining row is added there ON the straight segment between its neighbours — the
 * same pixels a single line draws, so the join changes the colour and nothing else.
 */
export function decayChartRows(trace: readonly (readonly [number, number])[], splitAt: number | null): DecayChartRow[] {
  if (splitAt == null) return trace.map(([t, m]) => ({ t, usual: m, recent: null }));
  const rows: DecayChartRow[] = [];
  for (let i = 0; i < trace.length; i++) {
    const [t, m] = trace[i];
    if (i > 0) {
      const [t0, m0] = trace[i - 1];
      if (t0 < splitAt && t > splitAt) {
        const at = m0 + ((m - m0) * (splitAt - t0)) / (t - t0);
        rows.push({ t: splitAt, usual: at, recent: at });
      }
    }
    rows.push(t < splitAt ? { t, usual: m, recent: null } : t === splitAt ? { t, usual: m, recent: m } : { t, usual: null, recent: m });
  }
  return rows;
}

export function DecayChart({
  trace,
  usualMean,
  splitAt,
}: {
  trace: readonly (readonly [number, number])[];
  usualMean: number;
  /** The alarm trade (1-based) when the CUSUM alarmed, else null. */
  splitAt: number | null;
}) {
  const rows = decayChartRows(trace, splitAt);
  const last = trace.length ? trace[trace.length - 1] : null;
  return (
    <ResponsiveContainer width="100%" height={DECAY_CHART_HEIGHT}>
      <LineChart data={rows} margin={{ top: 6, right: 6, bottom: 6, left: 6 }}>
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} hide />
        <YAxis type="number" domain={["auto", "auto"]} hide />
        <ReferenceLine y={usualMean} stroke="var(--color-muted)" strokeDasharray="4 3" ifOverflow="extendDomain" />
        {splitAt != null ? <ReferenceLine x={splitAt} stroke="var(--color-warning)" strokeDasharray="3 3" /> : null}
        <Line isAnimationActive={false} type="linear" dataKey="usual" stroke="var(--color-primary)" strokeWidth={1.5} dot={false} activeDot={false} />
        {splitAt != null ? (
          <Line isAnimationActive={false} type="linear" dataKey="recent" stroke="var(--color-loss)" strokeWidth={1.5} dot={false} activeDot={false} />
        ) : null}
        {last ? (
          <ReferenceDot x={last[0]} y={last[1]} r={3} stroke="none" fill={splitAt != null ? "var(--color-loss)" : "var(--color-primary)"} />
        ) : null}
      </LineChart>
    </ResponsiveContainer>
  );
}
