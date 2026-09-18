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
  /**
   * How the stock was acquired, when NOT bought inside the imported window
   * (see lib/analytics/acquisition.ts). Null for the overwhelming majority.
   */
  acquisition: string | null;
  /** User-supplied cost per share for an acquisition-flagged trade. */
  acquisitionPrice: number | null;
  /** Purchase value; zero on a sale whose purchase is not in the data. */
  buyValue: number;
  /** Chronological tiebreaks for same-day rows (closedSorted); optional so narrower fixtures still compile. */
  id?: number;
  exitTime?: string | null;
}

/**
 * Can this trade's EDGE be measured?
 *
 * A sale whose purchase is not in the data has `buyValue = 0`, which makes the
 * arithmetic read it as pure profit — a 100% winner, every time. Counting
 * those would inflate win rate, profit factor, expectancy and average win
 * simultaneously, all in the flattering direction.
 *
 * Cash is different: the sale and its charges really happened, so net P&L,
 * gross and charges still include them. Only the RATIOS are protected.
 */
export function edgeMeasurable(t: AnalyticsTrade): boolean {
  if (!t.acquisition) return true;
  if ((t.buyValue ?? 0) > 0) return true;
  return t.acquisitionPrice != null;
}

export interface Kpis {
  count: number;
  closedCount: number;
  openCount: number;
  netPnl: number;
  grossPnl: number;
  charges: number;
  /**
   * THE FIVE RATIOS BELOW ARE `null` WHEN THEIR OWN DENOMINATOR IS 0.
   *
   * A book cannot state a win rate over no priced trade, an average loss with
   * no loser, or a charge share of a gross of exactly zero — and a 0 there
   * reads as a real, terrible figure (invariant 6: never fabricate a
   * denominator). Every reader FORMATS through lib/format's null-safe family
   * (`inr`/`inrCompact`/`num`/`pct` all print "—") and GUARDS `!= null` before
   * any arithmetic or comparison: `null !== 0` is TRUE, which is how the payoff
   * cell used to print "NaN×", and `${null}%` is the string "null%".
   */
  /** null when `grossPnl` is 0. */
  chargePctOfGross: number | null;
  wins: number;
  losses: number;
  /** 0..1; null when no closed trade could be priced. */
  winRate: number | null;
  /** NOT in the null family — its own Infinity (no losers) / 0 (nothing) rule.
   *  Always r2(winnersNet ÷ |losersNet|) when there is a loser — by construction. */
  profitFactor: number;
  /**
   * Σ net P&L of the PRICED winners / losers — after charges, after the
   * `edgeMeasurable` filter: exactly the two sums `profitFactor` divides, so a
   * drill-down reading these reproduces the headline (v4.4.0 D6). NOT on the
   * lens wire either side (`lens-edge.ts`): together they rebuild PF, a Pro figure.
   */
  winnersNet: number;
  losersNet: number;
  /** null when no closed trade could be priced. */
  expectancy: number | null;
  avgR: number | null;
  /** null when there is no winner / no loser to average. */
  avgWin: number | null;
  avgLoss: number | null;
  maxDrawdown: number;
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: number; // +n wins / -n losses
  /** Closed trades excluded from the edge ratios for want of a cost basis. */
  unpricedCount: number;
  /** Their net P&L — counted in the cash totals, absent from the ratios. */
  unpricedNetPnl: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Closed trades sorted chronologically: sell date, then exit time, then id. Every caller feeds
 * rows NEWEST-FIRST (`orderBy(desc(sellDate), desc(createdAt), desc(id))` in lib/queries/trades.ts),
 * and a sort on sell date alone is stable, so same-day trades used to run BACKWARDS through the
 * streak and drawdown loops — 42 same-day option trades read "8 wins · best 11W" for a book whose
 * entry order says 7 wins · best 10W (2026-09-17). Rows without the tiebreak fields keep input order.
 */
export function closedSorted<T extends AnalyticsTrade>(trades: T[]): T[] {
  return trades
    .filter((t) => !t.isOpen)
    .slice()
    .sort(
      (a, b) =>
        (a.sellDate ?? "").localeCompare(b.sellDate ?? "") ||
        (a.exitTime ?? "").localeCompare(b.exitTime ?? "") ||
        (a.id ?? 0) - (b.id ?? 0),
    );
}

export function computeKpis(trades: AnalyticsTrade[]): Kpis {
  const closed = closedSorted(trades);
  const openCount = trades.filter((t) => t.isOpen).length;

  let netPnl = 0, grossPnl = 0, charges = 0;
  let wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let rSum = 0, rCount = 0;
  let unpricedCount = 0, unpricedNetPnl = 0;
  for (const t of closed) {
    // Cash always counts — the money moved whether or not we know the basis.
    netPnl += t.netPnl;
    grossPnl += t.grossPnl;
    charges += t.chargesTotal;

    if (!edgeMeasurable(t)) {
      unpricedCount++;
      unpricedNetPnl += t.netPnl;
      continue;
    }

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
  /**
   * Denominator for the RATIOS: closed trades whose edge can actually be
   * measured. Dividing by every closed trade while the numerator skips the
   * unpriced ones would swap one distortion for its mirror image — an
   * understated win rate instead of an overstated one.
   */
  const pricedCount = closedCount - unpricedCount;
  const pricedNetPnl = netPnl - unpricedNetPnl;
  const winnersNet = r2(sumWin);
  const losersNet = r2(sumLoss);

  return {
    count: trades.length,
    closedCount,
    openCount,
    netPnl: r2(netPnl),
    grossPnl: r2(grossPnl),
    charges: r2(charges),
    chargePctOfGross: grossPnl !== 0 ? r2((charges / Math.abs(grossPnl)) * 100) : null,
    wins,
    losses,
    winRate: pricedCount ? wins / pricedCount : null,
    profitFactor: losersNet !== 0 ? r2(winnersNet / Math.abs(losersNet)) : winnersNet > 0 ? Infinity : 0,
    winnersNet,
    losersNet,
    expectancy: pricedCount ? r2(pricedNetPnl / pricedCount) : null,
    avgR: rCount ? r2(rSum / rCount) : null,
    avgWin: wins ? r2(sumWin / wins) : null,
    avgLoss: losses ? r2(sumLoss / losses) : null,
    maxDrawdown: r2(Math.abs(maxDd)),
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss,
    currentStreak: cur,
    unpricedCount,
    unpricedNetPnl: r2(unpricedNetPnl),
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
  /**
   * Every closed trade in the group — the hygiene count the "Trades" column
   * shows. NOT the denominator of any ratio below.
   */
  count: number;
  net: number;
  gross: number;
  charges: number;
  /** Winners among the PRICED trades only (the `computeKpis` numerator rule). */
  wins: number;
  /** Closed trades whose edge can be measured — the ratio denominator. */
  pricedCount: number;
  /** Their net P&L — the numerator of this group's expectancy. */
  pricedNet: number;
  /** null when `pricedCount` is 0: a rate over nothing is not a rate (invariant 6). */
  winRate: number | null;
  avgR: number | null;
  /** Σ net of the priced winners / losers (after charges) — `Kpis`' own sums, per group. */
  winnersNet: number;
  losersNet: number;
  /** `edgeRatios` — null when the group has no loser (PF) / lacks a winner or a loser (payoff). */
  profitFactor: number | null;
  payoff: number | null;
}

export interface EdgeRatios {
  /** r2(winnersNet ÷ |losersNet|); null when there is no loser to divide by —
   *  which includes "nothing priced". The `LensEdge` convention: Kpis' Infinity
   *  reads as null here. UI: "no losing trade yet". */
  profitFactor: number | null;
  /** avgWin ÷ |avgLoss| (both r2, as `Kpis` states them), r4; null unless both exist. */
  payoff: number | null;
}

/**
 * THE per-group profit factor and payoff (v4.4.0 D6). `groupBy`, `segmentDepth`
 * and `winLossReport` all call this, so a segment's PF on the dashboard table,
 * the edge depth card and the Winners-vs-losers tab is one number.
 */
export function edgeRatios(x: { wins: number; losses: number; winnersNet: number; losersNet: number }): EdgeRatios {
  const profitFactor = x.losses > 0 && x.losersNet !== 0 ? r2(x.winnersNet / Math.abs(x.losersNet)) : null;
  const avgWin = x.wins > 0 ? r2(x.winnersNet / x.wins) : null;
  const avgLoss = x.losses > 0 ? r2(x.losersNet / x.losses) : null;
  const payoff = avgWin != null && avgLoss != null && avgLoss !== 0 ? r4(avgWin / Math.abs(avgLoss)) : null;
  return { profitFactor, payoff };
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
    let pricedCount = 0, pricedNet = 0, losses = 0, sumWin = 0, sumLoss = 0;
    for (const t of list) {
      // Cash always counts — the money moved whether or not we know the basis.
      net += t.netPnl; gross += t.grossPnl; charges += t.chargesTotal;
      // …and the ratios below skip it, exactly as computeKpis does above. A
      // group's win rate divided by every closed trade while the numerator
      // skipped the unpriced ones printed one rate here and another on the
      // dashboard for the same book.
      if (!edgeMeasurable(t)) continue;
      pricedCount++; pricedNet += t.netPnl;
      if (t.netPnl > 0) { wins++; sumWin += t.netPnl; }
      else if (t.netPnl < 0) { losses++; sumLoss += t.netPnl; }
      if (t.rMultiple != null) { rSum += t.rMultiple; rCount++; }
    }
    out.push({
      key,
      count: list.length,
      net: r2(net),
      gross: r2(gross),
      charges: r2(charges),
      wins,
      pricedCount,
      pricedNet: r2(pricedNet),
      winRate: pricedCount ? wins / pricedCount : null,
      avgR: rCount ? r2(rSum / rCount) : null,
      winnersNet: r2(sumWin),
      losersNet: r2(sumLoss),
      ...edgeRatios({ wins, losses, winnersNet: r2(sumWin), losersNet: r2(sumLoss) }),
    });
  }
  return out.sort((a, b) => b.net - a.net);
}

export const bySegment = (t: AnalyticsTrade[]) => groupBy(t, (x) => x.segment);
export const bySetup = (t: AnalyticsTrade[]) => groupBy(t, (x) => x.setupTag || "(untagged)");
export const byBroker = (t: AnalyticsTrade[]) => groupBy(t, (x) => x.broker);
