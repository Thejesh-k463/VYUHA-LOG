// CROSS-SOURCE DUPLICATE DETECTION (PURE, no DB/React).
//
// ── The problem this exists for ─────────────────────────────────────────────
//
// `dedupHash` keys on broker + tradingsymbol + quantities + PRICES + DATES. That
// is exactly right for re-importing the SAME file: nothing changes, the hash
// matches, the row is skipped.
//
// It cannot work across file KINDS, because the two kinds do not state the same
// facts. A Dhan Global Transaction Report gives one row per (date, scrip, bill)
// with both legs and real dates. A P&L export is scrip-aggregated with no dates
// and often only the side that realised. The same real trade therefore hashes
// differently in each, both rows insert, and the journal now holds it twice.
//
// The symptoms look unrelated but share this one cause:
//   • a holding shows "no cost on record" — the P&L row carried only the sell
//   • a position that was closed still shows open — the extra row has one leg
//   • re-importing "merges wrongly" — nothing merged; it duplicated
//
// ── Why this DETECTS rather than merges ─────────────────────────────────────
//
// Automatically merging two rows means choosing which file's numbers to keep,
// and getting that wrong silently corrupts cost basis, holding period and tax
// treatment. The GTR states charges the broker actually levied; the P&L states
// an aggregate. Neither is a superset. So this reports the collision with enough
// detail for a person to decide, and the import stays a decision rather than a
// guess. That is the same rule the product applies to MTF and to product type.

export interface ExistingRow {
  id: number;
  broker: string;
  symbol: string;
  tradingsymbol: string;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  buyDate: string | null;
  sellDate: string | null;
  sourceFile: string | null;
  dedupHash: string;
}

export interface IncomingRow {
  broker: string;
  symbol: string;
  tradingsymbol: string;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  buyDate: string | null;
  sellDate: string | null;
  dedupHash: string;
}

export type OverlapKind = "same-quantity" | "same-value" | "partial-quantity";

export interface CrossSourceCollision {
  symbol: string;
  incoming: { buyQty: number; sellQty: number; buyValue: number; sellValue: number };
  existing: { id: number; buyQty: number; sellQty: number; sourceFile: string | null };
  kind: OverlapKind;
  /** Plain-language reason a human can check against their broker statement. */
  detail: string;
}

export interface CrossSourceReport {
  collisions: CrossSourceCollision[];
  /** Distinct symbols involved — what the warning headline counts. */
  symbols: string[];
  /** True when importing as-is would very likely double-count. */
  risky: boolean;
  message: string | null;
}

const norm = (s: string) => s.trim().toUpperCase();
/** Values rarely match to the paisa across file kinds; 1% is a real match. */
const VALUE_TOLERANCE = 0.01;

function closeEnough(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= VALUE_TOLERANCE;
}

/**
 * Find incoming rows that look like trades already recorded from a DIFFERENT
 * file, judged on the facts both kinds agree on: symbol, quantity and value.
 *
 * Dates are deliberately NOT required to match — a P&L export has none, which
 * is the whole reason the hashes differ.
 */
export function detectCrossSourceDuplicates(
  incoming: IncomingRow[],
  existing: ExistingRow[],
  incomingFileName: string,
): CrossSourceReport {
  const collisions: CrossSourceCollision[] = [];

  for (const inc of incoming) {
    const candidates = existing.filter(
      (e) =>
        e.broker === inc.broker &&
        norm(e.tradingsymbol) === norm(inc.tradingsymbol) &&
        // An identical hash is an ordinary duplicate the existing dedup already
        // handles — this is only about rows that slip past it.
        e.dedupHash !== inc.dedupHash &&
        // A row from the SAME file is a genuine second trade in that scrip, not
        // a cross-source echo of the first.
        (e.sourceFile ?? "") !== incomingFileName,
    );

    for (const e of candidates) {
      let kind: OverlapKind | null = null;
      let detail = "";

      const incQty = Math.max(inc.buyQty, inc.sellQty);
      const exQty = Math.max(e.buyQty, e.sellQty);

      if (incQty > 0 && incQty === exQty) {
        kind = "same-quantity";
        detail = `${incQty} shares already recorded from ${e.sourceFile ?? "an earlier import"}.`;
      } else if (closeEnough(inc.buyValue, e.buyValue) || closeEnough(inc.sellValue, e.sellValue)) {
        kind = "same-value";
        detail = `A trade of nearly the same value is already recorded from ${e.sourceFile ?? "an earlier import"}.`;
      } else if (incQty > 0 && exQty > 0 && (incQty % exQty === 0 || exQty % incQty === 0)) {
        kind = "partial-quantity";
        detail = `${incQty} shares here against ${exQty} already recorded from ${e.sourceFile ?? "an earlier import"} — one may be part of the other.`;
      }

      if (kind) {
        collisions.push({
          symbol: inc.symbol,
          incoming: { buyQty: inc.buyQty, sellQty: inc.sellQty, buyValue: inc.buyValue, sellValue: inc.sellValue },
          existing: { id: e.id, buyQty: e.buyQty, sellQty: e.sellQty, sourceFile: e.sourceFile },
          kind,
          detail,
        });
        break; // one report per incoming row is enough to prompt a decision
      }
    }
  }

  const symbols = [...new Set(collisions.map((c) => c.symbol))].sort();
  const risky = collisions.some((c) => c.kind === "same-quantity" || c.kind === "same-value");

  return {
    collisions,
    symbols,
    risky,
    message:
      collisions.length === 0
        ? null
        : `${collisions.length} row${collisions.length === 1 ? "" : "s"} in this file (${symbols.slice(0, 5).join(", ")}${symbols.length > 5 ? `, +${symbols.length - 5} more` : ""}) look like trades already recorded from a different file. ` +
          "The two file kinds state different facts — a transaction report has dates and both legs, a P&L export has neither — so the duplicate check cannot match them and importing both would record the same trade twice. " +
          "Nothing is merged automatically: merging means choosing whose numbers to keep, and getting that wrong silently corrupts cost basis and holding period. Delete the earlier import first if these are the same trades.",
  };
}
