// Rate-card refresh for the desktop sidecar (scripts/desktop-server.mjs).
// Plain ESM under plain Node: imports only node:fs, takes an OPEN
// better-sqlite3 connection, and is unit-tested by tests/rate-card-refresh.test.ts.
import fs from "node:fs";

/**
 * Bring charge_config up to date with the rate cards this build ships.
 *
 * Migrations already ran on every launch, but SEEDING did not: it happened once,
 * when the database file was first created. So a broker added in a later release,
 * or a rate corrected after a broker revised its card, never reached anyone who
 * had already installed Vyuha — the app kept quoting figures from the build the
 * user first ran, and the new brokers showed as "unpriced" forever.
 *
 * THE ROW IDENTITY IS READ FROM THE USER DATABASE'S OWN UNIQUE INDEX
 * (`charge_config_uq`), never written out by hand. Migration 0050 (v3.2.0) made
 * it five columns — broker, plan, segment, exchange, effective_from — so one key
 * can hold several dated epochs (the F&O STT change of 2026-04-01 is two rows
 * per key). This function used to hard-code the old four columns: both epoch
 * rows of a key then matched the same template row, the UPDATE gave them the
 * same effective_from, and it died on the unique index on EVERY launch of every
 * v3.2.0+ install — after the INSERT had already autocommitted, so new epochs
 * landed and corrections never did (two overlapping open-ended epochs per F&O
 * key, the 1970 one carrying the post-2026 STT). Deriving the key from the index
 * means the next index change cannot desync it.
 *
 * The INSERT and the UPDATE run in ONE transaction: a refresh either lands
 * whole or not at all. ATTACH/DETACH stay outside it (SQLite refuses to ATTACH
 * inside a transaction).
 *
 * Rows the user edited are pinned by `user_edited` and never touched: their
 * number came from their own contract note and outranks ours. And, parity with
 * lib/db/seed-core.ts, a seed epoch whose start falls inside a user-edited row's
 * [effective_from, effective_to) window is neither ADDED nor REFRESHED — an
 * epoch inserted beside a user-edited open row would win `findRates`
 * (newest-first) and silently shadow the rate the user verified.
 *
 * A NON-edited row already sitting inside such a window is REMOVED first
 * (v4.3.0 R54, parity with seed-core's refreshChargeConfig). The guard alone
 * only stops new ones: a pre-v3.2.0 install whose user edited an F&O row got
 * its 1970 stamp, and v4.2.0's unguarded INSERT then landed the 2026-04-01
 * epoch beside it — a row the guard kept from the UPDATE but nothing deleted,
 * so it went on overriding the user's rate for every trade dated from its
 * start. Users edit rates, never dates, so the user's window is the authority
 * on those dates; the removed row is one the template can always reproduce.
 *
 * Rates only: charges already stored on trades are not rewritten here.
 *
 * The template is the same seed the TypeScript path writes (build-desktop.mjs
 * generates it by running that seed), so both routes agree by construction.
 *
 * Returns { added, refreshed, removed }, or { skipped: reason } when it cannot
 * run safely.
 *
 * THE MARGIN HALF (v4.6.0 fix wave, SM-1) runs after it, on its own ATTACH, and
 * reports on its own line: `refreshMarginRows` below. The return value stays the
 * charge half's, so every caller and pin of it reads what it always read.
 */
export function refreshRateCards(sqlite, templatePath, log = console.log) {
  const charge = refreshChargeRows(sqlite, templatePath, log);
  refreshMarginRows(sqlite, templatePath, log);
  return charge;
}

/**
 * Add every margin_config row the template ships that the user database lacks —
 * INSERT OR IGNORE on the (broker, segment) unique key, so an existing row
 * (edited or not, a hand-added one included) is never touched and a second run
 * adds 0. Parity with `refreshMarginConfig` (lib/db/seed-core.ts), which the two
 * restore paths call inside their transactions: a 4.5.0 database, backup or
 * baseline has no Fyers / Nuvama rows, and `capitalBlocked` then assumed 100% of
 * notional for their derivatives. Only columns both databases have are copied.
 *
 * Returns { added }, or { skipped: reason }.
 */
export function refreshMarginRows(sqlite, templatePath, log = console.log) {
  const skip = (reason) => {
    log(`[vyuha] margin rates: skipped — ${reason}`);
    return { skipped: reason };
  };
  if (!templatePath || !fs.existsSync(templatePath)) return skip("no seed template bundled");
  const cols = sqlite.prepare("PRAGMA main.table_info(margin_config)").all().map((c) => c.name);
  if (cols.length === 0) return skip("no margin_config table");
  sqlite.prepare("ATTACH ? AS seedtpl").run(templatePath);
  try {
    const tplCols = new Set(sqlite.prepare("PRAGMA seedtpl.table_info(margin_config)").all().map((c) => c.name));
    // The row id and its own stamp are the user database's, never the template's.
    const own = new Set(["id", "updated_at"]);
    const shared = cols.filter((c) => tplCols.has(c) && !own.has(c));
    if (!shared.includes("broker") || !shared.includes("segment")) return skip("template lacks a key column");
    const list = shared.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
    const added = sqlite.prepare(`INSERT OR IGNORE INTO main.margin_config (${list}) SELECT ${list} FROM seedtpl.margin_config`).run().changes;
    log(`[vyuha] margin rates: ${added} added (existing rows kept)`);
    return { added };
  } finally {
    sqlite.exec("DETACH seedtpl");
  }
}

/** The charge_config half of `refreshRateCards` — see its comment above. */
function refreshChargeRows(sqlite, templatePath, log) {
  const skip = (reason) => {
    log(`[vyuha] rate cards: skipped — ${reason}`);
    return { skipped: reason };
  };
  if (!templatePath || !fs.existsSync(templatePath)) return skip("no seed template bundled");

  const q = (c) => `"${c.replace(/"/g, '""')}"`;
  const uq = sqlite
    .prepare("PRAGMA main.index_list(charge_config)")
    .all()
    .find((i) => i.name === "charge_config_uq" && i.unique);
  if (!uq) return skip("charge_config_uq index not found");
  const KEY = sqlite
    .prepare("PRAGMA main.index_info(charge_config_uq)")
    .all()
    .sort((a, b) => a.seqno - b.seqno)
    .map((c) => c.name);
  if (KEY.length === 0 || KEY.some((k) => k == null)) return skip("charge_config_uq has no plain columns");

  const cols = sqlite
    .prepare("PRAGMA main.table_info(charge_config)")
    .all()
    .map((c) => c.name);

  sqlite.prepare("ATTACH ? AS seedtpl").run(templatePath);
  try {
    // Only columns BOTH databases have — an older template must not break launch.
    const tplCols = new Set(
      sqlite.prepare("PRAGMA seedtpl.table_info(charge_config)").all().map((c) => c.name),
    );
    const shared = cols.filter((c) => tplCols.has(c) && c !== "id");
    if (!KEY.every((k) => shared.includes(k))) return skip("template lacks a key column");

    // The template must be unique on the user's key, or the correlated SET below
    // would pick an arbitrary template row (a user DB still on an older index
    // after a failed migration, facing an epoch-carrying template).
    const ambiguous = sqlite
      .prepare(
        `SELECT count(*) AS n FROM (SELECT 1 FROM seedtpl.charge_config
           GROUP BY ${KEY.map(q).join(", ")} HAVING count(*) > 1)`,
      )
      .get().n;
    if (ambiguous > 0) return skip(`template is not unique on (${KEY.join(", ")})`);

    const values = shared.filter((c) => !KEY.includes(c) && c !== "user_edited" && c !== "updated_at");
    const list = shared.map(q).join(", ");
    const sList = shared.map((c) => `s.${q(c)}`).join(", ");
    const match = KEY.map((k) => `t.${q(k)} IS s.${q(k)}`).join(" AND ");

    // The user-edit guard: a user_edited row of the same broker/plan/segment/
    // exchange whose window covers the seed epoch's start owns that date range.
    // Windows are inclusive-from / exclusive-to; a NULL effective_to is open.
    const epochs = shared.includes("effective_from") && shared.includes("effective_to");
    const guard = (alias) =>
      epochs
        ? `NOT EXISTS (SELECT 1 FROM main.charge_config u
             WHERE u.user_edited = 1
               AND u."broker" = ${alias}."broker" AND u."plan" IS ${alias}."plan"
               AND u."segment" = ${alias}."segment" AND u."exchange" = ${alias}."exchange"
               AND u."effective_from" <= ${alias}."effective_from"
               AND (u."effective_to" IS NULL OR u."effective_to" > ${alias}."effective_from"))`
        : "1";

    const set = values.map((c) => `${q(c)} = (SELECT s.${q(c)} FROM seedtpl.charge_config s WHERE ${match})`);
    // `IS NOT` is SQLite's null-safe comparison, so an unchanged row with NULLs
    // in it does not count as a difference and get rewritten every launch.
    const differs = values.length ? values.map((c) => `t.${q(c)} IS NOT s.${q(c)}`).join(" OR ") : "0";

    // A non-edited row whose start a user-edited window of its key covers
    // (NOT the guard = such a window EXISTS). With no epoch columns the guard
    // is "1", so this removes nothing.
    const remove = sqlite.prepare(
      `DELETE FROM main.charge_config AS d WHERE d.user_edited = 0 AND NOT (${guard("d")})`,
    );
    const insert = sqlite.prepare(
      `INSERT OR IGNORE INTO main.charge_config (${list})
       SELECT ${sList} FROM seedtpl.charge_config s WHERE ${guard("s")}`,
    );
    const update = values.length
      ? sqlite.prepare(
          `UPDATE main.charge_config AS t SET ${set.join(", ")}
           WHERE t.user_edited = 0
             AND ${guard("t")}
             AND EXISTS (SELECT 1 FROM seedtpl.charge_config s WHERE ${match} AND (${differs}))`,
        )
      : null;

    // Property order is run order: the DELETE lands before the INSERT and UPDATE.
    const { added, refreshed, removed } = sqlite.transaction(() => ({
      removed: remove.run().changes,
      added: insert.run().changes,
      refreshed: update ? update.run().changes : 0,
    }))();
    log(`[vyuha] rate cards: ${added} added, ${refreshed} refreshed, ${removed} removed (user edits kept)`);
    return { added, refreshed, removed };
  } finally {
    sqlite.prepare("DETACH seedtpl").run();
  }
}
