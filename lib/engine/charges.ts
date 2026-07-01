import type { ChargeBreakdown, ChargeInput, ChargeRates } from "./types";
import { roundRupee, toRupees } from "@/lib/money";

// P0.1: the engine now computes natively in INTEGER PAISE. `computeChargesPaise`
// is the paise-native core; `computeCharges` is a thin rupee wrapper that keeps
// the existing rupee-in/rupee-out API (so current callers and the REAL columns are
// untouched until the staged column migration switches them to paise reads).

/** Rupees → integer paise. */
const P = (rupees: number) => Math.round(rupees * 100);

export interface ChargeInputPaise {
  segment: ChargeInput["segment"];
  buyValue: number; // paise
  sellValue: number; // paise
  buyQty: number;
  sellQty: number;
  buyOrderCount?: number;
  sellOrderCount?: number;
  mtf?: { fundedAmount: number; daysHeld: number; pledgeScrips?: number } | null; // fundedAmount in paise
}

export interface ChargeBreakdownPaise {
  brokerage: number;
  sttCtt: number;
  exchangeTxn: number;
  sebi: number;
  stampDuty: number;
  ipft: number;
  gst: number;
  dpCharges: number;
  mtfInterest: number;
  pledgeCharges: number;
  total: number;
}

/**
 * Brokerage for one side (in paise): flat fee, or clamp(pct × turnover, floor, cap).
 * Returns fractional paise; the caller rounds the two-sided sum once.
 */
function brokerageForSidePaise(turnoverPaise: number, orders: number, rates: ChargeRates): number {
  if (orders <= 0 || turnoverPaise <= 0) return 0;
  if (rates.brokerageFlat != null) return P(rates.brokerageFlat) * orders;
  const perOrder = turnoverPaise / orders;
  let fee = rates.brokeragePct * perOrder;
  if (rates.brokerageCap != null) fee = Math.min(fee, P(rates.brokerageCap));
  fee = Math.max(fee, P(rates.brokerageFloor));
  return fee * orders;
}

/** Pick the annual MTF rate for a funded amount (tiered or flat). `fundedAmount` in rupees. */
export function mtfRateFor(fundedAmount: number, rates: ChargeRates): number {
  if (rates.mtfTiers && rates.mtfTiers.length > 0) {
    for (const tier of rates.mtfTiers) {
      if (tier.upTo == null || fundedAmount <= tier.upTo) return tier.rate;
    }
    return rates.mtfTiers[rates.mtfTiers.length - 1]!.rate;
  }
  return rates.mtfInterestAnnual;
}

/**
 * Pure charges engine in integer paise. STT/CTT and stamp round to the nearest
 * rupee (statutory); other components round to the nearest paisa. GST (18%) applies
 * to brokerage + exchange + sebi + ipft + dp(pre-GST) + pledge, never to STT/stamp.
 */
export function computeChargesPaise(input: ChargeInputPaise, rates: ChargeRates): ChargeBreakdownPaise {
  const buyOrders = input.buyOrderCount ?? (input.buyQty > 0 ? 1 : 0);
  const sellOrders = input.sellOrderCount ?? (input.sellQty > 0 ? 1 : 0);
  const turnover = input.buyValue + input.sellValue; // paise
  const isDeliveryLike = input.segment === "eq_delivery" || input.segment === "eq_mtf";

  const brokerage = Math.round(
    brokerageForSidePaise(input.buyValue, buyOrders, rates) +
      brokerageForSidePaise(input.sellValue, sellOrders, rates),
  );

  // STT / CTT (rounded to the nearest rupee, straight from the paise-float).
  let sttBase = 0;
  switch (rates.sttSide) {
    case "both": sttBase = input.buyValue + input.sellValue; break;
    case "buy": sttBase = input.buyValue; break;
    case "sell": sttBase = input.sellValue; break;
    default: sttBase = 0;
  }
  const sttCtt = roundRupee(rates.sttPct * sttBase);

  const exchangeTxn = Math.round(rates.exchangeTxnPct * turnover);
  const sebi = Math.round(rates.sebiPct * turnover);
  const stampDuty = roundRupee(rates.stampPct * input.buyValue);
  const ipft = Math.round(rates.ipftPct * turnover);

  let dpCharges = 0;
  let dpForGst = 0;
  if (isDeliveryLike && input.sellQty > 0 && input.sellValue >= P(rates.dpMinValue)) {
    dpCharges = P(rates.dpCharge);
    if (rates.dpGstApplicable) dpForGst = P(rates.dpCharge);
  }

  let mtfInterest = 0;
  let pledgeCharges = 0;
  if (input.segment === "eq_mtf" && input.mtf && input.mtf.fundedAmount > 0) {
    const rate = mtfRateFor(toRupees(input.mtf.fundedAmount), rates);
    mtfInterest = Math.round((input.mtf.fundedAmount * rate * Math.max(0, input.mtf.daysHeld)) / 365);
    const scrips = input.mtf.pledgeScrips ?? 1;
    pledgeCharges = Math.round((P(rates.pledgeCharge) + P(rates.unpledgeCharge)) * scrips);
  }

  const gst = Math.round(rates.gstPct * (brokerage + exchangeTxn + sebi + ipft + dpForGst + pledgeCharges));

  const total =
    brokerage + sttCtt + exchangeTxn + sebi + stampDuty + ipft + gst + dpCharges + mtfInterest + pledgeCharges;

  return { brokerage, sttCtt, exchangeTxn, sebi, stampDuty, ipft, gst, dpCharges, mtfInterest, pledgeCharges, total };
}

/** Rupee-API wrapper over the paise engine (unchanged contract for existing callers). */
export function computeCharges(input: ChargeInput, rates: ChargeRates): ChargeBreakdown {
  const p = computeChargesPaise(
    {
      segment: input.segment,
      buyValue: P(input.buyValue),
      sellValue: P(input.sellValue),
      buyQty: input.buyQty,
      sellQty: input.sellQty,
      buyOrderCount: input.buyOrderCount,
      sellOrderCount: input.sellOrderCount,
      mtf: input.mtf
        ? { fundedAmount: P(input.mtf.fundedAmount), daysHeld: input.mtf.daysHeld, pledgeScrips: input.mtf.pledgeScrips }
        : null,
    },
    rates,
  );
  return {
    brokerage: toRupees(p.brokerage),
    sttCtt: toRupees(p.sttCtt),
    exchangeTxn: toRupees(p.exchangeTxn),
    sebi: toRupees(p.sebi),
    stampDuty: toRupees(p.stampDuty),
    ipft: toRupees(p.ipft),
    gst: toRupees(p.gst),
    dpCharges: toRupees(p.dpCharges),
    mtfInterest: toRupees(p.mtfInterest),
    pledgeCharges: toRupees(p.pledgeCharges),
    total: toRupees(p.total),
  };
}
