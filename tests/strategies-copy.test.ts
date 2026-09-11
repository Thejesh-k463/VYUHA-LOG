import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowseDrawer } from "@/components/strategies/browse-drawer";
import {
  FIGURE_TONE_CLASS,
  STRATEGY_COPY,
  UNCAPPED_SUB,
  capNote,
  customName,
  figureDescriptor,
  helpHref,
  legCountLabel,
} from "@/components/strategies/strategy-copy";
import { CATALOGUE } from "@/lib/analytics/strategy-catalogue";
import { OPTIONS_HELP_FOOTER, OPTIONS_SECTION_ANCHOR } from "@/lib/domain/options-help";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { SEBI_FNO_FACTS } from "@/lib/analytics/sebi-reality";
import { sebiRealityLine } from "@/lib/domain/options-help";

/**
 * THE /strategies COPY GUARD (research note §6).
 *
 * A payoff diagram is arithmetic; a sentence next to it is where a screen stops
 * computing and starts advising, and that is the SEBI IA line. §6 names the
 * vocabulary that must never appear here and asks for exactly this lint over
 * `app/strategies/**` — "the only thing that keeps it true after six more
 * edits". `tests/live-tracker-copy.test.ts` is the shape this follows,
 * including its two hard-won properties:
 *
 *  1. it scans the WHOLE comment-stripped source, not extracted string
 *     literals — a JSX text node containing an interpolation defeats every
 *     extractor, and this screen is nothing but figures inside text;
 *  2. the one legitimately-negated sentence is exempt BY VALUE, not by a hole
 *     in the regex, so the regex still fires on it here.
 */

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["app/strategies", "components/strategies"];

const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function files(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));
  return out;
}

/**
 * The footer says what Vyuha is NOT doing ("Not a forecast and not advice"),
 * which is the one legitimate use of a banned word. Removed by value before the
 * scan; the regex below still fires on it, which the falsification pins.
 */
const EXEMPT = [OPTIONS_HELP_FOOTER];

/**
 * The paywall sentence states its number in words, and the number is a COUNT
 * of catalogue rows (G-2). Only the count the code actually has is spellable
 * here: any other count is a loud failure rather than a sentence that quietly
 * stops matching the boundary it describes.
 */
const FREE_COUNT_WORD: Record<number, string> = { 16: "sixteen" };

function copyOf(file: string): string {
  let src = stripComments(fs.readFileSync(file, "utf8"));
  for (const e of EXEMPT) src = src.split(e).join(" ");
  return src;
}

/**
 * §6's list, plus the transaction verbs the Live Desk guard already bans.
 *
 * Every token is `\b`-anchored, so the journal's own column names survive:
 * `buyQty`, `avgBuyPrice`, `sellQty` and `avgSellPrice` all continue into
 * another word character. `\btarget\b` is bare here, unlike the Live Desk's
 * `target price` — this screen has no user-recorded target to print, so any
 * "target" on it is Vyuha asserting one.
 *
 * T-1 (audit round 3): the two transaction verbs were bare — `\bbuy\b` and
 * `\bsell\b` — so "Try selling the wing" walked straight through a gate whose
 * whole job is that sentence. `tests/options-help.test.ts:143` bans
 * `buys|buying|sells|selling|seller|must|will` for the SAME copy rule on the
 * same 40 shapes, and the inflections were added here to match it.
 *
 * R4-T-1: that comment then CLAIMED to be the wider of the two, and it was not.
 * The claim was never checked, and the lists had diverged in BOTH directions —
 * help had `tips?`, `shall`, `suggestion(s)` and the whole `guarantee\w*` family
 * that this one lacked, while this one had `buyer(s)`, `sellers`, `safest`,
 * `safety` and `safely` that help lacked. A gate documented as a superset of
 * another gate has to BE one, or the two screens are held to two different copy
 * rules while both greens say otherwise. This regex is now the UNION of the two
 * lists, so the claim is true by construction: every word either gate refuses,
 * this one refuses. `must`, `will` and `shall` are the other half of
 * prescription — a screen that states what a structure IS never needs any of
 * them — and a "tip" is advice wearing a friendlier noun.
 */
const BANNED =
  /\b(recommend(s|ed|ation|ations)?|suggest(s|ed|ion|ions)?|advice|advise[sd]?|tips?|should|shall|must|will|consider(s|ed|ing)?|buy(s|ing|er|ers)?|sell(s|ing|er|ers)?|target|expected|guarantee\w*|safe(st|ty|ly)?|ideal|best|opportunit\w*)\b/i;

describe("the /strategies vocabulary gate (§6)", () => {
  it.each(files().map((f) => path.relative(ROOT, f).replace(/\\/g, "/")))(
    "%s carries no banned vocabulary",
    (rel) => {
      const src = copyOf(path.join(ROOT, rel));
      const offenders = [...src.matchAll(new RegExp(BANNED.source, "gi"))].map((m) => m[0]);
      expect(offenders, `${rel}: ${offenders.join(" | ")}`).toEqual([]);
    },
  );

  it("scans both directories, and the scan is not empty", () => {
    // A walk over a directory that has been renamed passes vacuously. This is
    // what makes the green above mean something.
    const rel = files().map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
    expect(rel).toContain("app/strategies/page.tsx");
    expect(rel).toContain("components/strategies/strategy-copy.ts");
    expect(rel.length).toBeGreaterThanOrEqual(6);
  });

  it("the gate really can fire — a prescriptive sentence is caught", () => {
    for (const bad of [
      "We recommend a bull call spread here",
      "You should buy the far leg",
      "Consider selling the wing",
      "Our target is 24,000",
      "The expected payoff is ₹18,000",
      "This is the safest structure",
      "Max profit is guaranteed at expiry",
      "The ideal strike is 24,500",
      "Vyuha suggests a wider wing",
      // T-1: every one of these passed the gate before the inflections were
      // added, and each is the same instruction wearing a different ending.
      "Try selling the wing",
      "Buying the far leg caps the loss",
      "The seller keeps the premium",
      "You must roll this before expiry",
      "This position will be profitable above 24,000",
      // R4-T-1: every one of these walked through THIS gate while the options
      // help desk refused the identical sentence — the divergence the comment
      // above claimed did not exist.
      "One tip: widen the wing",
      "A few tips before expiry",
      "The wing shall be rolled on Thursday",
      "Our suggestion is the 24,000 strike",
      "Two suggestions for the far leg",
      "A guarantee on the downside",
      "The floor guarantees the premium",
      "Guaranteeing the credit is the point",
    ]) {
      expect(BANNED.test(bad), bad).toBe(true);
    }
  });

  it("is a genuine SUPERSET of the options help gate — in both directions (R4-T-1)", () => {
    // `tests/options-help.test.ts` holds a strict gate over `lib/domain/
    // options-help.ts` for the SAME copy rule on the SAME forty shapes, and the
    // comment on this regex says this one is the wider of the two. It says so
    // here, executably, by naming what each list had that the other did not.
    // Reverting the union to either original list fails this test.
    for (const helpOnly of ["tip", "tips", "shall", "suggestion", "suggestions", "guarantee", "guarantees", "guaranteeing"]) {
      expect(BANNED.test(`A ${helpOnly} for the reader`), `the help gate refuses "${helpOnly}" and this one does not`).toBe(true);
    }
    for (const copyOnly of ["buyer", "buyers", "sellers", "safest", "safety", "safely"]) {
      expect(BANNED.test(`A ${copyOnly} for the reader`), `the union dropped "${copyOnly}"`).toBe(true);
    }
    // The union widens what is REFUSED, never what is allowed: the register the
    // screens are actually written in still passes.
    for (const ok of ["Max loss is the debit, computed at underlying = 0.", "Two legs, one expiry."]) {
      expect(BANNED.test(ok), ok).toBe(false);
    }
  });

  it("the journal's own column names are not copy, and survive the anchoring", () => {
    for (const ok of ["avgBuyPrice", "buyQty", "sellQty", "avgSellPrice", "isCredit"]) {
      expect(BANNED.test(ok), ok).toBe(false);
    }
  });

  it("the footer is exempt BY VALUE, not by a regex hole", () => {
    expect(BANNED.test(OPTIONS_HELP_FOOTER), "the regex still fires on it").toBe(true);
    expect(EXEMPT).toContain(OPTIONS_HELP_FOOTER);
  });

  it("the sign-contradicting payoff headings need NO exemption — neither trips the gate", () => {
    // The orchestrator first asked for "Best case"; that word is a superlative the
    // gate bans on purpose, so the heading became "Highest outcome" rather than a
    // by-value hole. The footer stays the ONLY exemption.
    for (const label of [
      figureDescriptor("maxProfit", -450, "At expiry").label,
      figureDescriptor("maxProfit", 0, "At expiry").label,
      figureDescriptor("maxLoss", 800, "At expiry").label,
    ]) {
      expect(BANNED.test(label), `"${label}" trips the vocabulary gate`).toBe(false);
    }
    expect(figureDescriptor("maxProfit", -450, "At expiry").label).toBe("Highest outcome");
    expect(EXEMPT).toEqual([OPTIONS_HELP_FOOTER]);
  });

  it("a banned verb inside a JSX text node with an interpolation is still seen", () => {
    const planted = "return (<p>You should widen {inr(g.netPremium)} here</p>);";
    expect(BANNED.test(planted)).toBe(true);
    const oldExtractor = [...planted.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]);
    expect(oldExtractor.some((s) => BANNED.test(s)), "an extractor could not").toBe(false);
  });
});

describe("the §6 / §7 sentences, by value", () => {
  it("the card footer is the ONE shared constant, not a second copy of it", () => {
    // /help prints the same sentence. Two literals drift; one constant cannot.
    expect(STRATEGY_COPY.footer).toBe(OPTIONS_HELP_FOOTER);
    expect(STRATEGY_COPY.footer).toBe(
      "Computed at expiry from entry premiums. Intrinsic value only — no volatility, no time value, no charges. Not a forecast and not advice.",
    );
  });

  it("the figures are labelled BEFORE charges (Q6)", () => {
    expect(STRATEGY_COPY.beforeCharges).toBe(
      "Before charges — brokerage and statutory charges are not in these figures.",
    );
  });

  it("exactly ONE sentence on exercise STT, and it names intrinsic value (Q6)", () => {
    expect(STRATEGY_COPY.sttNote).toBe(
      "STT on an exercised option is charged on intrinsic value, not on premium, so a long butterfly's stated maximum is unreachable if the position is left to settle.",
    );
    expect(STRATEGY_COPY.sttNote.match(/\./g), "one sentence, one full stop").toHaveLength(1);
    expect(STRATEGY_COPY.sttNote).toMatch(/intrinsic value/);
  });

  it("the multi-expiry note states the direction of its own error (§7)", () => {
    expect(STRATEGY_COPY.multiExpiryNote).toMatch(/^Drawn at the nearest expiry\./);
    expect(STRATEGY_COPY.multiExpiryNote).toMatch(/intrinsic only/);
    expect(STRATEGY_COPY.multiExpiryNote).toMatch(/long far leg is understated/);
    expect(STRATEGY_COPY.multiExpiryNote).toMatch(/short far leg is overstated/);
  });

  it("the two odd cap labels carry their §6 sentence, and the ordinary ones do not", () => {
    expect(capNote("Computed at underlying = 0")).toBe(
      "Computed from your entry premiums as the value at expiry if the underlying settled at zero. A price floor, not a forecast.",
    );
    expect(capNote("Not computed")).toBe(STRATEGY_COPY.notComputedNote);
    expect(capNote("At expiry")).toBeNull();
    expect(capNote("Unlimited")).toBeNull();
  });

  it("the withheld-name chip counts the FREE boundary, and counts it from the code (G-2)", () => {
    // The sentence used to say "the eight defaults". Eight is `DEFAULT_SHELF`,
    // a different list entirely: the boundary `withholdForFree` applies is
    // `legacyFree`, the names this screen printed before 4.3, and there are
    // sixteen of them (owner ruling 2026-09-11). Counted here rather than
    // written here, so a 17th legacy row reddens the sentence instead of
    // silently contradicting it.
    const free = CATALOGUE.filter((d) => d.legacyFree).length;
    const word = FREE_COUNT_WORD[free];
    expect(word, `${free} legacyFree rows — no spelled-out word is known for that count`).toBeDefined();
    expect(STRATEGY_COPY.proWithheldNote).toContain(word);
    expect(STRATEGY_COPY.proWithheldNote).toMatch(/stay free/);
    expect(STRATEGY_COPY.proWithheldNote, "DEFAULT_SHELF is a different list").not.toMatch(/\beight\b/i);
    expect(STRATEGY_COPY.shelfLocked).toMatch(/Vyuha Pro/);
  });

  it("the accent link is one label, and Custom keeps the catalogue's own wording", () => {
    expect(STRATEGY_COPY.howThisWorks).toBe("How this works");
    expect(customName(4)).toBe("Custom (4 legs)");
  });

  it("every one of these strings is actually printed by the screen", () => {
    // Copy pinned in a module nobody renders is a comment with a test.
    const src = files()
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    for (const key of [
      "beforeCharges",
      "sttNote",
      "multiExpiryNote",
      "howThisWorks",
      "footer",
      "empty",
      "proWithheldNote",
      "shelfLocked",
      "browseOpen",
    ]) {
      expect(src, `STRATEGY_COPY.${key} is never rendered`).toContain(`STRATEGY_COPY.${key}`);
    }
  });
});

/**
 * C-3 (v4.3.0 fix wave C). The drawer button read "Browse all 40 (40)": the
 * label carried the count as a literal AND browse-drawer.tsx appended the
 * derived one. The substring pins above passed over it, because "Browse all 40"
 * is inside "Browse all 40 (40)". The button is rendered here and read EXACTLY,
 * and no count is ever a literal in this copy (the "never a value pin" rule,
 * docs/DECISIONS.md) — each one is the catalogue's own length.
 */
describe("the drawer button states the count once, and every count is the catalogue's (C-3)", () => {
  const rows = CATALOGUE.map((d) => ({ id: d.id, name: d.name, style: d.style, beginner: d.beginner }));
  const noop = () => {};

  it("the rendered button text is EXACTLY `Browse all (N)`, N derived from the rows", () => {
    const html = renderToStaticMarkup(
      React.createElement(BrowseDrawer, {
        rows,
        selected: [],
        onToggle: noop,
        onRestore: noop,
        onUndo: noop,
        onRedo: noop,
        undoable: false,
        redoable: false,
      }),
    );
    const first = /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(first, "the drawer renders no button").not.toBeNull();
    const text = first![1].replace(/<[^>]+>/g, "").trim();
    expect(text).toBe(`Browse all (${CATALOGUE.length})`);
  });

  it("the label itself carries no digit — the drawer appends the one count", () => {
    expect(STRATEGY_COPY.browseOpen).not.toMatch(/\d/);
  });

  it("every count STRATEGY_COPY prints equals CATALOGUE.length (a version like 4.3 is not a count)", () => {
    let seen = 0;
    for (const [key, value] of Object.entries(STRATEGY_COPY)) {
      if (typeof value !== "string") continue;
      const counts = value.replace(/\b\d+\.\d+\b/g, " ").match(/\d+/g) ?? [];
      for (const n of counts) {
        seen++;
        expect(Number(n), `STRATEGY_COPY.${key} prints ${n}: "${value}"`).toBe(CATALOGUE.length);
      }
    }
    // The shelf-locked sentence names the picker's size, so this scan is not vacuous.
    expect(seen).toBeGreaterThanOrEqual(1);
  });

  it("the shelf-locked sentence DERIVES its count — no digit literal in its source", () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, "components/strategies/strategy-copy.ts"), "utf8"));
    const decl = /shelfLocked:\s*([^\n]+)/.exec(src);
    expect(decl, "shelfLocked is not declared on one line").not.toBeNull();
    expect(decl![1]).toContain("CATALOGUE.length");
    expect(decl![1], "a hand-typed count drifts from the catalogue").not.toMatch(/\d/);
  });
});

describe("the SEBI line", () => {
  it("is B5's computed sentence, printed once, with no invented URL", () => {
    const line = sebiRealityLine(SEBI_FNO_FACTS);
    expect(line).toContain("91.1%");
    expect(line).toContain("FY2024");
    expect(line).not.toMatch(/https?:\/\//);
    const page = fs.readFileSync(path.join(ROOT, "app/strategies/page.tsx"), "utf8");
    expect(page).toContain("sebiRealityLine");
    expect(page.match(/sebiRealityLine\(/g), "once, at the top").toHaveLength(1);
  });
});

/**
 * THE TWO PAYOFF TILES (v4.3.0 wave 2, seam defects 1, 3 and 4).
 *
 * `maxLoss` is B1's MINIMUM payoff and `maxProfit` its MAXIMUM — neither name
 * is a claim about the sign, and the card read them as if it were: a married
 * put whose worst outcome is a GAIN of ₹8,000 printed "Max loss ₹8,000" in
 * loss red. The rule lives here, where it is arithmetic rather than JSX.
 */
describe("figureDescriptor — the heading and the colour follow the SIGN", () => {
  it("a married put: the minimum payoff is a gain, and the tile says so", () => {
    expect(figureDescriptor("maxLoss", 8000, "At expiry")).toEqual({
      label: "Worst case",
      tone: "gain",
      sub: "a gain at every price",
    });
    expect(FIGURE_TONE_CLASS.gain).toBe("text-profit");
  });

  it("an ordinary loss and an ordinary profit keep their own labels and tones", () => {
    expect(figureDescriptor("maxLoss", -12000, "At expiry")).toEqual({
      label: "Max loss",
      tone: "loss",
      sub: "At expiry",
    });
    expect(figureDescriptor("maxProfit", 12000, "At expiry")).toEqual({
      label: "Max profit",
      tone: "gain",
      sub: "At expiry",
    });
  });

  it("a maximum below zero is a loss tone, and a floor of exactly zero is neither", () => {
    expect(figureDescriptor("maxProfit", -450, "At expiry")).toEqual({
      label: "Highest outcome",
      tone: "loss",
      sub: "a loss at every price",
    });
    expect(figureDescriptor("maxLoss", 0, "At expiry")).toEqual({
      label: "Worst case",
      tone: "neutral",
      sub: "no loss at any price",
    });
    expect(figureDescriptor("maxProfit", 0, "At expiry").tone).toBe("neutral");
    expect(FIGURE_TONE_CLASS.loss).toBe("text-loss");
    expect(FIGURE_TONE_CLASS.neutral).toBe("text-muted-foreground");
  });

  it("a §6 cap sentence is not traded away for the sign note — the tile states both", () => {
    expect(figureDescriptor("maxLoss", 8000, "Computed at underlying = 0").sub).toBe(
      "Computed at underlying = 0 — a gain at every price",
    );
    expect(capNote("Computed at underlying = 0")).toBe(STRATEGY_COPY.atZeroNote);
  });

  it("an unbounded tile never prints its own value twice (defect 4)", () => {
    for (const which of ["maxProfit", "maxLoss"] as const) {
      const d = figureDescriptor(which, null, "Unlimited");
      expect(d.sub, `${which}: "Unlimited" is already the value`).not.toBe("Unlimited");
      expect(d.sub).toBe(UNCAPPED_SUB);
      expect(d.label).toBe(which === "maxProfit" ? "Max profit" : "Max loss");
    }
    expect(figureDescriptor("maxProfit", null, "Unlimited").tone).toBe("gain");
    expect(figureDescriptor("maxLoss", null, "Unlimited").tone).toBe("loss");
    expect(UNCAPPED_SUB).toBe("No cap as the underlying rises");
  });

  it("a model-dependent tile takes no tone from the figure it refuses to print (§7)", () => {
    // The calendar's maxProfit is a negative number that is never rendered;
    // colouring the em dash would state exactly what §7 declines to state.
    expect(figureDescriptor("maxProfit", -300, "Not computed")).toEqual({
      label: "Max profit",
      tone: "neutral",
      sub: "Not computed",
    });
  });

  it("legCountLabel counts in English (defect 3)", () => {
    expect(legCountLabel(1)).toBe("1 leg");
    expect(legCountLabel(2)).toBe("2 legs");
    expect(legCountLabel(4)).toBe("4 legs");
  });
});

/**
 * R50 (v4.3.0 fix wave 1). The /strategies help entry said "each card here
 * links straight to its entry". A Custom card — a group that matches no shape,
 * or a match whose name is withheld on the free tier — has no entry to link to:
 * `helpHref(null)` sends it to the TOP of the Options section. The help now says
 * both halves, and this joins the sentence to the function that decides it.
 */
describe("the help says where a Custom card's link lands (R50)", () => {
  it("helpHref(null) is the Options section top, and the /strategies help entry says so", () => {
    expect(helpHref(null)).toBe("/help#options-help");
    expect(helpHref(null)).toBe(`/help#${OPTIONS_SECTION_ANCHOR}`);
    const body = HELP_ENTRIES.find((e) => e.href === "/strategies")!.body.join(" ");
    expect(body).toMatch(/Custom/);
    expect(body).toMatch(/top of the Options section/);
    expect(body, "the help still says EVERY card links to its own entry").not.toMatch(
      /each card here links straight to its entry/,
    );
  });
});
