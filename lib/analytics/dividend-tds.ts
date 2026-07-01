// IND-6 — Dividend & TDS tracker (PURE, no DB/React). INFORMATIONAL ONLY.
//
// Since FY2020-21, dividends are taxable in the shareholder's hands (no longer
// exempt via DDT). Section 194: a company must deduct 10% TDS if the aggregate
// dividend it pays a resident shareholder in a FY exceeds ₹5,000 — once that
// aggregate crosses the threshold, TDS applies to the payment that crosses it
// (this module taxes the full crossing payment, not just the excess — the
// common real-world convention, since payers estimate annual dividend up front
// rather than prorating a single payment).

const r2 = (n: number) => Math.round(n * 100) / 100;

export const TDS_THRESHOLD = 5000; // ₹ aggregate per company per FY
export const TDS_RATE = 0.10;

export interface DividendEvent {
  symbol: string; // canonical ticker
  fy: string; // e.g. "2026-27"
  date: string; // ISO — used to order events within a company+FY for the running-threshold calc
  grossAmount: number; // ₹ — pre-TDS dividend for this single payment
}

export interface DividendTdsEvent extends DividendEvent {
  tds: number; // ₹ TDS on this specific payment (0 if not yet past threshold)
  net: number; // grossAmount - tds
}

export interface CompanyFyDividend {
  symbol: string;
  fy: string;
  grossTotal: number;
  tdsTotal: number;
  netTotal: number;
  thresholdCrossed: boolean;
}

/**
 * Per-event TDS given the running total already received from this company
 * this FY (BEFORE this payment). Crossing the ₹5,000 aggregate triggers TDS
 * on the whole payment that crosses it, and on every payment after.
 */
export function computeEventTds(cumulativeBefore: number, grossAmount: number): { tds: number; net: number } {
  const cumulativeAfter = cumulativeBefore + grossAmount;
  if (cumulativeAfter <= TDS_THRESHOLD) return { tds: 0, net: r2(grossAmount) };
  const tds = r2(grossAmount * TDS_RATE);
  return { tds, net: r2(grossAmount - tds) };
}

/** Annotate a list of dividend events (any order) with per-event TDS, grouped by symbol+FY. */
export function annotateDividendTds(events: DividendEvent[]): DividendTdsEvent[] {
  const groups = new Map<string, DividendEvent[]>();
  for (const e of events) {
    const key = `${e.symbol}::${e.fy}`;
    const g = groups.get(key) ?? [];
    g.push(e);
    groups.set(key, g);
  }
  const out: DividendTdsEvent[] = [];
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => a.date.localeCompare(b.date));
    let cumulative = 0;
    for (const e of sorted) {
      const { tds, net } = computeEventTds(cumulative, e.grossAmount);
      out.push({ ...e, tds, net });
      cumulative += e.grossAmount;
    }
  }
  return out;
}

/** Roll annotated events up into one row per company+FY. */
export function summariseByCompanyFy(events: DividendEvent[]): CompanyFyDividend[] {
  const annotated = annotateDividendTds(events);
  const map = new Map<string, CompanyFyDividend>();
  for (const e of annotated) {
    const key = `${e.symbol}::${e.fy}`;
    const row = map.get(key) ?? { symbol: e.symbol, fy: e.fy, grossTotal: 0, tdsTotal: 0, netTotal: 0, thresholdCrossed: false };
    row.grossTotal = r2(row.grossTotal + e.grossAmount);
    row.tdsTotal = r2(row.tdsTotal + e.tds);
    row.netTotal = r2(row.netTotal + e.net);
    if (e.tds > 0) row.thresholdCrossed = true;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.fy.localeCompare(b.fy) || a.symbol.localeCompare(b.symbol));
}
