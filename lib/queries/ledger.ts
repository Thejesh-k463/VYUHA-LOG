import "server-only";
import { db } from "@/lib/db";
import { ledgerEntries } from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { LedgerEntryInput, LedgerGroupRow, LedgerType, RunningRow } from "@/lib/analytics/ledger";
import { toPaise } from "@/lib/money";
import { getSelectedAccountId } from "./accounts";
import { getBucketCapital } from "./bucket-capital";

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

/**
 * Dividend entries that name a company — the only rows the Tax Summary's
 * Dividend & TDS card reads. Filtered in SQL: `/reports/tax` used to
 * materialise all 60k ledger rows (~130 ms) to keep the ~5.7k dividends. The
 * predicate is the page's old `e.type === "dividend" && e.symbol` verbatim
 * (non-empty symbol), and the ORDER BY matches `getLedgerEntries`, so
 * per-company float sums accumulate in the same order — identical rupees out.
 */
export function getDividendLedgerEntries(): (LedgerEntryInput & { symbol: string })[] {
  const accountId = getSelectedAccountId();
  const isDividend = and(
    eq(ledgerEntries.type, "dividend"),
    isNotNull(ledgerEntries.symbol),
    ne(ledgerEntries.symbol, ""),
  );
  const q = db.select().from(ledgerEntries);
  return q
    .where(accountId > 0 ? and(isDividend, eq(ledgerEntries.accountId, accountId)) : isDividend)
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
      symbol: r.symbol!,
    }));
}

/** The two ledger types that are money crossing the account boundary. */
const EXTERNAL_TYPES = ["deposit", "withdrawal"] as const;

/**
 * External cash flows (deposits/withdrawals) only — the rows XIRR and TWR on
 * /reports/performance turn into dated flows. Filtered in SQL: the page used
 * to materialise all 60k ledger rows (~130 ms + row mapping) to keep the
 * external ones. ORDER BY matches `getLedgerEntries` and `id` is unique, so
 * the flow order (and every integer-paise sum) is identical to filtering the
 * full list in JS.
 */
export function getExternalCashFlows(): { date: string; amountPaise: number }[] {
  const accountId = getSelectedAccountId();
  const isExternal = inArray(ledgerEntries.type, [...EXTERNAL_TYPES]);
  return db
    .select({ date: ledgerEntries.date, amountPaise: ledgerEntries.amountPaise })
    .from(ledgerEntries)
    .where(accountId > 0 ? and(isExternal, eq(ledgerEntries.accountId, accountId)) : isExternal)
    .orderBy(desc(ledgerEntries.date), desc(ledgerEntries.id))
    .all();
}

/**
 * The two whole-ledger figures /reports/performance needs beyond the external
 * rows, computed inside SQLite: the net of every NON-external entry (integer
 * paise — SQL SUM and a JS reduce are bit-identical for integers), and the
 * earliest non-empty entry date (TEXT MIN === lexicographic min on ISO dates,
 * exactly what `[...dates].filter(Boolean).sort()[0]` computed).
 */
export function getLedgerAggregates(): { internalNetPaise: number; minDate: string | null } {
  const accountId = getSelectedAccountId();
  const row = db.get<{ internal: number | null; minDate: string | null }>(sql`
    select
      sum(case when ${ledgerEntries.type} not in ('deposit','withdrawal') then ${ledgerEntries.amountPaise} else 0 end) as internal,
      min(nullif(${ledgerEntries.date}, '')) as minDate
    from ${ledgerEntries}
    ${accountId > 0 ? sql`where ${ledgerEntries.accountId} = ${accountId}` : sql``}
  `);
  return { internalNetPaise: row?.internal ?? 0, minDate: row?.minDate ?? null };
}

/**
 * Opening balance per bucket in PAISE (rupees at rest, converted once here).
 * 0 means NOT CONFIGURED — a clean install seeds exactly that. The old ₹13L/₹4L
 * fallbacks seeded every running balance and "available" figure on /cash with
 * fictional opening capital (invariant 6: never fabricate a denominator). With
 * 0, running balances are honest NET-FLOW figures; the UI reads
 * `getCapitalConfigured()` to say so instead of printing an invented ₹0 opening
 * as if it were real.
 *
 * ACCOUNT-FIRST (v3.7): the ledger rows above are account-scoped (invariant 8),
 * so the opening they run from must be the SELECTED account's capital, not the
 * global settings row. `getBucketCapital` is imported from its own module so
 * /cash does not inherit capital.ts's trades/ipos import graph.
 */
export function getOpeningByBucketPaise(): Record<string, number> {
  const cap = getBucketCapital();
  return {
    equity: toPaise(cap.equityCapital),
    active: toPaise(cap.activeCapital),
  };
}

/**
 * Whether each bucket's opening capital is actually configured (> 0; a clean
 * install seeds 0 = unset — same convention as the trackers' bucketCapital).
 * Carried to the UI so /cash can label balances as flows-only rather than
 * presenting a fabricated ₹0 opening as a real figure. Resolved account-first,
 * from the same helper as the openings above — the label and the number it
 * describes must never disagree about which account they are talking about.
 */
export function getCapitalConfigured(): { equity: boolean; active: boolean; any: boolean } {
  const cap = getBucketCapital();
  const equity = cap.equityCapital > 0;
  const active = cap.activeCapital > 0;
  return { equity, active, any: equity || active };
}

/**
 * The ledger reduced to `GROUP BY bucket, type` sums inside SQLite. /cash's
 * KPI row, bucket cards and type breakdown need nothing finer, and this stays
 * O(distinct groups) in JS no matter how many entries exist (60k entries → ~20 rows).
 */
export function getLedgerGroups(): LedgerGroupRow[] {
  const accountId = getSelectedAccountId();
  return db.all<LedgerGroupRow>(sql`
    select ${ledgerEntries.bucket} as bucket, ${ledgerEntries.type} as type,
           sum(${ledgerEntries.amountPaise}) as totalPaise, count(*) as count
    from ${ledgerEntries}
    ${accountId > 0 ? sql`where ${ledgerEntries.accountId} = ${accountId}` : sql``}
    group by ${ledgerEntries.bucket}, ${ledgerEntries.type}
  `);
}

/** Ledger entry count for the selected account — the header badge, and load-more math. */
export function countLedgerEntries(): number {
  const accountId = getSelectedAccountId();
  const row = db.get<{ n: number }>(sql`
    select count(*) as n from ${ledgerEntries}
    ${accountId > 0 ? sql`where ${ledgerEntries.accountId} = ${accountId}` : sql``}
  `);
  return row?.n ?? 0;
}

/**
 * One PAGE of the running-balance ledger, latest first, with the per-bucket
 * running balance computed by a SQL window function instead of materialising
 * every entry into JS (the pattern that made /cash a 27-second render at 60k
 * rows). The window runs chronologically (date, id) per bucket — identical to
 * `summariseLedger`'s running pass — and the page is then ordered latest first,
 * exactly matching the old `[...running].reverse()`.
 *
 * `limit < 0` means ALL rows (SQLite's own `LIMIT -1` semantics) — used by the
 * on-demand export, never by a render.
 */
export function getLedgerRunningRows(opts: { limit: number; offset?: number }): (RunningRow & { symbol: string | null })[] {
  const accountId = getSelectedAccountId();
  const opening = getOpeningByBucketPaise();
  const rows = db.all<{
    id: number; date: string; bucket: string; type: LedgerType; amountPaise: number;
    note: string | null; refTradeId: number | null; symbol: string | null; runPaise: number;
  }>(sql`
    select ${ledgerEntries.id} as id, ${ledgerEntries.date} as date, ${ledgerEntries.bucket} as bucket,
           ${ledgerEntries.type} as type, ${ledgerEntries.amountPaise} as amountPaise,
           ${ledgerEntries.note} as note, ${ledgerEntries.refTradeId} as refTradeId, ${ledgerEntries.symbol} as symbol,
           sum(${ledgerEntries.amountPaise}) over (
             partition by ${ledgerEntries.bucket}
             order by ${ledgerEntries.date}, ${ledgerEntries.id}
             rows unbounded preceding
           ) as runPaise
    from ${ledgerEntries}
    ${accountId > 0 ? sql`where ${ledgerEntries.accountId} = ${accountId}` : sql``}
    order by ${ledgerEntries.date} desc, ${ledgerEntries.id} desc
    limit ${opts.limit} offset ${opts.offset ?? 0}
  `);
  return rows.map(({ runPaise, ...r }) => ({ ...r, balancePaise: (opening[r.bucket] ?? 0) + runPaise }));
}
