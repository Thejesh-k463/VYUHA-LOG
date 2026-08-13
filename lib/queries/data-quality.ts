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

  /**
   * Index the marks ONCE, upper-cased, instead of scanning them per trade.
   *
   * Both lines below used to be nested scans over the whole marks table:
   * `staleMtmCount` spread `latestBySymbol.entries()` into a fresh array for
   * every open trade, and `markedTradeIds` ran `marks.some(...)` per trade with
   * two `toUpperCase()` allocations per comparison.
   *
   * `.some()` short-circuits, so this looked acceptable whenever a trade's
   * symbol WAS marked — 25,000 trades against 50,000 marks measured 555 ms.
   * The moment symbols stopped matching, which is ordinary (an F&O book against
   * equity-only bhavcopy marks), nothing short-circuited and the same page took
   * **10.3 seconds**. /data-quality is force-dynamic and better-sqlite3 is
   * synchronous, so that was the whole app frozen on every render.
   *
   * Keying case-insensitively also fixes a smaller wrong answer: the old map
   * was keyed on the raw symbol, so "RELIANCE" and "Reliance" were separate
   * entries and a stale mark under one casing reported the position stale even
   * when the other casing had a fresh one. The newest mark for a symbol is the
   * mark for that symbol, whatever case it was written in.
   */
  const latestByUpperSymbol = new Map<string, string>();
  const markedUpperSymbols = new Set<string>();
  for (const m of marks) {
    const key = m.symbol.toUpperCase();
    const seen = latestByUpperSymbol.get(key);
    if (seen === undefined || m.asOfDate > seen) latestByUpperSymbol.set(key, m.asOfDate);
    if (m.price > 0) markedUpperSymbols.add(key);
  }

  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 4); const cutoffIso = cutoff.toISOString().slice(0, 10);
  const staleMtmCount = all.filter((t) => {
    if (!t.isOpen) return false;
    const latest = latestByUpperSymbol.get(t.symbol.toUpperCase());
    return latest !== undefined && latest < cutoffIso;
  }).length;
  const markedTradeIds = new Set(all.filter((t) => markedUpperSymbols.has(t.symbol.toUpperCase())).map((t) => t.id));
  const knownSymbols = new Set(db.select({ symbol: instruments.symbol }).from(instruments).all().map((x) => x.symbol.toUpperCase()));
  const ipoLinkedTradeIds = new Set(db.select({ tradeId: ipos.tradeId }).from(ipos).all().map((x) => x.tradeId).filter((x): x is number => x != null));
  const missingAttachmentFiles = db.select().from(tradeAttachments).all().filter((a) => !fs.existsSync(path.join(attachmentsDir, path.basename(a.storedName)))).length;
  return assessDataQuality({ trades: all, markedTradeIds, knownSymbols, ipoLinkedTradeIds, staleMtmCount, missingAttachmentFiles });
}
