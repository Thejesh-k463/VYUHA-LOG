/**
 * Build lib/data/isin-symbols.json from the exchanges' own listed-security
 * lists, so a file that states an ISIN and a numeric scrip code can be shown
 * under a real ticker.
 *
 *   node scripts/build-isin-symbols.mjs --fetch            # download + build (normal refresh)
 *   node scripts/build-isin-symbols.mjs --src "path/to/lists" [--as-of YYYY-MM-DD] [--out file.json]
 *
 * `--out` exists for tests: they build a synthetic folder and assert on the
 * result without touching the committed snapshot.
 *
 * `--fetch` downloads the three lists into `--src` (default: a temp folder)
 * from the URLs in SOURCES below and then builds. The URLs live HERE rather
 * than in a runbook so a refresh is one command and the provenance of the
 * committed JSON is readable in the repo. If a URL 404s, NSE or BSE moved it:
 * fix it here, in the commit that re-snapshots.
 *
 * The committed JSON is a SNAPSHOT, exactly like lib/data/nse-index-map.json:
 * the as-of date lives in the file, and the only way to refresh it is to
 * re-download the lists and re-run this script. NEVER hand-edit the JSON — a
 * hand-added row has no provenance, and a wrong ISIN→ticker mapping silently
 * merges two companies' trades into one position, which is the single worst
 * thing this module can do.
 *
 * ── Which files it reads ──────────────────────────────────────────────────
 *
 * Any .csv in --src. Columns are matched by NAME, not position, because NSE
 * ships real files whose headers carry leading spaces (" SERIES", " ISIN
 * NUMBER") and BSE has renamed columns between downloads.
 *
 *   NSE main board   EQUITY_L.csv        SYMBOL + ISIN NUMBER      (2,559 ISINs)
 *   NSE SME (Emerge) SME_EQUITY_L.csv    SYMBOL + ISIN_NUMBER      (  565)
 *   BSE all scrips   bse-scrips.json     scrip_id + ISIN_NUMBER    (2,547 new)
 *
 * NSE ships those two CSVs with DIFFERENT header conventions — EQUITY_L.csv
 * has leading spaces (" ISIN NUMBER"), SME_EQUITY_L.csv uses underscores
 * ("ISIN_NUMBER") — which is why headers are normalised rather than matched
 * literally. BSE serves JSON from its API, not a CSV: the CSV on
 * bseindia.com/corporates/List_Scrips.html is generated in the browser from
 * this same payload, so the API is the source with fewer moving parts.
 *
 * ── The two rules that matter ─────────────────────────────────────────────
 *
 * 1. NSE WINS a collision. A security listed on both exchanges has one ISIN
 *    and two tickers, and every other Vyuha surface — the index map, the
 *    bhavcopy, corporate actions, the surveillance list — is keyed on the NSE
 *    symbol. Preferring BSE's Security Id would produce a ticker that is
 *    correct on screen and matches nothing downstream. Load order is therefore
 *    forced (NSE files first) rather than left to readdir.
 *
 * 2. EQUITY ONLY, and only what is live. BSE's list carries debt, mutual-fund
 *    units, warrants and delisted rows; mapping a trade to a delisted ticker
 *    that has since been REISSUED to another company is exactly the silent
 *    merge described above. Rows are kept only when Status is Active and the
 *    Instrument reads as equity. NSE's lists are equity-only by construction,
 *    so nothing is filtered there.
 *
 * ── What each row keeps (v3.8) ────────────────────────────────────────────
 *
 * `byIsin[ISIN] = [SYMBOL, NAME, BOARD, BSE_CODE, SERIES]` — a positional
 * tuple, documented in the file's `fields`. Measured on the same 5,7xx rows,
 * an object per row (`{s,n,b,bc,sr}`) costs ~150 KB more raw for the same
 * gzip, and five parallel ISIN-keyed maps repeat every 12-char key five
 * times; the tuple was the smallest of the three. Column meanings:
 *
 *   NAME      the exchange's company name (NSE's when NSE won the ISIN).
 *   BOARD     "nse" main board · "sme" NSE Emerge · "bse" BSE-only listing.
 *   BSE_CODE  BSE's numeric SCRIP_CD — kept EVEN WHEN NSE WON the ISIN, so a
 *             file that states a BSE code resolves to the NSE ticker. It is
 *             the CODE that is unique on BSE, never the ticker: FOCUS, HSIL
 *             and KALYANI are different companies on NSE and on BSE.
 *   SERIES    NSE series (EQ/BE/SM/ST…) or, for a BSE-only row, BSE's GROUP
 *             (A/B/M/MT/T/X/XT…) — the nearest thing BSE has to a series.
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
const wantFetch = args.includes("--fetch");
const src = opt("--src", wantFetch ? path.join(root, ".isin-lists") : null);
const asOf = opt("--as-of", new Date().toISOString().slice(0, 10));
const outPath = opt("--out", path.join(root, "lib", "data", "isin-symbols.json"));

/**
 * Where the three lists come from. Both hosts serve these to a plain client
 * with a browser User-Agent; NSE's archive host needs no cookie, and BSE's API
 * needs a Referer. Verified working 2026-08-30.
 */
const SOURCES = [
  {
    file: "EQUITY_L.csv",
    url: "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
    headers: { Referer: "https://www.nseindia.com/market-data/securities-available-for-trading" },
  },
  {
    file: "SME_EQUITY_L.csv",
    // NOT under /content/equities/ — that path returns a 224-byte error page
    // with a 200 status, which is exactly how a silent empty snapshot happens.
    url: "https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv",
    headers: { Referer: "https://www.nseindia.com/emerge/market-data-active-securities" },
  },
  {
    file: "bse-scrips.json",
    url: "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active",
    // `segment` must be non-empty: blank returns an empty array, not everything.
    // "Equity" already includes the BSE SME board.
    headers: { Referer: "https://www.bseindia.com/corporates/List_Scrips.html" },
  },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchLists(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of SOURCES) {
    const res = await fetch(s.url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...s.headers } });
    if (!res.ok) throw new Error(`${s.file}: HTTP ${res.status} from ${s.url}`);
    const body = Buffer.from(await res.arrayBuffer());
    // A 200 carrying an error page is the failure mode that matters: it builds
    // a snapshot that looks fine and resolves nothing.
    if (body.length < 2000) throw new Error(`${s.file}: only ${body.length} bytes — the URL has moved or is serving an error page.`);
    fs.writeFileSync(path.join(dir, s.file), body);
    console.log(`  ↓ ${s.file} — ${body.length.toLocaleString("en-IN")} bytes`);
  }
}

if (wantFetch) {
  console.log(`Downloading listing files into ${src}`);
  await fetchLists(src);
}

if (!src || !fs.existsSync(src)) {
  console.error("Usage: node scripts/build-isin-symbols.mjs --fetch");
  console.error("   or: node scripts/build-isin-symbols.mjs --src <folder of EQUITY_L.csv / SME_EQUITY_L.csv / bse-scrips.json> [--as-of YYYY-MM-DD]");
  process.exit(1);
}

const ISIN_RE = /^IN[A-Z0-9]{10}$/;
/** A ticker, not a code: BSE's Security Id is alphabetic, its Security Code is not. */
const TICKER_RE = /^[A-Z0-9&*-]{1,20}$/;

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

/**
 * NSE files load first so rule 1 (NSE wins) holds regardless of readdir order.
 * Anything unrecognised loads last and can only fill gaps.
 */
function loadOrder(file) {
  const f = path.basename(file).toUpperCase();
  if (f.includes("SME") || f.includes("EMERGE")) return 1; // NSE SME
  if (f.includes("EQUITY_L")) return 0;                    // NSE main board
  if (f.includes("SCRIP") || f.includes("BSE")) return 3;  // BSE
  return 2;
}
/** Which board a file describes, from the same filename rules as loadOrder. */
function boardOf(file) {
  const o = loadOrder(file);
  return o === 0 ? "nse" : o === 1 ? "sme" : o === 3 ? "bse" : "nse";
}

/**
 * BSE's payload as rows: `scrip_id` is the ticker ("ABB"), `SCRIP_CD` the
 * numeric code we are trying to get RID of, so the ticker column is named
 * explicitly rather than guessed.
 */
function readJsonRows(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const arr = Array.isArray(raw) ? raw : (raw.Table ?? Object.values(raw).find(Array.isArray));
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const header = Object.keys(arr[0]);
  return [header, ...arr.map((r) => header.map((h) => (r[h] == null ? "" : String(r[h]).trim())))];
}

const files = fs
  .readdirSync(src)
  .filter((f) => /\.(csv|json)$/i.test(f))
  .sort((a, b) => loadOrder(a) - loadOrder(b) || a.localeCompare(b));

if (files.length === 0) {
  console.error("✗ no CSVs in", src);
  process.exit(1);
}

const byIsin = new Map(); // ISIN → [SYMBOL, NAME, BOARD, BSE_CODE, SERIES] (first writer wins, given the load order)
const seenBseCodes = new Map(); // BSE code → ISIN, so a reused code is caught rather than silently re-pointed
const provenance = [];
let skippedInactive = 0, skippedNonEquity = 0, skippedNoIsin = 0, bseCodesAttached = 0;

for (const f of files) {
  const full = path.join(src, f);
  const rows = /\.json$/i.test(f)
    ? readJsonRows(full)
    : parseCsv(fs.readFileSync(full, "utf8").replace(/^﻿/, ""));
  if (rows.length < 2) { console.warn("• skipped (empty):", f); continue; }
  const header = rows[0];

  const iSymbol = findCol(header, "SYMBOL", "scrip_id", "Security Id", "SecurityId", "TradingSymbol");
  const iIsin = findCol(header, "ISIN NUMBER", "ISIN_NUMBER", "ISIN No", "ISIN", "ISIN Code");
  if (iSymbol < 0 || iIsin < 0) {
    console.warn(`• skipped (no symbol/ISIN column): ${f} — headers: ${header.slice(0, 8).join(" | ")}`);
    continue;
  }
  // Present on BSE's list only; absent on NSE's, where every row is a live equity.
  const iStatus = findCol(header, "Status");
  const iInstrument = findCol(header, "Instrument", "Instrument Type", "Segment");
  // NSE: "NAME OF COMPANY" (main) / "NAME_OF_COMPANY" (Emerge). BSE: Issuer_Name
  // is the registered name ("… Limited"), Scrip_Name the display short form.
  const iName = findCol(header, "NAME OF COMPANY", "NAME_OF_COMPANY", "Issuer_Name", "Scrip_Name", "Security Name");
  const iSeries = findCol(header, "SERIES", "GROUP");
  const iBseCode = findCol(header, "SCRIP_CD", "Security Code", "Scrip Code");
  const board = boardOf(f);

  let added = 0, seen = 0;
  for (const r of rows.slice(1)) {
    const isin = String(r[iIsin] ?? "").trim().toUpperCase();
    const symbol = String(r[iSymbol] ?? "").trim().toUpperCase();
    if (!ISIN_RE.test(isin)) { skippedNoIsin++; continue; }
    if (!TICKER_RE.test(symbol) || /^\d+$/.test(symbol)) { skippedNoIsin++; continue; }
    seen++;
    if (iStatus >= 0 && !/^active$/i.test(String(r[iStatus] ?? "").trim())) { skippedInactive++; continue; }
    if (iInstrument >= 0) {
      const ins = String(r[iInstrument] ?? "").trim().toUpperCase();
      // BSE segment/instrument values: Equity / Debt / MF / Preference Shares…
      if (ins && !/EQUIT/.test(ins)) { skippedNonEquity++; continue; }
    }
    const name = iName >= 0 ? String(r[iName] ?? "").trim() : "";
    const series = iSeries >= 0 ? String(r[iSeries] ?? "").trim().toUpperCase() : "";
    const bseCode = iBseCode >= 0 ? String(r[iBseCode] ?? "").trim() : "";
    if (bseCode && !/^\d{5,7}$/.test(bseCode)) { skippedNoIsin++; continue; }
    if (bseCode) {
      const prior = seenBseCodes.get(bseCode);
      if (prior && prior !== isin) throw new Error(`BSE code ${bseCode} appears under two ISINs (${prior}, ${isin}) — refusing to build`);
      seenBseCodes.set(bseCode, isin);
    }
    const existing = byIsin.get(isin);
    if (existing) {
      // rule 1: first writer wins, NSE files first. The BSE CODE is still
      // attached, because a BSE-coded file must resolve to the NSE ticker.
      if (bseCode && !existing[3]) { existing[3] = bseCode; bseCodesAttached++; }
      if (!existing[1] && name) existing[1] = name;
      continue;
    }
    byIsin.set(isin, [symbol, name, board, bseCode, series]);
    added++;
  }
  provenance.push({ file: path.basename(f), board, rows: seen, added, dated: fs.statSync(full).mtime.toISOString().slice(0, 10) });
  console.log(`  ${path.basename(f)}: ${seen} usable rows → ${added} new ISINs`);
}

if (byIsin.size === 0) {
  console.error("✗ no ISIN→symbol pairs found — check the input files");
  process.exit(1);
}

const out = {
  asOf,
  source: "Exchange listed-security lists (NSE EQUITY_L / SME_EQUITY_L, BSE ListOfScrips)",
  files: provenance,
  count: byIsin.size,
  bseCodes: seenBseCodes.size,
  /** Positions in each byIsin tuple. Readers key on this, not on memory. */
  fields: ["symbol", "name", "board", "bseCode", "series"],
  // Sorted so a refresh produces a minimal, reviewable diff.
  byIsin: Object.fromEntries([...byIsin.entries()].sort(([a], [b]) => a.localeCompare(b))),
};

const dest = path.resolve(outPath);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 0) + "\n");
console.log(`✓ ${dest}`);
console.log(`  ${byIsin.size} ISINs from ${provenance.length} file(s) · as of ${asOf}`);
console.log(`  ${seenBseCodes.size} BSE codes (${bseCodesAttached} attached to an ISIN NSE had already won)`);
console.log(`  skipped: ${skippedInactive} inactive, ${skippedNonEquity} non-equity, ${skippedNoIsin} without a usable ISIN/ticker/code`);
