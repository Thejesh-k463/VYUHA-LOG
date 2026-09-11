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
 */
export function refreshRateCards(sqlite, templatePath, log = console.log) {
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
