import "server-only";
import { inArray, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { trades, tradeLegs, tradeAttachments, importBatches, ipos, ledgerEntries, brokerReference } from "@/lib/db/schema";
import { recordAudit, recordAuditMany } from "@/lib/audit";
import { writeTrashSnapshot, stashAttachmentFiles } from "@/lib/trash";
import { resolveDeleteScope, type DeletePreview } from "@/lib/domain/delete-scope";
import { getSelectedAccountId } from "./accounts";

/**
 * Executing a delete. The DECISION of what to delete lives in the pure
 * lib/domain/delete-scope.ts; this file only carries it out.
 *
 * ── What a trade actually owns ──────────────────────────────────────────────
 *
 * The old single-trade delete removed the `trades` row and nothing else, which
 * left `trade_legs` and `trade_attachments` rows pointing at an id that no
 * longer existed, and left the attachment BYTES on disk forever. Every delete
 * now goes through here so a trade takes its own belongings with it:
 *
 *   trade_legs         — the staged ladder
 *   trade_attachments  — rows AND the files they name
 *   ipos.tradeId       — unlinked, but the IPO record itself is KEPT
 *
 * The IPO is deliberately not deleted. It is a separate thing the user recorded
 * (issue price, allotment, listing) and losing it because a linked holding was
 * removed would destroy data they never asked to delete.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 *
 * A snapshot is written FIRST (lib/trash.ts), then rows go in one transaction,
 * then files move into the snapshot only AFTER it commits. A rollback with the
 * bytes already gone would leave rows pointing at nothing, which is exactly the
 * failure the backup work fixed. Files that cannot be moved are reported, not
 * thrown — the database is already consistent by then and an unreadable file
 * must not undo a correct delete.
 *
 * ── Why a failed snapshot aborts the delete ─────────────────────────────────
 *
 * The confirmation dialog tells the user these trades can be put back. If the
 * snapshot cannot be written, that sentence is a lie and the delete does not
 * happen. Refusing to delete is recoverable by the user; deleting after
 * promising recovery is not.
 */

export interface DeleteResult {
  ok: boolean;
  deleted: number;
  legs: number;
  attachments: number;
  /** Attachment files that could not be removed. The rows are gone regardless. */
  orphanedFiles: string[];
  /** The snapshot these trades can be restored from, if one was written. */
  snapshotId: string | null;
  message: string;
}

/**
 * Largest id list handed to a single `inArray(...)`.
 *
 * Drizzle expands `inArray` to one bound parameter per element, and SQLite has
 * a hard per-statement ceiling (`SQLITE_MAX_VARIABLE_NUMBER`). Past it the
 * statement does not run slowly — it throws "too many SQL variables", which is
 * what a bulk delete used to do above ~32,766 trades. That is reachable from
 * the UI: "delete everything in this account" and the by-broker scope resolve
 * client-side to a full id list, so nothing bounds it but the size of the book.
 *
 * 900 rather than the build's actual ceiling: better-sqlite3 vendors its own
 * SQLite and the limit is a compile-time choice, so the safe number is one that
 * clears the most conservative build (999) rather than one probed from this
 * machine's. The extra statements are a rounding error next to the per-trade
 * audit write this same transaction already makes.
 */
export const ID_CHUNK = 900;

/** Exported for lib/queries/account-delete.ts, which deletes whole accounts
 *  through the same parameter-ceiling-safe chunking. */
export function forEachIdChunk(ids: number[], run: (chunk: number[]) => void): void {
  for (let i = 0; i < ids.length; i += ID_CHUNK) run(ids.slice(i, i + ID_CHUNK));
}

/** The same chunking for reads, concatenating each chunk's rows. */
export function collectIdChunks<T>(ids: number[], run: (chunk: number[]) => T[]): T[] {
  if (ids.length === 0) return [];
  if (ids.length <= ID_CHUNK) return run(ids);
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(...run(ids.slice(i, i + ID_CHUNK)));
  return out;
}

/**
 * Delete trades by id.
 *
 * @param ids the exact ids from the confirmation preview — never a re-derived
 *   set, so what was shown is what is removed.
 * @param reason recorded in the audit log so the history says why.
 * @param referenceRows `broker_reference` rows that must go WITH these trades
 *   — the figures the broker stated ABOUT them (v3.9 "Trust the numbers").
 *   Only `deleteImportBatch` passes any: a batch's reference rows describe the
 *   very trades that batch created, so leaving them behind would leave
 *   `reconcile()` comparing the broker's stated totals against a book that no
 *   longer holds the rows. They ride in the same snapshot and come back with
 *   the restore, under their original ids (`import_batch_id` intact).
 */
export function deleteTradesByIds(
  ids: number[],
  reason: string,
  source = "ui",
  referenceRows: (typeof brokerReference.$inferSelect)[] = [],
): DeleteResult {
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  if (unique.length === 0) {
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], snapshotId: null, message: "Nothing was selected to delete." };
  }

  // Account scoping is enforced HERE, not trusted from the caller: a stale tab
  // or a hand-made request must not reach into a book the user is not in.
  const accountId = getSelectedAccountId();
  // Chunked like the writes below: the read side hits the same parameter
  // ceiling, and it is the FIRST statement to hit it — a whole-account delete
  // threw here before it reached the transaction.
  const rows = collectIdChunks(unique, (chunk) => db.select().from(trades).where(inArray(trades.id, chunk)).all());
  const allowed = rows.filter((r) => accountId === 0 || r.accountId === accountId);
  const allowedIds = allowed.map((r) => r.id);

  if (allowedIds.length === 0) {
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], snapshotId: null, message: "Those trades are not in the account you are viewing." };
  }

  const attachRows = collectIdChunks(allowedIds, (chunk) => db.select().from(tradeAttachments).where(inArray(tradeAttachments.tradeId, chunk)).all());
  const legRows = collectIdChunks(allowedIds, (chunk) => db.select().from(tradeLegs).where(inArray(tradeLegs.tradeId, chunk)).all());
  // Ledger entries pointing at these trades. They are UNLINKED, never deleted:
  // a ledger row records money that really moved (a charge, an interest debit,
  // a realised-P&L credit), and that stays true whether or not the trade row
  // survives — the same reasoning that keeps the IPO record. The link is
  // snapshotted so a restore can re-point them.
  const ledgerRefRows = collectIdChunks(allowedIds, (chunk) =>
    db
      .select({ ledgerId: ledgerEntries.id, tradeId: ledgerEntries.refTradeId })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.refTradeId, chunk))
      .all(),
  ) as { ledgerId: number; tradeId: number }[];

  // The recovery, before anything is touched. See the header: no snapshot, no
  // delete.
  let snapshotId: string;
  try {
    snapshotId = writeTrashSnapshot({
      trades: allowed as unknown as Record<string, unknown>[],
      legs: legRows as unknown as Record<string, unknown>[],
      attachments: attachRows as unknown as Record<string, unknown>[],
      ledgerRefs: ledgerRefRows,
      // Undefined, not [], when there are none: JSON.stringify drops an
      // undefined field, so an ordinary delete keeps writing the EXACT shape
      // it always did (tests/trash-roundtrip.test.ts pins that).
      referenceRows: referenceRows.length ? (referenceRows as unknown as Record<string, unknown>[]) : undefined,
      reason,
      accountId,
    });
  } catch (e) {
    return {
      ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], snapshotId: null,
      message: `Nothing was deleted — the recovery snapshot could not be saved (${e instanceof Error ? e.message : "unknown error"}). Your journal is unchanged.`,
    };
  }

  let result: DeleteResult;
  try {
    result = db.transaction((tx) => {
      // Audit BEFORE the row is gone — the before-snapshot is the only record
      // of what was deleted, and it is what a restore-by-hand would work from.
      // Batched: one row per trade is correct, one STATEMENT per trade was not
      // (2,000 of the 2,029 statements a 2,000-trade delete used to issue).
      recordAuditMany(
        allowed.map((t) => ({
          entity: "trade" as const,
          entityId: t.id,
          action: "delete" as const,
          summary: `${t.tradingsymbol} — ${reason}`,
          before: t as unknown as Record<string, unknown>,
          source,
        })),
      );

      forEachIdChunk(allowedIds, (chunk) => tx.delete(tradeLegs).where(inArray(tradeLegs.tradeId, chunk)).run());
      forEachIdChunk(allowedIds, (chunk) => tx.delete(tradeAttachments).where(inArray(tradeAttachments.tradeId, chunk)).run());
      // Unlink IPOs rather than deleting them — see the header. This was a loop
      // issuing one UPDATE per id, which is what the ledger unlink below already
      // does in a single statement; on a 2,000-trade delete it was 2,000 of the
      // 4,010 statements the operation took.
      forEachIdChunk(allowedIds, (chunk) => tx.update(ipos).set({ tradeId: null }).where(inArray(ipos.tradeId, chunk)).run());
      // Unlink ledger entries the same way. Leaving the id in place looked
      // harmless — there are no real foreign keys, nothing crashes — but a
      // dangling ref is a link to a trade that does not exist, and the next
      // feature to follow it renders a hole. The snapshot carries the pairs.
      forEachIdChunk(allowedIds, (chunk) => tx.update(ledgerEntries).set({ refTradeId: null }).where(inArray(ledgerEntries.refTradeId, chunk)).run());
      forEachIdChunk(allowedIds, (chunk) => tx.delete(trades).where(inArray(trades.id, chunk)).run());
      // The broker-stated figures about these trades, snapshotted above.
      forEachIdChunk(referenceRows.map((r) => r.id), (chunk) =>
        tx.delete(brokerReference).where(inArray(brokerReference.id, chunk)).run(),
      );

      return {
        ok: true,
        deleted: allowedIds.length,
        legs: legRows.length,
        attachments: attachRows.length,
        orphanedFiles: [] as string[],
        snapshotId,
        message: "",
      };
    });
  } catch (e) {
    return {
      ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], snapshotId: null,
      message: `Nothing was deleted — ${e instanceof Error ? e.message : "unknown error"}. Your journal is unchanged.`,
    };
  }

  // Files only after the commit. They MOVE into the snapshot rather than being
  // unlinked — the rows are recoverable, so the screenshots must be too, or the
  // restored trade comes back with its charts missing.
  const { failed } = stashAttachmentFiles(snapshotId, attachRows.map((a) => a.storedName));

  result.orphanedFiles = failed;
  result.message =
    `Deleted ${result.deleted} trade${result.deleted === 1 ? "" : "s"}` +
    (result.legs ? `, ${result.legs} leg${result.legs === 1 ? "" : "s"}` : "") +
    (result.attachments ? `, ${result.attachments} attachment${result.attachments === 1 ? "" : "s"}` : "") +
    ". Recoverable from Backup & Restore → Deleted items." +
    (failed.length ? ` ${failed.length} attachment file${failed.length === 1 ? "" : "s"} could not be moved into the snapshot.` : "");
  return result;
}

export interface BatchDeleteResult extends DeleteResult {
  batchRemoved: boolean;
}

/**
 * Delete an import batch, optionally with the trades it created.
 *
 * `cascade: false` removes only the batch record — the trades stay but lose
 * their provenance, which is why the UI asks rather than assuming. `true`
 * removes both.
 */
export function deleteImportBatch(batchId: number, cascade: boolean, source = "ui"): BatchDeleteResult {
  const accountId = getSelectedAccountId();
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch) {
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], snapshotId: null, batchRemoved: false, message: "That import no longer exists." };
  }
  if (accountId !== 0 && batch.accountId !== accountId) {
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], snapshotId: null, batchRemoved: false, message: "That import belongs to a different account." };
  }

  let res: DeleteResult = { ok: true, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], snapshotId: null, message: "" };
  // The figures this batch stored about its own trades (v3.9
  // `broker_reference`). They are keyed on `import_batch_id`, which is also
  // what `holdsBookTrades` (lib/import/commit.ts) reads — so they follow the
  // batch's TRADES, not the batch record:
  //
  //   cascade  — the trades go, so the figures stated about them go too, into
  //              the same snapshot, and come back with the restore.
  //   no cascade — the trades STAY, so the figures stay. Deleting them here
  //              would leave the broker's own statement gone while its rows
  //              remain, and would silently reclassify those surviving rows as
  //              BOOK trades in `holdsBookTrades` — the double-count guard the
  //              column exists for. The batch RECORD going is exactly what the
  //              caller asked for; the column keeps naming the same rows.
  const refRows = cascade
    ? db.select().from(brokerReference).where(eq(brokerReference.importBatchId, batchId)).all()
    : [];
  if (cascade) {
    const ids = db.select({ id: trades.id }).from(trades).where(eq(trades.importBatchId, batchId)).all().map((r) => r.id);
    if (ids.length > 0) {
      res = deleteTradesByIds(ids, `import “${batch.fileName}” deleted`, source, refRows);
      // If the trades could not be removed, leave the batch in place too —
      // deleting the record while its trades survive destroys the only link
      // back to where they came from.
      if (!res.ok) return { ...res, batchRemoved: false };
    } else if (refRows.length > 0) {
      // A reference-only batch (a realised-P&L statement that produced figures
      // and no book trades) still has figures to take with it — and they are
      // the only copy, so they get their own snapshot rather than a bare
      // delete. `restoreTrashSnapshot` reads a figures-only envelope.
      const snapshotId = writeTrashSnapshot({
        trades: [], legs: [], attachments: [],
        referenceRows: refRows as unknown as Record<string, unknown>[],
        reason: `import “${batch.fileName}” deleted`,
        accountId: batch.accountId,
      });
      db.delete(brokerReference).where(eq(brokerReference.importBatchId, batchId)).run();
      res = { ...res, snapshotId };
    }
  }

  db.delete(importBatches).where(eq(importBatches.id, batchId)).run();
  recordAudit({
    entity: "settings",
    entityId: batchId,
    action: "delete",
    summary: `import “${batch.fileName}” removed${cascade ? ` with ${res.deleted} trade(s)` : " (trades kept)"}`,
    before: batch as unknown as Record<string, unknown>,
    source,
  });

  return {
    ...res,
    ok: true,
    batchRemoved: true,
    message: cascade
      ? `${res.message || "No trades were linked to that import."} The import record was removed.`
      : "The import record was removed. Its trades were kept.",
  };
}

/** Trades linked to an import batch — for the confirmation prompt. */
export function tradesInBatch(batchId: number): number {
  return db.select({ id: trades.id }).from(trades).where(eq(trades.importBatchId, batchId)).all().length;
}

/**
 * The full blast radius of deleting one import — open/closed split, net P&L,
 * symbols, date span and warnings, not just a count.
 *
 * The Recent-imports dialog used to show a bare number from `tradesInBatch`
 * while the delete re-derived its own set, which is the exact mismatch the
 * `resolveDeleteScope` header warns about. Both sides now use the same
 * predicate — `importBatchId === batchId` — so what is shown is what goes.
 *
 * The one honest caveat: this is resolved when the page renders, and the delete
 * re-runs the predicate. The set can only SHRINK in between (a re-import of the
 * same file creates a new batch id, so nothing joins this one), so the count
 * can be stale-high but never stale-low. It cannot delete more than it showed.
 */
export function previewImportBatchDelete(batchId: number): DeletePreview {
  const accountId = getSelectedAccountId();
  const rows = db
    .select()
    .from(trades)
    .where(eq(trades.importBatchId, batchId))
    .all()
    .filter((r) => accountId === 0 || r.accountId === accountId);

  return resolveDeleteScope(
    rows.map((t) => ({
      id: t.id, accountId: t.accountId, broker: t.broker, segment: t.segment,
      symbol: t.symbol, tradingsymbol: t.tradingsymbol, buyDate: t.buyDate,
      sellDate: t.sellDate, isOpen: t.isOpen, netPnl: t.netPnl,
      importBatchId: t.importBatchId, createdAt: t.createdAt, staged: t.staged,
    })),
    { kind: "importBatch", batchId },
  );
}
