// IND-3 — Tax-loss harvesting assistant (PURE, no DB/React).
//
// India has NO wash-sale rule, so booking an unrealised loss before 31-Mar to
// offset realised capital gains — then (optionally) re-buying — is legitimate.
// Set-off rules (capital assets, i.e. equity delivery):
//   • Short-term capital LOSS (STCL) → offsets STCG first, then LTCG.
//   • Long-term capital LOSS  (LTCL) → offsets LTCG only.
//   • LTCG enjoys a ₹1.25L annual exemption (FY2024-25 onward).
// Rates are RESOLVED BY DATE from lib/analytics/capital-gains.ts, not hardcoded
// here. F&O / intraday are business income — NOT eligible — so the caller passes
// equity-delivery lots only.
//
// On the law, stated precisely because this is where journals give bad advice:
// there is no wash-sale rule in the Income-tax Act, 2025, and GAAR is out of
// reach for retail (Rule 128 of the Income-tax Rules, 2026 disapplies Chapter XI
// below ₹3 crore of aggregate tax benefit). The residual exposure is the
// ordinary colourable-device doctrine applied to a trade where beneficial
// ownership never really changed. NEVER tell the user to wait N days before
// re-buying: that implies a rule India does not have.

import { capitalGainsRatesFor } from "./capital-gains";

export type Term = "ST" | "LT";

export interface OpenLot {
  id: number;
  symbol: string;
  qty: number;
  entry: number;
  mtm: number;
  term: Term;
  unrealised: number; // (mtm − entry) × qty ; negative = loss
}

export interface HarvestRates {
  stcgPct: number;
  ltcgPct: number;
  ltcgExemption: number;
}

// There is deliberately NO `CG_RATES` constant here any more. It held a second,
// hardcoded copy of the post-23-Jul-2024 pair while `capitalGainsRatesFor`
// resolved by date, so the two modules could disagree on a historical year.
// Replacing it with a clock read would only have moved the staleness. Callers
// take the schedule from `capitalGainsRatesFor(date)`, which is the one source.

export interface HarvestCandidate {
  id: number;
  symbol: string;
  qty: number;
  term: Term;
  loss: number; // positive magnitude
  offsetAmount: number; // portion that offsets a gain now
  status: "offsets" | "partial" | "carry";
}

export interface HarvestReport {
  daysToFyEnd: number;
  realisedStcg: number;
  realisedLtcg: number;
  stLoss: number; // total harvestable ST loss (magnitude)
  ltLoss: number;
  stclVsStcg: number;
  stclVsLtcg: number;
  ltclVsLtcg: number;
  taxSaved: number; // estimated tax saved by harvesting the offsetting losses
  carryForward: number; // losses beyond offsettable gains (carry to future FYs)
  candidates: HarvestCandidate[]; // loss lots, ST then LT, largest first
  rates: HarvestRates;
}

const rupee = (n: number) => Math.round(n);

export function daysBetween(a: string, b: string): number {
  const x = new Date(a + "T00:00:00").getTime();
  const y = new Date(b + "T00:00:00").getTime();
  if (Number.isNaN(x) || Number.isNaN(y)) return 0;
  return Math.max(0, Math.round((y - x) / 86400000));
}

// ── FY window ───────────────────────────────────────────────────────────────

export interface FyWindow {
  fyStartYear: number;
  /** First day of the FY containing `today` (YYYY-MM-DD). */
  fyStart: string;
  /** Last day of that FY — the day BEFORE the next FY starts (YYYY-MM-DD). */
  fyEnd: string;
  /** e.g. "2026-27". */
  fyLabel: string;
}

/**
 * The FY window containing `today`, derived from the configured FY start month.
 * The end is computed as the day before the next FY starts — the page used to
 * hardcode `${fyStartYear + 1}-03-31`, which is wrong for any fyStartMonth
 * other than April (a January FY ends 31-Dec, not 31-Mar).
 */
export function fyWindowFor(today: string, fyStartMonth: number): FyWindow {
  const [y, m] = today.split("-").map(Number);
  const fyStartYear = m >= fyStartMonth ? y : y - 1;
  const fyStart = `${fyStartYear}-${String(fyStartMonth).padStart(2, "0")}-01`;
  // Day 0 of the next FY's start month is the last day of the month before it.
  const fyEnd = new Date(Date.UTC(fyStartYear + 1, fyStartMonth - 1, 0)).toISOString().slice(0, 10);
  const fyLabel = `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;
  return { fyStartYear, fyStart, fyEnd, fyLabel };
}

// ── LTCG exemption headroom ─────────────────────────────────────────────────

/**
 * Rupees of the annual long-term exemption not yet consumed by taxable realised
 * LTCG this FY, floored at 0. A realised long-term LOSS does not enlarge the
 * headroom beyond the threshold — the exemption caps at itself.
 *
 * This is an UPPER BOUND on the user's real headroom: the threshold is per
 * PERSON per tax year across every qualifying gain they have anywhere, and the
 * journal sees only imported gains. Render it WITH `LTCG_THRESHOLD_CAVEAT`
 * (lib/analytics/tax-levers.ts), never bare.
 */
export function ltcgExemptionHeadroom(realisedLtcg: number, exemption: number): number {
  return rupee(Math.max(0, exemption - Math.max(0, realisedLtcg)));
}

// ── Partial-lot simulation ──────────────────────────────────────────────────

/**
 * A lot restricted to `qty` units for what-if simulation. Unrealised P&L scales
 * proportionally: an open lot carries one weighted-average entry price, so every
 * unit has the same per-unit basis. `qty` is floored to whole units and clamped
 * to [0, lot.qty].
 */
export function partialLot(lot: OpenLot, qty: number): OpenLot {
  const q = Math.min(Math.max(0, Math.floor(qty)), lot.qty);
  const frac = lot.qty > 0 ? q / lot.qty : 0;
  // `|| 0` normalises the -0 a loss × 0-fraction produces.
  return { ...lot, qty: q, unrealised: lot.unrealised * frac || 0 };
}

/** Walk loss lots (largest first), allocating up to `offsettable` and tagging status. */
function allocate(lots: OpenLot[], offsettable: number): HarvestCandidate[] {
  let remaining = offsettable;
  return lots
    .slice()
    .sort((a, b) => Math.abs(b.unrealised) - Math.abs(a.unrealised))
    .map((l) => {
      const loss = Math.abs(l.unrealised);
      const offsetAmount = Math.min(loss, Math.max(0, remaining));
      remaining -= offsetAmount;
      const status: HarvestCandidate["status"] =
        offsetAmount >= loss - 0.5 ? "offsets" : offsetAmount > 0 ? "partial" : "carry";
      return { id: l.id, symbol: l.symbol, qty: l.qty, term: l.term, loss: rupee(loss), offsetAmount: rupee(offsetAmount), status };
    });
}

export function computeHarvest(
  lots: OpenLot[],
  realisedStcg: number,
  realisedLtcg: number,
  today: string,
  fyEnd: string,
  // Resolved from the date the loss would be booked, matching capital-gains.ts.
  rates: HarvestRates = capitalGainsRatesFor(today),
): HarvestReport {
  const stLots = lots.filter((l) => l.term === "ST" && l.unrealised < 0);
  const ltLots = lots.filter((l) => l.term === "LT" && l.unrealised < 0);
  const stLoss = stLots.reduce((s, l) => s + Math.abs(l.unrealised), 0);
  const ltLoss = ltLots.reduce((s, l) => s + Math.abs(l.unrealised), 0);

  const stcg = Math.max(0, realisedStcg);
  const ltcg = Math.max(0, realisedLtcg);

  // STCL → STCG, then leftover STCL → LTCG.
  const stclVsStcg = Math.min(stLoss, stcg);
  let remStcl = stLoss - stclVsStcg;
  let remLtcg = ltcg;
  const stclVsLtcg = Math.min(remStcl, remLtcg);
  remStcl -= stclVsLtcg;
  remLtcg -= stclVsLtcg;
  // LTCL → remaining LTCG only.
  const ltclVsLtcg = Math.min(ltLoss, remLtcg);
  const remLtcl = ltLoss - ltclVsLtcg;

  // Tax saved. ST gains are fully taxable; LT gains net of the annual exemption.
  const savedSt = stclVsStcg * rates.stcgPct;
  const taxableLtBefore = Math.max(0, ltcg - rates.ltcgExemption);
  const taxableLtAfter = Math.max(0, ltcg - stclVsLtcg - ltclVsLtcg - rates.ltcgExemption);
  const savedLt = (taxableLtBefore - taxableLtAfter) * rates.ltcgPct;

  const candidates = [
    ...allocate(stLots, stclVsStcg + stclVsLtcg),
    ...allocate(ltLots, ltclVsLtcg),
  ];

  return {
    daysToFyEnd: daysBetween(today, fyEnd),
    realisedStcg: rupee(realisedStcg),
    realisedLtcg: rupee(realisedLtcg),
    stLoss: rupee(stLoss),
    ltLoss: rupee(ltLoss),
    stclVsStcg: rupee(stclVsStcg),
    stclVsLtcg: rupee(stclVsLtcg),
    ltclVsLtcg: rupee(ltclVsLtcg),
    taxSaved: rupee(savedSt + savedLt),
    carryForward: rupee(remStcl + remLtcl),
    candidates,
    rates,
  };
}
