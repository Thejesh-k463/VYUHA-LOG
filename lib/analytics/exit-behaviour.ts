/**
 * WHAT HAPPENS AT THE EXIT — four analytics built from columns the journal has
 * always captured and never read.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Why these four ────────────────────────────────────────────────────────
 *
 * A schema audit (2026-08-30) cross-referenced every column against every read
 * in `lib/queries/` and `lib/analytics/`. Eighteen fields were captured on every
 * trade and analysed nowhere. Four of them are about the EXIT — the half of the
 * decision the journal recorded and never asked about:
 *
 *   `exitTime`          read ONLY as a chronological tiebreak in tiltBehaviour.
 *                       `entryTime` gets a full session-band edge analysis; the
 *                       exit side got nothing.
 *   `buyOrderCount` /
 *   `sellOrderCount`    read ONLY as charge inputs, because brokerage is per
 *                       executed order. Never as behaviour, though fills-per-
 *                       position is a direct measure of hesitation.
 *   `exitTrigger`       new in migration 0051 — WHY the trade was closed.
 *   audit-log stop edits are handled separately (`stop-migration.ts`).
 *
 * Every function here EXCLUDES rows that lack the field rather than bucketing
 * them as "unknown" and quietly changing the denominator (invariant 6), and
 * every one reports how many it excluded so the screen can say so.
 */

import { SESSIONS, sessionOf } from "./cockpit";

export interface ExitTrade {
  netPnl: number;
  grossPnl: number;
  buyValue: number;
  isOpen: boolean;
  entryTime?: string | null;
  exitTime?: string | null;
  exitTrigger?: string | null;
  buyOrderCount?: number | null;
  sellOrderCount?: number | null;
  /** Fraction of the favourable excursion the exit captured, from mae-mfe.ts. */
  capturedPct?: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** "HH:MM" from "HH:MM:SS" or "HH:MM", for sessionOf's string comparison. */
function hhmm(t: string | null | undefined): string | null {
  const m = minutesOfDay(t);
  if (m == null) return null;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Minutes past midnight from "HH:MM" or "HH:MM:SS". Null when unreadable. */
export function minutesOfDay(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

export interface BucketStat {
  key: string;
  count: number;
  net: number;
  wins: number;
  winRate: number;
  expectancy: number;
}

function statOf(key: string, rows: ExitTrade[]): BucketStat {
  const count = rows.length;
  const net = r2(rows.reduce((s, t) => s + t.netPnl, 0));
  const wins = rows.filter((t) => t.netPnl > 0).length;
  return {
    key,
    count,
    net,
    wins,
    winRate: count ? wins / count : 0,
    expectancy: count ? r2(net / count) : 0,
  };
}

export interface ExitClockReport {
  /** Edge by the market session the position was EXITED in. */
  bands: BucketStat[];
  /** Trades with a usable exit time inside market hours. */
  withTime: number;
  /** Closed trades whose exit time the file never carried — excluded, not guessed. */
  withoutTime: number;
  /**
   * Timed exits that fall OUTSIDE the SESSIONS span and so belong to no session.
   * Reported rather than dropped, exactly as cockpit.ts does for entries, so
   * the bands reconcile against the total.
   */
  offHours: number;
}

/**
 * THE EXIT CLOCK — edge by the session band a position was closed in.
 *
 * The mirror of `timeEdge` in cockpit.ts, which buckets ENTRY time and has
 * shipped for months. Exits are where most of the damage is done: a trader with
 * a good entry process and a panicky last-hour habit will see nothing wrong on
 * the entry-side chart.
 */
export function exitClock(trades: ExitTrade[]): ExitClockReport {
  const closed = trades.filter((t) => !t.isOpen);
  const timed = closed.filter((t) => minutesOfDay(t.exitTime) != null);
  // Reuses cockpit.ts's SESSIONS and sessionOf rather than restating the
  // boundaries: two definitions of "the closing hour" would drift apart, and
  // the entry-side and exit-side charts must be directly comparable.
  const bands: BucketStat[] = [];
  for (const s of SESSIONS) {
    const rows = timed.filter((t) => sessionOf(hhmm(t.exitTime)) === s.key);
    if (rows.length > 0) bands.push(statOf(s.label, rows));
  }
  const inSession = timed.filter((t) => sessionOf(hhmm(t.exitTime)) != null).length;
  return {
    bands,
    withTime: timed.length,
    withoutTime: closed.length - timed.length,
    offHours: timed.length - inSession,
  };
}

export interface HoldingClockReport {
  /** Buckets of time-in-trade, for positions with BOTH times on the same day. */
  buckets: BucketStat[];
  measured: number;
  /** Intraday positions missing one of the two times. */
  unmeasurable: number;
}

const HOLD_BUCKETS: { label: string; upToMin: number }[] = [
  { label: "under 5 min", upToMin: 5 },
  { label: "5–30 min", upToMin: 30 },
  { label: "30–120 min", upToMin: 120 },
  { label: "over 2 h", upToMin: Number.POSITIVE_INFINITY },
];

/**
 * TIME IN TRADE, for same-day positions.
 *
 * Only same-day: `entryTime` and `exitTime` are clock times with no date, so
 * subtracting them across days would produce nonsense. A multi-day position's
 * holding period is already covered by `holdingBehaviour` in cockpit.ts, which
 * works in days.
 */
export function holdingClock(trades: ExitTrade[], sameDayOnly: (t: ExitTrade) => boolean): HoldingClockReport {
  const candidates = trades.filter((t) => !t.isOpen && sameDayOnly(t));
  const measured: { t: ExitTrade; mins: number }[] = [];
  for (const t of candidates) {
    const a = minutesOfDay(t.entryTime);
    const b = minutesOfDay(t.exitTime);
    if (a == null || b == null || b < a) continue; // an exit before its entry is unusable
    measured.push({ t, mins: b - a });
  }
  const buckets: BucketStat[] = [];
  let lower = 0;
  for (const b of HOLD_BUCKETS) {
    const rows = measured.filter((m) => m.mins >= lower && m.mins < b.upToMin).map((m) => m.t);
    if (rows.length > 0) buckets.push(statOf(b.label, rows));
    lower = b.upToMin;
  }
  return { buckets, measured: measured.length, unmeasurable: candidates.length - measured.length };
}

export interface FragmentationReport {
  /** Edge by how many executed orders the position took to build and unwind. */
  buckets: BucketStat[];
  /** Median fills per position, a blunt summary of the whole book. */
  medianFills: number | null;
  measured: number;
}

/**
 * ORDER FRAGMENTATION — how many executed orders a position took.
 *
 * `buyOrderCount` and `sellOrderCount` exist because brokerage is charged per
 * executed order, and they have only ever been read as charge inputs. As
 * BEHAVIOUR they measure something else: a position built in eleven fills is
 * usually a trader who could not commit, and every one of those fills paid
 * brokerage. The cost is already in the charges; the habit was invisible.
 */
export function fragmentation(trades: ExitTrade[]): FragmentationReport {
  const rows = trades.filter(
    (t) => !t.isOpen && (t.buyOrderCount ?? 0) > 0 && (t.sellOrderCount ?? 0) > 0,
  );
  const fillsOf = (t: ExitTrade) => (t.buyOrderCount ?? 0) + (t.sellOrderCount ?? 0);
  const buckets: BucketStat[] = [];
  const defs: { label: string; test: (n: number) => boolean }[] = [
    { label: "2 fills (one in, one out)", test: (n) => n <= 2 },
    { label: "3–4 fills", test: (n) => n >= 3 && n <= 4 },
    { label: "5–8 fills", test: (n) => n >= 5 && n <= 8 },
    { label: "9+ fills", test: (n) => n >= 9 },
  ];
  for (const d of defs) {
    const inBucket = rows.filter((t) => d.test(fillsOf(t)));
    if (inBucket.length > 0) buckets.push(statOf(d.label, inBucket));
  }
  const counts = rows.map(fillsOf).sort((a, b) => a - b);
  const medianFills = counts.length
    ? counts.length % 2
      ? counts[(counts.length - 1) / 2]
      : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2
    : null;
  return { buckets, medianFills, measured: rows.length };
}

export interface TriggerRow extends BucketStat {
  /** Mean fraction of the favourable move this exit reason captured. */
  avgCapturedPct: number | null;
  /** How many rows in this bucket had an excursion to measure. */
  capturedFrom: number;
}

export interface TriggerReport {
  rows: TriggerRow[];
  answered: number;
  /** Closed trades with no exit reason recorded — excluded, never bucketed. */
  unanswered: number;
}

/**
 * WHY THE TRADE WAS CLOSED, crossed with how much of the move it caught.
 *
 * This is the payoff for migration 0051, and it needs no new measurement:
 * `capturedPct` already comes out of `lib/analytics/mae-mfe.ts`. Crossing two
 * numbers the product already has produces the sentence a trader can act on —
 * "target exits capture 78% of the move available, panic exits 31%".
 *
 * A trade with no recorded reason is EXCLUDED and counted, never bucketed as
 * "other": an unanswered question is not an answer (invariant 6).
 */
export function exitTriggers(trades: ExitTrade[]): TriggerReport {
  const closed = trades.filter((t) => !t.isOpen);
  const answered = closed.filter((t) => (t.exitTrigger ?? "").trim() !== "");
  const keys = [...new Set(answered.map((t) => t.exitTrigger!.trim()))].sort();
  const rows: TriggerRow[] = keys.map((k) => {
    const bucket = answered.filter((t) => t.exitTrigger!.trim() === k);
    const withCapture = bucket.filter((t) => t.capturedPct != null && Number.isFinite(t.capturedPct));
    return {
      ...statOf(k, bucket),
      avgCapturedPct: withCapture.length
        ? r2(withCapture.reduce((s, t) => s + (t.capturedPct as number), 0) / withCapture.length)
        : null,
      capturedFrom: withCapture.length,
    };
  });
  rows.sort((a, b) => b.count - a.count);
  return { rows, answered: answered.length, unanswered: closed.length - answered.length };
}

/**
 * The curated list the UI offers. Free text is still allowed — a trader's own
 * vocabulary is worth more than a tidy enum — but a default list is what makes
 * the field get filled in at all.
 */
export const EXIT_TRIGGERS = [
  "target hit",
  "stop hit",
  "trailing stop hit",
  "time exit",
  "thesis changed",
  "took profit early",
  "cut early — fear",
  "panic",
  "margin pressure",
  "expiry",
] as const;
