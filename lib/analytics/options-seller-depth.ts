// OPTION-SELLER DEPTH, ROUND TWO (PURE, no DB/React).
//
// `options-seller.ts` answers "how much of the premium did I keep?". That is the
// scoreboard. These are the four questions a seller actually changes their
// behaviour over, and none of them are answerable from a P&L total:
//
//   1. Which DTE band is my edge in? Weeklies and monthlies are different
//      businesses — same underlying, different risk, different theta curve.
//   2. Does hedging actually pay for itself, or am I buying wings out of
//      anxiety and handing back the premium that justified the trade?
//   3. When I roll, does the CHAIN end up ahead — or am I converting a small
//      loss into a large one while each individual leg looks defensible?
//   4. Was I selling into rich IV or cheap IV, and does it correlate?
//
// ── The honesty rules this module inherits ──────────────────────────────────
//
// Every grouped finding carries its own sample size and a `trustworthy` flag,
// because a 3-trade DTE bucket is noise wearing a percentage sign. Nothing here
// invents a denominator: a percentage with nothing to divide by comes back
// null, never 0. And IV rank is computed ONLY against the user's own recorded
// observations for that underlying — the app has no IV history feed, so a rank
// derived from four data points says so rather than pretending to be a
// percentile.

import type { SellerTrade } from "./options-seller";

/** Below this, a grouped statistic is reported but explicitly not trustworthy. */
export const MIN_SAMPLE = 15;
/** IV rank needs a distribution, not a handful of points. */
export const MIN_IV_OBSERVATIONS = 8;

export interface SellerTradeWithDates extends SellerTrade {
  buyDate: string | null;
  sellDate: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The population this module speaks about: positions opened by SELLING. */
export function sellerTrades<T extends SellerTrade>(trades: T[]): T[] {
  return trades.filter((t) => t.sellQty > 0 && (t.sellQty >= t.buyQty || t.avgSellPrice > 0));
}

function expectancyOf(nets: number[]): { trades: number; net: number; expectancy: number | null; winRate: number | null } {
  if (nets.length === 0) return { trades: 0, net: 0, expectancy: null, winRate: null };
  const net = nets.reduce((s, n) => s + n, 0);
  return {
    trades: nets.length,
    net: r2(net),
    expectancy: r2(net / nets.length),
    winRate: r2((nets.filter((n) => n > 0).length / nets.length) * 100),
  };
}

// ── 1. DTE bands ────────────────────────────────────────────────────────────

export interface DteBand {
  label: string;
  minDte: number;
  maxDte: number;
}

/**
 * Bands chosen around how Indian options are actually sold, not round numbers:
 * expiry-week (the theta rush and the gamma risk that comes with it), the
 * fortnight, the monthly cycle, and everything longer.
 */
export const DTE_BANDS: DteBand[] = [
  { label: "0–2 (expiry zone)", minDte: 0, maxDte: 2 },
  { label: "3–7 (expiry week)", minDte: 3, maxDte: 7 },
  { label: "8–21 (fortnight)", minDte: 8, maxDte: 21 },
  { label: "22–45 (monthly)", minDte: 22, maxDte: 45 },
  { label: "46+ (far)", minDte: 46, maxDte: Number.POSITIVE_INFINITY },
];

export interface DteBucket {
  label: string;
  trades: number;
  net: number;
  expectancy: number | null;
  winRate: number | null;
  capturePct: number | null;
  trustworthy: boolean;
}

export interface DteReport {
  buckets: DteBucket[];
  /** Closed sellers whose entry DTE was never recorded — excluded, not guessed. */
  unknownDte: number;
  best: string | null;
  worst: string | null;
}

function captureOf(ts: SellerTrade[]): number | null {
  const sold = ts.reduce((s, t) => s + t.avgSellPrice * t.sellQty, 0);
  if (sold <= 0) return null;
  const bought = ts.reduce((s, t) => s + t.avgBuyPrice * Math.min(t.buyQty, t.sellQty), 0);
  return r2(((sold - bought) / sold) * 100);
}

/** Expectancy by days-to-expiry at entry. Closed sellers only. */
export function dteReport(trades: SellerTrade[]): DteReport {
  const closed = sellerTrades(trades).filter((t) => !t.isOpen);
  const withDte = closed.filter((t) => t.entryDte != null && t.entryDte >= 0);

  const buckets: DteBucket[] = DTE_BANDS.map((b) => {
    const ts = withDte.filter((t) => t.entryDte! >= b.minDte && t.entryDte! <= b.maxDte);
    const e = expectancyOf(ts.map((t) => t.netPnl));
    return {
      label: b.label,
      trades: e.trades,
      net: e.net,
      expectancy: e.expectancy,
      winRate: e.winRate,
      capturePct: captureOf(ts),
      trustworthy: e.trades >= MIN_SAMPLE,
    };
  });

  // Only rank bands that carry enough trades to mean anything — otherwise the
  // "best band" is whichever one happened to contain a single large winner.
  const ranked = buckets.filter((b) => b.trustworthy && b.expectancy != null);
  ranked.sort((a, b) => b.expectancy! - a.expectancy!);

  return {
    buckets,
    unknownDte: closed.length - withDte.length,
    best: ranked.length > 0 ? ranked[0].label : null,
    worst: ranked.length > 1 ? ranked[ranked.length - 1].label : null,
  };
}

// ── 2. Does hedging pay? ────────────────────────────────────────────────────

export interface HedgeArm {
  label: string;
  trades: number;
  net: number;
  expectancy: number | null;
  winRate: number | null;
  trustworthy: boolean;
}

export interface HedgeReport {
  hedged: HedgeArm;
  unhedged: HedgeArm;
  /** hedged expectancy − unhedged expectancy; null unless BOTH arms qualify. */
  expectancyGap: number | null;
  comparable: boolean;
  unclassified: number;
  note: string;
}

/**
 * Hedged vs unhedged expectancy.
 *
 * Reported as a GAP between two observed populations, never as "hedging cost
 * you ₹X" — the trader chose which trades to hedge, so the two arms are not a
 * controlled experiment. A seller who only hedges when they are nervous will
 * show worse hedged expectancy for reasons that have nothing to do with hedging.
 * That caveat ships in `note` so it cannot be dropped by a caller.
 */
export function hedgeReport(trades: SellerTrade[]): HedgeReport {
  const closed = sellerTrades(trades).filter((t) => !t.isOpen);
  const hedgedTs = closed.filter((t) => t.hedgeStatus === "hedged");
  const unhedgedTs = closed.filter((t) => t.hedgeStatus === "unhedged");

  const arm = (label: string, ts: SellerTrade[]): HedgeArm => {
    const e = expectancyOf(ts.map((t) => t.netPnl));
    return { label, trades: e.trades, net: e.net, expectancy: e.expectancy, winRate: e.winRate, trustworthy: e.trades >= MIN_SAMPLE };
  };

  const hedged = arm("Hedged", hedgedTs);
  const unhedged = arm("Unhedged", unhedgedTs);
  const comparable = hedged.trustworthy && unhedged.trustworthy;

  return {
    hedged,
    unhedged,
    expectancyGap: comparable ? r2(hedged.expectancy! - unhedged.expectancy!) : null,
    comparable,
    unclassified: closed.length - hedgedTs.length - unhedgedTs.length,
    note:
      "You chose which trades to hedge, so these two groups are not a controlled comparison — a gap can reflect which trades felt risky rather than what hedging did to them.",
  };
}

// ── 3. Roll / adjustment chains ─────────────────────────────────────────────

export interface RollChain {
  group: string;
  legs: number;
  net: number;
  /** The first leg's own result — what stopping there would have booked. */
  firstLegNet: number;
  /** net − firstLegNet. Positive means the adjustments added to the outcome. */
  adjustmentDelta: number;
  resolved: boolean;
  verdict: "helped" | "hurt" | "neutral" | "open";
}

export interface RollReport {
  chains: RollChain[];
  chainsResolved: number;
  helped: number;
  hurt: number;
  neutral: number;
  totalDelta: number;
  /** Chains that turned a first-leg profit into an overall loss. The one to look at. */
  rescuesThatBackfired: number;
}

/**
 * Group adjusted positions by `adjustmentGroup` and ask whether the chain ended
 * up better than its first leg alone.
 *
 * `firstLegNet` is a LABELLED counterfactual, not a claim: it is what the first
 * leg actually booked, so stopping there was genuinely available. It does not
 * model what the underlying did afterwards.
 *
 * A chain with any open leg is "open" and stays out of every aggregate — a roll
 * still in progress has no outcome to judge.
 */
export function rollReport(trades: SellerTrade[]): RollReport {
  const grouped = new Map<string, SellerTrade[]>();
  for (const t of sellerTrades(trades)) {
    const g = t.adjustmentGroup?.trim();
    if (!g) continue;
    const list = grouped.get(g) ?? [];
    list.push(t);
    grouped.set(g, list);
  }

  const chains: RollChain[] = [...grouped.entries()].map(([group, ts]) => {
    // Ascending id is the only ordering the journal guarantees for a chain.
    const ordered = [...ts].sort((a, b) => a.id - b.id);
    const net = r2(ordered.reduce((s, t) => s + t.netPnl, 0));
    const firstLegNet = r2(ordered[0].netPnl);
    const resolved = ordered.every((t) => !t.isOpen);
    const delta = r2(net - firstLegNet);
    // Same dead-band shape as scaling quality: rupees of rounding are not edge.
    const threshold = Math.max(10, Math.abs(firstLegNet) * 0.01);
    const verdict: RollChain["verdict"] = !resolved
      ? "open"
      : delta > threshold
        ? "helped"
        : delta < -threshold
          ? "hurt"
          : "neutral";
    return { group, legs: ordered.length, net, firstLegNet, adjustmentDelta: delta, resolved, verdict };
  });

  chains.sort((a, b) => a.group.localeCompare(b.group));
  const done = chains.filter((c) => c.resolved);

  return {
    chains,
    chainsResolved: done.length,
    helped: done.filter((c) => c.verdict === "helped").length,
    hurt: done.filter((c) => c.verdict === "hurt").length,
    neutral: done.filter((c) => c.verdict === "neutral").length,
    totalDelta: r2(done.reduce((s, c) => s + c.adjustmentDelta, 0)),
    rescuesThatBackfired: done.filter((c) => c.firstLegNet > 0 && c.net < 0).length,
  };
}

// ── 4. IV rank at entry ─────────────────────────────────────────────────────

export interface IvRankRow {
  id: number;
  symbol: string;
  entryIv: number;
  /** 0–100 percentile within THIS underlying's own recorded entry IVs. */
  ivRank: number | null;
  netPnl: number;
}

export interface IvRankReport {
  rows: IvRankRow[];
  /** Underlyings with too few observations to rank against. */
  insufficient: string[];
  richHalf: { trades: number; net: number; expectancy: number | null };
  cheapHalf: { trades: number; net: number; expectancy: number | null };
  comparable: boolean;
  note: string;
}

/**
 * Where each entry sat within the IV this book has actually observed for that
 * underlying.
 *
 * Vyuha has no IV history feed, so "rank" here means a percentile among the
 * user's OWN recorded entry IVs for the same symbol — nothing more. An
 * underlying with fewer than MIN_IV_OBSERVATIONS entries is listed as
 * insufficient rather than ranked against three numbers.
 */
export function ivRankReport(trades: SellerTrade[]): IvRankReport {
  const closed = sellerTrades(trades).filter((t) => !t.isOpen && t.entryIv != null);

  const bySymbol = new Map<string, SellerTrade[]>();
  for (const t of closed) {
    const k = t.symbol.toUpperCase();
    const l = bySymbol.get(k) ?? [];
    l.push(t);
    bySymbol.set(k, l);
  }

  const rows: IvRankRow[] = [];
  const insufficient: string[] = [];

  for (const [symbol, ts] of bySymbol) {
    const ivs = ts.map((t) => t.entryIv!).sort((a, b) => a - b);
    if (ivs.length < MIN_IV_OBSERVATIONS) {
      insufficient.push(symbol);
      for (const t of ts) rows.push({ id: t.id, symbol: t.symbol, entryIv: t.entryIv!, ivRank: null, netPnl: t.netPnl });
      continue;
    }
    const lo = ivs[0];
    const hi = ivs[ivs.length - 1];
    for (const t of ts) {
      // A flat history has no spread to rank within — say so instead of
      // reporting everything as the 0th or 100th percentile.
      const rank = hi > lo ? r2(((t.entryIv! - lo) / (hi - lo)) * 100) : null;
      rows.push({ id: t.id, symbol: t.symbol, entryIv: t.entryIv!, ivRank: rank, netPnl: t.netPnl });
    }
  }

  rows.sort((a, b) => a.id - b.id);

  const ranked = rows.filter((r) => r.ivRank != null);
  const rich = ranked.filter((r) => r.ivRank! >= 50);
  const cheap = ranked.filter((r) => r.ivRank! < 50);
  const half = (rs: IvRankRow[]) => {
    const e = expectancyOf(rs.map((r) => r.netPnl));
    return { trades: e.trades, net: e.net, expectancy: e.expectancy };
  };

  return {
    rows,
    insufficient: insufficient.sort(),
    richHalf: half(rich),
    cheapHalf: half(cheap),
    comparable: rich.length >= MIN_SAMPLE && cheap.length >= MIN_SAMPLE,
    note:
      "Rank is a percentile within this journal's own recorded entry IVs for the same underlying — not a market IV-rank feed. It moves as you record more trades.",
  };
}

// ── 5. Premium capture per day of risk ──────────────────────────────────────

export interface ThetaEfficiencyRow {
  id: number;
  symbol: string;
  daysHeld: number;
  premiumCaptured: number;
  perDay: number;
}

export interface ThetaEfficiencyReport {
  rows: ThetaEfficiencyRow[];
  medianPerDay: number | null;
  /** Closed sellers whose dates are incomplete — excluded, never assumed. */
  undated: number;
}

/**
 * Premium captured per day the position was open.
 *
 * The seller's real unit of production: two trades that both kept ₹5,000 are not
 * equal if one took three days and the other took thirty. Median rather than
 * mean, because one expiry-day scalp distorts an average badly.
 */
export function thetaEfficiency(trades: SellerTradeWithDates[]): ThetaEfficiencyReport {
  const closed = sellerTrades(trades).filter((t) => !t.isOpen);
  const rows: ThetaEfficiencyRow[] = [];
  let undated = 0;

  for (const t of closed) {
    // A short is opened by the SELL and closed by the BUY.
    const open = t.sellDate;
    const close = t.buyDate;
    if (!open || !close) {
      undated++;
      continue;
    }
    const ms = new Date(close + "T00:00:00").getTime() - new Date(open + "T00:00:00").getTime();
    if (!Number.isFinite(ms) || ms < 0) {
      undated++;
      continue;
    }
    // Same-day counts as one day of risk, not zero — you carried it.
    const daysHeld = Math.max(1, Math.round(ms / 86400000));
    const captured = r2(t.avgSellPrice * t.sellQty - t.avgBuyPrice * Math.min(t.buyQty, t.sellQty));
    rows.push({ id: t.id, symbol: t.symbol, daysHeld, premiumCaptured: captured, perDay: r2(captured / daysHeld) });
  }

  rows.sort((a, b) => b.perDay - a.perDay);
  const vals = rows.map((r) => r.perDay).sort((a, b) => a - b);
  const median =
    vals.length === 0
      ? null
      : vals.length % 2
        ? vals[(vals.length - 1) / 2]
        : r2((vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2);

  return { rows, medianPerDay: median, undated };
}
