/**
 * Build lib/data/mtf-margins.json from scripts/mtf-src/<broker>.json — the
 * common shape emitted by scripts/convert-mtf-workbook.py from the owner's
 * MTF refresh-toolkit workbook (all seven brokers, each from its own feed).
 *
 *   node scripts/build-mtf-margins.mjs
 *
 * marginPct is always the TRADER'S OWN contribution %. Rows with funded=false
 * are broker-approved but ₹0-funded: they ship at 100% so the engine prices
 * them as full cash, and the UI can say "approved, not funded".
 *
 * The snapshot's asOf comes from the workbook's own Sources sheet — refresh by
 * re-running the owner's toolkit (scripts/mtf-toolkit/) and the converter.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "scripts", "mtf-src");

const BROKER_SOURCES = {
  dhan: "Dhan MTF list (own feed)",
  zerodha: "zerodha.com approved-mtf-securities",
  upstox: "Upstox MTF list (own feed)",
  kotakneo: "kotakneo.com margin-trading",
  paytm: "api-eq.paytmmoney.com MTF scrips",
  angelone: "Angel One back-office scrip categories + NSE VaR/ELM",
  groww: "groww.in MTF list (in-app harvest)",
};

const brokers = {};
let asOf = null;

for (const [broker, source] of Object.entries(BROKER_SOURCES)) {
  const file = path.join(src, `${broker}.json`);
  const { asOf: fileAsOf, rows } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (fileAsOf) asOf = asOf && asOf > fileAsOf ? asOf : fileAsOf;
  const stocks = {};
  let funded = 0;
  for (const r of rows) {
    if (!r.symbol || !(r.marginPct > 0)) continue;
    stocks[r.symbol] = { m: r.marginPct, isin: r.isin ?? null, f: r.funded ? 1 : 0 };
    if (r.funded) funded += 1;
  }
  brokers[broker] = {
    coverage: "complete",
    source,
    count: Object.keys(stocks).length,
    fundedCount: funded,
    stocks,
  };
}

brokers.sahi = { coverage: "no-mtf", note: "Sahi offers no margin trading facility.", count: 0, fundedCount: 0, stocks: {} };

const out = { asOf: asOf ?? new Date().toISOString().slice(0, 10), marginMeaning: "trader's own contribution %", brokers };
const dest = path.join(root, "lib", "data", "mtf-margins.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
for (const [k, b] of Object.entries(brokers)) {
  console.log(`  ${k.padEnd(9)} ${String(b.count).padStart(5)} scrips  ${String(b.fundedCount).padStart(5)} funded  ${b.coverage}`);
}
console.log(`✓ ${dest} · as of ${out.asOf}`);
