"use client";
/**
 * The entry→target and entry→stop fills for the expanded position chart, as an
 * `ISeriesPrimitive` (02 §9.5, spec §3.2).
 *
 * WHY A PRIMITIVE AND NOT TWO AREA SERIES. Two `AreaSeries` fill correctly and
 * are wrong for every other reason: each is a *series*, so it joins autoscaling,
 * appears in the legend, and pins its baseline to the pane bottom rather than to
 * entry. `createSeriesMarkers` cannot fill a region at all. A primitive gets the
 * price converter on every paint, so the fills follow a moving stop with no
 * teardown and no flicker — 02 §9.5 rejects the other two by name.
 *
 * FOUR PROPERTIES THIS FILE EXISTS TO KEEP:
 *
 *  1. PAISE IN, RUPEES ONCE. Every level arrives as integer paise (invariant 1)
 *     and is divided by 100 exactly once, in `zoneGeometry`, immediately before
 *     it is handed to `priceToCoordinate`. Nothing downstream of that division
 *     is money any more — it is a y coordinate.
 *  2. GEOMETRY IS PURE AND SEPARATE. `zoneGeometry()` takes a
 *     `priceToCoordinate` function and a frame and returns plain rectangles. It
 *     touches no canvas, no chart and no DOM, so the thing that can actually be
 *     wrong — which rectangle lands where — is unit-testable without a browser
 *     (`tests/position-zone-primitive.test.ts`).
 *  3. LITERAL COLOURS ONLY. The canvas is handed colour strings the caller
 *     derived with `withAlpha()` from `./theme`. A `color-mix()`, an `oklch()`
 *     or an unresolved `var()` does not throw here — 2D canvas silently paints
 *     NOTHING for an unparseable `fillStyle`, exactly as lightweight-charts
 *     silently draws an invisible series. This module therefore never composes
 *     a colour itself; it only stores what the theme bridge produced.
 *  4. FILLS PAINT BELOW THE CANDLES. `zOrder()` is `"bottom"`, so wicks stay
 *     readable over the tint.
 *
 * `update()` mutates the stored levels and asks the chart to repaint. It never
 * recreates the primitive: a detach/attach cycle drops a frame and re-runs
 * autoscaling, which is visible as a jump when a trailing stop ratchets.
 */
import type {
  AutoscaleInfo,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { Paise, Side } from "@/lib/live/types";

/** The one place paise become rupees. See property (1) in the header. */
export const PAISE_PER_RUPEE = 100;

/** R multiples the ladder marks. ⅓ at each is the owner's ruling (Q35). */
export const LADDER_STEPS = [1, 2, 3] as const;

/** Width in media px of a ladder tick, drawn on the left edge of the zone. */
export const LADDER_TICK_WIDTH = 28;

/** Height in media px of a ladder tick's rule. */
export const LADDER_TICK_HEIGHT = 2;

/** Which zone a rectangle is. `reward` is entry→target, `risk` is entry→stop. */
export type ZoneKind = "reward" | "risk";

/** A rectangle in MEDIA coordinates, normalised so `height` is never negative. */
export interface ZoneRect {
  kind: ZoneKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One R-ladder tick: the level it marks and where it lands. */
export interface LadderTick {
  /** 1, 2 or 3. */
  r: number;
  /** The level in paise, so a caller can label it without re-deriving it. */
  priceP: Paise;
  x: number;
  y: number;
  width: number;
}

export interface ZoneGeometry {
  rects: ZoneRect[];
  ticks: LadderTick[];
}

/** The levels the zone paints between. Any of them may be unknown. */
export interface ZoneLevels {
  side: Side;
  entryP: Paise;
  targetP: Paise | null;
  /** null hides the risk zone AND the ladder — no stop, no R (invariant 6). */
  stopP: Paise | null;
}

/** `ISeriesApi.priceToCoordinate`, in RUPEES. null when the level is off-scale. */
export type PriceToCoordinate = (price: number) => number | null;

/** Horizontal extent of the fills, in media px. */
export interface ZoneFrame {
  /** Left edge — the entry's x when it is known, else the plot's left edge. */
  x0: number;
  /** Right edge — the plot width. */
  x1: number;
}

/**
 * Rectangles and ladder ticks for one set of levels.
 *
 * PURE. Given the same converter and frame it returns the same geometry, which
 * is what makes the paise fixture in the test meaningful.
 */
export function zoneGeometry(levels: ZoneLevels, priceToCoordinate: PriceToCoordinate, frame: ZoneFrame): ZoneGeometry {
  const empty: ZoneGeometry = { rects: [], ticks: [] };
  const width = frame.x1 - frame.x0;
  if (!Number.isFinite(width) || width <= 0) return empty;

  // Property (1): the ONLY division by 100 in this module.
  const yOf = (priceP: Paise | null): number | null => {
    if (priceP === null || !Number.isFinite(priceP)) return null;
    const y = priceToCoordinate(priceP / PAISE_PER_RUPEE);
    return y === null || !Number.isFinite(y) ? null : y;
  };

  const yEntry = yOf(levels.entryP);
  if (yEntry === null) return empty;

  const rects: ZoneRect[] = [];
  const band = (kind: ZoneKind, other: Paise | null) => {
    const y = yOf(other);
    if (y === null) return;
    const height = Math.abs(y - yEntry);
    if (height <= 0) return;
    rects.push({ kind, x: frame.x0, y: Math.min(y, yEntry), width, height });
  };
  band("reward", levels.targetP);
  band("risk", levels.stopP);

  const ticks: LadderTick[] = [];
  if (levels.stopP !== null) {
    const rP = Math.abs(levels.entryP - levels.stopP);
    // A short's ladder runs DOWN from entry; the sign is the only difference.
    const sign = levels.side === "short" ? -1 : 1;
    if (rP > 0) {
      for (const r of LADDER_STEPS) {
        const priceP = levels.entryP + sign * r * rP;
        const y = yOf(priceP);
        if (y === null) continue;
        ticks.push({ r, priceP, x: frame.x0, y, width: Math.min(LADDER_TICK_WIDTH, width) });
      }
    }
  }

  return { rects, ticks };
}

/** Literal colour strings, already derived by `withAlpha()` — property (3). */
export interface PositionZoneStyle {
  /** entry→target fill, `withAlpha(theme.profit, ~0.12)`. */
  reward: string;
  /** entry→stop fill, `withAlpha(theme.loss, ~0.12)`. */
  risk: string;
  /** R-ladder tick rule. */
  ladder: string;
  /** R-ladder tick label. */
  ladderText: string;
  /** The page's resolved font stack, so canvas text matches the DOM. */
  font: string;
}

export interface PositionZoneOptions extends ZoneLevels {
  style: PositionZoneStyle;
  /** x of the entry bar, when the caller knows it. null ⇒ the whole plot. */
  entryX?: number | null;
  /** false while the R ladder has nothing to stand on. */
  showLadder?: boolean;
}

type AttachedSeries = ISeriesApi<SeriesType, Time>;

class ZonePaneRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly zone: PositionZonePrimitive) {}

  draw(): void {
    // Nothing here: the fills belong under the candles, so all painting happens
    // in `drawBackground`. Property (4).
  }

  drawBackground(target: Parameters<NonNullable<IPrimitivePaneRenderer["drawBackground"]>>[0]): void {
    const series = this.zone.series;
    if (!series) return;
    target.useBitmapCoordinateSpace((scope) => {
      const geo = zoneGeometry(
        this.zone.levels,
        (price) => series.priceToCoordinate(price),
        { x0: this.zone.entryX ?? 0, x1: scope.mediaSize.width },
      );
      const { context: ctx, horizontalPixelRatio: hx, verticalPixelRatio: vy } = scope;
      const style = this.zone.style;

      for (const rect of geo.rects) {
        ctx.fillStyle = rect.kind === "reward" ? style.reward : style.risk;
        ctx.fillRect(
          Math.round(rect.x * hx),
          Math.round(rect.y * vy),
          Math.round(rect.width * hx),
          Math.round(rect.height * vy),
        );
      }

      if (!this.zone.showLadder) return;
      ctx.fillStyle = style.ladder;
      for (const tick of geo.ticks) {
        ctx.fillRect(
          Math.round(tick.x * hx),
          Math.round(tick.y * vy),
          Math.round(tick.width * hx),
          Math.max(1, Math.round(LADDER_TICK_HEIGHT * vy)),
        );
      }
      ctx.fillStyle = style.ladderText;
      ctx.font = `${Math.round(10 * vy)}px ${style.font}`;
      ctx.textBaseline = "bottom";
      for (const tick of geo.ticks) {
        ctx.fillText(`${tick.r}R`, Math.round(tick.x * hx), Math.round(tick.y * vy) - 2);
      }
    });
  }
}

class ZonePaneView implements IPrimitivePaneView {
  private readonly paneRenderer: ZonePaneRenderer;
  constructor(zone: PositionZonePrimitive) {
    this.paneRenderer = new ZonePaneRenderer(zone);
  }
  /** Property (4) — under the candles, so wicks stay readable. */
  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }
  renderer(): IPrimitivePaneRenderer {
    return this.paneRenderer;
  }
}

/**
 * The zone itself. Construct it, `series.attachPrimitive(zone)`, and thereafter
 * only ever call `update()` / `applyStyle()`.
 */
export class PositionZonePrimitive implements ISeriesPrimitive<Time> {
  levels: ZoneLevels;
  style: PositionZoneStyle;
  entryX: number | null;
  showLadder: boolean;
  series: AttachedSeries | null = null;

  private chart: IChartApiBase<Time> | null = null;
  private askForRepaint: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(options: PositionZoneOptions) {
    this.levels = { side: options.side, entryP: options.entryP, targetP: options.targetP, stopP: options.stopP };
    this.style = options.style;
    this.entryX = options.entryX ?? null;
    this.showLadder = options.showLadder ?? true;
    // One array instance for the lifetime of the primitive: the library caches
    // pane views by reference and a fresh array on every call defeats that.
    this.views = [new ZonePaneView(this)];
  }

  /** Move any level. A trailing stop is `zone.update({ stopP })` — nothing else. */
  update(next: Partial<ZoneLevels & { entryX: number | null; showLadder: boolean }>): void {
    if (next.side !== undefined) this.levels.side = next.side;
    if (next.entryP !== undefined) this.levels.entryP = next.entryP;
    if (next.targetP !== undefined) this.levels.targetP = next.targetP;
    if (next.stopP !== undefined) this.levels.stopP = next.stopP;
    if (next.entryX !== undefined) this.entryX = next.entryX;
    if (next.showLadder !== undefined) this.showLadder = next.showLadder;
    this.askForRepaint?.();
  }

  /** Re-colour after a theme class change. Colours only — never levels. */
  applyStyle(style: PositionZoneStyle): void {
    this.style = style;
    this.askForRepaint?.();
  }

  /** The geometry this zone would paint. Exists for the renderer and the test. */
  geometry(priceToCoordinate: PriceToCoordinate, frame: ZoneFrame): ZoneGeometry {
    return zoneGeometry(this.levels, priceToCoordinate, frame);
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.series = param.series;
    this.chart = param.chart;
    this.askForRepaint = param.requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.chart = null;
    this.askForRepaint = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /**
   * Keep target, stop and the whole ladder inside the visible price range even
   * before price has reached them — otherwise the zone is clipped to the bars
   * and the user sees a fill with no edge (02 §9.5).
   */
  autoscaleInfo(): AutoscaleInfo | null {
    const { side, entryP, targetP, stopP } = this.levels;
    const levelsP: Paise[] = [entryP];
    if (targetP !== null) levelsP.push(targetP);
    if (stopP !== null) {
      levelsP.push(stopP);
      if (this.showLadder) {
        const rP = Math.abs(entryP - stopP);
        const sign = side === "short" ? -1 : 1;
        for (const r of LADDER_STEPS) levelsP.push(entryP + sign * r * rP);
      }
    }
    const finite = levelsP.filter((p) => Number.isFinite(p));
    if (finite.length === 0) return null;
    return {
      priceRange: {
        minValue: Math.min(...finite) / PAISE_PER_RUPEE,
        maxValue: Math.max(...finite) / PAISE_PER_RUPEE,
      },
    };
  }

  /** The chart handle, for callers that need the time scale. Read-only use. */
  get chartApi(): IChartApiBase<Time> | null {
    return this.chart;
  }
}
