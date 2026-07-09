// Monte Carlo resampling of the portfolio's own daily returns (PURE, no DB/React).
// Bootstrap: each simulated day draws a real historical daily return with replacement,
// so the simulation inherits the ACTUAL return distribution (fat tails included) without
// assuming normality. Deterministic via a seeded PRNG — testable and reproducible.
//
// Risk of ruin here = P(the equity path EVER dips to/below `ruinFrac` × start within the
// horizon) — a path-min statistic, not just terminal. This is the honest retail question:
// "how likely am I to lose half my capital in a year trading like I trade?"

export interface MonteCarloResult {
  paths: number;
  horizonDays: number;
  startEquity: number;
  ruinFrac: number; // e.g. 0.5 = ruin at −50% from start
  terminal: { p5: number; p25: number; p50: number; p75: number; p95: number; mean: number };
  riskOfRuinPct: number; // % of paths that ever touched the ruin level
  probLossPct: number; // % of paths ending below start
  sampleDays: number; // historical daily returns resampled from
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** mulberry32 — tiny deterministic PRNG, good enough for bootstrap resampling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * @param dailyReturns historical fractional daily returns (e.g. 0.004 = +0.4%)
 * @param startEquity  simulation starting equity (today's equity)
 * @param opts.horizonDays  simulated trading days (default 252 ≈ 1y)
 * @param opts.paths        number of simulated paths (default 2000)
 * @param opts.ruinFrac     ruin level as a fraction of start (default 0.5)
 * @param opts.seed         PRNG seed (default 42) — fixed for reproducible UI
 */
export function monteCarloEquity(
  dailyReturns: number[],
  startEquity: number,
  opts: { horizonDays?: number; paths?: number; ruinFrac?: number; seed?: number } = {},
): MonteCarloResult | null {
  const { horizonDays = 252, paths = 2000, ruinFrac = 0.5, seed = 42 } = opts;
  // Too little history and the bootstrap just replays noise — refuse below 20 days.
  if (dailyReturns.length < 20 || startEquity <= 0) return null;

  const rand = mulberry32(seed);
  const n = dailyReturns.length;
  const ruinLevel = startEquity * ruinFrac;

  const terminals: number[] = new Array(paths);
  let ruined = 0;
  let endedBelowStart = 0;

  for (let p = 0; p < paths; p++) {
    let equity = startEquity;
    let touchedRuin = false;
    for (let d = 0; d < horizonDays; d++) {
      const r = dailyReturns[Math.floor(rand() * n)];
      equity *= 1 + r;
      if (equity <= ruinLevel) touchedRuin = true;
      if (equity <= 0) { equity = 0; touchedRuin = true; break; }
    }
    terminals[p] = equity;
    if (touchedRuin) ruined++;
    if (equity < startEquity) endedBelowStart++;
  }

  terminals.sort((a, b) => a - b);
  const mean = terminals.reduce((s, x) => s + x, 0) / paths;

  return {
    paths,
    horizonDays,
    startEquity: r2(startEquity),
    ruinFrac,
    terminal: {
      p5: r2(percentile(terminals, 0.05)),
      p25: r2(percentile(terminals, 0.25)),
      p50: r2(percentile(terminals, 0.5)),
      p75: r2(percentile(terminals, 0.75)),
      p95: r2(percentile(terminals, 0.95)),
      mean: r2(mean),
    },
    riskOfRuinPct: r2((ruined / paths) * 100),
    probLossPct: r2((endedBelowStart / paths) * 100),
    sampleDays: n,
  };
}
