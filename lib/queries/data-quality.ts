import "server-only";
import fs from "node:fs";
import path from "node:path";
import { db, attachmentsDir } from "@/lib/db";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { instruments, ipos, mtmPrices, tradeAttachments, tradeLegs } from "@/lib/db/schema";
import {
  assessDataQuality,
  saleJournalFields,
  staleFillsNote,
  staleJournalNote,
  staleOpenPairs,
  staleSaleRows,
  type IpoRecordFacts,
  type StaleOpenPair,
  type StaleSaleRow,
} from "@/lib/analytics/data-quality";
import { getSelectedAccountId } from "./accounts";
import { getTrades } from "./trades";
import { collectIdChunks } from "./delete";

/** A stale pair as the screen shows it: `blocked` is why it gets no button. */
export interface StaleOpenView extends StaleOpenPair {
  /**
   * Set when the sale row carries the user's own journal fields (R26
   * decision), or was recorded in several fills — staged, or holding
   * `trade_legs` (R2-DQ N10).
   */
  blocked: string | null;
}

/**
 * R26 (v4.3.0) — the open lots with their closing trade stored beside them, for
 * the Data Quality card. ACCOUNT-SCOPED through `getTrades()` (invariant 8):
 * the All-accounts view lists every book's pairs, each within its own book.
 */
export function getStaleOpenPairs(): StaleOpenView[] {
  return staleViewsOf(getTrades());
}

/**
 * The whole stale section of the Data Quality page from ONE read of the book:
 * the pairs (R26) and the closing-trade rows left open with no open position
 * to pair (W2-DQ P2, the `stale_sale` warning). Account-scoped through
 * `getTrades()` (invariant 8).
 */
export function getStaleOpenSection(): { pairs: StaleOpenView[]; sales: StaleSaleRow[] } {
  const all = getTrades();
  return { pairs: staleViewsOf(all), sales: staleSaleRows(all) };
}

function staleViewsOf(all: ReturnType<typeof getTrades>): StaleOpenView[] {
  const pairs = staleOpenPairs(all);
  if (pairs.length === 0) return [];
  const saleIds = [...new Set(pairs.map((p) => p.saleId))];
  const countBy = (rows: { tradeId: number }[]) => {
    const m = new Map<number, number>();
    for (const r of rows) m.set(r.tradeId, (m.get(r.tradeId) ?? 0) + 1);
    return m;
  };
  const attachments = countBy(
    collectIdChunks(saleIds, (c) => db.select({ tradeId: tradeAttachments.tradeId }).from(tradeAttachments).where(inArray(tradeAttachments.tradeId, c)).all()),
  );
  const legs = countBy(
    collectIdChunks(saleIds, (c) => db.select({ tradeId: tradeLegs.tradeId }).from(tradeLegs).where(inArray(tradeLegs.tradeId, c)).all()),
  );
  const byId = new Map(all.map((t) => [t.id, t]));
  return pairs.map((p) => {
    const sale = byId.get(p.saleId);
    const fields = sale ? saleJournalFields(sale, { attachments: attachments.get(p.saleId) ?? 0 }) : [];
    const notes: string[] = [];
    if (p.saleStaged || (legs.get(p.saleId) ?? 0) > 0) notes.push(staleFillsNote(p.side));
    if (fields.length) notes.push(staleJournalNote(fields, p.side));
    return { ...p, blocked: notes.length ? notes.join(" ") : null };
  });
}

/**
 * L6 (v4.3.0 wave 2L) — EXITED IPO records with no holding attached.
 *
 * "Exited" is `computeIpo`'s own rule: allotted, with an exit price stated. Only
 * those are read, because an unlinked exited record is the one that states a
 * sale of its own beside the holding's — the double count the pairing asks
 * about. ACCOUNT-SCOPED (invariant 8) through `getSelectedAccountId()`, matching
 * the `getTrades()` scope the same report is built from: in one book the pairs
 * are that book's, and in the All-accounts view each pair is still within one
 * account, because the match itself requires the same `account_id`.
 */
export function getUnlinkedExitedIpoRecords(): IpoRecordFacts[] {
  const accountId = getSelectedAccountId();
  const where = and(isNull(ipos.tradeId), eq(ipos.allotted, true), isNotNull(ipos.exitPrice));
  const q = db
    .select({ id: ipos.id, accountId: ipos.accountId, name: ipos.name, allottedQty: ipos.allottedQty })
    .from(ipos);
  return (accountId > 0 ? q.where(and(where, eq(ipos.accountId, accountId))) : q.where(where)).all();
}

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
  return assessDataQuality({ trades: all, markedTradeIds, knownSymbols, ipoLinkedTradeIds, staleMtmCount, missingAttachmentFiles, unlinkedIpoRecords: getUnlinkedExitedIpoRecords() });
}
