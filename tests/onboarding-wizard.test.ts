import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FIRST_STEP,
  LAST_STEP,
  ONBOARDING_STEP_KEY,
  ONBOARDING_COPY,
  accountStepIsDirty,
  clampStep,
  dismissalSurvives,
  isLastStep,
  nextStep,
  parseOptionalCapital,
  parseStoredStep,
  prevStep,
  readCapitalEntry,
  serializeStep,
} from "@/lib/domain/onboarding";

/**
 * WS3 — the first-run wizard's PURE half (lib/domain/onboarding.ts) plus the
 * structural guarantees the component makes that no rendering test covers
 * (vitest runs in the node environment; there is no DOM here by design).
 *
 * The envelope cases are the point. Wizard progress lives in localStorage so a
 * mid-wizard trip to /import resumes at step 2 — which means a value written by
 * SOME OTHER BUILD can be read by this one. AGENTS.md's rule is that stored
 * JSON wears a versioned envelope and a shape it does not recognise is
 * DISCARDED, not half-read: a downgraded install must not read `step: 5` out of
 * a future `{v:2}` envelope and render a step that does not exist.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const WIZARD = read("components/system/onboarding-wizard.tsx");

describe("stored progress envelope", () => {
  it("uses the documented key", () => {
    expect(ONBOARDING_STEP_KEY).toBe("vyuha-onboarding-step");
  });

  it("round-trips a real step", () => {
    expect(parseStoredStep(serializeStep(2))).toBe(2);
    expect(parseStoredStep(serializeStep(4))).toBe(4);
    expect(JSON.parse(serializeStep(3))).toEqual({ v: 1, step: 3 });
  });

  it("DISCARDS a future version rather than reading a step out of it", () => {
    expect(parseStoredStep(JSON.stringify({ v: 2, step: 3 }))).toBe(FIRST_STEP);
    expect(parseStoredStep(JSON.stringify({ v: 99, step: 5 }))).toBe(FIRST_STEP);
  });

  it("discards an unversioned envelope — the pre-envelope shape is not trusted", () => {
    expect(parseStoredStep(JSON.stringify({ step: 3 }))).toBe(FIRST_STEP);
    expect(parseStoredStep("3")).toBe(FIRST_STEP);
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["not JSON", "{step:2"],
    ["a JSON array", "[1,2,3]"],
    ["JSON null", "null"],
    ["an object with no step", '{"v":1}'],
    ["a string step", '{"v":1,"step":"2"}'],
    ["a fractional step", '{"v":1,"step":2.5}'],
    ["a step past the end", '{"v":1,"step":9}'],
    ["a step before the start", '{"v":1,"step":0}'],
  ])("resumes at step 1 when the stored value is %s", (_label, raw) => {
    expect(parseStoredStep(raw)).toBe(FIRST_STEP);
  });

  it("never STORES an out-of-range step, whatever it is handed", () => {
    expect(JSON.parse(serializeStep(99)).step).toBe(LAST_STEP);
    expect(JSON.parse(serializeStep(-4)).step).toBe(FIRST_STEP);
    expect(JSON.parse(serializeStep(Number.NaN)).step).toBe(FIRST_STEP);
  });
});

describe("step machine", () => {
  it("clamps at both ends instead of running off", () => {
    expect(nextStep(LAST_STEP)).toBe(LAST_STEP);
    expect(prevStep(FIRST_STEP)).toBe(FIRST_STEP);
    expect(nextStep(1)).toBe(2);
    expect(prevStep(3)).toBe(2);
    expect(clampStep(2.4)).toBe(2);
  });

  it("knows where Finish belongs", () => {
    expect(isLastStep(LAST_STEP)).toBe(true);
    expect([1, 2, 3].some(isLastStep)).toBe(false);
    expect(LAST_STEP).toBe(4);
  });
});

describe("capital stays OPTIONAL (owner decision Q4, invariant 6)", () => {
  it("reads blank as NULL, never as zero", () => {
    expect(parseOptionalCapital("")).toBeNull();
    expect(parseOptionalCapital("   ")).toBeNull();
    // A zero the user actually typed is a different statement from a blank.
    expect(parseOptionalCapital("0")).toBe(0);
  });

  it("refuses an unreadable entry rather than coercing it to a number", () => {
    expect(parseOptionalCapital("abc")).toBeNull();
    expect(parseOptionalCapital("-500")).toBeNull();
  });

  it("accepts the way Indian amounts are typed", () => {
    expect(parseOptionalCapital("1,50,000")).toBe(150000);
    expect(parseOptionalCapital(" 250000 ")).toBe(250000);
  });
});

describe("a box we could not read is NOT a box the user emptied", () => {
  // Probed 2026-09-02: "₹500000", "5 lakh" and "-5" all came back as null,
  // accountStepIsDirty then read 500000 → null as a real change, and Continue
  // wrote equityCapital: null over a configured capital base with no toast and
  // no validation. Every %-of-equity figure in the app fell to "—".
  // app/layout.tsx states the opposite guarantee in as many words.

  it("tells blank apart from unreadable — the distinction the defect collapsed", () => {
    expect(readCapitalEntry("")).toEqual({ kind: "blank", value: null });
    expect(readCapitalEntry("   ")).toEqual({ kind: "blank", value: null });
    expect(readCapitalEntry("₹500000")).toEqual({ kind: "unreadable", value: null, raw: "₹500000" });
    expect(readCapitalEntry("5 lakh")).toEqual({ kind: "unreadable", value: null, raw: "5 lakh" });
    expect(readCapitalEntry("-5")).toEqual({ kind: "unreadable", value: null, raw: "-5" });
  });

  it("still reads the amounts it always read", () => {
    expect(readCapitalEntry("5,00,000")).toEqual({ kind: "amount", value: 500000 });
    expect(readCapitalEntry(" 250000 ")).toEqual({ kind: "amount", value: 250000 });
    // A typed zero is a statement, and a different one from an empty box.
    expect(readCapitalEntry("0")).toEqual({ kind: "amount", value: 0 });
  });

  it("capital stays OPTIONAL — blank is still saved as NULL", () => {
    // Owner decision Q4. The fix refuses the unreadable entry ONLY; making
    // capital mandatory would push users into inventing a denominator, which
    // is what invariant 6 exists to prevent.
    expect(readCapitalEntry("").kind).toBe("blank");
    expect(accountStepIsDirty(
      { name: "Main", equityCapital: 500000, activeCapital: null },
      { name: "Main", equityCapital: readCapitalEntry("").value, activeCapital: null },
    )).toBe(true);
  });

  it("the wizard refuses the step instead of sending a NULL it invented", () => {
    // The component half: a save that reads `.value` off an entry it never
    // classified is the defect back again.
    expect(WIZARD).toMatch(/readCapitalEntry\(equity\)/);
    expect(WIZARD).toMatch(/readCapitalEntry\(active\)/);
    expect(WIZARD, "the flattening parser is back on the write path").not.toMatch(/parseOptionalCapital/);
    // Unreadable → a named box, a message, and no request at all.
    expect(WIZARD).toMatch(/kind === "unreadable"/);
    expect(WIZARD).toMatch(/toast\.error\(C\.step1\.capitalUnreadable\(unreadable\)\)/);
    const guard = WIZARD.indexOf("if (unreadable)");
    const post = WIZARD.indexOf('fetch("/api/accounts"');
    expect(guard).toBeGreaterThan(0);
    expect(guard, "the unreadable check runs after the POST").toBeLessThan(post);
  });

  it("and the message says which box, and what IS read", () => {
    const msg = ONBOARDING_COPY.step1.capitalUnreadable(ONBOARDING_COPY.step1.equityLabel);
    expect(msg).toContain("Equity capital");
    expect(msg).toMatch(/could not read/i);
    expect(msg).toMatch(/nothing on this step was saved/i);
    // …and it does not turn an optional field into a demand.
    expect(msg).toMatch(/blank/i);
  });
});

describe("the dismissal latch belongs to ONE run of the wizard", () => {
  // "Run setup again" clears the server flag, so `show` swings false → true.
  // The old one-way `closed` boolean swallowed that second run for the rest of
  // the session: the root layout survives client navigation, so nothing
  // remounted until a full page reload.

  it("a run that becomes due again drops a latch from the previous one", () => {
    expect(dismissalSurvives(false, true, true)).toBe(false);
  });

  it("but the latch holds through the refresh that follows Skip/Finish", () => {
    // Skip → dismissed, then the server flag lands and `show` goes false. The
    // dialog stays shut; re-opening it there would be the flicker the latch
    // exists to prevent.
    expect(dismissalSurvives(true, true, true)).toBe(true);
    expect(dismissalSurvives(true, false, true)).toBe(true);
  });

  it("and a wizard nobody dismissed is never latched shut", () => {
    expect(dismissalSurvives(true, true, false)).toBe(false);
    expect(dismissalSurvives(false, true, false)).toBe(false);
    expect(dismissalSurvives(true, false, false)).toBe(false);
  });

  it("the component applies it during render, not from an effect", () => {
    // AGENTS.md: a synchronous setState inside a useEffect keyed on other
    // state is the shape that silently broke the Trades filter.
    expect(WIZARD).toMatch(/dismissalSurvives\(seenShow, show, dismissed\)/);
    expect(WIZARD).toMatch(/if \(seenShow !== show\)/);
    expect(WIZARD, "a useEffect is back in the wizard").not.toMatch(/useEffect/);
  });
});

describe("step 1 writes only when something changed", () => {
  const before = { name: "Main", equityCapital: 500000, activeCapital: null };

  it("is clean when the form still holds what the server sent", () => {
    expect(accountStepIsDirty(before, { ...before })).toBe(false);
    expect(accountStepIsDirty(before, { ...before, name: "  Main  " })).toBe(false);
  });

  it("is dirty for a renamed account or a changed capital — including one being cleared", () => {
    expect(accountStepIsDirty(before, { ...before, name: "Swing" })).toBe(true);
    expect(accountStepIsDirty(before, { ...before, activeCapital: 100000 })).toBe(true);
    expect(accountStepIsDirty(before, { ...before, equityCapital: null })).toBe(true);
  });
});

describe("the component's structural promises", () => {
  it("“Skip for now” COMPLETES the flag — a skipped wizard does not return every launch", () => {
    expect(WIZARD).toMatch(/data-testid="onboarding-skip"/);
    // The skip button and Finish share one handler, and that handler posts
    // `complete`. If skip is ever downgraded to "just close the dialog", this
    // reddens.
    const skipButton = WIZARD.slice(WIZARD.indexOf('data-testid="onboarding-skip"') - 400, WIZARD.indexOf('data-testid="onboarding-skip"'));
    expect(skipButton).toMatch(/onClick=\{\(\) => void complete\(\)\}/);
    expect(WIZARD).toMatch(/JSON\.stringify\(\{ action: "complete" \}\)/);
    expect(WIZARD).not.toMatch(/action: "reset"/);
  });

  it("opens over the dashboard only, so it can never block /import or /trades", () => {
    expect(WIZARD).toMatch(/pathname === "\/"/);
    // The three ways out of step 2 are the routes the plan names.
    expect(WIZARD).toMatch(/href="\/import"/);
    expect(WIZARD).toMatch(/href="\/import-help"/);
    expect(WIZARD).toMatch(/href="\/trades"/);
  });

  it("is mounted in the ROOT LAYOUT, which is what makes progress resumable", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/<OnboardingWizard\b/);
    expect(layout).toMatch(/onboardingCompletedAt == null/);
  });

  it("is not wired into navigation (the /pricing precedent — no help-entry coupling)", () => {
    expect(read("components/layout/nav-config.ts")).not.toMatch(/onboarding/i);
  });

  it("derives step 2's broker count from the import registry, never a literal", () => {
    // AGENTS.md: registry-meta.ts is the ONLY source of truth for what can be
    // imported, and copy that stops deriving from it drifts.
    expect(WIZARD).toMatch(/brokersWithNativeParser\(\)\.length/);
  });

  it("Settings can put the wizard back — the only path, since the flag is machine state", () => {
    const form = read("components/settings/settings-form.tsx");
    expect(form).toMatch(/Run setup again/);
    expect(form).toMatch(/JSON\.stringify\(\{ action: "reset" \}\)/);
    // Route handler + fetch + router.refresh(), never a server action.
    expect(form).not.toMatch(/"use server"/);
  });
});
