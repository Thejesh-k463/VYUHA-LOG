#!/usr/bin/env node
/**
 * Redact ONE real broker export into a committable fixture.
 *
 *   node scripts/fixtures/redact-broker-export.mjs <in.(csv|xlsx|xls)> <out>
 *
 * THE THREE-ROW RULE (owner ruling, 2026-09-04): keep EVERY row. Only
 * identity is replaced — names, UCC, PAN, e-mail, mobile, client/account ids
 * and addresses become fixed tokens; dates, quantities, prices, charges,
 * symbols and ISINs are untouched, so every distinct case (scrip × product ×
 * side × exchange) keeps exactly the rows the broker wrote. Nothing is
 * dropped, and the script asserts that rather than assuming it.
 *
 * What it does, in order:
 *   1. reads the workbook with the repo's SheetJS (CSV is handled as text so
 *      every byte outside the replaced values survives, line endings included);
 *   2. tokenises identity CELLS — a label cell (`Name`, `UCC`, `PAN`,
 *      `Client ID`, `Email ID`, …) with its value to the right or after a
 *      colon, and any table COLUMN whose header is such a label;
 *   3. tokenises every e-mail address anywhere, then re-scans every cell and
 *      sheet name for every value it replaced (and for id-looking tokens in
 *      the input filename — brokers put the client code there) so a name that
 *      also appears in a title cell cannot survive;
 *   4. writes `.xls` back as `.xls` (BIFF8) when SheetJS can; otherwise falls
 *      back to `.xlsx` and SAYS SO on stdout;
 *   5. proves the redaction changed nothing a parser reads: `buildContext` +
 *      `rankParsers` on the original and the output must agree on the top
 *      parser AND its score — under the original filename and under a
 *      neutral one — and parsing both with that parser must give the same
 *      `trades.length`, `sourceRows`, Σ gross and Σ reported charges;
 *   6. re-reads the OUTPUT and refuses (exit 1) if any replaced value, or any
 *      e-mail other than the token, is still in it.
 *
 * Sheet names, header rows, blank-row structure, merged ranges and text-typed
 * money cells are preserved because only identity cells are ever rewritten.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(ROOT, "package.json"));
const XLSX = require("xlsx");

const TOKENS = {
  name: "REDACTED NAME",
  ucc: "UCC0000000",
  pan: "AAAAA0000A",
  email: "user@example.com",
  mobile: "9999999999",
  client: "ACC000000",
  address: "REDACTED ADDRESS",
};
const TOKEN_VALUES = new Set(Object.values(TOKENS));

/** Label → token kind. Anchored so `Scrip Name` / `Security Name` never match. */
const LABELS = [
  [/^(client\s*|account\s*holder\s*|customer\s*)?name$/i, "name"],
  [/^(ucc|unique\s*client\s*code)$/i, "ucc"],
  [/^pan(\s*(no|number|card))?$/i, "pan"],
  [/^e-?mail(\s*(id|address))?$/i, "email"],
  [/^(mobile|phone|contact)(\s*(no|number))?$/i, "mobile"],
  [/^(client\s*(id|code)|clientcode|clientid|account\s*(no|number|id|code)|dp\s*id|bo\s*id|trading\s*code|user\s*id|customer\s*id)$/i, "client"],
  [/^address$/i, "address"],
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const labelKind = (cell) => {
  const s = String(cell ?? "").trim().replace(/[:\-–]+$/, "").trim();
  for (const [re, kind] of LABELS) if (re.test(s)) return kind;
  return null;
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whitespace-flexible, case-insensitive matcher for a replaced value. */
const valueRe = (v) => new RegExp(v.trim().split(/\s+/).map(esc).join("\\s+"), "gi");

/** Every value the run replaced, so the leak scan can look for each one. */
const replaced = new Map(); // value → kind

function note(value, kind) {
  const v = String(value).trim();
  if (v.length < 3 || TOKEN_VALUES.has(v)) return;
  replaced.set(v, kind);
}

/** Id-looking tokens in the input filename (client codes live there). */
function filenameIds(file) {
  const base = path.basename(file, path.extname(file));
  return base.split(/[^A-Za-z0-9]+/).filter((t) => {
    if (t.length < 6 || t.length > 14) return false;
    const letters = /[A-Za-z]/.test(t), digits = /\d/.test(t);
    if (letters && digits) return true;
    return digits && !letters && t.length >= 9; // a bare numeric client code (a yyyymmdd date is 8)
  });
}

// ── Workbook redaction ──────────────────────────────────────────────────────

function redactSheet(ws) {
  if (!ws["!ref"]) return;
  const rng = XLSX.utils.decode_range(ws["!ref"]);
  const cellAt = (r, c) => ws[XLSX.utils.encode_cell({ r, c })];
  const setText = (r, c, text) => {
    const a = XLSX.utils.encode_cell({ r, c });
    ws[a] = { t: "s", v: text, w: text };
  };
  const isFilled = (cell) => cell != null && cell.v !== "" && cell.v != null;
  const filledCount = (r) => {
    let n = 0;
    for (let c = rng.s.c; c <= rng.e.c; c++) if (isFilled(cellAt(r, c))) n++;
    return n;
  };
  const columnHeaders = []; // {c, kind, fromRow}

  for (let r = rng.s.r; r <= rng.e.r; r++) {
    const filled = filledCount(r);
    for (let c = rng.s.c; c <= rng.e.c; c++) {
      const cell = cellAt(r, c);
      if (!isFilled(cell) || cell.t !== "s") continue;
      const text = String(cell.v);

      // `Label: value` inside one cell.
      const m = text.match(/^([^:]{2,40}):\s*(.+)$/);
      if (m && labelKind(m[1]) && m[2].trim()) {
        const kind = labelKind(m[1]);
        note(m[2], kind);
        setText(r, c, `${m[1]}: ${TOKENS[kind]}`);
        continue;
      }

      const kind = labelKind(text);
      if (!kind) continue;

      if (filled >= 4) {
        // A table header naming an identity column: tokenise the column below.
        columnHeaders.push({ c, kind, fromRow: r + 1 });
        continue;
      }
      // A preamble label: the value is the next filled cell to the right (≤ 3 away).
      for (let k = 1; k <= 3 && c + k <= rng.e.c; k++) {
        const v = cellAt(r, c + k);
        if (!isFilled(v)) continue;
        if (labelKind(v.v)) break; // the neighbour is another label, not a value
        note(v.v, kind);
        setText(r, c + k, TOKENS[kind]);
        break;
      }
    }
  }

  for (const { c, kind, fromRow } of columnHeaders) {
    for (let r = fromRow; r <= rng.e.r; r++) {
      const cell = cellAt(r, c);
      if (!isFilled(cell)) {
        // A fully blank row ends the table; a blank cell inside it does not.
        if (filledCount(r) === 0) break;
        continue;
      }
      note(cell.v, kind);
      setText(r, c, TOKENS[kind]);
    }
  }
}

/** Pass 2 over every string cell and sheet name: e-mails, then every replaced value. */
function sweepWorkbook(wb, extraValues) {
  const patterns = [...replaced.keys(), ...extraValues].map((v) => [valueRe(v), replaced.get(v) ?? "client"]);
  const scrub = (text) => {
    let out = text.replace(EMAIL_RE, (e) => {
      if (e === TOKENS.email) return e;
      note(e, "email");
      return TOKENS.email;
    });
    for (const [re, kind] of patterns) out = out.replace(re, TOKENS[kind]);
    return out;
  };
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    for (const a of Object.keys(ws)) {
      if (a[0] === "!") continue;
      const cell = ws[a];
      if (cell.t !== "s" || typeof cell.v !== "string") continue;
      const next = scrub(cell.v);
      if (next !== cell.v) ws[a] = { t: "s", v: next, w: next };
    }
    const newName = scrub(name);
    if (newName !== name) throw new Error(`sheet name "${name}" carries identity — refusing rather than renaming a sheet a parser may key on`);
  }
}

// ── CSV redaction (text-level, byte-preserving outside the replaced values) ──

function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function redactCsv(text, extraValues) {
  const lines = text.split(/(\r?\n)/); // keep the separators
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    if (f.filter((x) => x.trim()).length >= 4) continue; // a table row, not a label line
    const kind = labelKind(f[0]);
    if (!kind) continue;
    const value = (f.slice(1).find((x) => x.trim()) ?? "").trim();
    if (!value || labelKind(value)) continue;
    note(value, kind);
    lines[i] = line.replace(value, TOKENS[kind]);
  }
  let out = lines.join("");
  out = out.replace(EMAIL_RE, (e) => {
    if (e === TOKENS.email) return e;
    note(e, "email");
    return TOKENS.email;
  });
  for (const v of [...replaced.keys(), ...extraValues]) out = out.replace(valueRe(v), TOKENS[replaced.get(v) ?? "client"]);
  return out;
}

// ── Leak scan over the written OUTPUT ───────────────────────────────────────

function leakScan(outFile, extraValues) {
  const texts = [];
  if (/\.csv$/i.test(outFile)) texts.push(fs.readFileSync(outFile, "utf8"));
  else {
    const wb = XLSX.read(fs.readFileSync(outFile), { type: "buffer" });
    for (const name of wb.SheetNames) {
      texts.push(name);
      const ws = wb.Sheets[name];
      for (const a of Object.keys(ws)) if (a[0] !== "!" && ws[a].t === "s") texts.push(String(ws[a].v));
    }
  }
  const blob = texts.join("\n");
  const hits = [];
  for (const v of [...replaced.keys(), ...extraValues]) {
    const n = (blob.match(valueRe(v)) ?? []).length;
    if (n) hits.push(`${replaced.get(v) ?? "client"} value (${v.length} chars) ×${n}`);
  }
  for (const e of blob.match(EMAIL_RE) ?? []) if (e !== TOKENS.email) hits.push("an e-mail address");
  return hits;
}

// ── Row-conservation (the three-row rule) ───────────────────────────────────

const COLS = {
  scrip: /^(script|symbol|scrip\s*name|stock\s*name|security\s*name|company|tradingsymbol|scrip|scrip\s*code|instrument)$/i,
  side: /^(type|side|trade\s*type|buy\/sell|transaction\s*type)$/i,
  product: /^(product\s*type|product|segment)$/i,
  exchange: /^exchange$/i,
};

/** Per sheet: non-empty row count, and row count per (scrip, product, side, exchange). */
function rowProfile(file) {
  const profile = {};
  const tables = /\.csv$/i.test(file)
    ? [["csv", fs.readFileSync(file, "utf8").split(/\r?\n/).map(splitCsvLine)]]
    : (() => {
        const wb = XLSX.read(fs.readFileSync(file), { type: "buffer" });
        return wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" })]);
      })();
  for (const [name, rows] of tables) {
    const filled = rows.filter((r) => r.some((c) => String(c).trim() !== ""));
    const hi = rows.findIndex((r) => r.filter((c) => String(c).trim() !== "").length >= 5);
    const groups = new Map();
    if (hi >= 0) {
      const h = rows[hi].map((c) => String(c).trim());
      const idx = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, h.findIndex((c) => re.test(c))]));
      if (idx.scrip >= 0) {
        for (const r of rows.slice(hi + 1)) {
          if (!String(r[idx.scrip] ?? "").trim()) continue;
          const key = ["scrip", "product", "side", "exchange"].map((k) => (idx[k] >= 0 ? String(r[idx[k]]).trim() : "")).join("|");
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
      }
    }
    profile[name] = { rows: filled.length, groups };
  }
  return profile;
}

function assertRowsConserved(inFile, outFile) {
  const a = rowProfile(inFile), b = rowProfile(outFile);
  for (const name of Object.keys(a)) {
    const x = a[name], y = b[name] ?? (Object.keys(b).length === 1 ? b[Object.keys(b)[0]] : null);
    if (!y) throw new Error(`three-row rule: sheet "${name}" is missing from the output`);
    if (x.rows !== y.rows) throw new Error(`three-row rule: sheet "${name}" had ${x.rows} filled rows, output has ${y.rows}`);
    for (const [k, n] of x.groups) if (y.groups.get(k) !== n) throw new Error(`three-row rule: case ${k} had ${n} rows, output has ${y.groups.get(k) ?? 0}`);
    if (x.groups.size) {
      const min = Math.min(...x.groups.values());
      console.log(`  rows conserved on "${name}": ${x.rows} filled rows, ${x.groups.size} distinct cases (smallest case ${min} row${min === 1 ? "" : "s"})`);
    } else console.log(`  rows conserved on "${name}": ${x.rows} filled rows`);
  }
}

/**
 * Cell-level proof: the formatted text of every cell (what `raw: false`
 * hands the parsers) is unchanged except where a token now sits. SheetJS's
 * BIFF8 writer caps a string at 255 characters, so one long footer sentence
 * may come back truncated — tolerated only when the output is a strict
 * prefix of a >255-character input, and reported on stdout.
 */
function assertCellsPreserved(inFile, outFile) {
  if (/\.csv$/i.test(outFile)) return; // CSV is text: only the replaced values changed, by construction
  const a = XLSX.read(fs.readFileSync(inFile), { type: "buffer", cellNF: true });
  const b = XLSX.read(fs.readFileSync(outFile), { type: "buffer" });
  let tokenised = 0, truncated = 0;
  for (const name of a.SheetNames) {
    const x = XLSX.utils.sheet_to_json(a.Sheets[name], { header: 1, raw: false, defval: "" });
    const y = XLSX.utils.sheet_to_json(b.Sheets[name], { header: 1, raw: false, defval: "" });
    x.forEach((row, r) => row.forEach((cell, c) => {
      const before = String(cell), after = String(y[r]?.[c] ?? "");
      if (before === after) return;
      if ([...TOKEN_VALUES].some((t) => after.includes(t))) { tokenised++; return; }
      if (before.length > 255 && after.length >= 255 && before.startsWith(after)) { truncated++; return; }
      throw new Error(`cell ${name}!${XLSX.utils.encode_cell({ r, c })} changed without a token: "${before.slice(0, 40)}" → "${after.slice(0, 40)}"`);
    }));
  }
  console.log(`  cells preserved: ${tokenised} tokenised cell(s)${truncated ? `, ${truncated} footer string(s) >255 chars truncated by the BIFF8 writer` : ""}`);
}

// ── Parser equivalence, through the repo's own detection ────────────────────

/**
 * The parsers are TypeScript with `@/` path aliases, so the equivalence leg
 * runs in a child process under the repo's `tsx` (the same loader the load
 * suite and vitest use) — `tsImport` from a plain .mjs resolved `./registry-meta`
 * as CommonJS and failed. The child is THIS file with `--verify`.
 */
function verifyInChild(inFile, outFile) {
  const { spawnSync } = require("node:child_process");
  const tsxCli = require.resolve("tsx/cli");
  const res = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), "--verify", inFile, outFile], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(res.stdout ?? "");
  if (res.status !== 0) throw new Error((res.stderr ?? "").trim() || `verification exited ${res.status}`);
}

const r2 = (n) => Math.round(n * 100) / 100;

async function parserView(detect, filename, bytes) {
  const ctx = detect.buildContext(filename, bytes);
  const top = detect.rankParsers(ctx)[0];
  const view = { id: top.sourceId, score: r2(top.confidence) };
  const parsed = await top.parse(ctx);
  view.trades = parsed.trades.length;
  view.sourceRows = parsed.sourceRows ?? null;
  view.gross = r2(parsed.trades.reduce((s, t) => s + (t.grossPnl ?? 0), 0));
  view.charges = r2(parsed.trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0));
  view.reported = JSON.stringify(parsed.reported ?? null);
  // A REFERENCE source (Paytm/Angel P&L, Dhan DP charges and holdings, the
  // ledgers) and an ENRICH source (the Dhan contract note) parse to ZERO
  // trades, so every field above is 0/null for them and a redaction that
  // changed their entire output would have compared equal. These two carry
  // what those files actually emit, so the refusal covers them too.
  view.reference = JSON.stringify(parsed.reference ?? null);
  view.enrich = JSON.stringify(parsed.enrich ?? null);
  view.tableRows = parsed.table?.totalRows ?? null;
  return view;
}

function sameView(a, b, label) {
  const diffs = Object.keys(a).filter((k) => a[k] !== b[k]);
  if (diffs.length) throw new Error(`parser equivalence FAILED (${label}): ${diffs.map((k) => `${k} ${a[k]} → ${b[k]}`).join("; ")}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const [inFile, outArg] = process.argv.slice(2);
  if (!inFile || !outArg) {
    console.error("usage: node scripts/fixtures/redact-broker-export.mjs <in.(csv|xlsx|xls)> <out>");
    process.exit(2);
  }
  if (!fs.existsSync(inFile)) throw new Error(`no such file: ${inFile}`);
  const ext = path.extname(inFile).toLowerCase();
  if (![".csv", ".xlsx", ".xls"].includes(ext)) throw new Error(`unsupported extension ${ext} — CSV, XLSX and XLS only`);

  const extra = filenameIds(inFile);
  let outFile = outArg;
  let outcome;

  if (ext === ".csv") {
    const text = fs.readFileSync(inFile, "utf8");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, redactCsv(text, extra), "utf8");
    outcome = "csv rewritten as text";
  } else {
    // cellNF keeps each cell's number format so the writer re-emits it: without
    // it a date cell comes back as its serial (2026-04-01 → 46113) and a
    // formatted money cell loses its separators and its last digit
    // (124,047,284.95 → 124047284.9) — both read by parsers via `raw: false`.
    const wb = XLSX.read(fs.readFileSync(inFile), { type: "buffer", cellNF: true });
    for (const name of wb.SheetNames) redactSheet(wb.Sheets[name]);
    sweepWorkbook(wb, extra);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    if (ext === ".xls") {
      try {
        if (path.extname(outFile).toLowerCase() !== ".xls") outFile = outFile.replace(/\.[^.]+$/, ".xls");
        XLSX.writeFile(wb, outFile, { bookType: "biff8", compression: false });
        outcome = "xls KEPT as .xls (BIFF8)";
      } catch (e) {
        outFile = outFile.replace(/\.[^.]+$/, ".xlsx");
        XLSX.writeFile(wb, outFile, { bookType: "xlsx", compression: true });
        outcome = `xls CONVERTED to .xlsx — SheetJS could not write BIFF8 (${e.message})`;
      }
    } else {
      XLSX.writeFile(wb, outFile, { bookType: "xlsx", compression: true });
      outcome = "xlsx rewritten";
    }
  }

  console.log(`${path.basename(inFile)} → ${path.relative(ROOT, outFile)}: ${outcome}; ${replaced.size} identity value(s) replaced`);

  // 6. Leak scan first — a leaked value must never reach the equivalence check output.
  const hits = leakScan(outFile, extra);
  if (hits.length) {
    fs.rmSync(outFile, { force: true });
    throw new Error(`LEAK — output deleted. Still present: ${hits.join(", ")}`);
  }
  console.log(`  leak scan: 0 hits for ${replaced.size + extra.length} value(s)`);

  // Three-row rule.
  assertRowsConserved(inFile, outFile);
  // Every cell a parser could read (`raw: false` text) is unchanged except
  // the tokenised ones.
  assertCellsPreserved(inFile, outFile);

  // 5. Parser equivalence, under the original name and a neutral one.
  verifyInChild(inFile, outFile);
}

async function verify(inFile, outFile) {
  const detect = await import(pathToFileURL(path.join(ROOT, "lib", "import", "detect.ts")).href);
  const inBytes = fs.readFileSync(inFile), outBytes = fs.readFileSync(outFile);
  const origName = path.basename(inFile);
  const neutral = "export" + path.extname(outFile);
  const a1 = await parserView(detect, origName, inBytes), b1 = await parserView(detect, origName, outBytes);
  sameView(a1, b1, "original filename");
  const a2 = await parserView(detect, neutral, inBytes), b2 = await parserView(detect, neutral, outBytes);
  sameView(a2, b2, "neutral filename");
  const c = await parserView(detect, path.basename(outFile), outBytes);
  console.log(`  parser: ${a1.id}@${a1.score} (neutral ${a2.id}@${a2.score}; under the output name ${c.id}@${c.score}) trades=${a1.trades} sourceRows=${a1.sourceRows} gross=${a1.gross} charges=${a1.charges} — identical on both files`);
  if (c.id !== a2.id) console.log(`  NOTE: the output FILENAME changes the top parser (${a2.id} → ${c.id}); tests must load this fixture under a neutral name`);
}

(process.argv[2] === "--verify" ? verify(process.argv[3], process.argv[4]) : main()).catch((e) => {
  console.error(`redact-broker-export: ${e.message}`);
  process.exit(1);
});
