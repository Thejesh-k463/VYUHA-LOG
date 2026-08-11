"use client";
/**
 * lightweight-charts theme bridge — reads this app's CSS custom properties off
 * `document.documentElement` and turns them into chart options.
 *
 * Three rules govern everything in this file:
 *
 * 1. ONLY LITERAL COLOURS MAY REACH THE CANVAS. lightweight-charts parses colour
 *    strings with its own parser (hex, `rgb()/rgba()`, `hsl()/hsla()`, named
 *    colours). It does NOT understand `color-mix(...)`, `oklch(...)`, or an
 *    unresolved `var(...)`. Handed one it draws an INVISIBLE line: no throw, no
 *    console warning, no missing DOM node — the series simply is not there. The
 *    browser will not resolve these for us either, because the computed value of
 *    an untyped custom property is the token stream, so `color-mix()` arrives as
 *    literal text. Every token read below is literal hex/rgba in every theme
 *    block today; `assertLiteralColour()` re-checks that at runtime in dev so a
 *    future token rewrite fails loudly instead of silently blanking the chart.
 *    Derive translucent shades with `withAlpha()` — never with `color-mix()`.
 *
 * 2. `layout.background` IS TRANSPARENT so the Card's own gradient shows through.
 *    lightweight-charts special-cases the literal string "transparent", so this
 *    costs nothing and needs no token.
 *
 * 3. `layout.attributionLogo` IS FALSE. v5 defaults it to TRUE and paints an
 *    outbound link to tradingview.com onto the chart. This app is offline,
 *    local-first and zero-telemetry; an outbound link in the UI is unacceptable.
 *    The Apache-2.0 licence's attribution requirement is met by the NOTICE-style
 *    credit carried in package metadata and docs/DECISIONS.md, not by a link.
 *
 * No React and no DOM writes live here — this module only reads computed style
 * and returns plain objects, so the options builder stays trivially testable.
 */
import { ColorType, CrosshairMode, LineStyle, type ChartOptions, type DeepPartial } from "lightweight-charts";

/** The subset of app tokens the charts need, resolved to literal colours. */
export interface LwTheme {
  /** `--color-primary` — the price line. */
  primary: string;
  /** `--color-profit` — entry markers, target line. */
  profit: string;
  /** `--color-loss` — exit markers, stop-loss line. */
  loss: string;
  /** `--color-gold` — crosshair axis labels. */
  gold: string;
  /** `--color-border` — price/time scale borders. */
  border: string;
  /** `--color-rule` — grid lines (already low-alpha in the token itself). */
  rule: string;
  /** `--color-muted-foreground` — axis tick text. */
  mutedForeground: string;
  /** `--color-foreground` — crosshair lines (via `withAlpha`). */
  foreground: string;
  /** The root element's resolved font stack, so the canvas matches the page. */
  fontFamily: string;
}

/** Token name → LwTheme key, with the fallback used when the token is absent. */
const TOKENS = {
  primary: ["--color-primary", "#7c5cff"],
  profit: ["--color-profit", "#12b886"],
  loss: ["--color-loss", "#e03131"],
  gold: ["--color-gold", "#f0b429"],
  border: ["--color-border", "#2a2f3a"],
  rule: ["--color-rule", "rgba(148, 163, 184, 0.23)"],
  mutedForeground: ["--color-muted-foreground", "#94a3b8"],
  foreground: ["--color-foreground", "#e2e8f0"],
} as const satisfies Record<Exclude<keyof LwTheme, "fontFamily">, readonly [string, string]>;

const FALLBACK_FONT = "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";

/**
 * Colour forms lightweight-charts' own parser accepts. Anything else — a
 * `color-mix()`, an `oklch()`, an unresolved `var()` — renders as nothing at all,
 * which is why it is worth a dev-only check rather than trusting the token sheet.
 */
const PARSEABLE_COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([^()]*\)|hsla?\([^()]*\)|[a-z]+)$/i;

function assertLiteralColour(token: string, value: string): void {
  if (process.env.NODE_ENV === "production") return;
  if (PARSEABLE_COLOUR.test(value)) return;
  // Not a throw: a blank chart is bad, a crashed report page is worse.
  console.error(
    `[charts/lw] ${token} resolved to "${value}", which lightweight-charts cannot parse. ` +
      "It will draw NOTHING and report no error. Use a literal hex/rgba token, or derive it with withAlpha().",
  );
}

/**
 * Re-scale a literal colour's alpha channel. Exists so translucent chart colours
 * never have to be expressed as `color-mix()` (see rule 1). Unrecognised input is
 * returned untouched — a fully opaque colour beats an unparseable one.
 */
export function withAlpha(colour: string, alpha: number): string {
  const c = colour.trim();
  const clamp = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

  const hex = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const chan = (i: number) => parseInt(h[i] + h[i], 16);
      const a = h.length === 4 ? chan(3) / 255 : 1;
      return `rgba(${chan(0)}, ${chan(1)}, ${chan(2)}, ${clamp(a * alpha)})`;
    }
    if (h.length === 6 || h.length === 8) {
      const chan = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16);
      const a = h.length === 8 ? chan(3) / 255 : 1;
      return `rgba(${chan(0)}, ${chan(1)}, ${chan(2)}, ${clamp(a * alpha)})`;
    }
    return c;
  }

  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(c);
  if (fn) {
    const kind = fn[1].toLowerCase().startsWith("rgb") ? "rgba" : "hsla";
    // Handles both `r, g, b, a` (legacy) and `r g b / a` (modern) syntax.
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const raw = parts[3];
      const existing = raw == null ? 1 : raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
      if (!Number.isNaN(existing)) return `${kind}(${parts[0]}, ${parts[1]}, ${parts[2]}, ${clamp(existing * alpha)})`;
    }
  }

  return c;
}

/**
 * Read the live token values. Called on mount AND on every themed class change
 * (light/dark, colourblind palette, accent skin) — never cached, because the
 * point is to re-read after the class flips.
 */
export function readLwTheme(root: HTMLElement = document.documentElement): LwTheme {
  const style = getComputedStyle(root);
  const read = (token: string, fallback: string) => {
    const value = style.getPropertyValue(token).trim();
    if (!value) return fallback;
    assertLiteralColour(token, value);
    return value;
  };
  return {
    primary: read(...TOKENS.primary),
    profit: read(...TOKENS.profit),
    loss: read(...TOKENS.loss),
    gold: read(...TOKENS.gold),
    border: read(...TOKENS.border),
    rule: read(...TOKENS.rule),
    mutedForeground: read(...TOKENS.mutedForeground),
    foreground: read(...TOKENS.foreground),
    fontFamily: style.fontFamily || FALLBACK_FONT,
  };
}

/**
 * Chart-level options derived from the theme. Applied at creation AND re-applied
 * wholesale on every theme change, so this must stay a pure function of `t`:
 * anything set here that is NOT derived from `t` would be silently reset on the
 * first theme toggle.
 */
export function chartOptions(t: LwTheme): DeepPartial<ChartOptions> {
  const crosshairLine = {
    color: withAlpha(t.foreground, 0.32),
    style: LineStyle.Dashed,
    width: 1 as const,
    labelBackgroundColor: t.gold,
  };
  return {
    autoSize: true,
    layout: {
      // Rule 2 — let the Card gradient show through.
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: t.mutedForeground,
      fontSize: 11,
      fontFamily: t.fontFamily,
      // Rule 3 — no outbound TradingView link in an offline, local-first app.
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: t.rule, style: LineStyle.Dotted },
      horzLines: { color: t.rule, style: LineStyle.Dotted },
    },
    rightPriceScale: { borderColor: t.border, scaleMargins: { top: 0.14, bottom: 0.14 } },
    timeScale: { borderColor: t.border, fixLeftEdge: true, fixRightEdge: true },
    crosshair: { mode: CrosshairMode.Normal, vertLine: crosshairLine, horzLine: crosshairLine },
    localization: { locale: "en-IN" },
  };
}
