/**
 * Source guard over the expanded position chart and its panel.
 *
 * TWO FAILURE MODES, BOTH SILENT, BOTH SHIPPED BEFORE:
 *
 *  1. A COLOUR THAT NEVER REACHES THE CANVAS. lightweight-charts parses colour
 *     strings itself and understands hex, `rgb()/rgba()`, `hsl()/hsla()` and
 *     named colours — nothing else. Handed a `color-mix()`, an `oklch()` or an
 *     unresolved `var()` it draws an INVISIBLE series: no throw, no console
 *     warning, no missing DOM node. `assertLiteralColour()` in
 *     `components/charts/lw/theme.ts` is dev-only, so a text guard is what
 *     actually holds the line in a production build. Every colour these files
 *     hand to the chart therefore has to come through the theme bridge —
 *     `theme.*`/`t.*` or `withAlpha()` — and never be written inline.
 *  2. COPY THAT ADVISES. Ruling Q31(b) and Q32: the chart states the arithmetic
 *     and names where each number came from. It never tells anyone what to do.
 *     `PRESCRIPTIVE_LANGUAGE` is the product-wide regex; the list below adds the
 *     Live Desk's own bans.
 *
 * The scan runs over comment-stripped source, so the prose in this file's own
 * header — and in the components' headers, which legitimately name the banned
 * constructs to explain them — cannot fail it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const CHART = "components/charts/lw/position-chart.tsx";
const PANEL = "components/live/position-chart-panel.tsx";
const ZONE = "components/charts/lw/position-zone-primitive.ts";
const FILES = [CHART, PANEL, ZONE];

/** Same stripper as the discipline guard: a MIME wildcard opens a comment too. */
const stripComments = (src: string) =>
  src
    .replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * The Live Desk's own bans, on top of `PRESCRIPTIVE_LANGUAGE`.
 *
 * `suggestion` / `suggestions` is deliberately NOT here: "Trailing profit
 * suggestions" is the owner's own heading for the rail (ruling Q35, and the
 * mockup). The VERB is what advises, so the verb is what is banned.
 */
const LIVE_DESK_BANNED: { re: RegExp; why: string }[] = [
  { re: /\brecommend(s|ed|ation|ations)?\b/i, why: "Vyuha computes; it does not advise" },
  { re: /\bsuggest(s|ed|ing)?\b/i, why: "the verb advises; the noun is the owner's heading" },
  { re: /\bconsider(s|ed|ing)?\b/i, why: "prompts a decision" },
  { re: /\bshould\b/i, why: "prescriptive" },
  { re: /\badvice\b/i, why: "the product is not an adviser" },
  { re: /\bopportunit(y|ies)\b/i, why: "an outcome claim" },
  { re: /\b(buy|sell|accumulate|square off|book profit)\b/i, why: "names a transaction" },
  { re: /\bwill (rise|fall|go up|go down|recover)\b/i, why: "an outcome claim" },
  { re: /\b(safe|risk-free|guaranteed profit)\b/i, why: "a risk adjective" },
];

describe("copy on the position chart states arithmetic and never advises", () => {
  it.each(FILES)("%s carries no prescriptive language", (file) => {
    const src = stripComments(read(file));
    expect(src, `${file} instructs the reader instead of describing the record`).not.toMatch(PRESCRIPTIVE_LANGUAGE);
  });

  it.each(FILES)("%s is clean of the Live Desk's banned vocabulary", (file) => {
    const src = stripComments(read(file));
    const hits = LIVE_DESK_BANNED.filter((b) => b.re.test(src)).map((b) => `${b.re} — ${b.why}`);
    expect(hits, `${file} contains banned phrasing:\n  ${hits.join("\n  ")}`).toEqual([]);
  });

  it("the panel carries the standing disclaimer, verbatim and not folded away", () => {
    expect(read(PANEL)).toContain("Vyuha computes; it does not advise.");
  });

  it("the chart carries the fills caveat — a stop is a level, not a fill", () => {
    expect(read(CHART)).toContain(
      "Stops are not guaranteed fills — gaps, circuits and illiquidity can execute worse than the level shown.",
    );
  });

  it("the risk-not-set state routes to the Sizing Lab on both surfaces (ruling Q33)", () => {
    for (const file of [CHART, PANEL]) {
      const src = read(file);
      expect(src, file).toContain("Position size needs your risk per trade.");
      expect(src, file).toContain('href="/sizing-lab"');
    }
  });

  it("the R ladder is stated, never applied (ruling Q35)", () => {
    const src = read(PANEL);
    expect(src).toContain("Vyuha never applies a step on its own.");
    // A panel that could write would be a panel that could apply a step.
    expect(stripComments(src)).not.toMatch(/\bfetch\s*\(|method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });
});

/** `upColor: theme.profit` — the key and the expression it is handed. */
const COLOUR_ASSIGNMENT = /\b([A-Za-z]*[Cc]olor)\s*:\s*([^,\n}]+)/g;

/**
 * The only expressions allowed to become a chart colour: a field of the theme
 * the bridge resolved, a `withAlpha()` of one, a colour factory closed over the
 * theme, or the literal "transparent" (which lightweight-charts special-cases).
 */
const FROM_THEME_BRIDGE = /^(withAlpha\(|(theme|t|next)\.[A-Za-z]+|[A-Za-z.]*colour\((theme|next)\)|"transparent")/;

describe("every colour reaching the canvas comes through the theme bridge", () => {
  it.each(FILES)("%s writes no raw colour function or hex literal", (file) => {
    const src = stripComments(read(file));
    // `var(--color-profit)` and `color-mix(...)` are the two that render
    // NOTHING and report NOTHING. `oklch()` is the third.
    expect(src, `${file} hands an unresolvable colour to the canvas`).not.toMatch(/var\(\s*--|color-mix\(|oklch\(|lab\(|lch\(/);
    expect(src, `${file} hard-codes a colour instead of reading the token`).not.toMatch(/["'`]#[0-9a-fA-F]{3,8}["'`]/);
    expect(src, `${file} hard-codes an rgb/hsl colour`).not.toMatch(/["'`](rgba?|hsla?)\(/);
  });

  it("every colour option in the chart is a theme expression", () => {
    const src = stripComments(read(CHART));
    const assignments = [...src.matchAll(COLOUR_ASSIGNMENT)].map(([, key, value]) => [key, value.trim()] as const);

    expect(assignments.length, "no colour options found — has the chart stopped drawing?").toBeGreaterThan(6);
    for (const [key, value] of assignments) {
      expect(value, `${key}: ${value} does not come from the theme bridge`).toMatch(FROM_THEME_BRIDGE);
    }
  });

  it("the chart reads the theme and the zone tints from `withAlpha`, not from a constant", () => {
    const src = read(CHART);
    expect(src).toMatch(/import\s*\{[^}]*withAlpha[^}]*\}\s*from\s*"\.\/theme"/);
    expect(src).toMatch(/reward:\s*withAlpha\(t\.profit/);
    expect(src).toMatch(/risk:\s*withAlpha\(t\.loss/);
  });

  it("the panel hands the chart data, never colours", () => {
    const src = stripComments(read(PANEL));
    expect([...src.matchAll(COLOUR_ASSIGNMENT)]).toEqual([]);
  });

  it("the zone primitive stores the colours it is given and composes none", () => {
    const src = stripComments(read(ZONE));
    expect(src).toMatch(/fillStyle\s*=\s*(style\.|rect\.kind)/);
    expect(src).not.toMatch(/withAlpha\(/);
  });
});

describe("the stop line names where its number came from (ruling Q31(b), Q33)", () => {
  it("labels an ATR stop with the risk percentage and the ATR length", async () => {
    const { stopLineTitle } = await import("@/components/charts/lw/position-chart");

    expect(stopLineTitle({ stopP: 260000, source: "atr", riskPpm: 20000, atrLength: 21 })).toBe(
      "Stop 2,600.00 — computed from your 2% risk per trade and the 21-day ATR",
    );
  });

  it("names every other branch of the tree, and never presents a manual level as computed", async () => {
    const { stopLineTitle } = await import("@/components/charts/lw/position-chart");
    const at = (source: "manual" | "structure" | "percent") =>
      stopLineTitle({ stopP: 260000, source, riskPpm: 20000, atrLength: 21 });

    expect(at("manual")).toBe("Stop 2,600.00 — the level you recorded");
    expect(at("structure")).toContain("the swing level on this chart");
    expect(at("percent")).toContain("your fixed percentage");
  });

  it("says so plainly when the risk percentage is not a prop, rather than printing a number", async () => {
    const { stopLineTitle } = await import("@/components/charts/lw/position-chart");

    expect(stopLineTitle({ stopP: 260000, source: "atr", riskPpm: null, atrLength: 14 })).toBe(
      "Stop 2,600.00 — computed from your recorded risk per trade and the 14-day ATR",
    );
  });

  it("the target is the user's number and the trail names its method", async () => {
    const { targetLineTitle, trailLineTitle } = await import("@/components/charts/lw/position-chart");

    expect(targetLineTitle(335000)).toBe("Your target 3,350.00");
    expect(trailLineTitle(274200, "chandelier, 22 bars × 3 ATR")).toBe(
      "Trailing stop 2,742.00 — chandelier, 22 bars × 3 ATR",
    );
  });
});
