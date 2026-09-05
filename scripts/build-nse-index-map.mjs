/**
 * Build lib/data/nse-index-map.json from a folder of NSE index-constituent
 * CSVs (the ind_*_list.csv downloads from niftyindices.com / nseindia.com).
 *
 *   node scripts/build-nse-index-map.mjs --src "path/to/NIFTY INDICES" \
 *     [--size-src "path/to/index-constituents-YYYY-MM-DD"] [--as-of YYYY-MM-DD]
 *
 * The committed JSON is a SNAPSHOT — the as-of date is stored in the file and
 * shown in the UI, because index constituents churn at every semi-annual
 * rebalance. Refresh by re-downloading the lists and re-running this script.
 *
 * TWO FOLDERS, TWO ROLES. `--src` holds the sectoral/thematic lists and feeds
 * `symbols[SYM].indices[]`. `--size-src` holds the eight SIZE lists (Nifty 50 /
 * Next 50 / 100 / 200 / 500 / Midcap 150 / Smallcap 250 / Microcap 250), which
 * are a different KIND of fact — a cap bucket, not a theme — and so land in
 * their own `sizeIndices` section plus a per-symbol `capBand`. A size list is
 * skipped by the sectoral pass even when it sits in `--src`, so that "Nifty
 * 500" can never appear as a theme in edge analytics (a 500-name "theme" would
 * swamp every real one). The 2026-08-06 map had no size data at all because
 * the folder that build ran against held only the thematic downloads.
 *
 * DATING (Q50, standing rule). Every size membership carries `effective_at` —
 * the list's own as-of, which for these CSVs is the download date, since NSE
 * puts no date in the file or the URL — and `captured_at`, the build date.
 * The top-level `asOf` continues to date the SECTORAL snapshot; do not bump it
 * when only the size lists are refreshed.
 *
 * Industry normalisation: the constituent files span two generations of NSE's
 * sector taxonomy. Legacy ALL-CAPS labels are mapped to their modern
 * equivalents ONLY where the mapping is unambiguous; anything else is kept
 * verbatim rather than guessed (CONSUMER GOODS could be FMCG or Durables —
 * it stays as-is and simply won't collide). When two files disagree on a
 * symbol's industry, the Title-Case (modern taxonomy) value wins.
 */

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
const sizeSrc = opt("--size-src");
const asOf = opt("--as-of", new Date().toISOString().slice(0, 10));
const capturedAt = opt("--captured-at", new Date().toISOString().slice(0, 10));
if (!src || !fs.existsSync(src)) {
  console.error("Usage: node scripts/build-nse-index-map.mjs --src <folder of ind_*_list.csv> [--size-src <folder>] [--as-of YYYY-MM-DD]");
  process.exit(1);
}
if (sizeSrc && !fs.existsSync(sizeSrc)) {
  console.error("✗ --size-src folder not found:", sizeSrc);
  process.exit(1);
}

/**
 * The eight size indices, LARGEST FIRST — the order is the tie-break.
 *
 * SEBI's buckets are defined by rank (top 100 large, 101–250 mid, 251+ small),
 * and NSE's own lists are the published expression of that ranking, so
 * membership is the bucket (Q47). A symbol that appears in two bands at a
 * rebalance takes the LARGER one: over-stating size is the conservative error
 * for position sizing, under-stating it is not.
 */
const SIZE_BANDS = [
  ["Nifty 100", "large"],
  ["Nifty Midcap 150", "mid"],
  ["Nifty Smallcap 250", "small"],
  ["Nifty Microcap 250", "micro"],
];
/** Every label the sectoral pass must refuse. Nifty 50 / Next 50 / 200 / 500 are
 *  size lists too — they just don't define a band of their own. Midsmallcap 400
 *  is Midcap 150 + Smallcap 250 restated and defines nothing; it is ignored
 *  outright rather than shipped as a ninth key. */
const SIZE_LABELS = new Set([
  "Nifty 50", "Nifty Next 50", "Nifty 100", "Nifty 200",
  "Nifty 500", "Nifty Midcap 150", "Nifty Smallcap 250", "Nifty Microcap 250",
]);
const IGNORED_SIZE_LABELS = new Set(["Nifty Midsmallcap 400", "Nifty Largemidcap 250", "Nifty Total Market"]);

/** Legacy → modern taxonomy, unambiguous cases only. */
const INDUSTRY_CANON = new Map([
  ["AUTOMOBILE", "Automobile and Auto Components"],
  ["FINANCIAL SERVICES", "Financial Services"],
  ["INDUSTRIAL MANUFACTURING", "Capital Goods"],
  ["Oil, Gas & Consumable Fuels", "Oil Gas & Consumable Fuels"],
]);
const canonIndustry = (s) => INDUSTRY_CANON.get(s) ?? s;
const isModernCase = (s) => s !== s.toUpperCase(); // Title Case = new taxonomy

/** "ind_niftyIndiaRailwaysPSU_list.csv" → "Nifty India Railways PSU" */
export function indexLabelFromFilename(file) {
  let n = path.basename(file)
    .replace(/^ind[_-]/i, "")
    .replace(/[_-]?list\.csv$/i, "")
    .replace(/\.csv$/i, "");
  n = n.replace(/^nifty[_-]?/i, "");
  // Split camelCase / digits, tidy separators.
  n = n
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .trim();
  // Words that must stay upper.
  n = n
    .split(/\s+/)
    .map((w) => (/^(psu|nbfc|sfbs|mfis|ipo|ev|cpse|mnc|fmcg|it)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
  return "Nifty " + n;
}

function parseCsv(text) {
  // Constituent files are simple CSVs; company names may carry commas inside
  // quotes, so a tiny state machine instead of naive split.
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

const listCsvs = (dir) => fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv")).sort();

/** One constituent file → its rows, or null if it carries no Symbol column. */
function readConstituents(dir, f) {
  const rows = parseCsv(fs.readFileSync(path.join(dir, f), "utf8").replace(/^﻿/, ""));
  const header = rows[0].map((h) => h.toUpperCase());
  const ix = {
    name: header.findIndex((h) => h.includes("COMPANY")),
    industry: header.findIndex((h) => h.includes("INDUSTRY")),
    symbol: header.findIndex((h) => h === "SYMBOL"),
    isin: header.findIndex((h) => h.includes("ISIN")),
  };
  if (ix.symbol < 0) { console.warn("• skipped (no Symbol column):", f); return null; }
  const out = [];
  for (const r of rows.slice(1)) {
    const sym = (r[ix.symbol] ?? "").toUpperCase();
    if (!sym) continue;
    out.push({
      sym,
      industry: ix.industry >= 0 ? canonIndustry(r[ix.industry] ?? "") : "",
      isin: ix.isin >= 0 && /^[A-Z]{2}[A-Z0-9]{10}$/.test(r[ix.isin] ?? "") ? r[ix.isin] : "",
      name: ix.name >= 0 ? (r[ix.name] ?? "") : "",
    });
  }
  return out;
}

const symbols = {}; // SYM → { industry, industryModern, isin, name, indices: Set }
let rowsRead = 0;

/** Fill the reference fields for a symbol without ever overwriting a set one. */
function upsert(sym, row, { allowIndustryUpgrade }) {
  const cur = symbols[sym] ?? { industry: "", industryModern: false, isin: "", name: "", indices: new Set() };
  const better = allowIndustryUpgrade ? !cur.industryModern && isModernCase(row.industry) : false;
  if (row.industry && (!cur.industry || better)) {
    cur.industry = row.industry;
    cur.industryModern = isModernCase(row.industry);
  }
  if (!cur.isin && row.isin) cur.isin = row.isin;
  if (!cur.name && row.name) cur.name = row.name;
  symbols[sym] = cur;
  return cur;
}

const allFiles = listCsvs(src);
if (allFiles.length === 0) {
  console.error("✗ no CSVs in", src);
  process.exit(1);
}
// Size lists in --src are NOT themes; they are handled by the size pass below.
const files = allFiles.filter((f) => {
  const label = indexLabelFromFilename(f);
  return !SIZE_LABELS.has(label) && !IGNORED_SIZE_LABELS.has(label);
});

for (const f of files) {
  const label = indexLabelFromFilename(f);
  const rows = readConstituents(src, f);
  if (!rows) continue;
  for (const r of rows) {
    rowsRead += 1;
    upsert(r.sym, r, { allowIndustryUpgrade: true }).indices.add(label);
  }
}

/**
 * Size pass. Reference fields are filled only where the sectoral pass left a
 * gap (`allowIndustryUpgrade: false`) — a size list must be able to ADD a
 * microcap the thematic lists never name, but must never re-sector a symbol
 * they already classified, or the size work would silently rewrite analytics
 * that have nothing to do with market cap.
 */
const sizeIndices = {};
const bandOf = {}; // SYM → "large" | "mid" | "small" | "micro"
if (sizeSrc) {
  const members = {}; // label → SYM[]
  for (const f of listCsvs(sizeSrc)) {
    const label = indexLabelFromFilename(f);
    if (IGNORED_SIZE_LABELS.has(label)) { console.warn("• ignored (restates two other size lists):", f); continue; }
    if (!SIZE_LABELS.has(label)) { console.warn("• ignored (not one of the eight size indices):", f); continue; }
    const rows = readConstituents(sizeSrc, f);
    if (!rows) continue;
    const seen = new Set();
    for (const r of rows) {
      rowsRead += 1;
      upsert(r.sym, r, { allowIndustryUpgrade: false });
      seen.add(r.sym);
    }
    members[label] = [...seen].sort();
    // No date in the file and none in the URL, so the download date IS the
    // as-of. mtime is preserved by the fetch script's `cp -p`.
    // LOCAL date, not toISOString(): a 00:15 IST download is the previous day
    // in UTC, and the date the operator recorded in the fetch manifest is the
    // local one. An effective_at that disagrees with the manifest is worse
    // than one that is a few hours coarse.
    const m = fs.statSync(path.join(sizeSrc, f)).mtime;
    const effectiveAt = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(m.getDate()).padStart(2, "0")}`;
    sizeIndices[label] = {
      asOf: effectiveAt,
      effective_at: effectiveAt,
      captured_at: capturedAt,
      source: `https://niftyindices.com/IndexConstituent/${f}`,
      file: f,
      count: members[label].length,
      symbols: members[label],
    };
  }
  const missing = [...SIZE_LABELS].filter((l) => !sizeIndices[l]);
  if (missing.length) console.warn("⚠ size lists missing from --size-src:", missing.join(", "));
  // Largest band wins.
  for (const [label, band] of [...SIZE_BANDS].reverse()) {
    for (const s of members[label] ?? []) bandOf[s] = band;
  }
}

const out = {
  asOf,
  capturedAt,
  source: "NSE index constituent lists (niftyindices.com)",
  indexCount: files.length + Object.keys(sizeIndices).length,
  provenance: {
    sectoralIndexCount: files.length,
    sizeIndexCount: Object.keys(sizeIndices).length,
    sizeIndicesReason:
      "Absent from 2026-08-06 build because the source folder held only sectoral/thematic lists; added 2026-09-06 (owner ruling Q46)",
  },
  sizeIndices,
  symbols: Object.fromEntries(
    Object.entries(symbols)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, v]) => [s, {
        industry: v.industry || null,
        isin: v.isin || null,
        name: v.name || null,
        capBand: bandOf[s] ?? "unclassified",
        indices: [...v.indices].sort(),
      }]),
  ),
};

const dest = path.join(root, "lib", "data", "nse-index-map.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
const n = Object.keys(out.symbols).length;
console.log(`✓ ${dest}`);
console.log(`  ${files.length} sectoral + ${Object.keys(sizeIndices).length} size files → ${n} symbols (${rowsRead} rows) · sectoral as of ${asOf}, captured ${capturedAt}`);
const bands = {};
for (const v of Object.values(out.symbols)) bands[v.capBand] = (bands[v.capBand] ?? 0) + 1;
console.log(`  capBand: ${["large", "mid", "small", "micro", "unclassified"].map((b) => `${b} ${bands[b] ?? 0}`).join(" · ")}`);
if (!sizeSrc) console.warn("  ⚠ no --size-src: every capBand is \"unclassified\" and sizeIndices is empty");
const noInd = Object.values(out.symbols).filter((v) => !v.industry).length;
if (noInd) console.warn(`  ⚠ ${noInd} symbols without industry`);
