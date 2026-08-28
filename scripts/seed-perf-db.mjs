/**
 * Seed a MIGRATED perf database with a realistic HEAVY-tier book.
 *
 *   node scripts/seed-perf-db.mjs [--trades=25000] [--out=data/perf.sqlite]
 *
 * Built for the browser-level perf harness: `npm run perf:seed`, then start a
 * production server against it (VYUHA_DB_PATH=data/perf.sqlite next start) and
 * run `npm run perf:sweep`. The file lands under data/, which is gitignored.
 *
 * Determinism: the three bulk tables (trades, ledger_entries, audit_log) are
 * byte-deterministic — mulberry32 PRNG (fixed seed 42), all dates derived from
 * a fixed base date (2024-08-01 + 24 months), and created_at / updated_at / ts
 * written explicitly. Accounts and config rows are NOT byte-deterministic:
 * seedDatabase() and the account inserts leave their timestamps to
 * `datetime('now')` defaults, so those few rows differ run-to-run.
 *
 * Marker: exactly ONE extra trade with symbol "PERFSEED" is inserted in
 * account 1, dated 2026-07-31 (newest in the book, latest created_at), so it
 * tops date-sorted listings. Harness tooling (scripts/perf-sweep.mjs) fetches
 * /trades and looks for it to prove the server under test is actually bound
 * to this database. It is a closed, zero-P&L, zero-charge trade so it does
 * not perturb aggregates.
 *
 * Ratios follow the HEAVY tier in tests/load/README.md (trades 25,000 →
 * ledger_entries 60,000, audit_log 100,000), scaled with --trades.
 *
 * Money: rows are written through drizzle, so ₹ amounts are RUPEES here and
 * the `moneyPaise` column type converts at the boundary (invariant 1). The one
 * raw-SQL table is ledger_entries, whose `amount_paise` column is a plain
 * integer in the schema too — it is written in PAISE, deliberately and
 * labelled. Charge figures are plausible synthetic data for load shape, not
 * engine output — nothing here feeds the charges engine (invariant 3 intact).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const TRADES = Number(arg("trades", "25000"));
const OUT = path.resolve(ROOT, arg("out", path.join("data", "perf.sqlite")));
if (!Number.isFinite(TRADES) || TRADES < 1) {
  console.error(`✗ --trades must be a positive number, got "${arg("trades", "25000")}"`);
  process.exit(1);
}

// HEAVY-tier ratios (tests/load/README.md): 60k ledger / 100k audit per 25k trades.
const LEDGER_ROWS = Math.round(TRADES * (60_000 / 25_000));
const AUDIT_ROWS = Math.round(TRADES * (100_000 / 25_000));

// Fresh file every run — a perf baseline must not accrete.
fs.mkdirSync(path.dirname(OUT), { recursive: true });
for (const f of [OUT, `${OUT}-wal`, `${OUT}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

// lib/db resolves its file from VYUHA_DB_PATH at import time — set it BEFORE
// the first import (same contract as tests/helpers/temp-db.ts).
process.env.VYUHA_DB_PATH = OUT;

// tsx lets this .mjs import the real TS schema + seed instead of duplicating
// either in raw SQL (where the paise/rupee boundary is easy to get wrong).
// The tsx/cjs require hook is the one path that works on node 22 here: the
// ESM register() trips the require(esm)-in-a-cycle guard, and the scoped
// tsImport() does not hook CJS resolution of extensionless "./schema" imports.
await import("tsx/cjs");
const { createRequire } = await import("node:module");
const requireTs = createRequire(import.meta.url);
const tsImport = (rel) => requireTs(path.join(ROOT, rel));

const { db, sqlite, schema } = tsImport("lib/db/index.ts");
if (path.resolve(sqlite.name) !== OUT) {
  console.error(`✗ lib/db bound to ${sqlite.name}, expected ${OUT}`);
  process.exit(1);
}
// Same-realm require, so the migrator sees the same drizzle instance lib/db used.
const { migrate } = requireTs("drizzle-orm/better-sqlite3/migrator");
migrate(db, { migrationsFolder: path.join(ROOT, "drizzle") });
const { seedDatabase } = tsImport("lib/db/seed-core.ts");
seedDatabase();

// --------------------------------------------------------------------------
// Deterministic generator
// --------------------------------------------------------------------------

/** Mulberry32 — same generator as tests/sim/book.ts. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const r2 = (n) => Math.round(n * 100) / 100;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// Fixed 24-month window: 2024-08-01 .. 2026-07-31 (no Date.now anywhere).
const BASE_UTC = Date.UTC(2024, 7, 1);
const WINDOW_DAYS = 730;
const dateAt = (dayOffset) => new Date(BASE_UTC + dayOffset * 86_400_000).toISOString().slice(0, 10);

const SYMBOLS = [
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK",
  "LT", "ITC", "HINDUNILVR", "BHARTIARTL", "MARUTI", "TATAMOTORS", "TATASTEEL", "JSWSTEEL",
  "SUNPHARMA", "CIPLA", "DRREDDY", "DIVISLAB", "TITAN", "ASIANPAINT", "ULTRACEMCO", "GRASIM",
  "ADANIENT", "ADANIPORTS", "POWERGRID", "NTPC", "ONGC", "COALINDIA", "BPCL", "TATAPOWER",
  "WIPRO", "HCLTECH", "TECHM", "BAJFINANCE", "BAJAJFINSV", "HDFCLIFE", "SBILIFE", "INDIGO",
].map((symbol, i) => ({
  symbol,
  isin: `INE${String(100000 + i * 137).slice(0, 6)}01`,
  base: r2(80 + rand() * 2900), // per-symbol price level, fixed for the run
}));
const INDEX_UNDERLYINGS = [
  { symbol: "NIFTY", base: 24000, step: 50, lot: 75 },
  { symbol: "BANKNIFTY", base: 51000, step: 100, lot: 30 },
];

// Three accounts; id 1 ("Primary") comes from seedDatabase().
db.insert(schema.accounts)
  .values([
    { id: 2, name: "Zerodha — Long Term", broker: "zerodha" },
    { id: 3, name: "Groww — Swing", broker: "groww" },
  ])
  .onConflictDoNothing()
  .run();
const ACCOUNTS = [
  { id: 1, broker: "dhan", weight: 0.5 },
  { id: 2, broker: "zerodha", weight: 0.3 },
  { id: 3, broker: "groww", weight: 0.2 },
];
const pickAccount = () => {
  const roll = rand();
  let acc = 0;
  for (const a of ACCOUNTS) {
    acc += a.weight;
    if (roll < acc) return a;
  }
  return ACCOUNTS[0];
};

const SETUPS = ["breakout", "pullback", "trend-follow", "mean-revert", "earnings", "news", "range", null];
const EMOTIONS = [null, null, null, "confident", "fomo", "revenge", "hesitant"];

/**
 * Plausible per-trade charges in RUPEES (sim-style formula from
 * tests/sim/book.ts, both sides folded together). Synthetic — for load shape.
 */
function makeCharges(seg, buyValue, sellValue) {
  const turnover = buyValue + sellValue;
  const intradayish = seg === "eq_intraday";
  const optionish = seg === "index_option" || seg === "stock_option";
  const brokerage = seg === "eq_delivery" ? 0 : r2(Math.min(40, turnover * 0.0003));
  const exchangeTxn = r2(turnover * (optionish ? 0.0005 : 0.0000322));
  const sebi = r2(turnover * 0.000001);
  const gst = r2((brokerage + exchangeTxn + sebi) * 0.18);
  const sttCtt = optionish
    ? Math.round(sellValue * 0.000625)
    : intradayish
      ? Math.round(sellValue * 0.00025)
      : Math.round(turnover * 0.001);
  const stampDuty = Math.round(buyValue * (intradayish || optionish ? 0.00003 : 0.00015));
  const total = r2(brokerage + exchangeTxn + sebi + gst + sttCtt + stampDuty);
  return { brokerage, exchangeTxn, sebi, gst, sttCtt, stampDuty, total };
}

function makeTrade(i) {
  const account = pickAccount();
  const roll = rand();
  const segment =
    roll < 0.4 ? "eq_delivery" : roll < 0.58 ? "eq_intraday" : roll < 0.68 ? "eq_mtf" : roll < 0.85 ? "index_option" : "stock_option";
  const isOption = segment === "index_option" || segment === "stock_option";
  const bucket = segment === "eq_delivery" || segment === "eq_mtf" ? "equity" : "active";
  const buyOffset = Math.floor(rand() * (WINDOW_DAYS - 30));
  const buyDate = dateAt(buyOffset);
  // Intraday closes same-day by definition; options expire, so they cannot
  // stay open for the tail of the window. Net open share lands near 15%.
  const isOpen = segment === "eq_intraday" ? false : rand() < (isOption ? 0.08 : 0.22);

  let row;
  if (isOption) {
    const idx = segment === "index_option" ? pick(INDEX_UNDERLYINGS) : null;
    const stock = idx ? null : pick(SYMBOLS);
    const spot = idx ? idx.base * (0.92 + rand() * 0.16) : stock.base * (0.92 + rand() * 0.16);
    const step = idx ? idx.step : Math.max(2.5, Math.round(stock.base / 40));
    const strike = Math.round(spot / step) * step;
    const lotSize = idx ? idx.lot : 100 + Math.floor(rand() * 8) * 50;
    const lots = 1 + Math.floor(rand() * 4);
    const qty = lots * lotSize;
    const optionType = rand() < 0.5 ? "CE" : "PE";
    const expiryOffset = buyOffset + 3 + Math.floor(rand() * 28);
    const expiry = dateAt(expiryOffset);
    const avgBuyPrice = r2(5 + rand() * 350);
    const buyValue = r2(qty * avgBuyPrice);
    const holdDays = Math.min(expiryOffset - buyOffset, Math.floor(rand() * 10));
    const avgSellPrice = isOpen ? 0 : r2(Math.max(0.05, avgBuyPrice * (0.55 + rand() * 0.95)));
    const sellValue = isOpen ? 0 : r2(qty * avgSellPrice);
    const symbol = idx ? idx.symbol : stock.symbol;
    row = {
      broker: account.broker, bucket, segment, instrumentType: "option", exchange: "NSE",
      symbol,
      tradingsymbol: `${symbol}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${strike}${optionType}`,
      isin: null, expiry, strike, optionType, lotSize,
      buyQty: qty, avgBuyPrice, buyValue,
      sellQty: isOpen ? 0 : qty, avgSellPrice, sellValue,
      buyDate, sellDate: isOpen ? null : dateAt(buyOffset + holdDays),
      closingPrice: isOpen ? r2(Math.max(0.05, avgBuyPrice * (0.6 + rand() * 0.9))) : null,
      expiryOutcome: isOpen ? "open" : rand() < 0.2 ? "expired_worthless" : "squared_off",
    };
  } else {
    const stock = pick(SYMBOLS);
    const qty = 1 + Math.floor(rand() * (segment === "eq_intraday" ? 800 : 400));
    const avgBuyPrice = r2(stock.base * (0.85 + rand() * 0.3));
    const buyValue = r2(qty * avgBuyPrice);
    const holdDays = segment === "eq_intraday" ? 0 : 1 + Math.floor(rand() * 180);
    const drift = segment === "eq_intraday" ? 0.985 + rand() * 0.03 : 0.88 + rand() * 0.3;
    const avgSellPrice = isOpen ? 0 : r2(avgBuyPrice * drift);
    const sellValue = isOpen ? 0 : r2(qty * avgSellPrice);
    row = {
      broker: account.broker, bucket, segment, instrumentType: "equity", exchange: rand() < 0.85 ? "NSE" : "BSE",
      symbol: stock.symbol, tradingsymbol: stock.symbol, isin: stock.isin,
      expiry: null, strike: null, optionType: null, lotSize: null,
      buyQty: qty, avgBuyPrice, buyValue,
      sellQty: isOpen ? 0 : qty, avgSellPrice, sellValue,
      buyDate, sellDate: isOpen ? null : dateAt(Math.min(buyOffset + holdDays, WINDOW_DAYS - 1)),
      closingPrice: isOpen ? r2(avgBuyPrice * (0.9 + rand() * 0.25)) : null,
      expiryOutcome: null,
    };
    if (segment === "eq_mtf") {
      row.mtfFundedAmount = r2(buyValue * 0.75);
      row.mtfInterest = r2(buyValue * 0.75 * 0.00035 * Math.max(1, holdDays));
    }
  }

  const ch = makeCharges(segment, row.buyValue, row.sellValue);
  const grossPnl = row.sellQty > 0 ? r2(row.sellValue - row.buyValue) : 0;
  const chargesTotal = r2(ch.total + (row.mtfInterest ?? 0));
  const createdAt = `${row.buyDate}T10:${String(i % 60).padStart(2, "0")}:00.000Z`;
  return {
    accountId: account.id,
    ...row,
    grossPnl,
    chargesTotal,
    netPnl: row.sellQty > 0 ? r2(grossPnl - chargesTotal) : 0,
    unrealisedPnl: row.closingPrice != null ? r2(row.buyQty * (row.closingPrice - row.avgBuyPrice)) : 0,
    isOpen: row.sellQty === 0,
    brokerage: ch.brokerage, sttCtt: ch.sttCtt, exchangeTxn: ch.exchangeTxn,
    sebi: ch.sebi, stampDuty: ch.stampDuty, gst: ch.gst,
    setupTag: pick(SETUPS),
    emotionTag: pick(EMOTIONS),
    slPlanned: rand() < 0.5 ? r2(row.avgBuyPrice * 0.95) : null,
    targetPlanned: rand() < 0.5 ? r2(row.avgBuyPrice * 1.1) : null,
    rMultiple: row.sellQty > 0 && rand() < 0.6 ? r2(-2 + rand() * 5) : null,
    sourceFile: "perf-seed",
    dedupHash: `perf-${i}`,
    createdAt,
    updatedAt: createdAt,
  };
}

// --------------------------------------------------------------------------
// Insert — one transaction per table. Only ledger/audit use prepared raw
// statements; trades go through drizzle per-row so the moneyPaise column type
// converts at the boundary (slower, accepted cost — invariant 1).
// --------------------------------------------------------------------------
const t0 = performance.now();

/** Verifiable marker trade (see header): symbol PERFSEED, newest date in the
 *  book, account 1, closed same-day with zero P&L and zero charges. */
const MARKER_TRADE = {
  accountId: 1,
  broker: "dhan", bucket: "equity", segment: "eq_delivery",
  instrumentType: "equity", exchange: "NSE",
  symbol: "PERFSEED", tradingsymbol: "PERFSEED", isin: null,
  expiry: null, strike: null, optionType: null, lotSize: null,
  buyQty: 1, avgBuyPrice: 100, buyValue: 100,
  sellQty: 1, avgSellPrice: 100, sellValue: 100,
  buyDate: "2026-07-31", sellDate: "2026-07-31",
  closingPrice: null, expiryOutcome: null,
  grossPnl: 0, chargesTotal: 0, netPnl: 0, unrealisedPnl: 0,
  isOpen: false,
  brokerage: 0, sttCtt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, gst: 0,
  setupTag: null, emotionTag: null, slPlanned: null, targetPlanned: null, rMultiple: null,
  sourceFile: "perf-seed",
  dedupHash: "perf-marker",
  createdAt: "2026-07-31T23:59:59.000Z",
  updatedAt: "2026-07-31T23:59:59.000Z",
};

db.transaction((tx) => {
  for (let i = 0; i < TRADES; i++) tx.insert(schema.trades).values(makeTrade(i)).run();
  tx.insert(schema.trades).values(MARKER_TRADE).run();
});
const tTrades = performance.now();

// ledger_entries.amount_paise is a plain integer column — RAW PAISE here, on purpose.
const insLedger = sqlite.prepare(
  "INSERT INTO ledger_entries (account_id, date, bucket, type, amount_paise, ref_trade_id, symbol, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const LEDGER_TYPES = [
  { type: "realised_pnl", w: 0.4, amt: () => Math.round((rand() * 2 - 0.8) * 2_500_000) },
  { type: "charge", w: 0.25, amt: () => -Math.round(500 + rand() * 150_000) },
  { type: "mtf_interest", w: 0.1, amt: () => -Math.round(100 + rand() * 40_000) },
  { type: "dividend", w: 0.1, amt: () => Math.round(1_000 + rand() * 500_000) },
  { type: "deposit", w: 0.1, amt: () => Math.round(5_000_000 + rand() * 50_000_000) },
  { type: "withdrawal", w: 0.05, amt: () => -Math.round(5_000_000 + rand() * 20_000_000) },
];
sqlite.transaction(() => {
  for (let i = 0; i < LEDGER_ROWS; i++) {
    const roll = rand();
    let acc = 0;
    let kind = LEDGER_TYPES[0];
    for (const k of LEDGER_TYPES) {
      acc += k.w;
      if (roll < acc) { kind = k; break; }
    }
    const date = dateAt(Math.floor(rand() * WINDOW_DAYS));
    const account = pickAccount();
    insLedger.run(
      account.id, date, rand() < 0.6 ? "equity" : "active", kind.type, kind.amt(),
      kind.type === "realised_pnl" ? 1 + Math.floor(rand() * TRADES) : null,
      kind.type === "dividend" ? pick(SYMBOLS).symbol : null,
      null, "perf-seed", `${date}T11:00:00.000Z`,
    );
  }
})();
const tLedger = performance.now();

const insAudit = sqlite.prepare(
  "INSERT INTO audit_log (ts, entity, entity_id, action, summary, before_json, after_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
sqlite.transaction(() => {
  for (let i = 0; i < AUDIT_ROWS; i++) {
    const tradeId = 1 + Math.floor(rand() * TRADES);
    const action = rand() < 0.5 ? "create" : rand() < 0.8 ? "update" : "close";
    const day = dateAt(Math.floor(rand() * WINDOW_DAYS));
    insAudit.run(
      `${day}T${String(9 + (i % 7)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
      "trade", tradeId, action, `perf seed ${action} trade #${tradeId}`,
      action === "create" ? null : JSON.stringify({ netPnl: r2(rand() * 10000 - 4000) }),
      JSON.stringify({ netPnl: r2(rand() * 10000 - 4000) }),
      "perf-seed",
    );
  }
})();
const tAudit = performance.now();

// --------------------------------------------------------------------------
// Sanity report
// --------------------------------------------------------------------------
const one = (sql) => Object.values(sqlite.prepare(sql).get())[0];
const tradeCount = one("SELECT COUNT(*) FROM trades");
const openCount = one("SELECT COUNT(*) FROM trades WHERE is_open = 1");
const ledgerCount = one("SELECT COUNT(*) FROM ledger_entries");
const auditCount = one("SELECT COUNT(*) FROM audit_log");
const accountCount = one("SELECT COUNT(*) FROM accounts");
const netPaise = one("SELECT COALESCE(SUM(net_pnl_paise), 0) FROM trades");
const segments = sqlite.prepare("SELECT segment, COUNT(*) n FROM trades GROUP BY segment ORDER BY n DESC").all();

console.log(`✓ perf DB ready: ${OUT}`);
console.log(`  trades          ${tradeCount.toLocaleString()} (${openCount.toLocaleString()} open, ${((openCount / tradeCount) * 100).toFixed(1)}%) in ${Math.round(tTrades - t0)} ms`);
console.log(`  ledger_entries  ${ledgerCount.toLocaleString()} in ${Math.round(tLedger - tTrades)} ms`);
console.log(`  audit_log       ${auditCount.toLocaleString()} in ${Math.round(tAudit - tLedger)} ms`);
console.log(`  accounts        ${accountCount}`);
console.log(`  Σ net_pnl       ₹${(netPaise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
console.log(`  segments        ${segments.map((s) => `${s.segment}:${s.n}`).join("  ")}`);

sqlite.close();
