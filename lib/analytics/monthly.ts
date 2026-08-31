/**
 * THE MONTH AS A UNIT OF WORK — depth behind the returns matrix.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `monthlyReturns` (performance.ts) chains DAILY returns into a geometric
 * monthly percentage. That is the right way to compute a return, but it is
 * computed from the equity series, which carries no trade count, no charges and
 * no win/loss — so the monthly matrix could only ever show one number per cell.
 * `MonthlyReturn.net` was already computed there and thrown away by every
 * caller.
 *
 * This module aggregates the TRADES instead, so a month can be read as a unit of
 * work: how many trades, how many won, what it cost to trade, and how it
 * compares with the month before.
 *
 * It deliberately does NOT recompute retPct. That number needs the equity
 * series and already exists; duplicating it here would create two monthly return
 * figures that could disagree — the exact defect that three turnover formulas
 * caused in the tax modules.
 *
 * ── On month-over-month ───────────────────────────────────────────────────
 *
 * `momNet` is set ONLY when the preceding row is the immediately preceding
 * CALENDAR month. A trader who did not trade in November has no
 * November-to-December comparison, and quietly comparing December against
 * October would invent a trend. Gaps yield null, and null renders as "—".
 *
 * ── On the tax split ──────────────────────────────────────────────────────
 *
 * `monthlyByHead` reports REALISED GAINS BY HEAD PER MONTH. It is NOT a monthly
 * tax liability and must never be labelled as one: set-off, thresholds and slab
 * rates are all ANNUAL, so "your tax for March" is not a quantity that exists.
 * What a month can honestly show is what was realised in it, split the way the
 * return splits it. See `MONTHLY_HEAD_CAVEAT`.
 */

import { DELIVERY_SEGMENTS, FNO_SEGMENTS, SPECULATIVE_SEGMENT } from "./turnover";

export interface MonthlyTrade {
  /** Realisation date. A trade with none cannot be placed in a month. */
  sellDate: string | null;
  buyDate: string | null;
  segment: string;
  netPnl: number;
  grossPnl: number;
  chargesTotal: number;
  isOpen: boolean;
}

export interface MonthRow {
  ym: string; // YYYY-MM
  year: number;
  month: number; // 1-12
  trades: number;
  net: number;
  gross: number;
  charges: number;
  wins: number;
  losses: number;
  /** Wins ÷ trades, 0..1. */
  winRate: number;
  /** Net ÷ trades. */
  expectancy: number;
  best: number;
  worst: number;
  /**
   * Charges as a share of GROSS profit. Null against a non-positive gross,
   * because a percentage of a loss is not a drag figure (same rule as
   * segment-depth.ts).
   */
  chargeDragPct: number | null;
  /** Change in net vs the immediately preceding CALENDAR month; null if absent. */
  momNet: number | null;
}

export interface MonthlyReport {
  rows: MonthRow[];
  /** Closed trades with no sell date — countable, but not placeable in a month. */
  undated: number;
  bestMonth: MonthRow | null;
  worstMonth: MonthRow | null;
  /** Months in the range that saw no trades at all. */
  monthsWithoutTrades: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Previous calendar month for a "YYYY-MM" key. */
function prevYm(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Count of calendar months from a to b inclusive; 0 if out of order. */
function monthSpan(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  const n = (by - ay) * 12 + (bm - am) + 1;
  return n > 0 ? n : 0;
}

export function monthlyBreakdown(trades: MonthlyTrade[]): MonthlyReport {
  const closed = trades.filter((t) => !t.isOpen);
  const undated = closed.filter((t) => !t.sellDate).length;

  const map = new Map<string, MonthlyTrade[]>();
  for (const t of closed) {
    if (!t.sellDate) continue;
    const ym = t.sellDate.slice(0, 7);
    const cur = map.get(ym);
    if (cur) cur.push(t);
    else map.set(ym, [t]);
  }

  const keys = [...map.keys()].sort();
  const rows: MonthRow[] = keys.map((ym) => {
    const ts = map.get(ym)!;
    const [year, month] = ym.split("-").map(Number);
    const net = r2(ts.reduce((s, t) => s + t.netPnl, 0));
    const gross = r2(ts.reduce((s, t) => s + t.grossPnl, 0));
    const charges = r2(ts.reduce((s, t) => s + t.chargesTotal, 0));
    const wins = ts.filter((t) => t.netPnl > 0).length;
    const losses = ts.filter((t) => t.netPnl < 0).length;
    const nets = ts.map((t) => t.netPnl);
    return {
      ym,
      year,
      month,
      trades: ts.length,
      net,
      gross,
      charges,
      wins,
      losses,
      winRate: ts.length ? wins / ts.length : 0,
      expectancy: ts.length ? r2(net / ts.length) : 0,
      best: r2(Math.max(...nets)),
      worst: r2(Math.min(...nets)),
      chargeDragPct: gross > 0 ? r2((charges / gross) * 100) : null,
      momNet: null,
    };
  });

  // Month-over-month only against the immediately preceding calendar month.
  const byYm = new Map(rows.map((r) => [r.ym, r]));
  for (const row of rows) {
    const prev = byYm.get(prevYm(row.ym));
    row.momNet = prev ? r2(row.net - prev.net) : null;
  }

  const ranked = [...rows].sort((a, b) => b.net - a.net);
  const span = keys.length ? monthSpan(keys[0], keys[keys.length - 1]) : 0;

  return {
    rows,
    undated,
    bestMonth: ranked[0] ?? null,
    worstMonth: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    monthsWithoutTrades: Math.max(0, span - keys.length),
  };
}

// ---------------------------------------------------------------------------
// Realised gains by head, by month
// ---------------------------------------------------------------------------

/**
 * The sentence that MUST travel with `monthlyByHead` wherever it is displayed.
 * Without it the table reads as a monthly tax bill, which is not a thing.
 */
export const MONTHLY_HEAD_CAVEAT =
  "This is what you REALISED each month, split by head — not a monthly tax bill. Tax is computed for the whole year: set-off between heads, the long-term exemption threshold and the slab rates are all annual, so no month has a tax figure of its own. Use this to see when income arrived, and the yearly tables to see what is owed.";

export interface MonthHeadRow {
  ym: string;
  year: number;
  month: number;
  /** Short-term capital gains — equity delivery and MTF held under 12 months. */
  stcg: number;
  /** Long-term capital gains. */
  ltcg: number;
  /** Speculative business — intraday equity. */
  speculative: number;
  /** Non-speculative business — F&O. */
  fnoBusiness: number;
  charges: number;
  trades: number;
}

const LONG_TERM_DAYS = 365;

function isLongTerm(buy: string | null, sell: string | null): boolean {
  if (!buy || !sell) return false;
  const days = (new Date(sell + "T00:00:00").getTime() - new Date(buy + "T00:00:00").getTime()) / 86400000;
  return days >= LONG_TERM_DAYS;
}

/**
 * Realised P&L per month, split by the head the Act puts it in.
 *
 * Uses the same segment sets and the same 12-month line as the annual tax
 * modules, so a month column and the FY table cannot disagree about which head
 * a trade belongs to.
 */
export function monthlyByHead(trades: MonthlyTrade[]): MonthHeadRow[] {
  const map = new Map<string, MonthHeadRow>();

  for (const t of trades) {
    if (t.isOpen || !t.sellDate) continue;
    const ym = t.sellDate.slice(0, 7);
    const [year, month] = ym.split("-").map(Number);
    const row =
      map.get(ym) ??
      { ym, year, month, stcg: 0, ltcg: 0, speculative: 0, fnoBusiness: 0, charges: 0, trades: 0 };

    if (DELIVERY_SEGMENTS.has(t.segment)) {
      if (isLongTerm(t.buyDate, t.sellDate)) row.ltcg += t.netPnl;
      else row.stcg += t.netPnl;
    } else if (t.segment === SPECULATIVE_SEGMENT) {
      row.speculative += t.netPnl;
    } else if (FNO_SEGMENTS.has(t.segment)) {
      row.fnoBusiness += t.netPnl;
    }
    row.charges += t.chargesTotal;
    row.trades++;
    map.set(ym, row);
  }

  return [...map.values()]
    .map((r) => ({
      ...r,
      stcg: r2(r.stcg),
      ltcg: r2(r.ltcg),
      speculative: r2(r.speculative),
      fnoBusiness: r2(r.fnoBusiness),
      charges: r2(r.charges),
    }))
    .sort((a, b) => a.ym.localeCompare(b.ym));
}
