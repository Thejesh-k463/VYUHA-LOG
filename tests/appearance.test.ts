import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SKINS, SKIN_META } from "@/lib/domain/skin";
import {
  DEFAULT_CUSTOM_THEME,
  NEUTRAL_CHROME,
  PANEL_STYLES,
  SKIN_HUE,
  TINTED_SKINS,
  WALLPAPER_MAX_BYTES,
  appearanceClasses,
  appearanceVars,
  asPanelStyle,
  chromeVars,
  clampIntensity,
  contrastRatio,
  customThemeWarnings,
  customVars,
  darken,
  hexToHsl,
  hexToRgb,
  hslToHex,
  lighten,
  mix,
  panelClass,
  parseCustomTheme,
  relativeLuminance,
  rgbToHex,
  serializeCustomTheme,
  wallpaperVars,
  withAlpha,
} from "@/lib/domain/appearance";

/** The one shape the chart canvas can parse: #rrggbb or rgba(r, g, b, a<1). */
const LITERAL = /^#[0-9a-f]{6}$|^rgba\(\d+, \d+, \d+, 0?\.\d+\)$/;
const alphaOf = (v: string) => Number(v.match(/, (0?\.\d+)\)$/)![1]);

describe("colour maths", () => {
  it("hex ⇄ rgb ⇄ hsl round-trip", () => {
    expect(hexToRgb("#2dd4bf")).toEqual({ r: 45, g: 212, b: 191 });
    expect(rgbToHex({ r: 45, g: 212, b: 191 })).toBe("#2dd4bf");
    for (const h of ["#000000", "#ffffff", "#2dd4bf", "#e8b006", "#7196ff", "#14181f"]) {
      expect(hslToHex(hexToHsl(h))).toBe(h);
    }
    expect(hexToHsl("#ff0000")).toEqual({ h: 0, s: 100, l: 50 });
  });

  it("mix is linear and clamped", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#000000", "#ffffff", 7)).toBe("#ffffff");
  });

  it("WCAG: black on white is 21:1, a colour on itself is 1:1, order does not matter", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#2dd4bf", "#2dd4bf")).toBe(1);
    expect(contrastRatio("#2dd4bf", "#05080f")).toBeCloseTo(contrastRatio("#05080f", "#2dd4bf"), 10);
    // Luxe's dark primary on the dark canvas — the figure recorded in skin.ts.
    expect(contrastRatio("#2dd4bf", "#05080f")).toBeGreaterThan(10);
  });

  it("darken lowers and lighten raises lightness; both clamp", () => {
    expect(hexToHsl(darken("#2dd4bf", 12)).l).toBeLessThan(hexToHsl("#2dd4bf").l);
    expect(hexToHsl(lighten("#2dd4bf", 12)).l).toBeGreaterThan(hexToHsl("#2dd4bf").l);
    expect(darken("#000000", 20)).toBe("#000000");
    expect(lighten("#ffffff", 20)).toBe("#ffffff");
  });

  it("withAlpha emits the exact rgba(r, g, b, a) form and rounds to 3 dp", () => {
    expect(withAlpha("#94a3b8", 0.14)).toBe("rgba(148, 163, 184, 0.14)");
    expect(withAlpha("#94a3b8", 0.14 + 0.3 * 0.5)).toBe("rgba(148, 163, 184, 0.29)");
    expect(withAlpha("#94a3b8", 0.29)).toMatch(LITERAL);
  });

  it("clampIntensity rounds and clamps, falling back to the default", () => {
    expect(clampIntensity(50)).toBe(50);
    expect(clampIntensity(140)).toBe(100);
    expect(clampIntensity(-3)).toBe(0);
    expect(clampIntensity("72.6")).toBe(73);
    expect(clampIntensity(null)).toBe(50);
    expect(clampIntensity("x")).toBe(50);
  });
});

describe("SKIN_HUE covers the roster and matches the CSS", () => {
  const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const block = (selector: string) => {
    const i = css.indexOf(`\n  ${selector} {`);
    if (i < 0) return "";
    const start = css.indexOf("{", i);
    return css.slice(start + 1, css.indexOf("\n  }", start));
  };
  const primaryIn = (b: string) => b.match(/--color-primary\s*:\s*(#[0-9a-fA-F]{6})/)?.[1]?.toLowerCase();

  it("has an entry for every skin; mono and custom are untinted", () => {
    for (const s of SKINS) expect(s in SKIN_HUE, s).toBe(true);
    expect(SKIN_HUE.mono).toBeNull();
    expect(SKIN_HUE.custom).toBeNull();
    expect(TINTED_SKINS).not.toContain("mono");
    expect(TINTED_SKINS).not.toContain("custom");
    expect(TINTED_SKINS).toContain("luxe");
  });

  it("each tinted skin's hue IS its CSS --color-primary in both themes", () => {
    const themeBlock = css.slice(css.indexOf("@theme static {"), css.indexOf("\n}", css.indexOf("@theme static {")));
    for (const s of TINTED_SKINS) {
      const hue = SKIN_HUE[s]!;
      const dark = s === "luxe" ? primaryIn(themeBlock) : primaryIn(block(`html.skin-${s}`));
      const light = s === "luxe" ? primaryIn(block("html.theme-light")) : primaryIn(block(`html.theme-light.skin-${s}`));
      expect(hue.dark, `${s} dark`).toBe(dark);
      expect(hue.light, `${s} light`).toBe(light);
      expect(SKIN_META[s].swatch.primary.toLowerCase(), `${s} swatch`).toBe(hue.dark);
    }
  });

  it("the neutral chrome constants are the CSS defaults", () => {
    const themeBlock = css.slice(css.indexOf("@theme static {"), css.indexOf("\n}", css.indexOf("@theme static {")));
    expect(themeBlock).toContain(`--color-background: ${NEUTRAL_CHROME.dark.background}`);
    expect(themeBlock).toContain(`--color-card-top: ${NEUTRAL_CHROME.dark.cardTop}`);
    expect(themeBlock).toContain(`--color-foreground: ${NEUTRAL_CHROME.dark.foreground}`);
    const light = block("html.theme-light");
    expect(light).toContain(`--color-background: ${NEUTRAL_CHROME.light.background}`);
    expect(light).toContain(`--color-border: ${NEUTRAL_CHROME.light.border}`);
    expect(light).toContain(`--color-foreground: ${NEUTRAL_CHROME.light.foreground}`);
  });
});

describe("chromeVars", () => {
  const CHROME = [
    "--color-background",
    "--color-surface",
    "--color-card",
    "--color-card-top",
    "--color-card-hover",
    "--color-border",
    "--color-rule",
    "--color-header-band",
  ];

  it("mono and custom return nothing — flat, and user-owned, respectively", () => {
    expect(chromeVars({ skin: "mono", theme: "dark", intensity: 100 })).toEqual({});
    expect(chromeVars({ skin: "custom", theme: "light", intensity: 100 })).toEqual({});
  });

  for (const theme of ["dark", "light"] as const) {
    it(`every value is a LITERAL colour, all eight tokens present (${theme})`, () => {
      for (const s of TINTED_SKINS) {
        for (const i of [0, 50, 100]) {
          const v = chromeVars({ skin: s, theme, intensity: i });
          expect(Object.keys(v).sort()).toEqual([...CHROME].sort());
          for (const [k, val] of Object.entries(v)) {
            expect(val, `${s} ${theme} ${i} ${k}`).toMatch(LITERAL);
            expect(val).not.toContain("color-mix");
            expect(val).not.toContain("var(");
          }
        }
      }
    });

    it(`intensity is monotonic: the border is stronger at 100 than at 0 (${theme})`, () => {
      for (const s of TINTED_SKINS) {
        const lo = chromeVars({ skin: s, theme, intensity: 0 });
        const hi = chromeVars({ skin: s, theme, intensity: 100 });
        const hue = SKIN_HUE[s]![theme];
        if (theme === "dark") {
          expect(alphaOf(hi["--color-border"]!), s).toBeGreaterThan(alphaOf(lo["--color-border"]!));
          expect(alphaOf(hi["--color-rule"]!), s).toBeGreaterThan(alphaOf(lo["--color-rule"]!));
        } else {
          // Closer to the hue = lower contrast against it.
          expect(contrastRatio(hi["--color-border"]!, hue), s).toBeLessThan(contrastRatio(lo["--color-border"]!, hue));
        }
        expect(contrastRatio(hi["--color-background"]!, hue), s).toBeLessThan(contrastRatio(lo["--color-background"]!, hue));
        expect(hi["--color-background"]).not.toBe(lo["--color-background"]);
      }
    });
  }

  it("light foreground stays ≥ 7:1 on the tinted light canvas, card and surface at intensity 100, every skin", () => {
    for (const s of TINTED_SKINS) {
      const v = chromeVars({ skin: s, theme: "light", intensity: 100 });
      for (const k of ["--color-background", "--color-card", "--color-card-top", "--color-surface"] as const) {
        expect(contrastRatio(NEUTRAL_CHROME.light.foreground, v[k]!), `${s} ${k}`).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("dark foreground stays ≥ 12:1 on the tinted dark canvas, card and surface, ≥ 9:1 on card-top/hover, at intensity 100, every skin", () => {
    for (const s of TINTED_SKINS) {
      const v = chromeVars({ skin: s, theme: "dark", intensity: 100 });
      for (const k of ["--color-background", "--color-card", "--color-surface"] as const) {
        expect(contrastRatio(NEUTRAL_CHROME.dark.foreground, v[k]!), `${s} ${k}`).toBeGreaterThanOrEqual(12);
      }
      for (const k of ["--color-card-top", "--color-card-hover"] as const) {
        expect(contrastRatio(NEUTRAL_CHROME.dark.foreground, v[k]!), `${s} ${k}`).toBeGreaterThanOrEqual(9);
      }
    }
  });

  it("no two tinted skins share a canvas at the same intensity — the reason skins tint at all", () => {
    for (const theme of ["dark", "light"] as const) {
      const seen = new Map<string, string>();
      for (const s of TINTED_SKINS) {
        const bg = chromeVars({ skin: s, theme, intensity: 50 })["--color-background"]!;
        expect(seen.get(bg), `${s} and ${seen.get(bg)} share ${bg} (${theme})`).toBeUndefined();
        seen.set(bg, s);
      }
    }
  });

  it("intensity 0 is still faintly tinted — a coloured skin is never fully neutral", () => {
    const v = chromeVars({ skin: "tape", theme: "dark", intensity: 0 });
    expect(v["--color-background"]).not.toBe(NEUTRAL_CHROME.dark.background);
    expect(contrastRatio(v["--color-background"]!, NEUTRAL_CHROME.dark.background)).toBeLessThan(1.15);
  });
});

describe("custom theme", () => {
  it("parseCustomTheme accepts the default (object and JSON string) and normalises case", () => {
    expect(parseCustomTheme(DEFAULT_CUSTOM_THEME)).toEqual(DEFAULT_CUSTOM_THEME);
    expect(parseCustomTheme(serializeCustomTheme(DEFAULT_CUSTOM_THEME))).toEqual(DEFAULT_CUSTOM_THEME);
    const upper = { dark: { ...DEFAULT_CUSTOM_THEME.dark, accent: "#2DD4BF" }, light: DEFAULT_CUSTOM_THEME.light };
    expect(parseCustomTheme(upper)!.dark.accent).toBe("#2dd4bf");
  });

  it("parseCustomTheme rejects a bad hex, a missing field, a missing side, garbage", () => {
    const bad = (side: Record<string, string>) => ({ dark: side, light: DEFAULT_CUSTOM_THEME.light });
    expect(parseCustomTheme(bad({ ...DEFAULT_CUSTOM_THEME.dark, accent: "#fff" }))).toBeNull();
    expect(parseCustomTheme(bad({ ...DEFAULT_CUSTOM_THEME.dark, accent: "rgb(1,2,3)" }))).toBeNull();
    expect(parseCustomTheme(bad({ ...DEFAULT_CUSTOM_THEME.dark, accent: "teal" }))).toBeNull();
    expect(parseCustomTheme(bad({ ...DEFAULT_CUSTOM_THEME.dark, accent: "#2dd4bfff" }))).toBeNull();
    const { money: _m, ...missing } = DEFAULT_CUSTOM_THEME.dark;
    expect(parseCustomTheme(bad(missing as Record<string, string>))).toBeNull();
    expect(parseCustomTheme({ dark: DEFAULT_CUSTOM_THEME.dark })).toBeNull();
    for (const g of [null, undefined, "", "{", 7, [], "not json", { dark: null, light: null }]) {
      expect(parseCustomTheme(g), String(g)).toBeNull();
    }
  });

  it("customVars derives every accent and chrome token, all literal, in both themes", () => {
    for (const theme of ["dark", "light"] as const) {
      const v = customVars(theme, DEFAULT_CUSTOM_THEME);
      const side = DEFAULT_CUSTOM_THEME[theme];
      for (const need of [
        "--color-primary", "--color-primary-deep", "--color-primary-foreground", "--color-ring",
        "--color-violet", "--color-violet-deep", "--color-accent",
        "--color-gold", "--color-gold-bright", "--color-gold-deep", "--color-warning",
        "--color-surface", "--color-background", "--color-card", "--color-card-top", "--color-card-hover",
        "--color-border", "--color-rule", "--color-header-band",
      ]) {
        expect(v[need], `${theme} ${need}`).toMatch(LITERAL);
      }
      expect(v["--color-primary"]).toBe(side.accent);
      expect(v["--color-ring"]).toBe(side.accent);
      expect(v["--color-violet"]).toBe(side.analytics);
      expect(v["--color-accent"]).toBe(side.analytics);
      expect(v["--color-gold"]).toBe(side.money);
      expect(v["--color-warning"]).toBe(side.money);
      expect(v["--color-background"]).toBe(side.background);
      expect(v["--color-card"]).toBe(side.card);
      expect(v["--color-surface"]).toBe(side.surface);
      // Never touches profit/loss — those belong to colourblind mode.
      expect(v["--color-profit"]).toBeUndefined();
      expect(v["--color-loss"]).toBeUndefined();
      // primary-foreground is readable ON the accent.
      expect(contrastRatio(v["--color-primary-foreground"]!, side.accent)).toBeGreaterThanOrEqual(4.5);
    }
    // Dark border is translucent (rgba), light border is the hex itself.
    expect(customVars("dark", DEFAULT_CUSTOM_THEME)["--color-border"]).toMatch(/^rgba\(/);
    expect(customVars("light", DEFAULT_CUSTOM_THEME)["--color-border"]).toBe(DEFAULT_CUSTOM_THEME.light.border);
  });

  it("the default custom theme has no warnings; a grey accent on grey does", () => {
    expect(customThemeWarnings(DEFAULT_CUSTOM_THEME)).toEqual([]);
    const bad = {
      dark: { ...DEFAULT_CUSTOM_THEME.dark, accent: "#333333", background: "#222222" },
      light: { ...DEFAULT_CUSTOM_THEME.light, background: "#888888" },
    };
    const w = customThemeWarnings(bad);
    expect(w.find((x) => x.side === "dark" && x.field === "accent")).toBeTruthy();
    expect(w.find((x) => x.side === "light" && x.field === "foreground")).toBeTruthy();
    for (const x of w) expect(x.ratio).toBeLessThan(x.floor);
    // A colour-blind-safe check on the SIDE that is fine says nothing about it.
    expect(w.find((x) => x.side === "dark" && x.field === "foreground")).toBeUndefined();
  });
});

describe("panel style + wallpaper + appearanceVars", () => {
  it("panelClass: luxe is the default (no class), the rest are panel-<style>", () => {
    expect([...PANEL_STYLES]).toEqual(["flat", "soft", "luxe", "glow"]);
    expect(panelClass("luxe")).toBeNull();
    expect(panelClass("flat")).toBe("panel-flat");
    expect(panelClass("soft")).toBe("panel-soft");
    expect(panelClass("glow")).toBe("panel-glow");
    expect(asPanelStyle("glow")).toBe("glow");
    expect(asPanelStyle("neon")).toBe("luxe");
    expect(asPanelStyle(null)).toBe("luxe");
  });

  it("wallpaperVars: scrim alpha = 1 − opacity/100", () => {
    expect(WALLPAPER_MAX_BYTES).toBe(12 * 1024 * 1024);
    expect(wallpaperVars(35)).toEqual({ "--wallpaper-scrim": "0.65" });
    expect(wallpaperVars(0)).toEqual({ "--wallpaper-scrim": "1" });
    expect(wallpaperVars(100)).toEqual({ "--wallpaper-scrim": "0" });
    expect(wallpaperVars(250)).toEqual({ "--wallpaper-scrim": "0" });
  });

  it("appearanceVars: tinted skin → chrome; custom → customVars; wallpaper only when stored", () => {
    const tape = appearanceVars({ skin: "tape", theme: "dark", intensity: 50, wallpaper: { storedName: null, opacity: 35 } });
    expect(tape).toEqual(chromeVars({ skin: "tape", theme: "dark", intensity: 50 }));
    expect(tape["--wallpaper"]).toBeUndefined();

    const custom = appearanceVars({ skin: "custom", theme: "light", intensity: 50, customTheme: DEFAULT_CUSTOM_THEME });
    expect(custom["--color-primary"]).toBe(DEFAULT_CUSTOM_THEME.light.accent);
    // No stored custom theme yet → Luxe's values, never a blank screen.
    expect(appearanceVars({ skin: "custom", theme: "dark", intensity: 50, customTheme: null })["--color-primary"]).toBe("#2dd4bf");

    const wp = appearanceVars({ skin: "luxe", theme: "dark", intensity: 50, wallpaper: { storedName: "wp-1 a.jpg", opacity: 40 } });
    expect(wp["--wallpaper-scrim"]).toBe("0.6");
    expect(wp["--wallpaper"]).toBe('url("/api/appearance/wallpaper?v=wp-1%20a.jpg")');
    expect(appearanceVars({ skin: "mono", theme: "dark", intensity: 50 })).toEqual({});
  });

  it("appearanceClasses: panel class + wallpaper flag", () => {
    expect(appearanceClasses({ panelStyle: "luxe", wallpaper: null })).toEqual([]);
    expect(appearanceClasses({ panelStyle: "glow", wallpaper: { storedName: "x.png" } })).toEqual(["panel-glow", "wallpaper"]);
  });
});
