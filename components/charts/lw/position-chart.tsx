"use client";
/**
 * The expanded position chart (spec §3.2, owner rulings Q27–Q29, Q31, Q33).
 *
 * ONE POSITION, ONE CHART. Grid cards get a line sparkline (Q28); this is the
 * candle view for the single selected row, and the only place the zone
 * primitive, the level lines and the trailing stop are drawn.
 *
 * HOW TO MOUNT IT. `next/dynamic(..., { ssr: false })` from a client component,
 * always. lightweight-charts touches `document` the moment a chart is created,
 * and every DB-backed page here is `force-dynamic` — so a server import would
 * NOT fail `next build` (nothing prerenders it) and would instead 500 the route
 * at request time, in front of a paying user.
 *
 * THREE RULES INHERITED FROM `./theme`, ALL OF WHICH FAIL SILENTLY:
 *
 *  1. Only literal colours reach the canvas. Every colour below comes from
 *     `LwTheme` or from `withAlpha()` on an `LwTheme` field. A `color-mix()`,
 *     an `oklch()` or an unresolved `var()` makes lightweight-charts draw an
 *     INVISIBLE series with no throw and no warning.
 *     `tests/position-chart-copy.test.ts` is the real gate.
 *  2. Re-theming is imperative. The hook's `MutationObserver` hands back a new
 *     theme; the returned callback re-applies it to the series, the price lines
 *     and the zone. Nothing here sets React state from an effect.
 *  3. The stop is a NUMBER THIS FILE IS GIVEN. It is computed once, in
 *     `lib/live/stop.ts`, by the panel. A stop recomputed inside a render path
 *     diverges from the journal's number and then only the chart is wrong —
 *     visibly, to a paying user, with no error anywhere (02 §9.6).
 *
 * COPY. Every string states the arithmetic and attributes the choice to the
 * user. The stop line names WHERE ITS NUMBER CAME FROM (`source` from
 * `StopResult`) — an unlabelled level is indistinguishable from one the user
 * set themselves, which is the whole of ruling Q33.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  CandlestickSeries,
  LineSeries,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PPM, type Bar, type Paise, type Ppm, type Side } from "@/lib/live/types";
import type { StopSource } from "@/lib/live/stop";
import { withAlpha, type LwTheme } from "./theme";
import { useLwChart } from "./use-lw-chart";
import { PositionZonePrimitive, type PositionZoneStyle } from "./position-zone-primitive";

/** Paise → rupees. The chart's price scale speaks rupees (invariant 1). */
const PAISE_PER_RUPEE = 100;
const rupees = (p: Paise) => p / PAISE_PER_RUPEE;

/** Tint strength of the two zones. 0.12 keeps candle bodies legible over it. */
const ZONE_ALPHA = 0.12;

export type PositionChartKind = "candles" | "line";

export interface PositionChartProps {
  symbol: string;
  /** Ascending EOD bars, paise-native. Sorting and duplicates are handled here. */
  bars: Bar[];
  side: Side;
  entryP: Paise;
  targetP: Paise | null;
  /** The computed stop, in paise. null hides the stop line AND the risk zone. */
  stopP: Paise | null;
  /** Which branch of the tree produced `stopP`, for the label. */
  stopSource: StopSource | null;
  /** `risk_pct_ppm`, only so the label can name it. null ⇒ the label says so. */
  riskPpm: Ppm | null;
  /** Wilder ATR length behind an ATR stop (21 by default — ruling Q34). */
  atrLength: number;
  /** Chandelier level, drawn dashed. null when there are too few sessions. */
  trailStopP: Paise | null;
  /** How the trail was derived, e.g. "chandelier, 22 bars × 3 ATR". */
  trailMethodLabel: string | null;
  /** True when `computeStop` returned `risk-not-set` (ruling Q33). */
  riskNotSet: boolean;
  className?: string;
}

/**
 * The stop line's label. PURE and exported so the copy guard can assert the
 * exact shape without a browser.
 *
 * Ruling Q31(b): the chart label states the arithmetic in one line; the long
 * form (a) belongs in the detail pane; the bare number (c) is never used,
 * because a level with no provenance reads as a level the user set.
 */
export function stopLineTitle(input: {
  stopP: Paise;
  source: StopSource;
  riskPpm: Ppm | null;
  atrLength: number;
}): string {
  const level = `Stop ${num(rupees(input.stopP))}`;
  // The user's own number is not "computed from" anything.
  if (input.source === "manual") return `${level} — the level you recorded`;

  const risk =
    input.riskPpm === null
      ? "your recorded risk per trade"
      : `your ${num((input.riskPpm * 100) / PPM, 2).replace(/\.00$/, "")}% risk per trade`;
  const method =
    input.source === "atr"
      ? `the ${input.atrLength}-day ATR`
      : input.source === "structure"
        ? "the swing level on this chart"
        : "your fixed percentage";
  return `${level} — computed from ${risk} and ${method}`;
}

/** The target line's label. The target is the user's number, never Vyuha's. */
export function targetLineTitle(targetP: Paise): string {
  return `Your target ${num(rupees(targetP))}`;
}

/** The trailing line's label: the method, its parameters, and the number. */
export function trailLineTitle(levelP: Paise, methodLabel: string): string {
  return `Trailing stop ${num(rupees(levelP))} — ${methodLabel}`;
}

/**
 * `setData` asserts strictly ascending, unique times, and SQLite hands rows
 * back in rowid order — insertion order, not date order. Sorting and collapsing
 * duplicates here is what stops a re-imported bhavcopy throwing inside the
 * chart. Last row wins on a duplicate date, matching a re-import overwriting a
 * close. A bar with no OHLC falls back to its close, so a close-only history
 * still draws (as four-equal candles) instead of vanishing.
 */
function toCandles(bars: Bar[]): CandlestickData<Time>[] {
  const byDate = new Map<string, Bar>();
  for (const b of bars) if (Number.isFinite(b.closeP)) byDate.set(b.date, b);
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, b]) => ({
      time: date as Time,
      open: rupees(b.openP ?? b.closeP),
      high: rupees(b.highP ?? b.closeP),
      low: rupees(b.lowP ?? b.closeP),
      close: rupees(b.closeP),
    }));
}

const toLine = (candles: CandlestickData<Time>[]): LineData<Time>[] =>
  candles.map((c) => ({ time: c.time, value: c.close }));

/** Zone tints, derived from the theme with `withAlpha` — never `color-mix()`. */
function zoneStyle(t: LwTheme): PositionZoneStyle {
  return {
    reward: withAlpha(t.profit, ZONE_ALPHA),
    risk: withAlpha(t.loss, ZONE_ALPHA),
    ladder: withAlpha(t.mutedForeground, 0.55),
    ladderText: t.mutedForeground,
    font: t.fontFamily,
  };
}

interface LevelLine {
  line: IPriceLine;
  colour: (t: LwTheme) => string;
}

export default function PositionChart(props: PositionChartProps) {
  const { symbol, bars, side, entryP, targetP, stopP, stopSource, riskPpm, atrLength, trailStopP, trailMethodLabel, riskNotSet, className } = props;
  const [kind, setKind] = useState<PositionChartKind>("candles");
  const readoutRef = useRef<HTMLSpanElement | null>(null);

  const candles = useMemo(() => toCandles(bars), [bars]);
  const linePoints = useMemo(() => toLine(candles), [candles]);

  // The risk-not-set state hides the stop, the risk zone and the ladder. There
  // is no stop to draw, and a zone drawn to a level nobody configured would be
  // a claim about the user's risk (invariant 6).
  const shownStopP = riskNotSet ? null : stopP;

  const build = useCallback(
    (chart: IChartApi, theme: LwTheme) => {
      const priceFormat = { type: "price" as const, precision: 2, minMove: 0.01 };

      let series: ISeriesApi<SeriesType, Time>;
      let recolour: (t: LwTheme) => void;
      if (kind === "line") {
        const line = chart.addSeries(LineSeries, {
          color: theme.primary,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerBorderColor: theme.primary,
          crosshairMarkerBackgroundColor: theme.primary,
          priceFormat,
        });
        line.setData(linePoints);
        series = line;
        recolour = (t) =>
          line.applyOptions({
            color: t.primary,
            crosshairMarkerBorderColor: t.primary,
            crosshairMarkerBackgroundColor: t.primary,
          });
      } else {
        const candle = chart.addSeries(CandlestickSeries, {
          upColor: theme.profit,
          downColor: theme.loss,
          borderUpColor: theme.profit,
          borderDownColor: theme.loss,
          wickUpColor: withAlpha(theme.profit, 0.8),
          wickDownColor: withAlpha(theme.loss, 0.8),
          priceLineVisible: false,
          priceFormat,
        });
        candle.setData(candles);
        series = candle;
        recolour = (t) =>
          candle.applyOptions({
            upColor: t.profit,
            downColor: t.loss,
            borderUpColor: t.profit,
            borderDownColor: t.loss,
            wickUpColor: withAlpha(t.profit, 0.8),
            wickDownColor: withAlpha(t.loss, 0.8),
          });
      }

      // Rule 3 — the fills are a primitive, not two area series (02 §9.5): an
      // area series joins autoscaling, shows in the legend and anchors its
      // baseline to the pane bottom rather than to entry.
      const zone = new PositionZonePrimitive({
        side,
        entryP,
        targetP,
        stopP: shownStopP,
        style: zoneStyle(theme),
        showLadder: shownStopP !== null,
      });
      series.attachPrimitive(zone);

      const lines: LevelLine[] = [];
      const addLine = (price: number, title: string, colour: (t: LwTheme) => string, style: LineStyle) => {
        lines.push({
          line: series.createPriceLine({
            price,
            color: colour(theme),
            lineWidth: 1,
            lineStyle: style,
            axisLabelVisible: true,
            title,
          }),
          colour,
        });
      };

      addLine(rupees(entryP), `Entry ${num(rupees(entryP))}`, (t) => t.primary, LineStyle.Solid);
      if (targetP !== null) addLine(rupees(targetP), targetLineTitle(targetP), (t) => t.profit, LineStyle.Dashed);
      if (shownStopP !== null && stopSource !== null) {
        addLine(
          rupees(shownStopP),
          stopLineTitle({ stopP: shownStopP, source: stopSource, riskPpm, atrLength }),
          (t) => t.loss,
          LineStyle.Dashed,
        );
      }
      if (!riskNotSet && trailStopP !== null && trailMethodLabel !== null) {
        // No `--color-warning` exists in the theme bridge's TOKENS, and
        // `theme.ts` belongs to another wave this cycle; `gold` is the token
        // every skin defines for exactly this "attention, not loss" role.
        addLine(rupees(trailStopP), trailLineTitle(trailStopP, trailMethodLabel), (t) => t.gold, LineStyle.LargeDashed);
      }

      const last = candles[candles.length - 1];
      const paint = (bar: CandlestickData<Time> | undefined) => {
        const el = readoutRef.current;
        if (!el) return;
        el.textContent = bar
          ? `O ${num(bar.open)}  H ${num(bar.high)}  L ${num(bar.low)}  C ${num(bar.close)}`
          : "";
      };
      paint(last);
      chart.subscribeCrosshairMove((param) => {
        const hovered = param.time == null ? undefined : param.seriesData.get(series);
        if (hovered && "close" in hovered && typeof hovered.close === "number") {
          paint(hovered as CandlestickData<Time>);
        } else if (hovered && "value" in hovered && typeof hovered.value === "number") {
          const at = candles.find((c) => c.time === param.time);
          paint(at ?? last);
        } else {
          paint(last);
        }
      });

      chart.timeScale().fitContent();

      return (next: LwTheme) => {
        recolour(next);
        zone.applyStyle(zoneStyle(next));
        for (const l of lines) l.line.applyOptions({ color: l.colour(next) });
      };
    },
    [kind, candles, linePoints, side, entryP, targetP, shownStopP, stopSource, riskPpm, atrLength, trailStopP, trailMethodLabel, riskNotSet],
  );

  const containerRef = useLwChart(build);

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="position-chart">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-sm font-semibold">{symbol} · daily</h3>
        <span ref={readoutRef} className="text-[0.6875rem] tabular-nums text-muted-foreground" />
        <span className="ml-auto text-[0.6875rem] text-muted-foreground tabular-nums">{candles.length} sessions</span>
        <button
          type="button"
          aria-pressed={kind === "candles"}
          onClick={() => setKind((k) => (k === "candles" ? "line" : "candles"))}
          className="rounded-md border border-border px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
        >
          {kind === "candles" ? "Candles" : "Line"}
        </button>
      </div>

      <div className="relative h-96 w-full">
        <div ref={containerRef} className="absolute inset-0" />
        {riskNotSet ? (
          <div className="pointer-events-auto absolute inset-x-3 bottom-3 z-10 rounded-md border border-l-2 border-border bg-card/90 p-3 text-xs leading-relaxed">
            <b className="block font-semibold">Position size needs your risk per trade.</b>
            The stop, the risk zone and the R ladder are hidden because there is no stored risk to compute them from.{" "}
            <Link href="/sizing-lab" className="underline underline-offset-4">
              Open the Sizing Lab
            </Link>{" "}
            — the method and the percentage come back here.
          </div>
        ) : null}
      </div>

      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
        Stops are not guaranteed fills — gaps, circuits and illiquidity can execute worse than the level shown.
      </p>
    </div>
  );
}
