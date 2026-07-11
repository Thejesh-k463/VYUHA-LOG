// Pure discipline scorecard — per-week adherence to the risk rules.

export interface DisciplineTrade {
  sellDate: string | null;
  netPnl: number;
  riskAmount: number | null;
  slPlanned: number | null;
  targetPlanned: number | null;
  isOpen: boolean;
}

export interface WeekScore {
  week: string; // ISO year-week label e.g. 2026-W23
  weekStart: string; // YYYY-MM-DD (Monday)
  trades: number;
  riskCapRespectedPct: number; // losses kept within per-trade cap
  dailyStopRespectedPct: number; // days that stayed within daily stop
  planningPct: number; // trades with SL/target recorded
  score: number; // 0..100 average of the three
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** ISO week (Mon-based) helpers. */
function isoWeek(dateStr: string): { label: string; monday: string } {
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7; // 0=Mon
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  // ISO week number
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const yearStart = new Date(thursday.getFullYear(), 0, 1);
  const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const label = `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}`;
  return { label, monday: monday.toISOString().slice(0, 10) };
}

// --- Entry-time limit breaches (P1.4 follow-up) -----------------------------
// Trades saved despite a warn/block from the pre-trade limits engine carry the
// breached checks in rule_violations as "Label: message" strings. This rolls
// them up so the scorecard shows what overriding the guardrails actually cost.

export interface BreachTrade {
  ruleViolations: string[] | null;
  netPnl: number;
  isOpen: boolean;
}

export interface BreachRuleStat {
  rule: string; // the check label, e.g. "Per-trade risk"
  trades: number; // trades entered with this breach
  closedNet: number; // net P&L of the CLOSED trades among them
}

export interface BreachReport {
  breachedTrades: number; // trades entered with ≥1 breach
  totalBreaches: number;
  openBreached: number; // still-open breached trades
  closedNet: number; // net P&L of closed breached trades
  perRule: BreachRuleStat[]; // worst closedNet first
}

export function breachReport(trades: BreachTrade[]): BreachReport {
  const breached = trades.filter((t) => t.ruleViolations && t.ruleViolations.length > 0);
  const perRule = new Map<string, { trades: number; closedNet: number }>();
  let totalBreaches = 0;
  for (const t of breached) {
    for (const v of t.ruleViolations!) {
      totalBreaches += 1;
      const rule = v.includes(":") ? v.slice(0, v.indexOf(":")).trim() : v.trim();
      const s = perRule.get(rule) ?? { trades: 0, closedNet: 0 };
      s.trades += 1;
      if (!t.isOpen) s.closedNet = r2(s.closedNet + t.netPnl);
      perRule.set(rule, s);
    }
  }
  const closed = breached.filter((t) => !t.isOpen);
  return {
    breachedTrades: breached.length,
    totalBreaches,
    openBreached: breached.length - closed.length,
    closedNet: r2(closed.reduce((s, t) => s + t.netPnl, 0)),
    perRule: [...perRule.entries()]
      .map(([rule, s]) => ({ rule, ...s }))
      .sort((a, b) => a.closedNet - b.closedNet),
  };
}

export function disciplineByWeek(
  trades: DisciplineTrade[],
  perTradeCap: number,
  dailyStop: number,
): WeekScore[] {
  const closed = trades.filter((t) => !t.isOpen && t.sellDate);
  const weeks = new Map<string, { monday: string; list: DisciplineTrade[] }>();
  for (const t of closed) {
    const { label, monday } = isoWeek(t.sellDate!);
    const w = weeks.get(label) ?? { monday, list: [] };
    w.list.push(t);
    weeks.set(label, w);
  }

  const out: WeekScore[] = [];
  for (const [week, { monday, list }] of weeks) {
    const cap = perTradeCap || 9500;
    // risk-cap respected: of losing trades, fraction within the cap
    const losers = list.filter((t) => t.netPnl < 0);
    const capOk = losers.length ? losers.filter((t) => t.netPnl >= -(t.riskAmount ?? cap)).length / losers.length : 1;
    // daily-stop respected: fraction of trading days within the daily stop
    const dayNet = new Map<string, number>();
    for (const t of list) dayNet.set(t.sellDate!, (dayNet.get(t.sellDate!) ?? 0) + t.netPnl);
    const days = [...dayNet.values()];
    const stopOk = days.length ? days.filter((n) => n >= -dailyStop).length / days.length : 1;
    // planning: fraction of trades with SL or target recorded
    const planOk = list.length ? list.filter((t) => t.slPlanned != null || t.targetPlanned != null).length / list.length : 0;

    const score = r2(((capOk + stopOk + planOk) / 3) * 100);
    out.push({
      week,
      weekStart: monday,
      trades: list.length,
      riskCapRespectedPct: r2(capOk * 100),
      dailyStopRespectedPct: r2(stopOk * 100),
      planningPct: r2(planOk * 100),
      score,
    });
  }
  return out.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}
