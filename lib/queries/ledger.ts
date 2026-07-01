import "server-only";
import { db } from "@/lib/db";
import { ledgerEntries } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import type { LedgerEntryInput, LedgerType } from "@/lib/analytics/ledger";

/** All ledger entries (latest first). Amounts are signed paise. */
export function getLedgerEntries(): LedgerEntryInput[] {
  return db
    .select()
    .from(ledgerEntries)
    .orderBy(desc(ledgerEntries.date), desc(ledgerEntries.id))
    .all()
    .map((r) => ({
      id: r.id,
      date: r.date,
      bucket: r.bucket,
      type: r.type as LedgerType,
      amountPaise: r.amountPaise,
      note: r.note,
      refTradeId: r.refTradeId,
    }));
}
