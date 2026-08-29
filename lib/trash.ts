import "server-only";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, trashDir, attachmentsDir } from "@/lib/db";
import {
  trades,
  tradeLegs,
  tradeAttachments,
  ledgerEntries,
  accounts,
  ipos,
  importBatches,
  tradingSessions,
  capitalSnapshots,
} from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import {
  TRASH_VERSION,
  trashSnapshotId,
  isTrashSnapshotId,
  validateTrashEnvelope,
  summariseTrash,
  type TrashEnvelope,
  type TrashSummary,
} from "./trash-format";

/**
 * Deleted-trade snapshots — the recovery path for a delete.
 *
 * The shape mirrors `lib/queries/delete.ts` deliberately, because they are two
 * halves of the same promise:
 *
 *   delete  — snapshot BEFORE the transaction, move the bytes AFTER it commits
 *   restore — stage the bytes BEFORE the transaction, swap them in AFTER
 *
 * Both orderings exist so that a failure at any point leaves the database and
 * the files agreeing with each other. A rollback with the bytes already gone is
 * the exact failure the backup work was written to fix.
 *
 * ── Nothing is auto-purged ──────────────────────────────────────────────────
 *
 * There is no retention window and no sweeper. A snapshot is the only copy of
 * something the user asked to delete, and a background job quietly destroying
 * the last copy of a year's journal — on a schedule the user never chose — is
 * a worse failure than a folder that grows. The list reports its size and
 * purging is a deliberate act.
 */

const SNAPSHOT_FILE = "snapshot.json";
const FILES_SUBDIR = "files";

function snapshotDir(id: string): string {
  return path.join(trashDir, id);
}

/** The bytes for one attachment inside a snapshot. Basename-only by
 *  construction — `storedName` reaches here from a database column, and a
 *  separator in it must never escape the snapshot folder. */
function stashedFile(id: string, storedName: string): string | null {
  const safe = path.basename(storedName);
  if (!safe || safe !== storedName) return null;
  return path.join(snapshotDir(id), FILES_SUBDIR, safe);
}

export interface SnapshotInput {
  trades: Record<string, unknown>[];
  legs: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  /** Ledger entries about to be UNLINKED (not deleted) — see trash-format.ts. */
  ledgerRefs?: { ledgerId: number; tradeId: number }[];
  /** The accounts row being deleted WITH these trades (account deletion only). */
  account?: Record<string, unknown> & { id: number; name: string };
  /** Destroyed account-scoped rows — see trash-format.ts. NEVER broker_connections. */
  accountRows?: TrashEnvelope["accountRows"];
  /** merge only: how the source's pnlRolledIn marker moved — see trash-format.ts. */
  merge?: TrashEnvelope["merge"];
  reason: string;
  accountId: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Write the snapshot for a delete that is about to happen.
 *
 * Throws rather than returning a failure: the caller must ABORT the delete if
 * this does not succeed. Deleting after failing to write the recovery, having
 * just told the user the delete is recoverable, is the one outcome this whole
 * module exists to prevent.
 */
export function writeTrashSnapshot(input: SnapshotInput): string {
  const deletedAt = new Date().toISOString();
  const id = trashSnapshotId(deletedAt, randomBytes(4).toString("hex"));
  const dir = snapshotDir(id);

  const envelope: TrashEnvelope = {
    vyuhaTrash: true,
    v: TRASH_VERSION,
    id,
    deletedAt,
    reason: input.reason,
    accountId: input.accountId,
    counts: { trades: input.trades.length, legs: input.legs.length, attachments: input.attachments.length },
    trades: input.trades,
    legs: input.legs,
    attachments: input.attachments,
    files: [],
    ledgerRefs: input.ledgerRefs ?? [],
    // JSON.stringify drops an undefined field, so ordinary trade deletes keep
    // writing the exact shape they always did.
    account: input.account,
    accountRows: input.accountRows,
    merge: input.merge,
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SNAPSHOT_FILE), JSON.stringify(envelope));
  return id;
}

/**
 * Move attachment bytes into a snapshot instead of deleting them.
 *
 * Called only after the delete transaction has committed. A file that cannot be
 * moved is REPORTED, never thrown: the database is already consistent by then,
 * and an unreadable screenshot must not undo a correct delete. Such a file is
 * left where it is — orphaned but harmless, and reclaimable by hand.
 */
export function stashAttachmentFiles(
  id: string,
  storedNames: string[],
): { stashed: string[]; failed: string[] } {
  const stashed: string[] = [];
  const failed: string[] = [];
  if (storedNames.length === 0) return { stashed, failed };

  const filesDir = path.join(snapshotDir(id), FILES_SUBDIR);
  try {
    fs.mkdirSync(filesDir, { recursive: true });
  } catch {
    return { stashed, failed: storedNames };
  }

  for (const storedName of storedNames) {
    const target = stashedFile(id, storedName);
    if (!target) continue;
    const source = path.join(attachmentsDir, path.basename(storedName));
    try {
      if (fs.existsSync(source)) {
        fs.renameSync(source, target);
        stashed.push(path.basename(storedName));
      }
      // The strip thumbnail is a regenerable sidecar, not user data — it is
      // removed rather than stashed, and its absence (every pre-P6 attachment)
      // is a no-op.
      fs.rmSync(path.join(attachmentsDir, `thumb-${path.basename(storedName)}`), { force: true });
    } catch {
      failed.push(path.basename(storedName));
    }
  }

  // Record which bytes actually made it, so restore does not promise files it
  // does not hold.
  try {
    const env = readEnvelope(id);
    if (env) {
      env.files = stashed;
      fs.writeFileSync(path.join(snapshotDir(id), SNAPSHOT_FILE), JSON.stringify(env));
    }
  } catch {
    /* the rows are still restorable without the file list */
  }

  return { stashed, failed };
}

function readEnvelope(id: string): TrashEnvelope | null {
  if (!isTrashSnapshotId(id)) return null;
  const file = path.join(snapshotDir(id), SNAPSHOT_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return validateTrashEnvelope(parsed).ok ? (parsed as TrashEnvelope) : null;
  } catch {
    return null;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* vanished under us — not worth failing a size read over */
        }
      }
    }
  };
  walk(dir);
  return total;
}

/** Every snapshot on disk, newest first. Unreadable folders are skipped. */
export function listTrashSnapshots(): TrashSummary[] {
  if (!fs.existsSync(trashDir)) return [];
  const out: TrashSummary[] = [];
  for (const entry of fs.readdirSync(trashDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const env = readEnvelope(entry.name);
    if (!env) continue;
    out.push(summariseTrash(env, dirSize(snapshotDir(entry.name))));
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export interface TrashRestoreResult {
  ok: boolean;
  restored: number;
  legs: number;
  attachments: number;
  /** Trades that could not come back, and why — never silently dropped. */
  skipped: { id: number; symbol: string; reason: string }[];
  message: string;
}

/**
 * Put a snapshot's trades back.
 *
 * ── Why rows can refuse to come back ────────────────────────────────────────
 *
 * Trades are restored under their ORIGINAL ids, so their legs, attachments and
 * audit history line up again. Two things can stand in the way, and both are
 * ordinary rather than exceptional:
 *
 *   1. the id is taken — something else was written after the delete;
 *   2. `trades_account_broker_dedup_uq` rejects it — the user re-imported the
 *      same file, so the trade is already back by another route.
 *
 * Either way the row is SKIPPED and named in the result. Restoring it under a
 * fresh id would silently duplicate a trade and quietly corrupt every figure
 * derived from the book, which is worse than a restore that reports what it
 * could not do.
 *
 * An ACCOUNT-deletion snapshot has one stronger rule: if the account's id or
 * name now belongs to a DIFFERENT account, the whole restore refuses up front
 * — putting the trades anywhere else would merge two books. Only an account
 * that matches the envelope (same name and broker) counts as "already back".
 *
 * The snapshot is left on disk afterwards even on full success. Deleting the
 * only copy of the thing the user has just recovered, at the exact moment they
 * are checking whether the recovery worked, is not a tidy-up.
 */
export function restoreTrashSnapshot(id: string, source = "ui"): TrashRestoreResult {
  const fail = (message: string): TrashRestoreResult => ({ ok: false, restored: 0, legs: 0, attachments: 0, skipped: [], message });

  if (!isTrashSnapshotId(id)) return fail("That is not a snapshot id.");
  const env = readEnvelope(id);
  if (!env) return fail("That snapshot is missing or unreadable. Nothing was changed.");

  const rows = env.trades as (Record<string, unknown> & { id: number; symbol?: string })[];
  // A v2 account-deletion snapshot can legitimately hold zero trades (the
  // account was empty): the account row itself is still worth restoring.
  if (rows.length === 0 && !env.account) return fail("That snapshot holds no trades.");

  // ── Account conflicts refuse the WHOLE restore (nothing partial) ──────────
  //
  // The trades in an account-deletion snapshot belong to that account's book.
  // If its id or name now belongs to a DIFFERENT account, restoring the trades
  // anyway would silently merge two books — the exact corruption invariant 8
  // exists to prevent — so the restore refuses up front and changes nothing.
  // An account that matches the envelope (same name and broker) is the book
  // itself already back (an earlier restore, or the user recreated it): that
  // is "already restored", and the rows proceed under their original ids.
  let recreateAccount = false;
  let accountAlreadyPresent = false;
  if (env.account) {
    const envBroker = ((env.account as { broker?: string | null }).broker ?? null);
    const holder = db.select().from(accounts).where(eq(accounts.id, env.account.id)).get();
    if (holder) {
      if (holder.name === env.account.name && (holder.broker ?? null) === envBroker) {
        accountAlreadyPresent = true;
      } else {
        return fail(
          `account id ${env.account.id} now belongs to “${holder.name}” — restore skipped to avoid merging two books. Nothing was changed.`,
        );
      }
    } else {
      const nameHolder = db.select().from(accounts).where(eq(accounts.name, env.account.name)).get();
      if (nameHolder) {
        return fail(
          `the account name “${env.account.name}” now belongs to account id ${nameHolder.id} — restore skipped to avoid merging two books. Nothing was changed.`,
        );
      }
      recreateAccount = true;
    }
  }

  const wantedIds = rows.map((r) => r.id);
  const taken = new Set(
    db.select({ id: trades.id }).from(trades).where(inArray(trades.id, wantedIds)).all().map((r) => r.id),
  );

  const skipped: TrashRestoreResult["skipped"] = [];
  let restored = 0, legs = 0, attachments = 0;
  let extraRestored = 0, extraSkipped = 0;

  let accountBack = false;
  let mergeMarkerReturned = false;
  try {
    const res = db.transaction((tx) => {
      // Recreate the deleted account FIRST (v2 account-deletion snapshots), so
      // the rows restored below land in a book that exists again. Conflicts
      // were refused above, so a failure here is genuine and aborts the whole
      // transaction — no silent catch-and-continue.
      if (env.account && recreateAccount) {
        const carried = env.merge?.carried ?? 0;
        const rawMarker = env.account.pnlRolledIn;
        const originalMarker = typeof rawMarker === "number" ? rawMarker : 0;
        // A merged-away source comes back with only the residue of its marker:
        // the `carried` share now marks the moved trades in the TARGET, and is
        // subtracted back from the target below — see trash-format.ts.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.insert(accounts).values({ ...env.account, pnlRolledIn: r2(originalMarker - carried) } as any).run();
        accountBack = true;
        recordAudit({
          entity: "account",
          entityId: env.account.id,
          action: "create",
          summary: `${env.account.name} — recreated from deleted items (${id})`,
          after: env.account,
          source,
        });
        if (env.merge && carried !== 0) {
          const target = db.select().from(accounts).where(eq(accounts.id, env.merge.targetId)).get();
          if (target) {
            tx.update(accounts)
              .set({ pnlRolledIn: Math.max(0, r2(target.pnlRolledIn - carried)), updatedAt: new Date().toISOString() })
              .where(eq(accounts.id, env.merge.targetId))
              .run();
            mergeMarkerReturned = true;
          }
        }
      }

      const landed = new Set<number>();
      for (const row of rows) {
        if (taken.has(row.id)) {
          skipped.push({ id: row.id, symbol: String(row.symbol ?? "—"), reason: "a trade with that id is already in the journal" });
          continue;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tx.insert(trades).values(row as any).run();
          landed.add(row.id);
          restored++;
        } catch (e) {
          // Almost always the dedup unique index: the same file was imported
          // again after the delete, so this trade is already back.
          const msg = e instanceof Error && /unique/i.test(e.message)
            ? "an identical trade is already in the journal (re-imported since the delete)"
            : e instanceof Error ? e.message : "unknown error";
          skipped.push({ id: row.id, symbol: String(row.symbol ?? "—"), reason: msg });
        }
      }

      // Children follow only the parents that actually came back — a leg
      // pointing at a trade that was skipped is precisely the orphan this
      // whole delete/restore rework exists to stop creating.
      for (const leg of env.legs as (Record<string, unknown> & { tradeId: number })[]) {
        if (!landed.has(leg.tradeId)) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.insert(tradeLegs).values(leg as any).run();
        legs++;
      }
      for (const att of env.attachments as (Record<string, unknown> & { tradeId: number })[]) {
        if (!landed.has(att.tradeId)) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.insert(tradeAttachments).values(att as any).run();
        attachments++;
      }

      // Re-point the ledger entries the delete unlinked — but only where the
      // trade actually came back, only where the entry still exists, and only
      // where its ref is still null. An entry someone re-linked by hand since
      // the delete is their decision, not this restore's to overwrite.
      for (const ref of env.ledgerRefs ?? []) {
        if (!landed.has(ref.tradeId)) continue;
        tx.update(ledgerEntries)
          .set({ refTradeId: ref.tradeId })
          .where(and(eq(ledgerEntries.id, ref.ledgerId), isNull(ledgerEntries.refTradeId)))
          .run();
      }

      // The account-scoped rows the delete destroyed (v2): imports, sessions,
      // capital checkpoints, IPOs and the account's own ledger entries come
      // back with the book. A row that cannot land (id or unique key taken —
      // e.g. a session date the account has planned again since) is COUNTED,
      // never silently dropped and never duplicated under a fresh id.
      if (env.account && env.accountRows) {
        const groups: [unknown, Record<string, unknown>[] | undefined][] = [
          [importBatches, env.accountRows.importBatches],
          [tradingSessions, env.accountRows.tradingSessions],
          [capitalSnapshots, env.accountRows.capitalSnapshots],
          [ipos, env.accountRows.ipos],
          [ledgerEntries, env.accountRows.ledgerEntries],
        ];
        for (const [table, tableRows] of groups) {
          for (const row of tableRows ?? []) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tx.insert(table as any).values(row as any).run();
              extraRestored++;
            } catch {
              extraSkipped++;
            }
          }
        }
      }

      for (const row of rows) {
        if (!landed.has(row.id)) continue;
        recordAudit({
          entity: "trade",
          entityId: row.id,
          action: "update",
          summary: `${String(row.tradingsymbol ?? row.symbol ?? "trade")} — restored from deleted items (${id})`,
          after: row,
          source,
        });
      }

      return { landed };
    });

    // Files only after the commit, and copied rather than moved: if the copy
    // fails the rows are still correct, and the snapshot still holds the only
    // copy of the bytes.
    for (const att of env.attachments as (Record<string, unknown> & { tradeId: number; storedName: string })[]) {
      if (!res.landed.has(att.tradeId)) continue;
      const from = stashedFile(id, att.storedName);
      if (!from || !fs.existsSync(from)) continue;
      try {
        fs.mkdirSync(attachmentsDir, { recursive: true });
        fs.copyFileSync(from, path.join(attachmentsDir, path.basename(att.storedName)));
      } catch {
        /* reported below via the count, not thrown */
      }
    }
  } catch (e) {
    return fail(`Nothing was restored — ${e instanceof Error ? e.message : "unknown error"}. Your journal is unchanged.`);
  }

  const parts = [`Restored ${restored} trade${restored === 1 ? "" : "s"}`];
  if (legs) parts.push(`${legs} leg${legs === 1 ? "" : "s"}`);
  if (attachments) parts.push(`${attachments} attachment${attachments === 1 ? "" : "s"}`);
  let message = `${parts.join(", ")}.`;
  if (env.account) {
    if (accountBack) {
      message += ` The account “${env.account.name}” was recreated.`;
      if (env.merge && env.merge.carried !== 0) {
        message += mergeMarkerReturned
          ? ` ₹${env.merge.carried.toLocaleString("en-IN")} of rolled-in P&L moved back from “${env.merge.targetName}”.`
          : ` The merge target “${env.merge.targetName}” no longer exists, so its rolled-in marker was left untouched.`;
      }
    } else if (accountAlreadyPresent) {
      message += ` The account “${env.account.name}” was already present.`;
    }
  }
  if (extraRestored > 0) {
    message += ` ${extraRestored} related row${extraRestored === 1 ? "" : "s"} (imports, sessions, capital history, IPOs, ledger) came back with it.`;
  }
  if (extraSkipped > 0) {
    message += ` ${extraSkipped} related row${extraSkipped === 1 ? " was" : "s were"} already present and skipped.`;
  }
  if (skipped.length > 0) {
    message += ` ${skipped.length} could not be restored — ${skipped[0].symbol}: ${skipped[0].reason}${skipped.length > 1 ? `, and ${skipped.length - 1} more` : ""}.`;
  }
  message += " The snapshot was kept.";

  return {
    ok: restored > 0 || skipped.length > 0 || accountBack || accountAlreadyPresent || extraRestored > 0,
    restored,
    legs,
    attachments,
    skipped,
    message,
  };
}

/** Remove a snapshot and its stashed bytes for good. */
export function purgeTrashSnapshot(id: string): { ok: boolean; message: string } {
  if (!isTrashSnapshotId(id)) return { ok: false, message: "That is not a snapshot id." };
  const dir = snapshotDir(id);
  if (!fs.existsSync(dir)) return { ok: false, message: "That snapshot is already gone." };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, message: "The snapshot was permanently removed. Those trades can no longer be recovered from inside the app." };
  } catch (e) {
    return { ok: false, message: `Could not remove the snapshot — ${e instanceof Error ? e.message : "unknown error"}.` };
  }
}
