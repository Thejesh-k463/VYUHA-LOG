/**
 * D4 (v4.3.0 wave 2N) — WHAT THE TRADE EDITOR'S SAVE MAY RE-PRICE.
 *
 * PURE (no DB, no React — invariant 2): the predicate is read by the save
 * (`lib/import/commit.ts#updateManualTrade`) and by the server half of its live
 * preview (`app/api/charges/preview`), so the dialog can never show a figure the
 * save will not store (`tests/preview-equals-save-matrix.test.ts`).
 *
 * ── Why it exists ─────────────────────────────────────────────────────────────
 *
 * `updateManualTrade` re-priced the row on EVERY save and compared the engine's
 * fresh output against the stored heads only to decide whether to drop the IPO
 * sync's provenance marker. Two consequences, both measured (wave-2L re-check,
 * `ipo` new_defects[2]):
 *
 *   • an IPO-synced holding is priced by the IPO model (the sale plus the
 *     allotment's stamp; NO purchase STT — none is due on an allotment) while the
 *     editor priced it as a delivery ROUND TRIP, so the two disagreed BY
 *     CONSTRUCTION: a notes-only save moved chargesTotal 37.97 → 52.72 (sttCtt
 *     2 → 3) and stripped the marker, after which /ipos could never re-price the
 *     row again — a ₹5,000 sale carrying a ₹1,500 sale's ₹18.43;
 *   • an IMPORTED row carrying the BROKER's own bill had it replaced by the
 *     engine's estimate on a save that changed nothing but a note — owner ruling
 *     F1 (a figure the user states is never rewritten), in the one door that had
 *     not applied it.
 *
 * So the money moves only when a CHARGE INPUT moves. Notes, tags, levels, the
 * setup, the exit trigger, the risk amount and the MTM price change no charge, so
 * they leave every head, the total and the net exactly as stored; R and realised %
 * are recomputed from the KEPT net (a risk-only edit still updates R).
 */

import type { ChargeBreakdown } from "@/lib/engine/types";

/**
 * Everything the charge engine is fed for a trade, as the SAVE resolves it —
 * quantities, values, the two dates, the open/closed state, the order counts each
 * side actually bills, and the MTF funded principal the row will carry.
 *
 * Both sides of the comparison are built the same way (`chargeInputsOf`), so a
 * stored order count of 0 on a side with quantity reads as the settings default on
 * BOTH sides rather than as a change, and an open row's empty side reads as 0 on
 * both.
 */
export interface TradeChargeInputs {
  buyQty: number;
  avgBuyPrice: number;
  buyValue: number;
  buyDate: string | null;
  sellQty: number;
  avgSellPrice: number;
  sellValue: number;
  sellDate: string | null;
  isOpen: boolean;
  buyOrderCount: number;
  sellOrderCount: number;
  /** MTF only; null for every other segment, and for a row nobody has priced. */
  fundedAmount: number | null;
}

/** The ten charge columns a row states, in the engine's own order. */
export const CHARGE_HEADS = ["brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty", "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges"] as const;

/**
 * The charges a row ALREADY states, as a breakdown — what a save that changes no
 * charge input writes back, and what its preview must show (F1).
 */
export function storedCharges(row: Record<string, unknown>): ChargeBreakdown {
  const heads = Object.fromEntries(CHARGE_HEADS.map((k) => [k, Number(row[k]) || 0])) as Record<(typeof CHARGE_HEADS)[number], number>;
  return { ...heads, total: Number(row.chargesTotal) || 0 };
}

/**
 * A row that states NO charge at all — every head and the total 0.
 *
 * Nothing stated is destroyed by pricing such a row, so a save prices it even when
 * it changed no input: this is the /ipos sync's own `statesNoCharges` rule (wave
 * 2I, `app/api/ipos/route.ts`), read here so the two doors answer the same
 * question the same way. A manually entered row, a fixture, or an import whose
 * file carried no charge columns is priced on its first editor save, as before;
 * only a row that STATES a bill keeps it (F1).
 */
export function statesNoCharges(row: Record<string, unknown>): boolean {
  const c = storedCharges(row);
  return c.total === 0 && CHARGE_HEADS.every((k) => c[k] === 0);
}

/** Paise, the unit the columns store (invariant 1) — so a float tail is not a change. */
const paise = (n: number): number => Math.round((Number(n) || 0) * 100);

/**
 * The charge inputs of a row as the save reads them. `defaults` are
 * `settings.defaultBuyOrders` / `defaultSellOrders`: the count a side gaining its
 * first quantity bills (V4), which is why the STORED side must be read through the
 * same rule as the next one.
 */
export function chargeInputsOf(
  row: {
    buyQty: number;
    avgBuyPrice: number;
    buyValue: number;
    buyDate: string | null;
    sellQty: number;
    avgSellPrice: number;
    sellValue: number;
    sellDate: string | null;
    isOpen: boolean;
    buyOrderCount: number;
    sellOrderCount: number;
    mtfFundedAmount: number | null;
  },
  defaults: { buyOrders: number; sellOrders: number },
): TradeChargeInputs {
  return {
    buyQty: row.buyQty,
    avgBuyPrice: row.avgBuyPrice,
    buyValue: row.buyValue,
    buyDate: row.buyDate,
    sellQty: row.sellQty,
    avgSellPrice: row.avgSellPrice,
    sellValue: row.sellValue,
    sellDate: row.sellDate,
    isOpen: row.isOpen,
    buyOrderCount: row.buyQty > 0 ? row.buyOrderCount || defaults.buyOrders : 0,
    sellOrderCount: row.sellQty > 0 ? row.sellOrderCount || defaults.sellOrders : 0,
    fundedAmount: row.mtfFundedAmount,
  };
}

/**
 * Does this save change anything the charge engine is fed?
 *
 * TRUE → price it: the figures this save stores are the user's own, and the IPO
 * sync's marker goes with them. FALSE → every stored head, the total and the net
 * stand exactly as they are (F1).
 *
 * Money is compared AT THE PAISA, the unit the column stores; the funded amount is
 * compared null-aware, because a null (nobody priced it) and a stated 0 (paid for
 * in full out of own capital) are different facts.
 */
export function chargeInputsChanged(stored: TradeChargeInputs, next: TradeChargeInputs): boolean {
  if (paise(stored.buyValue) !== paise(next.buyValue)) return true;
  if (paise(stored.sellValue) !== paise(next.sellValue)) return true;
  if (paise(stored.avgBuyPrice) !== paise(next.avgBuyPrice)) return true;
  if (paise(stored.avgSellPrice) !== paise(next.avgSellPrice)) return true;
  if (stored.buyQty !== next.buyQty || stored.sellQty !== next.sellQty) return true;
  if ((stored.buyDate ?? null) !== (next.buyDate ?? null)) return true;
  if ((stored.sellDate ?? null) !== (next.sellDate ?? null)) return true;
  if (stored.isOpen !== next.isOpen) return true;
  if (stored.buyOrderCount !== next.buyOrderCount || stored.sellOrderCount !== next.sellOrderCount) return true;
  if (stored.fundedAmount == null || next.fundedAmount == null) return stored.fundedAmount !== next.fundedAmount;
  return paise(stored.fundedAmount) !== paise(next.fundedAmount);
}
