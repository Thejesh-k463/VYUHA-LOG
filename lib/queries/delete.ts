import "server-only";
import { inArray, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { trades, tradeLegs, tradeAttachments, importBatches, ipos, ledgerEntries } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
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
 * Delete trades by id.
 *
 * @param ids the exact ids from the confirmation preview — never a re-derived
 *   set, so what was shown is what is removed.
 * @param reason recorded in the audit log so the history says why.
 */
export function deleteTradesByIds(ids: number[], reason: string, source = "ui"): DeleteResult {
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  if (unique.length === 0) {
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], snapshotId: null, message: "Nothing was selected to delete." };
  }

  // Account scoping is enforced HERE, not trusted from the caller: a stale tab
  // or a hand-made request must not reach into a book the user is not in.
  const accountId = getSelectedAccountId();
  const rows = db.select().from(trades).where(inArray(trades.id, unique)).all();
  const allowed = rows.filter((r) => accountId === 0 || r.accountId === accountId);
  const allowedIds = allowed.map((r) => r.id);

  if (allowedIds.length === 0) {
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], snapshotId: null, message: "Those trades are not in the account you are viewing." };
  }

  const attachRows = db.select().from(tradeAttachments).where(inArray(tradeAttachments.tradeId, allowedIds)).all();
  const legRows = db.select().from(tradeLegs).where(inArray(tradeLegs.tradeId, allowedIds)).all();
  // Ledger entries pointing at these trades. They are UNLINKED, never deleted:
  // a ledger row records money that really moved (a charge, an interest debit,
  // a realised-P&L credit), and that stays true whether or not the trade row
  // survives — the same reasoning that keeps the IPO record. The link is
  // snapshotted so a restore can re-point them.
  const ledgerRefRows = db
    .select({ ledgerId: ledgerEntries.id, tradeId: ledgerEntries.refTradeId })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.refTradeId, allowedIds))
    .all() as { ledgerId: number; tradeId: number }[];

  // The recovery, before anything is touched. See the header: no snapshot, no
  // delete.
  let snapshotId: string;
  try {
    snapshotId = writeTrashSnapshot({
      trades: allowed as unknown as Record<string, unknown>[],
      legs: legRows as unknown as Record<string, unknown>[],
      attachments: attachRows as unknown as Record<string, unknown>[],
      ledgerRefs: ledgerRefRows,
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
      for (const t of allowed) {
        recordAudit({
          entity: "trade",
          entityId: t.id,
          action: "delete",
          summary: `${t.tradingsymbol} — ${reason}`,
          before: t as unknown as Record<string, unknown>,
          source,
        });
      }

      tx.delete(tradeLegs).where(inArray(tradeLegs.tradeId, allowedIds)).run();
      tx.delete(tradeAttachments).where(inArray(tradeAttachments.tradeId, allowedIds)).run();
      // Unlink IPOs rather than deleting them — see the header.
      for (const id of allowedIds) {
        tx.update(ipos).set({ tradeId: null }).where(eq(ipos.tradeId, id)).run();
      }
      // Unlink ledger entries the same way. Leaving the id in place looked
      // harmless — there are no real foreign keys, nothing crashes — but a
      // dangling ref is a link to a trade that does not exist, and the next
      // feature to follow it renders a hole. The snapshot carries the pairs.
      tx.update(ledgerEntries).set({ refTradeId: null }).where(inArray(ledgerEntries.refTradeId, allowedIds)).run();
      tx.delete(trades).where(inArray(trades.id, allowedIds)).run();

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
  if (cascade) {
    const ids = db.select({ id: trades.id }).from(trades).where(eq(trades.importBatchId, batchId)).all().map((r) => r.id);
    if (ids.length > 0) {
      res = deleteTradesByIds(ids, `import “${batch.fileName}” deleted`, source);
      // If the trades could not be removed, leave the batch in place too —
      // deleting the record while its trades survive destroys the only link
      // back to where they came from.
      if (!res.ok) return { ...res, batchRemoved: false };
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
