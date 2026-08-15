// LIVE PREVIEW of appearance changes on <html> — the client-side twin of what
// app/layout.tsx server-renders as `style={appearanceVars(...)}` plus the
// panel-*/wallpaper/skin-* classes.
//
// Two rules this file exists to enforce:
//
// 1. Vars are REPLACED, not accumulated. The layout puts a fixed set of
//    --color-* tokens inline; a preview that switches from a tinted skin to
//    Terminal (mono) must REMOVE the tint tokens, or the flat skin previews with
//    Rose's borders. So every name we set is remembered in a module-level Set
//    and anything absent from the next call is cleared.
//
// 2. lightweight-charts re-reads its theme ONLY on a class-attribute mutation
//    of <html> (components/charts/lw/use-lw-chart.ts) — a MutationObserver with
//    attributeFilter ["class"]. An inline setProperty changes no attribute it
//    watches, so after writing vars we toggle a marker class `appearance-tick`
//    (add now, remove next frame). Two mutations, two re-reads, both cheap; the
//    class has no CSS and is never persisted.

import {
  CUSTOM_THEME_FIELDS,
  PANEL_STYLES,
  chromeVars,
  panelClass,
  type CustomThemeField,
  type CustomThemeSide,
  type PanelStyle,
  type Theme,
} from "@/lib/domain/appearance";
import { SKINS, skinClass, type Skin } from "@/lib/domain/skin";

const applied = new Set<string>();
const TICK_CLASS = "appearance-tick";

export interface PreviewClasses {
  /** Panel style to preview; undefined = leave the current panel-* class alone. */
  panel?: PanelStyle | null;
  /** Wallpaper flag; undefined = leave alone. */
  wallpaper?: boolean;
  /** Skin class to preview; undefined = leave alone. */
  skin?: Skin;
}

/** Nudge the chart MutationObserver: a class-attribute mutation with no CSS behind it. */
export function tickAppearance(): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.classList.add(TICK_CLASS);
  const clear = () => el.classList.remove(TICK_CLASS);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(clear);
  else setTimeout(clear, 0);
}

/**
 * Write the given vars inline on <html> (removing any this module set earlier
 * that are absent now), toggle the requested classes, then tick the observer.
 */
export function applyAppearancePreview(vars: Record<string, string>, classes: PreviewClasses = {}): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;

  for (const name of applied) {
    if (!(name in vars)) {
      el.style.removeProperty(name);
      applied.delete(name);
    }
  }
  for (const [name, value] of Object.entries(vars)) {
    el.style.setProperty(name, value);
    applied.add(name);
  }

  if (classes.panel !== undefined) {
    for (const p of PANEL_STYLES) {
      const c = panelClass(p);
      if (c) el.classList.remove(c);
    }
    const c = classes.panel ? panelClass(classes.panel) : null;
    if (c) el.classList.add(c);
  }
  if (classes.wallpaper !== undefined) el.classList.toggle("wallpaper", classes.wallpaper);
  if (classes.skin !== undefined) {
    for (const s of SKINS) {
      const c = skinClass(s);
      if (c) el.classList.remove(c);
    }
    const c = skinClass(classes.skin);
    if (c) el.classList.add(c);
  }

  tickAppearance();
}

/** Clear every inline var this module has set. Classes are left as they are. */
export function resetAppearancePreview(): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  for (const name of applied) el.style.removeProperty(name);
  applied.clear();
  tickAppearance();
}

/** `#rrggbb` from a computed token value (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`); null otherwise. Alpha is dropped. */
export function cssColorToHex(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return "#" + s.slice(1).split("").map((c) => c + c).join("");
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/);
  if (!m) return null;
  const h = (n: string) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0");
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
}

/** The custom-theme field → the token that carries it in a built-in skin. */
const SAMPLE_TOKENS: Record<CustomThemeField, string> = {
  accent: "--color-primary",
  analytics: "--color-violet",
  money: "--color-gold",
  surface: "--color-surface",
  card: "--color-card",
  border: "--color-border",
  background: "--color-background",
};

/**
 * Read a built-in skin's seven tokens for one theme side, as the browser
 * resolves them — the "Start from Luxe" seed for the custom builder.
 *
 * Temporarily puts <html> into that skin (class + its chrome tint at the given
 * intensity, theme-light toggled to match), reads getComputedStyle, then
 * restores the exact previous `style` and `class` attributes. All synchronous:
 * getComputedStyle forces a style recalc but nothing paints in between, so the
 * user never sees the swap. Fields whose token cannot be parsed fall back to
 * `fallback`.
 */
export function sampleSkinSide(
  skin: Skin,
  theme: Theme,
  intensity: number,
  fallback: CustomThemeSide,
): CustomThemeSide {
  if (typeof document === "undefined") return fallback;
  const el = document.documentElement;
  const prevStyle = el.getAttribute("style");
  const prevClass = el.getAttribute("class");
  try {
    for (const name of applied) el.style.removeProperty(name);
    for (const s of SKINS) {
      const c = skinClass(s);
      if (c) el.classList.remove(c);
    }
    const c = skinClass(skin);
    if (c) el.classList.add(c);
    el.classList.toggle("theme-light", theme === "light");
    for (const [n, v] of Object.entries(chromeVars({ skin, theme, intensity }))) el.style.setProperty(n, v);
    const cs = getComputedStyle(el);
    const out = { ...fallback };
    for (const f of CUSTOM_THEME_FIELDS) {
      const hex = cssColorToHex(cs.getPropertyValue(SAMPLE_TOKENS[f]));
      if (hex) out[f] = hex;
    }
    return out;
  } finally {
    if (prevStyle === null) el.removeAttribute("style");
    else el.setAttribute("style", prevStyle);
    if (prevClass === null) el.removeAttribute("class");
    else el.setAttribute("class", prevClass);
  }
}

/**
 * Names of the vars app/layout.tsx server-rendered inline. On first preview we
 * adopt them so a later call can REMOVE them (they were not set through this
 * module, but they are the same tokens and must not survive a skin switch).
 */
export function adoptServerVars(): void {
  if (typeof document === "undefined") return;
  const st = document.documentElement.style;
  for (let i = 0; i < st.length; i++) {
    const n = st.item(i);
    if (n.startsWith("--color-") || n.startsWith("--wallpaper")) applied.add(n);
  }
}
