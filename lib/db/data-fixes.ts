import type Database from "better-sqlite3";
import { dedupHash, PAYTM_BROKER } from "@/lib/import/dedup";
import { isLotIdentityFrozen } from "@/lib/import/close-open-lots";
import { dedupLabelFromNotes, withDedupLabelNote } from "@/lib/import/trade-identity";
import { bundledSymbolByIsin, normalizeCompanyName, securityByCompanyName } from "@/lib/import/isin-symbol";
import { normalizeDate } from "@/lib/domain/trading-day";
import { backfillSide } from "@/lib/domain/side";
import { parseSeededSignalNotes, serializeSignal } from "@/lib/domain/signal";
import { classifyUnsourcedRisk, repriceCapTrades } from "@/lib/queries/risk-cap";

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
export const LEG_TRADE_DATE_ISO_FIX = "leg-trade-date-iso-v1";
export const SIGNAL_NOTES_BACKFILL_FIX = "signal-notes-backfill-v1";
export const RISK_SOURCE_FIX = "risk-source-v1";
export const DHAN_GTR_SYMBOL_FIX = "dhan-gtr-symbols-v1";
export const TRADES_SIDE_FIX = "trades-side-v1";

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
 * longer exists (deleted — the link is history, not a destination), a trade
 * whose `accounts` row is gone, and (L3, wave 2L) a trade in an ARCHIVED
 * account — both of which would move the record into a book that cannot be
 * SELECTED and hide it from every single-account view
 * (components/system/account-switcher.tsx offers `accounts.filter(a =>
 * !a.archived)`, so "the row exists" was never the test this guard meant).
 * Account 0 is a view and is never written (invariant 9); `t.account_id > 0`
 * refuses it even if a trade somehow carries it.
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
          AND a.archived = 0
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

/**
 * LEG-TRADE-DATE-ISO (v4.3.0 wave 2P, D4 layer 3) — rewrite every
 * `trade_legs.trade_date` that states a readable day in a spelling other than
 * ISO ('20-01-2026' → '2026-01-20').
 *
 * `addLeg` / `updateLeg` have stored the normalised day since wave 2M and the
 * import's `writeLadder` since v2.85.0, but a leg written by a non-browser
 * `addLeg` before 2M (it stored the typed value raw through v4.2.0) or restored
 * from a hand-edited backup still holds the day-first spelling. `sortLegs`
 * orders by seq; the rewrite exists for the readers that compare or parse the
 * leg date as ISO — the scaling replay window (`app/reports/scaling/page.tsx`,
 * a string `>= from` / `<= to` window that a day-first `to` empties), the
 * replay chart's `time` (lightweight-charts drops an unparsable time silently),
 * the ladder's date cell — none of which a rebuild touches. It moves no money
 * and triggers no rebuild (DECISIONS 2026-08-30 decision 6).
 *
 * An UNREADABLE value ('2026-02-31', 'not-a-date') is left exactly as stored:
 * it stays `validateLegs`'s to refuse by name at the ladder's next rebuild — a
 * fix must not invent a day (invariant 6). Idempotent (an ISO value normalises
 * to itself and is skipped); re-run after a backup restore like the other two.
 * A Trash restore replays legs verbatim and runs no fix — such a leg is covered
 * by layers 1–2 (the parent writes ISO on rebuild, the compares read days) until
 * its next `updateLeg` stores the day; accepted.
 */
function applyLegTradeDateIso(sqlite: Database.Database): DataFixResult {
  const result: DataFixResult = { name: LEG_TRADE_DATE_ISO_FIX, applied: true, rekeyed: 0, skippedCollisions: 0 };
  const rows = sqlite.prepare("SELECT id, trade_date FROM trade_legs ORDER BY id").all() as { id: number; trade_date: string | null }[];
  const rewrite = sqlite.prepare("UPDATE trade_legs SET trade_date = ? WHERE id = ?");
  for (const r of rows) {
    if (r.trade_date == null) continue;
    const iso = normalizeDate(r.trade_date);
    if (iso == null || iso === r.trade_date) continue;
    rewrite.run(iso, r.id);
    result.rekeyed++;
  }
  return result;
}

/**
 * SIGNAL-NOTES-BACKFILL (v4.3.0) — read the 42 seeded options-strategy rows'
 * signal back out of the notes they already carry, into `signal_json` (0072).
 *
 * `scripts/seed-options-account.ts` wrote each trade's signal as four lines of
 * `notes` because there was nowhere else to put it. Now there is. The parse
 * lives in `lib/domain/signal.ts` (pure, exhaustively unit-tested) and this is
 * just the loop: the fix has no account predicate — the log is one account's
 * today, but a book restored under another name is the same 42 trades — and it
 * NEVER writes `notes`. What was typed stays typed.
 *
 * IT REFUSES, IT DOES NOT GUESS. `parseSeededSignalNotes` answers null for
 * anything but an exact four-line match under one of the two setup tags, with a
 * direction that agrees with `option_type`; such a row is counted in
 * `skippedCollisions`, LOGGED BY ID, and left exactly as stored. Without the log
 * a refused row is silent — and a silent refusal in a one-shot fix is a row
 * nobody ever looks at again.
 *
 * `signal_json IS NULL` is what makes it idempotent AND safe: a user-edited
 * signal is never overwritten, and neither is the tombstone `{"v":1}` an
 * explicit clear stores — which is the whole reason that tombstone exists, since
 * `rerunDataFixesAfterRestore` forgets every marker and replays this fix.
 *
 * NO QUIET `hasColumn` GUARD (design review item 7). On a pre-0072 connection
 * the SELECT throws "no such column", the marker transaction rolls back, and
 * lib/db/index.ts swallows it so the fix runs again on the next open — which is
 * correct. A quiet `return` would be MARKED by `runDataFixes` (it marks after
 * ANY return) and the fix would be consumed forever, having done nothing.
 */
function applySignalNotesBackfill(sqlite: Database.Database): DataFixResult {
  const result: DataFixResult = { name: SIGNAL_NOTES_BACKFILL_FIX, applied: true, rekeyed: 0, skippedCollisions: 0 };
  const rows = sqlite
    .prepare(
      `SELECT id, notes, setup_tag, option_type
         FROM trades
        WHERE signal_json IS NULL
          AND notes LIKE 'Options strategy log #%'
          AND setup_tag IN ('CE BREAKOUT (RES)','PE BREAKDOWN (SUP)')
        ORDER BY id`,
    )
    .all() as { id: number; notes: string | null; setup_tag: string | null; option_type: string | null }[];
  const write = sqlite.prepare("UPDATE trades SET signal_json = ? WHERE id = ?");
  const skipped: number[] = [];

  for (const r of rows) {
    const signal = r.notes ? parseSeededSignalNotes(r.notes, r.setup_tag, r.option_type) : null;
    const json = signal ? serializeSignal(signal) : null;
    if (!json) {
      result.skippedCollisions++;
      skipped.push(r.id);
      continue;
    }
    write.run(json, r.id);
    result.rekeyed++;
  }
  if (skipped.length) console.log(`[data-fix] ${SIGNAL_NOTES_BACKFILL_FIX}: ${skipped.length} note(s) not read in full, left as they are — trade ids ${skipped.join(", ")}`);
  return result;
}

/**
 * risk-source-v1 (v4.4.0 D1) — say where every stored risk came from, then put
 * every cap-derived R on today's cap.
 *
 * Migration 0073 added `trades.risk_source` NULL on every row. This fix
 * classifies each row that holds a risk but states no source — with
 * `classifyRiskSource` (lib/queries/risk-cap.ts), the SAME function Trash
 * restore calls on a pre-0073 envelope — and then re-prices every `'cap'` row
 * to the cap its bucket/segment resolves to now. On an untouched install that
 * moves nothing (every legacy seed row inherits the global ₹9,500); a segment
 * cap the user set to anything else now drives that segment's R (owner ruling
 * Q6 — the release notes say so).
 *
 * ACROSS ACCOUNTS, ON PURPOSE: `risk_config` has no `account_id` (the caps are
 * per install, app/api/risk/live-desk/route.ts), so a row's cap does not
 * depend on which book it sits in; declared in the OWNERS registry of
 * tests/account-isolation.test.ts with that reason.
 *
 * Money is raw integer PAISE on both sides of these statements (invariant 1):
 * `risk_amount_paise` is written as rupees × 100, `net_pnl_paise` read ÷ 100,
 * once each. Idempotent: a classified row is never re-classified, and a re-price
 * writes only rows whose figures differ. Re-run after every backup restore
 * (`rerunDataFixesAfterRestore`), where it re-prices against the RESTORED caps.
 *
 * No quiet `hasColumn` guard, for the reason `signal-notes-backfill-v1` states:
 * on a pre-0073 connection the SELECT throws, the marker rolls back, and the
 * fix runs on the next open.
 */
function applyRiskSource(sqlite: Database.Database): DataFixResult {
  const classified = classifyUnsourcedRisk(sqlite);
  const repriced = repriceCapTrades(sqlite);
  return { name: RISK_SOURCE_FIX, applied: true, rekeyed: classified + repriced, skippedCollisions: 0 };
}

/**
 * dhan-gtr-symbols-v1 (v4.5.0 W1, F-L1-3) — put a Dhan Global Transaction
 * Report row under the TICKER the rest of the book is keyed on, and nothing
 * else.
 *
 * The GTR states a company NAME ("Aarti Industries") and no ISIN where Dhan's
 * own API states AARTIIND, so the same instrument sat in the book as two: the
 * duplicate scan buckets on `norm(tradingsymbol)` and could not see the C-6
 * remedy ("import a Dhan tradebook for …") re-importing days the API pull had
 * already brought in. The three Dhan report parsers that state a NAME (the
 * GTR, the P&L export, the Realised P&L) resolve it from now on; this is the
 * retrofit for rows already stored, and it covers all three the same way —
 * `import_batches` carries no source id, so the selection is "a Dhan batch,
 * labelled with something no ticker can be".
 *
 * IT WRITES `tradingsymbol`, `symbol` AND `isin`, AND NOTHING ELSE. No money
 * column, no re-classification, no `dedup_hash` and NO alias: identity stays
 * the name the bill stated, recorded as the `gtr-name:` segment this fix adds
 * to `import_notes` (lib/import/trade-identity.ts), which is exactly what the
 * parser now writes — so a re-import of the same report still de-duplicates
 * against these rows, with the hash unmoved. No position's P&L can move; only
 * which symbol a row groups under does, and the release notes say so.
 *
 * WHAT IT WILL NOT TOUCH:
 *   • a row with `import_batch_id IS NULL` — the JOIN alone refuses it. That is
 *     what protects a hand-entered or seeded book: the owner's account #3 is 42
 *     manual Dhan option rows (net ₹75,132.75) and none of them has a batch.
 *   • a row whose identity is FROZEN (an alias or an auto-close note) — the
 *     same guard the Paytm re-key makes (S-2).
 *   • a row already carrying a `gtr-name:` segment (idempotent; the markers are
 *     forgotten on every restore and this fix runs again).
 *   • a row whose `tradingsymbol` is a TICKER. A company name is mixed case
 *     ("Cupid"); no broker's ticker ever is, so `GLOB '*[a-z]*'` keeps every
 *     Dhan tradebook / API row in the same batch table out of this fix even
 *     when a one-word company name would otherwise have matched one.
 *   • a row that resolves to NOTHING — an abbreviated name ("Gujarat Narmada Valley
 *     Fert & Chem"), ambiguous, or an F&O contract. It is left exactly as
 *     stated and counted: a wrong ticker merges two companies (invariant 6).
 *
 * The chain is the documented one: the user's own Instruments table, then the
 * bundled listing snapshot, then the index map, then keep the name.
 */
function applyDhanGtrSymbols(sqlite: Database.Database): DataFixResult {
  const result: DataFixResult = { name: DHAN_GTR_SYMBOL_FIX, applied: true, rekeyed: 0, skippedCollisions: 0 };
  const rows = sqlite
    .prepare(
      `SELECT t.id AS id, t.tradingsymbol AS tradingsymbol, t.isin AS isin,
              t.import_notes AS import_notes, t.dedup_hash AS dedup_hash
         FROM trades t
         JOIN import_batches b ON b.id = t.import_batch_id
        WHERE t.import_batch_id IS NOT NULL
          AND t.broker = 'dhan'
          AND b.broker = 'dhan'
          AND t.tradingsymbol GLOB '*[a-z]*'
        ORDER BY t.id`,
    )
    .all() as { id: number; tradingsymbol: string; isin: string | null; import_notes: string | null; dedup_hash: string }[];
  if (rows.length === 0) return result;

  // The user's own Instruments table first — the only source that can know a
  // security listed after our snapshot. A key held by two instruments answers
  // with neither.
  const ownByName = new Map<string, { symbol: string; isin: string | null } | null>();
  const ownByIsin = new Map<string, string | null>();
  for (const r of sqlite
    .prepare("SELECT symbol, name, isin FROM instruments")
    .all() as { symbol: string; name: string | null; isin: string | null }[]) {
    const key = normalizeCompanyName(r.name ?? "");
    if (key) {
      const prior = ownByName.get(key);
      if (prior === undefined) ownByName.set(key, { symbol: r.symbol, isin: r.isin });
      else if (prior && prior.symbol !== r.symbol) ownByName.set(key, null);
    }
    const id = (r.isin ?? "").trim().toUpperCase();
    if (id) {
      const prior = ownByIsin.get(id);
      if (prior === undefined) ownByIsin.set(id, r.symbol);
      else if (prior && prior !== r.symbol) ownByIsin.set(id, null);
    }
  }

  const write = sqlite.prepare("UPDATE trades SET tradingsymbol = ?, symbol = ?, isin = ?, import_notes = ? WHERE id = ?");
  const unresolved: string[] = [];
  for (const r of rows) {
    if (isLotIdentityFrozen({ dedupHash: r.dedup_hash, importNotes: r.import_notes })) continue;
    if (dedupLabelFromNotes(r.import_notes) != null) continue;
    const name = r.tradingsymbol;
    const isin = (r.isin ?? "").trim().toUpperCase() || null;
    // The row's OWN ISIN answers first when it states one (the Realised P&L
    // report does); the company name second. Each through the user's table
    // before the bundled snapshots.
    const byName = ownByName.get(normalizeCompanyName(name)) ?? securityByCompanyName(name);
    const symbol =
      (isin ? (ownByIsin.get(isin) ?? bundledSymbolByIsin(isin)) : null) ?? byName?.symbol ?? null;
    if (!symbol) {
      result.skippedCollisions++;
      unresolved.push(name);
      continue;
    }
    // Nothing to regroup: the row already sits under the ticker.
    if (symbol.trim().toUpperCase() === name.trim().toUpperCase()) continue;
    write.run(symbol, symbol, isin ?? byName?.isin ?? null, withDedupLabelNote(r.import_notes, name), r.id);
    result.rekeyed++;
  }
  // Logged as a COUNT plus a sample: most of a real report's misses are F&O
  // contract names, which resolve to nothing by design, and a 79-name line on
  // every restore is noise nobody reads (measured on the owner's own GTR).
  if (unresolved.length) {
    const distinct = [...new Set(unresolved)];
    console.log(
      `[data-fix] ${DHAN_GTR_SYMBOL_FIX}: ${distinct.length} scrip name(s) not resolved (F&O contracts and abbreviated names resolve to nothing by design), left exactly as the report states them — e.g. ${distinct.slice(0, 5).join(", ")}`,
    );
  }
  return result;
}

/**
 * trades-side-v1 (v4.6.0 W6, contract D1) — state WHICH SIDE OPENED every row
 * migration 0077 left NULL.
 *
 * ONE implementation: `backfillSide` (lib/domain/side.ts), the same function
 * `sideOf` falls back to on a NULL — so a reader and this fix cannot disagree,
 * and there is no SQL copy. SQL could not be it: a 4.2.x row holds 'DD-MM-YYYY'
 * dates and a same-day ISO row can carry a time suffix, so a byte compare of
 * `sell_date < buy_date` labels a long as short (design review R-4).
 *
 * `side IS NULL` is what makes it idempotent AND safe on the replay every backup
 * restore runs (`rerunDataFixesAfterRestore`): a stated side — a writer's, or a
 * restored post-W6 row's — is never overwritten. Touches `side` and nothing else.
 *
 * No quiet `hasColumn` guard, for the reason `signal-notes-backfill-v1` states:
 * on a pre-0077 connection the SELECT throws, the marker rolls back, and the fix
 * runs on the next open.
 */
function applyTradesSide(sqlite: Database.Database): DataFixResult {
  const result: DataFixResult = { name: TRADES_SIDE_FIX, applied: true, rekeyed: 0, skippedCollisions: 0 };
  const rows = sqlite
    .prepare("SELECT id, buy_qty, sell_qty, buy_date, sell_date, import_notes FROM trades WHERE side IS NULL ORDER BY id")
    .all() as { id: number; buy_qty: number; sell_qty: number; buy_date: string | null; sell_date: string | null; import_notes: string | null }[];
  const write = sqlite.prepare("UPDATE trades SET side = ? WHERE id = ?");
  for (const r of rows) {
    const side = backfillSide({ buyQty: r.buy_qty, sellQty: r.sell_qty, buyDate: r.buy_date, sellDate: r.sell_date, importNotes: r.import_notes });
    // Fix wave (finding 2): no signal is no side — a flat, same-day-or-undated
    // row with no intraday-short note stays NULL rather than a guessed 'long'.
    if (side == null) continue;
    write.run(side, r.id);
    result.rekeyed++;
  }
  return result;
}

const FIXES: { name: string; apply: (sqlite: Database.Database) => DataFixResult }[] = [
  { name: PAYTM_DEDUP_FIX, apply: applyPaytmDedupIsin },
  { name: IPO_ACCOUNT_REHOME_FIX, apply: applyIpoAccountRehome },
  { name: LEG_TRADE_DATE_ISO_FIX, apply: applyLegTradeDateIso },
  { name: SIGNAL_NOTES_BACKFILL_FIX, apply: applySignalNotesBackfill },
  { name: RISK_SOURCE_FIX, apply: applyRiskSource },
  { name: DHAN_GTR_SYMBOL_FIX, apply: applyDhanGtrSymbols },
  { name: TRADES_SIDE_FIX, apply: applyTradesSide },
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
