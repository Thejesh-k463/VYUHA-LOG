import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { trades, importBatches } from "@/lib/db/schema";
import { desc, sql } from "drizzle-orm";
import type { Trade } from "@/lib/db/schema";

export const getTrades = cache((): Trade[] => {
  return db
    .select()
    .from(trades)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt))
    .all();
});

export function getSetupTags(): string[] {
  const rows = db
    .selectDistinct({ tag: trades.setupTag })
    .from(trades)
    .where(sql`${trades.setupTag} is not null and ${trades.setupTag} != ''`)
    .all();
  return rows.map((r) => r.tag!).filter(Boolean);
}

export function getImportBatches() {
  return db.select().from(importBatches).orderBy(desc(importBatches.importedAt)).all();
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
