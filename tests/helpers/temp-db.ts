import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A throwaway migrated SQLite database for tests that genuinely need one.
 *
 * Almost every test in this suite runs against pure modules and needs no
 * database at all — that is the point of the lib/{engine,analytics,risk,domain}
 * rule. Two things cannot be tested that way, because the behaviour under test
 * IS the I/O:
 *
 *   - backup/restore  (tests/backup-roundtrip.test.ts)
 *   - account isolation in lib/queries/*  (tests/account-isolation.test.ts)
 *
 * HOW IT WORKS: lib/db/index.ts resolves its file from `VYUHA_DB_PATH` at
 * import time and then caches the connection on globalThis. So the env var must
 * be set BEFORE the first `import("@/lib/db")` anywhere in the module graph —
 * which is why callers must use dynamic `import()` inside the test, never a
 * top-level static import of lib/db or of anything that pulls it in
 * (lib/backup.ts, lib/queries/*).
 *
 * The connection cache is also why `openTempDb` asserts the path it got back is
 * the path it asked for: if a future refactor makes Vitest share a module
 * registry across files, the second file would silently reuse the first file's
 * database and its assertions would be meaningless. Failing loudly there beats
 * passing dishonestly.
 */

export interface TempDb {
  /** Drizzle handle bound to the temp file. */
  db: Awaited<typeof import("@/lib/db")>["db"];
  /** Raw better-sqlite3 connection. */
  sqlite: Awaited<typeof import("@/lib/db")>["sqlite"];
  schema: Awaited<typeof import("@/lib/db")>["schema"];
  /** Where attachments land for this database (`<dir>/attachments`). */
  attachmentsDir: string;
  dbPath: string;
  dir: string;
  /** Close the connection and delete the whole temp directory. */
  cleanup: () => void;
}

/**
 * Create a migrated (and optionally seeded) temp database.
 *
 * @param label short tag used in the temp directory name, for debugging
 * @param opts.seed run lib/db/seed-core#seedDatabase — creates the `accounts`
 *   row, the `settings` row and the charge/margin/risk rate tables. Needed by
 *   anything that reads settings (account selection) or prices a trade.
 */
export async function openTempDb(label: string, opts: { seed?: boolean } = {}): Promise<TempDb> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vyuha-${label}-`));
  const dbPath = path.join(dir, "vyuha-test.sqlite");
  process.env.VYUHA_DB_PATH = dbPath;

  const dbmod = await import("@/lib/db");

  // Guard against a leaked module registry handing us someone else's database.
  if (path.resolve(dbmod.sqlite.name) !== path.resolve(dbPath)) {
    throw new Error(
      `temp-db: expected the connection at ${dbPath} but lib/db is bound to ${dbmod.sqlite.name}. ` +
        `Something imported lib/db before openTempDb() ran — use dynamic import() inside the test.`,
    );
  }

  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbmod.db, { migrationsFolder: "./drizzle" });

  if (opts.seed) {
    const { seedDatabase } = await import("@/lib/db/seed-core");
    seedDatabase();
  }

  return {
    db: dbmod.db,
    sqlite: dbmod.sqlite,
    schema: dbmod.schema,
    attachmentsDir: dbmod.attachmentsDir,
    dbPath,
    dir,
    cleanup() {
      try {
        dbmod.sqlite.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let dedupSeq = 0;

/**
 * Minimal valid `trades` row — every column the schema leaves without a default.
 *
 * `dedupHash` is unique per call because `trades_account_broker_dedup_uq`
 * spans (account_id, broker, dedup_hash): two default rows for the same broker
 * would collide. Pass an explicit `dedupHash` when a test wants that collision.
 */
export function tradeRow(over: Record<string, unknown> = {}) {
  return {
    broker: "dhan",
    bucket: "equity",
    segment: "eq_delivery",
    instrumentType: "equity",
    exchange: "NSE",
    symbol: "TCS",
    tradingsymbol: "TCS",
    dedupHash: `test-dedup-${++dedupSeq}`,
    ...over,
  };
}
