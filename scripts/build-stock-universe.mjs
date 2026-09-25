/**
 * Build lib/data/stock-universe.json — the full Indian listed-equity universe
 * with the exchanges' own 4-level industry classification and AMFI's
 * half-yearly cap band (v4.6.0 W2, owner rulings U1–U4).
 *
 *   node scripts/build-isin-symbols.mjs --fetch --src .isin-lists   # 1. refresh the listing snapshot (same run, one as-of)
 *   node scripts/build-stock-universe.mjs --crawl [--limit N] [--only nse|bse]   # 2. polite crawl into .universe-cache/
 *   node scripts/build-stock-universe.mjs [--amfi <file.xlsx>] [--out <file>]    # 3. reconcile + emit + prove
 *
 * BUILD TIME ONLY, on the owner's machine (ruling U1): the app never contacts
 * any of these hosts. Refresh is manual, once per MINOR release (the Q52
 * precedent); AMFI publishes twice a year.
 *
 * ── Sources (research `VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/research/R3-STOCK-UNIVERSE.md` §2, §4) ──
 *
 *   targets      lib/data/isin-symbols.json (rebuilt first, so the universe and the listing snapshot share
 *                ONE as-of and can never disagree on a symbol): NSE + Emerge symbols, and every BSE code.
 *   NSE status   GetQuoteApi getMetaData   → activeSeries, isin, isSuspended, isDelisted, isETFSec
 *   NSE labels   GetQuoteApi getSymbolData → secInfo.macro / sector / industryInfo / basicIndustry
 *                (the SERIES must be right: a wrong one answers 200 with secInfo null, or 404)
 *   BSE labels   ComHeadernew              → Sector / IndustryNew / IGroup / ISubGroup (Node fetch only;
 *                curl gets an Akamai 403 on every BSE API — TLS fingerprinting)
 *   structure    scripts/ics-structure-2023-07.json (extracted once from NSE Indices' structure PDF by
 *                scripts/extract-ics-structure.mjs) — every label is validated against it, never
 *                against the crawl itself (a check must not agree with itself).
 *   cap band     AMFI "Average Market Capitalisation" xlsx, newest link scraped from the categorisation
 *                page (the host moved in 2026: portal.amfiindia.com/spages/); `--amfi <file>` if it refuses.
 *
 * ── Politeness and failure (R3 §6) ──
 *
 * 0.5 s between requests PER HOST (NSE and BSE run in parallel), a resumable
 * JSONL cache under .universe-cache/ (gitignored), retry-on-empty ×3 with
 * backoff (a 200 with empty secInfo happened transiently in research), and
 * the host's loop STOPS on 5 consecutive 403/429 answers. A stopped or
 * partial crawl never reaches lib/data: the build step refuses a snapshot
 * below the coverage floor, so the previous snapshot stays.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".universe-cache");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SPACING_MS = 500;
const NSE_HEADERS = { Referer: "https://www.nseindia.com/", Accept: "application/json, text/plain, */*" };
const BSE_HEADERS = { Referer: "https://www.bseindia.com/", Origin: "https://www.bseindia.com", Accept: "application/json, text/plain, */*" };
const NSE_API = "https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi";
const BSE_API = "https://api.bseindia.com/BseIndiaAPI/api/ComHeadernew/w";
export const AMFI_PAGE = "https://www.amfiindia.com/otherdata/categorisation-of-stocks";

/** Series tried first when NSE lists several active ones (T0 is the T+0 twin of EQ, never a label source). */
const SERIES_PREF = ["EQ", "BE", "BZ", "SM", "ST", "SZ"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

/** key → last line, for a JSONL cache file. A later line for the same key wins (a retry supersedes). */
export function readJsonl(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.k != null) out.set(String(row.k), row);
    } catch {
      /* a line cut short by a killed run — the key is simply retried */
    }
  }
  return out;
}

/** A cached answer that needs no retry: an answer was recorded (labels or a definite "none"). */
const FINAL = new Set(["ok", "empty", "notfound"]);

// ─────────────────────────────────────────────────────────────────────────────
// Crawl
// ─────────────────────────────────────────────────────────────────────────────

class Host {
  constructor(name, headers) {
    this.name = name;
    this.headers = headers;
    this.last = 0;
    this.blocked = 0; // consecutive 403/429
    this.stopped = false;
    this.calls = 0;
  }
  /** One polite GET → { status, json|null }. Network errors retry ×3; a 403/429 burst stops the host. */
  async get(url) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = this.last + SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.calls++;
      let res;
      try {
        res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...this.headers }, signal: AbortSignal.timeout(20000) });
      } catch (e) {
        if (attempt === 3) return { status: 0, json: null, error: String(e?.message ?? e) };
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (res.status === 403 || res.status === 429) {
        this.blocked++;
        if (this.blocked >= 5) {
          this.stopped = true;
          return { status: res.status, json: null };
        }
        await sleep(5000 * 2 ** attempt);
        continue;
      }
      this.blocked = 0;
      if (res.status >= 500) {
        if (attempt === 3) return { status: res.status, json: null };
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 404 answers "Unexpected end of JSON input" style bodies */
      }
      return { status: res.status, json };
    }
    return { status: 0, json: null };
  }
}

const hasLabels = (o) => !!(o && (o.macro || o.sector || o.industry || o.basic));

/** NSE secInfo → our four levels (null when NSE states none). */
export function nseLabels(secInfo) {
  if (!secInfo) return null;
  const t = (v) => (v == null ? null : String(v).trim() || null);
  return { macro: t(secInfo.macro), sector: t(secInfo.sector), industry: t(secInfo.industryInfo), basic: t(secInfo.basicIndustry) };
}
/** BSE ComHeadernew → our four levels. BSE names them Sector / IndustryNew / IGroup / ISubGroup. */
export function bseLabels(body) {
  if (!body || typeof body !== "object") return null;
  const t = (v) => (v == null ? null : String(v).trim() || null);
  return { macro: t(body.Sector), sector: t(body.IndustryNew), industry: t(body.IGroup), basic: t(body.ISubGroup) };
}

function seriesOrder(active, listed) {
  const act = Array.isArray(active) ? active.map(String) : [];
  const ordered = [...SERIES_PREF.filter((s) => act.includes(s)), ...act.filter((s) => !SERIES_PREF.includes(s) && s !== "T0")];
  if (!ordered.length && listed) ordered.push(listed);
  return ordered;
}

async function crawlNse(targets, host, out) {
  const done = readJsonl(out);
  const todo = targets.filter((t) => !FINAL.has(done.get(t.symbol)?.st));
  console.log(`  NSE: ${targets.length} symbols, ${targets.length - todo.length} cached, ${todo.length} to fetch`);
  let n = 0;
  for (const t of todo) {
    if (host.stopped) break;
    const m = await host.get(`${NSE_API}?functionName=getMetaData&symbol=${encodeURIComponent(t.symbol)}`);
    if (host.stopped) break;
    const meta = m.json && typeof m.json === "object" ? m.json : null;
    const row = { k: t.symbol, at: new Date().toISOString(), isin: t.isin };
    if (meta) {
      row.meta = {
        isin: meta.isin ?? null,
        activeSeries: meta.activeSeries ?? [],
        isSuspended: meta.isSuspended ?? null,
        isDelisted: meta.isDelisted ?? null,
        isETFSec: meta.isETFSec ?? null,
        companyName: meta.companyName ?? null,
      };
    }
    let labels = null;
    let seriesUsed = null;
    let lastStatus = m.status;
    for (const s of seriesOrder(meta?.activeSeries, t.series)) {
      for (let attempt = 0; attempt < 3 && !labels && !host.stopped; attempt++) {
        if (attempt) await sleep(2000 * 2 ** (attempt - 1));
        const r = await host.get(`${NSE_API}?functionName=getSymbolData&marketType=N&series=${encodeURIComponent(s)}&symbol=${encodeURIComponent(t.symbol)}`);
        lastStatus = r.status;
        if (r.status === 404) break; // wrong series: no retry, try the next one
        const sec = r.json?.equityResponse?.[0]?.secInfo ?? null;
        const l = nseLabels(sec);
        if (hasLabels(l)) {
          labels = l;
          seriesUsed = s;
          row.listingDate = sec.listingDate ?? null;
          row.secStatus = sec.secStatus ?? null;
        } else if (r.status !== 200) break;
      }
      if (labels || host.stopped) break;
    }
    if (host.stopped) break;
    row.series = seriesUsed;
    row.labels = labels;
    row.st = labels ? "ok" : meta || lastStatus === 200 || lastStatus === 404 ? "empty" : "error";
    row.status = lastStatus;
    fs.appendFileSync(out, JSON.stringify(row) + "\n");
    if (++n % 200 === 0) console.log(`  NSE ${n}/${todo.length} (${host.calls} calls)`);
  }
  console.log(`  NSE finished: ${n} fetched, ${host.calls} calls${host.stopped ? " — STOPPED on a 403/429 burst (re-run resumes)" : ""}`);
}

async function crawlBse(targets, host, out) {
  const done = readJsonl(out);
  const todo = targets.filter((t) => !FINAL.has(done.get(t.code)?.st));
  console.log(`  BSE: ${targets.length} scrip codes, ${targets.length - todo.length} cached, ${todo.length} to fetch`);
  let n = 0;
  for (const t of todo) {
    if (host.stopped) break;
    let labels = null;
    let body = null;
    let status = 0;
    // Two attempts, not three: a well-formed BSE answer with no labels (partly-paid IN9… lines, illiquid
    // groups) was never transient in research, and a third attempt costs ~4 s on each of hundreds of them.
    for (let attempt = 0; attempt < 2 && !labels && !host.stopped; attempt++) {
      if (attempt) await sleep(2000 * 2 ** (attempt - 1));
      const r = await host.get(`${BSE_API}?quotetype=EQ&scripcode=${encodeURIComponent(t.code)}&seriesid=`);
      status = r.status;
      body = r.json && typeof r.json === "object" ? r.json : null;
      const l = bseLabels(body);
      if (hasLabels(l)) labels = l;
      else if (r.status !== 200) break;
    }
    if (host.stopped) break;
    const row = {
      k: t.code,
      at: new Date().toISOString(),
      isin: t.isin,
      bseIsin: body?.ISIN ? String(body.ISIN).trim() : null,
      securityId: body?.SecurityId ?? null,
      group: body?.Group ?? null,
      labels,
      st: labels ? "ok" : body || status === 200 ? "empty" : status === 404 ? "notfound" : "error",
      status,
    };
    fs.appendFileSync(out, JSON.stringify(row) + "\n");
    if (++n % 200 === 0) console.log(`  BSE ${n}/${todo.length} (${host.calls} calls)`);
  }
  console.log(`  BSE finished: ${n} fetched, ${host.calls} calls${host.stopped ? " — STOPPED on a 403/429 burst (re-run resumes)" : ""}`);
}

/** The newest `AverageMarketCapitalization<DD><Mon><YYYY>.xlsx` link on AMFI's categorisation page. */
export function newestAmfiLink(html) {
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  let best = null;
  for (const m of html.matchAll(/https?:[^"'\s>]*AverageMarketCapitali[sz]ation_?(\d{1,2})([A-Za-z]{3})[a-z]*(\d{4})\.xlsx/gi)) {
    const mon = MON[m[2].toLowerCase()];
    if (mon == null) continue;
    const t = Date.UTC(Number(m[3]), mon, Number(m[1]));
    if (!best || t > best.t) best = { url: m[0], t, periodEnd: new Date(t).toISOString().slice(0, 10) };
  }
  return best;
}

async function fetchAmfi() {
  const page = await fetch(AMFI_PAGE, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
  if (!page.ok) throw new Error(`AMFI page: HTTP ${page.status} — download the xlsx by hand and pass --amfi <file>`);
  const link = newestAmfiLink(await page.text());
  if (!link) throw new Error("AMFI page: no AverageMarketCapitalization*.xlsx link found — pass --amfi <file>");
  const res = await fetch(link.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`AMFI xlsx: HTTP ${res.status} from ${link.url} — pass --amfi <file>`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 4).toString("latin1") !== "PK\u0003\u0004") throw new Error(`AMFI xlsx: ${link.url} is not an xlsx (${buf.length} bytes)`);
  const file = path.join(CACHE, path.basename(new URL(link.url).pathname));
  fs.writeFileSync(file, buf);
  fs.writeFileSync(file + ".json", JSON.stringify({ url: link.url, lastModified: res.headers.get("last-modified"), periodEnd: link.periodEnd, sha256: sha256(buf), bytes: buf.length, fetchedAt: new Date().toISOString() }, null, 2));
  console.log(`  AMFI: ${path.basename(file)} — ${buf.length.toLocaleString("en-IN")} bytes, period end ${link.periodEnd}`);
}

async function crawl() {
  fs.mkdirSync(CACHE, { recursive: true });
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "lib/data/isin-symbols.json"), "utf8"));
  const limit = Number(opt("limit") ?? Infinity);
  const only = opt("only");
  const nseTargets = [];
  const bseTargets = [];
  for (const [isin, [symbol, , board, bseCode, series]] of Object.entries(snap.byIsin)) {
    if ((board === "nse" || board === "sme") && symbol) nseTargets.push({ symbol, isin, board, series });
    if (bseCode) bseTargets.push({ code: String(bseCode), isin });
  }
  const run = { listsAsOf: snap.asOf, startedAt: new Date().toISOString(), nseTargets: nseTargets.length, bseTargets: bseTargets.length };
  fs.writeFileSync(path.join(CACHE, "run.json"), JSON.stringify(run, null, 2));
  console.log(`Crawl for the listing snapshot of ${snap.asOf}: ${nseTargets.length} NSE symbols, ${bseTargets.length} BSE codes`);
  if (!only || only === "amfi") await fetchAmfi().catch((e) => console.error(`  ⚠ ${e.message}`));
  const nse = new Host("nse", NSE_HEADERS);
  const bse = new Host("bse", BSE_HEADERS);
  await Promise.all([
    only && only !== "nse" ? null : crawlNse(nseTargets.slice(0, limit), nse, path.join(CACHE, "nse.jsonl")),
    only && only !== "bse" ? null : crawlBse(bseTargets.slice(0, limit), bse, path.join(CACHE, "bse.jsonl")),
  ]);
  fs.writeFileSync(path.join(CACHE, "run.json"), JSON.stringify({ ...run, finishedAt: new Date().toISOString(), nseCalls: nse.calls, bseCalls: bse.calls, nseStopped: nse.stopped, bseStopped: bse.stopped }, null, 2));
  if (nse.stopped || bse.stopped) process.exit(3);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && flag("crawl")) {
  await crawl();
} else if (isMain) {
  const { build } = await import("./stock-universe-build.mjs");
  await build({ root: ROOT, cache: CACHE, amfi: opt("amfi"), out: opt("out"), allowPartial: flag("allow-partial") });
}
