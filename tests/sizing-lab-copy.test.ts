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
import {
  DEFAULT_RISK_PCT_PPM,
  JOURNAL_CEILING_FLAG,
  KELLY_JOURNAL_DESCRIPTION,
  LAB_METHODS,
  journalCeilingLine,
  journalRefusalLine,
  journalSampleLine,
  kellyDescription,
} from "@/components/sizing/lab-config";
import type { JournalKellyOk } from "@/lib/analytics/journal-kelly";
import { sizePctVolatility, sizeVolatilityUnit } from "@/lib/risk/sizing";

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
  // v4.7.0 C3 — the Kelly tab's journal panel speaks inside the Lab, so it is held to the Lab's words.
  "components/sizing/journal-kelly-panel.tsx",
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

/**
 * Build prompt §0.2 Q-1: the two pre-trade screens are cross-linked, BOTH ways.
 * They answer adjacent questions — how many shares my rule allows, and what the
 * round trip costs — and a trader who lands on one has no way to discover the
 * other from the sidebar alone. The link is factual: it names what the other
 * screen computes, and neither tells the reader to go there.
 */
describe("the Lab and the calculator each name the other (U5)", () => {
  const CALC_PAGE = "app/calculator/page.tsx";

  it("the Lab links to the calculator, and says what it computes", () => {
    const src = read(CLIENT);
    expect(src, "no link from the Lab to /calculator").toMatch(/href="\/calculator"/);
    expect(src).toContain("Charges and break-even for a trade");
  });

  it("the calculator links to the Lab, and says what it computes", () => {
    const src = read(CALC_PAGE);
    expect(src, "no link from /calculator to the Lab").toMatch(/href="\/sizing-lab"/);
    expect(src).toContain("Position size from a risk budget");
  });

  it("neither cross-link instructs the reader", () => {
    for (const f of [CLIENT, CALC_PAGE]) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(PRESCRIPTIVE_LANGUAGE);
    }
  });
});

/**
 * v4.1 docs wave. The `pct-volatility` tab description read "At identical
 * inputs it returns a larger quantity than the Turtle unit" — false on the
 * screen a reader opens. Both methods run `floor(budget x 1000 / atrP3)` over
 * the same ATR and differ only in the budget, so Varsity returns
 * `riskPpm / unitRiskPpm` times the Turtle unit (lib/risk/sizing.ts
 * `sizePctVolatility` vs `sizeVolatilityUnit`); at the Lab's own opening
 * sample — `DEFAULT_RISK_PCT_PPM` 2,500 against `unitRiskPpm` 10,000 — that
 * factor is 0.25 and the Turtle unit is FOUR TIMES larger. Nothing else pins a
 * `LAB_METHODS` description, so the false sentence could return unnoticed; the
 * direction word is what this holds.
 */
describe("the % volatility tab states the true relation to the Turtle unit", () => {
  it("never claims it always returns the larger quantity", () => {
    const desc = LAB_METHODS.find((m) => m.id === "pct-volatility")?.description ?? "";
    expect(desc, "no pct-volatility method in LAB_METHODS").not.toBe("");
    expect(desc, "the false unconditional claim is back").not.toContain(
      "it returns a larger quantity than the Turtle unit",
    );
    expect(desc, "the ratio that actually relates the two variants is not stated").toContain(
      "times your per-trade risk % divided by the Turtle unit risk %",
    );
  });

  it("the arithmetic the sentence describes is the arithmetic the engine does", () => {
    // Same ATR, same lot size, same entry/stop: the only difference is the
    // budget, so the quantities stand in the budgets' own ratio.
    const common = { capitalP: 10_000_000, atrP3: 5_000_000, entryP: 100_000, stopP: 95_000, lotSize: 1 };
    const varsity = sizePctVolatility({ ...common, riskPpm: DEFAULT_RISK_PCT_PPM });
    const turtle = sizeVolatilityUnit({ ...common, unitRiskPpm: 10_000 });
    expect(varsity.ok && turtle.ok).toBe(true);
    if (!varsity.ok || !turtle.ok) return;
    // 2,500 / 10,000 = a QUARTER, not "larger" and not "around twice".
    expect(varsity.qty * 4).toBe(turtle.qty);
    expect(varsity.qty).toBeLessThan(turtle.qty);
  });
});

/**
 * v4.7.0 C3 (design D9, D10, K6, K7; research R4, R6). The journal branch of
 * the Kelly card says the same thing about the record that R4 says about typed
 * inputs: the formula returns a number FROM it, the record is not a forecast.
 * The panel's lines state what was measured, over which trades, and why a
 * refusal refused — never an instruction, never a counterfactual.
 */
describe("the Kelly tab's journal copy (C3)", () => {
  const ok: JournalKellyOk = {
    ok: true, label: "Whole account", n: 42, of: 1292, winPpm: 452_381, payoffPpm: 1_840_000,
    p: 0.452381, pLo: 0.31, pHi: 0.6, b: 1.84, bLo: 1.2, lossHi: 0.92, kellyPoint: 0.1546, kellyAtLowerBounds: 0.0392, halfKellyLowerBound: 0.0213, supportsSizingUp: true,
  };
  const weak: JournalKellyOk = { ...ok, halfKellyLowerBound: null, kellyAtLowerBounds: -0.265, supportsSizingUp: false };
  // Q3 / R4 + CG-1: Kelly at the lower bounds positive, but the empirical Kelly is off the grid.
  const offGrid: JournalKellyOk = { ...ok, halfKellyLowerBound: null, kellyAtLowerBounds: 0.27, supportsSizingUp: false };
  const lines = [
    KELLY_JOURNAL_DESCRIPTION,
    journalSampleLine(ok, "all"),
    journalSampleLine(ok, "12m"),
    journalCeilingLine(ok),
    journalCeilingLine(weak),
    JOURNAL_CEILING_FLAG,
    journalRefusalLine({ ok: false, reason: "all-view", n: 0, of: 0, need: 30 }),
    journalRefusalLine({ ok: false, reason: "below-floor", n: 0, of: 1292, need: 30 }),
    journalRefusalLine({ ok: false, reason: "no-losing-trades", n: 31, of: 31, need: 30 }),
    journalCeilingLine(offGrid),
  ];

  it("the journal branch says the record measured the inputs and is not a forecast; the manual branch keeps 'you supplied' (R4)", () => {
    expect(kellyDescription("journal")).toBe(KELLY_JOURNAL_DESCRIPTION);
    expect(KELLY_JOURNAL_DESCRIPTION).toContain(
      "The Kelly formula, with the win rate and payoff measured in your own record, returns a fraction of capital. The record is not a forecast.",
    );
    expect(kellyDescription("manual")).toContain("with the win rate and payoff you supplied");
  });

  it("D9: the sample line names N of M, the slice, the window, the win rate with its interval, and the payoff", () => {
    expect(journalSampleLine(ok, "all")).toBe(
      "From your journal: 42 of 1,292 closed trades in Whole account, all dates. Win rate 45.2 % (95 % CI 31.0–60.0). Payoff 1.84 R.",
    );
    expect(journalSampleLine(ok, "12m")).toContain("closed trades in Whole account, the last 12 months.");
  });

  it("D10 / K7: the ceiling line, the flag, and the weak-edge mark in C1's words", () => {
    // Q3 (v4.7.0 audit): the ceiling is per 1R and the line says how — the divisor and the cap.
    expect(journalCeilingLine(ok)).toBe(
      "Clinic ceiling for this slice, per 1R: ½ Kelly at the lower 95 % bounds over the average loss at its upper 95 % bound (0.92 R), no higher than ½ the empirical Kelly = 2.13 % of capital at risk per trade.",
    );
    // R4 + CG-1: a positive Kelly at the lower bounds with no ceiling must not claim "is not positive".
    expect(journalCeilingLine(offGrid)).toBe(
      "Whole account: no Clinic ceiling — Kelly at the lower 95 % bounds is positive, but the empirical Kelly has no maximum below 99 % of capital per 1R (the losses measured are too small to size against).",
    );
    expect(JOURNAL_CEILING_FLAG).toBe("Your Kelly fraction puts more at risk than this ceiling.");
    expect(journalCeilingLine(weak)).toMatch(/^Whole account: the data does not support sizing up — Kelly at the lower 95 % bounds \(win rate 31\.0 %, payoff 1\.20 R\) is not positive\.$/);
  });

  it("K6 and the floor: the refusal lines, verbatim", () => {
    expect(lines[6]).toBe("Choose one account — a Kelly from merged books describes neither.");
    expect(lines[7]).toBe("0 of 1,292 closed trades carry a real risk (a stop or a typed risk). 30 needed.");
  });

  it("no line instructs, ranks or states a counterfactual", () => {
    for (const l of lines) {
      expect(l).not.toMatch(PRESCRIPTIVE_LANGUAGE);
      expect(l).not.toMatch(/would have|could have made|missed out/i);
      expect(l).not.toMatch(/don'?t trade/i);
      for (const b of BANNED) expect(l, `${b.re} — ${b.why}`).not.toMatch(b.re);
    }
  });

  it("no Lab file states a counterfactual", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/would have|could have made|missed out/i);
  });

  it("only the click fills: the panel calls onUse from the button and nowhere else", () => {
    const src = stripComments(read("components/sizing/journal-kelly-panel.tsx"));
    expect(src.match(/onUse\(/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/onClick=\{\(\) => \{\s*if \(ok\) onUse\(ok\);\s*\}\}/);
    // The fill helper touches the two fields only — never the Kelly fraction.
    const cfg = stripComments(read(CONFIG));
    const body = /export function applyJournalKelly[\s\S]*?\n\}/.exec(cfg)?.[0] ?? "";
    expect(body).toContain("winPpm");
    expect(body).not.toContain("kellyFractionPpm");
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
