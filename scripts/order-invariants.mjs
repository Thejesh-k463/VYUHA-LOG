/**
 * ORDER INVARIANTS — a read-only fingerprint of everything that depends on
 * the /trades row order.
 *
 * v3.9 gives the book a TOTAL order (sell_date, created_at, id). Rows that tie
 * on (sell_date, created_at) — and a whole import batch does, because
 * `created_at` is `datetime('now')` at second resolution — were previously
 * returned in whatever order SQLite happened to produce. This script exists to
 * prove that pinning that order changes NOTHING a user can see a number for:
 *
 *   - taxByFy per FY, to the paisa            (/reports/tax)
 *   - every harvest lot's id + LT/ST status   (/reports/harvest)
 *   - the holding-clock report + its first 15 symbols   (/arjuns-eye)
 *   - the /trades first-page id list          (the one thing that MAY move,
 *                                              and only inside a tie block)
 *
 * Run BEFORE and AFTER the change and diff the JSON:
 *
 *   npx tsx --tsconfig scripts/tsconfig.invariants.json \
 *     scripts/order-invariants.mjs <db.sqlite> [out.json]
 *
 * It reads through the app's own query modules and prints ONLY aggregates and
 * row ids — a trade row never leaves this process, so the output of a real
 * book is safe to keep. The ONE write it makes is the settings row's
 * selected-account id, so it can snapshot each account in turn; the original
 * value is restored in a finally block. Run it against a COPY of a live book, never the live file.
 */
import fs from "node:fs";
import path from "node:path";

const dbPath = process.argv[2];
const outPath = process.argv[3] ?? null;
if (!dbPath) {
  console.error("usage: order-invariants.mjs <db.sqlite> [out.json]");
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error(`no such database: ${dbPath}`);
  process.exit(2);
}
process.env.VYUHA_DB_PATH = path.resolve(dbPath);

const { sqlite } = await import("../lib/db/index.ts");
const { getJournalTrades, getArjunTrades, getHarvestTrades } = await import("../lib/queries/trades.ts");
const { getTaxBase } = await import("../lib/queries/tax-itr.ts");
const { taxByFy, currentFy: deriveCurrentFy } = await import("../lib/analytics/tax.ts");
const { holdingClock } = await import("../lib/analytics/exit-behaviour.ts");
const { classifyGain } = await import("../lib/analytics/capital-gains.ts");
const { fyWindowFor } = await import("../lib/analytics/harvest.ts");
const { getSettings } = await import("../lib/queries/settings.ts");
const { todayIstIso } = await import("../lib/domain/trading-day.ts");

/** The one page-size the /trades table pages at. Keep in step with TRADES_PAGE_SIZE. */
const FIRST_PAGE = 500;
const EQUITY_SEGMENTS = new Set(["eq_delivery", "eq_mtf"]);
const daysHeld = (a, b) => (a ? Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) : 0);
const r2 = (v) => Math.round(v * 100) / 100;

/** How badly (sell_date, created_at) fails to be a total order. */
function ties(accountId) {
  const scope = accountId > 0 ? `where account_id = ${accountId}` : "";
  const row = sqlite
    .prepare(
      `select count(*) as blocks, coalesce(sum(c), 0) as rows, coalesce(max(c), 0) as largest from (
         select sell_date, created_at, count(*) c from trades ${scope}
         group by sell_date, created_at having c > 1)`,
    )
    .get();
  return { tieBlocks: Number(row.blocks), rowsInTies: Number(row.rows), largestTieBlock: Number(row.largest) };
}

function snapshotForSelectedAccount() {
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;

  // /reports/tax — the exact call the page makes.
  const { trades: taxTrades, ipoTaxRows } = getTaxBase();
  const tax = taxByFy([...taxTrades, ...ipoTaxRows], fyStartMonth, deriveCurrentFy(fyStartMonth))
    .map((r) => ({ ...r, stcg: r2(r.stcg), ltcg: r2(r.ltcg), intradaySpeculative: r2(r.intradaySpeculative), fnoBusiness: r2(r.fnoBusiness), fnoTurnover: r2(r.fnoTurnover), charges: r2(r.charges), totalRealised: r2(r.totalRealised) }))
    .sort((a, b) => a.fy.localeCompare(b.fy));

  // /reports/harvest — the open-lot list in rendered order, plus both realised sums.
  const today = todayIstIso();
  const harvest = getHarvestTrades();
  const lots = harvest
    .filter((t) => t.isOpen && EQUITY_SEGMENTS.has(t.segment))
    .map((t) => {
      const qty = Math.max(t.buyQty - t.sellQty, 0) || t.buyQty;
      return `${t.id}:${daysHeld(t.buyDate, today) >= 365 ? "LT" : "ST"}:${qty}`;
    });
  const { fyStart } = fyWindowFor(today, fyStartMonth);
  let realisedStcg = 0;
  let realisedLtcg = 0;
  for (const t of harvest) {
    if (t.isOpen || !EQUITY_SEGMENTS.has(t.segment) || !t.sellDate || t.sellDate < fyStart) continue;
    const g = classifyGain({
      segment: t.segment, buyDate: t.buyDate, sellDate: t.sellDate,
      buyValue: t.buyValue, sellValue: t.sellValue, netPnl: t.netPnl,
      fmv31Jan2018: t.fmv31Jan2018 != null && t.buyQty > 0 ? t.fmv31Jan2018 * t.buyQty : null,
    });
    if (g?.bucket === "ltcg") realisedLtcg += g.taxableGain;
    else if (g?.bucket === "stcg") realisedStcg += g.taxableGain;
  }

  // /arjuns-eye — the holding clock, and the first 15 symbols it measures, in
  // the order the book handed them over.
  const arjun = getArjunTrades();
  const exitRows = arjun.map((t) => ({
    netPnl: t.netPnl, isOpen: t.isOpen, entryTime: t.entryTime, exitTime: t.exitTime,
    exitTrigger: t.exitTrigger, buyOrderCount: t.buyOrderCount, sellOrderCount: t.sellOrderCount,
    capturedPct: null, buyDate: t.buyDate, sellDate: t.sellDate, symbol: t.symbol,
  }));
  const sameDay = (t) => t.buyDate != null && t.sellDate != null && t.buyDate === t.sellDate;
  const clock = holdingClock(exitRows, sameDay);
  const clockTop15 = exitRows
    .filter((t) => !t.isOpen && sameDay(t) && t.entryTime != null && t.exitTime != null)
    .slice(0, 15)
    .map((t) => t.symbol);

  // /trades — the ids the first server page renders.
  const firstPageIds = getJournalTrades().slice(0, FIRST_PAGE).map((t) => t.id);

  return {
    taxByFy: tax,
    harvestLots: lots,
    harvestRealised: { stcg: r2(realisedStcg), ltcg: r2(realisedLtcg) },
    holdingClock: clock,
    holdingClockTop15: clockTop15,
    tradesFirstPageIds: firstPageIds,
    tradesTotal: getJournalTrades().length,
  };
}

const accounts = sqlite.prepare("select id, name from accounts order by id").all();
const original = sqlite.prepare("select selected_account_id as id from settings limit 1").get()?.id ?? 0;
const out = { db: path.resolve(dbPath), whole: ties(0), accounts: {} };

// One snapshot per account, plus the aggregate view (0). `settings` is written
// and RESTORED — the only write this script makes, and it never touches a trade.
const setSel = sqlite.prepare("update settings set selected_account_id = ?");
try {
  for (const a of [{ id: 0, name: "(all accounts)" }, ...accounts]) {
    setSel.run(a.id);
    out.accounts[`${a.id}`] = { name: a.name, ties: ties(a.id), ...snapshotForSelectedAccount() };
  }
} finally {
  setSel.run(original);
}

const json = JSON.stringify(out, null, 1);
if (outPath) {
  fs.writeFileSync(outPath, json);
  console.log(`wrote ${outPath}`);
}
console.log(
  `${path.basename(dbPath)}: ties ${out.whole.tieBlocks} blocks / ${out.whole.rowsInTies} rows / largest ${out.whole.largestTieBlock}; ` +
    `accounts ${Object.keys(out.accounts).join(",")}`,
);
