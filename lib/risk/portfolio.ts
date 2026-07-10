// P1.2 — Portfolio risk v2 (PURE, no DB/React): VaR/CVaR, per-symbol beta,
// beta-weighted exposure and Greeks-based stress scenarios.
//
// Approach: DELTA-NORMAL. Each position contributes a delta-equivalent ₹ exposure
// to its underlying (equity: qty × mtm, sign by side; options: the position delta
// × spot — already signed by side in lib/analytics/greeks.ts). Portfolio 1-day P&L
// is then Σ exposure_i × underlyingReturn_i,t over the COMMON date grid of the
// symbols' return histories.
//
// Honesty rules (sparse local data is the norm — bhavcopy pastes, not a feed):
//   • a symbol with fewer than `minDays` overlapping returns is UNCOVERED — its
//     exposure is excluded from VaR and reported, never silently assumed.
//   • daysUsed/coveragePct ship with every result so the UI can badge confidence.
//   • VaR is a 1-day, ₹-positive loss magnitude (0 when the tail is a gain).

export interface RetPoint {
  date: string; // ISO
  ret: number; // fractional daily return
}

export interface VarPosition {
  id: number;
  symbol: string; // canonical ticker used in the returns map
  exposure: number; // delta-equivalent ₹ exposure to the underlying (signed; short < 0)
}

export interface PortfolioVar {
  daysUsed: number;
  var95: number; // ₹, historical
  var99: number;
  cvar95: number; // ₹, mean loss beyond VaR95
  parametricVar95: number; // ₹, z·σ (mean-zero normal)
  parametricVar99: number;
  sigmaDaily: number; // ₹ std-dev of the simulated daily P&L
  coveredExposure: number; // Σ|exposure| with usable history
  uncoveredExposure: number; // Σ|exposure| without
  coveragePct: number; // covered / total, by |exposure|
  uncoveredSymbols: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const Z95 = 1.645;
const Z99 = 2.326;

/** p-quantile (linear interpolation) of an ASCENDING-sorted array. */
function quantileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Historical + parametric 1-day VaR/CVaR of the open portfolio.
 * @param positions delta-equivalent exposures (one per position; same symbol may repeat)
 * @param returnsBySymbol per-symbol daily return series (canonical ticker → returns)
 * @param minDays minimum overlapping days for a symbol to count (default 30)
 */
export function computePortfolioVar(
  positions: VarPosition[],
  returnsBySymbol: Map<string, RetPoint[]>,
  minDays = 30,
): PortfolioVar | null {
  // Net exposures per symbol (a hedged book nets before it risks).
  const bySymbol = new Map<string, number>();
  for (const p of positions) bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + p.exposure);

  const covered: { symbol: string; exposure: number; rets: Map<string, number> }[] = [];
  const uncovered: { symbol: string; exposure: number }[] = [];
  for (const [symbol, exposure] of bySymbol) {
    if (exposure === 0) continue;
    const series = returnsBySymbol.get(symbol);
    if (!series || series.length < minDays) {
      uncovered.push({ symbol, exposure });
      continue;
    }
    covered.push({ symbol, exposure, rets: new Map(series.map((r) => [r.date, r.ret])) });
  }
  if (covered.length === 0) return null;

  // Common date grid — every covered symbol must have a return that day.
  let dates = [...covered[0].rets.keys()];
  for (const c of covered.slice(1)) dates = dates.filter((d) => c.rets.has(d));
  dates.sort();
  if (dates.length < minDays) return null;

  const pnl = dates.map((d) => covered.reduce((s, c) => s + c.exposure * (c.rets.get(d) ?? 0), 0));
  const sorted = [...pnl].sort((a, b) => a - b);

  const var95 = Math.max(0, -quantileSorted(sorted, 0.05));
  const var99 = Math.max(0, -quantileSorted(sorted, 0.01));
  const tailCut = quantileSorted(sorted, 0.05);
  const tail = sorted.filter((x) => x <= tailCut);
  const cvar95 = Math.max(0, -(tail.reduce((s, x) => s + x, 0) / Math.max(tail.length, 1)));

  const mean = pnl.reduce((s, x) => s + x, 0) / pnl.length;
  const sigma = Math.sqrt(pnl.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(pnl.length - 1, 1));

  const coveredExposure = covered.reduce((s, c) => s + Math.abs(c.exposure), 0);
  const uncoveredExposure = uncovered.reduce((s, c) => s + Math.abs(c.exposure), 0);
  const total = coveredExposure + uncoveredExposure;

  return {
    daysUsed: dates.length,
    var95: r2(var95),
    var99: r2(var99),
    cvar95: r2(cvar95),
    parametricVar95: r2(Z95 * sigma),
    parametricVar99: r2(Z99 * sigma),
    sigmaDaily: r2(sigma),
    coveredExposure: r2(coveredExposure),
    uncoveredExposure: r2(uncoveredExposure),
    coveragePct: total > 0 ? r2((coveredExposure / total) * 100) : 0,
    uncoveredSymbols: uncovered.map((u) => u.symbol).sort(),
  };
}

// ---------------------------------------------------------------------------
// Beta vs the index
// ---------------------------------------------------------------------------

/** OLS beta of a symbol vs the benchmark over their overlapping dates. */
export function symbolBeta(symbolReturns: RetPoint[], benchReturns: RetPoint[], minDays = 30): { beta: number; days: number } | null {
  const bench = new Map(benchReturns.map((r) => [r.date, r.ret]));
  const pairs: [number, number][] = [];
  for (const s of symbolReturns) {
    const b = bench.get(s.date);
    if (b != null) pairs.push([s.ret, b]);
  }
  if (pairs.length < minDays) return null;
  const n = pairs.length;
  const meanS = pairs.reduce((s, [x]) => s + x, 0) / n;
  const meanB = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let cov = 0, varB = 0;
  for (const [x, y] of pairs) {
    cov += (x - meanS) * (y - meanB);
    varB += (y - meanB) ** 2;
  }
  // Epsilon, not ===0: a constant benchmark accumulates ~1e-19 float noise in varB,
  // which would otherwise "divide fine" and emit a meaningless beta.
  if (varB < 1e-12) return null;
  return { beta: Math.round((cov / varB) * 100) / 100, days: n };
}

export interface BetaPosition {
  id: number;
  symbol: string;
  exposure: number; // delta-equivalent ₹, signed
  beta: number | null; // null = no usable history → falls back to 1, flagged
}

export interface BetaExposure {
  grossExposure: number; // Σ|exposure|
  netExposure: number; // Σ exposure (signed)
  betaWeightedExposure: number; // Σ exposure × β — the "NIFTY-equivalent" directional ₹
  withBetaPct: number; // share of gross exposure with a real (non-fallback) beta
  positions: { id: number; symbol: string; exposure: number; beta: number; betaIsFallback: boolean }[];
}

/** Net directional exposure in index terms. Unknown beta falls back to 1 (flagged). */
export function betaWeightedExposure(positions: BetaPosition[]): BetaExposure {
  const rows = positions.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    exposure: r2(p.exposure),
    beta: p.beta ?? 1,
    betaIsFallback: p.beta == null,
  }));
  const gross = rows.reduce((s, p) => s + Math.abs(p.exposure), 0);
  const withBeta = rows.filter((p) => !p.betaIsFallback).reduce((s, p) => s + Math.abs(p.exposure), 0);
  return {
    grossExposure: r2(gross),
    netExposure: r2(rows.reduce((s, p) => s + p.exposure, 0)),
    betaWeightedExposure: r2(rows.reduce((s, p) => s + p.exposure * p.beta, 0)),
    withBetaPct: gross > 0 ? r2((withBeta / gross) * 100) : 0,
    positions: rows,
  };
}

// ---------------------------------------------------------------------------
// Stress scenarios (delta-gamma-vega)
// ---------------------------------------------------------------------------

export interface StressPosition {
  id: number;
  symbol: string;
  exposure: number; // delta-equivalent ₹ (equity: value; options: positionDelta × spot)
  beta: number; // vs the shocked index (1 = moves with it)
  // Option second-order terms — POSITION-level Greeks (already qty-scaled & side-signed):
  gamma?: number | null; // per ₹1 underlying move
  vega?: number | null; // per 1 IV percentage-point
  spot?: number | null; // underlying spot (needed to turn % market move into ΔS)
}

export interface StressScenario {
  label: string;
  marketPct: number; // index move, e.g. -5 = NIFTY −5%
  ivShiftPts: number; // IV move in percentage points, e.g. +20
}

export const DEFAULT_SCENARIOS: StressScenario[] = [
  { label: "NIFTY −5%", marketPct: -5, ivShiftPts: 0 },
  { label: "NIFTY −3%", marketPct: -3, ivShiftPts: 0 },
  { label: "NIFTY +3%", marketPct: 3, ivShiftPts: 0 },
  { label: "NIFTY +5%", marketPct: 5, ivShiftPts: 0 },
  { label: "IV +10 pts", marketPct: 0, ivShiftPts: 10 },
  { label: "Crash: −5% & IV +20", marketPct: -5, ivShiftPts: 20 },
];

export interface StressResult {
  scenario: StressScenario;
  pnl: number; // ₹ projected
  deltaPnl: number;
  gammaPnl: number;
  vegaPnl: number;
}

/**
 * Project P&L per scenario: ΔP ≈ Σ [exposure·β·m + ½·Γ·(ΔS)² + V·Δiv], where
 * m = market move (fraction) and ΔS = spot·β·m per underlying. First-order works
 * for everything; Γ/V terms only where option Greeks are supplied.
 */
export function stressScenarios(
  positions: StressPosition[],
  scenarios: StressScenario[] = DEFAULT_SCENARIOS,
): StressResult[] {
  return scenarios.map((sc) => {
    const m = sc.marketPct / 100;
    let deltaPnl = 0, gammaPnl = 0, vegaPnl = 0;
    for (const p of positions) {
      deltaPnl += p.exposure * p.beta * m;
      if (p.gamma != null && p.spot != null && p.spot > 0) {
        const dS = p.spot * p.beta * m;
        gammaPnl += 0.5 * p.gamma * dS * dS;
      }
      if (p.vega != null) vegaPnl += p.vega * sc.ivShiftPts;
    }
    return {
      scenario: sc,
      pnl: r2(deltaPnl + gammaPnl + vegaPnl),
      deltaPnl: r2(deltaPnl),
      gammaPnl: r2(gammaPnl),
      vegaPnl: r2(vegaPnl),
    };
  });
}

/** closes → daily fractional returns (date = the later day). */
export function closesToReturnSeries(closes: { date: string; close: number }[]): RetPoint[] {
  const sorted = [...closes].sort((a, b) => a.date.localeCompare(b.date));
  const out: RetPoint[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].close;
    if (prev > 0) out.push({ date: sorted[i].date, ret: sorted[i].close / prev - 1 });
  }
  return out;
}
