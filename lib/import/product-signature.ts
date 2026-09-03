/**
 * Reading the PRODUCT TYPE out of the charges a broker actually levied.
 *
 * ZERO DB and ZERO React imports; pure functions over plain numbers.
 *
 * ── Why this works ────────────────────────────────────────────────────────
 *
 * A transaction report often omits the product column, but it cannot omit the
 * statutory charges — and in India those charges are levied at DIFFERENT RATES
 * depending on the product. The rate is therefore a fingerprint:
 *
 *              stamp duty (on buy)      STT
 *   delivery   0.015%                   0.10%  on BOTH legs
 *   intraday   0.003%                   0.025% on the SELL leg only
 *
 * Two independent witnesses. Stamp duty is used as the primary signal because
 * it is charged on the buy leg alone and so is unaffected by how much of the
 * position was sold; STT then corroborates it. Agreement between the two is
 * what makes this an inference worth trusting rather than a guess.
 *
 * ── What this deliberately does NOT do ────────────────────────────────────
 *
 * It never infers MTF. An MTF position attracts exactly the same STT and stamp
 * duty as a delivery position — the only thing that distinguishes them is
 * financing interest, which is a LEDGER entry, not a transaction charge, and
 * so is absent from a transaction report by construction. Claiming to detect
 * MTF from these columns would be inventing a fact. Delivery is returned
 * instead, and the caller is expected to ask.
 */

export type InferredProduct = "delivery" | "intraday" | "mixed" | "unknown";

/** Statutory rates, as fractions of value. Sourced from the same rate table
 *  the charge engine uses; kept here as plain numbers so this module stays
 *  pure and independently testable. */
export const STAMP_DELIVERY = 0.00015; // 0.015% on buy
export const STAMP_INTRADAY = 0.00003; // 0.003% on buy
export const STT_DELIVERY = 0.001; // 0.10%, both legs
export const STT_INTRADAY = 0.00025; // 0.025%, sell leg only

/**
 * Below this buy value the statutory rounding (STT rounds to the rupee, stamp
 * to the rupee) swamps the rate signal entirely. A ₹1,299 delivery buy shows
 * ₹1.00 STT — 0.077%, which resembles neither rate. Better to say "unknown"
 * than to read a rounding artefact as a product type.
 */
export const MIN_VALUE_FOR_SIGNAL = 5000;

/** Midpoint tolerance. Real files land within a few percent of the exact rate
 *  because of per-rupee rounding, so an exact match is the wrong test. */
const TOL = 0.35;

export interface ChargeSignature {
  buyValue: number;
  sellValue: number;
  /** Securities Transaction Tax actually charged on this row. */
  stt: number;
  /** Stamp duty actually charged on this row (buy side). */
  stampDuty: number;
}

function near(actual: number, expected: number): boolean {
  if (expected <= 0) return false;
  return Math.abs(actual - expected) / expected <= TOL;
}

/**
 * Classify one transaction row.
 *
 * Returns "mixed" when the stamp duty sits materially between the two rates —
 * that is not noise, it is the signature of a single bill in which part of the
 * quantity was squared off the same day and the rest was carried. Splitting it
 * is `splitMixedRow`'s job; saying so is this function's.
 */
export function inferProduct(sig: ChargeSignature): InferredProduct {
  const { buyValue, sellValue, stt, stampDuty } = sig;

  // A sell-only row carries no stamp duty at all (it is a buy-side levy), so
  // the product must be read from STT alone.
  if (buyValue <= 0) {
    if (sellValue < MIN_VALUE_FOR_SIGNAL || stt <= 0) return "unknown";
    if (near(stt / sellValue, STT_DELIVERY)) return "delivery";
    if (near(stt / sellValue, STT_INTRADAY)) return "intraday";
    return "unknown";
  }

  if (buyValue < MIN_VALUE_FOR_SIGNAL) return "unknown";

  const stampRate = stampDuty / buyValue;
  if (stampRate <= 0) return "unknown";

  if (near(stampRate, STAMP_DELIVERY)) return "delivery";
  if (near(stampRate, STAMP_INTRADAY)) return "intraday";

  // Between the two rates, and outside both tolerances → genuinely mixed.
  if (stampRate > STAMP_INTRADAY && stampRate < STAMP_DELIVERY) return "mixed";

  return "unknown";
}

/**
 * Corroborate a stamp-duty verdict against STT.
 *
 * Two signals agreeing is the whole basis for trusting this inference, so the
 * disagreement is surfaced rather than silently resolved in stamp duty's
 * favour — a mismatch means the assumptions behind this module do not hold for
 * that broker or that row, which is worth knowing.
 */
export function corroborate(sig: ChargeSignature, verdict: InferredProduct): boolean {
  const { buyValue, sellValue, stt } = sig;
  if (stt <= 0) return false;
  if (verdict === "delivery") {
    // Delivery STT is levied on BOTH legs, so a row (or scrip-day) that holds
    // a buy AND a sell carries STT on their SUM. Using the buy alone read a
    // same-day delivery round trip as "STT does not corroborate" — 49 of the
    // 83 same-day round trips in a real Paytm book (2026-09-04) are genuine
    // CNC delivery with STT = 0.1% of buy+sell, and every one of them failed.
    const base = buyValue + sellValue;
    return base >= MIN_VALUE_FOR_SIGNAL && near(stt / base, STT_DELIVERY);
  }
  if (verdict === "intraday") {
    const base = sellValue > 0 ? sellValue : buyValue;
    return base >= MIN_VALUE_FOR_SIGNAL && near(stt / base, STT_INTRADAY);
  }
  return false;
}

export interface MixedSplit {
  /** Portion of the BUY value that was carried overnight. */
  deliveryValue: number;
  /** Portion of the BUY value that was squared off the same day. */
  intradayValue: number;
  /** Fraction of the buy that was delivery, 0–1. */
  deliveryFraction: number;
}

/**
 * Solve a mixed row for its delivery / intraday split.
 *
 * Stamp duty is linear in value at a per-product rate, so for a single bill:
 *
 *   stamp = 0.00015·D + 0.00003·I      and      D + I = buyValue
 *
 * which has exactly one solution. This is algebra on a reported number, not a
 * heuristic — but it still rests on the assumption that the row contains only
 * these two products, so callers must label the result as DERIVED.
 *
 * Returns null when the numbers admit no sane split (fraction outside 0–1),
 * because a nonsense split is worse than admitting the row is unclear.
 */
export function splitMixedRow(sig: ChargeSignature): MixedSplit | null {
  const { buyValue, stampDuty } = sig;
  if (buyValue < MIN_VALUE_FOR_SIGNAL || stampDuty <= 0) return null;

  // stamp = Sd·D + Si·(V − D)  →  D = (stamp − Si·V) / (Sd − Si)
  const deliveryValue = (stampDuty - STAMP_INTRADAY * buyValue) / (STAMP_DELIVERY - STAMP_INTRADAY);
  const fraction = deliveryValue / buyValue;

  // Allow a hair outside [0,1] for rounding, then clamp; reject anything wilder.
  if (fraction < -0.02 || fraction > 1.02) return null;
  const f = Math.min(1, Math.max(0, fraction));

  return {
    deliveryValue: Math.round(buyValue * f * 100) / 100,
    intradayValue: Math.round(buyValue * (1 - f) * 100) / 100,
    deliveryFraction: Math.round(f * 10000) / 10000,
  };
}

/** Human-readable reason, so the UI can explain rather than assert. */
export function productReason(verdict: InferredProduct, corroborated: boolean): string {
  switch (verdict) {
    case "delivery":
      return corroborated
        ? "stamp duty 0.015% and STT 0.1% — both match delivery"
        : "stamp duty matches delivery (0.015%), STT does not corroborate";
    case "intraday":
      return corroborated
        ? "stamp duty 0.003% and STT 0.025% — both match intraday"
        : "stamp duty matches intraday (0.003%), STT does not corroborate";
    case "mixed":
      return "stamp duty sits between the delivery and intraday rates — part of this bill was squared off the same day";
    default:
      return "charges too small or too unusual to identify the product";
  }
}
