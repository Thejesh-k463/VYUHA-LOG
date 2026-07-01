// P1.1 (completion) — benchmark relative performance: alpha / beta vs an index
// series (e.g. NIFTY 50), PURE (no DB/React). Offline-first: the user pastes the
// index's daily closes; we derive its daily returns and regress the portfolio's
// daily returns against them (CAPM-style):
//
//   r_p − r_f  =  α  +  β·(r_b − r_f)  +  ε
//
//   β  — sensitivity to the market (1 = moves with it, >1 = amplified).
//   α  — return earned *beyond* what β·market explains (annualised). The edge.
//   R² — how much of the portfolio's variance the benchmark explains.

const TRADING_DAYS = 252;
const r2f = (n: number) => Math.round(n * 100) / 100;
const r4f = (n: number) => Math.round(n * 10000) / 10000;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

export interface BenchClose {
  date: string; // ISO YYYY-MM-DD
  close: number;
}

export interface ReturnByDate {
  date: string; // ISO
  ret: number; // fractional daily return
}

export interface BenchmarkStats {
  beta: number;
  alphaAnnualPct: number;
  correlation: number;
  rSquared: number;
  overlapDays: number; // paired daily returns used in the regression
  portfolioReturnPct: number; // chained over the overlap window
  benchmarkReturnPct: number; // chained over the overlap window
}

/** Coerce common Indian-CSV date shapes to ISO; returns null if unrecognised. */
export function toIsoDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  let m = t.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/); // 30-Jun-2026
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${m[1].padStart(2, "0")}`;
  }
  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // 30-06-2026 (day-month)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function parseNum(s: string): number {
  const n = Number(s.replace(/[^0-9.\-]/g, "")); // strip ₹, thousands commas, spaces
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parse a pasted index series. Each line is "DATE, CLOSE" (split on the first
 * delimiter, so thousands-separated closes like "24,000.50" survive). Header
 * lines and anything without a parseable date are skipped. Deduped by date.
 */
export function parseBenchmarkCsv(text: string): BenchClose[] {
  const out = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^,\s]+)[,\s]+(.+)$/);
    if (!m) continue;
    const date = toIsoDate(m[1]);
    if (!date) continue;
    const close = parseNum(m[2]);
    if (!Number.isFinite(close) || close <= 0) continue;
    out.set(date, close); // last value wins on dup
  }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, close]) => ({ date, close }));
}

/** Daily returns from a (date-sorted) close series. */
export function closesToReturns(closes: BenchClose[]): ReturnByDate[] {
  const cs = closes.slice().sort((a, b) => a.date.localeCompare(b.date));
  const out: ReturnByDate[] = [];
  for (let i = 1; i < cs.length; i++) {
    const prev = cs[i - 1].close;
    if (prev > 0) out.push({ date: cs[i].date, ret: cs[i].close / prev - 1 });
  }
  return out;
}

/**
 * Regress portfolio daily returns against benchmark daily returns over their
 * common dates. Returns null if fewer than 2 paired returns or the benchmark has
 * no variance (β undefined).
 *
 * @param portfolio       portfolio daily returns by date (e.g. performance series)
 * @param benchmarkCloses benchmark daily closes (raw, unsorted ok)
 * @param riskFreeAnnual  annual risk-free rate as a fraction (e.g. 0.07)
 */
export function computeBenchmark(
  portfolio: ReturnByDate[],
  benchmarkCloses: BenchClose[],
  riskFreeAnnual = 0,
): BenchmarkStats | null {
  const bench = closesToReturns(benchmarkCloses);
  const benchByDate = new Map(bench.map((b) => [b.date, b.ret]));

  // Pair on common dates only.
  const rp: number[] = [];
  const rb: number[] = [];
  for (const p of portfolio) {
    const b = benchByDate.get(p.date);
    if (b == null) continue;
    rp.push(p.ret);
    rb.push(b);
  }
  const n = rp.length;
  if (n < 2) return null;

  const rf = riskFreeAnnual / TRADING_DAYS;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mp = mean(rp);
  const mb = mean(rb);

  let cov = 0; // raw returns
  let varB = 0;
  let varP = 0;
  let covE = 0; // excess returns (for β/α)
  let varBE = 0;
  for (let i = 0; i < n; i++) {
    cov += (rp[i] - mp) * (rb[i] - mb);
    varB += (rb[i] - mb) * (rb[i] - mb);
    varP += (rp[i] - mp) * (rp[i] - mp);
    covE += (rp[i] - rf - (mp - rf)) * (rb[i] - rf - (mb - rf));
    varBE += (rb[i] - rf - (mb - rf)) * (rb[i] - rf - (mb - rf));
  }
  if (varBE <= 0) return null;

  const beta = covE / varBE;
  const alphaDaily = mp - rf - beta * (mb - rf);
  const sdP = Math.sqrt(varP);
  const sdB = Math.sqrt(varB);
  const correlation = sdP > 0 && sdB > 0 ? cov / (sdP * sdB) : 0;

  const chain = (xs: number[]) => xs.reduce((g, r) => g * (1 + r), 1) - 1;

  return {
    beta: r4f(beta),
    alphaAnnualPct: r2f(alphaDaily * TRADING_DAYS * 100),
    correlation: r4f(correlation),
    rSquared: r4f(correlation * correlation),
    overlapDays: n,
    portfolioReturnPct: r2f(chain(rp) * 100),
    benchmarkReturnPct: r2f(chain(rb) * 100),
  };
}
