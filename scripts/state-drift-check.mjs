#!/usr/bin/env node
/**
 * END-OF-SESSION DRIFT CHECK — re-derives every FACT the hand-off documents
 * claim from the tree itself, and prints PASS/FAIL/SKIP with BOTH values.
 *
 * Why this exists (owner, 2026-09-22): prose rules decay, executable ones do
 * not. README carried "9745 tests" in six places while the suite had moved to
 * 10,798 — guarded only for self-agreement, because tests/readme-claims.test.ts
 * checks the six figures against EACH OTHER. That is a check agreeing with
 * itself. Every check here reads its two sides from DIFFERENT sources: a doc
 * claim on one side, the tree / git / package.json (or a DIFFERENT doc) on the
 * other.
 *
 * Rules this file obeys:
 *   1. Never doc-vs-same-doc.
 *   2. BLOCK only on facts — a check that cannot derive its actual value
 *      prints SKIP with the reason, never PASS.
 *   3. One short line per check, then one summary line; exit 1 on any FAIL.
 *   4. Pure node ESM, no dependency (node:fs, node:path, node:child_process
 *      for git only).
 *
 * Two modes:
 *   node scripts/state-drift-check.mjs             STRUCTURAL — must hold at
 *      any commit; tests/state-drift.test.ts runs this in CI.
 *   node scripts/state-drift-check.mjs --close-out ALL checks, including the
 *      ones that legitimately lag mid-wave (suite counts vs STATE §0, shas,
 *      freshness). Run before /clear.
 *
 * WHEN A CHECK GOES RED, FIX THE DOC — NEVER THE CHECK.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const closeOut = process.argv.includes("--close-out");

const results = [];
const add = (status, name, claimed, actual, where) =>
  results.push({ status, name, claimed: String(claimed), actual: String(actual), where });
const pass = (n, c, a, w) => add("PASS", n, c, a, w);
const fail = (n, c, a, w) => add("FAIL", n, c, a, w);
const skip = (n, reason, w = "-") => add("SKIP", n, "-", reason, w);
const eq = (n, c, a, w) => (String(c) === String(a) ? pass(n, c, a, w) : fail(n, c, a, w));
/** Compare the VALUES, print the LABELS (so a label can name its source). */
const cmp = (n, cv, av, cl, al, w) => (String(cv) === String(av) ? pass(n, cl, al, w) : fail(n, cl, al, w));

const t = (s, n = 64) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (s) => Number(String(s ?? "").replace(/,/g, ""));

function doc(rel) {
  const abs = path.resolve(root, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf8");
}
/** 1-based line number of a character offset, for the `file:line` citation. */
function lineAt(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length;
}
function findLine(rel, text, re) {
  const m = re.exec(text);
  return m ? `${rel}:${lineAt(text, m.index)}` : rel;
}
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitOk(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}
function walk(dir, test, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, base, out);
    else if (test(e.name)) out.push(path.relative(base, p));
  }
  return out;
}

// ── the documents ───────────────────────────────────────────────────────────
const agents = doc("AGENTS.md");
const readme = doc("README.md");
const stateFull = doc("VYUHA-STATE.md");
const answersRel = "../LIVE-DESK-RESEARCH/06-ANSWERS.md";
const answers = doc(answersRel);
const sessionPrompt = doc("docs/SESSION_PROMPT.md");
const decisions = doc("docs/DECISIONS.md");

/** STATE §0 ONLY — from `## §0 START HERE` to the next `## 1.`. History
 *  sections below it are a RECORD and are deliberately exempt. */
let state0 = "";
let state0Line = 0;
if (stateFull) {
  const start = stateFull.search(/^## §0 START HERE/m);
  if (start >= 0) {
    const rest = stateFull.slice(start);
    const end = rest.search(/^## 1\./m);
    state0 = end > 0 ? rest.slice(0, end) : rest;
    state0Line = lineAt(stateFull, start);
  }
}
/** The CURRENT session log = the highest-numbered `NN-VNNN-BUILD/SESSION-LOG.md` that STATE §0 names. It was a
 *  hard-coded `21-V450-BUILD` path, which went stale the day v4.6.0 opened `22-V460-BUILD` (LEDGER L-5's class). */
const sessionLogFolder = [...state0.matchAll(/(\d{2}-V\d{3,}-BUILD)\/SESSION-LOG\.md/g)].map((m) => m[1]).sort().at(-1);
const sessionLogRel = sessionLogFolder ? `../LIVE-DESK-RESEARCH/${sessionLogFolder}/SESSION-LOG.md` : "a SESSION-LOG.md named in STATE §0";
const sessionLog = sessionLogFolder ? doc(sessionLogRel) : null;
const s0cite = (re) => {
  const m = re.exec(state0);
  return m ? `VYUHA-STATE.md:${state0Line + state0.slice(0, m.index).split(/\r?\n/).length - 1}` : "VYUHA-STATE.md §0";
};

// ── a. version sync ─────────────────────────────────────────────────────────
{
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const tauri = doc("src-tauri/tauri.conf.json");
  const cargo = doc("src-tauri/Cargo.toml");
  const tv = tauri ? JSON.parse(tauri).version : null;
  const cv = cargo ? /^\s*version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] : null;
  if (!tv || !cv) skip("version-sync", "tauri.conf.json or Cargo.toml unreadable", "src-tauri/");
  else if (tv === pkg.version && cv === pkg.version)
    pass("version-sync", `pkg ${pkg.version}`, `tauri ${tv} / cargo ${cv}`, "package.json vs src-tauri/{tauri.conf.json,Cargo.toml}");
  else fail("version-sync", `pkg ${pkg.version}`, `tauri ${tv} / cargo ${cv}`, "package.json vs src-tauri/{tauri.conf.json,Cargo.toml}");

  const sidebar = doc("components/layout/sidebar.tsx");
  if (!sidebar) skip("sidebar-footer", "components/layout/sidebar.tsx absent");
  else {
    const m = /Vyuha Desktop[^v\n]*v(\d+\.\d+)(?!\.\d)/.exec(sidebar);
    if (!m) skip("sidebar-footer", "no `Vyuha Desktop · vX.Y` footer string found", "components/layout/sidebar.tsx");
    else {
      const minor = pkg.version.split(".").slice(0, 2).join(".");
      eq("sidebar-footer", m[1], minor, `components/layout/sidebar.tsx:${lineAt(sidebar, m.index)}`);
    }
  }
}

// ── b. migrations ───────────────────────────────────────────────────────────
let diskMigration = null;
{
  const sqls = existsSync(path.join(root, "drizzle"))
    ? readdirSync(path.join(root, "drizzle")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    : [];
  diskMigration = sqls.length ? sqls[sqls.length - 1].slice(0, 4) : null;
  const journalRaw = doc("drizzle/meta/_journal.json");
  if (!diskMigration || !journalRaw) skip("migration-journal", "no drizzle/*.sql or meta/_journal.json", "drizzle/");
  else {
    const j = JSON.parse(journalRaw);
    const last = j.entries?.[j.entries.length - 1];
    eq("migration-journal", String(last?.tag ?? "?").slice(0, 4), diskMigration, "drizzle/meta/_journal.json (journal) vs drizzle/*.sql (disk)");
  }
  if (closeOut) {
    const m = /migration \*\*(\d{4})\*\*/.exec(state0) || /migration\D{0,14}(\d{4})/i.exec(state0);
    if (!m) skip("migration-vs-state", "STATE §0 names no migration number", "VYUHA-STATE.md §0");
    else if (!diskMigration) skip("migration-vs-state", "no drizzle/*.sql on disk", "drizzle/");
    else eq("migration-vs-state", m[1], diskMigration, s0cite(/migration \*\*(\d{4})\*\*/));
  }
}

// ── c. cited paths exist ────────────────────────────────────────────────────
const PATH_RE = /^(app|lib|components|scripts|tests|e2e|drizzle|docs)\/[\w./-]+\.(ts|tsx|mjs|js|json|sql|md)$/;
const citedSources = [
  ["AGENTS.md", agents],
  ["README.md", readme],
  ["VYUHA-STATE.md §0", state0],
];
/** A path a doc says will be WRITTEN (a plan, not a claim about the tree) is
 *  not drift. STATE §0's "What is NOT built" names next session's files. */
const PLANNED_RE = /\bwrites?\b|\bwill (?:write|add|create)\b|NOT built|\bowed\b/i;
const plannedPaths = [];
{
  const missing = [];
  let counted = 0;
  for (const [label, text] of citedSources) {
    if (!text) continue;
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const token = m[1].replace(/:\d+(,\d+)*$/, "");
      if (!PATH_RE.test(token)) continue;
      counted++;
      if (existsSync(path.join(root, token))) continue;
      const rel = label.startsWith("VYUHA") ? state0Line + text.slice(0, m.index).split(/\r?\n/).length - 1 : lineAt(text, m.index);
      const line = text.split(/\r?\n/)[(label.startsWith("VYUHA") ? text.slice(0, m.index).split(/\r?\n/).length : lineAt(text, m.index)) - 1] ?? "";
      const cite = `${token} (${label.split(" ")[0]}:${rel})`;
      if (PLANNED_RE.test(line)) plannedPaths.push(cite);
      else missing.push(cite);
    }
  }
  const where = "AGENTS.md + README.md + STATE §0";
  if (!missing.length) pass("cited-paths", `${counted} backticked paths`, `all exist on disk (${plannedPaths.length} planned, not yet written)`, where);
  else fail("cited-paths", `${counted} cited`, `${missing.length} MISSING: ${t(missing.join("; "), 120)}`, where);
  if (plannedPaths.length) skip("planned-paths", `not on disk BY DESIGN (the citing line says it is to be written): ${t(plannedPaths.join("; "), 90)}`, where);
}

// ── d. npm scripts cited exist ──────────────────────────────────────────────
{
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const keys = new Set(Object.keys(pkg.scripts ?? {}));
  const srcs = [...citedSources, ["docs/SESSION_PROMPT.md", sessionPrompt]];
  const bad = new Set();
  let counted = 0;
  for (const [label, text] of srcs) {
    if (!text) continue;
    for (const m of text.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      counted++;
      if (!keys.has(m[1])) bad.add(`${m[1]} (${label.split(" ")[0]})`);
    }
  }
  if (!bad.size) pass("cited-npm-scripts", `${counted} \`npm run\` citations`, "all are package.json keys", "AGENTS/README/STATE §0/SESSION_PROMPT");
  else fail("cited-npm-scripts", `${counted} cited`, `unknown: ${t([...bad].join(", "), 110)}`, "AGENTS/README/STATE §0/SESSION_PROMPT");
}

// ── e + j. cited test files / the named doc guards ──────────────────────────
{
  const names = new Set();
  for (const [, text] of citedSources) {
    if (!text) continue;
    for (const m of text.matchAll(/`((?:tests|e2e)\/[\w./-]+\.(?:test|spec)\.ts)`/g)) names.add(m[1]);
  }
  const planned = new Set(plannedPaths.map((c) => c.split(" ")[0]));
  const missing = [...names].filter((f) => !existsSync(path.join(root, f)) && !planned.has(f));
  if (!missing.length)
    pass("cited-test-files", `${names.size} test/spec files named in the docs`, "all exist (subset of cited-paths)", "AGENTS.md + README.md + STATE §0");
  else fail("cited-test-files", `${names.size} named`, `missing: ${t(missing.join(", "), 110)}`, "AGENTS.md + README.md + STATE §0");

  // j — the guards AGENTS.md's "Verify" + "Invariant guards" sections name.
  const guardBlock = agents
    ? (agents.match(/# Verify with[\s\S]*?(?=\n# )/)?.[0] ?? "") +
      (agents.match(/## Invariant guards[\s\S]*?(?=\n# |\n## )/)?.[0] ?? "") +
      (agents.match(/# Testing[\s\S]*?(?=\n# )/)?.[0] ?? "")
    : "";
  const guards = [...new Set([...guardBlock.matchAll(/`(tests\/[\w./-]+\.test\.ts)`/g)].map((m) => m[1]))];
  const guardMissing = guards.filter((f) => !existsSync(path.join(root, f)));
  if (!guards.length) skip("doc-guard-tests", "AGENTS.md names no guard test files in its Verify/Testing/Invariant sections", "AGENTS.md");
  else if (!guardMissing.length) pass("doc-guard-tests", `${guards.length} guards named`, "all exist on disk", "AGENTS.md Verify/Testing/Invariant guards");
  else fail("doc-guard-tests", `${guards.length} named`, `missing: ${guardMissing.join(", ")}`, "AGENTS.md Verify/Testing/Invariant guards");
}

// ── A. README's ITR item codes vs the code's own (form, AY) table ───────────
// README prose on one side, `lib/analytics/itr-cg-codes.ts`'s TABLE on the
// other. README carried "A3 … B4" — the pre-wave-3b-i codes — for a release
// whose whole point was that A3 is an ITR-3 row and 112A is AY-keyed.
{
  const codesRel = "lib/analytics/itr-cg-codes.ts";
  const codes = doc(codesRel);
  const row = codes ? /"ITR-2\|2025-26":\s*\{\s*stcg111A:\s*"([A-Z]\d)",\s*ltcg112A:\s*"([A-Z]\d)"/.exec(codes) : null;
  const rStcg = readme ? /A([23]) for STCG u\/s 111A/.exec(readme) : null;
  const rLtcg = readme ? /B([34]) for LTCG u\/s 112A/.exec(readme) : null;
  if (!row) skip("itr-codes-vs-readme", `${codesRel} has no parsable \`"ITR-2|2025-26"\` row`, codesRel);
  else if (!rStcg || !rLtcg) skip("itr-codes-vs-readme", "README states no `A? for STCG u/s 111A` / `B? for LTCG u/s 112A` pair", "README.md");
  else
    cmp(
      "itr-codes-vs-readme",
      `A${rStcg[1]}/B${rLtcg[1]}`,
      `${row[1]}/${row[2]}`,
      `README A${rStcg[1]} 111A + B${rLtcg[1]} 112A`,
      `${codesRel} ITR-2|2025-26 ${row[1]}/${row[2]}`,
      `README.md:${lineAt(readme, rStcg.index)} vs ${codesRel}:${lineAt(codes, row.index)}`,
    );
}

// ── B. STATE §0's claims ABOUT README, counted in README's own bytes ────────
// "README says "9745 tests" in 6 places" stayed in §0 after README was fixed.
{
  const m = /README says "(\d[\d,]*)([^"]*)" in (\d+) places/.exec(state0);
  if (!m) skip("state-claims-about-readme", "STATE §0 makes no `README says \"N …\" in K places` claim", "VYUHA-STATE.md §0");
  else if (!readme) skip("state-claims-about-readme", "README.md unreadable", "README.md");
  else {
    const needle = m[1];
    const hits = readme.split(needle).length - 1;
    cmp(
      "state-claims-about-readme",
      num(m[3]),
      hits,
      `STATE §0: "${needle}" in ${m[3]} places`,
      `${hits} occurrences in README.md`,
      s0cite(/README says "(\d[\d,]*)([^"]*)" in (\d+) places/),
    );
  }
}

// ── f. counts vs disk (close-out) ───────────────────────────────────────────
if (closeOut) {
  // readme-claims.test.ts's glob logic, reused verbatim in spirit: RECURSIVE
  // tests/**/*.test.ts, because vitest's include is recursive.
  const diskTestFiles = readdirSync(path.join(root, "tests"), { recursive: true }).filter((f) => String(f).endsWith(".test.ts")).length;
  const diskSpecs = readdirSync(path.join(root, "e2e")).filter((f) => f.endsWith(".spec.ts")).length;

  const sFiles = /(\d[\d,]*) files \/ ([\d,]+) passed \/ (\d+) skipped/.exec(state0);
  // STATE §0 quotes a RAW gate line AT A SHA ("Gate on `185ac15`: 467 files
  // …"), so the honest counterpart is that commit's tree, not the working
  // tree — otherwise adding a test file mid-wave reddens a line that was true
  // when it was written. Without a sha, fall back to the working tree.
  const gateSha = /Gate on `([0-9a-f]{7,40})`[^\n]{0,20}?\d[\d,]* files/.exec(state0)?.[1];
  let stateSide = diskTestFiles;
  let stateSideLabel = `${diskTestFiles} tests/**/*.test.ts in the working tree`;
  if (gateSha && gitOk(["cat-file", "-e", `${gateSha}^{commit}`])) {
    const n = git(["ls-tree", "-r", "--name-only", gateSha, "tests/"]).split(/\r?\n/).filter((f) => f.endsWith(".test.ts")).length;
    stateSide = n;
    stateSideLabel = `${n} tests/**/*.test.ts in the tree at ${gateSha}`;
  }
  if (!sFiles) skip("state-test-files", "STATE §0 states no `N files / M passed / K skipped` line", "VYUHA-STATE.md §0");
  else cmp("state-test-files", num(sFiles[1]), stateSide, `STATE §0 ${sFiles[1]} files`, stateSideLabel, s0cite(/(\d[\d,]*) files \/ ([\d,]+) passed/));

  const rFiles = readme ? /unit \+ integration tests across (\d+) files/.exec(readme) : null;
  if (!rFiles) skip("readme-test-files", "README states no tests/ file count", "README.md");
  else cmp("readme-test-files", num(rFiles[1]), diskTestFiles, `README ${rFiles[1]} files`, `${diskTestFiles} on disk`, `README.md:${lineAt(readme, rFiles.index)}`);

  const rSpecs = readme ? /Playwright flows through the real app, in (\d+) specs/.exec(readme) : null;
  if (!rSpecs) skip("readme-e2e-specs", "README states no e2e spec count", "README.md");
  else cmp("readme-e2e-specs", num(rSpecs[1]), diskSpecs, `README ${rSpecs[1]} specs`, `${diskSpecs} e2e/*.spec.ts on disk`, `README.md:${lineAt(readme, rSpecs.index)}`);

  // The drift that sat unnoticed for ~1,000 tests: README's unit-TEST number
  // against STATE §0's raw vitest line — TWO DIFFERENT DOCUMENTS.
  const rTests = readme ? /badge\/tests-([\d,]+)%20passing/.exec(readme) : null;
  if (!rTests) skip("readme-tests-vs-state", "README has no tests badge", "README.md");
  else if (!sFiles) skip("readme-tests-vs-state", "STATE §0 states no `M passed` figure", "VYUHA-STATE.md §0");
  else
    cmp("readme-tests-vs-state", num(rTests[1]), num(sFiles[2]), `README ${rTests[1]} tests`, `STATE §0 ${sFiles[2]} passed`, `README.md:${lineAt(readme, rTests.index)} vs VYUHA-STATE.md §0`);

  // README's e2e FLOW count needs Playwright's own list. It must not cost 20 s.
  const rFlows = readme ? /badge\/e2e-(\d+)%20flows/.exec(readme) : null;
  if (!rFlows) skip("readme-e2e-flows", "README has no e2e badge", "README.md");
  else {
    let listed = null;
    let why = "";
    try {
      // --list does NOT start the webServer, and takes ~6 s locally (measured
      // 2026-09-22). shell:true because `npx` is a .cmd shim on Windows.
      const out = execFileSync("npx", ["playwright", "test", "--list"], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      listed = num(/Total: (\d+) test/.exec(out)?.[1]);
      if (!listed) why = "`playwright test --list` printed no `Total: N tests` line";
    } catch (e) {
      why = `\`playwright test --list\` failed/timed out (${String(e.code ?? e.message).slice(0, 40)})`;
    }
    if (!listed) skip("readme-e2e-flows", why, "README.md");
    else cmp("readme-e2e-flows", num(rFlows[1]), listed, `README ${rFlows[1]} flows`, `playwright --list ${listed}`, `README.md:${lineAt(readme, rFlows.index)}`);
  }
}

// ── g. shas cited resolve; the claimed HEAD is an ancestor ──────────────────
if (closeOut) {
  const shaSrcs = [
    ["VYUHA-STATE.md §0", state0, state0Line],
    [sessionLogRel, sessionLog, 0],
  ];
  const bad = [];
  let counted = 0;
  for (const [label, text] of shaSrcs) {
    if (!text) continue;
    for (const m of text.matchAll(/`([0-9a-f]{7,40})`/g)) {
      const sha = m[1];
      if (!/\d/.test(sha) || !/[a-f]/.test(sha)) continue; // a bare number is not a sha
      counted++;
      if (!gitOk(["cat-file", "-e", `${sha}^{commit}`])) bad.push(`${sha} (${label.split(" ")[0]})`);
    }
  }
  if (!sessionLog) skip("cited-shas", `${sessionLogRel} absent — STATE §0 only would be a partial check`, "STATE §0 + SESSION-LOG.md");
  else if (!bad.length) pass("cited-shas", `${counted} shas cited`, "all resolve via git cat-file", `STATE §0 + ${sessionLogFolder}/SESSION-LOG.md`);
  else fail("cited-shas", `${counted} cited`, `unresolvable: ${t([...new Set(bad)].join(", "), 100)}`, `STATE §0 + ${sessionLogFolder}/SESSION-LOG.md`);

  const headClaim = /HEAD[^`\n]{0,6}`([0-9a-f]{7,40})`/.exec(state0)?.[1];
  if (!headClaim) skip("state-head-ancestor", "STATE §0 names no HEAD sha", "VYUHA-STATE.md §0");
  else if (!gitOk(["cat-file", "-e", `${headClaim}^{commit}`]))
    fail("state-head-ancestor", headClaim, "not a commit in this repo", s0cite(/HEAD[^`\n]{0,6}`[0-9a-f]{7,40}`/));
  else {
    const head = git(["rev-parse", "--short", "HEAD"]);
    const ok = gitOk(["merge-base", "--is-ancestor", headClaim, "HEAD"]);
    if (ok) pass("state-head-ancestor", headClaim, `ancestor of / equal to HEAD ${head}`, s0cite(/HEAD[^`\n]{0,6}`[0-9a-f]{7,40}`/));
    else fail("state-head-ancestor", headClaim, `NOT an ancestor of HEAD ${head}`, s0cite(/HEAD[^`\n]{0,6}`[0-9a-f]{7,40}`/));
  }
}

// ── h. the archive is append-only ───────────────────────────────────────────
if (closeOut) {
  let stat = "";
  try {
    stat = git(["diff", "HEAD~1", "--numstat", "--", "VYUHA-STATE-ARCHIVE.md"]);
  } catch {
    stat = "";
  }
  if (!stat) skip("archive-append-only", "VYUHA-STATE-ARCHIVE.md untouched in HEAD (nothing to judge)", "VYUHA-STATE-ARCHIVE.md");
  else {
    const [added, deleted] = stat.split(/\s+/);
    cmp("archive-append-only", 0, num(deleted), "0 deletions", `${deleted} deleted (+${added} added)`, "git diff HEAD~1 -- VYUHA-STATE-ARCHIVE.md");
  }
}

// ── i. freshness ordering: DECISIONS is never older than STATE §0 ───────────
if (closeOut) {
  const recon = /reconciled (\d{4}-\d{2}-\d{2})/.exec(state0)?.[1];
  const dates = decisions ? [...decisions.matchAll(/^## (2026-\d{2}-\d{2})/gm)].map((m) => m[1]).sort() : [];
  const newest = dates[dates.length - 1];
  if (!recon) skip("decisions-freshness", "STATE §0 header states no `reconciled <date>`", "VYUHA-STATE.md §0");
  else if (!newest) skip("decisions-freshness", "docs/DECISIONS.md has no `## 2026-…` entry", "docs/DECISIONS.md");
  else if (newest >= recon) pass("decisions-freshness", `STATE reconciled ${recon}`, `DECISIONS newest ${newest}`, "VYUHA-STATE.md §0 vs docs/DECISIONS.md");
  else fail("decisions-freshness", `STATE reconciled ${recon}`, `DECISIONS newest ${newest} (older)`, "VYUHA-STATE.md §0 vs docs/DECISIONS.md");
}

// ── k. STATE's pointer into 06-ANSWERS still names a real heading ───────────
if (closeOut) {
  if (!answers) skip("state-answers-pointer", `${answersRel} absent`, "VYUHA-STATE.md §0");
  else {
    const line = state0.split(/\r?\n/).find((l) => l.includes("06-ANSWERS.md"));
    const quoted = line ? [...line.matchAll(/[“"]([^”"\n]{6,80})[”"]/g)].map((m) => m[1]) : [];
    const headings = [...answers.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    if (!quoted.length) skip("state-answers-pointer", "STATE §0's 06-ANSWERS line quotes no table title", "VYUHA-STATE.md §0");
    else {
      const bad = quoted.filter((q) => !headings.some((h) => h.startsWith(q)));
      if (!bad.length) pass("state-answers-pointer", `${quoted.length} table titles quoted`, "each is a `## ` heading in 06-ANSWERS.md", "VYUHA-STATE.md §0 vs 06-ANSWERS.md");
      else fail("state-answers-pointer", t(bad.join(" / "), 60), "no such `## ` heading in 06-ANSWERS.md", "VYUHA-STATE.md §0 vs 06-ANSWERS.md");
    }
  }
}

// ── l. README's stated version vs package.json ──────────────────────────────
if (closeOut) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const m = readme ? /^> \*\*Now: v(\d+\.\d+\.\d+)\*\*/m.exec(readme) : null;
  if (!m) skip("readme-version", "README states no current version (`> **Now: vX.Y.Z**`)", "README.md");
  else cmp("readme-version", m[1], pkg.version, `README ${m[1]}`, `package.json ${pkg.version}`, `README.md:${lineAt(readme, m.index)}`);
}

// ── C. AGENTS invariant 3's rate KEY vs charge_config's own unique index ────
// AGENTS prose on one side, `lib/db/schema.ts`'s `charge_config_uq` on the
// other. The key gained `plan` in v4.5.0 wave U and the invariant was edited by
// hand; the next column to join it will be added to the index, not to the prose.
{
  const schemaRel = "lib/db/schema.ts";
  const schema = doc(schemaRel);
  const idx = schema ? /uniqueIndex\("charge_config_uq"\)\.on\(([^)]*)\)/.exec(schema) : null;
  // The prose wraps: "exchange," ends one line and "effective-dated" starts the next.
  const keyRe = /\(((?:\w+ × )+\w+),\s+effective-dated/;
  const claim = agents ? keyRe.exec(agents) : null;
  if (!idx) skip("rate-key-vs-schema", `${schemaRel} has no parsable \`charge_config_uq\` index`, schemaRel);
  else if (!claim) skip("rate-key-vs-schema", "AGENTS invariant 3 states no `(a × b × …, effective-dated` key", "AGENTS.md");
  else {
    // The index carries the effective-dating column too; the prose says
    // "effective-dated" in words, so it is compared as the flag it is.
    const cols = idx[1].split(",").map((s) => s.trim().replace(/^t\./, "")).filter(Boolean);
    const dated = cols.includes("effectiveFrom");
    const actual = `${cols.filter((c) => c !== "effectiveFrom").join(" × ")}${dated ? ", effective-dated" : ""}`;
    const claimed = `${claim[1]}, effective-dated`;
    cmp(
      "rate-key-vs-schema",
      claimed,
      actual,
      `AGENTS invariant 3: ${claimed}`,
      `${schemaRel} charge_config_uq: ${actual}`,
      `${findLine("AGENTS.md", agents, keyRe)} vs ${schemaRel}:${lineAt(schema, idx.index)}`,
    );
  }
}

// ── D. commit.ts's autoClose claim vs the import routes' own call sites ─────
// A COMMENT on one side, the CALLERS on the other. W2a landed the applier
// dormant ("every production caller … writes exactly what v4.4.0 wrote") and
// W2b turned it on — both import routes now pass `autoClose: !keepSellsSeparate`,
// i.e. ON unless the user ticks the box, while the comment still said otherwise.
{
  const commitRel = "lib/import/commit.ts";
  const commit = doc(commitRel);
  // EVERY such claim is checked, not just the first: the file carries two, and
  // it was the SECOND that went stale when W2b flipped the default on.
  const claims = commit
    ? [...commit.matchAll(/every production caller[\s\S]{0,400}?(writes exactly what v4\.4\.0 wrote|passes it EXPLICITLY)/g)]
    : [];
  const routes = ["app/api/import/route.ts", "app/api/import/broker/route.ts"];
  const sites = routes.flatMap((rel) => {
    const src = doc(rel);
    if (!src) return [];
    return [...src.matchAll(/autoClose:\s*([^,}\n]+)/g)].map((m) => ({ rel, value: m[1].trim() }));
  });
  if (claims.length === 0) skip("autoclose-comment-vs-callers", `${commitRel} makes no claim about what every production caller passes`, commitRel);
  else if (sites.length === 0) skip("autoclose-comment-vs-callers", "no `autoClose:` at any app/api/import*/route.ts call site", routes.join(", "));
  else {
    const actual = sites.every((s) => s.value === "false") ? "off at every caller" : "explicit at every caller";
    const said = (m) => (m[1] === "writes exactly what v4.4.0 wrote" ? "off at every caller" : "explicit at every caller");
    const bad = claims.find((m) => said(m) !== actual);
    const where = `${commitRel}:${lineAt(commit, (bad ?? claims[0]).index)} vs ${routes.join(" + ")}`;
    const actualLabel = sites.map((s) => `${path.basename(path.dirname(s.rel))}/route.ts ${s.value}`).join(", ");
    if (bad) fail("autoclose-comment-vs-callers", `${commitRel}: "${bad[1]}"`, actualLabel, where);
    else pass("autoclose-comment-vs-callers", `${claims.length} claim(s): ${actual}`, actualLabel, where);
  }
}

// ── E. every [FIX] row in docs/LEDGER.md names a test file that exists ──────
// Owner ruling R1 (2026-09-24, v4.6.0 spec W1): a [FIX] is a defect fixed, and
// it MUST name the test that goes red on revert. The two sides come from
// different sources: the ledger's own evidence cell, and the tree on disk.
{
  const ledgerRel = "docs/LEDGER.md";
  const ledger = doc(ledgerRel);
  if (ledger == null) skip("ledger-fix-tests", `${ledgerRel} is absent`);
  else {
    const rows = [...ledger.matchAll(/^\|\s*(F-\d+)\s*\|[^|\n]*\|\s*\[FIX\]\s*\|[^|\n]*\|([^\n]*)\|\s*$/gm)];
    if (rows.length === 0) skip("ledger-fix-tests", "no [FIX] rows yet", ledgerRel);
    else {
      const bad = [];
      for (const m of rows) {
        const tests = [...m[2].matchAll(/`((?:tests|e2e)\/[^`]+?\.(?:test|spec)\.ts)`/g)].map((x) => x[1]);
        if (tests.length === 0) bad.push(`${m[1]} names no test file`);
        for (const tf of tests) if (!existsSync(path.resolve(root, tf))) bad.push(`${m[1]}: ${tf} not on disk`);
      }
      // A [FIX] row in any other shape would be skipped by the regex above — count
      // every line carrying the tag and fail on the difference.
      const tagged = ledger.split(/\r?\n/).filter((l) => /^\|.*\|\s*\[FIX\]\s*\|/.test(l)).length;
      if (tagged !== rows.length) bad.push(`${tagged - rows.length} [FIX] row(s) not in the 5-cell form`);
      const where = `${ledgerRel}:${lineAt(ledger, rows[0].index)}`;
      if (bad.length) fail("ledger-fix-tests", `${rows.length} [FIX] row(s) each name an existing test`, bad.join("; "), where);
      else pass("ledger-fix-tests", `${rows.length} [FIX] row(s) each name an existing test`, "all on disk", where);
    }
  }
}

// ── output ──────────────────────────────────────────────────────────────────
for (const r of results) {
  if (r.status === "SKIP") console.log(`SKIP ${r.name}: ${t(r.actual, 110)} (${r.where})`);
  else console.log(`${r.status} ${r.name}: claimed ${t(r.claimed, 80)} | actual ${t(r.actual, 130)} (${r.where})`);
}
const f = results.filter((r) => r.status === "FAIL").length;
const s = results.filter((r) => r.status === "SKIP").length;
const p = results.length - f - s;
console.log(`${f ? "DRIFT" : "CLEAN"} ${closeOut ? "close-out" : "structural"}: ${p} PASS / ${f} FAIL / ${s} SKIP${f ? " — fix the DOC, never the check" : ""}`);
process.exit(f ? 1 : 0);
