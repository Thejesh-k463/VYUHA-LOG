import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { db, sqlite, schema } from "@/lib/db";
import { attachmentsDir } from "@/lib/db";
import {
  BACKUP_VERSION,
  BACKUP_TABLES,
  ENCRYPTED_BACKUP_VERSION,
  SCRYPT_PARAMS_V2,
  scryptMaxmem,
  paramsOf,
  validateBackup,
  type BackupEnvelope,
  type BackupTable,
  type EncryptedBackupEnvelope,
  isEncryptedBackup,
} from "@/lib/backup-format";

// P0.4 — backup/restore engine. Operates through the live Drizzle connection so it
// works without juggling file handles. Restore is transactional (all-or-nothing).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TABLE_MAP: Record<BackupTable, any> = {
  accounts: schema.accounts,
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
  trade_legs: schema.tradeLegs,
  symbol_aliases: schema.symbolAliases,
  benchmark_prices: schema.benchmarkPrices,
  instruments: schema.instruments,
  price_history: schema.priceHistory,
  corporate_actions: schema.corporateActions,
  playbooks: schema.playbooks,
  margin_config: schema.marginConfig,
  trade_attachments: schema.tradeAttachments,
  broker_connections: schema.brokerConnections,
  trading_sessions: schema.tradingSessions,
  regulatory_rule_packs: schema.regulatoryRulePacks,
};

/** Full JSON dump of every table. */
export function dumpDatabase(includeAttachments = true): BackupEnvelope {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const name of BACKUP_TABLES) {
    const rows = db.select().from(TABLE_MAP[name]).all();
    tables[name] = rows;
    counts[name] = rows.length;
  }
  const attachments: NonNullable<BackupEnvelope["attachments"]> = [];
  if (includeAttachments && fs.existsSync(attachmentsDir)) {
    for (const row of db.select().from(schema.tradeAttachments).all()) {
      const file = path.join(attachmentsDir, path.basename(row.storedName));
      if (fs.existsSync(file)) attachments.push({ storedName: path.basename(row.storedName), mime: row.mime, dataBase64: fs.readFileSync(file).toString("base64") });
    }
  }
  return { vyuhaBackup: true, version: BACKUP_VERSION, createdAt: new Date().toISOString(), counts, tables, attachments };
}

export function encryptBackup(dump: BackupEnvelope, password: string): EncryptedBackupEnvelope {
  if (password.length < 8) throw new Error("Backup password must be at least 8 characters.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const params = SCRYPT_PARAMS_V2;
  const key = scryptSync(password, salt, 32, { ...params, maxmem: scryptMaxmem(params) });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(dump), "utf8"), cipher.final()]);
  return {
    vyuhaEncrypted: true,
    version: ENCRYPTED_BACKUP_VERSION,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    kdfParams: params,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptBackup(value: unknown, password: string): unknown {
  if (!isEncryptedBackup(value)) return value;
  try {
    const salt = Buffer.from(value.salt, "base64");
    const iv = Buffer.from(value.iv, "base64");
    // Read the cost the file was SEALED with, not the current one, so raising
    // the cost never strands a backup already sitting on someone's disk.
    const params = paramsOf(value);
    const key = scryptSync(password, salt, 32, { ...params, maxmem: scryptMaxmem(params) });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    const raw = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Could not decrypt backup — check the password and file.");
  }
}

export function previewBackup(value: unknown, password = "") {
  let decoded: unknown;
  try { decoded = decryptBackup(value, password); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Could not decrypt backup." }; }
  const v = validateBackup(decoded);
  if (!v.ok) return v;
  const d = decoded as BackupEnvelope;
  return { ok: true, message: "Backup is valid.", version: d.version, createdAt: d.createdAt, counts: d.counts, totalRows: Object.values(d.counts ?? {}).reduce((s, n) => s + Number(n || 0), 0), attachments: d.attachments?.length ?? 0, dump: d };
}

/**
 * Wipe every table and reload from a validated dump.
 *
 * A restore replaces a user's entire journal, so the ordering below is chosen so
 * that ANY failure leaves the existing data intact:
 *
 *   1. decode + stage the incoming attachment bytes to a sibling directory
 *      (a malformed payload fails here, before anything is touched)
 *   2. run the table swap inside one transaction (a bad row rolls the lot back)
 *   3. only after the commit, swap the staged directory into place
 *
 * Attachments are replaced ONLY when the backup actually carries some. A backup
 * exported without them says nothing about which files should exist, and the
 * asymmetry of guessing wrong is total: an orphaned file on disk is invisible
 * and reclaimable, a deleted screenshot is gone. So the files stay.
 */
export function restoreDatabase(dump: unknown): { ok: boolean; message: string; restored?: number } {
  const v = validateBackup(dump);
  if (!v.ok) return { ok: false, message: v.message };
  const tables = v.tables!;
  const incoming = (dump as BackupEnvelope).attachments ?? [];

  // ---- 1. stage attachments -------------------------------------------------
  // `stagingDir` is a plain const rather than a nullable, and `replaceAttachments`
  // carries the decision: a `string | null` in the path.join below makes the
  // bundler's static file-pattern analysis widen to the whole project tree.
  const stagingDir = `${attachmentsDir}.restoring`;
  const replaceAttachments = incoming.length > 0;
  if (replaceAttachments) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.mkdirSync(stagingDir, { recursive: true });
      for (const a of incoming) {
        const safe = path.basename(a.storedName);
        if (!safe || safe !== a.storedName) continue; // never write outside the directory
        fs.writeFileSync(path.join(stagingDir, safe), Buffer.from(a.dataBase64, "base64"));
      }
    } catch (e) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      return { ok: false, message: `Could not unpack the backup's attachments — ${e instanceof Error ? e.message : "unknown error"}. Nothing was changed.` };
    }
  }

  // ---- 2. swap the tables ---------------------------------------------------
  let result: { ok: boolean; message: string; restored: number };
  try {
    result = db.transaction((tx) => {
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
      if ((tables.accounts ?? []).length === 0) tx.insert(schema.accounts).values({ id: 1, name: "Primary", isDefault: true }).run();
      return { ok: true, message: `Restored ${restored} rows across ${BACKUP_TABLES.length} tables.`, restored };
    });
  } catch (e) {
    if (replaceAttachments) fs.rmSync(stagingDir, { recursive: true, force: true });
    return { ok: false, message: `Restore failed and was rolled back — ${e instanceof Error ? e.message : "unknown error"}. Your journal is unchanged.` };
  }

  // ---- 3. swap the attachment directory in ----------------------------------
  if (replaceAttachments) {
    const retired = `${attachmentsDir}.replaced`;
    try {
      fs.rmSync(retired, { recursive: true, force: true });
      if (fs.existsSync(attachmentsDir)) fs.renameSync(attachmentsDir, retired);
      fs.renameSync(stagingDir, attachmentsDir);
      fs.rmSync(retired, { recursive: true, force: true });
    } catch (e) {
      // The journal is already restored and correct; only the screenshots are
      // in doubt. Say so plainly rather than reporting a clean success.
      return { ok: true, message: `${result.message} Screenshots could not be swapped in (${e instanceof Error ? e.message : "unknown error"}) — see ${path.basename(stagingDir)}.`, restored: result.restored };
    }
  }

  return result;
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
