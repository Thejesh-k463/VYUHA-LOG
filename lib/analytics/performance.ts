// Pure quant performance analytics — risk-adjusted returns from the realised
// daily P&L series. Returns are computed on running equity (capital + cumulative
// realised P&L), i.e. a time-weighted approximation. No DB/React deps.
//
// Note: this is "return on capital" using the configured starting capital as the
// base; a true money-weighted return (XIRR) needs the cash ledger (roadmap P0.2).

const TRADING_DAYS = 252;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  net: number; // realised net P&L that day
}

export interface ReturnPoint {
  date: string;
  net: number;
  equity: number; // equity after this day
  ret: number; // fractional daily return on prior equity
  drawdown: number; // fractional, <= 0
}

export interface MonthlyReturn {
  ym: string; // YYYY-MM
  year: number;
  month: number; // 1-12
  net: number;
  retPct: number;
}

export interface PerformanceStats {
  tradingDays: number;
  calendarDays: number;
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  cagrPct: number | null; // null when the window is too short to annualise (<30d)
  volatilityPct: number; // annualised
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number;
  maxDrawdownAmt: number;
  calmar: number | null;
  bestDayPct: number;
  worstDayPct: number;
  positiveDaysPct: number;
  avgWinDayPct: number;
  avgLossDayPct: number;
  series: ReturnPoint[];
  monthly: MonthlyReturn[];
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000));
}

export function emptyPerformance(startingCapital: number): PerformanceStats {
  return {
    tradingDays: 0, calendarDays: 0, startEquity: startingCapital, endEquity: startingCapital,
    totalReturnPct: 0, cagrPct: null, volatilityPct: 0, sharpe: null, sortino: null,
    maxDrawdownPct: 0, maxDrawdownAmt: 0, calmar: null, bestDayPct: 0, worstDayPct: 0,
    positiveDaysPct: 0, avgWinDayPct: 0, avgLossDayPct: 0, series: [], monthly: [],
  };
}

/**
 * @param daily            realised net P&L per day (any order)
 * @param startingCapital  equity base at the start of the window
 * @param riskFreeAnnual   annual risk-free rate as a fraction (e.g. 0.07 for 7%)
 */
export function computePerformance(
  daily: DailyPoint[],
  startingCapital: number,
  riskFreeAnnual = 0,
): PerformanceStats {
  const base = startingCapital > 0 ? startingCapital : 1;
  const days = daily.filter((d) => d.date).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (days.length === 0) return emptyPerformance(startingCapital);

  // Build the equity + return series.
  const series: ReturnPoint[] = [];
  let equity = base;
  let peak = base;
  let maxDdFrac = 0;
  let maxDdAmt = 0;
  for (const d of days) {
    const prev = equity;
    equity = equity + d.net;
    const ret = prev !== 0 ? d.net / prev : 0;
    if (equity > peak) peak = equity;
    const ddFrac = peak !== 0 ? (equity - peak) / peak : 0;
    if (ddFrac < maxDdFrac) maxDdFrac = ddFrac;
    if (equity - peak < maxDdAmt) maxDdAmt = equity - peak;
    series.push({ date: d.date, net: r2(d.net), equity: r2(equity), ret, drawdown: r4(ddFrac) });
  }

  const rets = series.map((s) => s.ret);
  const startEquity = base;
  const endEquity = equity;
  const totalReturn = endEquity / startEquity - 1;

  const sd = std(rets);
  const volAnnual = sd * Math.sqrt(TRADING_DAYS);
  const rfDaily = riskFreeAnnual / TRADING_DAYS;
  const excess = rets.map((r) => r - rfDaily);
  const meanExcess = excess.reduce((a, b) => a + b, 0) / excess.length;
  const downside = rets.filter((r) => r < 0);
  const downsideDev =
    downside.length > 0 ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / rets.length) : 0;

  const sharpe = sd > 0 ? (meanExcess * TRADING_DAYS) / volAnnual : null;
  const sortino = downsideDev > 0 ? (meanExcess * TRADING_DAYS) / (downsideDev * Math.sqrt(TRADING_DAYS)) : null;

  const calendarDays = daysBetween(days[0].date, days[days.length - 1].date) || 1;
  const years = calendarDays / 365;
  const cagr = calendarDays >= 30 && totalReturn > -1 ? Math.pow(1 + totalReturn, 1 / years) - 1 : null;
  const maxDdPct = Math.abs(maxDdFrac) * 100;
  const calmar = cagr != null && maxDdPct > 0 ? (cagr * 100) / maxDdPct : null;

  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);

  return {
    tradingDays: days.length,
    calendarDays,
    startEquity: r2(startEquity),
    endEquity: r2(endEquity),
    totalReturnPct: r2(totalReturn * 100),
    cagrPct: cagr == null ? null : r2(cagr * 100),
    volatilityPct: r2(volAnnual * 100),
    sharpe: sharpe == null ? null : r2(sharpe),
    sortino: sortino == null ? null : r2(sortino),
    maxDrawdownPct: r2(maxDdPct),
    maxDrawdownAmt: r2(Math.abs(maxDdAmt)),
    calmar: calmar == null ? null : r2(calmar),
    bestDayPct: rets.length ? r2(Math.max(...rets) * 100) : 0,
    worstDayPct: rets.length ? r2(Math.min(...rets) * 100) : 0,
    positiveDaysPct: rets.length ? r2((wins.length / rets.length) * 100) : 0,
    avgWinDayPct: wins.length ? r2((wins.reduce((a, b) => a + b, 0) / wins.length) * 100) : 0,
    avgLossDayPct: losses.length ? r2((losses.reduce((a, b) => a + b, 0) / losses.length) * 100) : 0,
    series,
    monthly: monthlyReturns(series),
  };
}

// ---------------------------------------------------------------------------
// Time-weighted return (TWR) — chains daily sub-period returns while neutralising
// the effect of external cashflows (deposits/withdrawals). Unlike XIRR (money-
// weighted), TWR measures the manager's *skill* independent of when capital was
// added or removed: a deposit grows the base but is NOT counted as a return.
// ---------------------------------------------------------------------------

export interface CashFlowR {
  date: string; // YYYY-MM-DD
  amount: number; // rupees; deposit +, withdrawal − (adds/removes capital, never a "return")
}

export interface TwrResult {
  twrPct: number; // cumulative chained return over the window
  annualizedPct: number | null; // null when the window is too short to annualise (<30d)
  days: number; // calendar days spanned
  periods: number; // number of daily sub-returns chained
}

/**
 * @param daily            realised net P&L per day (any order)
 * @param startingCapital  equity base at the start of the window
 * @param flows            external cashflows (deposits +, withdrawals −) by date
 */
export function timeWeightedReturn(
  daily: DailyPoint[],
  startingCapital: number,
  flows: CashFlowR[] = [],
): TwrResult | null {
  const days = daily.filter((d) => d.date).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (days.length === 0) return null;

  const flowByDate = new Map<string, number>();
  for (const f of flows) {
    if (!f.date || !Number.isFinite(f.amount)) continue;
    flowByDate.set(f.date, (flowByDate.get(f.date) ?? 0) + f.amount);
  }

  // Walk the union of P&L dates and flow dates in chronological order. A flow is
  // applied at the start of its day (joins the base for that day) but is excluded
  // from the return numerator; only realised P&L drives each daily return.
  const allDates = [...new Set([...days.map((d) => d.date), ...flowByDate.keys()])].sort((a, b) => a.localeCompare(b));
  const netByDate = new Map<string, number>();
  for (const d of days) netByDate.set(d.date, (netByDate.get(d.date) ?? 0) + d.net);

  let equity = startingCapital > 0 ? startingCapital : 1;
  let growth = 1;
  let periods = 0;
  for (const date of allDates) {
    equity += flowByDate.get(date) ?? 0; // capital in/out — not a return
    const net = netByDate.get(date) ?? 0;
    if (net !== 0 && equity > 0) {
      growth *= 1 + net / equity;
      periods++;
    }
    equity += net;
  }

  const twr = growth - 1;
  const calendarDays = daysBetween(allDates[0], allDates[allDates.length - 1]) || 1;
  const years = calendarDays / 365;
  const annualized = calendarDays >= 30 && twr > -1 ? Math.pow(1 + twr, 1 / years) - 1 : null;

  return {
    twrPct: r2(twr * 100),
    annualizedPct: annualized == null ? null : r2(annualized * 100),
    days: calendarDays,
    periods,
  };
}

/** Geometric monthly returns (chain daily returns within each month). */
export function monthlyReturns(series: ReturnPoint[]): MonthlyReturn[] {
  const map = new Map<string, { net: number; growth: number }>();
  for (const p of series) {
    const ym = p.date.slice(0, 7);
    const cur = map.get(ym) ?? { net: 0, growth: 1 };
    cur.net += p.net;
    cur.growth *= 1 + p.ret;
    map.set(ym, cur);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, v]) => {
      const [y, m] = ym.split("-").map(Number);
      return { ym, year: y, month: m, net: r2(v.net), retPct: r2((v.growth - 1) * 100) };
    });
}
