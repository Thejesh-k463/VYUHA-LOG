/**
 * Build lib/data/nse-index-map.json from a folder of NSE index-constituent
 * CSVs (the ind_*_list.csv downloads from niftyindices.com / nseindia.com).
 *
 *   node scripts/build-nse-index-map.mjs --src "path/to/NIFTY INDICES" [--as-of YYYY-MM-DD]
 *
 * The committed JSON is a SNAPSHOT — the as-of date is stored in the file and
 * shown in the UI, because index constituents churn at every semi-annual
 * rebalance. Refresh by re-downloading the lists and re-running this script.
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
const asOf = opt("--as-of", new Date().toISOString().slice(0, 10));
if (!src || !fs.existsSync(src)) {
  console.error("Usage: node scripts/build-nse-index-map.mjs --src <folder of ind_*_list.csv> [--as-of YYYY-MM-DD]");
  process.exit(1);
}

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

const files = fs.readdirSync(src).filter((f) => f.toLowerCase().endsWith(".csv"));
if (files.length === 0) {
  console.error("✗ no CSVs in", src);
  process.exit(1);
}

const symbols = {}; // SYM → { industry, industryModern, isin, name, indices: Set }
let rowsRead = 0;

for (const f of files) {
  const label = indexLabelFromFilename(f);
  const rows = parseCsv(fs.readFileSync(path.join(src, f), "utf8").replace(/^﻿/, ""));
  const header = rows[0].map((h) => h.toUpperCase());
  const ix = {
    name: header.findIndex((h) => h.includes("COMPANY")),
    industry: header.findIndex((h) => h.includes("INDUSTRY")),
    symbol: header.findIndex((h) => h === "SYMBOL"),
    isin: header.findIndex((h) => h.includes("ISIN")),
  };
  if (ix.symbol < 0) { console.warn("• skipped (no Symbol column):", f); continue; }

  for (const r of rows.slice(1)) {
    const sym = (r[ix.symbol] ?? "").toUpperCase();
    if (!sym) continue;
    rowsRead += 1;
    const industry = ix.industry >= 0 ? canonIndustry(r[ix.industry] ?? "") : "";
    const cur = symbols[sym] ?? { industry: "", industryModern: false, isin: "", name: "", indices: new Set() };
    if (industry && (!cur.industry || (!cur.industryModern && isModernCase(industry)))) {
      cur.industry = industry;
      cur.industryModern = isModernCase(industry);
    }
    if (!cur.isin && ix.isin >= 0 && /^[A-Z]{2}[A-Z0-9]{10}$/.test(r[ix.isin] ?? "")) cur.isin = r[ix.isin];
    if (!cur.name && ix.name >= 0) cur.name = r[ix.name] ?? "";
    cur.indices.add(label);
    symbols[sym] = cur;
  }
}

const out = {
  asOf,
  source: "NSE index constituent lists (niftyindices.com)",
  indexCount: files.length,
  symbols: Object.fromEntries(
    Object.entries(symbols)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, v]) => [s, {
        industry: v.industry || null,
        isin: v.isin || null,
        name: v.name || null,
        indices: [...v.indices].sort(),
      }]),
  ),
};

const dest = path.join(root, "lib", "data", "nse-index-map.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
const n = Object.keys(out.symbols).length;
console.log(`✓ ${dest}`);
console.log(`  ${files.length} index files → ${n} symbols (${rowsRead} rows) · as of ${asOf}`);
const noInd = Object.values(out.symbols).filter((v) => !v.industry).length;
if (noInd) console.warn(`  ⚠ ${noInd} symbols without industry`);
