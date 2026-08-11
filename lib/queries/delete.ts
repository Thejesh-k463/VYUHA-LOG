import "server-only";
import fs from "node:fs";
import path from "node:path";
import { inArray, eq } from "drizzle-orm";
import { db, attachmentsDir } from "@/lib/db";
import { trades, tradeLegs, tradeAttachments, importBatches, ipos } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
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
 * Rows go in one transaction; files are removed only AFTER it commits. A
 * rollback with the bytes already gone would leave rows pointing at nothing,
 * which is exactly the failure the backup work fixed. Files that cannot be
 * removed are reported, not thrown — the database is already consistent by then
 * and an unreadable file must not undo a correct delete.
 */

export interface DeleteResult {
  ok: boolean;
  deleted: number;
  legs: number;
  attachments: number;
  /** Attachment files that could not be removed. The rows are gone regardless. */
  orphanedFiles: string[];
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
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], message: "Nothing was selected to delete." };
  }

  // Account scoping is enforced HERE, not trusted from the caller: a stale tab
  // or a hand-made request must not reach into a book the user is not in.
  const accountId = getSelectedAccountId();
  const rows = db.select().from(trades).where(inArray(trades.id, unique)).all();
  const allowed = rows.filter((r) => accountId === 0 || r.accountId === accountId);
  const allowedIds = allowed.map((r) => r.id);

  if (allowedIds.length === 0) {
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], message: "Those trades are not in the account you are viewing." };
  }

  const attachRows = db.select().from(tradeAttachments).where(inArray(tradeAttachments.tradeId, allowedIds)).all();
  const legRows = db.select().from(tradeLegs).where(inArray(tradeLegs.tradeId, allowedIds)).all();

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
      tx.delete(trades).where(inArray(trades.id, allowedIds)).run();

      return {
        ok: true,
        deleted: allowedIds.length,
        legs: legRows.length,
        attachments: attachRows.length,
        orphanedFiles: [] as string[],
        message: "",
      };
    });
  } catch (e) {
    return {
      ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [],
      message: `Nothing was deleted — ${e instanceof Error ? e.message : "unknown error"}. Your journal is unchanged.`,
    };
  }

  // Files only after the commit.
  const orphaned: string[] = [];
  for (const a of attachRows) {
    const safe = path.basename(a.storedName);
    if (!safe || safe !== a.storedName) continue; // never delete outside the directory
    try {
      fs.rmSync(path.join(attachmentsDir, safe), { force: true });
      // New uploads carry a canvas-generated strip thumbnail as a sidecar
      // (`thumb-<storedName>`, P6 2026-08-11). force:true makes the missing
      // case (every pre-P6 attachment) a no-op.
      fs.rmSync(path.join(attachmentsDir, `thumb-${safe}`), { force: true });
    } catch {
      orphaned.push(safe);
    }
  }

  result.orphanedFiles = orphaned;
  result.message =
    `Deleted ${result.deleted} trade${result.deleted === 1 ? "" : "s"}` +
    (result.legs ? `, ${result.legs} leg${result.legs === 1 ? "" : "s"}` : "") +
    (result.attachments ? `, ${result.attachments} attachment${result.attachments === 1 ? "" : "s"}` : "") +
    "." +
    (orphaned.length ? ` ${orphaned.length} attachment file${orphaned.length === 1 ? "" : "s"} could not be removed from disk.` : "");
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
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], batchRemoved: false, message: "That import no longer exists." };
  }
  if (accountId !== 0 && batch.accountId !== accountId) {
    return { ok: false, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], batchRemoved: false, message: "That import belongs to a different account." };
  }

  let res: DeleteResult = { ok: true, deleted: 0, legs: 0, attachments: 0, orphanedFiles: [], message: "" };
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
