"use server";

import { revalidatePath } from "next/cache";
import { deleteTradesByIds } from "@/lib/queries/delete";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { duplicateTradeIdsIn, findDuplicateTradeGroup } from "@/lib/import/broker-identity";

/**
 * Removing ONE account's copy of a broker record that was imported into two
 * (v4.2.1, owner ruling R4b).
 *
 * Everything destructive here goes through `deleteTradesByIds`
 * (lib/queries/delete.ts): a recovery snapshot first, one audit row per trade,
 * legs and attachments taken with it, ledger entries and IPO links unlinked
 * rather than destroyed. A direct DELETE would be a second delete path with
 * none of that, which is the defect that file exists to have fixed once.
 *
 * THE GROUP IS RE-DERIVED, NOT TRUSTED. The form that submits this was
 * rendered at some earlier moment, and by now the other copy may already be
 * gone — deleting "the duplicate" of a record that has only one copy left is
 * data loss dressed as a fix. So the group is read again and the write is
 * refused unless it is still held in two or more accounts.
 *
 * `0 is a view, not a place` (invariant 9): the All-accounts view is where
 * these duplicates are VISIBLE, and it is never where one is removed FROM.
 */

export interface RemoveDuplicateResult {
  ok: boolean;
  message: string;
  removed: number;
}

export async function removeDuplicateCopy(input: {
  broker: string;
  dedupHash: string;
  accountId: number;
}): Promise<RemoveDuplicateResult> {
  const { broker, dedupHash, accountId } = input;

  if (!broker || !dedupHash) return { ok: false, message: "That record is no longer identified. Nothing was removed.", removed: 0 };

  if (!Number.isInteger(accountId) || accountId <= 0) {
    return {
      ok: false,
      message: "Name the account the copy is removed from. All accounts is a view, not an account.",
      removed: 0,
    };
  }

  const group = findDuplicateTradeGroup(broker, dedupHash);
  if (!group) {
    return {
      ok: false,
      message: "That record is no longer held in more than one account. Nothing was removed.",
      removed: 0,
    };
  }

  const holder = group.accounts.find((a) => a.id === accountId);
  if (!holder) {
    return { ok: false, message: "That account holds no copy of this record. Nothing was removed.", removed: 0 };
  }

  // M-5 — ONLY A PLAIN COPY MAY GO, AND THE BUTTON IS NOT TRUSTED FOR IT.
  // After R5's auto-close a row can be BOTH one account's copy of this record
  // and the row that closed a lot that account was holding; deleting it takes
  // the merged lot with it. `isPlainDuplicateCopy` is the one rule, re-derived
  // here from the database because the screen that submitted this was rendered
  // before the last import ran.
  if (!holder.removable) {
    return {
      ok: false,
      message: `The copy in ${holder.name} is a merged lot — it also records an execution that closed a position in that book. Nothing was removed.`,
      removed: 0,
    };
  }

  // `deleteTradesByIds` scopes on the SELECTED account and refuses ids outside
  // it. Said here first, because its own refusal ("those trades are not in the
  // account you are viewing") does not say which view would work.
  const selected = getSelectedAccountId();
  if (selected > 0 && selected !== accountId) {
    return {
      ok: false,
      message: `This copy is in ${holder.name}. Switch to ${holder.name} or to All accounts to remove it.`,
      removed: 0,
    };
  }

  const ids = duplicateTradeIdsIn(broker, dedupHash, accountId);
  if (ids.length === 0) {
    return { ok: false, message: "That account holds no copy of this record. Nothing was removed.", removed: 0 };
  }

  const res = deleteTradesByIds(
    ids,
    `duplicate copy of a ${group.brokerLabel} record also held in another account`,
    "data-quality",
  );
  if (!res.ok) return { ok: false, message: res.message, removed: 0 };

  for (const p of ["/data-quality", "/trades", "/risk", "/equity", "/active", "/", "/reports/broker-compare"]) {
    revalidatePath(p);
  }
  return { ok: true, message: res.message, removed: res.deleted };
}
