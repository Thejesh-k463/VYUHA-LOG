import type Database from "better-sqlite3";
import { dedupHash, PAYTM_BROKER } from "@/lib/import/dedup";

/**
 * Data fixes — one-shot row rewrites that SQL alone cannot express.
 *
 * A migration is a schema change plus whatever SQL can do to the rows. Some
 * fixes need application code (SQLite cannot SHA-1), so they live here and are
 * tracked in `data_fixes` (migration 0059): one marker row per fix name, and a
 * fix whose marker exists is never run again. `runDataFixes` is called from
 * every path that opens the database (lib/db/index.ts right after the
 * connection opens, lib/db/migrate.ts and tests/helpers/temp-db.ts right after
 * migrating), and is a silent no-op until migration 0059 has created the
 * table — so the desktop shell's plain-.mjs migration step needs no change.
 *
 * Each fix runs inside ONE transaction with its marker, so a crash mid-way
 * leaves no marker and the fix simply runs again next open.
 */

export const PAYTM_DEDUP_FIX = "paytm-dedup-isin-v1";

export interface DataFixResult {
  name: string;
  /** false when the marker already existed and nothing ran. */
  applied: boolean;
  /** Rows whose dedup_hash was rewritten. */
  rekeyed: number;
  /** Rows left untouched because the new hash already existed on another row. */
  skippedCollisions: number;
}

function hasTable(sqlite: Database.Database, name: string): boolean {
  return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function isApplied(sqlite: Database.Database, name: string): boolean {
  return !!sqlite.prepare("SELECT 1 FROM data_fixes WHERE name = ?").get(name);
}

interface StoredTradeKeyRow {
  id: number;
  account_id: number;
  broker: string;
  tradingsymbol: string;
  isin: string | null;
  buy_qty: number;
  avg_buy_price: number;
  buy_value_paise: number;
  sell_qty: number;
  avg_sell_price: number;
  sell_value_paise: number;
  buy_date: string | null;
  sell_date: string | null;
  dedup_hash: string;
}

/**
 * paytm-dedup-isin-v1 — re-key every Paytm row that carries an ISIN with the
 * ISIN-based hash `lib/import/dedup.ts` now produces, so a re-import that
 * labels the scrip differently de-duplicates against what is already stored.
 *
 * Money columns are integer paise at rest (invariant 1); the hash was built
 * from RUPEES, so `/ 100` here mirrors the `moneyPaise` fromDriver exactly.
 * A row whose new hash would collide with another row under
 * `trades_account_broker_dedup_uq` (account_id, broker, dedup_hash) — which is
 * precisely a duplicate the old hash let in — is left as it is and counted;
 * deciding which of two duplicates to keep is the user's call, not a
 * migration's. Classification overrides keyed by the old hash follow the row
 * to its new key so a saved segment/bucket choice is not orphaned.
 */
function applyPaytmDedupIsin(sqlite: Database.Database): DataFixResult {
  const result: DataFixResult = { name: PAYTM_DEDUP_FIX, applied: true, rekeyed: 0, skippedCollisions: 0 };
  const rows = sqlite
    .prepare(
      `SELECT id, account_id, broker, tradingsymbol, isin, buy_qty, avg_buy_price, buy_value_paise,
              sell_qty, avg_sell_price, sell_value_paise, buy_date, sell_date, dedup_hash
         FROM trades
        WHERE broker = ? AND isin IS NOT NULL AND trim(isin) <> ''
        ORDER BY id`,
    )
    .all(PAYTM_BROKER) as StoredTradeKeyRow[];
  const collides = sqlite.prepare(
    "SELECT 1 FROM trades WHERE account_id = ? AND broker = ? AND dedup_hash = ? AND id <> ?",
  );
  const rekey = sqlite.prepare("UPDATE trades SET dedup_hash = ? WHERE id = ?");
  const overrideTaken = sqlite.prepare("SELECT 1 FROM classification_overrides WHERE broker = ? AND dedup_hash = ?");
  const rekeyOverride = sqlite.prepare(
    "UPDATE classification_overrides SET dedup_hash = ? WHERE broker = ? AND dedup_hash = ?",
  );

  for (const r of rows) {
    const next = dedupHash({
      broker: r.broker,
      tradingsymbol: r.tradingsymbol,
      isin: r.isin,
      buyQty: r.buy_qty,
      avgBuyPrice: r.avg_buy_price,
      buyValue: r.buy_value_paise / 100,
      sellQty: r.sell_qty,
      avgSellPrice: r.avg_sell_price,
      sellValue: r.sell_value_paise / 100,
      buyDate: r.buy_date,
      sellDate: r.sell_date,
    });
    if (next === r.dedup_hash) continue;
    if (collides.get(r.account_id, r.broker, next, r.id)) {
      result.skippedCollisions++;
      continue;
    }
    rekey.run(next, r.id);
    if (!overrideTaken.get(r.broker, next)) rekeyOverride.run(next, r.broker, r.dedup_hash);
    result.rekeyed++;
  }
  return result;
}

const FIXES: { name: string; apply: (sqlite: Database.Database) => DataFixResult }[] = [
  { name: PAYTM_DEDUP_FIX, apply: applyPaytmDedupIsin },
];

/**
 * Apply every data fix that has not yet been recorded in `data_fixes`.
 * Idempotent; returns one result per fix (applied:false for ones already done).
 * Returns [] when `data_fixes` does not exist yet — migrations have not run.
 */
export function runDataFixes(sqlite: Database.Database): DataFixResult[] {
  if (!hasTable(sqlite, "data_fixes")) return [];
  const results: DataFixResult[] = [];
  const mark = sqlite.prepare("INSERT INTO data_fixes (name, applied_at) VALUES (?, datetime('now'))");
  for (const fix of FIXES) {
    if (isApplied(sqlite, fix.name)) {
      results.push({ name: fix.name, applied: false, rekeyed: 0, skippedCollisions: 0 });
      continue;
    }
    const run = sqlite.transaction(() => {
      const r = fix.apply(sqlite);
      mark.run(fix.name);
      return r;
    });
    results.push(run());
  }
  return results;
}
