import type { Trade } from "@/lib/db/schema";
import { defaultMtfFundedAmount, DEFAULT_MTF_OWN_MARGIN_PCT } from "@/lib/risk/margin";
import { plannedRewardRisk } from "@/lib/risk/calculators";

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
  ownCapital: number; // MTF only: invested − fundedAmount (what you actually put in)
  accruedInterest: number;
  riskAmount: number | null;
  rMultiple: number | null; // "Current R" — live: unrealised ÷ riskAmount (was a frozen creation-time value)
  targetRR: number | null; // "Target R:R" — planned reward:risk at entry (original SL + target), static

  roiOnCapitalPct: number | null; // MTF only: unrealised ÷ ownCapital × 100 (leveraged return)
  interestPctOfProfit: number | null; // MTF only: accrued interest ÷ |unrealised| × 100
  /** MTF only: sell price needed to cover round-trip charges + interest so far.
   * Left null here (this module stays rate-free) — a page with access to
   * charge_config rates fills it in via lib/analytics/trade-calc.ts. */
  breakevenPrice: number | null;
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
  mtfMarginByBroker: Record<string, number> = {},
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
      const isMtf = t.segment === "eq_mtf";
      // Reuse the persisted funded amount (set at entry, reused by accrual/close —
      // never the full invested value, which assumes 100% broker financing).
      // Fallback only covers a row that predates both the column and its first
      // accrual pass.
      const fundedAmount = isMtf
        ? t.mtfFundedAmount && t.mtfFundedAmount > 0
          ? t.mtfFundedAmount
          : defaultMtfFundedAmount(invested, mtfMarginByBroker[t.broker] ?? DEFAULT_MTF_OWN_MARGIN_PCT)
        : 0;
      const ownCapital = isMtf ? Math.round((invested - fundedAmount) * 100) / 100 : 0;
      const riskAmount = t.riskAmount;
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
        isMtf,
        fundedAmount: Math.round(fundedAmount * 100) / 100,
        ownCapital,
        accruedInterest: t.mtfInterest,
        riskAmount,
        // Live, not the frozen creation-time value: R should track the position
        // as it moves, not freeze at "−entry charges ÷ risk" from the moment
        // it was opened.
        rMultiple: riskAmount && riskAmount > 0 ? Math.round((unrealised / riskAmount) * 100) / 100 : null,
        targetRR: plannedRewardRisk(avgPrice, t.slPlanned, t.targetPlanned),
        roiOnCapitalPct: isMtf && ownCapital > 0 ? Math.round((unrealised / ownCapital) * 10000) / 100 : null,
        interestPctOfProfit: isMtf && unrealised !== 0 ? Math.round((t.mtfInterest / Math.abs(unrealised)) * 10000) / 100 : null,
        breakevenPrice: null,
      };
    });
}
