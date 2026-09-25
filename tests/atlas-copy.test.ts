import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * The Atlas COPY rulings (research answers Q49, Q52, Q58, Q59).
 *
 * Four sentences on this screen are not decoration — they are the difference
 * between a computation and a claim, and each was decided in 06-ANSWERS.md:
 * the provenance line (no Chartink data), the not-advice line, the cap-band
 * "current classification, not point-in-time" label, and the my-names dark
 * state that tells the user how to turn the tab on. A refactor that drops one
 * of them leaves a screen that reads like a recommendation, so the strings are
 * pinned here and the wiring is read out of the real component source.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let t: TempDb;
let q: typeof import("@/lib/queries/atlas");

beforeAll(async () => {
  t = await openTempDb("atlas-copy", { seed: true });
  q = await import("@/lib/queries/atlas");
});

afterAll(() => t?.cleanup());

describe("the two footer lines (Q58/Q59)", () => {
  it("names the source and rules Chartink out, verbatim", () => {
    expect(q.NO_CHARTINK_LINE).toBe(
      "Computed from your stored end-of-day bhavcopy. No Chartink data is used.",
    );
  });

  it("says the screen computes and does not advise, verbatim", () => {
    expect(q.NOT_ADVICE_LINE).toBe("Vyuha computes; it does not advise.");
  });

  it("hands both lines to the panel, which prints them", () => {
    // The loader's own output, not a literal restated here: the previous
    // version built `view` from the same two constants and then asserted them
    // against themselves, which was true of any code at all.
    const view = q.getAtlasPageData().view!;
    expect(view.provenanceLine).toBe(q.NO_CHARTINK_LINE);
    expect(view.notAdviceLine).toBe(q.NOT_ADVICE_LINE);
    const panel = read("components/atlas/atlas-panel.tsx");
    expect(panel).toContain("view.provenanceLine");
    expect(panel).toContain("view.notAdviceLine");
  });
});

describe("cap bands say what the band means (Q49)", () => {
  it("labels the classification as current, not point-in-time", () => {
    expect(q.CAP_BAND_CLASSIFICATION_NOTE.toLowerCase()).toContain(
      "current classification, not point-in-time",
    );
  });

  it("says the band is not backdated to the session being measured", () => {
    expect(q.CAP_BAND_CLASSIFICATION_NOTE).toMatch(/not backdated/i);
  });
});

describe("my names is dark until the cohort is real (Q52)", () => {
  it("needs 21 stored sessions", () => {
    expect(q.COHORT_MIN_SESSIONS).toBe(21);
  });

  it("tells the user to run the backfill, and counts what they have", () => {
    const view = q.getMyNames([], 4);
    expect(view.enabled).toBe(false);
    expect(view.cohorts).toHaveLength(0);
    expect(view.reason).toMatch(/run the backfill to enable/i);
    expect(view.reason).toContain("21");
    expect(view.reason).toContain("you have 4");
  });

  it("is enabled once the sessions are there", () => {
    const view = q.getMyNames([], 21);
    expect(view.enabled).toBe(true);
  });
});

describe("every figure prints its formula (build prompt Q-5)", () => {
  const panel = read("components/atlas/atlas-panel.tsx");

  it("hands a formula= to EVERY MetricTile, not just the two that had one", () => {
    // Q-5: every non-IP Atlas figure prints its plain public definition on
    // screen. Seven of the nine tiles shipped without one — advancing,
    // declining, unchanged, both regime inputs and both new-high/low counts —
    // so the screen asserted a breadth number and said nowhere what it meant
    // by "advancing". Counting is the guard that a NEW tile cannot ship bare.
    const tiles = (panel.match(/<MetricTile[\s>]/g) ?? []).length;
    const formulas = (panel.match(/[\s]formula=/g) ?? []).length;
    expect(tiles).toBeGreaterThan(0);
    expect(formulas, `${tiles} MetricTile(s) but only ${formulas} formula= prop(s)`).toBe(tiles);
  });

  it("defines the rotation table's columns on the tab that prints them — as the MEDIAN (AQ18)", () => {
    // The window columns are figures, not tiles, so they carry no formula= —
    // the definition sits under the table instead (components/atlas/rotation-table.tsx
    // since v4.6.0 W5). v3 FLIPS the shipped statistic: the wording pinned here
    // used to be "equal-weighted mean of each measurable"; the median is what
    // ships now and the mean is the labelled alternative (design review A2).
    const rotation = read("components/atlas/rotation-table.tsx");
    expect(rotation).toMatch(/median of each measurable member/i);
    expect(rotation).not.toMatch(/equal-weighted mean of each measurable/i);
    expect(rotation).toMatch(/the mean is the labelled alternative/i);
    expect(rotation).toMatch(/share of measurable members whose close is/i);
    // Every member counts once — no market cap, no free float.
    expect(rotation).toMatch(/every member counts once, whatever its size/i);
  });

  it("prints the group statistic in words on the cohort tab and the preview, never the old mean wording", () => {
    const cohort = read("components/atlas/cohort-table.tsx");
    expect(cohort).toMatch(/median[\s\S]*return of its own\s+cohort/i);
    const preview = read("components/atlas/atlas-preview.tsx");
    expect(preview).toMatch(/median return of its own cohort/i);
    expect(preview).not.toMatch(/equal-weighted return of its own sector cohort/i);
  });

  it("says what it does NOT do, without describing a feed that does not exist (Q-12)", () => {
    expect(panel).not.toMatch(/separate, signed, opt-in feed/);
    expect(panel).toMatch(/no feed/i);
    const page = read("app/atlas/page.tsx");
    expect(page).not.toMatch(/separate signed feed/i);
    expect(page).toMatch(/no such feed/i);
  });
});

describe("the locked preview (Q57)", () => {
  it("describes the cap bands without printing a figure", () => {
    const preview = read("components/atlas/atlas-preview.tsx");
    expect(preview.toLowerCase()).toContain("current classification, not a point-in-time");
  });

  it("carries exactly the panel's five tabs, in order (AQ3: a rename moves both in one commit)", async () => {
    const { TABS } = await import("@/components/atlas/atlas-panel");
    expect(TABS.map((t) => t.key)).toEqual(["market", "sectors", "cap", "mine", "coverage"]);
    const preview = read("components/atlas/atlas-preview.tsx");
    const labels = [...preview.matchAll(/^\s*label: "([^"]+)",\s*$/gm)].map((m) => m[1]);
    expect(labels).toEqual(TABS.map((t) => t.label));
  });
});

/**
 * AQ47 (owner, 2026-09-25): the panel describes; it never rates, scores or
 * tells anyone what to do. The banned vocabulary is scanned over every Atlas
 * component's PROSE — comments stripped first, so an explanation of the rule
 * cannot fail the rule — as whole words, case-insensitive. "overflow" is not
 * "flow"; "sellers" would be, and is not used.
 */
describe("the v3 panel's vocabulary (AQ47)", () => {
  const FORBIDDEN = [/\bmoney\b/i, /\bflow\b/i, /\bflows\b/i, /\brisk-on\b/i, /\breduce\b/i, /\bbuy\b/i, /\bsell\b/i, /\bscore\b/i, /\bscores\b/i, /\brating\b/i, /\bratings\b/i];
  const files = fs.readdirSync(path.join(ROOT, "components/atlas")).filter((f) => f.endsWith(".tsx"));
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("scans at least the panel, the rotation table, the cohort table and the honesty list", () => {
    expect(files).toEqual(expect.arrayContaining(["atlas-panel.tsx", "rotation-table.tsx", "cohort-table.tsx", "not-computed-list.tsx", "atlas-preview.tsx"]));
  });

  it.each(files)("%s uses none of the banned words", (file) => {
    const src = stripComments(read(`components/atlas/${file}`));
    for (const re of FORBIDDEN) {
      const hit = src.match(re);
      expect(hit, `${file} contains "${hit?.[0]}"`).toBeNull();
    }
  });

  it("the scan can fire — a planted sentence is caught", () => {
    const planted = stripComments(`export const x = "a score for what to buy";`);
    expect(FORBIDDEN.some((re) => re.test(planted))).toBe(true);
    // …and a comment does not trip it.
    expect(FORBIDDEN.some((re) => re.test(stripComments(`/* no score here */ const y = 1;`)))).toBe(false);
  });

  it("says turnover share, never the vendor's phrasing (AQ9)", () => {
    const rotation = read("components/atlas/rotation-table.tsx");
    expect(rotation).toMatch(/turnover share/i);
    for (const file of files) expect(read(`components/atlas/${file}`)).not.toMatch(/flowing in/i);
  });

  it("the honesty list names no vendor and no dashboard", () => {
    const list = read("components/atlas/not-computed-list.tsx");
    expect(list).not.toMatch(/chartink/i);
    expect(list).not.toMatch(/dashboard\s*\/?\s*\d+/i);
    expect(list).toContain("NOT_COMPUTED_GATES");
  });
});

/**
 * The v3 panel's honesty rules, pinned in source where a render cannot reach
 * them: the collapsed-denominator tile (AQ44), the filter that never writes,
 * the settings editor that echoes the route's 400 verbatim, and the copy that
 * spells out "unknown" instead of a bare code.
 */
describe("v3 panel rules in source", () => {
  it("MetricTile hides the value below the coverage floor and prints the coverage sentence instead (AQ44)", () => {
    const tile = read("components/atlas/metric-tile.tsx");
    expect(tile).toMatch(/import \{ COVERAGE_FLOOR_PPM \} from "@\/lib\/atlas\/types"/);
    expect(tile).toMatch(/belowCoverageFloor\(/);
    expect(tile).toMatch(/coverageSentence\(/);
  });

  it("the index filter is a GET of /api/atlas/view and the panel never posts a recompute (A8)", () => {
    const panel = read("components/atlas/atlas-panel.tsx");
    expect(panel).toMatch(/fetch\(`\/api\/atlas\/view\?index=\$\{encodeURIComponent\(indexFilter\)\}`/);
    expect(panel).not.toMatch(/method:\s*"POST"/);
    // The stored rows are never filtered client-side: the RETURNED payload is what the tabs read.
    expect(panel).toMatch(/const payload = active\?\.payload \?\? view\.payload;/);
  });

  it("the regime editor writes through the route handler and echoes its message inline — no server action", () => {
    const editor = read("components/settings/atlas-regime-editor.tsx");
    expect(editor).not.toMatch(/"use server"/);
    expect(editor).toMatch(/fetchImpl\("\/api\/settings"/);
    expect(editor).toMatch(/type: "atlas-regime"/);
    expect(editor).toMatch(/router\.refresh\(\)/);
    expect(editor).toMatch(/setError\(r\.message\)/);
  });

  it("spells every unknown-regime reason in words, including the coverage floor (A9)", () => {
    const panel = read("components/atlas/atlas-panel.tsx");
    for (const reason of ["missing_sma50", "missing_net_high_low", "coverage_below_floor"]) expect(panel).toContain(`case "${reason}"`);
    expect(panel).toMatch(/below the .* coverage floor, so the label does not vote/);
  });

  it("remembers the four preferences under vyuha- keys with a {v:1} envelope (AQ4)", () => {
    const panel = read("components/atlas/atlas-panel.tsx");
    for (const key of ["vyuha-atlas-tab", "vyuha-atlas-level", "vyuha-atlas-statistic", "vyuha-atlas-index-filter"]) expect(panel).toContain(`"${key}"`);
    expect(panel).toMatch(/JSON\.stringify\(\{ v: 1, \[field\]: value \}\)/);
    expect(panel).toMatch(/useStoredValue\(/);
    expect(panel).toMatch(/writeStored\(/);
  });
});
