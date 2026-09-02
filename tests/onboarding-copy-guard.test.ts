import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ONBOARDING_COPY, onboardingCopyStrings } from "@/lib/domain/onboarding";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";

/**
 * WS3 — what the first-run wizard is allowed to SAY.
 *
 * Two rules, both older than this feature:
 *
 *  • Vyuha describes, it does not instruct. PRESCRIPTIVE_LANGUAGE
 *    (lib/intelligence/insight.ts) is the same regex the insight engine is held
 *    to; a wizard is the most tempting place in the product to start telling
 *    people what to do with their money, so it is held to it too.
 *  • Nothing sells. This is a local, offline journal the user already has —
 *    superlatives in a first-run flow are a promise the software then has to
 *    keep.
 *
 * It scans BOTH the copy module (exact strings, no false positives) and the
 * component source with comments and class names stripped, so copy added later
 * straight into the JSX cannot slip past.
 */

const ROOT = path.resolve(__dirname, "..");
const WIZARD_SRC = fs.readFileSync(path.join(ROOT, "components/system/onboarding-wizard.tsx"), "utf8");

/** Marketing language. Every word here is one this product has no business
 *  using about itself in a setup flow. */
const SUPERLATIVES =
  /\b(best|fastest|smartest|ultimate|world[- ]class|revolutionary|unmatched|effortless|seamless|flawless|unbeatable|guaranteed|instantly|blazing|cutting[- ]edge|game[- ]chang\w+|number one)\b|#1/i;

/** Visible text only: block/line comments and class names carry engineering
 *  prose ("must not", "avoid") that no user ever reads. */
function visibleText(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/className="[^"]*"/g, " ")
    .replace(/data-testid="[^"]*"/g, " ");
}

describe("the wizard never prescribes", () => {
  it.each(onboardingCopyStrings().map((s) => [s.slice(0, 60), s]))("%s", (_label, s) => {
    expect(s, `prescriptive: ${s}`).not.toMatch(PRESCRIPTIVE_LANGUAGE);
  });

  it("holds for the component source too, not just the copy module", () => {
    const text = visibleText(WIZARD_SRC);
    const hit = text.match(PRESCRIPTIVE_LANGUAGE);
    expect(hit?.[0] ?? null, `prescriptive language in the wizard JSX: ${hit?.[0]}`).toBeNull();
  });
});

describe("the wizard never sells", () => {
  it.each(onboardingCopyStrings().map((s) => [s.slice(0, 60), s]))("%s", (_label, s) => {
    expect(s, `superlative: ${s}`).not.toMatch(SUPERLATIVES);
  });

  it("holds for the component source too", () => {
    const hit = visibleText(WIZARD_SRC).match(SUPERLATIVES);
    expect(hit?.[0] ?? null, `superlative in the wizard JSX: ${hit?.[0]}`).toBeNull();
  });
});

describe("step 1 — capital is optional, and the copy says what blank MEANS", () => {
  it("names the em dash the reports actually show (invariant 6)", () => {
    // "Never fabricate a denominator": the share cards return "—" rather than
    // invent a capital base, and DECISIONS 2026-09-01 ties this wizard to that
    // fix. A wizard that implied capital was required would push users into
    // inventing one.
    expect(ONBOARDING_COPY.step1.capitalNote).toMatch(/—/);
    expect(ONBOARDING_COPY.step1.capitalNote).toMatch(/blank/i);
    expect(ONBOARDING_COPY.step1.capitalLegend).toMatch(/optional/i);
    expect(ONBOARDING_COPY.step1.capitalNote).toMatch(/does not invent/i);
  });

  it("does not mark either capital field required in the JSX", () => {
    expect(WIZARD_SRC).not.toMatch(/required/);
  });
});

describe("step 3 — one sentence, and NOT a second copy of the consent UI", () => {
  it("is a single sentence", () => {
    const enders = ONBOARDING_COPY.step3.sentence.match(/[.!?](\s|$)/g) ?? [];
    expect(enders.length, ONBOARDING_COPY.step3.sentence).toBe(1);
  });

  it("points at Settings instead of restating the disclosure", () => {
    // The disclosure and its ack version are enforced server-side
    // (lib/domain/telegram-disclosure.ts + lib/telegram/digest-gate.ts). A
    // second copy here would drift from the version actually on file, which is
    // the openalgo-disclosure rule: risk copy written twice drifts.
    expect(ONBOARDING_COPY.step3.sentence).toMatch(/Settings/);
    expect(WIZARD_SRC).not.toMatch(/telegram-disclosure/);
    expect(WIZARD_SRC).not.toMatch(/ackVersion|AckVersion/);
    expect(WIZARD_SRC).not.toMatch(/telegramEnabled/);
  });

  it("does not claim the digest is on, or that anything has been sent", () => {
    expect(ONBOARDING_COPY.step3.sentence).toMatch(/off until you turn it on/i);
  });
});

describe("step 4 — the Review Desk and the trial", () => {
  it("derives the trial length from TRIAL_DAYS instead of hard-coding a number", () => {
    expect(WIZARD_SRC).toMatch(/TRIAL_DAYS/);
    expect(WIZARD_SRC).not.toMatch(/7-day/);
    expect(ONBOARDING_COPY.step4.reviewDesk(7)).toMatch(/7-day/);
  });

  it("names the Review Desk and the trial that includes it", () => {
    expect(ONBOARDING_COPY.step4.reviewDesk(7)).toMatch(/Review Desk/);
    expect(ONBOARDING_COPY.step4.reviewDesk(7)).toMatch(/trial includes it/);
  });

  it("keeps invariant 7 in view: the journal itself is never gated", () => {
    expect(ONBOARDING_COPY.step4.body).toMatch(/never gated/);
  });
});

describe("the skip route is described honestly", () => {
  it("says skipping counts as done, and where to get it back", () => {
    expect(ONBOARDING_COPY.skipNote).toMatch(/marks setup as done/i);
    expect(ONBOARDING_COPY.skipNote).toMatch(/Run setup again/);
  });
});
