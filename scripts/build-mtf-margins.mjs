/**
 * Build lib/data/mtf-margins.json from raw broker MTF lists in scripts/mtf-src/.
 *
 *   node scripts/build-mtf-margins.mjs [--as-of YYYY-MM-DD]
 *
 * Everything here is a SNAPSHOT — margins move with exchange VAR revisions, so
 * the as-of date ships in the file and every consumer shows it. `marginPct`
 * always means the TRADER'S OWN contribution percentage; the broker funds the
 * remainder.
 *
 * Coverage is deliberately per-broker honest:
 *   - complete: the broker's full published list was captured
 *   - partial:  only what the broker's site serves openly (first page/100)
 *   - rule:     the broker publishes a rule, not a per-scrip file
 *   - noMtf:    the broker offers no MTF at all
 * The engine treats missing per-stock data as "fall back to the broker-level
 * default" — it never invents a per-stock number.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "scripts", "mtf-src");
const args = process.argv.slice(2);
const asOf = args.includes("--as-of") ? args[args.indexOf("--as-of") + 1] : new Date().toISOString().slice(0, 10);

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(src, f), "utf8"));
const r1 = (n) => Math.round(n * 10) / 10;

const brokers = {};

// ── Zerodha: complete public JSON — margin = own contribution % ─────────────
{
  const rows = readJson("zerodha.json");
  const stocks = {};
  for (const r of rows) {
    const sym = String(r.tradingsymbol ?? "").toUpperCase();
    if (!sym || !(r.margin > 0)) continue;
    stocks[sym] = { m: r1(r.margin), isin: r.isin ?? null };
  }
  brokers.zerodha = {
    coverage: "complete",
    source: "zerodha.com/mtf-approved-securities",
    count: Object.keys(stocks).length,
    stocks,
  };
}

// ── Paytm Money: complete public JSON ───────────────────────────────────────
{
  const rows = readJson("paytm.json").data;
  const stocks = {};
  for (const r of rows) {
    const sym = String(r.symbol ?? "").toUpperCase();
    if (!sym || !(r.margin_perc > 0)) continue;
    // NSE preferred when both exchanges list the same symbol.
    if (!(sym in stocks) || r.exchange === "NSE") {
      stocks[sym] = { m: r1(r.margin_perc), isin: r.isin ?? null };
    }
  }
  brokers.paytm = {
    coverage: "complete",
    source: "paytmmoney.com/mtf/list",
    count: Object.keys(stocks).length,
    stocks,
  };
}

// ── Groww: partial (site serves only the first 100 openly) ─────────────────
{
  const rows = readJson("groww.json");
  const stocks = {};
  for (const r of rows) {
    const sym = String(r.nseScriptCode ?? "").toUpperCase();
    if (!sym || !(r.mtfHaircut > 0)) continue;
    stocks[sym] = { m: r1(r.mtfHaircut), isin: r.isin ?? null };
  }
  brokers.groww = {
    coverage: "partial",
    source: "groww.in/stocks/mtf/list (first page)",
    note: "Groww serves only the first 100 rows openly — margins for other scrips fall back to the broker default.",
    count: Object.keys(stocks).length,
    stocks,
  };
}

// ── Kotak Neo: partial (first page); margin = 100 / leverage ────────────────
{
  const rows = readJson("kotak.json");
  const stocks = {};
  for (const r of rows) {
    const sym = String(r.symbol ?? "").toUpperCase();
    if (!sym || !(r.leverage > 0)) continue;
    stocks[sym] = { m: r1(100 / r.leverage), isin: null };
  }
  brokers.kotakneo = {
    coverage: "partial",
    source: "kotakneo.com/margin-requirement/margin-trading (first page)",
    count: Object.keys(stocks).length,
    stocks,
  };
}

// ── Rule-based / absent brokers — no per-stock numbers are ever invented ────
brokers.angelone = {
  coverage: "rule",
  rule: "Bluechip 40% · Good/Average 50% (or exchange MTF VAR margin if higher)",
  defaultPct: 40,
  count: 0,
  stocks: {},
};
brokers.dhan = {
  coverage: "rule",
  rule: "Funding up to 75% of investment — own margin ≈25%",
  defaultPct: 25,
  count: 0,
  stocks: {},
};
brokers.upstox = {
  coverage: "none",
  note: "List not openly accessible — upload the broker's file to fill this in.",
  count: 0,
  stocks: {},
};
brokers.sahi = { coverage: "no-mtf", note: "Sahi offers no margin trading facility.", count: 0, stocks: {} };

const out = { asOf, marginMeaning: "trader's own contribution %", brokers };
const dest = path.join(root, "lib", "data", "mtf-margins.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
const total = Object.values(brokers).reduce((s, b) => s + b.count, 0);
console.log(`✓ ${dest}`);
for (const [k, b] of Object.entries(brokers)) console.log(`  ${k.padEnd(9)} ${String(b.count).padStart(5)}  ${b.coverage}`);
console.log(`  total ${total} per-stock margins · as of ${asOf}`);
