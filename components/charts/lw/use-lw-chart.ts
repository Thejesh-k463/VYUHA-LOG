"use client";
/**
 * Owns the whole lifetime of one lightweight-charts instance: create it in an
 * effect, hand it to the caller to draw on, keep it in sync with the theme, and
 * dispose it on cleanup.
 *
 * Two things here are load-bearing:
 *
 * - `chart.remove()` in the cleanup is NOT optional. React 19 StrictMode
 *   double-invokes effects in development; without disposal the first instance
 *   keeps its canvases in the container and you get two stacked charts, one of
 *   them frozen. The same cleanup is what keeps a client-side navigation away
 *   and back at exactly one canvas.
 *
 * - Re-theming happens through a SINGLE `MutationObserver` on
 *   `document.documentElement`'s `class` attribute. Every way this app changes
 *   its palette lands there — the light/dark toggle, colourblind mode, the
 *   accent-skin picker, and the class re-application after `router.refresh()` —
 *   so one observer covers all of them and nothing has to be wired per feature.
 *   The callback mutates the chart IMPERATIVELY. It sets no React state: state
 *   here would be a `setState` driven by an effect, which is exactly the pattern
 *   `react-hooks/set-state-in-effect` forbids in this codebase.
 */
import { useEffect, useRef, type RefObject } from "react";
import { createChart, type IChartApi } from "lightweight-charts";
import { chartOptions, readLwTheme, type LwTheme } from "./theme";

/** Re-applies theme-derived colours to whatever the build step created. */
export type LwRetheme = (theme: LwTheme) => void;

/**
 * Draws on a freshly created chart. Return a callback to re-colour the series,
 * markers and price lines you created; chart-level options are re-applied by the
 * hook itself. Return nothing if there is nothing series-level to re-colour.
 */
export type LwBuild = (chart: IChartApi, theme: LwTheme) => LwRetheme | void;

/**
 * @param build  Must be referentially stable (wrap it in `useCallback`). The
 *               chart is torn down and rebuilt whenever its identity changes,
 *               which is the intended behaviour when the plotted data changes.
 * @returns      The ref to attach to the sized container element.
 */
export function useLwChart(build: LwBuild): RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const theme = readLwTheme();
    const chart = createChart(container, chartOptions(theme));
    const drawn = build(chart, theme);
    const retheme = typeof drawn === "function" ? drawn : null;

    const observer = new MutationObserver(() => {
      const next = readLwTheme();
      chart.applyOptions(chartOptions(next));
      retheme?.(next);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [build]);

  return containerRef;
}
