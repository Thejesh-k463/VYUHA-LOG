import "server-only";
import fs from "node:fs";
import path from "node:path";
import { db, attachmentsDir } from "@/lib/db";
import { instruments, ipos, mtmPrices, tradeAttachments } from "@/lib/db/schema";
import { assessDataQuality } from "@/lib/analytics/data-quality";
import { getTrades } from "./trades";

export function getDataQualityReport(now = new Date()) {
  const all = getTrades();
  const marks = db.select().from(mtmPrices).all();
  const latestBySymbol = new Map<string, string>();
  for (const m of marks) if (!latestBySymbol.has(m.symbol) || m.asOfDate > latestBySymbol.get(m.symbol)!) latestBySymbol.set(m.symbol, m.asOfDate);
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 4); const cutoffIso = cutoff.toISOString().slice(0, 10);
  const staleMtmCount = all.filter((t) => t.isOpen && [...latestBySymbol.entries()].some(([s, d]) => s.toUpperCase() === t.symbol.toUpperCase() && d < cutoffIso)).length;
  const markedTradeIds = new Set(all.filter((t) => marks.some((m) => m.symbol.toUpperCase() === t.symbol.toUpperCase() && m.price > 0)).map((t) => t.id));
  const knownSymbols = new Set(db.select({ symbol: instruments.symbol }).from(instruments).all().map((x) => x.symbol.toUpperCase()));
  const ipoLinkedTradeIds = new Set(db.select({ tradeId: ipos.tradeId }).from(ipos).all().map((x) => x.tradeId).filter((x): x is number => x != null));
  const missingAttachmentFiles = db.select().from(tradeAttachments).all().filter((a) => !fs.existsSync(path.join(attachmentsDir, path.basename(a.storedName)))).length;
  return assessDataQuality({ trades: all, markedTradeIds, knownSymbols, ipoLinkedTradeIds, staleMtmCount, missingAttachmentFiles });
}
