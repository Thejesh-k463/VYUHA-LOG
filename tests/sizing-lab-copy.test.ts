/**
 * Source guard over the Sizing Lab's surface (spec §3.4, rulings Q36–Q41).
 *
 * The Lab is the one screen in Vyuha that prints a QUANTITY next to a price.
 * That is exactly the shape of an investment recommendation, and the only
 * thing that keeps it on the right side of the line is its wording: it states
 * what it COMPUTED, from which figures, and what happens IF THE STOP IS HIT —
 * it never tells the reader to take the trade, and it never calls a number
 * safe. None of that can be asserted by rendering, because the failure mode is
 * a phrase, so this is a text guard over the source.
 *
 * It also holds three things that go wrong silently:
 *   - a fallback charge schedule presented as the user's own (invariant 3 —
 *     `lib/data/charge-rates-defaults.json` has to be labelled "default
 *     schedule" wherever it prices something);
 *   - a settings write turned into a server action, which would remount the
 *     Lab's sibling client components and wipe the setup being typed;
 *   - money formatted inline instead of through the repo formatter, which is
 *     how a lakh loses its Indian grouping.
 *
 * The scan runs over comment-stripped source, so the prose in this file's
 * header and in the components' own headers — which legitimately name the
 * banned words to explain them — cannot fail it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const CLIENT = "components/sizing/lab-client.tsx";
const TILES = "components/sizing/tiles.tsx";
const DIALOG = "components/sizing/write-back-dialog.tsx";
const CONFIG = "components/sizing/lab-config.ts";
const PAGE = "app/sizing-lab/page.tsx";

const FILES = [
  CLIENT,
  TILES,
  DIALOG,
  CONFIG,
  PAGE,
  "components/sizing/method-rail.tsx",
  "components/sizing/formula-block.tsx",
  "components/sizing/compare-table.tsx",
];

/** Same stripper as `tests/position-chart-copy.test.ts`. */
const stripComments = (src: string) =>
  src
    .replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * The Live Desk vocabulary ban, carried over verbatim from the position-chart
 * guard so the two surfaces cannot drift apart. `buy`/`sell` are here for the
 * Lab's own reason: a tile labelled with a transaction verb turns an
 * arithmetic result into an instruction.
 */
const BANNED: { re: RegExp; why: string }[] = [
  { re: /\brecommend(s|ed|ation|ations)?\b/i, why: "Vyuha computes; it does not advise" },
  { re: /\bsuggest(s|ed|ing)?\b/i, why: "the verb advises" },
  { re: /\bconsider(s|ed|ing)?\b/i, why: "prompts a decision" },
  { re: /\bshould\b/i, why: "prescriptive" },
  { re: /\badvice\b/i, why: "the product is not an adviser" },
  { re: /\bopportunit(y|ies)\b/i, why: "an outcome claim" },
  { re: /\b(buy|sell|accumulate|square off|book profit)\b/i, why: "names a transaction" },
  { re: /\bwill (rise|fall|go up|go down|recover)\b/i, why: "an outcome claim" },
  { re: /\b(safe|risk-free|guaranteed profit)\b/i, why: "a risk adjective" },
];

describe("the Sizing Lab states arithmetic and never advises", () => {
  it.each(FILES)("%s carries no prescriptive language", (file) => {
    const src = stripComments(read(file));
    expect(src, `${file} instructs the reader instead of describing the arithmetic`).not.toMatch(
      PRESCRIPTIVE_LANGUAGE,
    );
  });

  it.each(FILES)("%s is clean of the Live Desk's banned vocabulary", (file) => {
    const src = stripComments(read(file));
    const hits = BANNED.filter((b) => b.re.test(src)).map((b) => `${b.re} — ${b.why}`);
    expect(hits, `${file} contains banned phrasing:\n  ${hits.join("\n  ")}`).toEqual([]);
  });

  it("the Lab carries the standing disclaimer, verbatim and not folded away", () => {
    expect(read(CLIENT)).toContain("Vyuha computes; it does not advise.");
  });

  it("the Lab carries the fills caveat — a stop is a level, not a fill", () => {
    expect(read(CLIENT)).toContain(
      "Stops are not guaranteed fills — gaps, circuits and illiquidity can execute worse than the level shown.",
    );
  });

  it("the risk figure is described as computed, and conditional on the stop being hit", () => {
    const tiles = stripComments(read(TILES));
    expect(tiles, "a quantity tile has to say it was computed, not that it is the size to take").toMatch(
      /\bcomputed\b/i,
    );
    expect(tiles, "the loss figure is conditional — it is only real if the stop is hit").toContain(
      "if the stop is hit",
    );
  });
});

describe("a fallback charge schedule is never presented as the user's own", () => {
  it("the client labels the defaults JSON 'default schedule' (invariant 3)", () => {
    const src = read(CLIENT);
    expect(src).toContain("default schedule");
    // And the label is keyed off the source the server resolved, not guessed.
    expect(src).toContain('"default-schedule"');
  });

  it("the loader only reaches for the defaults file when charge_config has no row", () => {
    const src = read(PAGE);
    expect(src).toContain("charge-rates-defaults.json");
    expect(src).toContain('source = "default-schedule"');
    // Nothing in the Lab writes the fallback back into charge_config: a
    // reference table that seeds itself becomes indistinguishable from a
    // schedule the user actually entered.
    expect(stripComments(src)).not.toMatch(/\.insert\(\s*chargeConfig/);
  });
});

describe("the write-back is an explicit route handler, never a server action", () => {
  it("no file in the Lab declares 'use server'", () => {
    for (const f of FILES) expect(read(f), f).not.toContain("use server");
  });

  it("the dialog POSTs to /api/risk/live-desk and refreshes the router itself", () => {
    const src = read(DIALOG);
    expect(src).toContain('fetch("/api/risk/live-desk"');
    expect(src).toContain('method: "POST"');
    expect(src).toContain("router.refresh()");
  });

  it("only the dialog can write — no other Lab file issues a mutating fetch", () => {
    for (const f of FILES.filter((x) => x !== DIALOG)) {
      expect(stripComments(read(f)), f).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    }
  });

  it("the dialog shows old → new per field before it fires (ruling Q36)", () => {
    const src = read(DIALOG);
    expect(src).toContain("Stored now");
    expect(src).toContain("After saving");
    expect(src).toMatch(/from=\{/);
    expect(src).toMatch(/to=\{/);
  });
});

describe("money is formatted by the repo formatter, never inline", () => {
  it.each(FILES)("%s does not hand-roll a locale or a rupee sign", (file) => {
    const src = stripComments(read(file));
    expect(src, `${file} formats money itself instead of using lib/money + lib/format`).not.toMatch(
      /toLocaleString|Intl\.NumberFormat|en-IN/,
    );
  });

  it("the components that print money import the repo formatter", () => {
    for (const f of [CLIENT, TILES, "components/sizing/compare-table.tsx"]) {
      expect(read(f), f).toMatch(/from "@\/lib\/money"/);
    }
  });
});
