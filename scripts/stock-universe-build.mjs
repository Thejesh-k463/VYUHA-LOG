/**
 * The BUILD half of scripts/build-stock-universe.mjs: reconcile the crawl cache,
 * AMFI's cap-band workbook and NSE Indices' structure into
 * lib/data/stock-universe.json, and refuse a snapshot that fails its own proof.
 * Split out so tests can drive `reconcile()` and `build()` on synthetic inputs
 * without a crawl (v4.6.0 W2; research R3 §4 steps 4–6).
 *
 * Rules (each is asserted by tests/stock-universe.test.ts):
 *  - Every label is validated against scripts/ics-structure-2023-07.json, after
 *    folding case, spaces and punctuation ("Residential, Commercial Projects" and
 *    "Residential Commercial Projects" are one label). Emitted labels are the
 *    STRUCTURE's spelling, stored as its code.
 *  - A side is used at the deepest level whose stated ancestors agree with the
 *    structure's tree; ALL-CAPS labels are NSE's legacy (pre-2022) scheme and are
 *    never used (SAYAJIHOTL in research) — the other exchange's label wins.
 *  - Both exchanges agree (or one is the other's ancestor) → "nse+bse"; they
 *    disagree → NSE's (the NSE-wins rule) and a DQ line; neither validates → blank.
 *  - A mixed-case label outside the structure FAILS THE BUILD unless it is in
 *    LABEL_ALLOWLIST with a reason — a new taxonomy revision must fail loudly.
 *  - Cap band = AMFI's categorisation (ruling U2), joined by ISIN, then by the
 *    NSE symbol, then by the BSE symbol (a face-value split reissues the ISIN; each
 *    fallback is counted in DQ). NSE Emerge is never banded (U3): blank + reason.
 *  - ETFs (INF…) carry no classification or band — etf-list.json owns them (U4).
 *  - Floors: ≥ 95% of equity ISINs classified; exchange agreement ≥ 90% where both
 *    classify; an AMFI period end no older than 7 months. Below any floor the build
 *    refuses and the previous snapshot stays.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

export const COVERAGE_FLOOR = 0.95;
export const AGREEMENT_FLOOR = 0.9;
export const AMFI_MAX_AGE_MONTHS = 7;

/** Labels outside the structure that are KNOWN and deliberately left blank. `{ normalisedLabel: reason }`. */
export const LABEL_ALLOWLIST = {
  // 2026-09-25 crawl: NSE's basic label for BATLIBOI (INE177C01022, "permitted to trade" from 2026-04-20). The
  // 2023-07 structure has no such basic industry. NSE's label still validates up to the industry (Industrial
  // Manufacturing), and BSE's basic ("Industrial Products", IN070204008) sits under it, so the ancestor rule keeps
  // BSE's deeper code as "nse+bse" — the NSE basic is simply not used, never mapped by guesswork.
  industrialequipments: "NSE basic label outside the 2023-07 structure (one company); BSE's validating basic is used",
};

/** U3's wording, shown wherever an Emerge stock's band would be. */
export const REASONS = {
  "nse-emerge": "SME — not ranked by AMFI",
  "post-period-listing": "Listed after AMFI's averaging period ended",
  "not-in-amfi": "Not in AMFI's list",
};

/** One issuer: same country + issuer code (ISIN characters 1-7). A split or reissue keeps it; another company cannot. */
export const sameIssuer = (a, b) => String(a ?? "").slice(0, 7).toUpperCase() === String(b ?? "").slice(0, 7).toUpperCase() && String(a ?? "").length === 12;
export const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const isLegacy = (s) => /[A-Z]{4}/.test(s) && s === s.toUpperCase();
const CODE_LEN = [4, 6, 8, 11];

/** Structure JSON → per-level lookup (normalised label → code) + code → label. */
export function indexStructure(ics) {
  const levels = [ics.macro, ics.sector, ics.industry, ics.basic];
  const byKey = levels.map((rows) => new Map(rows.map((r) => [norm(r.label), r.code])));
  const label = new Map(levels.flat().map((r) => [r.code, r.label]));
  return { byKey, label };
}

/**
 * One exchange's four labels → the deepest structure code whose ancestors agree with every label the
 * exchange stated above it. `{ code, depth, legacy, unknown[] }`; code null when nothing validates.
 */
export function resolveSide(labels, idx) {
  const out = { code: null, depth: -1, legacy: false, unknown: [] };
  if (!labels) return out;
  const stated = [labels.macro, labels.sector, labels.industry, labels.basic].map((v) => (v == null ? null : String(v).trim() || null));
  if (stated.some((v) => v && isLegacy(v))) {
    out.legacy = true;
    return out;
  }
  const codes = stated.map((v, i) => (v ? idx.byKey[i].get(norm(v)) ?? null : null));
  stated.forEach((v, i) => {
    if (v && !codes[i]) out.unknown.push({ level: i, label: v });
  });
  for (let d = 3; d >= 0; d--) {
    const c = codes[d];
    if (!c) continue;
    let ok = true;
    for (let up = 0; up < d; up++) if (codes[up] && codes[up] !== c.slice(0, CODE_LEN[up])) ok = false;
    // a stated label BETWEEN that did not validate is not a contradiction — it is recorded as unknown
    if (ok) {
      out.code = c;
      out.depth = d;
      return out;
    }
  }
  return out;
}

/** Two sides → one classification: `{ code, source, disagreement? }`. */
export function reconcileSides(n, b) {
  if (n.code && b.code) {
    if (n.code === b.code) return { code: n.code, source: "nse+bse" };
    if (n.code.startsWith(b.code)) return { code: n.code, source: "nse+bse" };
    if (b.code.startsWith(n.code)) return { code: b.code, source: "nse+bse" };
    return { code: n.code, source: "nse", disagreement: true };
  }
  if (n.code) return { code: n.code, source: "nse" };
  if (b.code) return { code: b.code, source: "bse" };
  return { code: null, source: null };
}

/** AMFI workbook rows (header row found by name) → { byIsin, byNse, byBse, periodEnd }. */
export function readAmfi(file) {
  const require = createRequire(import.meta.url);
  const XLSX = require("xlsx");
  const wb = XLSX.read(fs.readFileSync(file));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const title = String(rows[0]?.[0] ?? "");
  const MON = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  const pm = title.match(/ended\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i);
  const periodEnd = pm && MON[pm[2].toLowerCase()] != null ? new Date(Date.UTC(+pm[3], MON[pm[2].toLowerCase()], +pm[1])).toISOString().slice(0, 10) : null;
  const h = rows.findIndex((r) => Array.isArray(r) && r.some((c) => norm(c) === "isin"));
  if (h < 0) throw new Error(`${file}: no header row with an ISIN column`);
  const header = rows[h].map(norm);
  const col = (pred) => header.findIndex(pred);
  const cRank = col((c) => c.startsWith("srno"));
  const cIsin = col((c) => c === "isin");
  const cBse = col((c) => c === "bsesymbol");
  const cNse = col((c) => c === "nsesymbol");
  const cCat = col((c) => c.startsWith("categori"));
  if ([cRank, cIsin, cNse, cCat].some((i) => i < 0)) throw new Error(`${file}: expected columns missing (${rows[h].join(" | ")})`);
  const band = (s) => ({ largecap: "large", midcap: "mid", smallcap: "small" })[norm(s)] ?? null;
  const byIsin = new Map();
  const byNse = new Map();
  const byBse = new Map();
  let n = 0;
  for (const r of rows.slice(h + 1)) {
    const isin = String(r[cIsin] ?? "").trim().toUpperCase();
    const b = band(r[cCat]);
    if (!/^IN[A-Z0-9]{10}$/.test(isin) || !b) continue;
    const e = { isin, rank: Number(r[cRank]), band: b, nse: String(r[cNse] ?? "").trim().toUpperCase(), bse: cBse >= 0 ? String(r[cBse] ?? "").trim().toUpperCase() : "" };
    n++;
    if (!byIsin.has(isin)) byIsin.set(isin, e);
    if (e.nse && e.nse !== "-" && !byNse.has(e.nse)) byNse.set(e.nse, e);
    if (e.bse && e.bse !== "-" && !byBse.has(e.bse)) byBse.set(e.bse, e);
  }
  return { byIsin, byNse, byBse, periodEnd, rows: n };
}

const readJsonl = (file) => {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r?.k != null) out.set(String(r.k), r);
    } catch {
      /* torn last line of a killed run */
    }
  }
  return out;
};
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
/** sha256 of the canonical JSON — the same on every platform whatever the file's line endings. */
export const contentDigest = (obj) => sha256(JSON.stringify(obj));

const parseNseDate = (s) => {
  const m = String(s ?? "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const mo = MON[m[2].toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
};

/**
 * Pure reconciliation over already-loaded inputs. Returns `{ json, report, failures[] }`; the caller
 * writes the file only when `failures` is empty.
 */
export function reconcile({ snap, nse, bse, amfi, ics, prev, capturedAt, provenance }) {
  const idx = indexStructure(ics);
  const failures = [];
  const unknownLabels = new Map(); // norm → { label, level, count, example }
  const dq = { unclassified: [], disagreements: [], legacyLabels: [], partial: 0, isinMismatch: [], capUnmatched: {}, capFallback: { nse: 0, bse: 0, rejected: 0 } };
  const byIsin = {};
  const aliases = {};
  let equity = 0;
  let classified = 0;
  let both = 0;
  let agree = 0;
  const bands = { large: 0, mid: 0, small: 0 };

  for (const [isin, row] of Object.entries(snap.byIsin)) {
    const [symbol, , board, bseCode] = row;
    const n = board === "nse" || board === "sme" ? nse.get(symbol) : undefined;
    const b = bseCode ? bse.get(String(bseCode)) : undefined;
    const etf = isin.startsWith("INF");
    const sme = board === "sme" || (b?.group && /^(M|MT)$/i.test(String(b.group)));
    const assetClass = etf ? "etf" : sme ? "sme-equity" : "equity";

    if (n?.meta?.isin && n.meta.isin !== isin) dq.isinMismatch.push({ isin, exchange: "nse", stated: n.meta.isin, symbol });
    if (b?.bseIsin && b.bseIsin !== isin) dq.isinMismatch.push({ isin, exchange: "bse", stated: b.bseIsin, code: String(bseCode) });

    const status = n?.meta?.isDelisted === "true" ? "delisted" : n?.meta?.isSuspended === "true" ? "suspended" : "active";

    let cls = { code: null, source: null };
    if (!etf) {
      equity++;
      const ns = resolveSide(n?.labels, idx);
      const bs = resolveSide(b?.labels, idx);
      for (const side of [ns, bs]) {
        for (const u of side.unknown) {
          const k = norm(u.label);
          if (LABEL_ALLOWLIST[k]) continue;
          const cur = unknownLabels.get(k) ?? { label: u.label, level: u.level, count: 0, example: isin };
          cur.count++;
          unknownLabels.set(k, cur);
        }
      }
      if (ns.legacy) dq.legacyLabels.push({ isin, exchange: "nse", labels: n.labels });
      if (bs.legacy) dq.legacyLabels.push({ isin, exchange: "bse", labels: b.labels });
      cls = reconcileSides(ns, bs);
      if (ns.code && bs.code) {
        both++;
        if (!cls.disagreement) agree++;
      }
      if (cls.disagreement) dq.disagreements.push({ isin, nse: ns.code, bse: bs.code });
      if (cls.code) {
        classified++;
        if (cls.code.length < 11) dq.partial++;
      } else dq.unclassified.push(isin);
    }

    // Cap band (U2/U3). NSE Emerge is never banded; ETFs are out of scope.
    let capBand = null;
    let capRank = null;
    let capReason = null;
    if (etf) {
      capReason = null;
    } else if (board === "sme") {
      capReason = "nse-emerge";
    } else {
      let hit = amfi.byIsin.get(isin);
      // A fallback join by ticker must stay inside ONE issuer: a ticker is not an identity (BSE-only and Emerge
      // companies share tickers), so a hit whose ISIN names a different issuer is another company — no band,
      // no alias. A face-value split keeps the issuer code (ISIN characters 1–7) and changes only the serial.
      const fallback = (via, cand) => {
        if (!cand) return null;
        if (!sameIssuer(cand.isin, isin)) {
          dq.capFallback.rejected++;
          return null;
        }
        dq.capFallback[via]++;
        if (cand.isin !== isin) aliases[cand.isin] = isin;
        return cand;
      };
      if (!hit && symbol) hit = fallback("nse", amfi.byNse.get(symbol));
      const bseSym = b?.securityId ? String(b.securityId).toUpperCase() : null;
      if (!hit && bseSym) hit = fallback("bse", amfi.byBse.get(bseSym));
      if (hit) {
        capBand = hit.band;
        capRank = hit.rank;
        bands[hit.band]++;
      } else {
        const listed = parseNseDate(n?.listingDate);
        capReason = listed && amfi.periodEnd && listed > amfi.periodEnd ? "post-period-listing" : "not-in-amfi";
      }
    }
    if (capReason) dq.capUnmatched[capReason] = (dq.capUnmatched[capReason] ?? 0) + 1;

    byIsin[isin] = [cls.code, cls.source, assetClass, status, capBand, capRank, capReason];
  }

  // ── proofs ──
  for (const u of unknownLabels.values()) {
    failures.push(`label outside the structure (${["macro", "sector", "industry", "basic"][u.level]}): "${u.label}" ×${u.count} (e.g. ${u.example}) — add it to LABEL_ALLOWLIST with a reason, or update the structure`);
  }
  const coverage = equity ? classified / equity : 0;
  if (coverage < COVERAGE_FLOOR) failures.push(`coverage ${(coverage * 100).toFixed(1)}% of ${equity} equity ISINs is below the ${COVERAGE_FLOOR * 100}% floor — is the crawl complete?`);
  const agreement = both ? agree / both : 1;
  if (both >= 50 && agreement < AGREEMENT_FLOOR) failures.push(`exchange agreement ${(agreement * 100).toFixed(1)}% over ${both} dual-classified ISINs is below the ${AGREEMENT_FLOOR * 100}% floor`);
  if (!amfi.periodEnd) failures.push("AMFI workbook: its period end could not be read from the title row");
  else {
    const ageMonths = (Date.parse(capturedAt) - Date.parse(amfi.periodEnd)) / (30.44 * 86400000);
    if (ageMonths > AMFI_MAX_AGE_MONTHS) failures.push(`AMFI period end ${amfi.periodEnd} is ${ageMonths.toFixed(1)} months before ${capturedAt} (max ${AMFI_MAX_AGE_MONTHS}) — fetch the newer list`);
  }

  // Effective-dated history: a changed classification or band vs the previous snapshot becomes a row dated
  // at THIS capture (exchanges publish no reclassification date — provenance says so, never an invented one).
  const history = Array.isArray(prev?.history) ? [...prev.history] : [];
  if (prev?.byIsin) {
    for (const [isin, r] of Object.entries(byIsin)) {
      const old = prev.byIsin[isin];
      if (!old) continue;
      if (old[0] !== r[0]) history.push({ isin, field: "cls", from: old[0], to: r[0], effectiveFrom: capturedAt, source: r[1] });
      if (old[4] !== r[4]) history.push({ isin, field: "capBand", from: old[4], to: r[4], effectiveFrom: capturedAt, source: "amfi" });
    }
  }

  const effectiveFrom = amfi.periodEnd ? nextHalfStart(amfi.periodEnd) : null;
  const taxonomy = { name: ics.name, version: ics.version, sha256: ics.provenance?.sha256 ?? null, nodes: Object.fromEntries(idx.label) };
  const body = {
    schema: 1,
    asOf: capturedAt,
    capturedAt,
    listsAsOf: snap.asOf,
    taxonomy,
    cap: {
      source: "AMFI Average Market Capitalisation (SEBI circular 6 Oct 2017)",
      periodEnd: amfi.periodEnd,
      effectiveFrom,
      note: "The list governs the half-year after its period end; AMFI states only the averaging period.",
      reasons: REASONS,
    },
    provenance,
    fields: ["cls", "clsSource", "assetClass", "status", "capBand", "capRank", "capReason"],
    byIsin,
    aliases,
    history,
    dq: {
      equity,
      classified,
      coverage: Math.round(coverage * 10000) / 10000,
      dualClassified: both,
      agreement: Math.round(agreement * 10000) / 10000,
      bands,
      partial: dq.partial,
      capUnmatched: dq.capUnmatched,
      capFallback: dq.capFallback,
      unclassified: dq.unclassified,
      disagreements: dq.disagreements,
      legacyLabels: dq.legacyLabels.length,
      isinMismatch: dq.isinMismatch,
      reclassificationDates: "Exchanges publish no effective date for a re-classification; a change is dated at the capture that first saw it.",
    },
  };
  const json = { ...body, digest: contentDigest({ taxonomy: body.taxonomy, byIsin: body.byIsin, aliases: body.aliases }) };
  return { json, failures, report: { equity, classified, coverage, both, agreement, bands, unknown: unknownLabels.size } };
}

/** 30 Jun → 1 Jul; 31 Dec → 1 Jan of the next year. */
function nextHalfStart(periodEnd) {
  const d = new Date(`${periodEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function build({ root, cache, amfi: amfiArg, out, allowPartial = false, capturedAt }) {
  const snap = JSON.parse(fs.readFileSync(path.join(root, "lib/data/isin-symbols.json"), "utf8"));
  const ics = JSON.parse(fs.readFileSync(path.join(root, "scripts/ics-structure-2023-07.json"), "utf8"));
  const outFile = out ?? path.join(root, "lib/data/stock-universe.json");
  const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
  const nse = readJsonl(path.join(cache, "nse.jsonl"));
  const bse = readJsonl(path.join(cache, "bse.jsonl"));
  const run = fs.existsSync(path.join(cache, "run.json")) ? JSON.parse(fs.readFileSync(path.join(cache, "run.json"), "utf8")) : {};
  if (run.listsAsOf && run.listsAsOf !== snap.asOf) throw new Error(`the crawl was run for the listing snapshot of ${run.listsAsOf}, but isin-symbols.json is ${snap.asOf} — re-crawl`);

  const amfiFile = amfiArg ?? fs.readdirSync(cache).filter((f) => /^AverageMarketCapitali[sz]ation.*\.xlsx$/i.test(f)).map((f) => path.join(cache, f))[0];
  if (!amfiFile) throw new Error("no AMFI workbook in the cache — run --crawl, or pass --amfi <file>");
  const amfiBuf = fs.readFileSync(amfiFile);
  const amfiMeta = fs.existsSync(amfiFile + ".json") ? JSON.parse(fs.readFileSync(amfiFile + ".json", "utf8")) : {};
  const amfi = readAmfi(amfiFile);

  const count = (m) => [...m.values()].reduce((a, r) => ((a[r.st] = (a[r.st] ?? 0) + 1), a), {});
  const cap = capturedAt ?? new Date().toISOString().slice(0, 10);
  const provenance = [
    { id: "isin-symbols", file: "lib/data/isin-symbols.json", asOf: snap.asOf, rows: Object.keys(snap.byIsin).length, note: "the crawl's targets; the universe carries no symbols of its own" },
    { id: "nse-getMetaData+getSymbolData", url: "https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi", fetchedFrom: run.startedAt ?? null, fetchedTo: run.finishedAt ?? null, calls: run.nseCalls ?? null, answers: count(nse) },
    { id: "bse-ComHeadernew", url: "https://api.bseindia.com/BseIndiaAPI/api/ComHeadernew/w", fetchedFrom: run.startedAt ?? null, fetchedTo: run.finishedAt ?? null, calls: run.bseCalls ?? null, answers: count(bse) },
    { id: "amfi", url: amfiMeta.url ?? null, file: path.basename(amfiFile), lastModified: amfiMeta.lastModified ?? null, periodEnd: amfi.periodEnd, sha256: sha256(amfiBuf), rows: amfi.rows },
    { id: "structure", url: ics.provenance?.url ?? null, file: ics.provenance?.file ?? null, version: ics.version, sha256: ics.provenance?.sha256 ?? null, rows: ics.basic.length },
  ];

  const { json, failures, report } = reconcile({ snap, nse, bse, amfi, ics, prev, capturedAt: cap, provenance });
  console.log(`Universe for ${snap.asOf}: ${report.classified}/${report.equity} equity ISINs classified (${(report.coverage * 100).toFixed(1)}%), exchange agreement ${(report.agreement * 100).toFixed(1)}% over ${report.both}`);
  console.log(`  AMFI ${amfi.periodEnd}: large ${report.bands.large} · mid ${report.bands.mid} · small ${report.bands.small}; unmatched ${JSON.stringify(json.dq.capUnmatched)}; fallback ${JSON.stringify(json.dq.capFallback)}`);
  console.log(`  DQ: ${json.dq.disagreements.length} disagreements, ${json.dq.legacyLabels} legacy labels, ${json.dq.partial} partial, ${json.dq.isinMismatch.length} ISIN mismatches, ${Object.keys(json.aliases).length} aliases`);
  if (failures.length && !allowPartial) {
    console.error(`✗ refused — ${failures.length} failure(s); the previous snapshot stays:\n  ` + failures.slice(0, 40).join("\n  "));
    process.exitCode = 2;
    return { json, failures };
  }
  if (failures.length) console.warn(`⚠ --allow-partial: writing despite ${failures.length} failure(s) — NEVER commit this file`);
  fs.writeFileSync(outFile, JSON.stringify(json) + "\n");
  console.log(`✓ ${outFile} — ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB, digest ${json.digest.slice(0, 16)}…`);
  return { json, failures };
}
