// Pure analytics — runs on server or client (no DB/React deps). The DB `Trade`
// type is structurally assignable to AnalyticsTrade.

export interface AnalyticsTrade {
  broker: string;
  bucket: string;
  segment: string;
  netPnl: number;
  grossPnl: number;
  chargesTotal: number;
  rMultiple: number | null;
  isOpen: boolean;
  sellDate: string | null;
  buyDate: string | null;
  setupTag: string | null;
}

export interface Kpis {
  count: number;
  closedCount: number;
  openCount: number;
  netPnl: number;
  grossPnl: number;
  charges: number;
  chargePctOfGross: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  profitFactor: number;
  expectancy: number;
  avgR: number | null;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: number; // +n wins / -n losses
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Closed trades sorted chronologically by sell date (fallback id-less: keep input order). */
export function closedSorted<T extends AnalyticsTrade>(trades: T[]): T[] {
  return trades
    .filter((t) => !t.isOpen)
    .slice()
    .sort((a, b) => (a.sellDate ?? "").localeCompare(b.sellDate ?? ""));
}

export function computeKpis(trades: AnalyticsTrade[]): Kpis {
  const closed = closedSorted(trades);
  const openCount = trades.filter((t) => t.isOpen).length;

  let netPnl = 0, grossPnl = 0, charges = 0;
  let wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let rSum = 0, rCount = 0;
  for (const t of closed) {
    netPnl += t.netPnl;
    grossPnl += t.grossPnl;
    charges += t.chargesTotal;
    if (t.netPnl > 0) { wins++; sumWin += t.netPnl; }
    else if (t.netPnl < 0) { losses++; sumLoss += t.netPnl; }
    if (t.rMultiple != null) { rSum += t.rMultiple; rCount++; }
  }

  // streaks (chronological)
  let maxWin = 0, maxLoss = 0, cur = 0;
  for (const t of closed) {
    if (t.netPnl > 0) cur = cur >= 0 ? cur + 1 : 1;
    else if (t.netPnl < 0) cur = cur <= 0 ? cur - 1 : -1;
    else continue;
    if (cur > maxWin) maxWin = cur;
    if (cur < -maxLoss) maxLoss = -cur;
  }

  // drawdown from equity curve
  let peak = 0, cum = 0, maxDd = 0;
  for (const t of closed) {
    cum += t.netPnl;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < maxDd) maxDd = dd;
  }

  const closedCount = closed.length;
  return {
    count: trades.length,
    closedCount,
    openCount,
    netPnl: r2(netPnl),
    grossPnl: r2(grossPnl),
    charges: r2(charges),
    chargePctOfGross: grossPnl !== 0 ? r2((charges / Math.abs(grossPnl)) * 100) : 0,
    wins,
    losses,
    winRate: closedCount ? wins / closedCount : 0,
    profitFactor: sumLoss !== 0 ? r2(sumWin / Math.abs(sumLoss)) : sumWin > 0 ? Infinity : 0,
    expectancy: closedCount ? r2(netPnl / closedCount) : 0,
    avgR: rCount ? r2(rSum / rCount) : null,
    avgWin: wins ? r2(sumWin / wins) : 0,
    avgLoss: losses ? r2(sumLoss / losses) : 0,
    maxDrawdown: r2(Math.abs(maxDd)),
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss,
    currentStreak: cur,
  };
}

export interface EquityPoint {
  date: string;
  net: number; // that day's net
  cum: number; // cumulative
  peak: number;
  drawdown: number; // <= 0
}

/** Cumulative realised equity curve by sell date (with drawdown). */
export function equityCurve(trades: AnalyticsTrade[]): EquityPoint[] {
  const daily = dailyPnl(trades);
  const dates = [...daily.keys()].sort();
  const out: EquityPoint[] = [];
  let cum = 0, peak = 0;
  for (const d of dates) {
    const net = daily.get(d)!;
    cum = r2(cum + net);
    if (cum > peak) peak = cum;
    out.push({ date: d, net: r2(net), cum, peak, drawdown: r2(cum - peak) });
  }
  return out;
}

/** date (YYYY-MM-DD) -> realised net P&L that day. */
export function dailyPnl(trades: AnalyticsTrade[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of trades) {
    if (t.isOpen || !t.sellDate) continue;
    m.set(t.sellDate, r2((m.get(t.sellDate) ?? 0) + t.netPnl));
  }
  return m;
}

export interface GroupStat {
  key: string;
  count: number;
  net: number;
  gross: number;
  charges: number;
  wins: number;
  winRate: number;
  avgR: number | null;
}

export function groupBy(
  trades: AnalyticsTrade[],
  keyFn: (t: AnalyticsTrade) => string | null,
): GroupStat[] {
  const map = new Map<string, AnalyticsTrade[]>();
  for (const t of trades) {
    if (t.isOpen) continue;
    const k = keyFn(t);
    if (k == null) continue;
    (map.get(k) ?? map.set(k, []).get(k)!).push(t);
  }
  const out: GroupStat[] = [];
  for (const [key, list] of map) {
    let net = 0, gross = 0, charges = 0, wins = 0, rSum = 0, rCount = 0;
    for (const t of list) {
      net += t.netPnl; gross += t.grossPnl; charges += t.chargesTotal;
      if (t.netPnl > 0) wins++;
      if (t.rMultiple != null) { rSum += t.rMultiple; rCount++; }
    }
    out.push({
      key,
      count: list.length,
      net: r2(net),
      gross: r2(gross),
      charges: r2(charges),
      wins,
      winRate: list.length ? wins / list.length : 0,
      avgR: rCount ? r2(rSum / rCount) : null,
    });
  }
  return out.sort((a, b) => b.net - a.net);
}

export const bySegment = (t: AnalyticsTrade[]) => groupBy(t, (x) => x.segment);
export const bySetup = (t: AnalyticsTrade[]) => groupBy(t, (x) => x.setupTag || "(untagged)");
export const byBroker = (t: AnalyticsTrade[]) => groupBy(t, (x) => x.broker);
