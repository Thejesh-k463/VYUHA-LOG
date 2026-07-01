import path from "node:path";
import fs from "node:fs";

// Clean + migrate + seed the e2e database BEFORE next dev starts serving, so the
// first (DB-backed) page render succeeds. VYUHA_DB_PATH is provided by Playwright.
async function main() {
  const E2E_DB = process.env.VYUHA_DB_PATH ?? path.join(process.cwd(), "data", "e2e.sqlite");
  for (const f of [E2E_DB, `${E2E_DB}-wal`, `${E2E_DB}-shm`]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  const { db, sqlite } = await import("../lib/db/index");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("../lib/db/seed-core");
  seedDatabase();
  sqlite.close();
  console.log("✓ e2e DB ready:", E2E_DB);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
