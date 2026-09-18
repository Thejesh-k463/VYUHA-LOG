/**
 * THE READ RULE FOR A FIELD, AND AN AST SCANNER THAT ENFORCES IT.
 *
 * WHY THIS EXISTS (v4.3.0, guard G3). Two fix waves in a row shipped a value
 * written in ONE file and read differently in ANOTHER:
 *
 *   - wave 2H taught every WRITER that a stored `mtfFundedAmount` of 0 is a
 *     stated amount (the position paid for in full), and FIVE readers went on
 *     treating it as "never set" — `t.mtfFundedAmount && t.mtfFundedAmount > 0`
 *     substituted the margin estimate, so /equity reported own capital against
 *     a denominator the journal never recorded (invariant 6);
 *   - wave 2I widened the guard that was supposed to catch them, but the guard
 *     was LINE-BASED: the wave-2I re-check listed three shapes of the same
 *     defect that would slip past it (a read split across lines, a destructured
 *     alias, a helper wrapping the field) and one shape that is not a defect at
 *     all but is reported as one (a COMMENT quoting the old code).
 *
 * A regex over lines cannot see an expression; a parser can. This module parses
 * each candidate file with the TypeScript compiler API that already ships in
 * node_modules (no new dependency — AGENTS.md forbids letting npm rewrite the
 * lock) and judges each read by its position in the SYNTAX TREE, so the three
 * missed shapes are caught and the comment is not.
 *
 * NOTHING IS ALLOW-LISTED. A rule that needs an exception is a rule that is
 * stated wrongly; each rule below therefore states its SCOPE structurally (what
 * counts as a read, what counts as a resolved date, which function is a
 * realised consumer) rather than naming files that may break it.
 *
 * The scanner takes TEXT, not only paths, so the same code that walks the tree
 * can be pointed at a `git show <sha>:<path>` copy — which is how the tests
 * prove it can actually SEE the class it guards, instead of asserting an empty
 * array that a broken scanner would also return.
 */
import { createRequire } from "node:module";
import type * as TS from "typescript";
import fs from "node:fs";
import path from "node:path";

/**
 * The compiler API that already ships in node_modules (no new dependency —
 * AGENTS.md forbids letting npm rewrite the lock). Loaded through
 * `createRequire` rather than `import ts from "typescript"` so Vite does not
 * put the 9 MB CJS bundle through its SSR transform: a plain import works, but
 * makes every run print "Failed to load source map for …/typescript.js" into
 * the gate's log, and a gate log that cries wolf is a gate nobody reads.
 */
const ts = createRequire(import.meta.url)("typescript") as typeof TS;

export type RuleId = "mtf-funded-0" | "open-position-funded" | "own-capital-null" | "raw-date" | "ipo-link-scope";

export interface FieldRule {
  id: RuleId;
  /** The field (or link) the rule is about. */
  field: string;
  /** Every property name that carries this same value, when one rule governs
   *  more than one (a rupee field and its paise twin on the wire). Defaults to
   *  `[field]`. */
  fields?: string[];
  /** One line: what the stored value MEANS, and therefore how it must be read. */
  rule: string;
  /** The shapes that break it. */
  forbidden: string;
  /** The shapes that satisfy it. */
  allowed: string;
  /** Cheap substring pre-filter: a file without one of these is never parsed. */
  triggers: string[];
  /** Roots this rule walks, relative to the repo root. */
  roots: string[];
  /** Where the class was measured. */
  provenance: string;
}

/**
 * THE REGISTRY — one entry per field whose NULL and whose ZERO mean different
 * things, or whose raw form must not be read directly.
 */
export const REGISTRY: FieldRule[] = [
  {
    id: "mtf-funded-0",
    field: "mtfFundedAmount",
    rule:
      "A STORED value is the truth, 0 included: 0 means the position was paid for in full out of own capital, " +
      "null means the journal never resolved what the broker funded. Only null may be estimated.",
    forbidden: "`&&`, `||`, `> 0` / `>= 0` / `< 0` / `<= 0`, `!x`, `x ? :`, `Boolean(x)`, `if (x)` — every one of them reads a stated 0 as unset",
    allowed: "`?? <estimate>`, `== null` / `!= null` / `=== null` / `!== null`, `Number.isFinite(x ?? NaN)`, an optional-property type, passing it on unchanged",
    triggers: ["mtfFundedAmount"],
    roots: ["lib", "app", "components"],
    provenance:
      "wave 2H new_defects[0] (silent wrong number on /equity) and wave 2I I1[2]; the five readers were " +
      "lib/analytics/positions.ts, app/reports/broker-compare/page.tsx, lib/analytics/data-quality.ts.",
  },
  {
    id: "open-position-funded",
    field: "fundedAmount",
    // `fundedP` is the same money on the Live Desk wire, in paise (invariant 1).
    fields: ["fundedAmount", "fundedP"],
    rule:
      "`OpenPosition.fundedAmount` (and its paise twin `fundedP`) is NULLABLE since v4.3.0 wave 2N: null means the " +
      "journal never recorded what the broker funded, and 0 means the broker funded none of it. Neither may be " +
      "collapsed onto the other, and null is never estimated on a screen.",
    forbidden: "`?? 0`, `&&`, `||`, `> 0` / `>= 0` / `< 0` / `<= 0`, `!x`, `x ? :`, `Boolean(x)`, `if (x)`",
    allowed: "`== null` / `!= null`, `toPaiseOrNull(x)`, `Number.isFinite(x ?? NaN)`, a null-checked local, passing it on unchanged",
    triggers: ["fundedAmount", "fundedP"],
    // The CONSUMER surfaces. lib/analytics/positions.ts is the writer — it is
    // where the null is decided, and its own `invested - funded` construction
    // and ROI denominator guard are not reads of someone else's value.
    //
    // `lib/queries` joined them in v4.3.0 wave 2O (D6): the staged ladder
    // (lib/queries/staged.ts) prices each entry tranche's `fundedAmount` from the
    // amount the parent row states, and it WRITES the result into stored money —
    // it was the fifth writer of `mtf_interest`, reading the nullable principal
    // under a rule no other writer used (it read none at all: it substituted a
    // margin-config estimate). A directory, not the one file, so the next query
    // that reads the field is scanned without anyone remembering to add it.
    roots: ["components/trackers", "components/live", "app/equity", "app/targets", "lib/queries"],
    provenance:
      "wave 2L re-check close-readers#1 and #4: `p.fundedAmount <= 0` filed an unpriced row under 'user funded', " +
      "`> 0` hid it from both, `toPaise(p.fundedAmount)` would print a STATED ₹0 on the desk for a row nobody " +
      "priced, and app/targets/equity/page.tsx summed the estimate into five figures.",
  },
  {
    id: "own-capital-null",
    field: "ownCapital",
    fields: ["ownCapital", "ownCapitalP"],
    rule:
      "`OpenPosition.ownCapital` (and `ownCapitalP`) is null unless the row is a plain held MTF buy leg with a " +
      "stated funded amount. A STATED 0 (the broker funded the whole position) is a figure; null is the absence " +
      "of one, disclosed with a count and a reason (invariant 6).",
    forbidden: "`?? 0`, `&&`, `||`, `> 0` / `>= 0` / `< 0` / `<= 0`, `!x`, `x ? :`, `Boolean(x)`, `if (x)`",
    allowed: "`== null` / `!= null`, `statesOwnCapital(p)`, `toPaiseOrNull(x)`, a null-checked local, passing it on unchanged",
    triggers: ["ownCapital", "ownCapitalP"],
    roots: ["components/trackers", "components/live", "app/equity", "app/targets"],
    provenance:
      "wave 2L re-check close-readers#4: `ownCapitalP` appeared in no test at all, so `toPaise(p.ownCapital ?? 0)` " +
      "would typecheck and make the desk print '₹0' for a leg that states none — and the per-row cell's extra " +
      "`(p.ownCapital ?? 0) > 0` printed '—' for a STATED 0 the KPI counted (close-readers#0).",
  },
  {
    id: "raw-date",
    field: "exitDate / sellDate / buyDate",
    rule:
      "A RAW date string (a form field, a request body, a function parameter) must be RESOLVED before it is read as a day — " +
      "`normalizeDate` / `resolveExitIso` / `isRealDay` / a `Date.parse` validation — or guarded for emptiness where it is used.",
    forbidden:
      "`new Date(rawDateField)` with neither a resolver in its provenance nor an emptiness guard over it; " +
      "a raw date field handed to a DAY COUNTER (`epochSpans`) with no resolver at all — it does not throw on a value it cannot read; " +
      "a writer that prices from the STORED date columns (`closePosition`, `applyOverride`, `updateManualTrade`, `closeStaleLot`) with no `storedDateProblem` refusal in it",
    allowed:
      "`new Date(exitIso)` after `resolveExitIso`, `new Date(t.buyDate)` under `if (!t.buyDate) return` or inside `t.buyDate ? … : 0`, " +
      "`epochSpans(…, buyIso, today)` after `normalizeDate`, and `if (storedDateProblem(t)) return …` before any pricing in the four writers",
    triggers: ["new Date(", "epochSpans(", "closePosition", "applyOverride", "updateManualTrade", "closeStaleLot"],
    roots: ["lib", "app", "components"],
    provenance:
      "wave 2H new_defects[1] / wave 2I I1[1]: closePreviewBody took the holding period off the RAW exit field, " +
      "`new Date(\"\")` is Invalid Date, daysHeld went NaN, JSON sent it as null and the route billed 0 days of " +
      "MTF interest against a save that charged ₹205.15 of it. Wave 2N ipo#1 added the DAY-COUNTER half: " +
      "`accrueMtfInterest` (lib/jobs/mtf-accrual.ts) handed `t.buyDate` raw to `epochSpans`, which does NOT throw — " +
      "measured '9999-99-99' → 0 days (the job zeroed the row's stored interest, charges and net) and " +
      "'2026-02-31' → 199 days / ₹636.80 billed from a day the row does not state. Wave 2O D17 added the " +
      "STORED-COLUMN half: `updateManualTrade` was the third writer the shared docstring counted and the only one " +
      "left raw — a price-only patch on a row storing '9999-99-99' took NaN into `computeCharges` and died with " +
      "`NOT NULL constraint failed: trades.charges_total_paise` (a 500, not an {ok:false}).",
  },
  {
    id: "ipo-link-scope",
    field: "ipos.tradeId",
    rule:
      "A REALISED consumer — one that decides whether an IPO's sale was already counted through a trade — reads the " +
      "ipos→trades LINK unscoped by account: `countedTradeIds` already carries the caller's view. An account equality " +
      "between the two tables splits the rule per view and the same sale is counted twice on All accounts.",
    forbidden: "`eq(trades.accountId, ipos.accountId)` (either order, or the raw SQL equivalent) inside a function that reads `countedTradeIds`",
    allowed: "the account scope on the IPO ROWS (`eq(ipos.accountId, accountId)`), and the scoped join in `getIposComputed`, which answers a different question (whose sale DATE a form may pre-fill)",
    triggers: ["countedTradeIds"],
    roots: ["lib/queries"],
    provenance:
      "wave 2I/2L 'one home for the counted-once rule with an unscoped link read'; the capital summary stated one " +
      "sale twice on All accounts while the tax pack, the ITR export and AIS stated it once.",
  },
];

export const RULE = Object.fromEntries(REGISTRY.map((r) => [r.id, r])) as Record<RuleId, FieldRule>;

export interface Violation {
  rule: RuleId;
  /** Repo-relative, forward slashes. */
  file: string;
  line: number;
  /** The offending EXPRESSION, one line, as the scanner saw it. */
  expr: string;
  /** Why this shape breaks the rule. */
  why: string;
}

/** `file:line <expression>` — the report line the operator reads. */
export function format(v: Violation): string {
  return `${v.file}:${v.line} ${v.expr}`;
}

// ---------------------------------------------------------------------------
// Parsing, with a cache (the walk parses a file at most once per text).
// ---------------------------------------------------------------------------

const parsedCache = new Map<string, { text: string; sf: TS.SourceFile }>();

export function parseCount(): number {
  return parsedCache.size;
}

function sourceFileFor(fileName: string, text: string): TS.SourceFile {
  const hit = parsedCache.get(fileName);
  if (hit && hit.text === text) return hit.sf;
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsedCache.set(fileName, { text, sf });
  return sf;
}

function walk(node: TS.Node, visit: (n: TS.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

function lineOf(sf: TS.SourceFile, node: TS.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function oneLine(sf: TS.SourceFile, node: TS.Node, cap = 160): string {
  const t = node.getText(sf).replace(/\s*\r?\n\s*/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap)}…` : t;
}

const isZero = (n: TS.Node): boolean => ts.isNumericLiteral(n) && Number(n.text) === 0;

// ---------------------------------------------------------------------------
// Rule 1 — mtfFundedAmount: a stored 0 is a stated amount.
// ---------------------------------------------------------------------------

/** `x.mtfFundedAmount` or `x["mtfFundedAmount"]` — a READ of the field itself. */
function isFieldRead(n: TS.Node, field: string): boolean {
  if (ts.isPropertyAccessExpression(n) && n.name.text === field) {
    // `mtfFundedAmount: t.mtfFundedAmount` on the LEFT of a property assignment
    // is a write target, not a read — but that shape is a PropertyAssignment
    // name, never a PropertyAccessExpression, so nothing to exclude here.
    return true;
  }
  return (
    ts.isElementAccessExpression(n) &&
    !!n.argumentExpression &&
    ts.isStringLiteralLike(n.argumentExpression) &&
    n.argumentExpression.text === field
  );
}

/**
 * Every expression in the file that CARRIES the raw field value:
 *   - the field read itself                       `t.mtfFundedAmount`
 *   - a local bound to one                        `const funded = t.mtfFundedAmount`
 *   - a destructured alias                        `const { mtfFundedAmount: funded } = t`
 *   - a call to a local helper that returns one   `fundedOf(t)`
 *
 * The last three are exactly the shapes the line-based scan could not see
 * (wave 2I re-check, "KNOWN BLIND SPOTS of the scan").
 */
function carriersOf(sf: TS.SourceFile, field: string): { names: Set<string>; fns: Set<string> } {
  const names = new Set<string>();
  const fns = new Set<string>();

  const carries = (e: TS.Node | undefined): boolean => {
    if (!e) return false;
    if (isFieldRead(e, field)) return true;
    if (ts.isIdentifier(e)) return names.has(e.text);
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return carries(e.expression);
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return fns.has(e.expression.text);
    return false;
  };

  /** The expression a function body hands back, when it hands back exactly one. */
  const returned = (body: TS.Node | undefined): TS.Node | undefined => {
    if (!body) return undefined;
    if (!ts.isBlock(body)) return body; // concise arrow body
    const rets = body.statements.filter(ts.isReturnStatement);
    return rets.length === 1 ? rets[0].expression : undefined;
  };

  // Two passes: a helper may be declared after the local it reads, and a local
  // may be bound from a helper declared later in the file.
  for (let pass = 0; pass < 2; pass++) {
    walk(sf, (n) => {
      if (ts.isVariableDeclaration(n)) {
        if (ts.isIdentifier(n.name) && carries(n.initializer)) names.add(n.name.text);
        if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
            if (prop === field && ts.isIdentifier(el.name)) names.add(el.name.text);
          }
        }
        // `const fundedOf = (t) => t.mtfFundedAmount`
        if (ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
          if (carries(returned(n.initializer.body))) fns.add(n.name.text);
        }
      }
      if (ts.isFunctionDeclaration(n) && n.name && carries(returned(n.body))) fns.add(n.name.text);
    });
  }
  return { names, fns };
}

/** Shapes the compiler sees THROUGH: they hand the same null-vs-0 question on. */
function throughPassthrough(sf: TS.SourceFile, start: TS.Node): TS.Node {
  let cur: TS.Node = start;
  for (;;) {
    const p = cur.parent;
    if (!p) return cur;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)) {
      cur = p;
      continue;
    }
    // `Number(x)` — the line scan's blind spot (b): the call parens broke its regex.
    if (ts.isCallExpression(p) && p.expression.getText(sf) === "Number" && p.arguments[0] === cur) {
      cur = p;
      continue;
    }
    // `x ?? 0` — blind spot (c): the nullish default COLLAPSES null onto the
    // stated 0, so a later `> 0` cannot tell them apart. `?? <estimate>` (a call
    // or any other expression) is the CORRECT read and stops the chain here.
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && p.left === cur && isZero(p.right)) {
      cur = p;
      continue;
    }
    return cur;
  }
}

/** The rule broken by this read's position in the tree, or null. */
function fundedViolation(sf: TS.SourceFile, read: TS.Node): string | null {
  const node = throughPassthrough(sf, read);
  const p = node.parent;
  if (!p) return null;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      return "truthiness: a stated 0 is falsy, so this reads a position paid for in full as one nobody priced";
    }
    const cmp = [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken];
    if (cmp.includes(op) && (isZero(p.right) || isZero(p.left))) {
      return "compared against 0: null and a stated 0 answer this the same way";
    }
  }
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) {
    return "negated: `!0` is true, so a stated 0 reads as never set";
  }
  if (ts.isConditionalExpression(p) && p.condition === node) {
    return "truthiness ternary: a stated 0 takes the 'never set' branch";
  }
  if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === node) {
    return "used as a condition: a stated 0 is falsy";
  }
  if (ts.isCallExpression(p) && p.expression.getText(sf) === "Boolean" && p.arguments[0] === node) {
    return "Boolean(): a stated 0 becomes false";
  }
  return null;
}

/**
 * `x ?? 0` where the 0 is NOT an estimate but a silent fill-in.
 *
 * For `mtfFundedAmount` the nullish default is a legitimate read (`?? <estimate>`)
 * and only what SITS ON TOP of it can break the rule. For the two fields wave 2N
 * made nullable it is the defect itself: `toPaise(p.ownCapital ?? 0)` prints a
 * STATED ₹0 for a leg that states none, and nothing goes red.
 */
function collapsesNullOntoZero(sf: TS.SourceFile, read: TS.Node): boolean {
  // The same walk `throughPassthrough` makes, stopping AT the `?? 0` step
  // instead of walking through it — `s + (x.fundedAmount ?? 0)` wraps the
  // nullish default in parentheses, so looking only at the end of the chain
  // misses exactly the shape a reduce uses.
  let cur: TS.Node = read;
  for (;;) {
    const p: TS.Node | undefined = cur.parent;
    if (!p) return false;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)) {
      cur = p;
      continue;
    }
    if (ts.isCallExpression(p) && p.expression.getText(sf) === "Number" && p.arguments[0] === cur) {
      cur = p;
      continue;
    }
    return (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      p.left === cur &&
      isZero(p.right)
    );
  }
}

function scanFunded(sf: TS.SourceFile, file: string, field: string, rule: RuleId = "mtf-funded-0"): Violation[] {
  const out: Violation[] = [];
  const nullishZeroForbidden = rule !== "mtf-funded-0";
  const { names, fns } = carriersOf(sf, field);
  walk(sf, (n) => {
    const isCarrier =
      isFieldRead(n, field) ||
      (ts.isIdentifier(n) && names.has(n.text) && !(n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n) && !(n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n)) ||
      (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && fns.has(n.expression.text));
    if (!isCarrier) return;
    // A binding pattern element declares the alias; it is not a read of it.
    if (n.parent && ts.isBindingElement(n.parent)) return;
    const why =
      fundedViolation(sf, n) ??
      (nullishZeroForbidden && collapsesNullOntoZero(sf, n)
        ? "`?? 0` fills in a figure the journal does not state: null (never recorded) and a stated 0 become the same number"
        : null);
    if (why) out.push({ rule, file, line: lineOf(sf, n), expr: oneLine(sf, throughPassthrough(sf, n).parent ?? n), why });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Rule 2 — a raw date string must be resolved, or guarded, before `new Date`.
// ---------------------------------------------------------------------------

/** Names that hold a date the user (or a broker file) TYPED, before resolution. */
const RAW_DATE_NAMES = /^(exitDate|sellDate|buyDate|tradeDate|orderDate|allotmentDate|listingDate|appliedDate)$/;

/** Calls that turn a raw date into a real day (or refuse it). */
const RESOLVERS = /\b(normalizeDate|resolveExitIso|isRealDay|isPriceableExitDate|Date\.parse|todayIstIso|toLocaleDateString|pricingDate)\b/;

/** The name at the end of an expression: `t.sellDate` → sellDate, `exitDate` → exitDate. */
function trailingName(e: TS.Node): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return trailingName(e.expression);
  // `sellDate + "T00:00:00"` — the day is the left operand.
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return trailingName(e.left);
  return null;
}

/** The expression text a guard must mention: `t.sellDate`, `f.buyDate`, `exitDate`. */
function guardKey(sf: TS.SourceFile, e: TS.Node): string {
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return guardKey(sf, e.left);
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return guardKey(sf, e.expression);
  return e.getText(sf).trim();
}

/** Is `name` a local whose initializer already resolved it? */
function resolvedLocally(sf: TS.SourceFile, name: string): boolean {
  let resolved = false;
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== name || !n.initializer) return;
    if (RESOLVERS.test(n.initializer.getText(sf))) resolved = true;
  });
  return resolved;
}

/**
 * Is the read covered by an emptiness guard — the shape every correct day count
 * in this tree uses (`if (!buyDate || !sellDate) return 1;`, `t.buyDate ? … : 0`)?
 */
function guarded(sf: TS.SourceFile, node: TS.Node, key: string): boolean {
  const mentions = (cond: TS.Node) => cond.getText(sf).includes(key);
  let cur: TS.Node | undefined = node;
  const start = node.getStart(sf);
  while (cur) {
    const p: TS.Node | undefined = cur.parent;
    if (!p) break;
    // `cond ? <here> : …`
    if (ts.isConditionalExpression(p) && (p.whenTrue === cur || p.whenFalse === cur) && mentions(p.condition)) return true;
    // `if (cond) { <here> }`
    if (ts.isIfStatement(p) && p.thenStatement === cur && mentions(p.expression)) return true;
    // `cond && <here>`
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === cur && mentions(p.left)) return true;
    // An earlier `if (!x) return/continue/throw` in an enclosing block.
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isCaseClause(p)) {
      for (const st of (p as TS.Block).statements ?? []) {
        if (st.getEnd() > start) break;
        if (!ts.isIfStatement(st)) continue;
        const bails = /\b(return|continue|break|throw)\b/.test(st.thenStatement.getText(sf));
        if (bails && mentions(st.expression)) return true;
      }
    }
    cur = p;
  }
  return false;
}

/**
 * Calls that COUNT DAYS from the string they are handed. Unlike `new Date`, they
 * do not fail loudly on a value they cannot read — `epochSpans` → `daysBetween`
 * (lib/engine/rates.ts) answers 0 — so an emptiness guard is not enough for them:
 * the argument must have been RESOLVED (wave 2N, ipo#1).
 */
const DAY_COUNTERS = /^(epochSpans)$/;

/**
 * The writers that price from the STORED date COLUMNS — a patch may omit a date,
 * and then the row's own value decides the day count and the rate epoch.
 *
 * Their `new Date(...)` reads a LOCAL whose initializer mentions a resolver
 * (`fields.buyDate !== undefined ? normalizeDate(fields.buyDate) : t.buyDate`),
 * so `resolvedLocally` above clears it and the unresolved STORED half is
 * invisible to every expression rule in this scanner. The only readable rule is
 * therefore the one the tree already states: such a writer refuses the row
 * through the ONE shared helper (`storedDateProblem`, lib/domain/trading-day)
 * before it prices anything.
 *
 * D17 (v4.3.0 wave 2O, dates-charges#4) added the third name: `closePosition`
 * and `applyOverride` were fixed in wave 2N while `updateManualTrade` — which
 * the same docstring counted — took NaN into `computeCharges` for a stored
 * '9999-99-99' and died with `NOT NULL constraint failed:
 * trades.charges_total_paise`.
 *
 * The v4.4.0 fix list added the fourth: `closeStaleLot` (the Data Quality
 * one-click close) prices from the LOT's stored buy date, and joined a lot stored
 * as '2026-02-31' at 0 days of MTF interest — wave 2P's recorded finding.
 */
const STORED_DATE_WRITERS = /^(closePosition|applyOverride|updateManualTrade|closeStaleLot)$/;

function scanRawDate(sf: TS.SourceFile, file: string): Violation[] {
  const out: Violation[] = [];
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && STORED_DATE_WRITERS.test(n.name.text) && n.body) {
      if (!/\bstoredDateProblem\b/.test(n.body.getText(sf))) {
        out.push({
          rule: "raw-date",
          file,
          line: lineOf(sf, n),
          expr: `function ${n.name.text}(…)`,
          why:
            `\`${n.name.text}\` prices from the trade's STORED buy/sell date when the patch omits it, and never asks ` +
            "`storedDateProblem` whether the row states a day — an unreadable stored value is an Invalid Date, and the NaN " +
            "day count dies on the charge write instead of refusing",
        });
      }
    }
    if (ts.isCallExpression(n) && DAY_COUNTERS.test(trailingName(n.expression) ?? "")) {
      for (const arg of n.arguments) {
        const name = trailingName(arg);
        if (!name || !RAW_DATE_NAMES.test(name)) continue;
        if (RESOLVERS.test(arg.getText(sf))) continue;
        if (ts.isIdentifier(arg) && resolvedLocally(sf, arg.text)) continue;
        out.push({
          rule: "raw-date",
          file,
          line: lineOf(sf, n),
          expr: oneLine(sf, arg),
          why: `a raw \`${name}\` is counted from by ${trailingName(n.expression)}, which answers 0 days for a value it cannot read rather than refusing — the row's stored interest, charges and net then move to a figure nothing states`,
        });
      }
    }
    if (!ts.isNewExpression(n) || n.expression.getText(sf) !== "Date") return;
    const arg = n.arguments?.[0];
    if (!arg || n.arguments!.length !== 1) return; // `new Date(Date.UTC(y, m, d))` takes the parts, not a string
    const name = trailingName(arg);
    if (!name || !RAW_DATE_NAMES.test(name)) return;
    if (RESOLVERS.test(arg.getText(sf))) return;
    if (ts.isIdentifier(arg) && resolvedLocally(sf, arg.text)) return;
    if (guarded(sf, n, guardKey(sf, arg))) return;
    out.push({
      rule: "raw-date",
      file,
      line: lineOf(sf, n),
      expr: oneLine(sf, n),
      why: `a raw \`${name}\` reaches new Date() unresolved and unguarded: "" or an unreadable value is an Invalid Date, and the NaN it produces is sent as null`,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Rule 3 — the counted-once link is read unscoped by account.
// ---------------------------------------------------------------------------

const ACCOUNT_EQ = [/\btrades\.accountId\b/, /\bipos\.accountId\b/];

/**
 * `eq(trades.accountId, ipos.accountId)` in either order, or the SQL
 * equivalent. The SQL half matches an aliased join too (`t.account_id =
 * i.account_id`): inside a counted-once consumer, ANY account equality between
 * the two sides is the defect, whatever the tables are called.
 */
function joinsOnAccount(text: string): boolean {
  if (/(?:\b\w+\.)?account_id\s*=\s*(?:\b\w+\.)?account_id/.test(text)) return true;
  for (const m of text.matchAll(/\beq\(([^()]*)\)/g)) {
    const inner = m[1];
    if (ACCOUNT_EQ.every((re) => re.test(inner))) return true;
  }
  return false;
}

/**
 * The SCOPE is structural, not a file list: a function is a realised consumer
 * when it reads `countedTradeIds` — the set of trade ids the caller already
 * counted. `getIposComputed` does not, which is why its deliberately
 * account-scoped join (whose sale DATE a form may pre-fill) is not in scope and
 * needs no exception.
 */
function scanIpoLink(sf: TS.SourceFile, file: string): Violation[] {
  const out: Violation[] = [];
  walk(sf, (n) => {
    const isFn = ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);
    if (!isFn) return;
    const text = n.getText(sf);
    if (!/\bcountedTradeIds\b/.test(text)) return;
    if (!joinsOnAccount(text)) return;
    out.push({
      rule: "ipo-link-scope",
      file,
      line: lineOf(sf, n),
      expr: oneLine(sf, n, 120),
      why: "a realised consumer scoped the ipos→trades LINK by account: the same sale is then counted twice on All accounts",
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan one source TEXT. `fileName` is only a label (and decides TS vs TSX), so
 * a `git show <sha>:<path>` copy or an inline fixture scans exactly like a file
 * on disk — which is what lets the tests prove the scanner can see the class.
 */
export function scanSource(fileName: string, text: string, only?: RuleId[]): Violation[] {
  const want = (id: RuleId) => !only || only.includes(id);
  const out: Violation[] = [];
  const file = fileName.replace(/\\/g, "/");
  let sf: TS.SourceFile | null = null;
  const parse = () => (sf ??= sourceFileFor(fileName, text));
  for (const r of REGISTRY) {
    if (!want(r.id)) continue;
    if (!r.triggers.some((t) => text.includes(t))) continue;
    // The three null-vs-0 money rules share ONE scanner; each states its own
    // fields and its own roots.
    if (r.id === "mtf-funded-0" || r.id === "open-position-funded" || r.id === "own-capital-null") {
      for (const f of r.fields ?? [r.field]) out.push(...scanFunded(parse(), file, f, r.id));
    }
    if (r.id === "raw-date") out.push(...scanRawDate(parse(), file));
    if (r.id === "ipo-link-scope") out.push(...scanIpoLink(parse(), file));
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Every .ts/.tsx under `roots`, skipping tests and node_modules. */
export function listSourceFiles(roots: string[], cwd = process.cwd()): string[] {
  const out: string[] = [];
  const walkDir = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next" || e.name === "tests") continue;
        walkDir(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  for (const r of roots) walkDir(path.join(cwd, r));
  // A root nested inside another (lib/queries under lib) must not yield the
  // same file twice.
  return [...new Set(out)].sort();
}

export interface ScanReport {
  violations: Violation[];
  /** Files whose text was read. */
  filesRead: number;
  /** Files actually handed to the parser (a trigger matched). */
  filesParsed: number;
  ms: number;
}

/** Walk the tree named by the registry and apply every rule. */
export function scanTree(only?: RuleId[], cwd = process.cwd()): ScanReport {
  const t0 = performance.now();
  const rules = REGISTRY.filter((r) => !only || only.includes(r.id));
  const roots = [...new Set(rules.flatMap((r) => r.roots))];
  const files = listSourceFiles(roots, cwd);
  const violations: Violation[] = [];
  let parsedFiles = 0;
  for (const abs of files) {
    const text = fs.readFileSync(abs, "utf8");
    const rel = path.relative(cwd, abs).replace(/\\/g, "/");
    const applicable = rules.filter((r) => r.roots.some((root) => rel.startsWith(`${root}/`)) && r.triggers.some((t) => text.includes(t)));
    if (applicable.length === 0) continue;
    parsedFiles++;
    violations.push(...scanSource(rel, text, applicable.map((r) => r.id)));
  }
  return { violations, filesRead: files.length, filesParsed: parsedFiles, ms: performance.now() - t0 };
}
