// The Process Score (PURE — no DB, no React). v3.7 WS1, spec: docs/V370_BUILD_PLAN.md §1.2.
//
// ONE weekly number for how a book was TRADED, as opposed to what it made.
// Five equal-weight components, each carrying its own numerator, denominator
// and coverage so the UI can show the arithmetic instead of a bare number:
//
//   planned         SL or target recorded          / closed trades
//   risk-cap        loss within its own risk       / losing trades
//   daily-stop      day net within the daily stop  / trading days
//   rules-followed  playbook, and no rule broken   / closed trades WITH a playbook
//   reviewed        reviewed_at set                / closed trades
//
// INVARIANT 6 — NEVER FABRICATE A DENOMINATOR. Every component returns
// `pct: null` rather than a number it cannot honestly derive:
//
//  * `risk-cap` refuses when there are no losers to judge, and refuses when a
//    losing trade carries neither its own `riskAmount` nor a configured
//    per-trade cap. The v3.6 code read `cap = perTradeCap || 9500` — a limit no
//    user had set, silently deciding whether their losses were "respected".
//    That fallback is deleted; a component with nothing to measure against says
//    so, and drops out of the mean.
//  * `daily-stop` refuses when no daily stop is configured.
//  * `rules-followed` counts only trades that HAVE a playbook, and its coverage
//    states how many that was ("12 of 40 trades had a playbook").
//  * `reviewed` reads a blank `reviewedAt` as UNREVIEWED. A blank is never
//    bucketed as reviewed.
//
// SAMPLE FLOOR — the score refuses entirely below `floor` closed trades in the
// window (default 10, the minimum the insight contract allows). The components
// are still returned: the arithmetic is visible even when the summary figure is
// withheld, and `refusal.reason` says plainly what was short.
//
// The strings here reach the screen, so they stay DESCRIPTIVE — they state what
// the record holds and never instruct (lib/intelligence/insight.ts).

import { PLAYBOOK_RULE_PREFIX } from "./behavior";
import { isoWeek } from "./week";

/** Default sample floor: closed trades in the window below which the score refuses. */
export const PROCESS_SCORE_FLOOR = 10;

export interface ProcessTrade {
  sellDate: string | null;
  netPnl: number;
  riskAmount: number | null;
  slPlanned: number | null;
  targetPlanned: number | null;
  isOpen: boolean;
  playbookId: number | null;
  ruleViolations: string[] | null;
  reviewedAt: string | null;
}

export interface ProcessScoreConfig {
  /** Per-trade max loss the user configured, in ₹. `null` (or 0) = not set. */
  perTradeCap: number | null;
  /** Daily loss stop the user configured, in ₹. `null` (or 0) = not set. */
  dailyStop: number | null;
  /** Closed trades needed before a score is stated. Default `PROCESS_SCORE_FLOOR`. */
  floor?: number;
}

export type ProcessComponentId = "planned" | "risk-cap" | "daily-stop" | "rules-followed" | "reviewed";

/** What the component could actually read, stated with the claim (insight contract rule 3). */
export interface ProcessCoverage {
  /** Rows the component could judge. */
  have: number;
  /** Rows in the population the reader will assume. */
  of: number;
  /** What was counted — reads as "12 of 40 trades had a playbook". */
  noun: string;
}

export interface ProcessComponent {
  id: ProcessComponentId;
  label: string;
  numerator: number;
  denominator: number;
  /** 0..100, or null where the component has nothing honest to measure. */
  pct: number | null;
  coverage: ProcessCoverage;
}

export interface ProcessRefusal {
  reason: string;
}

export interface ProcessScore {
  /** 0..100, or null when the window is under floor or no component scored. */
  score: number | null;
  /** ALWAYS returned, floor or no floor — the arithmetic behind the number. */
  components: ProcessComponent[];
  /** Closed trades in the window (the floor is measured against this). */
  closedTrades: number;
  floor: number;
  /** Why there is no score. Null whenever `score` is a number. */
  refusal: ProcessRefusal | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number) => (den > 0 ? r2((num / den) * 100) : null);
/** A configured limit of 0 is "not set", not "zero rupees allowed". */
const limitOrNull = (n: number | null | undefined) => (n != null && n > 0 ? n : null);

function component(
  id: ProcessComponentId,
  label: string,
  numerator: number,
  denominator: number,
  value: number | null,
  coverage: ProcessCoverage,
): ProcessComponent {
  return { id, label, numerator, denominator, pct: value, coverage };
}

/** SL or target recorded, over every closed trade in the window. */
function plannedComponent(closed: ProcessTrade[]): ProcessComponent {
  const n = closed.filter((t) => t.slPlanned != null || t.targetPlanned != null).length;
  return component("planned", "SL or target recorded", n, closed.length, pct(n, closed.length), {
    have: closed.length,
    of: closed.length,
    noun: "closed trades in the window",
  });
}

/**
 * A losing trade's loss within the risk it was taken with: its own `riskAmount`
 * where recorded, else the configured per-trade cap. With neither, the trade is
 * unjudgeable and the whole component refuses — the alternative is inventing the
 * limit the user is being measured against.
 */
function riskCapComponent(closed: ProcessTrade[], perTradeCap: number | null): ProcessComponent {
  const losers = closed.filter((t) => t.netPnl < 0);
  const limits = losers.map((t) => limitOrNull(t.riskAmount) ?? perTradeCap);
  const judgeable = limits.filter((l) => l != null).length;
  const respected = losers.filter((t, i) => {
    const limit = limits[i];
    return limit != null && t.netPnl >= -limit;
  }).length;
  const value = losers.length > 0 && judgeable === losers.length ? pct(respected, losers.length) : null;
  return component("risk-cap", "Losses within the risk taken", respected, losers.length, value, {
    have: judgeable,
    of: losers.length,
    noun: "losing trades had a risk limit to measure against",
  });
}

/** Trading days whose net stayed within the configured daily stop. */
function dailyStopComponent(closed: ProcessTrade[], dailyStop: number | null): ProcessComponent {
  const dayNet = new Map<string, number>();
  for (const t of closed) dayNet.set(t.sellDate!, (dayNet.get(t.sellDate!) ?? 0) + t.netPnl);
  const days = [...dayNet.values()];
  const within = dailyStop != null ? days.filter((n) => n >= -dailyStop).length : 0;
  const value = dailyStop != null ? pct(within, days.length) : null;
  return component("daily-stop", "Days within the daily stop", within, days.length, value, {
    have: dailyStop != null ? days.length : 0,
    of: days.length,
    noun: "trading days had a daily stop to measure against",
  });
}

/**
 * A trade traded to a playbook, with no rule from that playbook's checklist
 * broken. The denominator is closed trades WITH a playbook — a trade taken
 * without one has no rules to have followed, so counting it either way would be
 * a verdict on evidence that does not exist.
 */
function rulesFollowedComponent(closed: ProcessTrade[]): ProcessComponent {
  const withPlaybook = closed.filter((t) => t.playbookId != null);
  const followed = withPlaybook.filter(
    (t) => !(t.ruleViolations ?? []).some((v) => v.startsWith(PLAYBOOK_RULE_PREFIX)),
  ).length;
  return component(
    "rules-followed",
    "Playbook rules followed",
    followed,
    withPlaybook.length,
    pct(followed, withPlaybook.length),
    { have: withPlaybook.length, of: closed.length, noun: "trades had a playbook" },
  );
}

/** Reviewed trades. A blank `reviewedAt` is UNREVIEWED, never a silent pass. */
function reviewedComponent(closed: ProcessTrade[]): ProcessComponent {
  const n = closed.filter((t) => t.reviewedAt != null && t.reviewedAt !== "").length;
  return component("reviewed", "Trades reviewed", n, closed.length, pct(n, closed.length), {
    have: closed.length,
    of: closed.length,
    noun: "closed trades in the window",
  });
}

/** Closed trades with a sell date — the only rows any component can read. */
export function closedInWindow(trades: ProcessTrade[]): ProcessTrade[] {
  return trades.filter((t) => !t.isOpen && t.sellDate);
}

/**
 * The Process Score for one window of trades. `components` always comes back;
 * `score` is null (with a stated `refusal`) under the floor or when every
 * component refused.
 */
export function processScore(trades: ProcessTrade[], cfg: ProcessScoreConfig): ProcessScore {
  return scoreWindow(trades, cfg, "in this window");
}

/** `windowPhrase` is how the refusal names the window ("in this window", "this week"). */
function scoreWindow(trades: ProcessTrade[], cfg: ProcessScoreConfig, windowPhrase: string): ProcessScore {
  const closed = closedInWindow(trades);
  const floor = cfg.floor ?? PROCESS_SCORE_FLOOR;
  const perTradeCap = limitOrNull(cfg.perTradeCap);
  const dailyStop = limitOrNull(cfg.dailyStop);

  const components: ProcessComponent[] = [
    plannedComponent(closed),
    riskCapComponent(closed, perTradeCap),
    dailyStopComponent(closed, dailyStop),
    rulesFollowedComponent(closed),
    reviewedComponent(closed),
  ];

  const base = { components, closedTrades: closed.length, floor };

  if (closed.length < floor) {
    const trade = closed.length === 1 ? "closed trade" : "closed trades";
    return {
      ...base,
      score: null,
      refusal: { reason: `${closed.length} ${trade} ${windowPhrase}; the score needs ${floor}` },
    };
  }

  const scored = components.filter((c) => c.pct != null).map((c) => c.pct!);
  if (scored.length === 0) {
    return {
      ...base,
      score: null,
      refusal: { reason: `None of the five components had anything to measure ${windowPhrase}` },
    };
  }
  return {
    ...base,
    score: Math.round(scored.reduce((s, p) => s + p, 0) / scored.length),
    refusal: null,
  };
}

export interface WeekProcessScore extends ProcessScore {
  /** ISO year-week label, e.g. "2026-W23". */
  week: string;
  /** ISO Monday, "YYYY-MM-DD". */
  weekStart: string;
  /** Closed trades in the week — same figure as `closedTrades`, named for tables. */
  trades: number;
}

/**
 * The Process Score per ISO week, oldest first. Buckets through the one week
 * bucketer (`lib/analytics/week.ts`), so a week here is the same week the
 * discipline table and `weekly_reviews.week_start` mean.
 */
export function processScoreByWeek(trades: ProcessTrade[], cfg: ProcessScoreConfig): WeekProcessScore[] {
  const weeks = new Map<string, { monday: string; list: ProcessTrade[] }>();
  for (const t of closedInWindow(trades)) {
    const { label, monday } = isoWeek(t.sellDate!);
    const w = weeks.get(label) ?? { monday, list: [] };
    w.list.push(t);
    weeks.set(label, w);
  }
  return [...weeks.entries()]
    .map(([week, { monday, list }]) => {
      // The window IS the week here, so the refusal names the week.
      const s = scoreWindow(list, cfg, "this week");
      return { ...s, week, weekStart: monday, trades: s.closedTrades };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}
