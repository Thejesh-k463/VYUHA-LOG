import "server-only";
import { db } from "@/lib/db";
import { ledgerEntries } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import type { LedgerEntryInput, LedgerType } from "@/lib/analytics/ledger";
import { getSelectedAccountId } from "./accounts";

/** All ledger entries (latest first). Amounts are signed paise. */
export function getLedgerEntries(): (LedgerEntryInput & { symbol: string | null })[] {
  const accountId = getSelectedAccountId();
  const q = db.select().from(ledgerEntries);
  return (accountId > 0 ? q.where(eq(ledgerEntries.accountId, accountId)) : q)
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
      symbol: r.symbol,
    }));
}
