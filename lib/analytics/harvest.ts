// IND-3 — Tax-loss harvesting assistant (PURE, no DB/React).
//
// India has NO wash-sale rule, so booking an unrealised loss before 31-Mar to
// offset realised capital gains — then (optionally) re-buying — is legitimate.
// Set-off rules (capital assets, i.e. equity delivery):
//   • Short-term capital LOSS (STCL) → offsets STCG first, then LTCG.
//   • Long-term capital LOSS  (LTCL) → offsets LTCG only.
//   • LTCG enjoys a ₹1.25L annual exemption (FY2024-25 onward).
// Rates here are the post-23-Jul-2024 regime (STCG 20%, LTCG 12.5%). F&O / intraday
// are business income — NOT eligible — so the caller passes equity-delivery lots only.

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

export const CG_RATES: HarvestRates = { stcgPct: 0.2, ltcgPct: 0.125, ltcgExemption: 125000 };

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

function daysBetween(a: string, b: string): number {
  const x = new Date(a + "T00:00:00").getTime();
  const y = new Date(b + "T00:00:00").getTime();
  if (Number.isNaN(x) || Number.isNaN(y)) return 0;
  return Math.max(0, Math.round((y - x) / 86400000));
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
  rates: HarvestRates = CG_RATES,
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
