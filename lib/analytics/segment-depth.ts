/**
 * THE FIVE BOOKS INSIDE ONE BOOK.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Why segments deserve their own depth ──────────────────────────────────
 *
 * Equity intraday, equity delivery, equity MTF, index options and stock options
 * are not five slices of one activity — they are five different businesses that
 * happen to share a login. They differ in the statute (STT on delivery is
 * charged on both sides at 0.1%; on an option it is 0.15% of premium on the
 * sell side only), in what a "position" costs to hold (MTF accrues financing
 * daily, delivery does not), in settlement (stock F&O is PHYSICALLY settled,
 * index F&O is cash), and in the SEBI regime that governs them.
 *
 * Rolling them into one expectancy hides the thing a trader most needs to know:
 * which of their five businesses actually pays. A book that nets +₹40,000 can
 * easily be +₹2,00,000 of delivery funding a −₹1,60,000 options habit, and the
 * headline number says nothing.
 *
 * ── What this module is NOT ───────────────────────────────────────────────
 *
 * It is not a new grouping. `bySegment` (metrics.ts) and `segmentScorecard`
 * (cockpit.ts) already group by segment, and `SEGMENTS` in domain/constants.ts
 * has distinguished `index_option` from `stock_option` since long before this.
 * This module adds DEPTH per segment — charge drag, capital efficiency, exit
 * behaviour and, above all, an interval on every rate so a thin segment cannot
 * masquerade as an edge.
 */

import type { Segment } from "@/lib/domain/constants";
import { proportionPValue, wilsonInterval, benjaminiYekutieli, type Interval } from "./inference";

/**
 * The five the owner asked for, in the order a trader thinks about them:
 * fastest and most punishing first.
 *
 * Deliberately NOT every value in `SEGMENTS`. Futures and commodities are real
 * segments and appear in `bySegment`, but they are a different conversation and
 * padding this surface with empty rows would make it useless for the traders
 * who have none.
 */
export const DEPTH_SEGMENTS: { segment: Segment; label: string; note: string }[] = [
  { segment: "eq_intraday", label: "Equity Intraday", note: "STT 0.025% sell-side; no financing, no delivery" },
  { segment: "eq_delivery", label: "Equity Delivery", note: "STT 0.1% BOTH sides; DP charge on every sell day" },
  { segment: "eq_mtf", label: "Equity MTF", note: "financing accrues daily — time itself is a cost here" },
  { segment: "index_option", label: "Options (Index)", note: "cash settled; SEBI weekly-expiry limits apply" },
  { segment: "stock_option", label: "Options (Stock)", note: "PHYSICALLY settled — expiry becomes a delivery obligation" },
];

export interface DepthTrade {
  segment: string;
  netPnl: number;
  grossPnl: number;
  chargesTotal: number;
  buyValue: number;
  isOpen: boolean;
  /** Excluded from every rate when false — no cost basis, no measurable edge. */
  basisKnown: boolean;
  buyOrderCount?: number | null;
  sellOrderCount?: number | null;
  exitTime?: string | null;
}

export interface SegmentDepth {
  segment: Segment;
  label: string;
  note: string;
  /** Closed trades with a known basis — the population every rate is over. */
  count: number;
  /** Closed trades EXCLUDED for want of a cost basis, reported not hidden. */
  excluded: number;
  net: number;
  gross: number;
  charges: number;
  wins: number;
  winRate: number;
  /** Wilson interval on the win rate. Wide means "we do not know yet". */
  winRateCi: Interval;
  expectancy: number;
  /**
   * Charges as a share of GROSS profit — how much of what the strategy made
   * went to the cost of making it. Null when gross is not positive, because a
   * percentage of a loss is not a meaningful drag figure.
   */
  chargeDragPct: number | null;
  /** Mean executed orders per position, when the data carries them. */
  avgFills: number | null;
  /**
   * True when this segment's win rate is distinguishable from the whole book's,
   * after correcting for testing all five together.
   */
  distinguishable: boolean;
}

export interface SegmentDepthReport {
  rows: SegmentDepth[];
  /** Book-wide win rate the segments are compared against. */
  bookWinRate: number | null;
  bookCount: number;
  /** Closed trades sitting in segments this surface does not cover. */
  otherSegmentTrades: number;
  totalExcluded: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Depth for each of the five segments, with an interval on every rate and one
 * multiplicity correction across the whole table.
 *
 * Five simultaneous comparisons is exactly the regime where an uncorrected
 * "best segment" is a coin that came up heads. Benjamini-Yekutieli because the
 * five populations are disjoint but the BOOK rate they are each compared
 * against is computed from all of them, which is a dependence.
 */
export function segmentDepth(trades: DepthTrade[]): SegmentDepthReport {
  const closed = trades.filter((t) => !t.isOpen);
  const measurable = closed.filter((t) => t.basisKnown);

  const covered = new Set<string>(DEPTH_SEGMENTS.map((d) => d.segment));
  const otherSegmentTrades = closed.filter((t) => !covered.has(t.segment)).length;

  const inScope = measurable.filter((t) => covered.has(t.segment));
  const bookCount = inScope.length;
  const bookWins = inScope.filter((t) => t.netPnl > 0).length;
  const bookWinRate = bookCount > 0 ? bookWins / bookCount : null;

  const draft = DEPTH_SEGMENTS.map((d) => {
    const rows = measurable.filter((t) => t.segment === d.segment);
    const excluded = closed.filter((t) => t.segment === d.segment && !t.basisKnown).length;
    const count = rows.length;
    const net = r2(rows.reduce((s, t) => s + t.netPnl, 0));
    const gross = r2(rows.reduce((s, t) => s + t.grossPnl, 0));
    const charges = r2(rows.reduce((s, t) => s + t.chargesTotal, 0));
    const wins = rows.filter((t) => t.netPnl > 0).length;
    const withFills = rows.filter((t) => (t.buyOrderCount ?? 0) > 0 && (t.sellOrderCount ?? 0) > 0);
    return {
      segment: d.segment,
      label: d.label,
      note: d.note,
      count,
      excluded,
      net,
      gross,
      charges,
      wins,
      winRate: count ? wins / count : 0,
      winRateCi: wilsonInterval(wins, count),
      expectancy: count ? r2(net / count) : 0,
      // A drag percentage against a negative gross would read as a profit share
      // of something that was never profit.
      chargeDragPct: gross > 0 ? r2((charges / gross) * 100) : null,
      avgFills: withFills.length
        ? r2(withFills.reduce((s, t) => s + (t.buyOrderCount ?? 0) + (t.sellOrderCount ?? 0), 0) / withFills.length)
        : null,
      distinguishable: false as boolean,
    } satisfies SegmentDepth;
  });

  if (bookWinRate != null) {
    const corrected = benjaminiYekutieli(
      draft
        .filter((d) => d.count > 0)
        .map((d) => ({ item: d.segment, p: proportionPValue(d.wins, d.count, bookWinRate) })),
    );
    const sig = new Map(corrected.map((c) => [c.item, c.significant]));
    for (const d of draft) d.distinguishable = sig.get(d.segment) ?? false;
  }

  return {
    rows: draft,
    bookWinRate,
    bookCount,
    otherSegmentTrades,
    totalExcluded: closed.filter((t) => !t.basisKnown).length,
  };
}

/**
 * The one sentence worth putting above the table: which segment is actually
 * carrying the book, and which is bleeding.
 *
 * Returns null rather than a weak claim when no segment has enough trades —
 * ranking five segments on a handful of trades each is exactly what the
 * interval work exists to prevent.
 */
export function segmentFinding(report: SegmentDepthReport, minSample = 20): string | null {
  const eligible = report.rows.filter((r) => r.count >= minSample);
  if (eligible.length < 2) return null;
  const best = [...eligible].sort((a, b) => b.net - a.net)[0];
  const worst = [...eligible].sort((a, b) => a.net - b.net)[0];
  if (best.segment === worst.segment) return null;
  if (worst.net >= 0) {
    return `Every segment with enough trades is positive. ${best.label} carries the most (₹${best.net} over ${best.count} trades).`;
  }
  return `${best.label} made ₹${best.net} over ${best.count} trades while ${worst.label} lost ₹${Math.abs(worst.net)} over ${worst.count}. The headline number is the two of them cancelling.`;
}
