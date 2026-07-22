/**
 * Return on Margin — what your capital actually earned while it was tied up.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Why this metric and not return-on-turnover ────────────────────────────
 *
 * Every Indian F&O journal reports P&L against turnover or notional. Both are
 * close to meaningless. A long option and a short strangle can carry identical
 * notional while tying up wildly different capital: the long option costs you
 * the premium and nothing more, the short strangle blocks margin against the
 * underlying. Measuring both against notional says they used the same capital.
 * They did not.
 *
 * ROM measures against what was ACTUALLY BLOCKED, using the same per-segment
 * rule as the live margin cockpit (lib/risk/margin.ts#capitalBlocked), so the
 * two views can never disagree.
 *
 * ── The three numbers, and why all three exist ────────────────────────────
 *
 *   romPct       — raw P&L ÷ capital blocked. Unambiguous, but a 2% return in
 *                  one day and 2% over thirty days read identically.
 *   romPerDay    — romPct ÷ days held. Makes a scalp and a swing comparable.
 *   annualisedPct — per-day × 365, reported at AGGREGATE level only.
 *
 * Annualising a single trade is where this metric usually turns into nonsense:
 * one lucky intraday scalp becomes "+5,000% annualised" and the report stops
 * being believable. So individual trades never show an annualised figure —
 * only the segment and portfolio rollups, where the sample makes it meaningful.
 */

import { capitalBlocked, marginKey, type MarginRates } from "@/lib/risk/margin";

/** One closed trade, in the shape ROM needs. */
export interface RomTrade {
  id: number;
  symbol: string;
  broker: string;
  bucket: string;
  segment: string;
  instrumentType: string; // equity | option | future
  optionType: string | null; // CE | PE | null
  strike: number | null;
  buyQty: number;
  avgBuyPrice: number;
  buyValue: number;
  sellQty: number;
  avgSellPrice: number;
  sellValue: number;
  netPnl: number;
  buyDate: string | null;
  sellDate: string | null;
  playbookId: number | null;
  setupTag: string | null;
}

export interface RomRow {
  id: number;
  symbol: string;
  segment: string;
  side: "long" | "short";
  netPnl: number;
  /** Capital actually tied up, per the shared margin rule. */
  capital: number;
  /** How that capital figure was derived — shown in the UI, not decoration. */
  basis: string;
  daysHeld: number;
  romPct: number | null;
  romPerDayPct: number | null;
  /** True when no margin rate was configured and 100% was assumed, which
   *  UNDERSTATES ROM. Surfaced so the number is never trusted blindly. */
  rateAssumed: boolean;
}

export interface RomGroup {
  key: string;
  label: string;
  trades: number;
  netPnl: number;
  /** Σ capital × days — the capital-time actually consumed. */
  capitalDays: number;
  totalCapital: number;
  avgDaysHeld: number;
  /** P&L ÷ total capital deployed across the group. */
  romPct: number | null;
  /** Weighted by capital-days, so a large slow position counts more than a
   *  small fast one — the whole point of the metric. */
  romPerDayPct: number | null;
  /** Raw linear extrapolation (per-day × 365). Kept uncapped for export
   *  fidelity — read `annualisedDisplayPct` for anything user-facing. */
  annualisedPct: number | null;
  /** Presentation-safe annualised figure, floored at -100%. */
  annualisedDisplayPct: number | null;
  /** True when the raw extrapolation left the range where it means anything —
   *  either it implied losing more than the capital, or it ran past +1000%. */
  annualisedIsExtrapolation: boolean;
  winRate: number | null;
}

export interface RomReport {
  rows: RomRow[];
  bySegment: RomGroup[];
  byPlaybook: RomGroup[];
  overall: RomGroup;
  /** Segments that fell back to a 100% margin assumption. */
  missingRates: string[];
  /** Trades excluded because capital could not be established. */
  skipped: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Calendar days a position was held. Same-day trades count as 1, not 0 —
 *  dividing by zero days is undefined, and intraday capital was still used. */
export function daysHeld(buyDate: string | null, sellDate: string | null): number {
  if (!buyDate || !sellDate) return 1;
  const a = new Date(buyDate).getTime();
  const b = new Date(sellDate).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 1;
  return Math.max(1, Math.round(Math.abs(b - a) / 86_400_000));
}

/** A trade opened by selling is short — same convention as the trackers. */
export function sideOf(t: Pick<RomTrade, "buyQty" | "sellQty" | "buyDate" | "sellDate">): "long" | "short" {
  if (t.buyDate && t.sellDate) return new Date(t.sellDate) < new Date(t.buyDate) ? "short" : "long";
  return t.sellQty > t.buyQty ? "short" : "long";
}

/**
 * Capital blocked for a CLOSED trade, via the shared rule.
 *
 * `entry` is the price the position was opened at, which for a short is the
 * sell price — getting this backwards would price a short option off its exit.
 */
export function capitalForTrade(t: RomTrade, rates: MarginRates): { capital: number; basis: string; rateAssumed: boolean } {
  const side = sideOf(t);
  const qty = Math.max(t.buyQty, t.sellQty);
  const entry = side === "short" ? t.avgSellPrice : t.avgBuyPrice;

  const { margin, basis, missingRate } = capitalBlocked(
    {
      id: t.id,
      symbol: t.symbol,
      bucket: t.bucket,
      broker: t.broker,
      segment: t.segment,
      side,
      qty,
      entry,
      // For a closed trade there is no live mark; the entry price is the
      // honest stand-in for contract value at the time capital was committed.
      mtm: entry,
      strike: t.strike,
      optionType: t.optionType,
      spot: null,
    },
    rates,
  );

  return { capital: r2(margin), basis, rateAssumed: missingRate != null };
}

function emptyGroup(key: string, label: string): RomGroup {
  return {
    key, label, trades: 0, netPnl: 0, capitalDays: 0, totalCapital: 0,
    avgDaysHeld: 0, romPct: null, romPerDayPct: null, annualisedPct: null,
    annualisedDisplayPct: null, annualisedIsExtrapolation: false, winRate: null,
  };
}

/** Roll a set of rows into one group. */
function summarise(key: string, label: string, rows: RomRow[]): RomGroup {
  if (rows.length === 0) return emptyGroup(key, label);

  const netPnl = rows.reduce((s, r) => s + r.netPnl, 0);
  const totalCapital = rows.reduce((s, r) => s + r.capital, 0);
  const capitalDays = rows.reduce((s, r) => s + r.capital * r.daysHeld, 0);
  const wins = rows.filter((r) => r.netPnl > 0).length;
  const avgDaysHeld = rows.reduce((s, r) => s + r.daysHeld, 0) / rows.length;

  const romPct = totalCapital > 0 ? r2((netPnl / totalCapital) * 100) : null;
  // Capital-days weighting: ₹1L held 10 days is ten times the commitment of
  // ₹1L held 1 day, and the per-day return must reflect that.
  const romPerDayPct = capitalDays > 0 ? r4((netPnl / capitalDays) * 100) : null;

  const annualisedPct = romPerDayPct != null ? r2(romPerDayPct * 365) : null;
  const { display: annualisedDisplayPct, extrapolated: annualisedIsExtrapolation } =
    presentAnnualised(annualisedPct);

  return {
    key,
    label,
    trades: rows.length,
    netPnl: r2(netPnl),
    capitalDays: r2(capitalDays),
    totalCapital: r2(totalCapital),
    avgDaysHeld: r2(avgDaysHeld),
    romPct,
    romPerDayPct,
    annualisedPct,
    annualisedDisplayPct,
    annualisedIsExtrapolation,
    winRate: rows.length > 0 ? r2((wins / rows.length) * 100) : null,
  };
}

/**
 * Make an annualised figure presentable without lying about it.
 *
 * Annualising is a LINEAR extrapolation (per-day × 365), and it stops meaning
 * anything at the extremes. A book of one-day option trades losing 10%/day
 * extrapolates to -3,887% — arithmetically correct and completely impossible,
 * because you cannot lose more than the capital you put up. Printing that makes
 * an otherwise honest report look unserious.
 *
 * So: floor the downside at -100% (total loss of capital), flag anything past
 * +1000% as extrapolation, and let the caller mark it in the UI. The raw value
 * stays on the group for exports.
 */
export function presentAnnualised(raw: number | null): { display: number | null; extrapolated: boolean } {
  if (raw == null) return { display: null, extrapolated: false };
  if (raw < -100) return { display: -100, extrapolated: true };
  if (raw > 1000) return { display: 1000, extrapolated: true };
  return { display: raw, extrapolated: false };
}

export interface RomOptions {
  /** Display names for playbooks, keyed by id. */
  playbookNames?: Record<number, string>;
  /** Human labels for segments. */
  segmentLabels?: Record<string, string>;
}

/**
 * The whole report. Only CLOSED trades count — an open position has not
 * finished using its capital, so including it would report a return on money
 * still at work.
 */
export function romReport(trades: RomTrade[], rates: MarginRates, opts: RomOptions = {}): RomReport {
  const rows: RomRow[] = [];
  const missing = new Set<string>();
  let skipped = 0;

  for (const t of trades) {
    const { capital, basis, rateAssumed } = capitalForTrade(t, rates);

    // No capital means no denominator; reporting an infinite return would be
    // worse than reporting nothing.
    if (!(capital > 0)) {
      skipped++;
      continue;
    }
    if (rateAssumed) missing.add(marginKey(t.broker, t.segment));

    const d = daysHeld(t.buyDate, t.sellDate);
    const romPct = r2((t.netPnl / capital) * 100);

    rows.push({
      id: t.id,
      symbol: t.symbol,
      segment: t.segment,
      side: sideOf(t),
      netPnl: r2(t.netPnl),
      capital,
      basis,
      daysHeld: d,
      romPct,
      romPerDayPct: r4(romPct / d),
      rateAssumed,
    });
  }

  // Segment rollup, best capital efficiency first.
  const segMap = new Map<string, RomRow[]>();
  for (const r of rows) {
    const arr = segMap.get(r.segment) ?? [];
    arr.push(r);
    segMap.set(r.segment, arr);
  }
  const bySegment = [...segMap.entries()]
    .map(([seg, rs]) => summarise(seg, opts.segmentLabels?.[seg] ?? seg, rs))
    .sort((a, b) => (b.romPerDayPct ?? -Infinity) - (a.romPerDayPct ?? -Infinity));

  // Playbook rollup — only trades actually tagged to one.
  const tradeById = new Map(trades.map((t) => [t.id, t]));
  const pbMap = new Map<number, RomRow[]>();
  for (const r of rows) {
    const pid = tradeById.get(r.id)?.playbookId;
    if (pid == null) continue;
    const arr = pbMap.get(pid) ?? [];
    arr.push(r);
    pbMap.set(pid, arr);
  }
  const byPlaybook = [...pbMap.entries()]
    .map(([pid, rs]) => summarise(String(pid), opts.playbookNames?.[pid] ?? `Playbook #${pid}`, rs))
    .sort((a, b) => (b.romPerDayPct ?? -Infinity) - (a.romPerDayPct ?? -Infinity));

  return {
    rows: rows.sort((a, b) => (b.romPerDayPct ?? -Infinity) - (a.romPerDayPct ?? -Infinity)),
    bySegment,
    byPlaybook,
    overall: summarise("all", "All segments", rows),
    missingRates: [...missing].sort(),
    skipped,
  };
}

/**
 * The comparison this report exists to make: which segment turned capital over
 * most efficiently. Returns null below `minTrades` on either side, because
 * "F&O beats delivery" off three trades is noise, not a finding.
 */
export function capitalEfficiencyVerdict(report: RomReport, minTrades = 10): string | null {
  const eligible = report.bySegment.filter((g) => g.trades >= minTrades && g.romPerDayPct != null);
  if (eligible.length < 2) return null;

  const best = eligible[0];
  const worst = eligible[eligible.length - 1];
  if (best.key === worst.key) return null;

  return `${best.label} returned ${best.romPerDayPct}%/day on capital vs ${worst.romPerDayPct}%/day for ${worst.label} — over ${best.trades} and ${worst.trades} trades respectively.`;
}
