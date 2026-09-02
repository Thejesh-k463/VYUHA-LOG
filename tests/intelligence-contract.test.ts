import { describe, expect, it } from "vitest";
import {
  PRESCRIPTIVE_LANGUAGE,
  coverageText,
  insightTexts,
  runRules,
  type Insight,
  type InsightRule,
} from "@/lib/intelligence/insight";
import { COCKPIT_RULES, CONTRACT_FIXTURES as COCKPIT_FIXTURES } from "@/lib/intelligence/rules/cockpit";
import { GROUP_RULES, CONTRACT_FIXTURES as GROUP_FIXTURES } from "@/lib/intelligence/rules/group";
import { GOAL_RULES, CONTRACT_FIXTURES as GOAL_FIXTURES } from "@/lib/intelligence/rules/goal";

/**
 * THE INSIGHT CONTRACT — every Vyuha Intelligence rule registry added to
 * REGISTRIES below is held to the same bar:
 *   unique stable ids · a real sample floor · descriptive language only.
 *
 * When a new registry lands (lens group rules, trade-craft rules, cockpit
 * rules), it registers here with representative fixture inputs that make its
 * rules FIRE — a rule whose output is never seen by this test is not
 * protected by it.
 */

type AnyRegistry = {
  name: string;
  rules: readonly InsightRule<unknown>[];
  /** Inputs that make as many rules as possible produce an Insight. */
  fixtures: unknown[];
};

// Every rule registry in the app registers here. A registry absent from this
// list is NOT protected by the contract — add it with fixtures that fire it.
const REGISTRIES: AnyRegistry[] = [
  { name: "cockpit (Arjun's Eye)", rules: COCKPIT_RULES as unknown as InsightRule<unknown>[], fixtures: COCKPIT_FIXTURES },
  { name: "lens-group rules", rules: GROUP_RULES as unknown as InsightRule<unknown>[], fixtures: GROUP_FIXTURES },
  { name: "goal rules", rules: GOAL_RULES as unknown as InsightRule<unknown>[], fixtures: GOAL_FIXTURES },
];

describe("insight primitives", () => {
  const mkRule = (id: string, out: Insight | null): InsightRule<null> => ({
    id,
    watches: "test signal",
    sampleFloor: 15,
    compute: () => out,
  });
  const sample: Insight = {
    id: "x",
    tone: "warn",
    headline: "Your after-loss expectancy is negative.",
    evidence: [{ label: "after a loss", value: "-₹412" }],
    sampleSize: 40,
  };

  it("runRules keeps registry order and stamps the registered id", () => {
    const out = runRules([mkRule("a", sample), mkRule("b", null), mkRule("c", sample)], null);
    expect(out.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("coverageText renders have-of-noun", () => {
    expect(coverageText({ have: 12, of: 40, noun: "losing trades with a stop recorded" })).toBe(
      "12 of 40 losing trades with a stop recorded",
    );
  });

  it("the banned-language regex rejects prescriptive phrasing", () => {
    for (const bad of [
      "You should trade less after a loss",
      "You must set a stop",
      "Stop doing revenge trades",
      "Avoid the open session",
      "We recommend exiting earlier",
      "Consider selling covered calls",
    ]) {
      expect(PRESCRIPTIVE_LANGUAGE.test(bad), bad).toBe(true);
    }
  });

  it("…and passes descriptive phrasing", () => {
    for (const ok of [
      "Your after-loss expectancy is negative.",
      "Historically, your morning entries carried your whole edge.",
      "SL recorded on 12 of 40 losers.",
      "Losses beyond -2R account for ₹41,200 of the gap.",
    ]) {
      expect(PRESCRIPTIVE_LANGUAGE.test(ok), ok).toBe(false);
    }
  });

  it("insightTexts exposes every prose field for scanning", () => {
    const texts = insightTexts({ ...sample, detail: "d", suggestion: "s" });
    expect(texts.join(" ")).toContain("after-loss");
    expect(texts.join(" ")).toContain("d");
    expect(texts.join(" ")).toContain("s");
  });
});

describe("every registered rule registry honours the contract", () => {
  it("all shipped registries are registered — an unregistered registry is unprotected", () => {
    expect(REGISTRIES.map((r) => r.name).sort()).toEqual(["cockpit (Arjun's Eye)", "goal rules", "lens-group rules"]);
  });

  for (const reg of REGISTRIES) {
    describe(reg.name, () => {
      it("rule ids are unique and kebab-case", () => {
        const ids = reg.rules.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      });

      it("every rule states a sample floor of at least 10", () => {
        for (const r of reg.rules) expect(r.sampleFloor, r.id).toBeGreaterThanOrEqual(10);
      });

      it("EVERY rule id fires from the registry's own fixtures — an unfired rule is unprotected", () => {
        // The prescriptive-language scan below only sees insights that FIRE.
        // A rule none of the fixtures reaches ships with zero contract
        // coverage — its copy, floor and evidence are all unchecked. So the
        // fixtures must collectively fire every registered rule; a new rule
        // lands with a fixture that fires it, or it does not land.
        const fired = new Set<string>();
        for (const fixture of reg.fixtures) {
          for (const insight of runRules(reg.rules, fixture)) fired.add(insight.id);
        }
        for (const r of reg.rules) {
          expect(fired.has(r.id), `${reg.name}: rule "${r.id}" never fired from any fixture — add one that reaches it`).toBe(true);
        }
      });

      it("no fired insight uses prescriptive language", () => {
        let fired = 0;
        for (const fixture of reg.fixtures) {
          for (const insight of runRules(reg.rules, fixture)) {
            fired++;
            for (const text of insightTexts(insight)) {
              expect(PRESCRIPTIVE_LANGUAGE.test(text), `${insight.id}: ${text}`).toBe(false);
            }
            expect(insight.sampleSize, insight.id).toBeGreaterThan(0);
          }
        }
        expect(fired, `${reg.name}: fixtures never fired a single rule`).toBeGreaterThan(0);
      });
    });
  }
});
