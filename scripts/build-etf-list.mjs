/**
 * Build lib/data/etf-list.json from NSE's own published ETF list, so an ETF
 * can be told apart from an ordinary equity share — and an equity-oriented
 * ETF from a gold / silver / debt / international one.
 *
 *   node scripts/build-etf-list.mjs --src "path/to/etf-list-folder" [--as-of YYYY-MM-DD] [--out file.json]
 *
 * `--out` exists for tests: they build a synthetic folder and assert on the
 * result without touching the committed snapshot.
 *
 * ── No `--fetch`, deliberately ────────────────────────────────────────────
 *
 * Unlike build-isin-symbols.mjs this script downloads nothing. The refresh is
 * MANUAL, on the owner's machine, once per MINOR release (owner ruling T4,
 * 2026-09-22 — the nse-index-map.json rule Q52), and the download is the
 * owner's own step:
 *
 *   https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv
 *
 * The downloaded CSV, its HTTP response headers and a MANIFEST with the
 * sha256 live OUTSIDE the repo, with the other vendor inputs:
 *   LIVE-DESK-RESEARCH/_data/etf-list-2026-09-11/
 *
 * The committed JSON is a SNAPSHOT, exactly like lib/data/isin-symbols.json
 * and lib/data/nse-index-map.json: the as-of date lives in the file and the
 * only way to refresh it is to re-download and re-run this script. NEVER
 * hand-edit the JSON — a hand-added row has no provenance, and a wrong class
 * moves a user's STT and (from wave 3b) their tax head.
 *
 * ── Effective dating (standing rule Q50) ──────────────────────────────────
 *
 * `asOf` is the list's OWN date — NSE states none in the file, so it is the
 * HTTP `Last-Modified` of the download, read from the `*.response-headers.txt`
 * saved beside the CSV. `capturedAt` is the build date. Using the build date
 * as `asOf` would date the snapshot to when we happened to run a script.
 *
 * ── Classification: the `ETF Underlying` column ONLY ──────────────────────
 *
 * Never the fund-house name, never `SecurityName`, never `Underlying Asset`.
 * EQUITY → `equity-oriented`; COMMODITY / DEBT / GLOBAL INDICES / Hybrid →
 * `other`. ANY OTHER VALUE FAILS THE BUILD — a value nobody has seen is a new
 * NSE category, and guessing its side of the equity-oriented line is exactly
 * the invented fact invariant 6 forbids. The RAW column value is kept on every
 * row too: `debtUnit` and `otherUnit` separate for the s.50AA cells (wave 3b),
 * and the binary kind cannot carry that.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const src = opt("--src");
const asOfOverride = opt("--as-of");
const outPath = opt("--out", path.join(root, "lib", "data", "etf-list.json"));
const SOURCE_URL = "https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv";

if (!src || !fs.existsSync(src)) {
  console.error("Usage: node scripts/build-etf-list.mjs --src <folder holding eq_etfseclist.csv> [--as-of YYYY-MM-DD]");
  process.exit(1);
}

/**
 * The only classification table there is. Keys are compared case-folded and
 * whitespace-collapsed because NSE's own file writes "Hybrid" in title case
 * and the rest in caps.
 */
const KINDS = {
  EQUITY: "equity-oriented",
  COMMODITY: "other",
  DEBT: "other",
  "GLOBAL INDICES": "other",
  HYBRID: "other",
};

const ISIN_RE = /^IN[A-Z0-9]{10}$/;

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

/** Header lookup that survives leading spaces and renamed columns. */
const norm = (h) => String(h).toUpperCase().replace(/[^A-Z0-9]/g, "");
function findCol(header, ...candidates) {
  const n = header.map(norm);
  for (const c of candidates) {
    const i = n.indexOf(norm(c));
    if (i >= 0) return i;
  }
  return -1;
}

/** The download's own date, from the response headers saved beside the CSV. */
function lastModifiedFor(csvFile) {
  const hdr = `${csvFile}.response-headers.txt`;
  if (!fs.existsSync(hdr)) return null;
  const m = fs.readFileSync(hdr, "utf8").match(/^last-modified:\s*(.+)$/im);
  if (!m) return null;
  const d = new Date(m[1].trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// The ETF list is one file; any other CSV in the folder is ignored rather than
// merged, because a second list would have no stated provenance of its own.
const csvs = fs.readdirSync(src).filter((f) => /\.csv$/i.test(f) && /etf/i.test(f));
if (csvs.length !== 1) {
  console.error(`✗ expected exactly one *etf*.csv in ${src}, found ${csvs.length}: ${csvs.join(", ")}`);
  process.exit(1);
}
const csvFile = path.join(src, csvs[0]);
const raw = fs.readFileSync(csvFile);
const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
const rows = parseCsv(raw.toString("utf8").replace(/^﻿/, ""));
if (rows.length < 2) {
  console.error("✗ no data rows in", csvFile);
  process.exit(1);
}

const header = rows[0];
const iSymbol = findCol(header, "Symbol", "SYMBOL");
const iIsin = findCol(header, "ISINNumber", "ISIN NUMBER", "ISIN_NUMBER", "ISIN");
const iUnderlying = findCol(header, "ETF Underlying");
const iAsset = findCol(header, "Underlying Asset");
if (iSymbol < 0 || iIsin < 0 || iUnderlying < 0) {
  console.error(`✗ ${csvs[0]} is missing Symbol / ISINNumber / "ETF Underlying" — headers: ${header.join(" | ")}`);
  process.exit(1);
}

const byIsin = {};
const bySymbol = {};
const kindCounts = {};
const underlyingCounts = {};
let dataRows = 0;

for (const r of rows.slice(1)) {
  const symbol = String(r[iSymbol] ?? "").trim().toUpperCase();
  const isin = String(r[iIsin] ?? "").trim().toUpperCase();
  const underlying = String(r[iUnderlying] ?? "").trim();
  dataRows++;
  if (!ISIN_RE.test(isin) || !symbol) {
    console.error(`✗ row ${dataRows} (${symbol || "?"}) has no usable ISIN/symbol — refusing to build`);
    process.exit(1);
  }
  const kind = KINDS[underlying.toUpperCase().replace(/\s+/g, " ")];
  if (!kind) {
    // A new NSE category. Classify it HERE, from NSE's own definition, in the
    // commit that re-snapshots — never by letting the build guess.
    console.error(`✗ unknown "ETF Underlying" value ${JSON.stringify(underlying)} on ${symbol} (${isin}) — refusing to build`);
    process.exit(1);
  }
  if (byIsin[isin]) {
    console.error(`✗ ISIN ${isin} appears twice (${byIsin[isin].symbol}, ${symbol}) — refusing to build`);
    process.exit(1);
  }
  byIsin[isin] = {
    symbol,
    underlying,
    kind,
    ...(iAsset >= 0 && r[iAsset] ? { asset: String(r[iAsset]).trim() } : {}),
  };
  // First writer wins, as everywhere else: one symbol cannot be two securities.
  if (!bySymbol[symbol]) bySymbol[symbol] = isin;
  kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
  underlyingCounts[underlying] = (underlyingCounts[underlying] ?? 0) + 1;
}

const asOf = asOfOverride ?? lastModifiedFor(csvFile);
if (!asOf) {
  console.error(`✗ no Last-Modified in ${path.basename(csvFile)}.response-headers.txt and no --as-of given — refusing to date the snapshot by the build date`);
  process.exit(1);
}

const out = {
  asOf,
  capturedAt: new Date().toISOString().slice(0, 10),
  source: "NSE, list of ETFs available for trading (eq_etfseclist.csv)",
  provenance: { url: SOURCE_URL, sha256, rows: dataRows },
  counts: { byIsin: Object.keys(byIsin).length, bySymbol: Object.keys(bySymbol).length, kinds: kindCounts, underlying: underlyingCounts },
  // Sorted so a refresh produces a minimal, reviewable diff.
  byIsin: Object.fromEntries(Object.entries(byIsin).sort(([a], [b]) => a.localeCompare(b))),
  bySymbol: Object.fromEntries(Object.entries(bySymbol).sort(([a], [b]) => a.localeCompare(b))),
};

const dest = path.resolve(outPath);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 0) + "\n");
console.log(`✓ ${dest}`);
console.log(`  ${out.counts.byIsin} ISINs · ${out.counts.bySymbol} symbols · as of ${asOf} (captured ${out.capturedAt})`);
console.log(`  kinds: ${Object.entries(kindCounts).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
console.log(`  underlying: ${Object.entries(underlyingCounts).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
console.log(`  sha256 ${sha256}`);
