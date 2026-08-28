// P0.2 — Cash & fund-flow ledger analytics (PURE, no DB/React). All money in PAISE.
//
// Capital is no longer a single hand-edited number: available capital is derived
// from an opening balance per bucket plus the running sum of ledger entries
// (deposits, withdrawals, charges, realised P&L, interest, adjustments). Entry
// amounts are stored SIGNED in paise (+ adds cash, − removes it).

export type LedgerType =
  | "deposit"
  | "withdrawal"
  | "charge"
  | "realised_pnl"
  | "mtf_interest"
  | "interest"
  | "dividend"
  | "dividend_tds"
  | "margin_penalty"
  | "adjustment";

export const LEDGER_TYPES: LedgerType[] = [
  "deposit",
  "withdrawal",
  "charge",
  "realised_pnl",
  "mtf_interest",
  "interest",
  "dividend",
  "dividend_tds",
  "margin_penalty",
  "adjustment",
];

/** Natural sign of a type — used when turning a user-entered magnitude into a signed amount. */
export const TYPE_SIGN: Record<LedgerType, 1 | -1> = {
  deposit: 1,
  withdrawal: -1,
  charge: -1,
  realised_pnl: 1, // may still be negative (a realised loss) — caller passes the real sign
  mtf_interest: -1,
  interest: 1,
  dividend: 1,
  dividend_tds: -1,
  margin_penalty: -1,
  adjustment: 1, // adjustments can be ±; caller passes the real sign
};

export const TYPE_LABEL: Record<LedgerType, string> = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  charge: "Charge",
  realised_pnl: "Realised P&L",
  mtf_interest: "MTF interest",
  interest: "Interest",
  dividend: "Dividend",
  dividend_tds: "Dividend TDS",
  margin_penalty: "Margin Penalty",
  adjustment: "Adjustment",
};

export interface LedgerEntryInput {
  id: number;
  date: string; // ISO
  bucket: string; // equity | active | "" (unassigned)
  type: LedgerType;
  amountPaise: number; // signed
  note?: string | null;
  refTradeId?: number | null;
}

export interface RunningRow extends LedgerEntryInput {
  balancePaise: number; // bucket balance immediately after this entry
}

/**
 * How many running-balance rows a /cash render ships. The full ledger used to
 * be SSR'd and serialised into the RSC payload wholesale — 113 MB of HTML and
 * a 27 s render at 60k entries. Everything beyond this page loads on demand
 * via GET /api/ledger with balances still computed in SQL, so every row (and
 * the exact same numbers) remains reachable.
 */
export const LEDGER_PAGE_SIZE = 200;

export interface BucketLedger {
  bucket: string;
  openingPaise: number;
  depositsPaise: number;
  withdrawalsPaise: number; // negative
  chargesPaise: number; // negative (charges + mtf_interest + margin_penalty)
  realisedPnlPaise: number;
  otherPaise: number; // interest + dividend + dividend_tds + adjustment
  flowsPaise: number; // Σ all entries
  availablePaise: number; // opening + flows
  count: number;
}

export interface LedgerSummary {
  buckets: BucketLedger[];
  totalOpeningPaise: number;
  totalFlowsPaise: number;
  totalAvailablePaise: number;
  byType: Record<LedgerType, number>;
  running: RunningRow[]; // chronological
}

/**
 * One `GROUP BY bucket, type` row from SQL — the whole ledger reduced to at
 * most buckets × types rows before it ever leaves the database.
 */
export interface LedgerGroupRow {
  bucket: string;
  type: LedgerType;
  totalPaise: number;
  count: number;
}

/** `summariseLedger` minus the materialised `running` rows, plus a total count. */
export type LedgerGroupSummary = Omit<LedgerSummary, "running"> & { totalCount: number };

/**
 * Same numbers as `summariseLedger`, computed from SQL GROUP BY rows instead of
 * every ledger entry. At 60k entries the entry-level path materialised the
 * whole table per render just to add it up; the grouped path is O(buckets × types).
 * `tests/ledger.test.ts` asserts the two agree entry-for-entry.
 */
export function summariseLedgerGroups(
  groups: LedgerGroupRow[],
  openingByBucket: Record<string, number>,
): LedgerGroupSummary {
  const bucketNames = [...new Set([...Object.keys(openingByBucket), ...groups.map((g) => g.bucket)])].sort();
  const byType = LEDGER_TYPES.reduce(
    (acc, t) => {
      acc[t] = 0;
      return acc;
    },
    {} as Record<LedgerType, number>,
  );
  const perBucket = new Map(bucketNames.map((b) => [b, { sums: {} as Record<string, number>, flows: 0, count: 0 }]));
  for (const g of groups) {
    const pb = perBucket.get(g.bucket);
    if (!pb) continue; // unreachable: bucketNames is built from groups
    pb.sums[g.type] = (pb.sums[g.type] ?? 0) + g.totalPaise;
    pb.flows += g.totalPaise; // flows sum EVERY entry, known type or not — same as summariseLedger
    pb.count += g.count;
    if (g.type in byType) byType[g.type] += g.totalPaise;
  }
  const buckets: BucketLedger[] = bucketNames.map((bucket) => {
    const { sums, flows, count } = perBucket.get(bucket)!;
    const by = (t: LedgerType) => sums[t] ?? 0;
    const opening = openingByBucket[bucket] ?? 0;
    return {
      bucket,
      openingPaise: opening,
      depositsPaise: by("deposit"),
      withdrawalsPaise: by("withdrawal"),
      chargesPaise: by("charge") + by("mtf_interest") + by("margin_penalty"),
      realisedPnlPaise: by("realised_pnl"),
      otherPaise: by("interest") + by("dividend") + by("dividend_tds") + by("adjustment"),
      flowsPaise: flows,
      availablePaise: opening + flows,
      count,
    };
  });
  return {
    buckets,
    totalOpeningPaise: buckets.reduce((s, b) => s + b.openingPaise, 0),
    totalFlowsPaise: buckets.reduce((s, b) => s + b.flowsPaise, 0),
    totalAvailablePaise: buckets.reduce((s, b) => s + b.availablePaise, 0),
    byType,
    totalCount: buckets.reduce((s, b) => s + b.count, 0),
  };
}

export function summariseLedger(
  entries: LedgerEntryInput[],
  openingByBucket: Record<string, number>,
): LedgerSummary {
  const bucketNames = [...new Set([...Object.keys(openingByBucket), ...entries.map((e) => e.bucket)])].sort();

  const buckets: BucketLedger[] = bucketNames.map((bucket) => {
    const es = entries.filter((e) => e.bucket === bucket);
    const opening = openingByBucket[bucket] ?? 0;
    const by = (t: LedgerType) => es.filter((e) => e.type === t).reduce((s, e) => s + e.amountPaise, 0);
    const flows = es.reduce((s, e) => s + e.amountPaise, 0);
    return {
      bucket,
      openingPaise: opening,
      depositsPaise: by("deposit"),
      withdrawalsPaise: by("withdrawal"),
      chargesPaise: by("charge") + by("mtf_interest") + by("margin_penalty"),
      realisedPnlPaise: by("realised_pnl"),
      otherPaise: by("interest") + by("dividend") + by("dividend_tds") + by("adjustment"),
      flowsPaise: flows,
      availablePaise: opening + flows,
      count: es.length,
    };
  });

  const byType = LEDGER_TYPES.reduce(
    (acc, t) => {
      acc[t] = entries.filter((e) => e.type === t).reduce((s, e) => s + e.amountPaise, 0);
      return acc;
    },
    {} as Record<LedgerType, number>,
  );

  // Running balance per bucket, in chronological order.
  const sorted = entries.slice().sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const run: Record<string, number> = { ...openingByBucket };
  const running: RunningRow[] = sorted.map((e) => {
    run[e.bucket] = (run[e.bucket] ?? 0) + e.amountPaise;
    return { ...e, balancePaise: run[e.bucket] };
  });

  return {
    buckets,
    totalOpeningPaise: buckets.reduce((s, b) => s + b.openingPaise, 0),
    totalFlowsPaise: buckets.reduce((s, b) => s + b.flowsPaise, 0),
    totalAvailablePaise: buckets.reduce((s, b) => s + b.availablePaise, 0),
    byType,
    running,
  };
}
