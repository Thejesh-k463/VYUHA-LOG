import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SKINS, SKIN_META, asSkin, skinClass, type Skin } from "@/lib/domain/skin";

const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

/** The declarations inside one `html…{ }` block, by exact selector. */
function block(selector: string): string {
  const i = css.indexOf(`\n  ${selector} {`);
  if (i < 0) return "";
  const start = css.indexOf("{", i);
  return css.slice(start + 1, css.indexOf("\n  }", start));
}
const tokensIn = (b: string) => [...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();

describe("asSkin", () => {
  it("maps the legacy 'terminal' to Luxe, NOT to the new flat skin", () => {
    // This is the whole reason the flat skin is called "mono". "terminal" is
    // the pre-v4 column default on every install ever made, and it has
    // rendered as the gradient look since v3 — so redefining it would restyle
    // every existing user, including anyone restoring an old backup.
    expect(asSkin("terminal")).toBe("luxe");
  });

  it("gives back the skin a user actually chose", () => {
    for (const s of SKINS) expect(asSkin(s)).toBe(s);
  });

  it("maps the retired 'ice' and 'royal' to Sapphire, the nearest survivor — never a 400, never a surprise Luxe", () => {
    expect(asSkin("ice")).toBe("sapphire");
    expect(asSkin("royal")).toBe("sapphire");
  });

  it("falls back to Luxe for anything else — a bad column never breaks the app", () => {
    for (const bad of [null, undefined, "", "sindoor", 7, {}, "LUXE"]) {
      expect(asSkin(bad)).toBe("luxe");
    }
  });

  it("Luxe emits no class — it IS the default", () => {
    expect(skinClass("luxe")).toBeNull();
    for (const s of SKINS.filter((x) => x !== "luxe")) {
      expect(skinClass(s)).toBe(`skin-${s}`);
    }
  });
});

describe("every skin is fully described", () => {
  it("has metadata, a hint and three swatch colours", () => {
    for (const s of SKINS) {
      const m = SKIN_META[s];
      expect(m.id).toBe(s);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
      for (const c of [m.swatch.primary, m.swatch.money, m.swatch.analytics]) {
        expect(c, `${s} swatch`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("names its money colour — the warm-led skins' is NOT gold, and the picker must say so", () => {
    expect(SKIN_META.tape.moneyLabel).toBe("violet");
    expect(SKIN_META.lime.moneyLabel).toBe("violet");
    expect(SKIN_META.ember.moneyLabel).toBe("violet");
    expect(SKIN_META.luxe.moneyLabel).toBe("gold");
    expect(SKIN_META.rose.moneyLabel).toBe("gold");
  });

  it("is exactly the approved roster", () => {
    expect([...SKINS]).toEqual(["luxe", "mono", "tape", "sapphire", "aurora", "lime", "rose", "ember", "custom"]);
  });
});

describe("skins are DISTINCT — the reason Ice and Royal were retired", () => {
  // Ice reused Sapphire's analytics hex, Royal reused Luxe's analytics as its
  // primary; with only the accent tokens recoloured, three of seven skins were
  // near-duplicates. These assertions make that impossible to reintroduce.
  // "custom" has no CSS block — its tokens are the user's hexes, applied inline
  // by lib/domain/appearance.ts — so it is exempt from every CSS assertion here.
  const coloured = SKINS.filter((s) => s !== "mono" && s !== "custom");
  const token = (b: string, name: string): string | undefined =>
    b.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1]?.toLowerCase();
  // Luxe has no block — its values ARE the @theme (dark) / html.theme-light values.
  const themeBlock = css.slice(css.indexOf("@theme static {"), css.indexOf("\n}", css.indexOf("@theme static {")));
  const lightBlock = block("html.theme-light");
  const primaryOf = (s: Skin, theme: "dark" | "light") =>
    s === "luxe"
      ? token(theme === "dark" ? themeBlock : lightBlock, "--color-primary")
      : token(block(theme === "dark" ? `html.skin-${s}` : `html.theme-light.skin-${s}`), "--color-primary");
  const analyticsOf = (s: Skin, theme: "dark" | "light") =>
    s === "luxe"
      ? token(theme === "dark" ? themeBlock : lightBlock, "--color-violet")
      : token(block(theme === "dark" ? `html.skin-${s}` : `html.theme-light.skin-${s}`), "--color-violet");

  for (const theme of ["dark", "light"] as const) {
    it(`no two coloured skins share a --color-primary (${theme})`, () => {
      const seen = new Map<string, Skin>();
      for (const s of coloured) {
        const p = primaryOf(s, theme);
        expect(p, `${s} ${theme} primary`).toMatch(/^#[0-9a-f]{6}$/);
        expect(seen.get(p!), `${s} and ${seen.get(p!)} share primary ${p} (${theme})`).toBeUndefined();
        seen.set(p!, s);
      }
    });

    it(`no coloured skin's primary is another skin's analytics colour (${theme})`, () => {
      for (const a of coloured) {
        expect(analyticsOf(a, theme), `${a} ${theme} analytics`).toMatch(/^#[0-9a-f]{6}$/);
        for (const b of coloured) {
          if (a === b) continue;
          expect(primaryOf(a, theme), `${a} primary == ${b} analytics (${theme})`).not.toBe(analyticsOf(b, theme));
        }
      }
    });
  }

  it("SKIN_META swatch primary is the CSS dark --color-primary (mono inherits Luxe's; custom has no CSS)", () => {
    for (const s of SKINS) {
      if (s === "custom") continue;
      const cssPrimary = s === "mono" ? primaryOf("luxe", "dark") : primaryOf(s, "dark");
      expect(SKIN_META[s].swatch.primary.toLowerCase(), `${s} swatch`).toBe(cssPrimary);
    }
  });

  it("every coloured skin except Luxe tints its surfaces, in both themes", () => {
    for (const s of coloured.filter((x) => x !== "luxe")) {
      for (const sel of [`html.skin-${s}`, `html.theme-light.skin-${s}`]) {
        const t = tokensIn(block(sel));
        for (const need of ["--color-background", "--color-card-top", "--color-border"]) {
          expect(t, `${sel} lacks ${need}`).toContain(need);
        }
      }
    }
  });
});

describe("the CSS answers both themes for every skin", () => {
  const themed = SKINS.filter((s): s is Exclude<Skin, "luxe" | "custom"> => s !== "luxe" && s !== "custom");

  it("a token overridden in dark is also overridden in light", () => {
    // A token answered only for dark leaks a dark value onto a near-white
    // canvas, and the failure mode is invisible text, not a visible error —
    // the same rule the light theme block already documents.
    for (const s of themed) {
      const dark = tokensIn(block(`html.skin-${s}`));
      const light = tokensIn(block(`html.theme-light.skin-${s}`));
      expect(dark.length, `skin-${s} has no dark block`).toBeGreaterThan(0);
      expect(light.length, `skin-${s} has no light block`).toBeGreaterThan(0);
      for (const t of dark) {
        expect(light, `skin-${s} sets ${t} in dark but not in light`).toContain(t);
      }
    }
  });

  it("no skin touches profit or loss — those belong to colourblind mode", () => {
    for (const s of themed) {
      const both = block(`html.skin-${s}`) + block(`html.theme-light.skin-${s}`);
      expect(both, `skin-${s}`).not.toMatch(/--color-(profit|loss)\s*:/);
    }
  });

  it("every skin value is a LITERAL colour — color-mix() would be invisible on the chart canvas", () => {
    // components/charts/lw/theme.ts reads these tokens with getComputedStyle
    // and hands the strings to lightweight-charts, which parses colours itself.
    // A color-mix() value draws nothing, with no error anywhere.
    for (const s of themed) {
      const both = block(`html.skin-${s}`) + block(`html.theme-light.skin-${s}`);
      expect(both, `skin-${s} uses color-mix`).not.toContain("color-mix");
    }
  });

  it("the skin blocks come AFTER the light theme — same specificity, order decides", () => {
    const light = css.indexOf("html.theme-light {");
    for (const s of themed) {
      const at = css.indexOf(`html.skin-${s} {`);
      expect(at, `skin-${s} missing`).toBeGreaterThan(0);
      expect(at, `skin-${s} must come after html.theme-light`).toBeGreaterThan(light);
    }
  });
});

describe("appearance CSS — panel styles and wallpaper (lib/domain/appearance.ts sets the classes)", () => {
  // The classes app/layout.tsx puts on <html>: panel-flat / panel-soft /
  // panel-glow (luxe = no class) and wallpaper. Each must have CSS behind it,
  // or the setting is a no-op that nothing on screen reports.
  const panelSelectors = ["html.panel-flat", "html.panel-soft", "html.panel-glow"] as const;
  const themed = SKINS.filter((s) => s !== "luxe" && s !== "custom");

  it("every panel style has both a token block (base) and a recipe override (utilities)", () => {
    for (const sel of panelSelectors) {
      // The utilities-layer override — the only thing that can beat @utility panel-luxe.
      expect(css, `${sel} .panel-luxe override missing`).toContain(`${sel} .panel-luxe`);
    }
    // Flat and soft set shadow tokens in @layer base; glow composes from the
    // skin's own --shadow-primary-glow and needs no token block.
    expect(block("html.panel-flat")).toContain("--shadow-hero: none");
    expect(block("html.panel-flat")).toContain("--shadow-primary-glow: none");
    expect(block("html.theme-light.panel-flat")).toContain("--shadow-hero: none");
    expect(block("html.panel-soft")).toContain("--shadow-hero:");
    expect(block("html.theme-light.panel-soft")).toContain("--shadow-hero:");
  });

  it("the panel-style token blocks come AFTER every skin block — same specificity, order decides", () => {
    const lastSkin = Math.max(...themed.map((s) => css.indexOf(`html.theme-light.skin-${s} {`)));
    for (const sel of ["html.panel-flat {", "html.theme-light.panel-flat {", "html.panel-soft {", "html.theme-light.panel-soft {"]) {
      expect(css.indexOf(sel), `${sel} must follow the skin blocks`).toBeGreaterThan(lastSkin);
    }
  });

  it("the recipe overrides live in a LAYERED utilities block, so print (unlayered) still flattens them", () => {
    const at = css.indexOf("html.panel-flat .panel-luxe");
    const layerOpen = css.lastIndexOf("@layer utilities {", at);
    expect(layerOpen, "panel overrides must sit inside @layer utilities").toBeGreaterThan(0);
    // No `@utility` or unlayered rule opens between the layer and the override.
    expect(css.slice(layerOpen, at)).not.toContain("@utility");
    // The C10 print block is the LAST @media print in the file (text-grad-gold nests an earlier one).
    expect(css.lastIndexOf("@media print")).toBeGreaterThan(at);
  });

  it("wallpaper paints on a fixed body::before layer, behind the scrim, and is reset on paper", () => {
    // Canvas colour stays on body; image + scrim live on a position:fixed
    // ::before that Chromium composites as its own layer. body-level
    // `background-attachment: fixed` + cover is the slow repaint-per-scroll
    // path this replaced (2026-08-29) — it must not come back.
    expect(css).toContain("html.wallpaper body {");
    expect(block("html.wallpaper body")).toContain("var(--color-background)");
    const layer = block("html.wallpaper body::before");
    expect(layer).toContain("var(--wallpaper)");
    expect(layer).toContain("var(--wallpaper-scrim");
    expect(layer).toContain("--wallpaper-scrim-rgb");
    expect(layer).toContain("background-size: cover");
    expect(layer).toContain("position: fixed");
    expect(layer).not.toContain("background-attachment");
    // Scrim channels are theme-answered.
    expect(css).toMatch(/--wallpaper-scrim-rgb:\s*5 8 15/);
    expect(block("html.theme-light")).toMatch(/--wallpaper-scrim-rgb:\s*244 246 249/);
    // Print reset — inside the @media print block, after it opens.
    // The C10 print block is the LAST @media print in the file (text-grad-gold
    // nests an earlier one). CRLF-tolerant: the file is checked out with \r\n.
    const print = css.lastIndexOf("@media print {");
    const reset = css.search(/html\.wallpaper body \{\r?\n\s+background-image: none !important;/);
    expect(reset).toBeGreaterThan(print);
    const layerOff = css.search(/html\.wallpaper body::before \{\r?\n\s+content: none !important;/);
    expect(layerOff).toBeGreaterThan(print);
  });

  it("none of the appearance blocks use color-mix() — same rule as the skins", () => {
    // Token blocks (base) — extracted by exact selector.
    for (const sel of ["html.panel-flat", "html.theme-light.panel-flat", "html.panel-soft", "html.theme-light.panel-soft", "html.wallpaper body", "html.wallpaper body::before"]) {
      expect(block(sel), `${sel} uses color-mix`).not.toContain("color-mix");
    }
    // The utilities-layer overrides — the whole `@layer utilities { … }` block
    // that holds the html.panel-* recipes.
    const at = css.indexOf("html.panel-flat .panel-luxe");
    const open = css.lastIndexOf("@layer utilities {", at);
    const close = at + css.slice(at).search(/\r?\n\}/); // the layer's own closing brace (column 0)
    expect(css.slice(open, close), "panel recipe overrides use color-mix").not.toContain("color-mix");
  });
});
