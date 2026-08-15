// APPEARANCE (PURE, no DB/React). Chrome tinting, panel style, custom theme,
// wallpaper — everything the <html> element needs beyond the skin class.
//
// Why this exists as CODE rather than CSS: the tint intensity is a user number
// (0–100), the custom theme is seven user hexes, and the chart canvas
// (components/charts/lw/theme.ts) reads --color-* through getComputedStyle and
// hands the strings to lightweight-charts, which parses colours itself and
// draws NOTHING — no throw, no warning — for color-mix()/oklch()/var(). So the
// mixing has to happen here, and every value this module returns is a literal
// `#rrggbb` or `rgba(r, g, b, a)`. tests/appearance.test.ts asserts that.
//
// The values land as an inline `style` on <html> (app/layout.tsx), which beats
// every class-level token in app/globals.css by cascade rule, so a tinted skin
// wins over its own CSS block, and the custom skin needs no CSS block at all.
//
// Neutral defaults below are the @theme / html.theme-light values in
// app/globals.css. If those move, move these — tests/appearance.test.ts pins
// the dark/light contrast floors, not the exact hexes.

import { SKINS, type Skin } from "@/lib/domain/skin";

// ── Types ─────────────────────────────────────────────────────────────────

/** Integer 0–100. 0 = untinted neutral chrome, 100 = fully saturated. */
export type TintIntensity = number;
export const DEFAULT_TINT_INTENSITY = 50;

export const PANEL_STYLES = ["flat", "soft", "luxe", "glow"] as const;
export type PanelStyle = (typeof PANEL_STYLES)[number];
export const DEFAULT_PANEL_STYLE: PanelStyle = "luxe";

export const PANEL_STYLE_META: Record<PanelStyle, { label: string; hint: string }> = {
  flat: { label: "Flat", hint: "Solid panels, no gradient, no glow — the terminal look." },
  soft: { label: "Soft", hint: "Faint gradient, no glow. Quiet on a busy screen." },
  luxe: { label: "Luxe", hint: "Gradient panels with the accent glow. The default." },
  glow: { label: "Glow", hint: "Luxe with a stronger halo on hero panels and buttons." },
};

export const CUSTOM_THEME_FIELDS = ["accent", "analytics", "money", "surface", "card", "border", "background"] as const;
export type CustomThemeField = (typeof CUSTOM_THEME_FIELDS)[number];
export type CustomThemeSide = Record<CustomThemeField, string>;
export interface CustomTheme {
  dark: CustomThemeSide;
  light: CustomThemeSide;
}

export const CUSTOM_THEME_FIELD_META: Record<CustomThemeField, { label: string; hint: string }> = {
  accent: { label: "Accent", hint: "Buttons, links, active nav, focus rings." },
  analytics: { label: "Analytics", hint: "The violet role — charts and analytics call-outs." },
  money: { label: "Money", hint: "The gold role — rupees, charges, capital." },
  surface: { label: "Sidebar", hint: "The sidebar and other raised surfaces." },
  card: { label: "Card", hint: "Panels and tables." },
  border: { label: "Border", hint: "Card edges and table rules." },
  background: { label: "Canvas", hint: "The page behind everything." },
};

/** Luxe's own values, so a fresh custom theme starts from the default look. */
export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  dark: {
    accent: "#2dd4bf",
    analytics: "#a78bfa",
    money: "#f0b429",
    surface: "#0a101c",
    card: "#0d1320",
    border: "#94a3b8",
    background: "#05080f",
  },
  light: {
    accent: "#0b7a70",
    analytics: "#6d28d9",
    money: "#8f6207",
    surface: "#ffffff",
    card: "#ffffff",
    border: "#d7dee6",
    background: "#f4f6f9",
  },
};

const HEX6 = /^#[0-9a-f]{6}$/;

/** Strict: a `#rrggbb` (lower-cased on the way in), else null. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return HEX6.test(s) ? s : null;
}

function parseSide(v: unknown): CustomThemeSide | null {
  if (!v || typeof v !== "object") return null;
  const out = {} as CustomThemeSide;
  for (const f of CUSTOM_THEME_FIELDS) {
    const h = normalizeHex((v as Record<string, unknown>)[f]);
    if (!h) return null;
    out[f] = h;
  }
  return out;
}

/**
 * Parse an untrusted value (DB column, request body) into a CustomTheme.
 * Accepts the object or its JSON string. Every one of the 14 hexes must be a
 * strict `#rrggbb`; anything else — a missing field, `rgb()`, a 3-digit hex,
 * a colour name — returns null. The caller decides whether null means "400"
 * (the API) or "fall back to Luxe" (the layout).
 */
export function parseCustomTheme(json: unknown): CustomTheme | null {
  let v: unknown = json;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const dark = parseSide((v as Record<string, unknown>).dark);
  const light = parseSide((v as Record<string, unknown>).light);
  return dark && light ? { dark, light } : null;
}

export function serializeCustomTheme(t: CustomTheme): string {
  return JSON.stringify({ dark: t.dark, light: t.light });
}

// ── Colour maths ──────────────────────────────────────────────────────────

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const clamp255 = (n: number) => clamp(Math.round(n), 0, 255);

export function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) throw new Error(`appearance: not a hex colour: ${hex}`);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return "#" + [r, g, b].map((c) => clamp255(c).toString(16).padStart(2, "0")).join("");
}

export function hexToHsl(hex: string): Hsl {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const sn = clamp(s, 0, 100) / 100, ln = clamp(l, 0, 100) / 100;
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0, g = 0, b = 0;
  if (hn < 60) [r, g, b] = [c, x, 0];
  else if (hn < 120) [r, g, b] = [x, c, 0];
  else if (hn < 180) [r, g, b] = [0, c, x];
  else if (hn < 240) [r, g, b] = [0, x, c];
  else if (hn < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
}

/** Linear RGB mix: t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  const k = clamp(t, 0, 1);
  return rgbToHex({ r: A.r + (B.r - A.r) * k, g: A.g + (B.g - A.g) * k, b: A.b + (B.b - A.b) * k });
}

/** Lower HSL lightness by `points` (0–100 scale). */
export function darken(hex: string, points: number): string {
  const c = hexToHsl(hex);
  return hslToHex({ ...c, l: c.l - points });
}

/** Raise HSL lightness by `points` (0–100 scale). */
export function lighten(hex: string, points: number): string {
  const c = hexToHsl(hex);
  return hslToHex({ ...c, l: c.l + points });
}

/** WCAG 2.x relative luminance, 0 (black) – 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1–21, order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** `rgba(r, g, b, a)` — the ONE alpha format the chart canvas can parse. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  const a = Math.round(clamp(alpha, 0, 1) * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ── Skin hues ─────────────────────────────────────────────────────────────

/**
 * Each skin's primary in both themes — the hue its chrome is tinted toward.
 * null = no tint (mono is flat by definition; custom supplies its own chrome).
 * These MUST equal the --color-primary in the skin's CSS blocks; the light
 * values are the AA-cleared darks recorded in lib/domain/skin.ts.
 */
export const SKIN_HUE: Record<Skin, { dark: string; light: string } | null> = {
  luxe: { dark: "#2dd4bf", light: "#0b7a70" },
  mono: null,
  tape: { dark: "#e8b006", light: "#8a6508" },
  sapphire: { dark: "#7196ff", light: "#1d4ed8" },
  aurora: { dark: "#e879f9", light: "#a21caf" },
  lime: { dark: "#a3e635", light: "#46700f" },
  rose: { dark: "#f472b6", light: "#be185d" },
  ember: { dark: "#fb923c", light: "#b93e0c" },
  custom: null,
};

export type Theme = "dark" | "light";
export type ChromeToken =
  | "--color-background"
  | "--color-surface"
  | "--color-card"
  | "--color-card-top"
  | "--color-card-hover"
  | "--color-border"
  | "--color-rule"
  | "--color-header-band";
export type ChromeVars = Partial<Record<ChromeToken, string>>;

/** The @theme (dark) / html.theme-light neutral chrome in app/globals.css. */
export const NEUTRAL_CHROME = {
  dark: {
    background: "#05080f",
    surface: "#0a101c",
    card: "#0d1320",
    cardTop: "#121a28",
    cardHover: "#16202f",
    borderBase: "#94a3b8", // rgba(148,163,184,·)
    headerBand: "#050910", // rgba(5,9,16,.75)
    foreground: "#e9eef5",
  },
  light: {
    background: "#f4f6f9",
    surface: "#ffffff",
    card: "#ffffff",
    cardTop: "#ffffff",
    cardHover: "#eef1f5",
    border: "#d7dee6",
    rule: "#dbe2ea",
    headerBand: "#eef1f5",
    foreground: "#14181f",
  },
} as const;

export function clampIntensity(v: unknown): TintIntensity {
  if (v == null || v === "") return DEFAULT_TINT_INTENSITY;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TINT_INTENSITY;
  return Math.round(clamp(n, 0, 100));
}

/**
 * Chrome tokens for a skin at a tint intensity. Every value is literal.
 * mono and custom return {} — mono is flat, custom is handled by customVars.
 * The curves start ABOVE zero at intensity 0 for a coloured skin (a coloured
 * skin is never fully neutral — that would make Tape and Sapphire share a
 * canvas by hex again) and grow linearly to intensity 100.
 */
export function chromeVars(input: { skin: Skin; theme: Theme; intensity: TintIntensity }): ChromeVars {
  const hue = SKIN_HUE[input.skin];
  if (!hue) return {};
  const i = clampIntensity(input.intensity) / 100;
  if (input.theme === "light") {
    const n = NEUTRAL_CHROME.light, h = hue.light;
    return {
      "--color-background": mix(n.background, h, 0.02 + 0.08 * i),
      "--color-surface": mix(n.surface, h, 0.01 + 0.06 * i),
      "--color-card": mix(n.card, h, 0.0 + 0.05 * i),
      "--color-card-top": mix(n.cardTop, h, 0.02 + 0.08 * i),
      "--color-card-hover": mix(n.cardHover, h, 0.03 + 0.1 * i),
      "--color-border": mix(n.border, h, 0.15 + 0.55 * i),
      "--color-rule": mix(n.rule, h, 0.12 + 0.45 * i),
      "--color-header-band": mix(n.headerBand, h, 0.04 + 0.16 * i),
    };
  }
  const n = NEUTRAL_CHROME.dark, h = hue.dark;
  return {
    "--color-background": mix(n.background, h, 0.02 + 0.1 * i),
    "--color-surface": mix(n.surface, h, 0.03 + 0.11 * i),
    "--color-card": mix(n.card, h, 0.02 + 0.1 * i),
    // Card-top/hover carry text too, so their curves stop where the brightest
    // hue (Lime #a3e635) still leaves body text ≥ 9:1 — tests pin the floor.
    "--color-card-top": mix(n.cardTop, h, 0.05 + 0.13 * i),
    "--color-card-hover": mix(n.cardHover, h, 0.05 + 0.11 * i),
    "--color-border": withAlpha(h, 0.14 + 0.3 * i),
    "--color-rule": withAlpha(h, 0.2 + 0.3 * i),
    "--color-header-band": withAlpha(mix(n.headerBand, h, 0.06 + 0.25 * i), 0.75),
  };
}

// ── Custom theme ──────────────────────────────────────────────────────────

/** Ink for text ON an accent: dark or white, whichever contrasts more. */
export function inkOn(hex: string): string {
  return contrastRatio(hex, "#0b1220") >= contrastRatio(hex, "#ffffff") ? "#0b1220" : "#ffffff";
}

/**
 * Every accent + chrome token for the custom skin, derived from the user's
 * seven hexes for one theme side. Same literal-only contract as chromeVars.
 * profit/loss are deliberately absent — those belong to colourblind mode.
 */
export function customVars(theme: Theme, custom: CustomTheme): Record<string, string> {
  const s = custom[theme];
  const dark = theme === "dark";
  const cardTop = dark ? lighten(s.card, 4) : s.card;
  const cardHover = dark ? lighten(s.card, 6) : darken(s.card, 3);
  return {
    "--color-primary": s.accent,
    "--color-primary-deep": darken(s.accent, 12),
    "--color-primary-foreground": inkOn(s.accent),
    "--color-ring": s.accent,
    "--color-violet": s.analytics,
    "--color-violet-deep": darken(s.analytics, 14),
    "--color-accent": s.analytics,
    "--color-gold": s.money,
    "--color-gold-bright": lighten(s.money, dark ? 10 : -3),
    "--color-gold-deep": darken(s.money, 12),
    "--color-warning": s.money,
    "--color-surface": s.surface,
    "--color-background": s.background,
    "--color-card": s.card,
    "--color-card-top": cardTop,
    "--color-card-hover": cardHover,
    "--color-input": s.card,
    "--color-border": dark ? withAlpha(s.border, 0.35) : s.border,
    "--color-rule": dark ? withAlpha(s.border, 0.5) : darken(s.border, 4),
    "--color-header-band": dark ? withAlpha(s.background, 0.75) : cardHover,
  };
}

export interface CustomThemeWarning {
  side: Theme;
  field: CustomThemeField | "foreground";
  ratio: number;
  /** The floor the pair failed: 4.5 for accents on canvas, 7 for body text. */
  floor: number;
}

/**
 * Pairs that fall under the WCAG floors: accent/analytics/money on the canvas
 * under 4.5:1, and the theme's body foreground on the canvas under 7:1. Advice,
 * not a gate — the user owns a custom theme, but the picker should say so.
 */
export function customThemeWarnings(custom: CustomTheme): CustomThemeWarning[] {
  const out: CustomThemeWarning[] = [];
  for (const side of ["dark", "light"] as const) {
    const s = custom[side];
    for (const field of ["accent", "analytics", "money"] as const) {
      const ratio = contrastRatio(s[field], s.background);
      if (ratio < 4.5) out.push({ side, field, ratio: round2(ratio), floor: 4.5 });
    }
    const fg = NEUTRAL_CHROME[side].foreground;
    const fr = contrastRatio(fg, s.background);
    if (fr < 7) out.push({ side, field: "foreground", ratio: round2(fr), floor: 7 });
  }
  return out;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Panel style, wallpaper ────────────────────────────────────────────────

export function asPanelStyle(v: unknown): PanelStyle {
  return PANEL_STYLES.includes(v as PanelStyle) ? (v as PanelStyle) : DEFAULT_PANEL_STYLE;
}

/** The `<html>` class for a panel style, or null for luxe (the default). */
export function panelClass(style: PanelStyle): string | null {
  return style === "luxe" ? null : `panel-${style}`;
}

export const WALLPAPER_MAX_BYTES = 12 * 1024 * 1024;
export const DEFAULT_WALLPAPER_OPACITY = 35;

/** Scrim alpha painted OVER the wallpaper: opacity 100 → 0 (bare image). */
export function wallpaperVars(opacity: number): { "--wallpaper-scrim": string } {
  const o = clampIntensity(opacity);
  return { "--wallpaper-scrim": String(Math.round((1 - o / 100) * 1000) / 1000) };
}

/** URL the layout points --wallpaper at; `v` busts the cache per stored file. */
export function wallpaperUrl(storedName: string): string {
  return `/api/appearance/wallpaper?v=${encodeURIComponent(storedName)}`;
}

export interface AppearanceInput {
  skin: Skin;
  theme: Theme;
  intensity: TintIntensity;
  panelStyle?: PanelStyle;
  customTheme?: CustomTheme | null;
  wallpaper?: { storedName: string | null; opacity: number } | null;
}

/**
 * Everything app/layout.tsx puts in <html style>. Custom skin → customVars
 * (the user's chrome, no tint curve); any other skin → chromeVars; plus the
 * wallpaper vars whenever a wallpaper is set. Falls back to Luxe's chrome if
 * the custom skin is selected but no valid theme is stored.
 */
export function appearanceVars(input: AppearanceInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.skin === "custom") {
    Object.assign(out, customVars(input.theme, input.customTheme ?? DEFAULT_CUSTOM_THEME));
  } else {
    Object.assign(out, chromeVars({ skin: input.skin, theme: input.theme, intensity: input.intensity }));
  }
  if (input.wallpaper?.storedName) {
    Object.assign(out, wallpaperVars(input.wallpaper.opacity));
    out["--wallpaper"] = `url("${wallpaperUrl(input.wallpaper.storedName)}")`;
  }
  return out;
}

/** The html classes beyond the skin class: panel style and wallpaper flag. */
export function appearanceClasses(input: { panelStyle: PanelStyle; wallpaper?: { storedName: string | null } | null }): string[] {
  const out: string[] = [];
  const p = panelClass(input.panelStyle);
  if (p) out.push(p);
  if (input.wallpaper?.storedName) out.push("wallpaper");
  return out;
}

/** Every skin the tint curve applies to (has a hue). */
export const TINTED_SKINS: readonly Skin[] = SKINS.filter((s) => SKIN_HUE[s] !== null);
