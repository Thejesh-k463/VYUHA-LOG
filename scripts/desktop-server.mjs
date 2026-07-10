// Sidecar entrypoint for the Tauri desktop app.
// Runs under plain Node (no tsx). It:
//   1. resolves the per-user data dir (passed by Tauri via VYUHA_DATA_DIR),
//   2. seeds the SQLite file from the bundled template on first run,
//   3. applies any pending Drizzle migrations (handles schema upgrades on update),
//   4. starts the Next.js standalone server bound to localhost.
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
}

// Apply pending migrations (idempotent; safe on every launch, incl. app updates).
// A pre-migration backup of the user DB is written first — parity with the dev
// migrate path (lib/db/migrate.ts), so a bad upgrade can never eat the journal.
const migrationsDir = path.join(here, "drizzle");
if (fs.existsSync(migrationsDir)) {
  try {
    if (fs.existsSync(dbPath)) {
      const backupsDir = path.join(dataDir, "backups");
      fs.mkdirSync(backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      fs.copyFileSync(dbPath, path.join(backupsDir, `pre-migrate-${stamp}.sqlite`));
      // Keep only the newest 10 pre-migrate backups.
      const old = fs
        .readdirSync(backupsDir)
        .filter((f) => f.startsWith("pre-migrate-") && f.endsWith(".sqlite"))
        .sort()
        .slice(0, -10);
      for (const f of old) fs.rmSync(path.join(backupsDir, f), { force: true });
      console.log("[vyuha] pre-migration backup →", backupsDir);
    }
    const { default: Database } = await import("better-sqlite3");
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    const sqlite = new Database(dbPath);
    migrate(drizzle(sqlite), { migrationsFolder: migrationsDir });
    sqlite.close();
    console.log("[vyuha] migrations applied");
  } catch (e) {
    console.error("[vyuha] migration step failed:", e?.message ?? e);
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
