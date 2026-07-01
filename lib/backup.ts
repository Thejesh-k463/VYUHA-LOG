import "server-only";
import fs from "node:fs";
import { db, sqlite, schema } from "@/lib/db";
import {
  BACKUP_VERSION,
  BACKUP_TABLES,
  validateBackup,
  type BackupEnvelope,
  type BackupTable,
} from "@/lib/backup-format";

// P0.4 — backup/restore engine. Operates through the live Drizzle connection so it
// works without juggling file handles. Restore is transactional (all-or-nothing).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TABLE_MAP: Record<BackupTable, any> = {
  settings: schema.settings,
  charge_config: schema.chargeConfig,
  risk_config: schema.riskConfig,
  capital_snapshots: schema.capitalSnapshots,
  import_batches: schema.importBatches,
  trades: schema.trades,
  positions: schema.positions,
  classification_overrides: schema.classificationOverrides,
  mtm_prices: schema.mtmPrices,
  ipos: schema.ipos,
  restricted_securities: schema.restrictedSecurities,
  ledger_entries: schema.ledgerEntries,
  audit_log: schema.auditLog,
};

/** Full JSON dump of every table. */
export function dumpDatabase(): BackupEnvelope {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const name of BACKUP_TABLES) {
    const rows = db.select().from(TABLE_MAP[name]).all();
    tables[name] = rows;
    counts[name] = rows.length;
  }
  return { vyuhaBackup: true, version: BACKUP_VERSION, createdAt: new Date().toISOString(), counts, tables };
}

/** Wipe every table and reload from a validated dump, atomically. */
export function restoreDatabase(dump: unknown): { ok: boolean; message: string; restored?: number } {
  const v = validateBackup(dump);
  if (!v.ok) return { ok: false, message: v.message };
  const tables = v.tables!;
  return db.transaction((tx) => {
    for (const name of [...BACKUP_TABLES].reverse()) tx.delete(TABLE_MAP[name]).run();
    let restored = 0;
    for (const name of BACKUP_TABLES) {
      const rows = (tables[name] ?? []) as Record<string, unknown>[];
      for (const r of rows) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.insert(TABLE_MAP[name]).values(r as any).run();
        restored++;
      }
    }
    return { ok: true, message: `Restored ${restored} rows across ${BACKUP_TABLES.length} tables.`, restored };
  });
}

/** Raw SQLite file bytes (WAL checkpointed first for a consistent snapshot). */
export function readSqliteFile(): Buffer {
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* ignore */
  }
  return fs.readFileSync(sqlite.name);
}

export function dbCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of BACKUP_TABLES) counts[name] = db.select().from(TABLE_MAP[name]).all().length;
  return counts;
}
