import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Source guard for audit fix A1 — invariant 6: never fabricate a denominator.
 *
 * On a fresh install no capital is configured (seed-core seeds 0), and these
 * files used to substitute invented capital — `?? 1300000`, `?? 400000`,
 * `|| 1700000` — so every downstream percentage (returns, exposure, margin
 * utilisation, concentration, ledger opening balances) silently computed on
 * fiction. The honest semantic is: capital unknown ⇒ capital-relative outputs
 * say so ("—", null, a skipped check with a notice), while capital-free ₹
 * figures keep rendering.
 *
 * This test fails if any of those fallback literals creeps back into a file
 * that feeds a capital denominator. It is deliberately a TEXT check: the bug
 * class is a literal constant standing in for user configuration, which no
 * unit test of the maths can see (the maths is correct on any base — that is
 * the problem).
 */

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

// Every file that reads bucket capital for a denominator. Includes the sites
// fixed in earlier passes so none of them regresses either.
const GUARDED_FILES = [
  "app/reports/monthly/page.tsx",
  "app/risk/page.tsx",
  "app/targets/equity/page.tsx",
  "lib/queries/ledger.ts",
  "lib/queries/limits.ts",
  "app/reports/performance/page.tsx",
  "app/equity/page.tsx",
  "app/active/page.tsx",
  "components/trackers/tracker-client.tsx",
  // v3.6 goal tracking: every file that feeds a capital denominator into goal
  // maths. Unknown capital must flow through as null/"—", never a literal.
  "lib/queries/capital.ts",
  "lib/queries/goals.ts",
  "lib/analytics/goal.ts",
  "components/settings/goal-card.tsx",
  "components/targets/goal-strip.tsx",
  // v3.6 Telegram digest: "open risk as % of capital" is a capital
  // denominator that leaves the machine. Unknown capital OMITS the % line
  // (pinned in tests/telegram-format.test.ts) — never a literal.
  "lib/jobs/telegram-digest.ts",
  "lib/telegram/format.ts",
];

// `?? <literal>` or `|| <literal>` where the literal is one of the historical
// fabricated capital bases (in any digit-grouping spelling).
const FABRICATED_CAPITAL_FALLBACK = /(\?\?|\|\|)\s*(1700000|1300000|400000)\b/;

// Comments legitimately NAME the old fallbacks ("The old ?? 400000 …"), so the
// guard strips block and line comments before matching. The block strip must
// not start inside an Accept-header MIME wildcard ("text/csv,*/*" contains the
// two characters that open a block comment; a naive strip ate from there to
// the next close, swallowing real code — found live in lib/jobs/auto-mtm.ts by
// the egress guard, same stripper family). A real comment opener is never
// preceded by a word char, comma or star; those are exactly the MIME shapes.
const stripComments = (src: string) =>
  src
    .replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("no fabricated capital fallbacks (invariant 6)", () => {
  for (const file of GUARDED_FILES) {
    it(`${file} does not fall back to an invented capital base`, () => {
      // Strip comments first; then normalise numeric-separator spellings
      // (1_300_000, 13_00_000, …) so a reformatted literal cannot slip past.
      const src = stripComments(read(file)).replace(/(\d)_(?=\d)/g, "$1");
      const m = src.match(FABRICATED_CAPITAL_FALLBACK);
      expect(
        m,
        m
          ? `${file} falls back to a fabricated capital base (“${m[0]}”). ` +
            "Capital unknown must surface as unknown — see AGENTS.md invariant 6."
          : undefined,
      ).toBeNull();
    });
  }

  it("the comment stripper is not blinded by a MIME wildcard", () => {
    // "*/*" must not open a comment: the fallback after it stays visible.
    const withWildcard =
      'const h = { Accept: "text/csv,*/*" };\nconst cap = settings ?? 1300000;\n';
    expect(stripComments(withWildcard)).toContain("?? 1300000");
    // A real block comment is still stripped, and a comment that merely NAMES
    // an old fallback still does not trip the guard.
    const withComment = "/* the old ?? 400000 fallback */\nconst ok = 1;\n";
    const stripped = stripComments(withComment);
    expect(stripped).not.toContain("400000");
    expect(stripped).toContain("const ok = 1;");
  });
});
