/**
 * LENS-GROUP INSIGHT RULES — what one drill-down group's record shows (PURE).
 *
 * Runs server-side against a /lenses drill-down: the group's members plus the
 * `computeKpis` figures already on screen. Every rule honours the insight
 * contract (lib/intelligence/insight.ts): descriptive only, refuses below its
 * sample floor, and carries coverage whenever a claim is computed on a subset
 * of what the reader sees.
 *
 * Partition honesty: a lens group is one cell of a partition (lenses.ts), and
 * the only cut taken INSIDE it here is by `setupTag` — single-valued per trade,
 * so its shares genuinely partition the losing total, and the prose says so.
 * A rule that ever cuts by an overlapping dimension (themes, mistake tags)
 * cannot present its shares as summing to the group.
 */

import { computeKpis, type Kpis } from "@/lib/analytics/metrics";
import { fmtDate, inr, num, pct } from "@/lib/format";
import type { Insight, InsightRule } from "@/lib/intelligence/insight";

/** The slim member shape the /lenses drill-down holds (LensTrade is
 *  structurally assignable — this module states its own needs rather than
 *  importing domain types it mostly ignores). */
export interface GroupMember {
  id: number;
  symbol: string;
  tradingsymbol: string;
  buyDate: string | null;
  sellDate: string | null;
  isOpen: boolean;
  netPnl: number;
  grossPnl: number;
  chargesTotal: number;
  rMultiple: number | null;
  setupTag: string | null;
  playbookId: number | null;
  broker: string;
  segment: string;
  bucket: string;
  staged?: boolean;
}

export interface GroupRuleInput {
  /** The group's display label — "Zerodha", "Feb 2026", a setup name. */
  label: string;
  kpis: Kpis;
  members: GroupMember[];
}

/** One floor for every rule: no claim about a group rests on fewer than ten
 *  qualifying observations (the contract test's own minimum). */
const FLOOR = 10;

const UNTAGGED = "(untagged)";

/** Setup-loss concentration fires past this share of the losing total. */
const SETUP_LOSS_SHARE = 0.6;
/** Single-trade share of the losing total worth naming. */
const TOP_LOSER_SHARE = 0.4;
/** Mirror of the cockpit's charge-drag line (cockpit.ts: chargeDragPct > 30). */
const CHARGE_DRAG_PCT = 30;
/** Loss runs shorter than this are noise, not a note. */
const LOSS_RUN = 5;
/** Holding-time divergence (either direction) worth stating. */
const HOLD_SKEW_RATIO = 1.5;

const closedOf = (members: GroupMember[]) => members.filter((m) => !m.isOpen);
const losersOf = (closed: GroupMember[]) => closed.filter((m) => m.netPnl < 0);
const displaySymbol = (m: GroupMember) => m.tradingsymbol || m.symbol;

/** Calendar days held, floored at one; null when either date is unreadable.
 *  Date-only maths on the ISO date part — no timezone in play. */
function heldDays(m: GroupMember): number | null {
  if (!m.buyDate || !m.sellDate) return null;
  const b = Date.parse(m.buyDate.slice(0, 10) + "T00:00:00Z");
  const s = Date.parse(m.sellDate.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(b) || Number.isNaN(s)) return null;
  return Math.max(1, Math.round((s - b) / 86_400_000));
}

interface LossRun {
  len: number;
  net: number;
  first: GroupMember;
  last: GroupMember;
}

/** Longest consecutive-loss run, chronological by sell date — the same reading
 *  computeKpis takes: a breakeven exit neither breaks nor extends a run. */
function worstLossRun(closed: GroupMember[]): LossRun | null {
  const sorted = closed
    .slice()
    .sort((a, b) => (a.sellDate ?? "").localeCompare(b.sellDate ?? ""));
  let best: LossRun | null = null;
  let cur: LossRun | null = null;
  for (const t of sorted) {
    if (t.netPnl < 0) {
      cur = cur
        ? { len: cur.len + 1, net: cur.net + t.netPnl, first: cur.first, last: t }
        : { len: 1, net: t.netPnl, first: t, last: t };
      if (!best || cur.len > best.len) best = cur;
    } else if (t.netPnl > 0) {
      cur = null;
    }
    // netPnl === 0: mirrors computeKpis's `continue` — the run stands.
  }
  return best;
}

export const GROUP_RULES: InsightRule<GroupRuleInput>[] = [
  {
    id: "setup-concentration",
    watches: "how the group's losing total distributes across setup tags",
    sampleFloor: FLOOR,
    compute: ({ label, members }) => {
      const closed = closedOf(members);
      const losers = losersOf(closed);
      if (losers.length < FLOOR) return null;
      const byTag = new Map<string, number>();
      let total = 0;
      for (const m of losers) {
        const tag = m.setupTag?.trim() || UNTAGGED;
        const loss = -m.netPnl;
        byTag.set(tag, (byTag.get(tag) ?? 0) + loss);
        total += loss;
      }
      if (total <= 0) return null;
      let topTag = UNTAGGED;
      let topLoss = 0;
      for (const [tag, loss] of byTag) {
        if (loss > topLoss) {
          topTag = tag;
          topLoss = loss;
        }
      }
      const share = topLoss / total;
      if (share <= SETUP_LOSS_SHARE) return null;
      return {
        id: "setup-concentration",
        tone: "warn",
        headline: `Most of ${label}'s losing total sits in one setup: "${topTag}" carries ${pct(share * 100, 0)} of it.`,
        detail:
          "Each losing trade counts under exactly one setup tag, so these shares partition the losing total.",
        evidence: [
          { label: `"${topTag}" loss`, value: inr(-topLoss, { decimals: 0 }), tone: "warn" },
          { label: "group losing total", value: inr(-total, { decimals: 0 }) },
          { label: "share", value: pct(share * 100, 0) },
        ],
        sampleSize: losers.length,
        coverage: { have: losers.length, of: closed.length, noun: "closed trades ended in a loss" },
      };
    },
  },
  {
    id: "top-loser-share",
    watches: "how much of the group's losing total one trade carries",
    sampleFloor: FLOOR,
    compute: ({ label, members }) => {
      const closed = closedOf(members);
      const losers = losersOf(closed);
      if (losers.length < FLOOR) return null;
      const worst = losers.reduce((a, b) => (b.netPnl < a.netPnl ? b : a));
      const total = losers.reduce((s, m) => s - m.netPnl, 0);
      if (total <= 0) return null;
      const share = -worst.netPnl / total;
      if (share <= TOP_LOSER_SHARE) return null;
      return {
        id: "top-loser-share",
        tone: "warn",
        headline: `A single trade, ${displaySymbol(worst)}, accounts for ${pct(share * 100, 0)} of ${label}'s losing total.`,
        evidence: [
          { label: displaySymbol(worst), value: inr(worst.netPnl, { decimals: 0 }), tone: "warn" },
          { label: "group losing total", value: inr(-total, { decimals: 0 }) },
          { label: "losing trades", value: String(losers.length) },
        ],
        sampleSize: losers.length,
        coverage: { have: losers.length, of: closed.length, noun: "closed trades ended in a loss" },
      };
    },
  },
  {
    id: "charge-drag",
    watches: "charges as a share of the group's gross P&L",
    sampleFloor: FLOOR,
    compute: ({ label, kpis }) => {
      if (kpis.closedCount < FLOOR) return null;
      // No gross, no denominator — refuse rather than divide by a fabricated one.
      if (kpis.grossPnl === 0) return null;
      if (kpis.chargePctOfGross <= CHARGE_DRAG_PCT) return null;
      const insight: Insight = {
        id: "charge-drag",
        tone: "warn",
        headline: `Charges in ${label} come to ${pct(kpis.chargePctOfGross, 0)} of its gross P&L — past the ${CHARGE_DRAG_PCT}% drag line.`,
        evidence: [
          { label: "charges", value: inr(kpis.charges, { decimals: 0 }), tone: "warn" },
          { label: "gross P&L", value: inr(kpis.grossPnl, { decimals: 0 }) },
          { label: "drag", value: pct(kpis.chargePctOfGross, 1) },
        ],
        sampleSize: kpis.closedCount,
      };
      // Gross and charges are summed over closed trades only; say so when the
      // group also holds open positions the reader is looking at.
      if (kpis.openCount > 0) {
        insight.coverage = { have: kpis.closedCount, of: kpis.count, noun: "trades in this group are closed" };
      }
      return insight;
    },
  },
  {
    id: "streak-note",
    watches: "consecutive losses inside the group",
    sampleFloor: FLOOR,
    compute: ({ label, members }) => {
      const closed = closedOf(members);
      if (closed.length < FLOOR) return null;
      const run = worstLossRun(closed);
      if (!run || run.len < LOSS_RUN) return null;
      const dated = Boolean(run.first.sellDate && run.last.sellDate);
      return {
        id: "streak-note",
        tone: "warn",
        headline: dated
          ? `${label} holds a run of ${run.len} consecutive losses, ${fmtDate(run.first.sellDate)} to ${fmtDate(run.last.sellDate)}.`
          : `${label} holds a run of ${run.len} consecutive losses (exit dates not recorded across the run).`,
        detail: "A breakeven exit neither breaks nor extends the run — the same reading the streak KPI uses.",
        evidence: [
          { label: "run length", value: String(run.len), tone: "warn" },
          { label: "run net P&L", value: inr(run.net, { decimals: 0 }), tone: "warn" },
        ],
        sampleSize: closed.length,
      };
    },
  },
  {
    id: "holding-skew",
    watches: "how long the group's winners stay open versus its losers",
    sampleFloor: FLOOR,
    compute: ({ label, members }) => {
      const decided = closedOf(members).filter((m) => m.netPnl !== 0);
      const dated: { m: GroupMember; d: number }[] = [];
      for (const m of decided) {
        const d = heldDays(m);
        if (d != null) dated.push({ m, d });
      }
      if (dated.length < FLOOR) return null;
      const winDays = dated.filter((x) => x.m.netPnl > 0).map((x) => x.d);
      const lossDays = dated.filter((x) => x.m.netPnl < 0).map((x) => x.d);
      // A side represented by one or two trades is an anecdote, not an average.
      if (winDays.length < 3 || lossDays.length < 3) return null;
      const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      const avgW = avg(winDays);
      const avgL = avg(lossDays);
      const winnersLonger = avgW >= avgL;
      const ratio = winnersLonger ? avgW / avgL : avgL / avgW;
      if (ratio <= HOLD_SKEW_RATIO) return null;
      const skipped = decided.length - dated.length;
      return {
        id: "holding-skew",
        tone: "info",
        headline: `In ${label}, ${winnersLonger ? "winners" : "losers"} stay open about ${num(ratio, 1)}× longer than ${winnersLonger ? "losers" : "winners"}.`,
        detail:
          skipped > 0
            ? `Calendar days between entry and exit, floored at one; ${skipped} closed trade${skipped === 1 ? "" : "s"} without both dates sit outside the averages.`
            : "Calendar days between entry and exit, floored at one.",
        evidence: [
          { label: "winners held (avg)", value: `${num(avgW, 1)} days` },
          { label: "losers held (avg)", value: `${num(avgL, 1)} days` },
        ],
        sampleSize: dated.length,
        coverage: { have: dated.length, of: decided.length, noun: "closed win/loss trades carry both dates" },
      };
    },
  },
  {
    id: "unpriced-share",
    watches: "closed trades excluded from the edge ratios for want of a cost basis",
    sampleFloor: FLOOR,
    compute: ({ label, kpis }) => {
      if (kpis.closedCount < FLOOR) return null;
      if (kpis.unpricedCount === 0) return null;
      const priced = kpis.closedCount - kpis.unpricedCount;
      return {
        id: "unpriced-share",
        tone: "info",
        headline: `${kpis.unpricedCount} of ${label}'s ${kpis.closedCount} closed trades carry no readable cost basis, so the edge figures read the ${priced} priced ones.`,
        detail: `Their cash still counts: ${inr(kpis.unpricedNetPnl, { decimals: 0 })} of net P&L sits in the totals but outside win rate, expectancy and profit factor.`,
        evidence: [
          { label: "unpriced trades", value: String(kpis.unpricedCount) },
          { label: "their net P&L", value: inr(kpis.unpricedNetPnl, { decimals: 0 }) },
          { label: "priced trades", value: String(priced) },
        ],
        sampleSize: kpis.closedCount,
        coverage: { have: priced, of: kpis.closedCount, noun: "closed trades carry a cost basis" },
      };
    },
  },
];

// ── Contract fixtures ───────────────────────────────────────────────────────
// Inputs that make every rule above fire, for tests/intelligence-contract.test.ts
// (the integrator registers { rules: GROUP_RULES, fixtures: CONTRACT_FIXTURES }).

/** Fixture members may carry the acquisition fields computeKpis reads to mark
 *  a trade unpriced; the rules themselves never look at them. */
type FixtureMember = GroupMember & {
  acquisition?: string | null;
  buyValue?: number;
  acquisitionPrice?: number | null;
};

let seq = 0;
function fx(netPnl: number, over: Partial<FixtureMember> = {}): FixtureMember {
  seq += 1;
  const chargesTotal = over.chargesTotal ?? 1500;
  return {
    id: seq,
    symbol: "TCS",
    tradingsymbol: over.symbol ?? "TCS",
    buyDate: "2026-01-01",
    sellDate: "2026-01-05",
    isOpen: false,
    netPnl,
    grossPnl: netPnl + chargesTotal,
    chargesTotal,
    rMultiple: null,
    setupTag: null,
    playbookId: null,
    broker: "zerodha",
    segment: "equity-delivery",
    bucket: "delivery",
    ...over,
  };
}

const d2 = (n: number) => String(n).padStart(2, "0");

// Fires setup-concentration, top-loser-share, charge-drag, streak-note and
// holding-skew at once: four 10-day winners, then twelve 2-day losers in a
// row, with "breakout" (and its ₹50k single worst trade) owning the loss.
const fixtureA: FixtureMember[] = [
  ...Array.from({ length: 4 }, (_, i) =>
    fx(2000, { setupTag: "trend", buyDate: "2026-01-01", sellDate: `2026-01-${d2(11 + i)}` }),
  ),
  ...Array.from({ length: 12 }, (_, i) =>
    fx(i === 0 ? -50000 : i <= 5 ? -3000 : -1000, {
      symbol: i === 0 ? "HDFCBANK" : "TCS",
      setupTag: i <= 5 ? "breakout" : i % 2 ? "reversal" : null,
      buyDate: `2026-02-${d2(i + 1)}`,
      sellDate: `2026-02-${d2(i + 3)}`,
    }),
  ),
];

// Fires unpriced-share: ten priced trades interleaved win/loss (no loss run,
// no holding skew), plus two sales whose purchase is not in the data.
const fixtureB: FixtureMember[] = [
  ...Array.from({ length: 10 }, (_, i) => fx(i % 2 ? -800 : 1000, { chargesTotal: 50 })),
  ...Array.from({ length: 2 }, () =>
    fx(5000, { chargesTotal: 50, acquisition: "off-market", buyValue: 0, acquisitionPrice: null }),
  ),
];

export const CONTRACT_FIXTURES: GroupRuleInput[] = [
  { label: "Zerodha", kpis: computeKpis(fixtureA), members: fixtureA },
  { label: "Feb 2026", kpis: computeKpis(fixtureB), members: fixtureB },
];
