import "server-only";
import { getStagedViews, toDomainLegs } from "./staged";
import {
  purchaseRows,
  realisedRows,
  type LadderInput,
  type PurchaseRow,
  type RealisedParent,
  type RealisedRow,
} from "@/lib/analytics/realised-rows";

/**
 * The server half of the "which rows are realised" rule. The maths lives in
 * the pure `lib/analytics/realised-rows.ts` (invariant 2); this file does
 * nothing but fetch the ladders behind the staged rows it is handed.
 *
 * INVARIANT 8 is preserved by construction, not by a filter of its own: the
 * `trades` array arrives from an ALREADY account-scoped read (`getTrades`,
 * `getTaxTrades`, `getHarvestTrades` — each `scopedBookRows`, or the
 * person-scoped `resolveTaxScope` account ids), and the only ids this file
 * ever loads are the ids of THOSE rows. It never reads the trades table by
 * anything but that id list, so it can neither widen a scope nor merge two
 * books; scoping it a second time here would be the duplicate filter the
 * guard warns about.
 *
 * `getStagedViews` is the batched read (two queries for any number of ids),
 * deliberately: /reports/itr hands it the whole book.
 *
 * NOT wrapped in React `cache`: it is generic, and every caller already reads
 * its `trades` from a `cache`d projection and calls this once per render.
 */
function laddersOf(trades: readonly RealisedParent[]): Map<number, LadderInput> {
  const stagedIds = trades.filter((t) => t.staged).map((t) => t.id);
  const ladders = new Map<number, LadderInput>();
  if (stagedIds.length > 0) {
    for (const [id, view] of getStagedViews(stagedIds)) {
      ladders.set(id, { legs: toDomainLegs(view.legs), position: view.position });
    }
  }
  return ladders;
}

export function getRealisedRows<T extends RealisedParent>(trades: readonly T[]): RealisedRow<T>[] {
  return realisedRows(trades, laddersOf(trades));
}

/** v4.6.0 W7 (D1) — the purchase book: one row per purchase leg of a staged
 *  ladder whose legs still state its parent, the parent row otherwise. */
export function getPurchaseRows<T extends RealisedParent>(trades: readonly T[]): PurchaseRow<T>[] {
  return purchaseRows(trades, laddersOf(trades));
}

/** Both books over ONE batched ladder read — the AIS route states the sale and
 *  the purchase side of the same trades, so it fetches the ladders once. */
export function getRealisedAndPurchaseRows<T extends RealisedParent>(
  trades: readonly T[],
): { realised: RealisedRow<T>[]; purchases: PurchaseRow<T>[] } {
  const ladders = laddersOf(trades);
  return { realised: realisedRows(trades, ladders), purchases: purchaseRows(trades, ladders) };
}
