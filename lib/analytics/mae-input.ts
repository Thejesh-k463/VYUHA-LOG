// THE ONE MaeTradeInput builder (PURE, no DB/React) — v4.7.0 C2, design review
// change 8. The Edge Clinic's Setups tab and Arjun's Eye each built the same
// object inline; a second copy is how one of them would forget the typed
// intra-trade range. Both now call `maeInputOf` / `maeInputsOf`.
//
// Direction goes through `sideOf` (never `t.side` directly). The typed
// intra-trade high / low ride along only while they still bracket both fills
// (`typedRangeValid`, lib/analytics/mae-mfe.ts) — otherwise they are dropped and
// `computeMaeMfe` uses the EOD bars, exactly as it did before C2.

import { sideOf, type SideInput } from "@/lib/domain/side";
import { typedRangeValid, type MaeTradeInput } from "@/lib/analytics/mae-mfe";

/** The slice of a `trades` row the builder reads (rupees at runtime, prices per unit). */
export interface MaeSourceRow extends SideInput {
  id: number;
  symbol: string;
  avgBuyPrice: number;
  avgSellPrice: number;
  netPnl: number;
  isOpen: boolean;
  riskAmount?: number | null;
  intraHigh?: number | null;
  intraLow?: number | null;
}

/** One MaeTradeInput. `ticker` is the canonical bars key (the caller resolves aliases). */
export function maeInputOf(t: MaeSourceRow, ticker: string): MaeTradeInput {
  const side = sideOf(t);
  const entry = side === "long" ? t.avgBuyPrice : t.avgSellPrice;
  const exit = side === "long" ? t.avgSellPrice : t.avgBuyPrice;
  const typed = typedRangeValid(entry, exit, t.intraHigh, t.intraLow);
  return {
    id: t.id,
    symbol: t.symbol,
    ticker,
    side,
    qty: Math.max(t.buyQty, t.sellQty),
    entry,
    exit,
    entryDate: (side === "long" ? t.buyDate : t.sellDate) ?? null,
    exitDate: (side === "long" ? t.sellDate : t.buyDate) ?? null,
    netPnl: t.netPnl,
    isOpen: t.isOpen,
    riskAmount: t.riskAmount ?? null,
    intraHigh: typed ? (t.intraHigh as number) : null,
    intraLow: typed ? (t.intraLow as number) : null,
  };
}

/** The closed rows of `rows` as MaeTradeInputs; `tickerOf` gets the UPPER-cased symbol. */
export function maeInputsOf(rows: readonly MaeSourceRow[], tickerOf: (symbolUpper: string) => string): MaeTradeInput[] {
  return rows.filter((t) => !t.isOpen).map((t) => maeInputOf(t, tickerOf(t.symbol.toUpperCase())));
}
