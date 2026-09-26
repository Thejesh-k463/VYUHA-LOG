// THE SIGNAL BOOK's three analytics blocks (PURE, no DB/React — invariant 2).
//
// Every figure here is computed from what the TRADE ITSELF recorded: the levels
// in its own stored envelope and its own fills. Nothing is judged against a
// house ladder, a model average or a counterfactual — the owner's ruling is
// that adherence is measured on each trade's OWN recorded levels, because the
// seeded log's ladder (+50/+100/−35) and the form's prefill (+30/+60/−25) are
// two different rule sets living in one book.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
//
// No scanner, no zone engine, no alerting: v4.3.0 records a signal, it does not
// produce one (owner ruling; docs/DECISIONS.md 2026-09-18). No network host and
// no chart — the screen is tables.
//
// ── THE DAY-RANGE CAVEAT ────────────────────────────────────────────────────
//
// `dayHigh` / `dayLow` are the WHOLE SESSION's range for the contract, not the
// range since entry. So "the day high reached T1" may describe a move that
// happened BEFORE the position existed. That is a limit of the recorded data,
// not something the code can correct, so it is stated on screen beside blocks A
// and C — and `TARGET_REACHED_NOT_TAKEN` is reported in `byCode` but kept OUT
// of `deviating`, where it would attribute a rupee figure to a rule-break that
// cannot be known (design review 4a).

import { sideOf } from "@/lib/analytics/rom";
import { normalizeDate } from "@/lib/domain/trading-day";
import type { SignalExitStatus, TradeSignal } from "@/lib/domain/signal";

/** One closed-or-open signal trade, as the analytics read it. */
export interface SignalTradeRow {
  id: number;
  symbol: string;
  tradingsymbol: string;
  strike: number | null;
  optionType: string | null;
  lotSize: number | null;
  buyQty: number;
  sellQty: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  buyDate: string | null;
  sellDate: string | null;
  isOpen: boolean;
  netPnl: number;
  /** v4.6.0 fix wave (SEAM-V46-1) — REQUIRED: which side opened a FLAT row, and
   *  the note a pre-W6 intraday short carries (a restored pre-W6 Trash row keeps
   *  it). Without them a same-day covered short read LONG and was judged as a
   *  long's exit. */
  side: string | null;
  importNotes: string | null;
  signal: TradeSignal;
}

/**
 * How far an exit may sit from the level it claims and still be adherent: 2% of
 * the level, with a ₹0.05 floor so a 60-paise option is not judged on a
 * two-paise band.
 *
 * A DECISION, NOT A MEASUREMENT — there are no live (non-seeded) exits to
 * measure against yet. Recorded in docs/DECISIONS.md 2026-09-18 and printed on
 * screen beside block A, so the number is never silently in force.
 */
export const ADHERENCE_TOL_PCT = 2;

export function adherenceTolerance(level: number): number {
  return Math.max(0.05, Math.abs(level) * (ADHERENCE_TOL_PCT / 100));
}

export const ADHERENCE_CODES = ["EXIT_OFF_STATUS", "SL_NOT_HONOURED", "HELD_OVERNIGHT", "TARGET_REACHED_NOT_TAKEN"] as const;
export type AdherenceCode = (typeof ADHERENCE_CODES)[number];

export const ADHERENCE_LABELS: Record<AdherenceCode, string> = {
  EXIT_OFF_STATUS: "exit away from the level the status claims",
  SL_NOT_HONOURED: "exited below the recorded SL",
  HELD_OVERNIGHT: "held past the day it was entered",
  // 4a: named for what it can actually prove, and excluded from `deviating`.
  TARGET_REACHED_NOT_TAKEN: "day high ≥ T1 (may precede entry)",
};

/** Codes that count as a DEVIATION with money attached. */
const DEVIATION_CODES: readonly AdherenceCode[] = ["EXIT_OFF_STATUS", "SL_NOT_HONOURED", "HELD_OVERNIGHT"];

export interface CodeTally {
  code: AdherenceCode;
  n: number;
  netPnl: number;
}

export interface RuleAdherence {
  /** Closed long signal trades whose exit-status check could run. */
  judged: number;
  /** Closed long signal trades missing the status, or the level a check needs. */
  notJudgeable: number;
  /** Closed SHORT signal trades — listed in the table, out of this block. */
  excludedShort: number;
  /** Trades carrying at least one DEVIATION code, each counted once. */
  deviating: { n: number; netPnl: number };
  byCode: CodeTally[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

/**
 * Long or short, asked of the DAY each date states.
 *
 * `sideOf` compares the two dates with `new Date()`, which reads a 4.2.x-era
 * '11-06-2026' as 6 November — so a same-day trade stored day-first read as a
 * SHORT and silently left blocks A and C. One fold, the repo's own
 * (`normalizeDate`, D4/wave 2P).
 */
function signalSide(t: SignalTradeRow): "long" | "short" {
  return sideOf({ buyQty: t.buyQty, sellQty: t.sellQty, buyDate: normalizeDate(t.buyDate), sellDate: normalizeDate(t.sellDate), side: t.side, importNotes: t.importNotes });
}

/** Closed rows only — an open position has no exit to judge. */
const closedOf = (rows: readonly SignalTradeRow[]) => rows.filter((t) => !t.isOpen);

/**
 * (A) RULE ADHERENCE — did the exit match the rule the trade says it followed?
 *
 * One trade can carry more than one code, and is counted ONCE in `deviating`
 * however many it carries. A trade that cannot be judged is `notJudgeable` and
 * never a pass (invariant 6: a blank is not a zero).
 */
export function ruleAdherence(rows: readonly SignalTradeRow[]): RuleAdherence {
  const closed = closedOf(rows);
  const longs = closed.filter((t) => signalSide(t) === "long");
  const out: RuleAdherence = {
    judged: 0,
    notJudgeable: 0,
    excludedShort: closed.length - longs.length,
    deviating: { n: 0, netPnl: 0 },
    byCode: [],
  };
  const tally = new Map<AdherenceCode, { n: number; netPnl: number }>();

  for (const t of longs) {
    const s = t.signal;
    const entry = t.avgBuyPrice;
    const exit = t.avgSellPrice;
    const status = s.exitStatus;

    // Can the exit-status check run at all? Missing status, or missing the level
    // that status names, makes the whole trade unjudgeable rather than adherent.
    const levelFor: Partial<Record<SignalExitStatus, number | null>> = {
      T1_HIT: s.t1,
      // The scale-out ruling: T2 is a partial, so the expected exit is the
      // blended (T1 + T2) / 2, not T2.
      T2_HIT: s.t1 != null && s.t2 != null ? (s.t1 + s.t2) / 2 : null,
      SL_HIT: s.sl,
    };
    const needsLevel = status === "T1_HIT" || status === "T2_HIT" || status === "SL_HIT";
    const expected = needsLevel ? levelFor[status] ?? null : null;
    if (status == null || !(entry > 0) || !(exit > 0) || (needsLevel && expected == null)) {
      out.notJudgeable++;
      continue;
    }
    out.judged++;

    const codes: AdherenceCode[] = [];
    if (needsLevel) {
      if (Math.abs(exit - expected!) > adherenceTolerance(expected!)) codes.push("EXIT_OFF_STATUS");
    } else if ((status === "EOD_PROFIT" && exit <= entry) || (status === "EOD_LOSS" && exit > entry)) {
      codes.push("EXIT_OFF_STATUS");
    }
    if (s.sl != null && exit < s.sl - adherenceTolerance(s.sl)) codes.push("SL_NOT_HONOURED");
    const buyDay = normalizeDate(t.buyDate);
    const sellDay = normalizeDate(t.sellDate);
    if (buyDay != null && sellDay != null && buyDay !== sellDay) codes.push("HELD_OVERNIGHT");
    if (
      s.dayHigh != null &&
      s.t1 != null &&
      s.dayHigh >= s.t1 &&
      (status === "EOD_PROFIT" || status === "EOD_LOSS") &&
      exit < s.t1 - adherenceTolerance(s.t1)
    ) {
      codes.push("TARGET_REACHED_NOT_TAKEN");
    }

    for (const c of codes) {
      const cur = tally.get(c) ?? { n: 0, netPnl: 0 };
      tally.set(c, { n: cur.n + 1, netPnl: r2(cur.netPnl + t.netPnl) });
    }
    if (codes.some((c) => DEVIATION_CODES.includes(c))) {
      out.deviating.n++;
      out.deviating.netPnl = r2(out.deviating.netPnl + t.netPnl);
    }
  }

  out.byCode = ADHERENCE_CODES.filter((c) => tally.has(c)).map((c) => ({ code: c, ...tally.get(c)! }));
  return out;
}

/* ───────────────────────────────── (B) edge ───────────────────────────────── */

export interface EdgeGroup {
  key: string;
  model: string;
  optionType: string;
  exitStatus: string;
  n: number;
  /** Share of the group with net P&L > 0, 0–1. */
  winRate: number;
  /** Mean net P&L, in rupees. */
  expectancy: number;
  /**
   * Mean of netPnl ÷ ((entry − SL) × qty) over the rows that carry an SL below
   * their entry. THIS IS NOT the stored `rMultiple`, which divides by
   * `riskAmount` — the two agree on the seeded rows (where slPlanned = sl) and
   * diverge on any form-entered trade, so the column is headed "R on signal SL"
   * and never "R" (design review 4b).
   */
  avgR: number | null;
  /** How many of the `n` rows that mean was taken over — stated, never hidden. */
  rN: number;
}

/**
 * (B) EDGE — model × direction × exit status.
 *
 * "—" is what NEVER RECORDED looks like, in every one of the three keys: a
 * group labelled "—" is not a bucket called "other", it is the set of trades
 * that have not been labelled yet (the 42 seeded rows, until the owner assigns
 * S1/S2 to them).
 */
export function edgeByGroup(rows: readonly SignalTradeRow[]): EdgeGroup[] {
  const groups = new Map<string, SignalTradeRow[]>();
  for (const t of closedOf(rows)) {
    const key = `${t.signal.model ?? "—"}|${t.optionType ?? "—"}|${t.signal.exitStatus ?? "—"}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  const out: EdgeGroup[] = [];
  for (const [key, list] of groups) {
    const [model, optionType, exitStatus] = key.split("|");
    const rs: number[] = [];
    for (const t of list) {
      const qty = Math.max(t.buyQty, t.sellQty);
      const sl = t.signal.sl;
      if (sl == null || !(t.avgBuyPrice > sl) || !(qty > 0)) continue;
      rs.push(t.netPnl / ((t.avgBuyPrice - sl) * qty));
    }
    out.push({
      key,
      model,
      optionType,
      exitStatus,
      n: list.length,
      winRate: r4(list.filter((t) => t.netPnl > 0).length / list.length),
      expectancy: r2(list.reduce((s, t) => s + t.netPnl, 0) / list.length),
      // Never substituted with `riskAmount`: a group with no recorded SL has no
      // R, and "—" is the honest cell (invariant 6).
      avgR: rs.length ? r2(rs.reduce((s, x) => s + x, 0) / rs.length) : null,
      rN: rs.length,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/* ──────────────────────────────── (C) ladder ──────────────────────────────── */

export interface LadderStats {
  /** Rows whose recorded day range actually contains their entry. */
  eligible: number;
  /** Closed LONG signal trades — the denominator `eligible` is "of". */
  total: number;
  excludedShort: number;
  reachT1: { n: number; of: number };
  reachT2: { n: number; of: number };
  touchSl: { n: number; of: number };
  /** Mean (dayHigh − entry) / entry over the eligible rows, as a FRACTION. */
  mfePct: number | null;
  /** Mean (dayLow − entry) / entry over the eligible rows, as a FRACTION. */
  maePct: number | null;
}

/**
 * (C) LADDER — how often the day's recorded range reached each level.
 *
 * A row whose H/L contradicts itself, or does not contain its own entry, is
 * EXCLUDED rather than clamped: it is a note someone mistyped, and a clamp would
 * silently invent a range. The screen prints "n of m" for each level and the
 * day-range caveat beside it.
 */
export function ladderStats(rows: readonly SignalTradeRow[]): LadderStats {
  const closed = closedOf(rows);
  const longs = closed.filter((t) => signalSide(t) === "long");
  const eligible = longs.filter((t) => {
    const { dayHigh, dayLow } = t.signal;
    const entry = t.avgBuyPrice;
    return dayHigh != null && dayLow != null && dayLow <= dayHigh && entry > 0 && dayLow <= entry && entry <= dayHigh;
  });

  const count = (level: (s: TradeSignal) => number | null, hit: (t: SignalTradeRow, x: number) => boolean) => {
    const carrying = eligible.filter((t) => level(t.signal) != null);
    return { n: carrying.filter((t) => hit(t, level(t.signal)!)).length, of: carrying.length };
  };
  const mean = (f: (t: SignalTradeRow) => number) =>
    eligible.length ? eligible.reduce((s, t) => s + f(t), 0) / eligible.length : null;

  return {
    eligible: eligible.length,
    total: longs.length,
    excludedShort: closed.length - longs.length,
    reachT1: count((s) => s.t1, (t, x) => t.signal.dayHigh! >= x),
    reachT2: count((s) => s.t2, (t, x) => t.signal.dayHigh! >= x),
    touchSl: count((s) => s.sl, (t, x) => t.signal.dayLow! <= x),
    mfePct: mean((t) => (t.signal.dayHigh! - t.avgBuyPrice) / t.avgBuyPrice),
    maePct: mean((t) => (t.signal.dayLow! - t.avgBuyPrice) / t.avgBuyPrice),
  };
}

/* ───────────────────────────────── gating ───────────────────────────────── */

export interface SignalAnalytics {
  adherence: RuleAdherence;
  edge: EdgeGroup[];
  ladder: LadderStats;
}

/**
 * THE WITHHOLDING HAPPENS BEFORE THE PAYLOAD (app/live/page.tsx, and
 * app/strategies/page.tsx's own `withholdForFree`, are the precedents).
 *
 * The three blocks are the Pro capability; the signal ENTRY and the plain table
 * of recorded option data are the user's own record and stay free (invariant 7).
 * Returning null — rather than computing the blocks and hiding them in the
 * client — is what makes the lock real: a locked panel on screen hides nothing
 * at all if the figures are sitting in the RSC flight payload behind it.
 */
export function withholdSignalAnalytics(rows: readonly SignalTradeRow[], pro: boolean): SignalAnalytics | null {
  if (!pro) return null;
  return { adherence: ruleAdherence(rows), edge: edgeByGroup(rows), ladder: ladderStats(rows) };
}
