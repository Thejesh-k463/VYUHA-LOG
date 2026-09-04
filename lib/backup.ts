import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, sqlite, schema } from "@/lib/db";
import { rerunDataFixesAfterRestore } from "@/lib/db/data-fixes";
import { attachmentsDir } from "@/lib/db";
import {
  BACKUP_VERSION,
  BACKUP_TABLES,
  SETTINGS_MACHINE_COLUMNS,
  BROKER_SECRET_COLUMNS,
  ENCRYPTED_BACKUP_VERSION,
  SCRYPT_PARAMS_V2,
  scryptMaxmem,
  paramsOf,
  validateBackup,
  type BackupEnvelope,
  type BackupTable,
  type EncryptedBackupEnvelope,
  isEncryptedBackup,
  settingsMachineBlank,
} from "@/lib/backup-format";

// P0.4 — backup/restore engine. Operates through the live Drizzle connection so it
// works without juggling file handles. Restore is transactional (all-or-nothing).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TABLE_MAP: Record<BackupTable, any> = {
  accounts: schema.accounts,
  settings: schema.settings,
  settings_baseline: schema.settingsBaseline,
  charge_config: schema.chargeConfig,
  risk_config: schema.riskConfig,
  capital_snapshots: schema.capitalSnapshots,
  capital_goals: schema.capitalGoals,
  bf_loss_lots: schema.bfLossLots,
  weekly_reviews: schema.weeklyReviews,
  advance_tax_challans: schema.advanceTaxChallans,
  import_batches: schema.importBatches,
  trades: schema.trades,
  classification_overrides: schema.classificationOverrides,
  mtm_prices: schema.mtmPrices,
  ipos: schema.ipos,
  restricted_securities: schema.restrictedSecurities,
  ledger_entries: schema.ledgerEntries,
  broker_reference: schema.brokerReference,
  audit_log: schema.auditLog,
  trade_legs: schema.tradeLegs,
  symbol_aliases: schema.symbolAliases,
  benchmark_prices: schema.benchmarkPrices,
  instruments: schema.instruments,
  instrument_indices: schema.instrumentIndices,
  mtf_margins: schema.mtfMargins,
  price_history: schema.priceHistory,
  corporate_actions: schema.corporateActions,
  playbooks: schema.playbooks,
  margin_config: schema.marginConfig,
  trade_attachments: schema.tradeAttachments,
  broker_connections: schema.brokerConnections,
  trading_sessions: schema.tradingSessions,
  regulatory_rule_packs: schema.regulatoryRulePacks,
  panel_dismissals: schema.panelDismissals,
};

/** Full JSON dump of every table. */
export function dumpDatabase(includeAttachments = true): BackupEnvelope {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const name of BACKUP_TABLES) {
    let rows = db.select().from(TABLE_MAP[name]).all() as Record<string, unknown>[];
    // Licence and trial state never leave the machine in a backup: a shared
    // file was a shared key, and restoring an old one lowered the tamper
    // ratchet (v3, see SETTINGS_MACHINE_COLUMNS in backup-format.ts).
    if (name === "settings") {
      rows = rows.map((r) => {
        const clean = { ...r };
        for (const col of SETTINGS_MACHINE_COLUMNS) clean[col] = settingsMachineBlank(col);
        return clean;
      });
    }
    // Broker credentials never leave the machine either (v2.99.80) — the
    // rows travel so the user can see WHICH brokers were connected, but the
    // secrets are blanked and such rows are dropped on restore.
    if (name === "broker_connections") {
      rows = rows.map((r) => {
        const clean = { ...r };
        for (const col of BROKER_SECRET_COLUMNS) clean[col] = "";
        return clean;
      });
    }
    tables[name] = rows;
    counts[name] = rows.length;
  }
  const attachments: NonNullable<BackupEnvelope["attachments"]> = [];
  if (includeAttachments && fs.existsSync(attachmentsDir)) {
    for (const row of db.select().from(schema.tradeAttachments).all()) {
      const stored = path.basename(row.storedName);
      const file = path.join(attachmentsDir, stored);
      if (fs.existsSync(file)) attachments.push({ storedName: stored, mime: row.mime, dataBase64: fs.readFileSync(file).toString("base64") });

      /**
       * The thumbnail sidecar, which has NO ROW of its own.
       *
       * Thumbnails are `thumb-<storedName>` by naming convention (see
       * app/api/trades/attachments/route.ts). Because this loop is driven by
       * `trade_attachments` rows, they were never enveloped — and restore
       * rebuilds the attachment directory purely from envelope entries, then
       * deletes the retired original. So every thumbnail on the machine was
       * destroyed by any attachment-carrying restore, including the automatic
       * pre-migration cycle: screenshots survived, previews silently went
       * blank. The comment at the write site asserted the opposite.
       *
       * Enveloping it by name needs nothing on the restore side — staging
       * writes each entry by `path.basename(storedName)`, and `thumb-…` is
       * already a safe basename. An older backup simply carries no thumbnail
       * entries, which is exactly today's behaviour, so this is backward
       * compatible in both directions and needs no BACKUP_VERSION bump.
       */
      const thumbName = `thumb-${stored}`;
      const thumbFile = path.join(attachmentsDir, thumbName);
      if (fs.existsSync(thumbFile)) {
        attachments.push({ storedName: thumbName, mime: "image/jpeg", dataBase64: fs.readFileSync(thumbFile).toString("base64") });
      }
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

/**
 * The last few derived restore keys, by (salt, params, password).
 *
 * A restore is TWO requests from the panel — `preview`, then `restore` with
 * the same file and password — and each derived the key from scratch: at
 * N=2^17 that is ~500 ms of blocked event loop, twice, for one key
 * (tests/load/b6-encrypted-backup.load.ts). The salt is per-file and random,
 * so the cache can only ever serve the same file with the same password
 * again; a different file or a mistyped password derives as before. Entries
 * are few, expire quickly, and hold a derived key — a secret already
 * equivalent to what the request body carried in plaintext moments earlier.
 */
const DERIVED_KEY_TTL_MS = 5 * 60 * 1000;
const DERIVED_KEY_MAX = 4;
const derivedKeys = new Map<string, { key: Buffer; at: number }>();

function deriveRestoreKey(password: string, salt: Buffer, params: ReturnType<typeof paramsOf>): Buffer {
  const id = createHash("sha256")
    .update(salt)
    .update(`|${params.N}|${params.r}|${params.p}|`)
    .update(password, "utf8")
    .digest("base64");
  const now = Date.now();
  for (const [k, v] of derivedKeys) if (now - v.at > DERIVED_KEY_TTL_MS) derivedKeys.delete(k);
  const hit = derivedKeys.get(id);
  if (hit) return hit.key;
  const key = scryptSync(password, salt, 32, { ...params, maxmem: scryptMaxmem(params) });
  if (derivedKeys.size >= DERIVED_KEY_MAX) derivedKeys.delete(derivedKeys.keys().next().value!);
  derivedKeys.set(id, { key, at: now });
  return key;
}

export function decryptBackup(value: unknown, password: string): unknown {
  if (!isEncryptedBackup(value)) return value;
  try {
    const salt = Buffer.from(value.salt, "base64");
    const iv = Buffer.from(value.iv, "base64");
    // Read the cost the file was SEALED with, not the current one, so raising
    // the cost never strands a backup already sitting on someone's disk.
    const params = paramsOf(value);
    const key = deriveRestoreKey(password, salt, params);
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
  // THIS machine's licence and trial state, read before the wipe and re-applied
  // after: the backup does not carry them (v3 redacts; older files that do are
  // ignored), because an entitlement and a tamper ratchet belong to the
  // machine, not to the journal being restored.
  const machineSettings = db.select().from(schema.settings).all()[0] as Record<string, unknown> | undefined;

  let result: { ok: boolean; message: string; restored: number };
  try {
    result = db.transaction((tx) => {
      for (const name of [...BACKUP_TABLES].reverse()) {
        // A table the envelope does not KNOW (an older backup version) is left
        // exactly as it is — wiping it would destroy data the backup never
        // claimed to hold, e.g. a v2 file zeroing today's MTF margin uploads.
        // An empty array is different: the backup knew the table and it was
        // empty, so empty is the restored truth.
        if (tables[name] === undefined) continue;
        tx.delete(TABLE_MAP[name]).run();
      }
      let restored = 0;
      for (const name of BACKUP_TABLES) {
        if (tables[name] === undefined) continue;
        const rows = tables[name] as Record<string, unknown>[];
        for (const r of rows) {
          // A redacted broker connection is a name without a credential —
          // restoring it would render a connection that cannot pull and can
          // only confuse. The user re-connects on the Import screen instead.
          if (name === "broker_connections" && !r.apiKey) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tx.insert(TABLE_MAP[name]).values(r as any).run();
          restored++;
        }
      }
      if ((tables.accounts ?? []).length === 0) tx.insert(schema.accounts).values({ id: 1, name: "Primary", isDefault: true }).run();

      // Re-apply the machine's own licence/trial state over whatever the
      // envelope carried — restoring a journal must neither install someone
      // else's key nor reopen this machine's trial. This runs even when the
      // settings table was EMPTY pre-restore (machineSettings undefined):
      // there is no machine state to keep then, but the envelope's machine
      // columns must still be blanked exactly as a dump blanks them — a
      // FORGED envelope's consent/credential/stamp values must never land
      // verbatim just because the install was fresh.
      {
        const restored0 = tx.select().from(schema.settings).all()[0] as Record<string, unknown> | undefined;
        if (restored0) {
          const keep: Record<string, unknown> = {};
          for (const col of SETTINGS_MACHINE_COLUMNS) keep[col] = machineSettings?.[col] ?? settingsMachineBlank(col);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tx.update(schema.settings).set(keep as any).run();
        }
      }
      // The rows above are the DONOR's, keyed however its release keyed them;
      // this database's data-fix markers say nothing about them. Forget the
      // markers and re-run the fixes on the restored rows, inside this same
      // transaction (`sqlite` is the connection `db` wraps, so the raw
      // statements join it; the fix's own transaction() becomes a savepoint).
      rerunDataFixesAfterRestore(sqlite);
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

/**
 * Row count per table, for the /backup page.
 *
 * `COUNT(*)`, not `.all().length`: the previous form materialised every row of
 * all 29 tables through Drizzle on every render of a force-dynamic page —
 * 125,195 rows and ~420 ms for a HEAVY-tier book, to print 29 numbers
 * (tests/load/b5-backup-restore.load.ts). SQLite answers a bare COUNT(*) from
 * the table's B-tree without decoding a row.
 */
export function dbCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of BACKUP_TABLES) {
    const row = db.select({ n: sql<number>`count(*)` }).from(TABLE_MAP[name]).get();
    counts[name] = Number(row?.n ?? 0);
  }
  return counts;
}
