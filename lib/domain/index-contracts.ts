// INDEX DERIVATIVE CONTRACTS (PURE, no DB/React).
//
// The calculator's "Underlying" picker: display labels, home exchange and a
// BUNDLED market-lot snapshot for the six index underlyings the engine
// classifies (lib/domain/constants.ts INDEX_UNDERLYINGS; classify.ts routes
// SENSEX/BANKEX to BSE).
//
// ── The lots are a SNAPSHOT, and lots CHANGE ────────────────────────────────
//
// Exchanges revise market lots by circular — every NSE index lot changed for
// the January 2026 series (NIFTY 75→65, BANKNIFTY 35→30, FINNIFTY 65→60,
// MIDCPNIFTY 140→120; NSE circular FAOP70616, cross-checked against Zerodha's
// and Sahi's published tables on 2026-08-10 — see docs/DECISIONS.md). That is
// why:
//   1. `INDEX_LOTS_AS_OF` is shown in the UI next to any bundled number;
//   2. the resolution chain PREFERS the instruments table (the user's own
//      fo_mktlots.csv upload, which tracks the exchange) over this snapshot;
//   3. the lot-size field stays editable — a typed value always wins.
// Refresh by re-verifying against the current NSE/BSE circulars and updating
// the literals + AS_OF together; never edit one without the other.

import { BSE_INDEX_UNDERLYINGS, INDEX_UNDERLYINGS } from "@/lib/domain/constants";

export type IndexUnderlying = (typeof INDEX_UNDERLYINGS)[number];

/** Effective date of the bundled lots below (January 2026 series revision). */
export const INDEX_LOTS_AS_OF = "2026-01-01";

/** Market lot per underlying as of INDEX_LOTS_AS_OF. */
export const BUNDLED_INDEX_LOTS: Record<IndexUnderlying, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  MIDCPNIFTY: 120,
  SENSEX: 20,
  BANKEX: 30,
};

const LABELS: Record<IndexUnderlying, string> = {
  NIFTY: "Nifty 50",
  BANKNIFTY: "Bank Nifty",
  FINNIFTY: "FinNifty",
  MIDCPNIFTY: "Midcap Nifty",
  SENSEX: "Sensex",
  BANKEX: "Bankex",
};

const BSE_SET: ReadonlySet<string> = new Set(BSE_INDEX_UNDERLYINGS);

export interface IndexContract {
  symbol: IndexUnderlying;
  label: string;
  /** The index's home exchange — the same routing classify.ts applies. */
  exchange: "NSE" | "BSE";
}

/** Picker rows, in INDEX_UNDERLYINGS order (major indices first). */
export const INDEX_CONTRACTS: IndexContract[] = INDEX_UNDERLYINGS.map((symbol) => ({
  symbol,
  label: LABELS[symbol],
  exchange: BSE_SET.has(symbol) ? "BSE" : "NSE",
}));

export interface ResolvedIndexLot {
  lot: number;
  /** Where the number came from — every figure names its source (MTF-chain
   *  precedent): the user's own lots upload beats the bundled snapshot. */
  source: "instruments" | "bundled";
  /** ISO date the source speaks for. */
  asOf: string;
}

/**
 * Resolve an underlying's market lot.
 *
 * `dbLot` is the instruments-table row for this symbol (from the user's
 * fo_mktlots.csv upload), or null/undefined when absent. A non-positive DB
 * value is treated as absent — a 0-lot contract does not exist, and sizing
 * maths dividing by it would be garbage.
 */
export function resolveIndexLot(
  symbol: IndexUnderlying,
  dbLot: { lotSize: number | null; asOf?: string | null } | null | undefined,
): ResolvedIndexLot {
  if (dbLot && dbLot.lotSize != null && dbLot.lotSize > 0) {
    return { lot: dbLot.lotSize, source: "instruments", asOf: dbLot.asOf ?? "" };
  }
  return { lot: BUNDLED_INDEX_LOTS[symbol], source: "bundled", asOf: INDEX_LOTS_AS_OF };
}
