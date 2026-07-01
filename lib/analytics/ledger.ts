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
  | "adjustment";

export const LEDGER_TYPES: LedgerType[] = [
  "deposit",
  "withdrawal",
  "charge",
  "realised_pnl",
  "mtf_interest",
  "interest",
  "dividend",
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

export interface BucketLedger {
  bucket: string;
  openingPaise: number;
  depositsPaise: number;
  withdrawalsPaise: number; // negative
  chargesPaise: number; // negative (charges + mtf_interest)
  realisedPnlPaise: number;
  otherPaise: number; // interest + dividend + adjustment
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
      chargesPaise: by("charge") + by("mtf_interest"),
      realisedPnlPaise: by("realised_pnl"),
      otherPaise: by("interest") + by("dividend") + by("adjustment"),
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
