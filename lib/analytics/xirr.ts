// P1.1 (completion) — XIRR money-weighted return (PURE, no DB/React). Paise cashflows.
//
// XIRR is the annualized rate r that makes the net present value of dated cashflows
// zero:  Σ amount_i / (1+r)^(years_i) = 0.  Money you put IN is a negative cashflow,
// money/equity you get OUT is positive. Unlike time-weighted return it accounts for
// the size AND timing of contributions/withdrawals — the institutional "what did MY
// money actually earn" number. Solved by Newton-Raphson with a bisection fallback.

export interface CashFlow {
  date: string; // ISO
  amountPaise: number; // signed: − = invested, + = returned
}

const DAY = 86400000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function yearsBetween(base: string, d: string): number {
  return (new Date(d + "T00:00:00").getTime() - new Date(base + "T00:00:00").getTime()) / (DAY * 365);
}

/**
 * @returns annualized rate as a fraction (0.18 = 18%), or null if it can't be solved
 *          (needs ≥2 flows with at least one positive and one negative).
 */
export function xirr(flows: CashFlow[]): number | null {
  const fs = flows.filter((f) => f.date && Number.isFinite(f.amountPaise) && f.amountPaise !== 0);
  if (fs.length < 2) return null;
  if (!fs.some((f) => f.amountPaise > 0) || !fs.some((f) => f.amountPaise < 0)) return null;

  const base = fs.reduce((m, f) => (f.date < m ? f.date : m), fs[0].date);
  const ts = fs.map((f) => ({ amt: f.amountPaise, t: yearsBetween(base, f.date) }));
  const npv = (r: number) => ts.reduce((s, c) => s + c.amt / Math.pow(1 + r, c.t), 0);
  const dnpv = (r: number) => ts.reduce((s, c) => s - (c.t * c.amt) / Math.pow(1 + r, c.t + 1), 0);

  // Newton-Raphson.
  let r = 0.1;
  for (let i = 0; i < 60; i++) {
    const y = npv(r);
    if (Math.abs(y) < 1) return round4(r); // within 1 paisa
    const dy = dnpv(r);
    if (!Number.isFinite(dy) || dy === 0) break;
    let nr = r - y / dy;
    if (!Number.isFinite(nr)) break;
    if (nr <= -0.9999) nr = -0.9999 + 1e-6;
    if (Math.abs(nr - r) < 1e-8) return round4(nr);
    r = nr;
  }

  // Bisection fallback on a wide bracket.
  let lo = -0.9999;
  let hi = 100;
  let flo = npv(lo);
  if (flo * npv(hi) > 0) return null; // no sign change → unsolvable in range
  for (let i = 0; i < 240; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1 || hi - lo < 1e-9) return round4(mid);
    if (flo * fm < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return round4((lo + hi) / 2);
}
