/**
 * Arjun's Eye — the trader's cockpit.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * Every other report in Vyuha answers "how did my money do". This one answers
 * a different question: **what kind of trader am I, and where does my edge
 * actually come from?** It looks for structural patterns in behaviour rather
 * than totals — when you trade well, what you hold too long, and whether a
 * loss changes how you act next.
 *
 * ── The honesty rules this module keeps ───────────────────────────────────
 *
 * 1. NEVER report a finding below `MIN_SAMPLE` trades. "Tuesdays are your best
 *    day" off four trades is noise dressed as insight, and a journal that says
 *    it once will not be believed again.
 * 2. NEVER invent a session. Time-of-day analysis needs `entryTime`, which
 *    only tradebook imports carry. Trades without it are counted separately
 *    and reported as a coverage gap, not silently bucketed into 09:15.
 * 3. Findings are DESCRIPTIVE. "Your losers are held 3.1x longer than your
 *    winners" is an observation. It is never phrased as "you should".
 */

export const MIN_SAMPLE = 15;

export interface CockpitTrade {
  id: number;
  symbol: string;
  segment: string;
  netPnl: number;
  buyValue: number;
  sellValue: number;
  buyDate: string | null;
  sellDate: string | null;
  entryTime: string | null;
  exitTime: string | null;
  isOpen: boolean;
  rMultiple: number | null;
  /**
   * Set when the stock was acquired outside the imported window, so the
   * purchase price is not in the data (see lib/analytics/acquisition.ts).
   */
  acquisition?: string | null;
  acquisitionPrice?: number | null;
}

/**
 * Whether this trade can contribute to an EDGE statistic.
 *
 * A sale with no purchase on record has `buyValue = 0`, which reads as a 100%
 * win. Arjun's Eye is entirely built from expectancy and win rate, so letting
 * those through would corrupt every panel on the page at once — the session
 * bars, the segment scorecard, the sizing quartiles and the tilt comparison
 * alike. They are dropped here, once, at the entry point.
 */
export function edgeMeasurable(t: CockpitTrade): boolean {
  if (!t.acquisition) return true;
  if (t.buyValue > 0) return true;
  return t.acquisitionPrice != null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Expectancy = average net P&L per trade. The single most honest edge number. */
function expectancy(rows: CockpitTrade[]): number | null {
  if (rows.length === 0) return null;
  return r2(rows.reduce((s, t) => s + t.netPnl, 0) / rows.length);
}

function winRate(rows: CockpitTrade[]): number | null {
  if (rows.length === 0) return null;
  return r2((rows.filter((t) => t.netPnl > 0).length / rows.length) * 100);
}

export interface Bucket {
  key: string;
  label: string;
  trades: number;
  netPnl: number;
  expectancy: number | null;
  winRate: number | null;
  /** True when the sample is too small to draw any conclusion from. */
  thin: boolean;
}

function bucket(key: string, label: string, rows: CockpitTrade[]): Bucket {
  return {
    key,
    label,
    trades: rows.length,
    netPnl: r2(rows.reduce((s, t) => s + t.netPnl, 0)),
    expectancy: expectancy(rows),
    winRate: winRate(rows),
    thin: rows.length < MIN_SAMPLE,
  };
}

// ── Time of day ────────────────────────────────────────────────────────────

/**
 * Indian market sessions, chosen because they behave differently rather than
 * because they divide the clock evenly.
 */
export const SESSIONS: { key: string; label: string; from: string; to: string; note: string }[] = [
  { key: "open", label: "Opening drive", from: "09:15", to: "09:45", note: "overnight gaps resolving" },
  { key: "morning", label: "Morning trend", from: "09:45", to: "11:30", note: "the cleanest trending window" },
  { key: "midday", label: "Midday chop", from: "11:30", to: "14:00", note: "lowest volume, widest noise" },
  { key: "afternoon", label: "Afternoon push", from: "14:00", to: "15:00", note: "positioning for the close" },
  { key: "close", label: "Closing hour", from: "15:00", to: "15:30", note: "squaring off, MIS auto-exits" },
];

/** Which session an HH:MM falls in. Null for anything outside market hours. */
export function sessionOf(time: string | null): string | null {
  if (!time) return null;
  for (const s of SESSIONS) {
    if (time >= s.from && time < s.to) return s.key;
  }
  // 15:30 exactly is the close; anything later is not a market trade.
  return time === "15:30" ? "close" : null;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayOf(date: string | null): number | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getDay();
}

export interface TimeEdge {
  bySession: Bucket[];
  byWeekday: Bucket[];
  /** Closed trades that carry an entry time — the analysable population. */
  withTime: number;
  /** Closed trades missing an entry time, i.e. imported from a P&L file. */
  withoutTime: number;
  /**
   * Timed trades whose entry falls OUTSIDE 09:15–15:30 and so belong to no
   * session. Reported rather than dropped: `bySession` must reconcile against
   * `withTime`, and a pile of off-hours stamps means the broker column was
   * misread, which is exactly the failure worth surfacing.
   */
  offHours: number;
  /** True when there is simply not enough timed data to say anything. */
  insufficient: boolean;
}

export function timeEdge(trades: CockpitTrade[]): TimeEdge {
  const closed = trades.filter((t) => !t.isOpen);
  const timed = closed.filter((t) => !!t.entryTime);

  const bySession = SESSIONS.map((s) =>
    bucket(s.key, s.label, timed.filter((t) => sessionOf(t.entryTime) === s.key)),
  ).filter((b) => b.trades > 0);

  // Weekday works off the exit date, so it functions even for P&L imports —
  // deliberately a wider population than the session analysis.
  //
  // All SEVEN days are built, not just Mon–Fri. NSE does run occasional
  // Saturday live sessions (disaster-recovery drills, and Muhurat has fallen
  // on a Saturday), and a hand-entered trade can carry any date. Weekend
  // buckets are dropped below only when genuinely empty, so the weekday
  // counts always reconcile against the closed-trade total instead of
  // quietly discarding rows that do not fit the expected week.
  const dated = closed.filter((t) => weekdayOf(t.sellDate ?? t.buyDate) != null);
  const byWeekday = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => bucket(String(d), WEEKDAYS[d], dated.filter((t) => weekdayOf(t.sellDate ?? t.buyDate) === d)))
    .filter((b) => b.trades > 0);

  return {
    bySession,
    byWeekday,
    withTime: timed.length,
    withoutTime: closed.length - timed.length,
    offHours: timed.filter((t) => sessionOf(t.entryTime) == null).length,
    insufficient: timed.length < MIN_SAMPLE,
  };
}

// ── Holding period ─────────────────────────────────────────────────────────

export interface HoldingBehaviour {
  avgWinDays: number | null;
  avgLossDays: number | null;
  /** Loss hold ÷ win hold. >1 means losers are held longer than winners. */
  ratio: number | null;
  winners: number;
  losers: number;
  insufficient: boolean;
}

function daysHeld(t: CockpitTrade): number {
  if (!t.buyDate || !t.sellDate) return 1;
  const a = new Date(t.buyDate).getTime();
  const b = new Date(t.sellDate).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 1;
  return Math.max(1, Math.round(Math.abs(b - a) / 86_400_000));
}

/**
 * Cutting winners early while holding losers is the most common structural
 * leak in retail trading, and it is invisible in a P&L total.
 */
export function holdingBehaviour(trades: CockpitTrade[]): HoldingBehaviour {
  const closed = trades.filter((t) => !t.isOpen && t.buyDate && t.sellDate);
  const wins = closed.filter((t) => t.netPnl > 0);
  const losses = closed.filter((t) => t.netPnl < 0);

  const avgWinDays = wins.length ? r2(wins.reduce((s, t) => s + daysHeld(t), 0) / wins.length) : null;
  const avgLossDays = losses.length ? r2(losses.reduce((s, t) => s + daysHeld(t), 0) / losses.length) : null;

  return {
    avgWinDays,
    avgLossDays,
    ratio: avgWinDays && avgLossDays && avgWinDays > 0 ? r2(avgLossDays / avgWinDays) : null,
    winners: wins.length,
    losers: losses.length,
    insufficient: wins.length < MIN_SAMPLE || losses.length < MIN_SAMPLE,
  };
}

// ── Position sizing ────────────────────────────────────────────────────────

export interface SizingBehaviour {
  /** Quartiles of position size (buy value), smallest first. */
  quartiles: Bucket[];
  /** True when bigger positions actually performed better. */
  biggerIsBetter: boolean | null;
  insufficient: boolean;
}

/**
 * Do your larger positions actually earn more? Conviction that is not
 * rewarded is a sizing problem, not a selection problem.
 */
export function sizingBehaviour(trades: CockpitTrade[]): SizingBehaviour {
  const closed = trades
    .filter((t) => !t.isOpen && t.buyValue > 0)
    .sort((a, b) => a.buyValue - b.buyValue);

  if (closed.length < MIN_SAMPLE * 2) {
    return { quartiles: [], biggerIsBetter: null, insufficient: true };
  }

  const q = Math.floor(closed.length / 4);
  const labels = ["Smallest 25%", "2nd quartile", "3rd quartile", "Largest 25%"];
  const quartiles = labels.map((label, i) => {
    const from = i * q;
    const to = i === 3 ? closed.length : (i + 1) * q;
    return bucket(`q${i + 1}`, label, closed.slice(from, to));
  });

  const smallest = quartiles[0].expectancy;
  const largest = quartiles[3].expectancy;

  return {
    quartiles,
    biggerIsBetter: smallest != null && largest != null ? largest > smallest : null,
    insufficient: false,
  };
}

// ── Streaks and tilt ───────────────────────────────────────────────────────

export interface TiltBehaviour {
  afterWin: Bucket;
  afterLoss: Bucket;
  longestWinStreak: number;
  longestLossStreak: number;
  /** Trades on the same day as a loss, i.e. did you immediately re-enter. */
  sameDayReentryAfterLoss: number;
  insufficient: boolean;
}

/**
 * Does a loss change how you trade next? Revenge trading shows up as a worse
 * expectancy immediately after a losing trade, and as same-day re-entries.
 */
export function tiltBehaviour(trades: CockpitTrade[]): TiltBehaviour {
  // Chronological by exit — the order the trader actually experienced.
  const closed = trades
    .filter((t) => !t.isOpen && (t.sellDate ?? t.buyDate))
    .sort((a, b) => {
      const da = `${a.sellDate ?? a.buyDate}${a.exitTime ?? ""}`;
      const db = `${b.sellDate ?? b.buyDate}${b.exitTime ?? ""}`;
      return da.localeCompare(db);
    });

  const afterWin: CockpitTrade[] = [];
  const afterLoss: CockpitTrade[] = [];
  let winStreak = 0, lossStreak = 0, bestWin = 0, bestLoss = 0, sameDay = 0;

  for (let i = 0; i < closed.length; i++) {
    const prev = closed[i - 1];
    if (prev) {
      if (prev.netPnl > 0) afterWin.push(closed[i]);
      else if (prev.netPnl < 0) {
        afterLoss.push(closed[i]);
        const pd = prev.sellDate ?? prev.buyDate;
        const cd = closed[i].sellDate ?? closed[i].buyDate;
        if (pd && cd && pd === cd) sameDay++;
      }
    }
    if (closed[i].netPnl > 0) { winStreak++; lossStreak = 0; bestWin = Math.max(bestWin, winStreak); }
    else if (closed[i].netPnl < 0) { lossStreak++; winStreak = 0; bestLoss = Math.max(bestLoss, lossStreak); }
  }

  return {
    afterWin: bucket("afterWin", "After a win", afterWin),
    afterLoss: bucket("afterLoss", "After a loss", afterLoss),
    longestWinStreak: bestWin,
    longestLossStreak: bestLoss,
    sameDayReentryAfterLoss: sameDay,
    insufficient: afterWin.length < MIN_SAMPLE || afterLoss.length < MIN_SAMPLE,
  };
}

// ── Segment scorecard ──────────────────────────────────────────────────────

export interface SegmentRow extends Bucket {
  charges: number;
  /** Charges as a share of gross — the leak that hides inside a small edge. */
  chargeDragPct: number | null;
  avgDaysHeld: number | null;
}

export function segmentScorecard(
  trades: CockpitTrade[],
  chargesById: Record<number, number>,
  labels: Record<string, string> = {},
): SegmentRow[] {
  const closed = trades.filter((t) => !t.isOpen);
  const bySeg = new Map<string, CockpitTrade[]>();
  for (const t of closed) {
    const arr = bySeg.get(t.segment) ?? [];
    arr.push(t);
    bySeg.set(t.segment, arr);
  }

  return [...bySeg.entries()]
    .map(([seg, rows]) => {
      const b = bucket(seg, labels[seg] ?? seg, rows);
      const charges = r2(rows.reduce((s, t) => s + (chargesById[t.id] ?? 0), 0));
      const gross = rows.reduce((s, t) => s + t.netPnl, 0) + charges;
      return {
        ...b,
        charges,
        // Only meaningful against a positive gross — dividing by a negative
        // gross produces a "drag" figure that reads backwards.
        chargeDragPct: gross > 0 ? r2((charges / gross) * 100) : null,
        avgDaysHeld: rows.length ? r2(rows.reduce((s, t) => s + daysHeld(t), 0) / rows.length) : null,
      };
    })
    .sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity));
}

// ── Findings ───────────────────────────────────────────────────────────────

export type FindingTone = "good" | "warn" | "info";

export interface Finding {
  tone: FindingTone;
  title: string;
  detail: string;
}

/**
 * Turn the analysis into plain statements a trader can act on — every one
 * gated behind MIN_SAMPLE, and every one phrased as an observation rather
 * than an instruction.
 */
export function findings(
  time: TimeEdge,
  hold: HoldingBehaviour,
  sizing: SizingBehaviour,
  tilt: TiltBehaviour,
  segments: SegmentRow[],
): Finding[] {
  const out: Finding[] = [];

  // Best vs worst session.
  const sessions = time.bySession.filter((b) => !b.thin && b.expectancy != null);
  if (sessions.length >= 2) {
    const sorted = [...sessions].sort((a, b) => (b.expectancy ?? 0) - (a.expectancy ?? 0));
    const best = sorted[0], worst = sorted[sorted.length - 1];
    if (best.key !== worst.key && (best.expectancy ?? 0) > (worst.expectancy ?? 0)) {
      out.push({
        tone: "info",
        title: `${best.label} is your strongest window`,
        detail: `₹${Math.round(best.expectancy ?? 0).toLocaleString("en-IN")} per trade across ${best.trades} trades, against ₹${Math.round(worst.expectancy ?? 0).toLocaleString("en-IN")} in the ${worst.label.toLowerCase()} over ${worst.trades}.`,
      });
    }
  }

  // Holding asymmetry.
  if (!hold.insufficient && hold.ratio != null && hold.ratio > 1.5) {
    out.push({
      tone: "warn",
      title: "Losers are held longer than winners",
      detail: `Losing trades average ${hold.avgLossDays} days against ${hold.avgWinDays} for winners — ${hold.ratio}x. Cutting winners early while giving losers room is the most common structural leak in retail trading.`,
    });
  } else if (!hold.insufficient && hold.ratio != null && hold.ratio < 0.8) {
    out.push({
      tone: "good",
      title: "Winners are held longer than losers",
      detail: `Winners average ${hold.avgWinDays} days against ${hold.avgLossDays} for losers. That is the right way round.`,
    });
  }

  // Sizing.
  if (!sizing.insufficient && sizing.biggerIsBetter === false) {
    const sm = sizing.quartiles[0], lg = sizing.quartiles[3];
    out.push({
      tone: "warn",
      title: "Your largest positions are not your best",
      detail: `Biggest quartile: ₹${Math.round(lg.expectancy ?? 0).toLocaleString("en-IN")} per trade. Smallest: ₹${Math.round(sm.expectancy ?? 0).toLocaleString("en-IN")}. Conviction is not being rewarded — that is a sizing question, not a selection one.`,
    });
  }

  // Tilt.
  if (!tilt.insufficient && tilt.afterLoss.expectancy != null && tilt.afterWin.expectancy != null) {
    const gap = tilt.afterWin.expectancy - tilt.afterLoss.expectancy;
    if (gap > 0 && tilt.afterLoss.expectancy < 0) {
      out.push({
        tone: "warn",
        title: "You trade worse immediately after a loss",
        detail: `₹${Math.round(tilt.afterLoss.expectancy).toLocaleString("en-IN")} per trade after a loser, against ₹${Math.round(tilt.afterWin.expectancy).toLocaleString("en-IN")} after a winner${tilt.sameDayReentryAfterLoss > 0 ? `, with ${tilt.sameDayReentryAfterLoss} same-day re-entries` : ""}.`,
      });
    }
  }

  // Segment worth questioning.
  const weak = segments.filter((s) => !s.thin && s.expectancy != null && s.expectancy < 0);
  if (weak.length > 0) {
    const worst = weak[weak.length - 1];
    out.push({
      tone: "warn",
      title: `${worst.label} is losing money`,
      detail: `₹${Math.round(worst.expectancy ?? 0).toLocaleString("en-IN")} per trade over ${worst.trades} trades, ${worst.winRate}% of them winners.`,
    });
  }

  // Charge drag.
  const dragged = segments.filter((s) => !s.thin && s.chargeDragPct != null && s.chargeDragPct > 30);
  for (const s of dragged.slice(0, 1)) {
    out.push({
      tone: "warn",
      title: `Charges eat ${s.chargeDragPct}% of your ${s.label} gross`,
      detail: `₹${Math.round(s.charges).toLocaleString("en-IN")} in costs across ${s.trades} trades. Fewer, larger positions carry the same edge for less friction.`,
    });
  }

  return out;
}

export interface CockpitReport {
  time: TimeEdge;
  holding: HoldingBehaviour;
  sizing: SizingBehaviour;
  tilt: TiltBehaviour;
  segments: SegmentRow[];
  findings: Finding[];
  closedTrades: number;
  /** Trades held out for want of a cost basis — reported, never silent. */
  excludedUnpriced: number;
}

export function cockpitReport(
  tradesIn: CockpitTrade[],
  chargesById: Record<number, number> = {},
  segmentLabels: Record<string, string> = {},
): CockpitReport {
  // Every panel below is an expectancy or a win rate, so unpriced sales are
  // excluded once here rather than defended against five times downstream.
  const trades = tradesIn.filter(edgeMeasurable);
  const excludedUnpriced = tradesIn.length - trades.length;
  const time = timeEdge(trades);
  const holding = holdingBehaviour(trades);
  const sizing = sizingBehaviour(trades);
  const tilt = tiltBehaviour(trades);
  const segments = segmentScorecard(trades, chargesById, segmentLabels);

  return {
    time,
    holding,
    sizing,
    tilt,
    segments,
    findings: findings(time, holding, sizing, tilt, segments),
    closedTrades: trades.filter((t) => !t.isOpen).length,
    excludedUnpriced,
  };
}
