import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DESK_COPY, POSITIONS_COPY, riskAtStopSentence } from "@/components/live/desk-copy";

/**
 * The `/live` POSITIONS tab's copy rules (v4.7.0 wave C4, design D13).
 *
 * SEBI-safe means record-keeping and calculation, never advice:
 *   - no counterfactual P&L ("would have", "could have made", "missed out") —
 *     invariant 6's mistake-economics rule: Vyuha reports what the book IS;
 *   - no imperative verb on a level ("move your stop", "set a stop", "book
 *     profit") — a level is something the user RECORDED, and telling them what
 *     to do with it is the advice the disclaimer says Vyuha does not give;
 *   - every computed loss or P&L says "before charges";
 *   - the fills caveat is the desk's ONE sentence, referenced (so
 *     `tests/live-tracker-copy.test.ts` keeps exempting "guaranteed" by value),
 *     and the card prints it ABOVE its four actions.
 *
 * `tests/live-tracker-copy.test.ts` already scans every file under
 * components/live for the desk's banned vocabulary; this file adds the rules
 * that are specific to the Positions tab and pins them against the VALUES as
 * well as the source.
 */

const ROOT = path.resolve(__dirname, "..");
const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (rel: string) => stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const FILES = [
  "components/live/positions-tab.tsx",
  "components/live/position-card.tsx",
  "components/live/position-calculator.tsx",
];

/** Counterfactual P&L — a result the user did not have. */
const COUNTERFACTUAL = /\b(would have|could have|should have|might have|missed out|left on the table|if only)\b/i;

/** An imperative verb aimed at a level the user recorded. "Edit levels" (an action naming the editor) is not one. */
const IMPERATIVE_ON_LEVEL =
  /\b(set|move|raise|lower|trail|tighten|widen|exit|book|take|cut|place|hold|add to|reduce)\s+(a |an |the |your )?(stop|stops|sl|target|targets|profit|profits|position|loss)\b/i;

/** The desk's own vocabulary ban (tests/live-tracker-copy.test.ts), applied to the rendered VALUES. */
const DESK_BANNED =
  /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed)\b/i;

/** Every POSITIONS_COPY value as the string it renders, functions called with placeholders. */
function renderedCopy(): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(POSITIONS_COPY)) {
    if (typeof value === "string") out.push([key, value]);
    else if (typeof value === "function") {
      const fn = value as (...a: unknown[]) => string;
      const args = Array.from({ length: Math.max(fn.length, 1) }, (_, i) => (i === 0 ? "bonus" : `₹${i}`));
      out.push([key, String(fn(...args))]);
      // The numeric branches too (plurals), so a "1 position" sentence is scanned.
      out.push([`${key}(1)`, String(fn(...Array.from({ length: Math.max(fn.length, 1) }, () => 1)))]);
      out.push([`${key}(2)`, String(fn(...Array.from({ length: Math.max(fn.length, 1) }, () => 2)))]);
    }
  }
  return out;
}

describe("Positions copy describes the arithmetic and never advises", () => {
  it("renders a non-trivial set of strings (the scan below has something to scan)", () => {
    expect(renderedCopy().length).toBeGreaterThan(60);
  });

  // One `it` per rule, listing every offender — not one per string, which
  // would put ~600 cases on the suite count for three assertions.
  it("no value carries counterfactual P&L", () => {
    const offenders = renderedCopy().filter(([, t]) => COUNTERFACTUAL.test(t));
    expect(offenders).toEqual([]);
  });

  it("no value puts an imperative verb on a level", () => {
    const offenders = renderedCopy().filter(([, t]) => IMPERATIVE_ON_LEVEL.test(t));
    expect(offenders).toEqual([]);
  });

  it("no value carries the desk's banned vocabulary (the fills caveat is exempt by value)", () => {
    const offenders = renderedCopy().filter(([k, t]) => !k.startsWith("fillsCaveat") && DESK_BANNED.test(t));
    expect(offenders).toEqual([]);
  });

  it.each(FILES)("%s source carries no counterfactual or imperative-on-a-level phrase", (rel) => {
    const src = read(rel);
    expect(src.match(COUNTERFACTUAL)?.[0] ?? null, rel).toBeNull();
    expect(src.match(IMPERATIVE_ON_LEVEL)?.[0] ?? null, rel).toBeNull();
  });

  it("names no stop parameter the journal does not store (P4: trailing has no parameters)", () => {
    for (const [key, text] of renderedCopy()) expect(text, key).not.toMatch(/\btrail\s*·?\s*\d+\s*×/i);
  });

  it("the scan can fire: planted sentences are caught", () => {
    expect("You would have made ₹4,000 more").toMatch(COUNTERFACTUAL);
    expect("Missed out on the move").toMatch(COUNTERFACTUAL);
    expect("Move your stop to entry").toMatch(IMPERATIVE_ON_LEVEL);
    expect("Set a stop → Sizing Lab").toMatch(IMPERATIVE_ON_LEVEL);
    expect("Book profit at the target").toMatch(IMPERATIVE_ON_LEVEL);
    expect("Edit levels").not.toMatch(IMPERATIVE_ON_LEVEL);
  });
});

describe("every computed loss or P&L says before charges", () => {
  it("the stop, target and partial sentences each carry it", () => {
    expect(POSITIONS_COPY.pnlAtTarget("₹2,640.00", "+₹38,500")).toContain("before charges");
    expect(POSITIONS_COPY.pnlAtStop("₹2,640.00", "+₹1,000")).toContain("before charges");
    expect(POSITIONS_COPY.lossAtStopLocked("₹2,177.00")).toContain("before charges");
    expect(POSITIONS_COPY.realisedBeforeCharges("+₹2,000")).toContain("before charges");
    expect(POSITIONS_COPY.realisedOnPartials("+3.50%")).toContain("before charges");
    // The card's Pro loss sentence is the desk's own, reused — and it says it too.
    expect(riskAtStopSentence("₹2,177.00", "₹12,430", "0.62%")).toContain("before charges");
    expect(riskAtStopSentence("₹2,177.00", "₹12,430", "0.62%")).toContain("computed loss");
  });

  it("the card prints those sentences, not a hand-rolled loss line", () => {
    const card = read("components/live/position-card.tsx");
    expect(card).toContain("riskAtStopSentence(");
    expect(card).toContain("POSITIONS_COPY.pnlAtTarget(");
    expect(card).toContain("POSITIONS_COPY.lossAtStopLocked(");
  });
});

describe("the fills caveat", () => {
  it("is the desk's ONE sentence, by reference", () => {
    expect(POSITIONS_COPY.fillsCaveat).toBe(DESK_COPY.fillsCaveat);
    expect(POSITIONS_COPY.fillsCaveat).toBe(
      "Stops are not guaranteed fills — gaps, circuits and illiquidity can execute worse than the level shown.",
    );
  });

  it("sits ABOVE the card's four actions", () => {
    const card = read("components/live/position-card.tsx");
    const caveat = card.indexOf("{POSITIONS_COPY.fillsCaveat}");
    expect(caveat, "the card no longer prints the fills caveat").toBeGreaterThan(-1);
    for (const action of ["actionOpenChart", "actionSizingLab", "actionEditLevels", "actionTradeRecord"]) {
      const at = card.indexOf(`{POSITIONS_COPY.${action}}`);
      expect(at, `${action} is not rendered`).toBeGreaterThan(-1);
      expect(caveat, `the fills caveat must come before ${action}`).toBeLessThan(at);
    }
  });

  it("the tab's footer prints it and the standing disclaimer", () => {
    const tab = read("components/live/positions-tab.tsx");
    expect(tab).toContain("{DESK_COPY.fillsCaveat}");
    expect(tab).toContain("{DESK_COPY.disclaimer}");
  });
});

describe("the since-close paragraph claims no stop moved (P7)", () => {
  it("says stop edits are not tracked and compares at today's stops", () => {
    expect(POSITIONS_COPY.sinceCloseStops).toMatch(/not tracked/);
    expect(POSITIONS_COPY.sinceCloseStops).toMatch(/today's stops/);
    for (const [key, text] of renderedCopy().filter(([k]) => k.startsWith("sinceClose"))) {
      expect(text, key).not.toMatch(/\b(moved|raised|lowered|trailed)\b/i);
    }
  });
});
