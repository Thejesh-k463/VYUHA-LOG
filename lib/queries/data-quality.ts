import "server-only";
import fs from "node:fs";
import path from "node:path";
import { db, attachmentsDir } from "@/lib/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { accounts as accountsTable, bfLossLots, instruments, ipos, mtmPrices, tradeAttachments, tradeLegs, trades } from "@/lib/db/schema";
import { trashedTradeIds } from "@/lib/trash";
import {
  assessDataQuality,
  planPricingNotice,
  scoreIssues,
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
import { brokerPlanOptions } from "./broker-plan";
import { getTrades } from "./trades";
import { collectIdChunks } from "./delete";
import { taxPersonKey } from "@/lib/domain/tax-person";
import { BROKER_LABELS } from "@/lib/domain/constants";
import { todayIstIso } from "@/lib/domain/trading-day";
import { ladderMismatch } from "@/lib/analytics/realised-rows";
import { getStagedViews, toDomainLegs } from "./staged";

/**
 * THE ONE PREDICATE FOR "this account is priced on a plan it never stated"
 * (wave U; exported in v4.5.0 fix list A3).
 *
 * An ACTIVE account whose broker sells MORE THAN ONE pricing plan and which
 * states none. The set of multi-plan brokers is DERIVED from `charge_config`
 * (`brokerPlanOptions`), so no broker is ever named here — the day a second
 * broker gets a tier, its accounts join the set with no code change.
 *
 * Read by Data Quality's `broker_plan:<id>` issue AND by the import preview's
 * pricing line, which is the point: two lists would drift, and the user would
 * be told on one screen that a plan is missing while another priced happily.
 */
export interface AccountWithoutPlan {
  id: number;
  name: string;
  /** The stored broker key, normalised — what `brokerPlanOptions` is keyed by. */
  broker: string;
  /** The broker as the account states it, for prose (Data Quality's wording). */
  brokerLabel: string;
}

export function getAccountsWithoutPlan(): AccountWithoutPlan[] {
  const planOptions = brokerPlanOptions();
  return db
    .select({ id: accountsTable.id, name: accountsTable.name, broker: accountsTable.broker, brokerPlan: accountsTable.brokerPlan, archived: accountsTable.archived })
    .from(accountsTable)
    .all()
    .filter((a) => !a.archived && !a.brokerPlan && (planOptions[(a.broker ?? "").trim().toLowerCase()]?.length ?? 0) > 1)
    .map((a) => ({ id: a.id, name: a.name, broker: (a.broker ?? "").trim().toLowerCase(), brokerLabel: (a.broker ?? "").trim() }));
}

/**
 * A3 (v4.5.0 fix list) — THE ONE LINE an estimate-showing screen states when
 * the account it is pricing for has no plan: the import preview's charges
 * column and the calculator both show a figure that is right for the free tier
 * and wrong for a paid one, and only the user knows which they are on.
 *
 * Account-scoped the ordinary way (invariant 8): the selected account in a
 * single-account view, every account in the All-accounts view — the same rows
 * Data Quality would list, filtered to what is on screen. Null when there is
 * nothing to say, so a caller renders nothing rather than an empty box.
 */
export function getPlanPricingNotice(): string | null {
  const selected = getSelectedAccountId();
  const rows = getAccountsWithoutPlan().filter((a) => selected <= 0 || a.id === selected);
  if (rows.length === 0) return null;
  const options = brokerPlanOptions();
  return planPricingNotice(
    rows.map((a) => {
      const free = options[a.broker]?.find((o) => o.plan === "default") ?? null;
      return {
        brokerLabel: BROKER_LABELS[a.broker as keyof typeof BROKER_LABELS] ?? a.brokerLabel,
        // `brokerPlanOptions` fills a missing label with its own placeholder;
        // only a label the RATE TABLE actually states is worth printing.
        freePlanLabel: free && free.label !== "Standard (free)" ? free.label : null,
      };
    }),
  );
}

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
 * L6 (v4.3.0 wave 2L) — the unlinked IPO records a holding could be, as read
 * for the report. D1 (wave 2M): THE SAME SET the Trash restore reads.
 *
 * Every unlinked record of the account that states an ALLOTMENT, exited or not.
 * It was `allotted AND exit_price IS NOT NULL` while `lib/trash.ts` read EVERY
 * unlinked record, and the disagreement was the seam defect: a never-allotted
 * application row (the same user's own record of applying, under the TICKER)
 * was a candidate for the restore and invisible to the report, so the restore
 * called the holding ambiguous and wrote nothing while the report said the one
 * record it could see matched. The set is now one rule on both sides, stated
 * here and in `ipoRecordMatchesHolding`: an application that was never allotted
 * is no allotment's record, and an allotted record with no exit yet is still a
 * candidate a restore may link (tier A, on the scrip's name).
 *
 * Whether a record STATES AN EXIT — `computeIpo`'s rule, allotted with an exit
 * price — travels as `exitPrice` for the pure layer to read: that is what makes
 * a sale countable twice, so `ipoAskPairs` raises the question only beside one.
 *
 * ACCOUNT-SCOPED (invariant 8) through `getSelectedAccountId()`, matching the
 * `getTrades()` scope the same report is built from: in one book the pairs are
 * that book's, and in the All-accounts view each pair is still within one
 * account, because the match itself requires the same `account_id`.
 *
 * D11 (v4.3.0 wave 2P, identity#1) — a reference that names NO row in the
 * journal is unlinked to the question. A purged book's record naming a holding
 * in ANOTHER book is replayed verbatim on restore (D4 of 2O — a Trash-resident
 * holding restored later makes the link live again by identity, so the
 * reference must be KEPT), but that holding may have been deleted since; keyed
 * on `isNull(trade_id)` alone such a record was invisible here while its
 * re-imported holding counted the same sale again. So `trades` is LEFT JOINed
 * and a row is listed when either the reference is null or nothing holds it.
 * A ghost carries `holdingRef` (the id it names) and `holdingInTrash`, resolved
 * through ONE `trashedTradeIds` read and only when at least one ghost exists.
 * Reader-side only: no writer of `ipos.trade_id` changes, and `lib/trash.ts`'s
 * own restore read stays `isNull` — a ghost is never a restore's to re-point.
 */
export function getUnlinkedExitedIpoRecords(): IpoRecordFacts[] {
  const accountId = getSelectedAccountId();
  const where = and(or(isNull(ipos.tradeId), isNull(trades.id)), eq(ipos.allotted, true));
  const q = db
    .select({
      id: ipos.id,
      accountId: ipos.accountId,
      name: ipos.name,
      allottedQty: ipos.allottedQty,
      // G-G2-1 (wave 2M) — tier B's facts. A record entered on /ipos carries the
      // ISSUE's name, so the name tier cannot see it; what the two rows DO state
      // identically is the allotment: allotted, exited, the same quantity and the
      // same two days. Read here rather than derived, so the report and the Trash
      // restore compare the same stored facts.
      allotted: ipos.allotted,
      exitPrice: ipos.exitPrice,
      exitDate: ipos.exitDate,
      allotmentDate: ipos.allotmentDate,
      // D11 — the id the record names when nothing holds it (null when unlinked).
      holdingRef: ipos.tradeId,
    })
    .from(ipos)
    .leftJoin(trades, eq(trades.id, ipos.tradeId));
  const rows = (accountId > 0 ? q.where(and(where, eq(ipos.accountId, accountId))) : q.where(where)).all();
  const ghostIds = new Set(rows.map((r) => r.holdingRef).filter((x): x is number => x != null));
  if (ghostIds.size === 0) return rows;
  const inTrash = trashedTradeIds(ghostIds);
  return rows.map((r) => (r.holdingRef == null ? r : { ...r, holdingInTrash: inTrash.has(r.holdingRef) }));
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
  // Wave U — accounts on a multi-plan broker that state no plan (A3: ONE
  // predicate, exported, so the import preview's pricing line and this issue
  // can never describe different sets of accounts).
  const accountsWithoutPlan = getAccountsWithoutPlan();
  // v4.5.0 wave TP — the same (incurredFy, head) lot held by TWO accounts of
  // ONE tax person. Read across every account on purpose: the question is
  // about a PERSON, not about the selected book, and the tax pages seed the
  // engine from all of that person's lots. Never de-duplicated here.
  const accountRows = db.select({ id: accountsTable.id, name: accountsTable.name, taxIdentity: accountsTable.taxIdentity }).from(accountsTable).all();
  const personOf = new Map(accountRows.map((a) => [a.id, taxPersonKey(a)]));
  const nameOf = new Map(accountRows.map((a) => [a.id, a.name]));
  const lotGroups = new Map<string, { person: string; fy: string; head: string; accounts: Set<number> }>();
  for (const lot of db.select({ accountId: bfLossLots.accountId, incurredFy: bfLossLots.incurredFy, head: bfLossLots.head }).from(bfLossLots).all()) {
    const person = personOf.get(lot.accountId);
    if (!person) continue;
    const key = `${person}|${lot.incurredFy}|${lot.head}`;
    const held = lotGroups.get(key) ?? { person, fy: lot.incurredFy, head: lot.head, accounts: new Set<number>() };
    held.accounts.add(lot.accountId);
    lotGroups.set(key, held);
  }
  const duplicateBfLots = [...lotGroups.values()]
    .filter((g) => g.accounts.size > 1)
    .map((g) => ({ person: g.person, fy: g.fy, head: g.head, accounts: [...g.accounts].sort((a, b) => a - b).map((id) => nameOf.get(id) ?? `#${id}`) }));
  const report = assessDataQuality({ today: todayIstIso(), trades: all, markedTradeIds, knownSymbols, ipoLinkedTradeIds, staleMtmCount, missingAttachmentFiles, unlinkedIpoRecords: getUnlinkedExitedIpoRecords(), accountsWithoutPlan, duplicateBfLots });
  // v4.6.0 fix wave (MO-4) — STAGED rows whose legs do not state their parent
  // (invariant 5), judged by the ONE predicate `ladderMismatch` (the L-36 guard
  // purchaseRows splits on, plus the sale side). A Paytm or Groww book imported
  // before 4.6.0 carries ladders the date-window filter over-counted (PARAS:
  // parent 2,000, ladder 3,001 bought). Re-importing the same file is SKIPPED as
  // a duplicate (dedup hashes the parent, which did not change), so the remedy is
  // named, never applied: delete the row, then re-import the file. The same
  // scope as every other issue here (`getTrades()`, invariant 8).
  const mismatched = ladderMismatchIds(all);
  if (mismatched.length === 0) return report;
  const issues = [
    ...report.issues,
    {
      code: "ladder_mismatch",
      severity: "warning" as const,
      title: "Staged positions whose fills do not add up to the position",
      detail:
        "These positions carry an execution ladder whose entries or exits do not sum to the position itself — an import from before v4.6.0 handed a fill split across two positions to both. The position's own quantities, values and P&L are right; its ladder, its fills list and the per-fill tax rows are not. Delete the position, then re-import the same file: this version writes a ladder that sums to it.",
      count: mismatched.length,
      href: "/trades",
      ids: mismatched.slice(0, 100),
    },
  ];
  return { ...report, issues, score: scoreIssues(issues), affected: new Set(issues.flatMap((x) => x.ids ?? [])).size };
}

/** Ids of the staged rows (in the caller's scope) whose ladder does not state the parent. */
export function ladderMismatchIds(rows: readonly { id: number; staged: boolean | null; buyQty: number; sellQty: number; buyValue: number; buyDate: string | null }[]): number[] {
  const staged = rows.filter((t) => t.staged);
  if (staged.length === 0) return [];
  const views = getStagedViews(staged.map((t) => t.id));
  const out: number[] = [];
  for (const t of staged) {
    const view = views.get(t.id);
    if (!view || view.legs.length === 0) continue;
    if (ladderMismatch({ ...t, isOpen: false }, toDomainLegs(view.legs), view.position.direction) != null) out.push(t.id);
  }
  return out;
}
