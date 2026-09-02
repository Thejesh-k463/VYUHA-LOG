import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Source guard for the v3.7 WS4 challan-ledger SURFACES.
 *
 * Everything pinned here is a property of how the screens are WIRED, which no
 * unit test of the maths can see — the arithmetic is correct either way; that
 * is exactly the problem. Each rule below has a recorded incident behind it:
 *
 *  1. Writes go through a route handler + client `fetch` + `router.refresh()`,
 *     never a server action. A server action auto-refreshes the current route,
 *     which remounts sibling client components and silently resets their state
 *     (AGENTS.md — it broke the charge-editor row selection and made the
 *     settings theme appear to revert). Nothing on screen looks wrong.
 *  2. BSR code and challan serial stay OPTIONAL. A self-assessment receipt
 *     often carries neither; refusing a real payment over a blank transcription
 *     field would be the worse error.
 *  3. A duplicate WARNS and is still saved. Two genuine payments of the same
 *     amount on one day are legal — the table has no unique index for exactly
 *     that reason (lib/db/schema.ts, lib/queries/challans.ts).
 *  4. The aggregate view refuses writes AND says why (invariant 9: "0 is a
 *     view, not a place"). A silently missing form reads as a broken screen.
 *  5. The calculator branches ledger-vs-scalar, and where the ledger wins it
 *     STATES that the saved figure is ignored. A silently ignored saved input
 *     is the class of defect this repo treats as a bug, not a nicety.
 *  6. No hard-coded "234C"/"234B"/"S.211" on any of these surfaces: citations
 *     resolve per FY through lib/analytics/statute.ts, so a 2024-25 pack keeps
 *     its 1961-Act numbers while 2026-27 says s.408/s.424/s.425.
 */

/**
 * EVERY read below is comment-stripped, and that is load-bearing rather than
 * tidy. These files DOCUMENT the conventions they follow, so a naive
 * `toMatch(/router\.refresh\(\)/)` matches the header comment that merely names
 * it — the guard then passes with the call deleted. That exact false pass was
 * observed while proving this file reddens on reverted code, so the stripper
 * runs first and the assertions only ever see executable source.
 *
 * The stripper is the one from tests/capital-fallback-guard.test.ts: a block
 * opener preceded by a word char, comma or star is not a comment (that is a
 * MIME wildcard, which a naive strip ate real code from), and `//` preceded by
 * `:` is a URL, not a line comment.
 */
const stripComments = (src: string) =>
  src
    .replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const root = process.cwd();
const read = (p: string) => stripComments(readFileSync(path.join(root, p), "utf8"));

const EDITOR = "components/reports/challan-editor.tsx";
const CALC = "components/reports/advance-tax-calc.tsx";
const PLANNER_PAGE = "app/reports/advance-tax/page.tsx";
const ITR_PAGE = "app/reports/itr/page.tsx";
const SCHEDULE = "lib/analytics/itr-schedule.ts";

describe("challan editor writes through the route, never a server action", () => {
  const src = read(EDITOR);

  it("posts to /api/challans and refreshes the router", () => {
    expect(src).toMatch(/fetch\("\/api\/challans"/);
    expect(src).toMatch(/router\.refresh\(\)/);
    expect(src).toMatch(/^"use client";/m);
  });

  it("contains no server action, and imports nothing server-only", () => {
    // A "use server" directive, or a lib/queries import in a client file, are
    // the two shapes this convention has actually been broken by.
    expect(src).not.toMatch(/["']use server["']/);
    expect(src).not.toMatch(/from "@\/lib\/(queries|db)\//);
    // <form action={serverAction}> is the other mount point for one.
    expect(src).not.toMatch(/<form[^>]*\saction=\{/);
  });

  it("derives nothing: the row's instalment rung and duplicate flag arrive computed", () => {
    // Mirrors the b/f-loss editor's header rule — the server computes, the
    // component renders. A rung recomputed here would drift from the engine.
    expect(src).toMatch(/countsTowards: string/);
    expect(src).toMatch(/duplicate: boolean/);
    expect(src).toMatch(/\{r\.countsTowards\}/);
  });
});

describe("optional receipt fields stay optional", () => {
  const src = read(EDITOR);

  it("the save button gates on the date and the amount only", () => {
    const gate = /disabled=\{busy \|\| paidOn\.trim\(\) === "" \|\| amount\.trim\(\) === ""\}/;
    expect(src).toMatch(gate);
    expect(src).not.toMatch(/bsr\.trim\(\) === ""[^?]*\}\s*onClick=\{save\}/);
  });

  it("a blank BSR or serial is sent as null, not refused", () => {
    expect(src).toMatch(/bsrCode: bsr\.trim\(\) === "" \? null : bsr\.trim\(\)/);
    expect(src).toMatch(/challanSerial: serial\.trim\(\) === "" \? null : serial\.trim\(\)/);
  });
});

describe("a duplicate warns and is still allowed", () => {
  it("the planner page asks findDuplicateChallan and passes the verdict down", () => {
    const page = read(PLANNER_PAGE);
    expect(page).toMatch(/findDuplicateChallan\(/);
    expect(page).toMatch(/duplicate: findDuplicateChallan\(/);
  });

  it("the editor renders the warning without blocking the write", () => {
    const src = read(EDITOR);
    expect(src).toMatch(/r\.duplicate/);
    expect(src).toMatch(/Both are\s*\n?\s*kept|both are kept/i);
    // Nothing may return early, disable the button, or skip post() on a
    // duplicate — the schema allows the row and so must the editor.
    expect(src).not.toMatch(/duplicate[^\n]*\)\s*return\b/);
    expect(src).not.toMatch(/disabled=\{[^}]*duplicate/);
  });
});

describe("the aggregate view is read-only and says why", () => {
  const src = read(EDITOR);

  it("row actions are hidden and the form is replaced by an explanation", () => {
    expect(src).toMatch(/\{!aggregate && \(/);
    expect(src).toMatch(/aggregate \? \(/);
    expect(src).toMatch(/cannot add or edit/i);
    expect(src).toMatch(/Pick an account in the sidebar/i);
  });
});

describe("the calculator branches ledger-vs-scalar, and says when it ignores the saved value", () => {
  const src = read(CALC);

  it("challans replace the scalar and are fed to the engine as DATED payments", () => {
    expect(src).toMatch(/ledger != null && ledger\.count > 0/);
    expect(src).toMatch(/payments: ledger\.payments/);
    expect(src).toMatch(/From your challan ledger/);
  });

  it("with no challans the v3.5 scalar path is what runs", () => {
    // `payments` ABSENT is what keeps the engine on its unchanged code path;
    // passing an empty array instead would silently re-date every instalment.
    expect(src).toMatch(/: \{ taxPaidToDate: paid \}/);
    expect(src).toMatch(/ledgerActive \? plan\.taxPaidToDate : paid/);
    expect(src).not.toMatch(/payments: \[\]/);
  });

  it("an ignored saved figure is stated on screen, not swallowed", () => {
    expect(src).toMatch(/savedPaidIgnored/);
    expect(src).toMatch(/is IGNORED for \{plan\.fyLabel\}/);
  });

  it("keeps the versioned localStorage envelope contract", () => {
    // A future `v` is discarded, never mis-read (AGENTS.md conventions).
    expect(src).toMatch(/\.v !== 1\) return null/);
  });
});

describe("the ITR taxes-paid surface emits blank, never 0", () => {
  it("the page reads the ledger through the pure schedule builder", () => {
    const page = read(ITR_PAGE);
    expect(page).toMatch(/taxesPaidByFy\(/);
    expect(page).toMatch(/taxesPaidExportRows\(/);
    // The rendered amount column falls back to an em dash on null, never 0.
    expect(page).toMatch(/l\.amount === null \? <span/);
  });

  it("the export maps a null amount to \"\" and not to 0", () => {
    const src = read(SCHEDULE);
    expect(src).toMatch(/amount: l\.amount \?\? ""/);
    expect(src).not.toMatch(/amount: l\.amount \?\? 0/);
  });
});

// ── No hard-coded statutory citations ───────────────────────────────────────
// Text check on purpose: the bug class is a literal standing in for a lookup,
// which no behavioural test can see (the number is even right — for one year).
// A comment may legitimately NAME the old sections (itr-schedule.ts's header
// does), which is the second reason `read` strips them.
const SURFACES = [EDITOR, CALC, PLANNER_PAGE, ITR_PAGE, SCHEDULE];

// 234A/B/C only where it is a LITERAL — `plan.interest234C` and
// `plan.underpaid234B` are the engine's own public field names and are not
// citations, so a preceding word character exempts them.
const LITERAL_INTEREST_SECTION = /(?<![A-Za-z0-9_])23[34][ABC]\b/;
// "S.211" / "s.211" / a bare 211 that is not part of a longer number.
const LITERAL_INSTALMENT_SECTION = /(?<![A-Za-z0-9_.\-])(?:[Ss]\.)?211\b/;

describe("statutory citations resolve per FY, never hard-coded", () => {
  for (const file of SURFACES) {
    it(`${file} cites through lib/analytics/statute.ts`, () => {
      const src = read(file);
      const interest = src.match(LITERAL_INTEREST_SECTION);
      expect(
        interest,
        interest
          ? `${file} hard-codes “${interest[0]}”. Resolve it with section(fy, "interestDeferment"|"interestAdvanceTax") — ` +
            "a 2024-25 pack must keep its 1961-Act citation while 2026-27 says s.425."
          : undefined,
      ).toBeNull();

      const instalments = src.match(LITERAL_INSTALMENT_SECTION);
      expect(
        instalments,
        instalments
          ? `${file} hard-codes “${instalments[0]}”. Resolve it with section(fy, "advanceTaxInstalments").`
          : undefined,
      ).toBeNull();
    });
  }

  it("the guard sees a literal but not the engine's field names", () => {
    // Both halves matter: a false negative here would make every case above
    // vacuous, and a false positive would forbid `plan.interest234C`.
    expect(stripComments('<ReportTh>234C</ReportTh>')).toMatch(LITERAL_INTEREST_SECTION);
    expect(stripComments("avoid 234C interest")).toMatch(LITERAL_INTEREST_SECTION);
    expect(stripComments("plan.interest234C > 0")).not.toMatch(LITERAL_INTEREST_SECTION);
    expect(stripComments("plan.underpaid234B")).not.toMatch(LITERAL_INTEREST_SECTION);
    expect(stripComments("due under S.211 of the Act")).toMatch(LITERAL_INSTALMENT_SECTION);
    expect(stripComments("const w = 2211;")).not.toMatch(LITERAL_INSTALMENT_SECTION);
    // A comment naming the old numbers is not a citation on screen.
    expect(stripComments("// keeps S.211/S.234C for 2024-25\nconst ok = 1;")).not.toMatch(LITERAL_INTEREST_SECTION);
  });
});
