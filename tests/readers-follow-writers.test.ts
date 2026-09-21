import { readFileSync } from "node:fs";
import path from "node:path";
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
// Wave U's `findRates` door guard walks the same AST with the same compiler
// that already ships in node_modules — no new dependency (AGENTS.md).
import ts from "typescript";
import { REGISTRY, RULE, format, listSourceFiles, scanSource, scanTree, type RuleId, type ScanReport, type Violation } from "./helpers/field-rules";
// Pure (no DB, no React), so the WRITE half of the raw-date rule is asserted by
// behaviour here and not only by the shape of the source text.
import { validateLegs } from "@/lib/domain/staged";

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

  /**
   * FINDING ipo#1 (wave-2L re-check, fixed in wave 2N) — the DAY-COUNTER half.
   * `accrueMtfInterest` handed the stored `t.buyDate` straight to `epochSpans`,
   * which does not throw on a value it cannot read: measured, '9999-99-99' spans
   * 0 days, so the job SET the row's interest to 0 and moved its stored charges
   * and net with it, and '2026-02-31' billed 199 days / ₹636.80. An emptiness
   * guard (`if (!t.buyDate) continue`) is what the job already had — which is why
   * a resolver, not a guard, is what this half of the rule requires.
   */
  it("a raw date handed to a DAY COUNTER is reported even under an emptiness guard; resolving it is not", () => {
    const bad = `declare function epochSpans(a: unknown, b: string, c: string, d: string, from: string, to: string): { days: number }[];
export function accrue(t: { buyDate: string | null; broker: string; exchange: string }, rates: unknown, today: string) {
  if (!t.buyDate) return 0;
  return epochSpans(rates, t.broker, "eq_mtf", t.exchange, t.buyDate, today).length;
}`;
    const hits = scanSource("fixture-daycount.ts", bad, ["raw-date"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].expr).toBe("t.buyDate");
    expect(hits[0].why).toContain("0 days");

    const resolved = bad
      .replace("if (!t.buyDate) return 0;", "const buyIso = normalizeDate(t.buyDate);\n  if (!buyIso) return 0;")
      .replace("t.buyDate, today", "buyIso, today");
    expect(scanSource("fixture-daycount-ok.ts", `declare function normalizeDate(s: string | null): string | null;\n${resolved}`, ["raw-date"])).toEqual([]);

    // …and the real file at HEAD reads it the resolved way.
    expect(scanSource("lib/jobs/mtf-accrual.ts", fs.readFileSync("lib/jobs/mtf-accrual.ts", "utf8"), ["raw-date"])).toEqual([]);
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

/**
 * v4.4.0 D1 (design review verdict REVISE, brief delta 4) — the per-trade cap
 * has ONE reader rule: `resolvePerTradeCap`. The registry entry is STRUCTURAL —
 * a `perTradeMaxLoss` read on a CARRIER of a `.from(riskConfig)` select — not a
 * file allow-list, and it is proven red against the importer as it stood at the
 * design's base (`58bf72c`, committed fixture), where `?? 9500` sat on the GLOBAL
 * row alone while the breach checks resolved global < bucket < segment.
 */
describe("v4.4.0 D1 — the per-trade cap is read through the resolver (risk-cap-resolver)", () => {
  const RC = "58bf72c";

  it("reports the pre-review importer's read of the GLOBAL row, and HEAD's importer is silent", () => {
    const f = "lib/import/commit.ts";
    const hits = scanSource(`${RC}:${f}`, git(`${RC}:${f}`), ["risk-cap-resolver"]);
    expect(hits.map((v) => v.expr)).toEqual(["globalRisk?.perTradeMaxLoss ?? 9500"]);
    expect(scanSource(f, git(`HEAD:${f}`), ["risk-cap-resolver"])).toEqual([]);
  });

  it("sees every carrier shape the pages and the importer used — and stays silent on the resolver's own reads", () => {
    const bad = `import { riskConfig } from "@/lib/db/schema";
declare const db: any;
export function page() {
  const risk = db.select().from(riskConfig).all();
  const a = risk.find((r: any) => r.scope === "global")?.perTradeMaxLoss ?? null;
  const globalRisk = db.select().from(riskConfig).where(1).all()[0];
  const b = globalRisk?.perTradeMaxLoss;
  const caps = risk.map((r: any) => r.perTradeMaxLoss);
  const segRisk = (k: string) => risk.find((r: any) => r.key === k);
  const c = segRisk("index_option")?.["perTradeMaxLoss"];
  const { perTradeMaxLoss: d } = risk.find((r: any) => r.key === "equity")!;
  return [a, b, caps, c, d];
}`;
    const seen = scanSource("fixture-risk-cap.ts", bad, ["risk-cap-resolver"]);
    expect(seen.map((v) => v.line)).toEqual([5, 7, 8, 10, 11]);

    const good = `import { riskConfig } from "@/lib/db/schema";
import { resolvePerTradeCap, withSegmentCap } from "@/lib/risk/limits";
declare const db: any; declare const body: any; declare const trades: any[];
export function page(props: { segLimits: { perTradeMaxLoss: number | null }[] }) {
  const risk = db.select().from(riskConfig).all();
  const cap = resolvePerTradeCap(risk, "active", "index_option");
  const scored = withSegmentCap(risk, trades);
  db.update(riskConfig).set({ perTradeMaxLoss: Number(body.perTradeMaxLoss) }).run();
  return [cap, scored, props.segLimits.map((s) => s.perTradeMaxLoss)];
}`;
    expect(scanSource("fixture-risk-cap-ok.ts", good, ["risk-cap-resolver"])).toEqual([]);
  });

  it("does NOT flag target-active-client.tsx: its `perTradeMaxLoss` is a resolved figure handed down as a PROP", () => {
    const f = "components/targets/target-active-client.tsx";
    const src = fs.readFileSync(f, "utf8");
    expect(src, "not empty-satisfiable: the file does read a same-named field").toContain(".perTradeMaxLoss");
    expect(scanSource(f, src, ["risk-cap-resolver"])).toEqual([]);
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

  /**
   * D7 (v4.3.0 wave 2N) — the two fields the wave made nullable. `fundedAmount`
   * and `ownCapital` (with their paise twins on the Live Desk wire) are read on
   * four surfaces, and the wave-2L re-check found the silent shapes on three of
   * them: `p.fundedAmount <= 0` filed a row the journal never priced under
   * "user funded", `> 0` hid it from both, and `ownCapitalP` had no test at all,
   * so `toPaise(p.ownCapital ?? 0)` would have printed a STATED ₹0 on the desk
   * with nothing red anywhere (close-readers#1, #4).
   */
  it("open-position-funded / own-capital-null: no consumer collapses a null onto 0", () => {
    expect(hits("open-position-funded"), RULE["open-position-funded"].forbidden).toEqual([]);
    expect(hits("own-capital-null"), RULE["own-capital-null"].forbidden).toEqual([]);

    // NOT EMPTY-SATISFIABLE — the scanner is shown the class it is silent about.
    const bad = `interface P { isMtf: boolean; fundedAmount: number | null; ownCapital: number | null }
declare function toPaise(n: number): number;
export function reads(p: P, list: P[]) {
  const user = list.filter((x) => x.fundedAmount <= 0);
  const broker = list.filter((x) => x.fundedAmount > 0);
  const own = toPaise(p.ownCapital ?? 0);
  const total = list.reduce((s, x) => s + (x.fundedAmount ?? 0), 0);
  return [user, broker, own, total];
}`;
    const seen = scanSource("fixture-nullable-money.ts", bad, ["open-position-funded", "own-capital-null"]);
    expect(seen.map((v) => v.expr)).toEqual([
      // Sorted by line: the filter, the filter, the desk's paise read, the reduce.
      "x.fundedAmount <= 0",
      "x.fundedAmount > 0",
      "toPaise(p.ownCapital ?? 0)",
      "s + (x.fundedAmount ?? 0)",
    ]);
    expect(seen.filter((v) => v.rule === "own-capital-null")).toHaveLength(1);

    // …and the CORRECT reads the four surfaces actually use stay silent.
    const good = `interface P { isMtf: boolean; fundedAmount: number | null; ownCapital: number | null }
declare function toPaiseOrNull(n: number | null): number | null;
declare function statesOwnCapital(p: P): boolean;
export function reads(p: P, list: P[]) {
  const funded = p.fundedAmount;
  if (funded == null) return null;
  let sum = 0;
  for (const x of list) {
    const row = x.fundedAmount;
    if (row == null) continue;
    sum += row;
  }
  return { sum, own: statesOwnCapital(p) ? p.ownCapital : null, wire: toPaiseOrNull(p.ownCapital), fundedP: toPaiseOrNull(p.fundedAmount) };
}`;
    expect(scanSource("fixture-nullable-money-ok.ts", good, ["open-position-funded", "own-capital-null"])).toEqual([]);
  });

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
   * FINDING G-G3-1 (product, low→medium) — FIXED in v4.3.0 fix wave 2M, so this
   * is a plain `it` again: lib/queries/staged.ts:178 priced a staged MTF ladder
   * off a leg date that nothing validated.
   *
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
   * staged ladder was not taught it. Wave 2M moved `normalizeDate` / `isRealDay`
   * out of the server-only lib/import/commit.ts into the pure
   * lib/domain/trading-day.ts, so the ladder, the pure staged module and both
   * dialogs read ONE calendar.
   */
  it("risk-cap-resolver: no reader in lib/, app/ or components/ takes the per-trade cap off a risk_config row", () => {
    expect(hits("risk-cap-resolver"), RULE["risk-cap-resolver"].forbidden).toEqual([]);
  });

  it("raw-date: no day count is taken from an unresolved, unguarded date field", () => {
    expect(hits("raw-date"), RULE["raw-date"].forbidden).toEqual([]);
  });

  it("FINDING G-G3-1, fixed: the ladder prices through the shared calendar, and its writers refuse a day that does not exist", () => {
    // The scan's own answer, stated as the list it prints (empty, and it is the
    // FIX that empties it: the same rule reported this file at HEAD 8ff4288).
    expect(hits("raw-date")).toEqual([]);

    // The READ half — lib/queries/staged.ts resolves both ends of every tranche.
    // CODE only: the comment there still quotes the old expression, which is the
    // false positive the AST scan was built to avoid, so this text pin drops
    // comment lines rather than re-introducing it.
    const q = fs.readFileSync("lib/queries/staged.ts", "utf8");
    const code = q.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, "");
    expect(/const legDay = normalizeDate\(leg\.tradeDate\)/.test(code), "the leg date is resolved once").toBe(true);
    expect(/const endDay = normalizeDate\(end\)/.test(code), "the consuming end is resolved too").toBe(true);
    expect(/new Date\(leg\.tradeDate\)/.test(code), "the raw read is gone").toBe(false);
    expect(/from "@\/lib\/domain\/trading-day"/.test(code), "from the one calendar").toBe(true);

    // The WRITE half — the pure module refuses it, so all four writers do
    // (addLeg / updateLeg / rebuildStagedTrade / convertToStaged call it first),
    // and the leg actions already surface `problems[0].message` to the user.
    const bad = validateLegs([{ id: 1, kind: "entry", seq: 1, tradeDate: "2026-02-31", qty: 10, price: 100 }]);
    expect(bad.map((p) => p.message)).toEqual([
      "The entry date “2026-02-31” is not a real calendar day — enter it as a day that exists, for example 2026-06-15. Nothing was changed.",
    ]);
    expect(validateLegs([{ id: 1, kind: "entry", seq: 1, tradeDate: "31-08-2026", qty: 10, price: 100 }])).toEqual([]);

    const action = fs.readFileSync("app/trades/actions.ts", "utf8");
    expect(action).toContain('if (!tradeDate) return { ok: false, message: "Pick the date of this entry." };');
    expect(action).toContain("return { ok: res.ok, message: res.message };");
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
      "components/live/tracker-client.tsx",
      "components/trackers/tracker-client.tsx",
      "app/targets/equity/page.tsx",
      "app/equity/page.tsx",
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
    expect(REGISTRY.map((r) => r.id)).toEqual(["mtf-funded-0", "open-position-funded", "own-capital-null", "raw-date", "ipo-link-scope", "risk-cap-resolver"]);
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

// ---------------------------------------------------------------------------
// WAVE U (v4.5.0) — ONE DOOR INTO THE RATE CARD
// ---------------------------------------------------------------------------

/**
 * `findRates` takes a `plan` argument, and until v4.5.0 every call site outside
 * lib/engine/ passed none — so the argument existed, was correct, and priced
 * nothing. Wave U wired the account's plan into pricing, and did it by adding
 * ONE entry point, `ratesForTrade`, which is `findRates` plus the plan (and,
 * from wave 3a, the ETF STT overlay). Twelve call sites would eventually miss
 * one of those; one would not.
 *
 * So the door is guarded structurally: outside the engine itself, only
 * `lib/analytics/broker-compare.ts` may call `findRates` directly — that screen
 * exists to sweep EVERY (broker, plan) pair deliberately, which is the one job
 * `ratesForTrade`'s single-plan signature cannot do. Everything else in lib/,
 * app/ and components/ goes through `ratesForTrade`.
 *
 * AST, not grep, for the same reason the rest of this file is: a call written
 * `rates.findRates(...)`, split across lines, or quoted in a comment, is a
 * different thing to a line-based scan and the same thing to a parser.
 */
describe("wave U — findRates is called only inside the engine (and the comparison screen)", () => {
  /** Every call expression whose callee is named `findRates`, with its line. */
  const findRatesCalls = (file: string, src: string): { file: string; line: number; text: string }[] => {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const hits: { file: string; line: number; text: string }[] = [];
    const nameOf = (e: ts.Expression): string | null =>
      ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && nameOf(n.expression) === "findRates") {
        hits.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf).split("\n")[0].slice(0, 90) });
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return hits;
  };

  /** The two scopes allowed to hold one, stated structurally — nothing is allow-listed per file. */
  const allowed = (rel: string) => rel.startsWith("lib/engine/") || rel === "lib/analytics/broker-compare.ts";

  it("no call site outside lib/engine/ and lib/analytics/broker-compare.ts calls findRates", () => {
    const root = process.cwd();
    const offenders = listSourceFiles(["lib", "app", "components"])
      .map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join("/") }))
      .filter(({ rel }) => !allowed(rel))
      .flatMap(({ abs, rel }) => findRatesCalls(rel, fs.readFileSync(abs, "utf8")));
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.text}`), "use ratesForTrade(map, t, onDate, plan) instead").toEqual([]);
  });

  it("…and the scan can SEE one: the same walk over an inline call site reports it", () => {
    // A green scan is not evidence on its own (this file's own standing rule).
    const hits = findRatesCalls("lib/queries/made-up.ts", [
      "import { findRates } from '@/lib/engine/rates';",
      "export const price = (m: RatesMap) => findRates(m, 'upstox', 'eq_delivery', 'NSE', '2026-08-28');",
      "export const viaNs = (m: RatesMap) => rates.findRates(m, 'upstox', 'eq_mtf', 'NSE', '2026-08-28');",
      "// a COMMENT saying findRates(map, …) is not a call site",
    ].join("\n"));
    expect(hits.map((h) => h.line)).toEqual([2, 3]);
  });

  it("the two allowed scopes really do hold calls, so the rule is not vacuous", () => {
    const root = process.cwd();
    const inScope = listSourceFiles(["lib"])
      .map((abs) => ({ abs, rel: path.relative(root, abs).split(path.sep).join("/") }))
      .filter(({ rel }) => allowed(rel))
      .flatMap(({ abs, rel }) => findRatesCalls(rel, fs.readFileSync(abs, "utf8")));
    expect(inScope.some((h) => h.file === "lib/analytics/broker-compare.ts")).toBe(true);
    expect(inScope.some((h) => h.file.startsWith("lib/engine/"))).toBe(true);
  });
});
