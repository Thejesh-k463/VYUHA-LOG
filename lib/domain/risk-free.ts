// The risk-free rate (v4.4.0 D5) — PURE: the one place its ppm is turned into a
// fraction, a percentage and the label every figure that uses it prints.
//
// It used to be three hard-coded 7% copies (the performance and monthly pages,
// and the Greeks module), so a user who changed one mental number had Sharpe at
// one rate and the option Greeks discounting at another. Now it is ONE dated
// setting (`settings.risk_free_rate_ppm` + `risk_free_as_of`, migration 0073)
// read through `getRiskFree()` in lib/queries/settings.ts.

/** 7% — Vyuha's default ASSUMPTION (not a market quote), in ppm. */
export const DEFAULT_RISK_FREE_PPM = 70_000;
/** The accepted range: 0% to 20%, in ppm. */
export const RISK_FREE_MAX_PPM = 200_000;

export interface RiskFree {
  /** Annual rate as a fraction (0.07) — what the maths reads. */
  annual: number;
  ppm: number;
  /** "7%", "6.5%", "7.25%" — for `{riskFreePct}` in help prose. */
  pct: string;
  /** The day the user said this rate was true on; null = Vyuha's default. */
  asOf: string | null;
  /** "7% · Vyuha default" or "6.5% · as of 2026-09-18" — printed beside every figure. */
  label: string;
}

/** ppm → "7%" / "6.5%" / "7.25%" (never more than two decimals, no trailing zeros). */
export function ppmToPct(ppm: number): string {
  return `${Number((ppm / 10_000).toFixed(2))}%`;
}

/** The pair as stored → the rate every consumer reads. A missing ppm is the default. */
export function riskFreeOf(ppm: number | null | undefined, asOf: string | null | undefined): RiskFree {
  const p = typeof ppm === "number" && Number.isFinite(ppm) ? ppm : DEFAULT_RISK_FREE_PPM;
  const pct = ppmToPct(p);
  const date = asOf ?? null;
  return { annual: p / 1_000_000, ppm: p, pct, asOf: date, label: date ? `${pct} · as of ${date}` : `${pct} · Vyuha default` };
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day in YYYY-MM-DD form. */
function isIsoDay(s: string): boolean {
  const m = ISO.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Validate a user edit. The rate arrives as a PERCENT (6.5) and is stored as
 * ppm (65000); the date is required — a rate is a statement about a day — and
 * may not be after `todayIst` (IST). Returns the pair to store, or the sentence
 * to show.
 */
export function parseRiskFreeEdit(
  input: { ratePct: unknown; asOf: unknown },
  todayIst: string,
): { ok: true; ppm: number; asOf: string } | { ok: false; message: string } {
  const raw = typeof input.ratePct === "string" ? input.ratePct.trim() : input.ratePct;
  const pct = raw === "" || raw == null ? NaN : Number(raw);
  if (!Number.isFinite(pct)) return { ok: false, message: "Enter the risk-free rate as a percentage, for example 6.5." };
  const ppm = Math.round(pct * 10_000);
  if (ppm < 0 || ppm > RISK_FREE_MAX_PPM) {
    return { ok: false, message: `The risk-free rate must be between 0% and ${ppmToPct(RISK_FREE_MAX_PPM)}.` };
  }
  const asOf = typeof input.asOf === "string" ? input.asOf.trim() : "";
  if (!isIsoDay(asOf)) return { ok: false, message: "Give the date this rate was true on (YYYY-MM-DD)." };
  if (asOf > todayIst) return { ok: false, message: "The as-of date cannot be in the future." };
  return { ok: true, ppm, asOf };
}
