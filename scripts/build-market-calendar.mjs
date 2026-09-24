/**
 * Build lib/data/market-calendar.json — the ONE effective-dated Indian market
 * calendar (v4.6.0 W1, owner rulings K1–K3, 2026-09-24).
 *
 *   node scripts/build-market-calendar.mjs --src "<folder>" [--as-of YYYY-MM-DD]
 *        [--captured-at YYYY-MM-DD] [--out file.json]
 *
 * The folder is the one the OWNER downloads into (K2):
 *   VYUHA/LIVE-DESK-RESEARCH/_data/market-calendar-2026-09-24/
 * and its DOWNLOAD-LIST.md names every file. Nothing is fetched — NSE archives
 * time out and BSE/MCX refuse an agent (LEDGER L-2); the app itself contacts no
 * host at all.
 *
 * ── How a fact gets in ────────────────────────────────────────────────────
 *
 * The timings are TYPED below, once, by a person reading the circular — PDF
 * tables do not extract into anything a parser could trust. What makes them
 * trustworthy is the ANCHOR: every session row, holiday source and special
 * session names the file it came from and the phrases that file must contain
 * ("3:15 pm to 3:35 pm", "August 03, 2026"). The build extracts each PDF's text
 * and REFUSES TO BUILD when an anchor is missing, so a wrong file under the
 * right name, or a typo in a time here, fails loudly instead of shipping.
 * Holidays are the exception: they are PARSED from the holiday file, because a
 * list of dates is exactly what text extraction does reliably.
 *
 * A row whose source file is absent (DOWNLOAD-LIST items 6, 8, 9, 10 are
 * optional) is built from the research citation and marked
 * `"sourceKind": "secondary"`; /instruments says so. A REQUIRED file absent
 * fails the build, naming it.
 *
 * ── Files ─────────────────────────────────────────────────────────────────
 *
 * Only the names in FILES below are read. `fo_mktlots.csv` is accepted as
 * item 7 because it is the name NSE's own URL (the one DOWNLOAD-LIST gives)
 * saves under. Four more files the owner saved are real NSE circulars and are
 * accepted as SUPPORTING evidence (hashed, anchored, never the only source of
 * a fact). Any other file is REFUSED — listed and ignored, never read.
 *
 * `asOf` is the folder's own date (the day the owner downloaded; it is also
 * the date of the F&O underlyings snapshot, which states none itself);
 * `capturedAt` is the build date. Effective dating per standing rule Q50.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const src = opt("--src");
const outPath = opt("--out", path.join(root, "lib/data/market-calendar.json"));
if (!src || !fs.existsSync(src)) {
  console.error("✗ --src <folder> is required and must exist (VYUHA/LIVE-DESK-RESEARCH/_data/market-calendar-<date>/)");
  process.exit(1);
}
const folderDate = /(\d{4}-\d{2}-\d{2})\/?$/.exec(path.resolve(src).replace(/\\/g, "/"))?.[1] ?? null;
const asOf = opt("--as-of", folderDate);
if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error("✗ the folder name carries no YYYY-MM-DD and no --as-of was given — refusing to date the snapshot by the build date");
  process.exit(1);
}
const capturedAt = opt("--captured-at", new Date().toISOString().slice(0, 10));

/* ───────────────────────────── the file list ──────────────────────────── */

/**
 * id → accepted names, role and whether it is required. Numbers are
 * DOWNLOAD-LIST.md's items; `s-*` are the supporting circulars.
 */
const FILES = [
  { id: "sebi-cas-2026", item: 1, names: ["01-sebi-cas-circular-2026-01-16.pdf"], required: true,
    ref: "SEBI/HO/47/11/11(3)2025-MRD-POD2/I/2765/2026", issued: "2026-01-16",
    url: "https://www.sebi.gov.in/legal/circulars/jan-2026/introduction-of-closing-auction-session-cas-in-the-equity-cash-segment-and-certain-modifications-in-the-pre-open-auction-session_99122.html" },
  { id: "nse-cas-page", item: 2, names: ["02-nse-cas-fno-1540.pdf"], required: true,
    ref: "NSE Closing Auction Session page (lists NSE/CMTR/72394, 73362, 73845, 74466, NSE/FAOP/74467)", issued: null,
    url: "https://www.nseindia.com/" },
  { id: "nse-preopen-page", item: 3, names: ["03-nse-preopen-revised.pdf"], required: true,
    ref: "NSE pre-open session page (revised timings)", issued: null, url: "https://www.nseindia.com/" },
  { id: "nse-fo-preopen", item: 4, names: ["04-nse-fno-preopen.pdf"], required: true,
    ref: "NSE/FAOP/71092", issued: "2025-11-03", url: "https://www.nseindia.com/resources/exchange-communication-circulars" },
  { id: "nse-holidays-2026", item: 5, names: ["05-nse-holidays-2026.pdf"], required: true,
    ref: "NSE trading holidays 2026 — Equities", issued: null, url: "https://www.nseindia.com/resources/exchange-communication-holidays" },
  { id: "nse-special-2026", item: 6, names: ["06-nse-special-sessions-2026.pdf"], required: false,
    ref: "NSE special live trading sessions 2026", issued: null, url: null },
  { id: "nse-fo-underlyings", item: 7, names: ["07-nse-fo-underlyings.csv", "fo_mktlots.csv"], required: true,
    ref: "NSE F&O market lots (one row per underlying)", issued: null,
    url: "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv" },
  { id: "bse-cas", item: 8, names: ["08-bse-cas-notice.pdf"], required: false, ref: "BSE notice 20260610-41", issued: null, url: null },
  { id: "bse-holidays-2026", item: 9, names: ["09-bse-holidays-2026.pdf"], required: false, ref: "BSE trading holidays 2026", issued: null, url: null },
  { id: "mcx-timings", item: 10, names: ["10-mcx-timings.pdf"], required: false, ref: "MCX circular 068/2026", issued: null, url: null },
  // Supporting — saved by the owner beside the list; real NSE circulars.
  { id: "nse-cas-sop", item: "s-1", names: ["02-nse-cas-fno-1540-V1.pdf"], required: false, supporting: true,
    ref: "NSE/CMTR/73362", issued: "2026-03-18", url: null },
  { id: "nse-cas-sop-update", item: "s-2", names: ["CMTR76170.pdf"], required: false, supporting: true,
    ref: "NSE/CMTR/76170", issued: "2026-09-03", url: null },
  { id: "nse-expiry-day", item: "s-3", names: ["FAOP68747.pdf"], required: false, supporting: true,
    ref: "NSE/FAOP/68747", issued: "2025-06-25", url: null },
  { id: "nse-fo-preopen-faq", item: "s-4", names: ["Annexure_FAQs for Pre-Open Session in Equity Derivatives (F&O) Segment.pdf"],
    required: false, supporting: true, ref: "NSE member FAQ, pre-open in equity derivatives, v1.0 (Nov 2025)", issued: null, url: null },
];
const IGNORED = new Set(["DOWNLOAD-LIST.md", "MANIFEST.md", "README.md"]);

/** Research citations for the files the owner did not (have to) supply. */
const SECONDARY = {
  "nse-special-2026": { ref: "NSE/CMTR/72349 (Budget-day session, 2026-02-01) — cited, not opened",
    url: "https://nsearchives.nseindia.com/content/circulars/CMTR72349.pdf",
    research: "VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/research/R4-MARKET-CALENDAR.md §1e" },
  "bse-cas": { ref: "BSE notice 20260610-41 — cited, not opened",
    research: "VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/research/R4-MARKET-CALENDAR.md §1a" },
  "bse-holidays-2026": { ref: "BSE holidays assumed equal to NSE's Equities list — not opened",
    research: "VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/research/R4-MARKET-CALENDAR.md §1e" },
  "mcx-timings": { ref: "MCX circular 068/2026 (US-DST evening close) — cited, not opened",
    url: "https://www.icicidirect.com/ilearn/commodity/articles/mcx-revision-in-trading-hours-from-march-09-2026",
    research: "VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/research/R4-MARKET-CALENDAR.md §1d" },
};

const present = new Map(); // id → { name, abs }
const refused = [];
for (const name of fs.readdirSync(src)) {
  const abs = path.join(src, name);
  if (!fs.statSync(abs).isFile() || IGNORED.has(name)) continue;
  const spec = FILES.find((f) => f.names.includes(name));
  if (!spec) {
    refused.push(name);
    continue;
  }
  if (present.has(spec.id)) {
    console.error(`✗ two files claim item ${spec.item} (${present.get(spec.id).name}, ${name}) — keep one`);
    process.exit(1);
  }
  present.set(spec.id, { name, abs });
}
const missing = FILES.filter((f) => f.required && !present.has(f.id));
if (missing.length) {
  for (const f of missing) console.error(`✗ REQUIRED item ${f.item} missing: save it as ${f.names[0]}`);
  process.exit(1);
}

/* ─────────────────────────── text + hashes ────────────────────────────── */

async function pdfText(buf) {
  const { PDFParse } = require("pdf-parse");
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try {
    return (await p.getText()).text ?? "";
  } finally {
    await p.destroy();
  }
}
/** Whitespace folded and lower-cased, so an anchor survives line breaks in the PDF. */
const fold = (s) => s.replace(/[–—]/g, "-").replace(/\s+/g, " ").toLowerCase();

const text = new Map(); // id → folded text
const provenance = [];
for (const spec of FILES) {
  const got = present.get(spec.id);
  if (!got) {
    const sec = SECONDARY[spec.id];
    if (sec) provenance.push({ id: spec.id, item: spec.item, sourceKind: "secondary", ref: sec.ref, url: sec.url ?? null, research: sec.research });
    continue;
  }
  const buf = fs.readFileSync(got.abs);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const raw = got.name.toLowerCase().endsWith(".pdf") ? await pdfText(buf) : buf.toString("utf8");
  text.set(spec.id, fold(raw));
  provenance.push({
    id: spec.id,
    item: spec.item,
    sourceKind: spec.supporting ? "supporting" : "primary",
    file: got.name,
    ref: spec.ref,
    issued: spec.issued,
    url: spec.url,
    sha256,
    bytes: buf.length,
  });
}

/** Refuse to build unless `id`'s text contains every phrase. */
const anchored = [];
function anchor(id, phrases, what) {
  const t = text.get(id);
  if (t == null) return false; // absent optional file — caller decides
  for (const p of phrases) {
    if (!t.includes(fold(p))) {
      console.error(`✗ ${what}: "${p}" not found in ${present.get(id).name} — wrong file, or the row below is wrong. Refusing to build.`);
      process.exit(1);
    }
  }
  anchored.push({ id, what, phrases });
  return true;
}

/* ─────────────────────────── the verified facts ───────────────────────── */

const CAS_FROM = "2026-08-03";
const PREOPEN_V2_FROM = "2026-09-07";
const FO_PREOPEN_FROM = "2025-12-08";

anchor("sebi-cas-2026", ["3:15 pm to 3:35 pm", "3:28 p.m. to 3:30 p.m.", "continue to operate up to 3:40", "3:50 p.m. to 4:00 p.m.",
  "stocks in the cash segment on which derivative contracts are available", "last 30 minutes of the cts", "from august 03, 2026"], "CAS timings + effective date");
anchor("sebi-cas-2026", ["9:00 a.m. to 9:15 a.m.", "anytime between 9:08 a.m. to 9:10 a.m.", "implemented from september 07, 2026"], "revised pre-open + effective date");
anchor("sebi-cas-2026", ["special trading sessions", "closed after 10 minutes from the close of the order entry period in cas"], "special-session CAS rule");
anchor("nse-cas-page", ["03:30 pm -03:35 pm", "transition period 03:35 pm", "03:50 pm - 04:00 pm", "non-cas securities: session timings are 9:15 am to 3:30 pm",
  "equity derivatives segment: session timings are 9:15 am to 3:40 pm"], "NSE CAS session table");
anchor("nse-preopen-page", ["from 9:00 am to 9:15 am", "9:10 am (*) - 9:12 am", "9:12 am - 9:15 am"], "NSE revised pre-open table");
anchor("nse-fo-preopen", ["from 9:00 am to 9:15 am", "9:00 am - 9:08 am", "9:08 am (*) - 9:12 am", "w.e.f. december 08, 2025", "current-month futures"], "F&O pre-open");
anchor("nse-holidays-2026", ["order matching & trade confirmation period: 15:30 hrs to 15:35 hrs", "transition period: 15:35 hrs to 15:50 hrs",
  "held between 15:50hrs and 16:00 hrs", "normal / limited physical market close: 15:30 hrs"], "NSE holiday page market timings");
anchor("nse-cas-sop", ["nse/cmtr/73362", "3:15 p.m. to 3:40 p.m."], "CAS SOP (supporting)");
anchor("nse-cas-sop-update", ["nse/cmtr/76170", "with effect from september 7, 2026"], "CAS SOP update (supporting)");
anchor("nse-expiry-day", ["nse/faop/68747", "last tuesday of expiry month"], "expiry-day revision (supporting)");

/**
 * Session rows. `from`/`to` are IST wall clock; ranges are half-open [from, to).
 * `officialCloseAt` is when the day's official close EXISTS (K3 adds the mark
 * margin in the module, not here). Markets: NSE_CM, BSE_CM, NSE_FO, BSE_FO, MCX.
 * Classes: cash rows are `cas_stock` / `equity` (or `*` before CAS existed);
 * `derivative`; `commodity`.
 */
const preopenCash = (from) => ({ key: "preopen", from: "09:00", to: "09:15", orderEntryEnds: from >= PREOPEN_V2_FROM ? "09:10" : "09:08" });
const cashRows = [];
for (const market of ["NSE_CM", "BSE_CM"]) {
  const src_ = market === "NSE_CM" ? "nse-cas-page" : "sebi-cas-2026";
  const kind = "primary"; // SEBI binds every exchange's cash segment; NSE's own page confirms NSE
  cashRows.push({
    market, class: "*", effectiveFrom: null, effectiveTo: "2026-08-02", source: "sebi-cas-2026", sourceKind: kind,
    note: "Before CAS: the close was the VWAP of the last 30 minutes of continuous trading. The old post-close window is not in any file supplied, so it is not modelled.",
    phases: [preopenCash("2000-01-01"), { key: "continuous", from: "09:15", to: "15:30" }],
    officialCloseAt: "15:30", closeMethod: "vwap-last-30-min",
  });
  for (const [from, to] of [[CAS_FROM, "2026-09-06"], [PREOPEN_V2_FROM, null]]) {
    cashRows.push({
      market, class: "cas_stock", effectiveFrom: from, effectiveTo: to, source: src_, sourceKind: kind,
      preopenSource: "sebi-cas-2026",
      phases: [
        preopenCash(from),
        { key: "continuous", from: "09:15", to: "15:15" },
        { key: "cas_reference", from: "15:15", to: "15:20" },
        { key: "cas_entry", from: "15:20", to: "15:30", randomCloseFrom: "15:28" },
        { key: "cas_match", from: "15:30", to: "15:35" },
        { key: "transition", from: "15:35", to: "15:50" },
        { key: "postclose", from: "15:50", to: "16:00" },
      ],
      officialCloseAt: "15:35", closeMethod: "cas-equilibrium",
    });
    cashRows.push({
      market, class: "equity", effectiveFrom: from, effectiveTo: to, source: src_, sourceKind: kind,
      phases: [preopenCash(from), { key: "continuous", from: "09:15", to: "15:30" }, { key: "postclose", from: "15:50", to: "16:00" }],
      officialCloseAt: "15:30", closeMethod: "vwap-last-30-min",
    });
  }
}
const foRows = [];
for (const market of ["NSE_FO", "BSE_FO"]) {
  const nse = market === "NSE_FO";
  // F&O pre-open is NSE's circular; BSE's own is not in the folder, so BSE_FO carries none.
  const pre = nse ? [{ key: "preopen", from: "09:00", to: "09:15", orderEntryEnds: "09:08", appliesTo: "current-month futures (next-month in the last 5 trading days)" }] : [];
  foRows.push({ market, class: "derivative", effectiveFrom: null, effectiveTo: nse ? "2025-12-07" : "2026-08-02", source: "sebi-cas-2026", sourceKind: "primary",
    phases: [{ key: "continuous", from: "09:15", to: "15:30" }], officialCloseAt: "15:30", closeMethod: "exchange-close-price" });
  if (nse) {
    foRows.push({ market, class: "derivative", effectiveFrom: FO_PREOPEN_FROM, effectiveTo: "2026-08-02", source: "nse-fo-preopen", sourceKind: "primary",
      phases: [...pre, { key: "continuous", from: "09:15", to: "15:30" }], officialCloseAt: "15:30", closeMethod: "exchange-close-price" });
  }
  foRows.push({ market, class: "derivative", effectiveFrom: CAS_FROM, effectiveTo: null, source: nse ? "nse-cas-page" : "sebi-cas-2026", sourceKind: "primary",
    phases: [...pre, { key: "continuous", from: "09:15", to: "15:30" }, { key: "fno_extension", from: "15:30", to: "15:40" }],
    officialCloseAt: "15:40", closeMethod: "exchange-close-price" });
}
// MCX — SECONDARY unless item 10 is supplied (it was not on 2026-09-24).
const mcxKind = present.has("mcx-timings") ? "primary" : "secondary";
const mcxRows = [
  { market: "MCX", class: "commodity", effectiveFrom: null, effectiveTo: "2026-03-08", source: "mcx-timings", sourceKind: mcxKind,
    phases: [{ key: "continuous", from: "09:00", to: "23:55" }], officialCloseAt: "23:55", closeMethod: "exchange-close-price", note: "non-agri contracts; agri close earlier and are not modelled" },
  { market: "MCX", class: "commodity", effectiveFrom: "2026-03-09", effectiveTo: "2026-10-31", source: "mcx-timings", sourceKind: mcxKind,
    phases: [{ key: "continuous", from: "09:00", to: "23:30" }], officialCloseAt: "23:30", closeMethod: "exchange-close-price", note: "US daylight saving; non-agri" },
  { market: "MCX", class: "commodity", effectiveFrom: "2026-11-01", effectiveTo: null, source: "mcx-timings", sourceKind: mcxKind,
    phases: [{ key: "continuous", from: "09:00", to: "23:55" }], officialCloseAt: "23:55", closeMethod: "exchange-close-price", note: "US daylight saving ended 2026-11-01; non-agri" },
];
const sessions = [...cashRows, ...foRows, ...mcxRows];

/* ─────────────────────────────── holidays ─────────────────────────────── */

const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const holText = text.get("nse-holidays-2026");
// "1 15-jan-2026 thursday municipal corporation election - maharashtra 2 26-jan-2026 …" (folded)
const holRe = /(\d{1,2}) (\d{2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(\d{4}) (monday|tuesday|wednesday|thursday|friday|saturday|sunday) (.+?)(?= \d{1,2} \d{2}-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{4} | note:| the holidays falling| -- \d| market timings|$)/g;
const raw = new Map();
for (const m of holText.matchAll(holRe)) {
  const date = `${m[4]}-${MONTHS[m[3]]}-${m[2]}`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const stated = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(m[5]);
  if (dow !== stated) {
    console.error(`✗ holiday ${date} is stated as ${m[5]} but is not — the text extraction misread a row. Refusing to build.`);
    process.exit(1);
  }
  const name = m[6].replace(/\*$/, "").trim();
  if (!raw.has(date)) raw.set(date, name);
}
// The name is title-cased from the source words (the fold lower-cased them).
const title = (s) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
const holidayYear = Number(asOf.slice(0, 4));
const holidays = [...raw.entries()]
  .filter(([d]) => Number(d.slice(0, 4)) === holidayYear)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([date, name]) => ({ date, name: title(name), markets: ["NSE_CM", "NSE_FO", "BSE_CM", "BSE_FO"], source: "nse-holidays-2026",
    ...(present.has("bse-holidays-2026") ? {} : { bseSourceKind: "secondary" }) }));
const weekdayHolidays = holidays.filter((h) => ![0, 6].includes(new Date(`${h.date}T00:00:00Z`).getUTCDay())).length;
if (holidays.length < 15 || weekdayHolidays < 12) {
  console.error(`✗ only ${holidays.length} holidays (${weekdayHolidays} on weekdays) read from the holiday file — extraction failed. Refusing to build.`);
  process.exit(1);
}

/* ─────────────────────────── special sessions ─────────────────────────── */

const muhurat = anchor("nse-holidays-2026", ["november 08, 2026, shall be a trading holiday on account of diwali laxmi pujan. muhurat trading will be conducted on that day"], "Muhurat 2026");
const specialSessions = [
  { date: "2026-02-01", kind: "budget", name: "Union Budget live session", markets: ["NSE_CM", "NSE_FO", "BSE_CM", "BSE_FO", "MCX"],
    timings: "normal", settlementHoliday: true, source: "nse-special-2026", sourceKind: present.has("nse-special-2026") ? "primary" : "secondary" },
  { date: "2026-11-08", kind: "muhurat", name: "Muhurat trading (Diwali Laxmi Pujan)", markets: ["NSE_CM", "NSE_FO", "BSE_CM", "BSE_FO"],
    timings: null, note: "Timings to be notified by an NSE circular — not bundled, so no session hours are known for this day.",
    source: "nse-holidays-2026", sourceKind: muhurat ? "primary" : "secondary" },
];

// A day with a session is not a holiday: NSE lists 2026-11-08 (Diwali Laxmi Pujan*) as a
// holiday whose asterisk IS the Muhurat session, and the pre-v4.6.0 list left it out for
// that reason (tests/nse-holidays.test.ts). It lives in specialSessions instead.
const listedHolidays = holidays.filter((h) => !specialSessions.some((s) => s.date === h.date));

/* ───────────────────────── CAS membership (item 7) ────────────────────── */

const fo = fs.readFileSync(present.get("nse-fo-underlyings").abs, "utf8").split(/\r?\n/);
const stockHeader = fo.findIndex((l) => /^\s*derivatives on individual securities\s*,/i.test(l));
if (stockHeader < 0) {
  console.error("✗ the F&O file has no 'Derivatives on Individual Securities' header row — not NSE's fo_mktlots layout. Refusing to build.");
  process.exit(1);
}
const members = new Set();
for (const line of fo.slice(stockHeader + 1)) {
  const cells = line.split(",");
  const sym = (cells[1] ?? "").trim().toUpperCase();
  if (!sym) continue;
  if (!/^[A-Z0-9&-]{1,20}$/.test(sym)) {
    console.error(`✗ unreadable F&O symbol ${JSON.stringify(sym)} — refusing to build`);
    process.exit(1);
  }
  members.add(sym);
}
if (members.size < 100) {
  console.error(`✗ only ${members.size} F&O stocks read — NSE lists ~200. Refusing to build.`);
  process.exit(1);
}

/* ──────────────────────────────── write ──────────────────────────────── */

const coversThrough = `${holidayYear}-12-31`;
const sourcesSha256 = crypto
  .createHash("sha256")
  .update(provenance.filter((p) => p.sha256).map((p) => `${p.id}:${p.sha256}`).join("\n"))
  .digest("hex");

const out = {
  _note:
    "SNAPSHOT — built by scripts/build-market-calendar.mjs from the owner's downloads; never hand-edited. Every session row names its source; the build refuses when an anchor phrase is missing from that source. Read ONLY through lib/domain/market-calendar.ts. A WRONGLY LISTED HOLIDAY SILENTLY SUPPRESSES A REAL SESSION'S AUTOMATIC CLOSE MARK — the desk says the market is shut and nothing on screen looks broken. CLEARING HOLIDAYS ARE NOT TRADING HOLIDAYS and must never be added: the market is OPEN on them (26-Aug-2026 Id-E-Milad, a clearing holiday copied into a trading list, once cancelled a real session). A date past coversThrough is UNKNOWN, never a holiday.",
  asOf,
  capturedAt,
  coversThrough,
  timezone: "Asia/Kolkata",
  sourcesSha256,
  provenance,
  refused,
  sessions,
  holidays: listedHolidays,
  specialSessions,
  casMembers: { asOf, effectiveFrom: CAS_FROM, source: "nse-fo-underlyings", count: members.size, symbols: [...members].sort() },
};

const dest = path.resolve(outPath);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
console.log(`✓ ${dest}`);
console.log(`  as of ${asOf} (captured ${capturedAt}), covers through ${coversThrough}`);
console.log(`  ${sessions.length} session rows · ${listedHolidays.length} holidays (${weekdayHolidays} weekday) · ${specialSessions.length} special sessions · ${members.size} CAS stocks`);
console.log(`  ${provenance.filter((p) => p.sourceKind === "primary").length} primary · ${provenance.filter((p) => p.sourceKind === "supporting").length} supporting · ${provenance.filter((p) => p.sourceKind === "secondary").length} secondary · ${anchored.length} anchor checks passed`);
if (refused.length) console.log(`  REFUSED (not on DOWNLOAD-LIST, not read): ${refused.join(", ")}`);
console.log(`  sources sha256 ${sourcesSha256}`);
