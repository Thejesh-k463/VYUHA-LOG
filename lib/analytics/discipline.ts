// Pure discipline scorecard — per-week adherence to the risk rules.
//
// v3.7 (WS2): the weekly `score` is no longer a private three-part average. It
// DELEGATES to `processScore` (lib/analytics/process-score.ts), so the product
// carries ONE weekly number — the discipline table, the monthly report and the
// Review Desk cannot disagree about the same week. The three legacy percentage
// fields are still populated, now read off the Process Score's own components,
// and they are nullable because a component with nothing to measure says so
// instead of inventing a denominator (invariant 6). `breachReport` is unrelated
// and untouched.
//
// The ISO-week bucketer that used to live here is now `lib/analytics/week.ts`,
// shared with the Process Score and `weekly_reviews.week_start`.

import {
  processScoreByWeek,
  type ProcessComponent,
  type ProcessRefusal,
  type ProcessTrade,
} from "./process-score";

export interface DisciplineTrade {
  sellDate: string | null;
  netPnl: number;
  riskAmount: number | null;
  slPlanned: number | null;
  targetPlanned: number | null;
  isOpen: boolean;
  /** v3.7 Process Score inputs. Optional so pre-3.7 callers still compile; an
   *  absent field reads as "not recorded", never as a pass. */
  playbookId?: number | null;
  ruleViolations?: string[] | null;
  reviewedAt?: string | null;
}

export interface WeekScore {
  week: string; // ISO year-week label e.g. 2026-W23
  weekStart: string; // YYYY-MM-DD (Monday)
  trades: number;
  riskCapRespectedPct: number | null; // losses within the risk actually taken
  dailyStopRespectedPct: number | null; // days that stayed within the daily stop
  planningPct: number | null; // trades with SL/target recorded
  /**
   * LEGACY. The Process Score for the week, and **0 when the week refused to
   * score** — kept a bare `number` only so `/reports/discipline` and the
   * monthly report (Wave 3's files) keep compiling. Read `processScore` with
   * `refusal` for the honest pair; averaging this field drags a refused week
   * toward zero.
   */
  score: number;
  /** The Process Score, or null when the week is under floor / unmeasurable. */
  processScore: number | null;
  /** The five components behind the score — always present, floor or no floor. */
  components: ProcessComponent[];
  /** Why the week did not score. Null whenever `processScore` is a number. */
  refusal: ProcessRefusal | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

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

/** A discipline row read as Process Score input. Absent = not recorded. */
function asProcessTrade(t: DisciplineTrade): ProcessTrade {
  return {
    sellDate: t.sellDate,
    netPnl: t.netPnl,
    riskAmount: t.riskAmount,
    slPlanned: t.slPlanned,
    targetPlanned: t.targetPlanned,
    isOpen: t.isOpen,
    playbookId: t.playbookId ?? null,
    ruleViolations: t.ruleViolations ?? null,
    reviewedAt: t.reviewedAt ?? null,
  };
}

/**
 * Weekly discipline rows, oldest first. The score IS the Process Score for that
 * week: same bucketer, same five components, same sample floor. `perTradeCap`
 * and `dailyStop` accept null — a limit the user never set makes its component
 * refuse rather than score against an invented number.
 */
export function disciplineByWeek(
  trades: DisciplineTrade[],
  perTradeCap: number | null,
  dailyStop: number | null,
  floor?: number,
): WeekScore[] {
  const weeks = processScoreByWeek(trades.map(asProcessTrade), { perTradeCap, dailyStop, floor });
  return weeks.map((w) => {
    const pctOf = (id: ProcessComponent["id"]) => w.components.find((c) => c.id === id)?.pct ?? null;
    return {
      week: w.week,
      weekStart: w.weekStart,
      trades: w.trades,
      riskCapRespectedPct: pctOf("risk-cap"),
      dailyStopRespectedPct: pctOf("daily-stop"),
      planningPct: pctOf("planned"),
      score: w.score ?? 0,
      processScore: w.score,
      components: w.components,
      refusal: w.refusal,
    };
  });
}
