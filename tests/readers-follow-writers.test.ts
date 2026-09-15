import { readFileSync } from "node:fs";
import path from "node:path";
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { REGISTRY, RULE, format, listSourceFiles, scanSource, scanTree, type RuleId, type ScanReport, type Violation } from "./helpers/field-rules";

/**
 * G3 (v4.3.0) — READERS FOLLOW WRITERS, checked by PARSING the code.
 *
 * The class this guards is the one that survived two fix waves: a value written
 * in one file and read differently in another. Wave 2H made every WRITER keep a
 * stored `mtfFundedAmount` of 0; five readers went on treating it as "never
 * set". Wave 2I widened the guard, but the guard was a regex over LINES, and
 * the wave-2I re-check listed what a line cannot see:
 *
 *   (a) a read split across lines          `const f = t.mtfFundedAmount\n ? … : est`
 *   (b) a destructured alias               `const { mtfFundedAmount: funded } = t`
 *   (c) a helper wrapping the field        `if (fundedOf(t) > 0)`
 *   (d) `Number(t.mtfFundedAmount) > 0`    (the call parens broke the regex)
 *   (e) `(t.mtfFundedAmount ?? 0) > 0`     (the nullish default collapses 0 onto null)
 *
 * …and what a line sees that is NOT a defect: a COMMENT quoting the old shape.
 *
 * So this scan is an AST walk with the TypeScript compiler API that already
 * ships in node_modules (`import ts from "typescript"` — no new dependency;
 * AGENTS.md forbids letting npm rewrite the lock). The rules, and the read rule
 * for each field, live in tests/helpers/field-rules.ts.
 *
 * NOTHING IS ALLOW-LISTED. Every rule states its scope structurally, so a file
 * that breaks it is reported rather than excused.
 *
 * A GREEN SCAN IS NOT EVIDENCE ON ITS OWN — an empty array is what a broken
 * scanner returns too. Every rule below is therefore ALSO run over the PRE-FIX
 * text of the very code that carried the defect (committed fixtures under tests/fixtures/pre-fix-3feb22f,
 * written from git show 3feb22f:<path>) and over inline fixtures of the five shapes above, so the
 * scan is proven able to SEE the class before its silence is believed.
 *
 * No database, no route: this file reads source text only.
 */

/** Source text by ref. A `3feb22f:<path>` ref reads a COMMITTED fixture (tests/fixtures/pre-fix-3feb22f/<path>.txt,
 *  written from `git show 3feb22f:<path>` on 2026-09-15) and a `HEAD:<path>` ref reads the working tree: CI checks out
 *  shallowly, so git history is not available there (run 35006280808 failed on "invalid object name 3feb22f").
 *  Regenerate a fixture with the same git command if it ever needs refreshing; never hand-edit one. */
const git = (ref: string): string => {
  const [sha, rel] = ref.split(/:(.+)/) as [string, string];
  if (sha === "HEAD") return readFileSync(path.join(process.cwd(), rel), "utf8");
  return readFileSync(path.join(process.cwd(), "tests", "fixtures", "pre-fix-" + sha, rel + ".txt"), "utf8");
};

/** The sha whose tree carried the three funded-0 readers (wave 2H, before 2I). */
const PRE = "3feb22f";

const at = (vs: Violation[]) => vs.map(format);
const linesOf = (vs: Violation[]) => [...new Set(vs.map((v) => `${v.file}:${v.line}`))];

describe("G3 — the scanner reproduces the class it guards (over the real pre-fix text)", () => {
  it("the three funded-0 readers of 3feb22f are all reported, with the expression that breaks the rule", () => {
    const files = ["lib/analytics/positions.ts", "app/reports/broker-compare/page.tsx", "lib/analytics/data-quality.ts"];
    const hits = files.flatMap((f) => scanSource(`${PRE}:${f}`, git(`${PRE}:${f}`), ["mtf-funded-0"]));

    // THE assertion: every one of the three readers the wave-2H re-check named
    // is reported, at its own line. On a scanner that cannot see the class this
    // array is empty — which is exactly what the green HEAD scan below would
    // also look like.
    expect(at(hits)).toEqual([
      `${PRE}:lib/analytics/positions.ts:128 t.mtfFundedAmount && t.mtfFundedAmount > 0`,
      `${PRE}:lib/analytics/positions.ts:128 t.mtfFundedAmount > 0`,
      `${PRE}:app/reports/broker-compare/page.tsx:59 t.mtfFundedAmount && t.mtfFundedAmount > 0`,
      `${PRE}:app/reports/broker-compare/page.tsx:59 t.mtfFundedAmount > 0`,
      `${PRE}:lib/analytics/data-quality.ts:842 !t.mtfFundedAmount`,
      `${PRE}:lib/analytics/data-quality.ts:842 t.mtfFundedAmount <= 0`,
    ]);
    expect(linesOf(hits)).toHaveLength(3);
    expect(hits.every((h) => h.rule === "mtf-funded-0" && h.why.length > 0)).toBe(true);

    // The same three files at HEAD read the rule's way, so it is the FIX that
    // makes the scan quiet, not a scanner that cannot see them.
    expect(files.flatMap((f) => scanSource(f, git(`HEAD:${f}`), ["mtf-funded-0"]))).toEqual([]);
  });

  it("the pre-fix close dialog's raw exit date is reported by the date rule (the daysHeld NaN class)", () => {
    const f = "components/trades/close-trade-dialog.tsx";
    const hits = scanSource(`${PRE}:${f}`, git(`${PRE}:${f}`), ["raw-date"]);
    // `daysHeld: trade.buyDate ? Math.max(0, Math.floor((new Date(exitDate)…` —
    // the buy date is guarded, the RAW exit field is not and never resolved.
    expect(linesOf(hits)).toEqual([`${PRE}:${f}:69`]);
    expect(hits[0].expr).toBe("new Date(exitDate)");
    expect(hits[0].why).toContain("Invalid Date");

    // The same file at HEAD resolves it once (`resolveExitIso`) and guards the
    // pair, so the rule is satisfied — the fix is what makes it quiet, not luck.
    expect(scanSource(f, git(`HEAD:${f}`), ["raw-date"])).toEqual([]);
  });
});

describe("G3 — the shapes the LINE-BASED scan missed", () => {
  /** tests/mtf-funded-zero.test.ts's own GUARDS, verbatim, for the contrast. */
  const LINE_GUARDS = [
    /mtfFundedAmount\s*&&/,
    /mtfFundedAmount\s*(?:>|>=|<|<=)\s*0/,
    /!\s*[\w.]*\bmtfFundedAmount\b/,
    /mtfFundedAmount\s*\?(?![?:.])/,
  ];
  const lineHits = (src: string) => src.split(/\r?\n/).filter((l) => LINE_GUARDS.some((re) => re.test(l))).length;

  const FIXTURES: [string, string, number][] = [
    [
      "(a) a read split across lines",
      `interface Row { mtfFundedAmount: number | null; buyValue: number }
const est = 1;
export function f(t: Row) {
  const funded = t.mtfFundedAmount
    ? t.mtfFundedAmount
    : est;
  return funded;
}`,
      1,
    ],
    [
      "(b) a destructured alias",
      `interface Row { mtfFundedAmount: number | null; buyValue: number }
export function f(t: Row, est: number) {
  const { mtfFundedAmount: funded } = t;
  return funded && funded > 0 ? funded : est;
}`,
      2, // the alias in the `&&`, and the alias compared `> 0`
    ],
    [
      "(c) a helper wrapping the field",
      `interface Row { mtfFundedAmount: number | null; buyValue: number }
function fundedOf(t: Row) { return t.mtfFundedAmount; }
export function f(t: Row, est: number) {
  if (fundedOf(t) > 0) return fundedOf(t);
  return est;
}`,
      1,
    ],
    [
      "(d) Number() around the read",
      `interface Row { mtfFundedAmount: number | null }
export function f(t: Row, est: number) {
  if (Number(t.mtfFundedAmount) > 0) return t.mtfFundedAmount;
  return est;
}`,
      1,
    ],
    [
      "(e) a nullish default that collapses 0 onto null",
      `interface Row { mtfFundedAmount: number | null }
export function f(t: Row, est: number) {
  if ((t.mtfFundedAmount ?? 0) > 0) return t.mtfFundedAmount;
  return est;
}`,
      1,
    ],
  ];

  it.each(FIXTURES)("%s: the AST scan reports it, the line scan does not", (_label, src, expected) => {
    const hits = scanSource("fixture.ts", src, ["mtf-funded-0"]);
    // THE assertion: the shape is SEEN.
    expect(hits).toHaveLength(expected);
    expect(hits.every((h) => h.why.length > 0)).toBe(true);
    // …and the line-based guard it replaces is blind to it (the wave-2I
    // re-check's own finding, re-proved here rather than quoted).
    expect(lineHits(src)).toBe(0);
  });

  it("a COMMENT quoting the old shape is NOT a violation (the line scan's false positive)", () => {
    const src = `interface Row { mtfFundedAmount: number | null }
export function f(t: Row, est: number) {
  // was: t.mtfFundedAmount && t.mtfFundedAmount > 0 ? t.mtfFundedAmount : est
  return t.mtfFundedAmount ?? est;
}`;
    expect(scanSource("fixture-comment.ts", src, ["mtf-funded-0"])).toEqual([]);
    // The line scan calls the comment a defect.
    expect(lineHits(src)).toBe(1);
  });

  it("every CORRECT read the tree actually uses stays silent (the scan is not 'flag any mention')", () => {
    const src = `interface Row { mtfFundedAmount?: number | null; buyValue: number; broker: string }
declare function est(v: number, pct: number): number;
declare function inr(n: number): string;
export function reads(t: Row) {
  const a = t.mtfFundedAmount ?? est(t.buyValue, 25);
  const b = t.mtfFundedAmount == null ? null : t.mtfFundedAmount;
  const c = t.mtfFundedAmount != null ? Math.max(0, t.buyValue - t.mtfFundedAmount) : null;
  const d = !Number.isFinite(t.mtfFundedAmount ?? NaN);
  const funded = t.mtfFundedAmount;
  if (funded == null) return inr(0);
  const own = t.buyValue - funded;
  return [a, b, c, d, own, { mtfFundedAmount: t.mtfFundedAmount }];
}`;
    expect(scanSource("fixture-correct.ts", src, ["mtf-funded-0"])).toEqual([]);
  });
});

describe("G3 — the raw-date rule, both ways", () => {
  it("an unresolved raw exit date is reported; resolving it or guarding it is not", () => {
    const bad = `declare const trade: { buyDate: string | null };
export function body(exitDate: string) {
  return trade.buyDate ? Math.floor((new Date(exitDate).getTime() - new Date(trade.buyDate).getTime()) / 864e5) : 0;
}`;
    const hits = scanSource("fixture-date.ts", bad, ["raw-date"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].expr).toBe("new Date(exitDate)");

    const resolved = `declare function resolveExitIso(s: string): string | null;
declare const trade: { buyDate: string | null };
export function body(exitDate: string) {
  const exitIso = resolveExitIso(exitDate);
  if (!trade.buyDate || !exitIso) return 0;
  return Math.floor((new Date(exitIso).getTime() - new Date(trade.buyDate).getTime()) / 864e5);
}`;
    expect(scanSource("fixture-date-ok.ts", resolved, ["raw-date"])).toEqual([]);

    const guardedEarly = `export function held(buyDate: string | null, sellDate: string | null) {
  if (!buyDate || !sellDate) return 1;
  return Math.abs(new Date(sellDate).getTime() - new Date(buyDate).getTime());
}`;
    expect(scanSource("fixture-date-guard.ts", guardedEarly, ["raw-date"])).toEqual([]);
  });
});

describe("G3 — the counted-once link rule (ipos.tradeId)", () => {
  /**
   * The one rule whose SCOPE is a judgement rather than a shape: "a realised
   * consumer". It is expressed structurally — a function that reads
   * `countedTradeIds` — which is why `getIposComputed`'s deliberately
   * account-scoped join (a different question: whose sale DATE a form may
   * pre-fill) needs no exception. A join built from raw SQL text is matched
   * textually inside that same scope; that half is a TEXT rule over the
   * function's source, stated here so the limitation is on the record.
   */
  it("an account-scoped link inside a counted-once consumer is reported; the same join outside one is not", () => {
    const bad = `import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { ipos, trades } from "@/lib/db/schema";
export function ipoIdsCountedThroughTrades(countedTradeIds: ReadonlySet<number>) {
  const rows = db.select({ id: ipos.id, tradeId: ipos.tradeId }).from(ipos)
    .innerJoin(trades, and(eq(trades.id, ipos.tradeId), eq(trades.accountId, ipos.accountId))).all();
  return new Set(rows.filter((r) => r.tradeId != null && countedTradeIds.has(r.tradeId)).map((r) => r.id));
}`;
    const hits = scanSource("lib/queries/fixture-ipos.ts", bad, ["ipo-link-scope"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].why).toContain("counted twice");

    const formRead = bad.replace("countedTradeIds: ReadonlySet<number>", "").replace("countedTradeIds.has(r.tradeId)", "r.tradeId > 0");
    expect(scanSource("lib/queries/fixture-ipos-form.ts", formRead, ["ipo-link-scope"])).toEqual([]);

    // The raw-SQL half of the same rule.
    const rawSql = `import { sql } from "drizzle-orm";
export function realisedIpoNet(countedTradeIds: ReadonlySet<number>) {
  return sql\`select i.id from ipos i join trades t on t.account_id = i.account_id and t.id = i.trade_id\`;
}`;
    expect(scanSource("lib/queries/fixture-ipos-sql.ts", rawSql, ["ipo-link-scope"])).toHaveLength(1);
  });
});

describe("G3 — HEAD under every rule", () => {
  /**
   * ONE walk for the whole file (measured locally 2026-09-15: 640 files read,
   * 104 parsed, 745 ms cold / ~450 ms warm — inside the 3 s local hook budget
   * and the 3 s walk budget). Each `it` below filters it, so no `it` pays for a
   * second walk and every one stays well inside 300 ms.
   */
  let full: ScanReport;
  beforeAll(() => {
    full = scanTree();
  });
  const hits = (id: RuleId) => full.violations.filter((v) => v.rule === id).map(format);

  it("mtf-funded-0: no reader in lib/, app/ or components/ treats a stated funded 0 as never set", () => {
    // THE assertion. Each violation prints as `file:line <expression>`, the
    // form the operator can open straight away.
    expect(hits("mtf-funded-0"), RULE["mtf-funded-0"].forbidden).toEqual([]);
  });

  it("ipo-link-scope: no counted-once consumer scopes the ipos→trades link by account", () => {
    expect(hits("ipo-link-scope"), RULE["ipo-link-scope"].forbidden).toEqual([]);
    // Not empty-satisfiable: the file that owns the rule IS parsed and DOES
    // carry a counted-once consumer (an empty trigger set would pass silently).
    const ipos = fs.readFileSync("lib/queries/ipos.ts", "utf8");
    expect(ipos).toContain("countedTradeIds");
    expect(scanSource("lib/queries/ipos.ts", ipos, ["ipo-link-scope"])).toEqual([]);
  });

  /**
   * FINDING G-G3-1 (product, low→medium): lib/queries/staged.ts:178 prices a
   * staged MTF ladder off a leg date that nothing validates.
   *
   * This `it` is RED ON HEAD and is marked `it.fails` — the pin holds the rule,
   * not the defect, so whoever fixes staged.ts must flip it back to `it`.
   * Measured 2026-09-15 (probe, deleted) on a seeded temp DB, angelone eq_mtf,
   * entry 100 @200 on 2026-08-20, priced as of 2026-09-15:
   *
   *   leg date '2026-08-20'  → charges 286.87, MTF interest 192.33   (honest)
   *   leg date '2026-02-31'  → charges 1544.40, MTF interest 1449.86 — `new Date`
   *       rolls the impossible day to 3 March, so the ladder bills seven months
   *       of interest and STORES it (parent row chargesTotal 1132.24 /
   *       mtfInterest 953.51). A silent wrong number.
   *   leg date 'not-a-date' or '31-08-2026' → days NaN, charges NaN, and
   *       `addLeg` THROWS `NOT NULL constraint failed: trade_legs.charges_total_paise`
   *       — the server action 500s instead of answering {ok:false}, AND the leg
   *       row is left behind: legs [[entry 2026-08-20 100 @200], [entry
   *       'not-a-date' 50 @210]] against a parent still reading 100 @200, the
   *       half-applied ladder `addLeg`'s own doc comment promises never happens
   *       (invariant 5: the parent row always holds the aggregate).
   *
   * Same class as L3 (wave 2L), which taught `closePosition` and
   * `updateManualTrade` to refuse a date that is not a real calendar day; the
   * staged ladder was not taught it. `app/trades/actions.ts` checks only that
   * the field is non-empty (`if (!tradeDate) return …`), so nothing between the
   * form and `new Date(leg.tradeDate)` reads the calendar. Reachability through
   * the shipped UI is nil — both leg forms use `<Input type="date" required>` —
   * so this needs a request posted straight at the server action.
   */
  it.fails("raw-date: no day count is taken from an unresolved, unguarded date field [RED ON HEAD — FINDING G-G3-1]", () => {
    expect(hits("raw-date"), RULE["raw-date"].forbidden).toEqual([]);
  });

  it("FINDING G-G3-1, stated positively: staged.ts is the ONE raw-date violation at HEAD, and its writer never reads the calendar", () => {
    expect(hits("raw-date")).toEqual(["lib/queries/staged.ts:178 new Date(leg.tradeDate)"]);
    // The reachability half: the only validation between the form and that read.
    const action = fs.readFileSync("app/trades/actions.ts", "utf8");
    expect(action).toContain('if (!tradeDate) return { ok: false, message: "Pick the date of this entry." };');
    expect(/tradeDate[^\n]*normalizeDate|unreadableDate\("(?:entry|exit|leg) date"/.test(action), "a calendar check on the leg date").toBe(false);
  });

  it("the walk is inside its budget and reaches the files that matter", () => {
    const report = full;
    // Not empty-satisfiable: the walk really reaches the files that matter.
    const files = listSourceFiles(["lib", "app", "components"]).map((f) => f.replace(/\\/g, "/"));
    for (const must of [
      "lib/analytics/positions.ts",
      "lib/analytics/data-quality.ts",
      "lib/risk/mtf-drift.ts",
      "lib/domain/trade-columns.ts",
      "lib/import/commit.ts",
      "lib/jobs/mtf-accrual.ts",
      "lib/queries/ipos.ts",
      "app/reports/broker-compare/page.tsx",
      "components/trades/close-trade-dialog.tsx",
      "components/trades/edit-trade-dialog.tsx",
      "components/live/load-desk.ts",
    ]) {
      expect(files.some((f) => f.endsWith(must)), `${must} is inside the walk`).toBe(true);
    }
    expect(report.filesRead).toBeGreaterThan(500);
    // Only files whose text carries a trigger are PARSED — that is what keeps
    // the walk inside its budget. Measured locally 2026-09-15: 640 files read,
    // 104 parsed, 745 ms for all three rules (budget: 3 s).
    expect(report.filesParsed).toBeLessThan(200);
    expect(report.filesParsed).toBeGreaterThan(20);
    // A smoke ceiling only: the Windows runner is > 15x slower on file work, so
    // a 3 s assertion here would be a flake, not a guard. The measured local
    // figure is in the comment above and in the report.
    expect(report.ms).toBeLessThan(20_000);
  });

  it("the registry states a rule, its forbidden shapes and its provenance for every field it guards", () => {
    expect(REGISTRY.map((r) => r.id)).toEqual(["mtf-funded-0", "raw-date", "ipo-link-scope"]);
    for (const r of REGISTRY) {
      expect(r.rule.length, r.id).toBeGreaterThan(40);
      expect(r.forbidden.length, r.id).toBeGreaterThan(20);
      expect(r.allowed.length, r.id).toBeGreaterThan(20);
      expect(r.provenance.length, r.id).toBeGreaterThan(20);
      expect(r.triggers.length, r.id).toBeGreaterThan(0);
    }
    expect(RULE["mtf-funded-0"].field).toBe("mtfFundedAmount");
  });

  it("re-scanning the same text re-uses the parsed file (the walk parses each file at most once)", () => {
    const src = `interface Row { mtfFundedAmount: number | null }
export const f = (t: Row) => t.mtfFundedAmount ?? 0;`;
    const t0 = performance.now();
    scanSource("cache-probe.ts", src, ["mtf-funded-0"]);
    const first = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 50; i++) scanSource("cache-probe.ts", src, ["mtf-funded-0"]);
    const fifty = performance.now() - t1;
    // 50 further scans of the same text cost less than 50x the first parse.
    expect(fifty).toBeLessThan(first * 50 + 50);
  });
});
