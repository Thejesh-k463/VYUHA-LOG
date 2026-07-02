// IND-9 — Peak-margin & short-margin penalty tracker (PURE, no DB/React).
//
// SEBI's peak-margin framework snapshots your margin utilisation multiple times
// intraday; a shortfall at any snapshot draws a broker penalty (a % of the
// shortfall, billed separately from brokerage/STT). There's no feed for this —
// brokers report it in the contract note / ledger statement — so it's tracked
// as a manually-entered ledger leak (type "margin_penalty"), same pattern as
// dividend TDS. This module just rolls those entries up by month for the
// Charges & MTF-Leak report.

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface MarginPenaltyEntry {
  date: string; // ISO
  amount: number; // ₹, magnitude (positive) — the penalty billed
}

export interface MarginPenaltyMonth {
  month: string; // YYYY-MM
  count: number;
  total: number; // ₹, positive magnitude
}

/** Roll up margin-penalty ledger entries by calendar month. */
export function marginPenaltyByMonth(entries: MarginPenaltyEntry[]): MarginPenaltyMonth[] {
  const map = new Map<string, MarginPenaltyMonth>();
  for (const e of entries) {
    if (!e.date) continue;
    const month = e.date.slice(0, 7);
    const row = map.get(month) ?? { month, count: 0, total: 0 };
    row.count++;
    row.total = r2(row.total + Math.abs(e.amount));
    map.set(month, row);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function marginPenaltyTotal(entries: MarginPenaltyEntry[]): number {
  return r2(entries.reduce((s, e) => s + Math.abs(e.amount), 0));
}
