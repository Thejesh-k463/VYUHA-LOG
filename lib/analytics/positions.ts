import type { Trade } from "@/lib/db/schema";

export interface OpenPosition {
  id: number;
  broker: string;
  bucket: string;
  segment: string;
  exchange: string;
  symbol: string;
  tradingsymbol: string;
  optionType: string | null;
  strike: number | null;
  expiry: string | null;
  qty: number; // remaining open qty
  avgPrice: number;
  invested: number;
  mtmPrice: number;
  currentValue: number;
  unrealised: number;
  unrealisedPct: number;
  daysHeld: number | null;
  dte: number | null; // days to expiry (derivatives)
  isMtf: boolean;
  fundedAmount: number;
  accruedInterest: number;
  rMultiple: number | null;
}

function daysBetween(a: string | null, b: string): number | null {
  if (!a) return null;
  const d1 = new Date(a + "T00:00:00").getTime();
  const d2 = new Date(b + "T00:00:00").getTime();
  if (Number.isNaN(d1) || Number.isNaN(d2)) return null;
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}

/** Derive open positions from open trades, applying a manual/EOD MTM map. */
export function deriveOpenPositions(
  trades: Trade[],
  mtm: Map<string, number>,
  today: string,
): OpenPosition[] {
  return trades
    .filter((t) => t.isOpen)
    .map((t) => {
      const qty = Math.max(0, t.buyQty - t.sellQty);
      const avgPrice = t.avgBuyPrice;
      const invested = qty * avgPrice;
      const mtmPrice =
        mtm.get(t.symbol.toUpperCase()) ??
        mtm.get(t.tradingsymbol.toUpperCase()) ??
        t.closingPrice ??
        avgPrice;
      const currentValue = qty * mtmPrice;
      const unrealised = Math.round((currentValue - invested) * 100) / 100;
      return {
        id: t.id,
        broker: t.broker,
        bucket: t.bucket,
        segment: t.segment,
        exchange: t.exchange,
        symbol: t.symbol,
        tradingsymbol: t.tradingsymbol,
        optionType: t.optionType,
        strike: t.strike,
        expiry: t.expiry,
        qty,
        avgPrice,
        invested: Math.round(invested * 100) / 100,
        mtmPrice,
        currentValue: Math.round(currentValue * 100) / 100,
        unrealised,
        unrealisedPct: invested > 0 ? Math.round((unrealised / invested) * 10000) / 100 : 0,
        daysHeld: daysBetween(t.buyDate, today),
        dte: t.expiry ? daysBetween(today, t.expiry) : null,
        isMtf: t.segment === "eq_mtf",
        fundedAmount: t.segment === "eq_mtf" ? Math.round(invested * 100) / 100 : 0,
        accruedInterest: t.mtfInterest,
        rMultiple: t.rMultiple,
      };
    });
}
