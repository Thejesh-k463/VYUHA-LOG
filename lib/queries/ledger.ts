import "server-only";
import { db } from "@/lib/db";
import { ledgerEntries } from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { LedgerEntryInput, LedgerGroupRow, LedgerType, RunningRow } from "@/lib/analytics/ledger";
import { toPaise } from "@/lib/money";
import { getSelectedAccountId } from "./accounts";
import { getSettings } from "./settings";

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
 * Opening balance per bucket in PAISE, from settings (rupees at rest there,
 * converted once here). The defaults mirror the historical /cash fallbacks.
 */
export function getOpeningByBucketPaise(): Record<string, number> {
  const settings = getSettings();
  return {
    equity: toPaise(settings?.equityCapital ?? 1300000),
    active: toPaise(settings?.activeCapital ?? 400000),
  };
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
