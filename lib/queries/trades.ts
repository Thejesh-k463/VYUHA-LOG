import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { trades, importBatches } from "@/lib/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import type { Trade } from "@/lib/db/schema";
import { getSelectedAccountId } from "./accounts";

export const getTrades = cache((): Trade[] => {
  const accountId = getSelectedAccountId();
  const q = db.select().from(trades);
  return (accountId > 0 ? q.where(eq(trades.accountId, accountId)) : q)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt)).all();
});

export function getSetupTags(): string[] {
  const accountId = getSelectedAccountId();
  const rows = db
    .selectDistinct({ tag: trades.setupTag })
    .from(trades)
    .where(accountId > 0 ? sql`${trades.setupTag} is not null and ${trades.setupTag} != '' and ${trades.accountId} = ${accountId}` : sql`${trades.setupTag} is not null and ${trades.setupTag} != ''`)
    .all();
  return rows.map((r) => r.tag!).filter(Boolean);
}

export function getImportBatches() {
  const accountId = getSelectedAccountId();
  const q = db.select().from(importBatches);
  return (accountId > 0 ? q.where(eq(importBatches.accountId, accountId)) : q).orderBy(desc(importBatches.importedAt)).all();
}

export function getTradeStats() {
  const all = getTrades();
  const net = all.reduce((s, t) => s + t.netPnl, 0);
  const gross = all.reduce((s, t) => s + t.grossPnl, 0);
  const charges = all.reduce((s, t) => s + t.chargesTotal, 0);
  return {
    count: all.length,
    open: all.filter((t) => t.isOpen).length,
    net: Math.round(net * 100) / 100,
    gross: Math.round(gross * 100) / 100,
    charges: Math.round(charges * 100) / 100,
  };
}
