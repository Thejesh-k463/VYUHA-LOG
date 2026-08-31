/**
 * COCKPIT RULES — Arjun's Eye findings, migrated onto the insight contract.
 *
 * Each row is one finding the cockpit can surface. The six migrated rules keep
 * the original `findings()` thresholds and prose byte-for-byte —
 * tests/cockpit.test.ts pins them, and tests/cockpit-rules.test.ts holds the
 * adapter output equal to a frozen copy of the pre-migration implementation.
 * `findings()` in lib/analytics/cockpit.ts is now a thin adapter over this
 * registry via `toFinding`, so a change here changes the cockpit page.
 *
 * PURE (invariant 2): no DB, no React. Imports from lib/analytics/cockpit are
 * TYPE-ONLY — that module imports THIS one at runtime, so a value import back
 * would evaluate inside the cycle's temporal dead zone. The `15` sample floors
 * below mirror cockpit's MIN_SAMPLE for exactly that reason; the gating itself
 * still lives upstream in the `thin`/`insufficient` flags the input carries.
 */

import type {
  Bucket,
  CockpitTrade,
  Finding,
  HoldingBehaviour,
  SegmentRow,
  SizingBehaviour,
  TiltBehaviour,
  TimeEdge,
} from "@/lib/analytics/cockpit";
import { wilsonInterval, type Interval } from "@/lib/analytics/inference";
import type { Insight, InsightRule } from "@/lib/intelligence/insight";

/** Everything cockpitReport already computes, plus the trade rows the
 *  trade-level rules read. `trades` is the edge-measurable set (see
 *  `edgeMeasurable`); pass `[]` when only aggregates are in hand — the
 *  trade-level rules then refuse rather than fire on a fabricated population. */
export interface CockpitRuleInput {
  time: TimeEdge;
  holding: HoldingBehaviour;
  sizing: SizingBehaviour;
  tilt: TiltBehaviour;
  segments: SegmentRow[];
  trades: CockpitTrade[];
}

/** Insight → the cockpit page's Finding shape. Headline and detail ARE the
 *  original title/detail strings — the migration moved the rules, not the prose. */
export function toFinding(i: Insight): Finding {
  return { tone: i.tone, title: i.headline, detail: i.detail ?? "" };
}

// ── Local helpers (duplicated as literals to keep this module import-clean) ─

const r2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => Math.round(n).toLocaleString("en-IN");

const expectancyOf = (rows: CockpitTrade[]): number | null =>
  rows.length ? r2(rows.reduce((s, t) => s + t.netPnl, 0) / rows.length) : null;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** "62% (CI 51–72%)" — the win-rate-with-Wilson evidence format. */
function fmtRateWithCi(ci: Interval): string {
  return `${Math.round(ci.point * 100)}% (CI ${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)}%)`;
}

/** "HH:MM" (seconds tolerated and ignored) → minutes since midnight. */
function toMinutes(hhmm: string): number | null {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** Chronological by exit — the same ordering tiltBehaviour uses, so "the trade
 *  after a loss" means the same trade on every cockpit surface. */
function sortByExit(rows: CockpitTrade[]): CockpitTrade[] {
  return [...rows].sort((a, b) => {
    const da = `${a.sellDate ?? a.buyDate}${a.exitTime ?? ""}`;
    const db = `${b.sellDate ?? b.buyDate}${b.exitTime ?? ""}`;
    return da.localeCompare(db);
  });
}

// ── New-rule thresholds — DECISIONS.md-worthy, stated here ─────────────────

/**
 * A re-entry inside this many minutes of a loss exit is "fast". 15 minutes is
 * one full NSE candle on the interval most intraday traders watch — inside it
 * the re-entry is a reaction to the loss, not a fresh read of the chart.
 */
export const FAST_REENTRY_MINUTES = 15;

/**
 * Both wings (fast and slower re-entries) need this many trades before
 * fast-vs-rest is a comparison rather than an anecdote about three trades.
 */
const REENTRY_WING_MIN = 5;

/**
 * Median size step-up after a loss that reads as escalation. 25% is past any
 * plausible rounding of lot sizes or price drift between two entries — a jump
 * that large is a decision, not noise.
 */
export const SIZE_ESCALATION_PCT = 25;

// ── Trade-level derivations for the new rules ──────────────────────────────

interface ReentryPair {
  gapMin: number;
  trade: CockpitTrade;
}

/**
 * For every timed loss, the SAME-DAY trade whose entry follows its exit
 * soonest. Both stamps are required — the gap is exit → next entry, and a
 * trade missing either cannot participate (coverage says how many could).
 * `entryTime` is the FIRST fill of an aggregate, so a scale-in measures to its
 * first fill and never manufactures a second "re-entry".
 */
function reentryPairs(trades: CockpitTrade[]): { pairs: ReentryPair[]; timed: number; closed: number } {
  const closed = trades.filter((t) => !t.isOpen);
  const timed = closed.filter((t) => t.entryTime && t.exitTime && t.buyDate && (t.sellDate ?? t.buyDate));
  const pairs: ReentryPair[] = [];
  for (const loss of timed) {
    if (loss.netPnl >= 0) continue;
    const exitDay = loss.sellDate ?? loss.buyDate;
    const exitMin = toMinutes(loss.exitTime as string);
    if (exitMin == null) continue;
    let next: ReentryPair | null = null;
    for (const t of timed) {
      if (t.id === loss.id || t.buyDate !== exitDay) continue;
      const entryMin = toMinutes(t.entryTime as string);
      if (entryMin == null || entryMin < exitMin) continue;
      const gapMin = entryMin - exitMin;
      if (!next || gapMin < next.gapMin) next = { gapMin, trade: t };
    }
    if (next) pairs.push(next);
  }
  return { pairs, timed: timed.length, closed: closed.length };
}

// ── The registry ───────────────────────────────────────────────────────────

export const COCKPIT_RULES: InsightRule<CockpitRuleInput>[] = [
  {
    id: "session-edge",
    watches: "expectancy per market session",
    sampleFloor: 15, // MIN_SAMPLE per session bucket — enforced upstream via `thin`
    compute: ({ time }) => {
      const sessions = time.bySession.filter((b) => !b.thin && b.expectancy != null);
      if (sessions.length < 2) return null;
      const sorted = [...sessions].sort((a, b) => (b.expectancy ?? 0) - (a.expectancy ?? 0));
      const best = sorted[0], worst = sorted[sorted.length - 1];
      if (best.key === worst.key || (best.expectancy ?? 0) <= (worst.expectancy ?? 0)) return null;
      return {
        id: "session-edge",
        tone: "info",
        headline: `${best.label} is your strongest window`,
        detail: `₹${inr(best.expectancy ?? 0)} per trade across ${best.trades} trades, against ₹${inr(worst.expectancy ?? 0)} in the ${worst.label.toLowerCase()} over ${worst.trades}.`,
        evidence: [
          { label: best.label, value: `₹${inr(best.expectancy ?? 0)} / trade over ${best.trades}`, tone: "good" },
          { label: worst.label, value: `₹${inr(worst.expectancy ?? 0)} / trade over ${worst.trades}`, tone: (worst.expectancy ?? 0) < 0 ? "warn" : "info" },
        ],
        sampleSize: best.trades + worst.trades,
        coverage: { have: time.withTime, of: time.withTime + time.withoutTime, noun: "closed trades with an entry time" },
      };
    },
  },
  {
    id: "holding-asymmetry",
    watches: "days held on winners vs losers",
    sampleFloor: 15, // MIN_SAMPLE winners AND losers — enforced upstream via `insufficient`
    compute: ({ holding: hold }) => {
      if (hold.insufficient || hold.ratio == null) return null;
      const base = {
        id: "holding-asymmetry",
        evidence: [
          { label: "winners held", value: `${hold.avgWinDays} days` },
          { label: "losers held", value: `${hold.avgLossDays} days` },
          { label: "loss ÷ win hold", value: `${hold.ratio}x` },
        ],
        sampleSize: hold.winners + hold.losers,
      };
      if (hold.ratio > 1.5) {
        return {
          ...base,
          tone: "warn" as const,
          headline: "Losers are held longer than winners",
          detail: `Losing trades average ${hold.avgLossDays} days against ${hold.avgWinDays} for winners — ${hold.ratio}x. Cutting winners early while giving losers room is the most common structural leak in retail trading.`,
        };
      }
      if (hold.ratio < 0.8) {
        return {
          ...base,
          tone: "good" as const,
          headline: "Winners are held longer than losers",
          detail: `Winners average ${hold.avgWinDays} days against ${hold.avgLossDays} for losers. That is the right way round.`,
        };
      }
      return null;
    },
  },
  {
    id: "sizing-conviction",
    watches: "expectancy across position-size quartiles",
    sampleFloor: 30, // MIN_SAMPLE * 2 — sizingBehaviour refuses to quartile fewer
    compute: ({ sizing }) => {
      if (sizing.insufficient || sizing.biggerIsBetter !== false) return null;
      const sm = sizing.quartiles[0], lg = sizing.quartiles[3];
      return {
        id: "sizing-conviction",
        tone: "warn",
        headline: "Your largest positions are not your best",
        detail: `Biggest quartile: ₹${inr(lg.expectancy ?? 0)} per trade. Smallest: ₹${inr(sm.expectancy ?? 0)}. Conviction is not being rewarded — that is a sizing question, not a selection one.`,
        evidence: [
          { label: "largest 25%", value: `₹${inr(lg.expectancy ?? 0)} / trade`, tone: "warn" },
          { label: "smallest 25%", value: `₹${inr(sm.expectancy ?? 0)} / trade` },
        ],
        sampleSize: sizing.quartiles.reduce((s, q) => s + q.trades, 0),
      };
    },
  },
  {
    id: "tilt-after-loss",
    watches: "expectancy immediately after a loss vs after a win",
    sampleFloor: 15, // MIN_SAMPLE on each side — enforced upstream via `insufficient`
    compute: ({ tilt }) => {
      if (tilt.insufficient || tilt.afterLoss.expectancy == null || tilt.afterWin.expectancy == null) return null;
      const gap = tilt.afterWin.expectancy - tilt.afterLoss.expectancy;
      if (gap <= 0 || tilt.afterLoss.expectancy >= 0) return null;
      return {
        id: "tilt-after-loss",
        tone: "warn",
        headline: "You trade worse immediately after a loss",
        detail: `₹${inr(tilt.afterLoss.expectancy)} per trade after a loser, against ₹${inr(tilt.afterWin.expectancy)} after a winner${tilt.sameDayReentryAfterLoss > 0 ? `, with ${tilt.sameDayReentryAfterLoss} same-day re-entries` : ""}.`,
        evidence: [
          { label: "after a loss", value: `₹${inr(tilt.afterLoss.expectancy)} / trade`, tone: "warn" },
          { label: "after a win", value: `₹${inr(tilt.afterWin.expectancy)} / trade` },
          ...(tilt.sameDayReentryAfterLoss > 0
            ? [{ label: "same-day re-entries after a loss", value: String(tilt.sameDayReentryAfterLoss) }]
            : []),
        ],
        sampleSize: tilt.afterWin.trades + tilt.afterLoss.trades,
      };
    },
  },
  {
    id: "segment-negative-expectancy",
    watches: "segments whose expectancy is negative",
    sampleFloor: 15, // MIN_SAMPLE per segment — enforced upstream via `thin`
    compute: ({ segments }) => {
      const weak = segments.filter((s) => !s.thin && s.expectancy != null && s.expectancy < 0);
      if (weak.length === 0) return null;
      // Segments arrive sorted by expectancy desc, so the last weak one is the worst.
      const worst = weak[weak.length - 1];
      // Recover the win count from the rounded rate — exact for any realistic
      // n, since winRate is wins/n·100 rounded to two decimals.
      const wins = Math.round(((worst.winRate ?? 0) / 100) * worst.trades);
      const ci = wilsonInterval(wins, worst.trades);
      return {
        id: "segment-negative-expectancy",
        tone: "warn",
        headline: `${worst.label} is losing money`,
        detail: `₹${inr(worst.expectancy ?? 0)} per trade over ${worst.trades} trades, ${worst.winRate}% of them winners.`,
        evidence: [
          { label: "expectancy", value: `₹${inr(worst.expectancy ?? 0)} / trade`, tone: "warn" },
          // Win-rate claims carry their Wilson 95% interval (contract rule 4;
          // lib/analytics/inference.ts explains why Wilson, not Wald).
          { label: "win rate", value: fmtRateWithCi(ci) },
        ],
        sampleSize: worst.trades,
      };
    },
  },
  {
    id: "charge-drag",
    watches: "charges as a share of a segment's gross",
    sampleFloor: 15, // MIN_SAMPLE per segment — enforced upstream via `thin`
    compute: ({ segments }) => {
      const dragged = segments.filter((s) => !s.thin && s.chargeDragPct != null && s.chargeDragPct > 30);
      if (dragged.length === 0) return null;
      const s = dragged[0];
      return {
        id: "charge-drag",
        tone: "warn",
        headline: `Charges eat ${s.chargeDragPct}% of your ${s.label} gross`,
        detail: `₹${inr(s.charges)} in costs across ${s.trades} trades. Fewer, larger positions carry the same edge for less friction.`,
        evidence: [
          { label: "charges", value: `₹${inr(s.charges)}`, tone: "warn" },
          { label: "share of gross", value: `${s.chargeDragPct}%` },
        ],
        sampleSize: s.trades,
      };
    },
  },
  {
    id: "revenge-reentry-minutes",
    watches: "how soon a same-day re-entry follows a loss exit, and how it fares",
    sampleFloor: 10, // loss → same-day re-entry pairs, not trades
    compute: ({ trades }) => {
      const { pairs, timed, closed } = reentryPairs(trades);
      if (pairs.length < 10) return null;
      const fast = pairs.filter((p) => p.gapMin < FAST_REENTRY_MINUTES);
      const rest = pairs.filter((p) => p.gapMin >= FAST_REENTRY_MINUTES);
      if (fast.length < REENTRY_WING_MIN || rest.length < REENTRY_WING_MIN) return null;
      const fastExp = expectancyOf(fast.map((p) => p.trade));
      const restExp = expectancyOf(rest.map((p) => p.trade));
      if (fastExp == null || restExp == null) return null;
      // The flag condition: fast re-entries lose money AND the slower ones do better.
      if (fastExp >= 0 || restExp <= fastExp) return null;
      const med = r2(median(pairs.map((p) => p.gapMin)) ?? 0);
      return {
        id: "revenge-reentry-minutes",
        tone: "warn",
        headline: `Re-entries within ${FAST_REENTRY_MINUTES} minutes of a loss carry negative expectancy`,
        detail: `The ${fast.length} re-entries inside ${FAST_REENTRY_MINUTES} minutes of a loss exit average ₹${inr(fastExp)} per trade; the ${rest.length} slower same-day re-entries average ₹${inr(restExp)}. The median gap between a loss exit and the next same-day entry is ${med} minutes.`,
        evidence: [
          { label: `inside ${FAST_REENTRY_MINUTES} min`, value: `₹${inr(fastExp)} / trade over ${fast.length}`, tone: "warn" },
          { label: "slower re-entries", value: `₹${inr(restExp)} / trade over ${rest.length}` },
          { label: "median re-entry gap", value: `${med} min` },
        ],
        suggestion: "Historically, the minutes between a loss exit and the next entry separated your losing re-entries from the rest.",
        sampleSize: pairs.length,
        coverage: { have: timed, of: closed, noun: "closed trades with entry and exit times" },
      };
    },
  },
  {
    id: "sizing-after-loss",
    watches: "position size of the first trade after a loss",
    sampleFloor: 10, // trades that directly follow a loss
    compute: ({ trades }) => {
      const closed = sortByExit(trades.filter((t) => !t.isOpen && (t.sellDate ?? t.buyDate)));
      const sized = closed.filter((t) => t.buyValue > 0);
      // Baseline deliberately includes the after-loss trades themselves: it is
      // the trader's typical size, not a counterfactual without the tilt.
      const baseline = median(sized.map((t) => t.buyValue));
      const afterLoss: number[] = [];
      for (let i = 1; i < closed.length; i++) {
        if (closed[i - 1].netPnl < 0 && closed[i].buyValue > 0) afterLoss.push(closed[i].buyValue);
      }
      if (afterLoss.length < 10 || baseline == null || baseline <= 0) return null;
      const afterMed = median(afterLoss) as number;
      const jumpPct = r2((afterMed / baseline - 1) * 100);
      if (jumpPct <= SIZE_ESCALATION_PCT) return null;
      return {
        id: "sizing-after-loss",
        tone: "warn",
        headline: "Position size grows after a loss",
        detail: `The first trade after a loss has a median buy value of ₹${inr(afterMed)}, against ₹${inr(baseline)} across all sized closed trades — a ${jumpPct}% step up.`,
        evidence: [
          { label: "median size after a loss", value: `₹${inr(afterMed)}`, tone: "warn" },
          { label: "baseline median size", value: `₹${inr(baseline)}` },
          { label: "step up", value: `${jumpPct}%` },
        ],
        sampleSize: afterLoss.length,
        coverage: { have: sized.length, of: closed.length, noun: "closed trades with a recorded buy value" },
      };
    },
  },
];

// ── Contract fixtures ──────────────────────────────────────────────────────
//
// Inputs that make EVERY rule above fire at least once across the array —
// tests/intelligence-contract.test.ts runs its language and floor checks over
// these. Aggregates are hand-authored (not computed via lib/analytics/cockpit)
// to keep this module free of runtime imports from that file — see header.

const fixBucket = (key: string, label: string, trades: number, expectancy: number | null, winRate: number | null): Bucket => ({
  key,
  label,
  trades,
  netPnl: expectancy == null ? 0 : r2(expectancy * trades),
  expectancy,
  winRate,
  thin: trades < 15,
});

const noAggregates = (): Omit<CockpitRuleInput, "trades"> => ({
  time: { bySession: [], byWeekday: [], withTime: 0, withoutTime: 0, offHours: 0, insufficient: true },
  holding: { avgWinDays: null, avgLossDays: null, ratio: null, winners: 0, losers: 0, insufficient: true },
  sizing: { quartiles: [], biggerIsBetter: null, insufficient: true },
  tilt: {
    afterWin: fixBucket("afterWin", "After a win", 0, null, null),
    afterLoss: fixBucket("afterLoss", "After a loss", 0, null, null),
    longestWinStreak: 0,
    longestLossStreak: 0,
    sameDayReentryAfterLoss: 0,
    insufficient: true,
  },
  segments: [],
});

let fixtureId = 0;
const fixTrade = (p: Partial<CockpitTrade>): CockpitTrade => ({
  id: ++fixtureId,
  symbol: "FIXTURE",
  segment: "eq_intraday",
  netPnl: 0,
  buyValue: 100000,
  sellValue: 100000,
  buyDate: "2026-06-01",
  sellDate: "2026-06-01",
  entryTime: null,
  exitTime: null,
  isOpen: false,
  rMultiple: null,
  ...p,
});

/** Fires: session-edge, holding-asymmetry (warn), sizing-conviction,
 *  tilt-after-loss, segment-negative-expectancy, charge-drag. */
const aggregateFixture: CockpitRuleInput = {
  time: {
    bySession: [
      fixBucket("open", "Opening drive", 20, 900, 60),
      fixBucket("midday", "Midday chop", 18, -300, 35),
    ],
    byWeekday: [],
    withTime: 38,
    withoutTime: 2,
    offHours: 0,
    insufficient: false,
  },
  holding: { avgWinDays: 2, avgLossDays: 8, ratio: 4, winners: 20, losers: 20, insufficient: false },
  sizing: {
    quartiles: [
      fixBucket("q1", "Smallest 25%", 10, 800, 60),
      fixBucket("q2", "2nd quartile", 10, 400, 55),
      fixBucket("q3", "3rd quartile", 10, 100, 50),
      fixBucket("q4", "Largest 25%", 10, -200, 40),
    ],
    biggerIsBetter: false,
    insufficient: false,
  },
  tilt: {
    afterWin: fixBucket("afterWin", "After a win", 20, 400, 55),
    afterLoss: fixBucket("afterLoss", "After a loss", 20, -450, 30),
    longestWinStreak: 5,
    longestLossStreak: 4,
    sameDayReentryAfterLoss: 3,
    insufficient: false,
  },
  segments: [
    { ...fixBucket("eq_intraday", "Equity Intraday", 25, 400, 60), charges: 9000, chargeDragPct: 47.4, avgDaysHeld: 1 },
    { ...fixBucket("index_option", "Index Options", 20, -350, 35), charges: 1200, chargeDragPct: null, avgDaysHeld: 1 },
  ],
  trades: [],
};

/** Fires: holding-asymmetry (good branch). */
const healthyHoldingFixture: CockpitRuleInput = {
  ...noAggregates(),
  holding: { avgWinDays: 10, avgLossDays: 4, ratio: 0.4, winners: 20, losers: 18, insufficient: false },
  trades: [],
};

/** Fires: revenge-reentry-minutes. Twelve days; each opens with a loss exiting
 *  10:00. Six days re-enter 5 minutes later and lose, six re-enter 90 minutes
 *  later and win. */
const revengeFixture: CockpitRuleInput = {
  ...noAggregates(),
  trades: Array.from({ length: 12 }, (_, i) => i + 1).flatMap((d) => {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    const fastDay = d <= 6;
    return [
      fixTrade({ buyDate: date, sellDate: date, entryTime: "09:30", exitTime: "10:00", netPnl: -500 }),
      fixTrade({
        buyDate: date,
        sellDate: date,
        entryTime: fastDay ? "10:05" : "11:30",
        exitTime: fastDay ? "10:20" : "12:00",
        netPnl: fastDay ? -800 : 600,
      }),
    ];
  }),
};

/** Fires: sizing-after-loss. Thirty trades alternating a 1L loss with a 2L
 *  win — every after-loss first trade is double the typical size. */
const escalationFixture: CockpitRuleInput = {
  ...noAggregates(),
  trades: Array.from({ length: 30 }, (_, i) => {
    const date = `2026-07-${String(i + 1).padStart(2, "0")}`;
    return i % 2 === 0
      ? fixTrade({ buyDate: date, sellDate: date, buyValue: 100000, netPnl: -500 })
      : fixTrade({ buyDate: date, sellDate: date, buyValue: 200000, netPnl: 100 });
  }),
};

export const CONTRACT_FIXTURES: CockpitRuleInput[] = [
  aggregateFixture,
  healthyHoldingFixture,
  revengeFixture,
  escalationFixture,
];
