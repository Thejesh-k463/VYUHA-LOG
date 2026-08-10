"use client";
/**
 * EOD price replay for one staged position, on lightweight-charts v5.
 *
 * Shows exactly what the recharts version it replaced showed: the close line,
 * a marker at every recorded fill, and the planned stop-loss / target as
 * horizontal reference lines. Markers and reference lines use the library's own
 * `createSeriesMarkers` / `createPriceLine` rather than hand-drawn overlays, so
 * they stay pinned through zoom and pan.
 *
 * Load it with `next/dynamic(..., { ssr: false })` from a client component.
 * lightweight-charts touches `document` as soon as a chart is created, and every
 * DB-backed page here is `force-dynamic` — so an accidental server import would
 * NOT fail `next build` (nothing prerenders it) and would instead 500 the route
 * at request time.
 */
import { useCallback, useMemo, useRef } from "react";
import {
  LineSeries,
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type LineData,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { fmtDate, num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { type LwTheme } from "./theme";
import { useLwChart } from "./use-lw-chart";

export interface ReplayBar {
  date: string;
  close: number;
}

export interface ReplayFill {
  id: number;
  kind: string;
  tradeDate: string;
  price: number;
  qty: number;
}

export interface PriceReplayChartProps {
  /** EOD closes, ISO `YYYY-MM-DD`. Need not be sorted or deduplicated. */
  bars: ReplayBar[];
  /** Recorded fills. `kind` is "entry" for anything that is not an exit. */
  legs: ReplayFill[];
  /** Planned stop-loss level, in rupees per unit. */
  stop: number | null;
  /** Planned target level, in rupees per unit. */
  target: number | null;
  className?: string;
}

interface MarkerSpec {
  time: Time;
  entry: boolean;
  text: string;
}

/**
 * `setData` asserts strictly ascending, unique times — SQLite hands rows back in
 * rowid order, which is insertion order, not date order. Sorting and collapsing
 * duplicates here is what stops a re-imported bhavcopy from throwing inside the
 * chart. Last row wins on a duplicate date, matching a re-import overwriting a
 * previous close.
 */
function toLinePoints(bars: ReplayBar[]): LineData<Time>[] {
  const byDate = new Map<string, number>();
  for (const b of bars) if (Number.isFinite(b.close)) byDate.set(b.date, b.close);
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, close]) => ({ time: date as Time, value: close }));
}

/** Formats whichever shape the library hands back for a point's time. */
function timeLabel(time: Time | undefined): string {
  if (time == null) return "";
  if (typeof time === "string") return fmtDate(time);
  if (typeof time === "number") return fmtDate(new Date(time * 1000).toISOString().slice(0, 10));
  return fmtDate(`${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`);
}

export default function PriceReplayChart({ bars, legs, stop, target, className }: PriceReplayChartProps) {
  const legendRef = useRef<HTMLSpanElement | null>(null);

  const points = useMemo(() => toLinePoints(bars), [bars]);

  const markerSpecs = useMemo<MarkerSpec[]>(
    () =>
      legs
        .map((l) => {
          const entry = l.kind !== "exit";
          return {
            time: l.tradeDate as Time,
            entry,
            text: `${entry ? "+" : "-"}${l.qty} @ ${num(l.price)}`,
          };
        })
        .sort((a, b) => (String(a.time) < String(b.time) ? -1 : String(a.time) > String(b.time) ? 1 : 0)),
    [legs],
  );

  const build = useCallback(
    (chart: IChartApi, theme: LwTheme) => {
      const markersFor = (t: LwTheme): SeriesMarker<Time>[] =>
        markerSpecs.map((m) => ({
          time: m.time,
          position: m.entry ? "belowBar" : "aboveBar",
          shape: m.entry ? "arrowUp" : "arrowDown",
          color: m.entry ? t.profit : t.loss,
          text: m.text,
        }));

      const series = chart.addSeries(LineSeries, {
        color: theme.primary,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerBorderColor: theme.primary,
        crosshairMarkerBackgroundColor: theme.primary,
        // Per-unit prices are REAL rupees end to end — no paise conversion here.
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      });
      series.setData(points);

      const markers = createSeriesMarkers(series, markersFor(theme));

      const levels: { line: IPriceLine; profit: boolean }[] = [];
      const addLevel = (price: number, title: string, profit: boolean) =>
        levels.push({
          line: series.createPriceLine({
            price,
            color: profit ? theme.profit : theme.loss,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title,
          }),
          profit,
        });
      if (stop != null) addLevel(stop, "SL", false);
      if (target != null) addLevel(target, "Target", true);

      const last = points[points.length - 1];
      const paint = (time: Time | undefined, value: number | undefined) => {
        const el = legendRef.current;
        if (!el) return;
        el.textContent = value == null ? "" : `${timeLabel(time)} · ${num(value)}`;
      };
      paint(last?.time, last?.value);
      chart.subscribeCrosshairMove((param) => {
        const hovered = param.time == null ? undefined : param.seriesData.get(series);
        if (hovered && "value" in hovered && typeof hovered.value === "number") paint(param.time, hovered.value);
        else paint(last?.time, last?.value);
      });

      chart.timeScale().fitContent();

      return (next: LwTheme) => {
        series.applyOptions({
          color: next.primary,
          crosshairMarkerBorderColor: next.primary,
          crosshairMarkerBackgroundColor: next.primary,
        });
        markers.setMarkers(markersFor(next));
        for (const l of levels) l.line.applyOptions({ color: l.profit ? next.profit : next.loss });
      };
    },
    [points, markerSpecs, stop, target],
  );

  const containerRef = useLwChart(build);

  return (
    <div className={cn("relative h-80 w-full", className)} data-testid="price-replay-chart">
      <div ref={containerRef} className="absolute inset-0" />
      <span
        ref={legendRef}
        className="pointer-events-none absolute left-2 top-1 z-10 rounded-md bg-card/70 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground"
      />
    </div>
  );
}
