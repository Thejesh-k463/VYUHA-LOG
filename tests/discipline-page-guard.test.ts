import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { disciplineByWeek, type DisciplineTrade } from "@/lib/analytics/discipline";
import { PROCESS_SCORE_FLOOR } from "@/lib/analytics/process-score";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";
import { weeklyScoreAverage } from "@/components/reports/weekly-score-average";

/**
 * The two report pages that render the weekly Process Score — invariant 6.
 *
 * v3.7 WS2 shipped `processScore: number | null` + `refusal` beside the legacy
 * `WeekScore.score`, which is **0 when the week refuses**. Wave 2a could not
 * switch these two pages over (they were another agent's files), so for one
 * wave a week with too few closed trades to score rendered as a ZERO and was
 * averaged into the monthly report's "Discipline score" — a fabricated
 * denominator on a PRINTED, shareable page. This file exists so that cannot
 * come back:
 *
 *  * neither page falls back to `9500` / `25000` for a cap or stop the user
 *    never configured (the same bug class as the fabricated capital bases in
 *    `tests/capital-fallback-guard.test.ts`, and the same text-check argument:
 *    the arithmetic is correct on any limit — inventing the limit is the bug).
 *    That check covers `NO_INVENTED_LIMIT`, which is wider than the two report
 *    pages: the Target Tracker (`app/targets/active/page.tsx` and its client)
 *    kept substituting ₹9,500 / ₹25,000 for a wave after the release note said
 *    the product had stopped;
 *  * neither page reads a week's `.score`, and the average is taken over the
 *    weeks that SCORED, never a plain reduce over every week;
 *  * `scoreColor` is only ever handed a number that exists;
 *  * and the arithmetic itself is proved on fixtures, not just on source text.
 */

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const PAGES = ["app/reports/discipline/page.tsx", "app/reports/monthly/page.tsx"];

/**
 * Wider than PAGES, and deliberately so. The v3.7.0 note says a limit you never
 * set is no longer substituted; the Target Tracker — a RISK cockpit — was still
 * reading `?? 9500` per segment, `?? 25000` for the day and `?? 9500` for the
 * lot sizer, so the claim read product-wide while one page still did it. Its
 * client half is listed too: the page can only pass null if nothing downstream
 * fills the blank back in.
 */
const NO_INVENTED_LIMIT = [
  ...PAGES,
  "app/targets/active/page.tsx",
  "components/targets/target-active-client.tsx",
];
const HELPER = "components/reports/weekly-score-average.ts";
const DETAIL = "components/reports/process-score-detail.tsx";

/** `?? 9500` / `|| 25000` — a per-trade cap or daily stop nobody set. */
const INVENTED_LIMIT_FALLBACK = /(\?\?|\|\|)\s*(9500|25000)\b/;

/** `w.score`, `week.score`, `latest?.score` — the legacy field that reads 0 on refusal. */
const LEGACY_SCORE_READ = /(?:^|[^.\w])(?:w|week|latest)\s*\??\.\s*score\b/m;

// Comments legitimately NAME the old fallbacks ("v3.6 read `?? 9500` here"), so
// strip them first. Same stripper as the capital guard, MIME-wildcard trap and
// all: "text/csv,*/*" carries the two characters that open a block comment, and
// a naive strip ate from there to the next close.
const stripComments = (src: string) =>
  src
    .replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** `9_500` is the same literal as `9500`; a reformat must not slip past. */
const normalise = (src: string) => stripComments(src).replace(/(\d)_(?=\d)/g, "$1");

describe("no surface invents a cap or a stop", () => {
  it.each(NO_INVENTED_LIMIT)("%s passes null rather than a limit the user never set", (file) => {
    const src = normalise(read(file));
    const m = src.match(INVENTED_LIMIT_FALLBACK);
    expect(
      m,
      m
        ? `${file} falls back to an invented risk limit (“${m[0]}”). A cap nobody configured ` +
          "makes the Process Score judge a rule that does not exist — see AGENTS.md invariant 6."
        : undefined,
    ).toBeNull();
  });

  it("the stripper hides a comment that names the old fallback, not live code", () => {
    expect(normalise("// v3.6 read `?? 9500` here\nconst cap = x ?? null;\n")).not.toContain("9500");
    expect(normalise('const h = { Accept: "text/csv,*/*" };\nconst cap = x ?? 9500;\n')).toContain("?? 9500");
    expect(normalise("const stop = x ?? 25_000;\n")).toMatch(INVENTED_LIMIT_FALLBACK);
  });
});

describe("both pages read the honest pair, not the legacy score", () => {
  it.each(PAGES)("%s never reads a week's `.score`", (file) => {
    const src = stripComments(read(file));
    const m = src.match(LEGACY_SCORE_READ);
    expect(
      m,
      m
        ? `${file} reads the legacy WeekScore.score (“${m[0].trim()}”), which is 0 on a refused ` +
          "week. Read `processScore` + `refusal` instead."
        : undefined,
    ).toBeNull();
    expect(src, `${file} never sums a score field`).not.toMatch(/\+\s*\w+\.score\b/);
  });

  it.each(PAGES)("%s resolves its score through processScore/refusal", (file) => {
    const src = stripComments(read(file));
    expect(
      src.includes("processScore") || src.includes("weeklyScoreAverage"),
      `${file} no longer reaches the Process Score (directly or through weeklyScoreAverage)`,
    ).toBe(true);
  });

  it("the discipline page renders the refusal and exports it beside a blank score", () => {
    const src = stripComments(read(PAGES[0]));
    expect(src, "the weekly table stopped rendering the refusal").toContain("refusal");
    expect(src, "the export lost the Process Score column").toMatch(/key:\s*"processScore"/);
    expect(src, "the export lost the refusal reason").toMatch(/key:\s*"refusal"/);
    expect(src, "the export still ships the legacy score column").not.toMatch(/key:\s*"score"/);
  });

  it("the shared average keys on processScore and never on score", () => {
    const src = stripComments(read(HELPER));
    expect(src).toContain("processScore");
    expect(src, "the average reads the legacy 0-on-refusal field").not.toMatch(/\.score\b/);
  });
});

describe("the average is taken over scoring weeks only", () => {
  it.each([...PAGES, HELPER])("%s does not reduce over every week", (file) => {
    const src = stripComments(read(file));
    expect(
      src,
      `${file} reduces over the whole week list — a refused week would vote 0 in the average`,
    ).not.toMatch(/\bweeks\.reduce\(/);
  });

  it("the helper's reduce runs over the filtered list", () => {
    const src = stripComments(read(HELPER));
    expect(src).toMatch(/filter\(\(w\)\s*=>\s*w\.processScore\s*!=\s*null\)/);
    expect(src).toMatch(/scored\.reduce\(/);
  });

  it("scoreColor is only ever handed a number that exists", () => {
    const src = stripComments(read(PAGES[0]));
    const args = [...src.matchAll(/scoreColor\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((a) => a !== "s: number"); // the declaration itself
    expect(args.length, "scoreColor is no longer called — has the colour scale gone?").toBeGreaterThan(0);
    for (const a of args) {
      expect(a, `scoreColor(${a}) may be handed a refused week`).toMatch(
        /^(weekly\.avg|latestScore|w\.processScore)$/,
      );
    }
  });
});

describe("copy on these surfaces stays descriptive (owner decision #7)", () => {
  // Comments are stripped: they state the RULE ("a printed report must not
  // divide one account's P&L by another's capital") and legitimately carry the
  // banned words. Only text that can reach a screen is scanned.
  it.each([...PAGES, HELPER, DETAIL])("%s carries no prescriptive language", (file) => {
    expect(
      stripComments(read(file)),
      `${file} instructs the reader instead of describing the record`,
    ).not.toMatch(PRESCRIPTIVE_LANGUAGE);
  });
});

// --- The arithmetic itself, on real weeks -----------------------------------

const trade = (sellDate: string, o: Partial<DisciplineTrade> = {}): DisciplineTrade => ({
  sellDate,
  netPnl: 1000, // every trade a winner: no losers, so `risk-cap` refuses on its own
  riskAmount: null,
  slPlanned: 100,
  targetPlanned: null,
  isOpen: false,
  playbookId: null,
  ruleViolations: null,
  reviewedAt: "2026-02-20",
  ...o,
});

/** `n` closed trades on one Monday, the first `reviewed` of them reviewed. */
const week = (monday: string, n: number, reviewed = n) =>
  Array.from({ length: n }, (_, i) => trade(monday, { reviewedAt: i < reviewed ? "2026-02-20" : null }));

// Five ISO weeks. Two clear the floor (10 closed trades), three do not.
//   2026-W02  10 trades, all planned, all reviewed   → mean(100, 100) = 100
//   2026-W03  10 trades, all planned, 2 reviewed     → mean(100,  20) =  60
//   2026-W04/05/06  4 / 3 / 2 trades                 → under floor, no score
//
// RECORDED NEWEST-FIRST, ON PURPOSE. Both pages under test feed `getTrades()`,
// which is ordered newest-first, so `disciplineByWeek`'s Map is populated
// newest week first and its trailing
// `.sort((a, b) => a.weekStart.localeCompare(b.weekStart))` is the ONLY thing
// rendering the weekly table in reading order. A chronological fixture is
// already sorted by insertion — it would keep this file green with that sort
// deleted, while the table on screen ran backwards.
const FIXTURE: DisciplineTrade[] = [
  ...week("2026-02-02", 2),
  ...week("2026-01-26", 3),
  ...week("2026-01-19", 4),
  ...week("2026-01-12", 10, 2),
  ...week("2026-01-05", 10),
];

describe("three sub-floor weeks of five do not vote zero", () => {
  const weeks = disciplineByWeek(FIXTURE, null, null);

  it("the fixture really is 2 scoring weeks and 3 refusals, oldest week first", () => {
    expect(weeks).toHaveLength(5);
    // A LITERAL sequence, never a sorted copy of the actual — the fixture went
    // in backwards, so this is what the `.sort()` inside the bucketer buys.
    expect(weeks.map((w) => w.weekStart)).toEqual([
      "2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02",
    ]);
    expect(weeks.map((w) => w.processScore)).toEqual([100, 60, null, null, null]);
    for (const w of weeks.filter((x) => x.processScore == null)) {
      expect(w.refusal?.reason).toMatch(new RegExp(`this week; the score needs ${PROCESS_SCORE_FLOOR}`));
    }
  });

  it("averages the weeks that scored and states its coverage", () => {
    const r = weeklyScoreAverage(weeks);
    expect(r.avg).toBe(80);
    expect(r.display).toBe("80");
    expect(r.scoringWeeks).toBe(2);
    expect(r.totalWeeks).toBe(5);
    expect(r.coverage).toBe("across 2 scoring weeks of 5");
  });

  it("the v3.6 defect — refused weeks summed as 0 — is measurably gone", () => {
    // What the monthly report printed for one wave: `weeks.reduce((s, w) => s + w.score, 0)`
    // over EVERY week, with `score` 0 on refusal. This deliberately still READS
    // the legacy field — it is the live hazard. Once nothing populates
    // `WeekScore.score` any more, this case stops compiling, which is the
    // correct moment to delete it rather than to work around it.
    const legacy = Math.round((weeks.reduce((s, w) => s + w.score, 0) / weeks.length) * 10) / 10;
    expect(legacy, "the legacy field still reads 0 on a refused week").toBe(32);
    expect(weeks.filter((w) => w.processScore == null).every((w) => w.score === 0)).toBe(true);
    expect(weeklyScoreAverage(weeks).avg).not.toBe(legacy);
  });

  it("one scoring week says 'week', not 'weeks'", () => {
    const r = weeklyScoreAverage(disciplineByWeek([...week("2026-01-05", 10), ...week("2026-01-19", 4)], null, null));
    expect(r.coverage).toBe("across 1 scoring week of 2");
  });
});

describe("a book where no week scores renders an em dash, never a zero", () => {
  const weeks = disciplineByWeek(
    [...week("2026-01-05", 4), ...week("2026-01-12", 3), ...week("2026-01-19", 2)],
    null,
    null,
  );

  it("every week refused", () => {
    expect(weeks).toHaveLength(3);
    expect(weeks.every((w) => w.processScore == null && w.refusal != null)).toBe(true);
  });

  it("the average refuses rather than printing 0", () => {
    const r = weeklyScoreAverage(weeks);
    expect(r.avg).toBeNull();
    expect(r.display).toBe("—");
    expect(r.display).not.toBe("0");
    expect(r.scoringWeeks).toBe(0);
    expect(r.coverage).toBe(`no week of 3 reached ${PROCESS_SCORE_FLOOR} closed trades`);
  });

  it("an empty book says so instead of scoring nothing", () => {
    const r = weeklyScoreAverage([]);
    expect(r.avg).toBeNull();
    expect(r.display).toBe("—");
    expect(r.coverage).toBe("no closed weeks yet");
  });
});
