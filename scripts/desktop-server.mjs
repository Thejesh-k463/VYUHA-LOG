// Sidecar entrypoint for the Tauri desktop app.
// Runs under plain Node (no tsx). It:
//   1. resolves the per-user data dir (passed by Tauri via VYUHA_DATA_DIR),
//   2. seeds the SQLite file from the bundled template on first run (and stamps
//      the journal's go-live date),
//   3. applies any pending Drizzle migrations (schema upgrades on update; a
//      pre-migration backup is written only when a migration is pending),
//   4. refreshes the rate cards on every launch (new brokers / corrected rates —
//      scripts/rate-card-refresh.mjs, in its own error handler),
//   5. starts the Next.js standalone server bound to localhost.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const dataDir = process.env.VYUHA_DATA_DIR || path.join(here, "userdata");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "vyuha.sqlite");
const seedTemplate = path.join(here, "vyuha.seed.sqlite");
if (!fs.existsSync(dbPath) && fs.existsSync(seedTemplate)) {
  fs.copyFileSync(seedTemplate, dbPath);
  console.log("[vyuha] initialized database from seed template →", dbPath);
  // The clean template ships a 1970-01-01 sentinel go-live (and zero capital):
  // this user's journal starts today, not on the day the installer was built.
  // Runs only on the first-run copy, so a user's own go-live is never touched.
  try {
    const { default: Database } = await import("better-sqlite3");
    const s = new Database(dbPath);
    const today = new Date().toISOString().slice(0, 10);
    const r = s.prepare("UPDATE settings SET go_live_date = ? WHERE go_live_date = '1970-01-01'").run(today);
    if (r.changes > 0) {
      s.prepare("UPDATE capital_snapshots SET as_of_date = ? WHERE as_of_date = '1970-01-01'").run(today);
      console.log("[vyuha] first launch — journal go-live stamped", today);
    }
    s.close();
  } catch (e) {
    console.warn("[vyuha] go-live stamp skipped:", e.message);
  }
}

// Apply pending migrations (idempotent; safe on every launch, incl. app updates).
// A pre-migration backup of the user DB is written first — parity with the dev
// migrate path (lib/db/migrate.ts), so a bad upgrade can never eat the journal.
//
// Migration and rate-card refresh are TWO steps with TWO error handlers. They
// used to share one try, so a refresh failure (it threw on every launch from
// v3.2.0 to v4.2) was logged as "migration step failed" and skipped close().
// A genuine migration failure still lets the server start, as it always has.
const migrationsDir = path.join(here, "drizzle");
if (fs.existsSync(migrationsDir)) {
  let sqlite;
  try {
    const { default: Database } = await import("better-sqlite3");
    sqlite = new Database(dbPath);

    try {
      const { drizzle } = await import("drizzle-orm/better-sqlite3");
      const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

      // Back up ONLY when this launch will actually migrate. The old code copied
      // the whole DB on EVERY launch — 30-150 ms of blocking I/O and up to ten
      // retained copies (70-350 MB at a large book) protecting against nothing
      // on the 99% of launches with no pending migration. The journal table is
      // the same source drizzle's migrator reads, so the check and the migration
      // cannot disagree about what "pending" means.
      let appliedCount = 0;
      try {
        appliedCount = sqlite
          .prepare("SELECT count(*) AS n FROM __drizzle_migrations")
          .get().n;
      } catch {
        appliedCount = 0; // fresh database — everything is pending
      }
      const journal = JSON.parse(
        fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
      );
      const pending = journal.entries.length > appliedCount;

      if (pending && fs.existsSync(dbPath)) {
        const backupsDir = path.join(dataDir, "backups");
        fs.mkdirSync(backupsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        // The connection's own backup API, NOT copyFileSync: with WAL on, a raw
        // file copy misses whatever still lives in the -wal sidecar — a backup
        // taken after an unclean shutdown could silently lack committed trades.
        // backup() checkpoints through the connection and is correct by
        // construction.
        await sqlite.backup(path.join(backupsDir, `pre-migrate-${stamp}.sqlite`));
        // Keep only the newest 10 pre-migrate backups.
        const old = fs
          .readdirSync(backupsDir)
          .filter((f) => f.startsWith("pre-migrate-") && f.endsWith(".sqlite"))
          .sort()
          .slice(0, -10);
        for (const f of old) fs.rmSync(path.join(backupsDir, f), { force: true });
        console.log("[vyuha] pre-migration backup →", backupsDir);
      }

      migrate(drizzle(sqlite), { migrationsFolder: migrationsDir });
      console.log(pending ? "[vyuha] migrations applied" : "[vyuha] schema current — no migration, no backup");
    } catch (e) {
      console.error("[vyuha] migration step failed:", e?.message ?? e);
    }

    // Rate cards (scripts/rate-card-refresh.mjs): its own step, its own handler.
    // Loaded dynamically so a packaging slip (the module missing beside this
    // file) degrades to a logged line instead of ERR_MODULE_NOT_FOUND killing
    // the sidecar before the server starts.
    try {
      const { refreshRateCards } = await import(pathToFileURL(path.join(here, "rate-card-refresh.mjs")).href);
      refreshRateCards(sqlite, seedTemplate);
    } catch (e) {
      console.error("[vyuha] rate-card refresh failed (journal and schema untouched):", e?.message ?? e);
    }
  } catch (e) {
    console.error("[vyuha] database could not be opened — migrations and rate-card refresh skipped:", e?.message ?? e);
  } finally {
    if (sqlite) sqlite.close();
  }
}

process.env.VYUHA_DB_PATH = dbPath;
process.env.PORT = process.env.PORT || "3000";
process.env.HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
process.env.NODE_ENV = "production";

// The Next standalone server resolves .next/static, public and node_modules
// relative to its own location, so run from here.
process.chdir(here);

console.log(`[vyuha] starting on http://${process.env.HOSTNAME}:${process.env.PORT}  (db: ${dbPath})`);
// On Windows an absolute path must be a file:// URL for dynamic import().
await import(pathToFileURL(path.join(here, "server.js")).href);
