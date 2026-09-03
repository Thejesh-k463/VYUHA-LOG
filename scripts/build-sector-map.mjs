/**
 * Build lib/data/sector-map.json — NSE's 4-level sector taxonomy keyed by
 * ISIN, with the confidence and provenance of every classification — from
 * the Sentinel reconciliation sheet.
 *
 *   node scripts/build-sector-map.mjs <path-to-classification-reconciliation-multisource.csv>
 *        [--indices "<folder of ind_*_list.csv>"] [--as-of YYYY-MM-DD] [--out file.json]
 *
 * The input is READ-ONLY and lives outside this repo (the TRADE-SENTINAL
 * workspace). Nothing here writes anywhere but `--out`. The committed JSON is
 * a SNAPSHOT with the same discipline as lib/data/isin-symbols.json: dated,
 * provenance recorded (file name, sha256, row counts by source / confidence /
 * status), never hand-edited — a hand-added row has no provenance, and a wrong
 * sector is a wrong concentration figure that looks perfectly plausible.
 *
 * ── What is kept ──────────────────────────────────────────────────────────
 *
 * Rows whose `status` is anything but `unmatched_no_company_level_classification`
 * (those 76 carry no sector, source or confidence at all) and whose
 * `confidence` is one of high / medium_high / medium. 2,229 of 2,305 on the
 * 2026-09-04 sheet.
 *
 * The taxonomy is NORMALISED rather than repeated per row: `taxonomy_code` is
 * 1:1 with (macro, sector, industry, basic) — this script REFUSES to build if
 * that ever stops being true — so each ISIN row carries the code and a
 * 185-entry table carries the labels. Measured on the same rows the flat
 * shape (labels on every row) was ~2.6× the raw bytes for the same
 * information; the numbers are printed at the end of every build.
 *
 * Tuples, documented in `fields`, for the same reason as isin-symbols.json.
 *
 * ── sectorAliases ─────────────────────────────────────────────────────────
 *
 * NSE's index-constituent CSVs (`ind_*_list.csv`) carry two generations of
 * the sector taxonomy in their `Industry` column: the modern Title-Case labels
 * and a handful of legacy ALL-CAPS ones, plus two punctuation forks. The
 * app's sector chain (user instruments → this taxonomy → index map) must not
 * show "AUTOMOBILE" and "Automobile and Auto Components" as two sectors, so
 * every fork maps to the taxonomy's own sector label. HAND-VERIFIED on
 * 2026-09-04 by joining every forked row to this sheet on ISIN:
 *
 *   AUTOMOBILE                        17/20 → Automobile and Auto Components
 *   CEMENT & CEMENT PRODUCTS           8/8  → Construction Materials
 *   CONSTRUCTION                       case fork of Construction (the legacy
 *                                      label also covered realty names: 3 of
 *                                      its 4 ISINs are Realty today)
 *   CONSUMER GOODS                     9/9  → Consumer Durables (the legacy
 *                                      sector was split into FMCG + Durables;
 *                                      every ISIN still carrying it is Durables)
 *   FINANCIAL SERVICES                15/15 → Financial Services
 *   INDUSTRIAL MANUFACTURING           NSE renamed this sector Capital Goods
 *                                      (3 of its 6 ISINs are Auto today)
 *   METALS                             3/3  → Metals & Mining
 *   Media Entertainment & Publication  comma fork (30/30)
 *   OIL & GAS                          4/4  → Oil, Gas & Consumable Fuels
 *   Oil Gas & Consumable Fuels         comma fork (120/120) — also what
 *                                      scripts/build-nse-index-map.mjs emits
 *   POWER, SERVICES                    case forks
 *
 * The alias only ever decides a name the taxonomy does NOT know by ISIN — in
 * the chain the taxonomy outranks the index map, so the ambiguous legacy
 * labels (CONSTRUCTION, INDUSTRIAL MANUFACTURING) affect at most the handful
 * of names that have no company-level classification. With `--indices` the
 * script verifies that every Industry value in the folder is either a
 * taxonomy sector or an alias, so a new fork fails the build instead of
 * silently becoming a 24th sector.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const srcFile = positional[0] ?? null;
const indicesDir = opt("--indices");
const outPath = opt("--out", path.join(root, "lib", "data", "sector-map.json"));

if (!srcFile || !fs.existsSync(srcFile)) {
  console.error("Usage: node scripts/build-sector-map.mjs <classification-reconciliation-multisource.csv> [--indices <folder>] [--as-of YYYY-MM-DD] [--out file.json]");
  process.exit(1);
}

/** Index-CSV `Industry` label → the taxonomy's `sector` label. See header. */
const SECTOR_ALIASES = {
  "AUTOMOBILE": "Automobile and Auto Components",
  "CEMENT & CEMENT PRODUCTS": "Construction Materials",
  "CONSTRUCTION": "Construction",
  "CONSUMER GOODS": "Consumer Durables",
  "FINANCIAL SERVICES": "Financial Services",
  "INDUSTRIAL MANUFACTURING": "Capital Goods",
  "METALS": "Metals & Mining",
  "Media Entertainment & Publication": "Media, Entertainment & Publication",
  "OIL & GAS": "Oil, Gas & Consumable Fuels",
  "Oil Gas & Consumable Fuels": "Oil, Gas & Consumable Fuels",
  "POWER": "Power",
  "SERVICES": "Services",
};

const EXCLUDED_STATUS = "unmatched_no_company_level_classification";
const CONFIDENCE = ["high", "medium_high", "medium"];
const ISIN_RE = /^IN[A-Z0-9]{10}$/;

/** RFC-4180-ish: quoted cells may carry commas and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const raw = fs.readFileSync(srcFile);
const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
const rows = parseCsv(raw.toString("utf8").replace(/^﻿/, ""));
const header = rows[0].map((h) => h.trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`column "${name}" missing — header: ${header.join(", ")}`);
  return i;
};
const C = {
  symbol: col("symbol"), isin: col("isin"), status: col("status"), source: col("source"),
  confidence: col("confidence"), bse: col("bse_code"), macro: col("macro_sector"), sector: col("sector"),
  industry: col("industry"), basic: col("basic_industry"), code: col("taxonomy_code"),
};

const asOf = opt("--as-of", fs.statSync(srcFile).mtime.toISOString().slice(0, 10));

const count = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const byStatus = new Map(), bySource = new Map(), byConfidence = new Map();
const taxonomy = new Map(); // code → [macro, sector, industry, basic]
const byIsin = new Map();   // ISIN → [sym, bse, code, conf, src]
const legend = new Map();   // source string → one-letter key
let excluded = 0, dropped = 0;

for (const r of rows.slice(1)) {
  const status = (r[C.status] ?? "").trim();
  count(byStatus, status);
  if (status === EXCLUDED_STATUS) { excluded++; continue; }
  const isin = (r[C.isin] ?? "").trim().toUpperCase();
  const conf = (r[C.confidence] ?? "").trim();
  const code = (r[C.code] ?? "").trim();
  const sector = (r[C.sector] ?? "").trim();
  if (!ISIN_RE.test(isin) || !CONFIDENCE.includes(conf) || !sector) { dropped++; continue; }
  const labels = [r[C.macro], sector, r[C.industry], r[C.basic]].map((s) => (s ?? "").trim());
  // One row (AARADHYA, 2026-09-04) is classified to sector + industry only —
  // no basic industry, hence no taxonomy_code. It is kept under a synthetic
  // "~"-prefixed key built from its labels; readers expose code = null for it.
  const key = code || "~" + labels.join("|");
  const prior = taxonomy.get(key);
  if (prior && prior.join("|") !== labels.join("|")) {
    throw new Error(`taxonomy_code ${key} carries two label sets — the 1:1 assumption this file is built on is broken:\n  ${prior.join(" / ")}\n  ${labels.join(" / ")}`);
  }
  taxonomy.set(key, labels);
  if (byIsin.has(isin)) throw new Error(`ISIN ${isin} appears twice`);
  const source = (r[C.source] ?? "").trim();
  if (!legend.has(source)) legend.set(source, source[0]); // S / B / N — distinct on this sheet
  const bse = (r[C.bse] ?? "").trim();
  byIsin.set(isin, [(r[C.symbol] ?? "").trim().toUpperCase(), /^\d+$/.test(bse) ? bse : "", key, conf, legend.get(source)]);
  count(bySource, source);
  count(byConfidence, conf);
}
if (new Set(legend.values()).size !== legend.size) throw new Error("source legend keys collide: " + [...legend.keys()].join(", "));

// The alias table must land on labels the taxonomy actually uses.
const sectors = new Set([...taxonomy.values()].map((t) => t[1]));
for (const [from, to] of Object.entries(SECTOR_ALIASES)) {
  if (!sectors.has(to)) throw new Error(`alias "${from}" → "${to}" is not a taxonomy sector; sectors are: ${[...sectors].sort().join(" | ")}`);
  if (sectors.has(from)) throw new Error(`alias key "${from}" is itself a taxonomy sector`);
}

// With --indices, every Industry value in the constituent CSVs must be known.
if (indicesDir) {
  const unknown = new Map();
  for (const f of fs.readdirSync(indicesDir).filter((f) => /^ind[_-].*\.csv$/i.test(f))) {
    const rs = parseCsv(fs.readFileSync(path.join(indicesDir, f), "utf8").replace(/^﻿/, ""));
    const h = rs[0].map((x) => x.trim().toUpperCase());
    const ii = h.indexOf("INDUSTRY");
    if (ii < 0) continue;
    for (const r of rs.slice(1)) {
      const v = (r[ii] ?? "").trim();
      if (v && !sectors.has(v) && !(v in SECTOR_ALIASES)) count(unknown, v);
    }
  }
  if (unknown.size) throw new Error(`Industry labels with neither a taxonomy sector nor an alias: ${[...unknown].map(([k, n]) => `${k} (${n})`).join(", ")}`);
  console.log(`  --indices: every Industry value in ${indicesDir} is a taxonomy sector or an alias`);
}

const sortObj = (m) => Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
const out = {
  asOf,
  source: "Sentinel classification-reconciliation-multisource.csv (NSE 4-level taxonomy; Screener / BSE / NIFTY constituent evidence)",
  provenance: {
    file: path.basename(srcFile),
    sha256,
    rows: rows.length - 1,
    classified: byIsin.size,
    excluded,
    dropped,
    sources: { byStatus: sortObj(byStatus), bySource: sortObj(bySource), byConfidence: sortObj(byConfidence) },
    legend: Object.fromEntries([...legend.entries()].map(([k, v]) => [v, k])),
  },
  fields: {
    taxonomy: ["macro", "sector", "industry", "basic"],
    byIsin: ["sym", "bse", "code", "conf", "src"],
  },
  taxonomy: sortObj(taxonomy),
  byIsin: sortObj(byIsin),
  sectorAliases: SECTOR_ALIASES,
};

const json = JSON.stringify(out, null, 0) + "\n";
const dest = path.resolve(outPath);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, json);

// The flat alternative, measured every build so the choice stays visible.
const flat = JSON.stringify({
  ...out,
  taxonomy: undefined,
  byIsin: Object.fromEntries([...byIsin.entries()].map(([isin, [sym, bse, code, conf, src]]) => {
    const [macro, sector, industry, basic] = taxonomy.get(code);
    return [isin, { sym, bse, macro, sector, industry, basic, code, conf, src: legend.size ? out.provenance.legend[src] : src }];
  })),
});
console.log(`✓ ${dest}`);
console.log(`  ${byIsin.size} classified ISINs (${excluded} excluded, ${dropped} dropped) · ${taxonomy.size} taxonomy keys (${[...taxonomy.keys()].filter((k) => k.startsWith("~")).length} synthetic) · as of ${asOf}`);
console.log(`  macro ${new Set([...taxonomy.values()].map((t) => t[0])).size} / sector ${sectors.size} / industry ${new Set([...taxonomy.values()].map((t) => t[2])).size} / basic ${new Set([...taxonomy.values()].map((t) => t[3])).size}`);
console.log(`  size: normalised ${json.length.toLocaleString("en-IN")} B raw · flat alternative ${flat.length.toLocaleString("en-IN")} B raw`);
console.log(`  sha256 ${sha256}`);
