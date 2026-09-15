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

export type RuleId = "mtf-funded-0" | "raw-date" | "ipo-link-scope";

export interface FieldRule {
  id: RuleId;
  /** The field (or link) the rule is about. */
  field: string;
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
    id: "raw-date",
    field: "exitDate / sellDate / buyDate",
    rule:
      "A RAW date string (a form field, a request body, a function parameter) must be RESOLVED before it is read as a day — " +
      "`normalizeDate` / `resolveExitIso` / `isRealDay` / a `Date.parse` validation — or guarded for emptiness where it is used.",
    forbidden: "`new Date(rawDateField)` with neither a resolver in its provenance nor an emptiness guard over it",
    allowed: "`new Date(exitIso)` after `resolveExitIso`, `new Date(t.buyDate)` under `if (!t.buyDate) return` or inside `t.buyDate ? … : 0`",
    triggers: ["new Date("],
    roots: ["lib", "app", "components"],
    provenance:
      "wave 2H new_defects[1] / wave 2I I1[1]: closePreviewBody took the holding period off the RAW exit field, " +
      "`new Date(\"\")` is Invalid Date, daysHeld went NaN, JSON sent it as null and the route billed 0 days of " +
      "MTF interest against a save that charged ₹205.15 of it.",
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

function scanFunded(sf: TS.SourceFile, file: string, field: string): Violation[] {
  const out: Violation[] = [];
  const { names, fns } = carriersOf(sf, field);
  walk(sf, (n) => {
    const isCarrier =
      isFieldRead(n, field) ||
      (ts.isIdentifier(n) && names.has(n.text) && !(n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n) && !(n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n)) ||
      (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && fns.has(n.expression.text));
    if (!isCarrier) return;
    // A binding pattern element declares the alias; it is not a read of it.
    if (n.parent && ts.isBindingElement(n.parent)) return;
    const why = fundedViolation(sf, n);
    if (why) out.push({ rule: "mtf-funded-0", file, line: lineOf(sf, n), expr: oneLine(sf, throughPassthrough(sf, n).parent ?? n), why });
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

function scanRawDate(sf: TS.SourceFile, file: string): Violation[] {
  const out: Violation[] = [];
  walk(sf, (n) => {
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
    if (r.id === "mtf-funded-0") out.push(...scanFunded(parse(), file, r.field));
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
