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
];

// `?? <literal>` or `|| <literal>` where the literal is one of the historical
// fabricated capital bases (in any digit-grouping spelling).
const FABRICATED_CAPITAL_FALLBACK = /(\?\?|\|\|)\s*(1700000|1300000|400000)\b/;

describe("no fabricated capital fallbacks (invariant 6)", () => {
  for (const file of GUARDED_FILES) {
    it(`${file} does not fall back to an invented capital base`, () => {
      // Comments legitimately NAME the old fallbacks ("The old ?? 400000 …"),
      // so strip block and line comments first; then normalise
      // numeric-separator spellings (1_300_000, 13_00_000, …) so a
      // reformatted literal cannot slip past the pattern.
      const src = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/(\d)_(?=\d)/g, "$1");
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
});
