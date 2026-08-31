// Carry-forward loss ledger (PURE, no DB/React) — one row per loss vintage
// still alive AS OF the latest FY of a computed tax timeline.
//
// Everything here is a re-reading of what computeTaxTimeline already returned:
// the surviving vintages are exactly the latest FY's newCarryForward (already
// pruned for expiry by that FY), the absorbed total is the sum of that
// vintage's usedCarryForward entries across the timeline, and the original
// amount is the vintage's carry-out figure in the FY it was incurred — a loss
// cannot be absorbed in its own FY, so that first carry-out IS the original.
// Nothing is invented: a vintage whose incurring FY is somehow absent from the
// timeline reports originalAmount null rather than a guess.

import { lossExpiryFy, type FySetOffResult, type LossBucket } from "./capital-gains";

export interface LossLedgerRow {
  bucket: LossBucket;
  fyIncurred: string;
  /** Carry-out amount recorded in the FY incurred; null if not derivable from this timeline. */
  originalAmount: number | null;
  /** Total of this vintage consumed across the whole timeline. */
  absorbed: number;
  /** Still available to set off, as of the latest FY. */
  remaining: number;
  /** Last FY the vintage is usable — it expires after this FY (8y capital/non-spec, 4y speculative). */
  expiresAfterFy: string;
}

const BUCKET_ORDER: Record<LossBucket, number> = { stcl: 0, ltcl: 1, speculative: 2, nonSpeculative: 3 };

/** Rows for the loss-ledger card: surviving vintages as of the timeline's latest FY. */
export function buildLossLedger(timeline: FySetOffResult[]): LossLedgerRow[] {
  if (timeline.length === 0) return [];
  const last = timeline[timeline.length - 1];
  return last.newCarryForward
    .map((lot) => {
      const absorbed = timeline.reduce(
        (sum, r) =>
          sum +
          r.usedCarryForward
            .filter((u) => u.bucket === lot.bucket && u.fyIncurred === lot.fyIncurred)
            .reduce((s, u) => s + u.amount, 0),
        0,
      );
      const originLot = timeline
        .find((r) => r.fy === lot.fyIncurred)
        ?.newCarryForward.find((l) => l.bucket === lot.bucket && l.fyIncurred === lot.fyIncurred);
      return {
        bucket: lot.bucket,
        fyIncurred: lot.fyIncurred,
        originalAmount: originLot ? originLot.amount : null,
        absorbed,
        remaining: lot.amount,
        expiresAfterFy: lossExpiryFy(lot.bucket, lot.fyIncurred),
      };
    })
    .sort((a, b) => a.fyIncurred.localeCompare(b.fyIncurred) || BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket]);
}
