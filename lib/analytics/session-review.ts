export interface SessionPlanInput {
  sessionDate: string;
  plannedSymbols: string[];
  plannedPlaybookIds: number[];
  maxTrades: number | null;
  maxLoss: number | null;
  cutoffTime: string | null;
}

export interface SessionTradeInput {
  id: number;
  symbol: string;
  playbookId: number | null;
  entryDate: string | null;
  entryTime: string | null;
  netPnl: number;
}

export interface SessionReview {
  tradeCount: number;
  netPnl: number;
  offPlanSymbols: string[];
  offPlanPlaybooks: number;
  /** Entries on the session date that breached the cutoff — counted over TIMED trades only. */
  afterCutoff: number;
  /** Trades on the session date with no entry time: neither compliant nor a breach. */
  untimed: number;
  /**
   * Coverage sentence for the cutoff check, or null when every trade is
   * timed (or no cutoff was planned). Also pushed into `findings`, so any
   * consumer that lists findings renders it without further wiring.
   */
  coverage: string | null;
  maxTradesBreached: boolean;
  maxLossBreached: boolean;
  adherencePct: number;
  findings: string[];
}

/**
 * Compare a plan with the recorded day. PURE — the optional `aliasMap`
 * (alias → canonical ticker, both upper) is passed IN by the query layer so
 * this module stays DB-free. Both sides of the watchlist comparison resolve
 * through it: a position stored under a broker's full name must not be
 * convicted as "off-watchlist" when its canonical ticker was planned (that
 * exact false conviction shipped before the map existed).
 */
export function reviewSession(plan: SessionPlanInput, trades: SessionTradeInput[], aliasMap?: Map<string, string>): SessionReview {
  const canon = (s: string): string => {
    const up = s.trim().toUpperCase();
    return aliasMap?.get(up) ?? up;
  };
  const actual = trades.filter((t) => t.entryDate === plan.sessionDate);
  const allowedSymbols = new Set(plan.plannedSymbols.map(canon).filter(Boolean));
  const allowedPlaybooks = new Set(plan.plannedPlaybookIds);
  const offPlanSymbols = [...new Set(actual.filter((t) => allowedSymbols.size > 0 && !allowedSymbols.has(canon(t.symbol))).map((t) => t.symbol))];
  const offPlanPlaybooks = actual.filter((t) => allowedPlaybooks.size > 0 && (t.playbookId == null || !allowedPlaybooks.has(t.playbookId))).length;
  // A null entry time is NOT compliance: it is a trade the cutoff check
  // cannot see. Count it separately so the verdict states its own coverage.
  const untimed = actual.filter((t) => !t.entryTime).length;
  const afterCutoff = actual.filter((t) => plan.cutoffTime && t.entryTime && t.entryTime > plan.cutoffTime).length;
  const coverage = plan.cutoffTime && untimed > 0
    ? `${untimed} of ${actual.length} trade${actual.length === 1 ? " has" : "s have"} no entry time — cutoff check covers ${actual.length - untimed}.`
    : null;
  const netPnl = Math.round(actual.reduce((s, t) => s + t.netPnl, 0) * 100) / 100;
  const maxTradesBreached = plan.maxTrades != null && actual.length > plan.maxTrades;
  const maxLossBreached = plan.maxLoss != null && netPnl < -Math.abs(plan.maxLoss);
  const checks = [offPlanSymbols.length === 0, offPlanPlaybooks === 0, afterCutoff === 0, !maxTradesBreached, !maxLossBreached];
  const adherencePct = Math.round(checks.filter(Boolean).length / checks.length * 100);
  const findings: string[] = [];
  if (offPlanSymbols.length) findings.push(`${offPlanSymbols.join(", ")} traded outside the watchlist.`);
  if (offPlanPlaybooks) findings.push(`${offPlanPlaybooks} trade${offPlanPlaybooks === 1 ? "" : "s"} used an unplanned or untagged playbook.`);
  if (afterCutoff) findings.push(`${afterCutoff} entr${afterCutoff === 1 ? "y was" : "ies were"} placed after the planned cutoff.`);
  if (coverage) findings.push(coverage);
  if (maxTradesBreached) findings.push(`Trade count exceeded the plan by ${actual.length - plan.maxTrades!}.`);
  if (maxLossBreached) findings.push(`Session net crossed the planned loss budget by ₹${Math.round(Math.abs(netPnl) - Math.abs(plan.maxLoss!)).toLocaleString("en-IN")}.`);
  if (!findings.length) findings.push(actual.length ? "The recorded session stayed inside every measurable part of the plan." : "No entries were recorded for this session.");
  return { tradeCount: actual.length, netPnl, offPlanSymbols, offPlanPlaybooks, afterCutoff, untimed, coverage, maxTradesBreached, maxLossBreached, adherencePct, findings };
}
