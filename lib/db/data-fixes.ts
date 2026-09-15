import type Database from "better-sqlite3";
import { dedupHash, PAYTM_BROKER } from "@/lib/import/dedup";
import { isLotIdentityFrozen } from "@/lib/import/close-open-lots";

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
export const IPO_ACCOUNT_REHOME_FIX = "ipo-account-rehome-v1";

export interface DataFixResult {
  name: string;
  /** false when the marker already existed and nothing ran. */
  applied: boolean;
  /** Rows the fix rewrote (a dedup_hash re-keyed, an IPO row re-homed). */
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
  import_notes: string | null;
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
              sell_qty, avg_sell_price, sell_value_paise, buy_date, sell_date, dedup_hash, import_notes
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
    // S-2: a lot an import auto-closed no longer answers to its own legs — its
    // hash is FROZEN at what the file that created it said, and every consuming
    // execution is an alias beside it (lib/import/close-open-lots.ts). Re-keying
    // it from the CURRENT legs (a 100 lot reduced to 60) would silently
    // disconnect that file, and this fix re-runs on every restore, so the buy
    // file would import again as a phantom open lot.
    if (isLotIdentityFrozen({ dedupHash: r.dedup_hash, importNotes: r.import_notes })) continue;
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

/**
 * ipo-account-rehome-v1 — file a legacy IPO record in the account its holding
 * is actually in (v4.3.0 wave 2J).
 *
 * "This holding came from an IPO" used to INSERT the `ipos` row with no
 * accountId, so the column took its schema default of 1 whatever account the
 * holding was in (fixed at the write in wave 2I). A journal that used that
 * button from a second account therefore stores rows in account 1 whose
 * `trade_id` names a trade in another book. Under the account-scoped read and
 * join those rows are invisible on their holding's /ipos, unreachable for a
 * sync, and read as UNLINKED by the counted-once consumers — so the same sale
 * is counted twice across "All accounts" (invariant 8).
 *
 * The holding is the fact the user cannot have got wrong: it is the row they
 * pressed the button on. So the IPO moves to the TRADE's account, and nothing
 * else moves — `trades` is never written here, and neither is `trade_id`.
 *
 * Left exactly as stored, deliberately: a null link (an ordinary application),
 * a trade already in the same account, a `trade_id` naming a trade that no
 * longer exists (deleted — the link is history, not a destination), and a trade
 * whose `accounts` row is gone, which would move the record into a book that
 * cannot be selected and hide it from every single-account view. Account 0 is a
 * view and is never written (invariant 9); `t.account_id > 0` refuses it even
 * if a trade somehow carries it.
 *
 * Naturally idempotent — after the move the two account ids are equal, so a
 * re-run (a restore forgets the markers) selects nothing.
 */
function applyIpoAccountRehome(sqlite: Database.Database): DataFixResult {
  const result: DataFixResult = { name: IPO_ACCOUNT_REHOME_FIX, applied: true, rekeyed: 0, skippedCollisions: 0 };
  const rows = sqlite
    .prepare(
      `SELECT i.id AS id, t.account_id AS account_id
         FROM ipos i
         JOIN trades t ON t.id = i.trade_id
         JOIN accounts a ON a.id = t.account_id
        WHERE i.trade_id IS NOT NULL
          AND t.account_id > 0
          AND t.account_id <> i.account_id
        ORDER BY i.id`,
    )
    .all() as { id: number; account_id: number }[];
  const rehome = sqlite.prepare("UPDATE ipos SET account_id = ? WHERE id = ?");
  for (const r of rows) {
    rehome.run(r.account_id, r.id);
    result.rekeyed++;
  }
  return result;
}

const FIXES: { name: string; apply: (sqlite: Database.Database) => DataFixResult }[] = [
  { name: PAYTM_DEDUP_FIX, apply: applyPaytmDedupIsin },
  { name: IPO_ACCOUNT_REHOME_FIX, apply: applyIpoAccountRehome },
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

/**
 * After a RESTORE: forget every marker and run the fixes again.
 *
 * A backup never carries `data_fixes` (tests/backup-format.test.ts excludes
 * it): the markers describe what THIS database has applied, not what the
 * donor had, and the rows just re-inserted may pre-date a fix — a v3.7 file
 * still keys its Paytm rows on the label. Called inside the restore
 * transaction (lib/backup.ts) so a failing fix rolls the whole restore back
 * rather than leaving markers that lie. No-op before migration 0059.
 */
export function rerunDataFixesAfterRestore(sqlite: Database.Database): DataFixResult[] {
  if (!hasTable(sqlite, "data_fixes")) return [];
  sqlite.prepare("DELETE FROM data_fixes").run();
  return runDataFixes(sqlite);
}
