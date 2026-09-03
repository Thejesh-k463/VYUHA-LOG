import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import { db, sqlite } from "./index";
import { runDataFixes } from "./data-fixes";

// P0.4 — auto-backup the database before applying any migration.
try {
  const src = sqlite.name;
  if (fs.existsSync(src)) {
    try {
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    const dir = path.join(process.cwd(), "data", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(src, path.join(dir, `vyuha-premigrate-${ts}.sqlite`));
    console.log("✓ Pre-migration backup → data/backups/");
  }
} catch (e) {
  console.warn("Pre-migration backup skipped:", e);
}

// Apply all generated migrations in ./drizzle to the local SQLite file.
migrate(db, { migrationsFolder: "./drizzle" });
// Name the file we ACTUALLY migrated. This line used to hard-code
// "./data/vyuha.sqlite", so a `VYUHA_DB_PATH=data/perf.sqlite npm run db:migrate`
// migrated the perf database while reporting the dev one — the command looked
// like it had done nothing, which invites re-running it against the wrong file.
console.log(`✓ Migrations applied to ${sqlite.name}`);
// Row rewrites that SQL cannot express (lib/db/data-fixes.ts). index.ts ran
// them when the connection opened, but that was BEFORE this run's migrations —
// a fix whose ledger table 0059 just created is applied here, now, and logged.
for (const r of runDataFixes(sqlite)) {
  if (r.applied) console.log(`✓ Data fix ${r.name}: ${r.rekeyed} rows re-keyed, ${r.skippedCollisions} collisions left as-is`);
}
sqlite.close();
