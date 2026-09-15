import type { Trade } from "@/lib/db/schema";
import { defaultMtfFundedAmount, DEFAULT_MTF_OWN_MARGIN_PCT } from "@/lib/risk/margin";
import { plannedRewardRisk } from "@/lib/risk/calculators";

/**
 * The fields this module actually reads — a structural subset of `Trade`, so
 * the tracker pages can feed it a column-trimmed query row (perf sweep
 * 2026-08-29) while every full-`Trade` caller keeps compiling unchanged.
 */
export type PositionTrade = Pick<
  Trade,
  | "id" | "broker" | "bucket" | "segment" | "instrumentType" | "exchange" | "symbol" | "tradingsymbol"
  | "optionType" | "strike" | "expiry" | "isOpen"
  | "buyQty" | "sellQty" | "avgBuyPrice" | "avgSellPrice" | "closingPrice"
  | "buyDate" | "sellDate" | "mtfFundedAmount" | "mtfInterest"
  | "riskAmount" | "slPlanned" | "targetPlanned"
>;

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
  /** MTF only: invested − fundedAmount (what you actually put in).
   *  NULL on a PARTLY SOLD leg — see the note at the computation below: the
   *  stored funded amount covers the whole buy leg while `invested` is only
   *  the remaining quantity, so there is no honest own-capital figure to
   *  state (invariant 6). Non-MTF stays 0. */
  ownCapital: number | null;
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

/**
 * The mark this position may read out of the stored MTM map, or null.
 *
 * A DERIVATIVE DROPS THE `symbol` RUNG (owner ruling A-1, v4.2 fix wave).
 * `mtm_prices` is keyed on `symbol`, and a derivative trade carries its
 * UNDERLYING there — so `mtm.get(symbol)` on an option hands back the cash
 * price of the underlying and prices the premium at it. An open
 * `OPT TCS 30 JUN 2026 2500 CE` (875 × ₹2.75) against a stored `TCS = 2057.5`
 * printed +₹17,97,906.25 (+74,718 %) across the desk, heat, /risk and exposure
 * — a number nothing in the book ever traded (invariant 6). The WRITE side
 * already refuses a derivative mark for the same reason (`isCashKey()` in
 * `lib/quotes/persist-mark.ts`, `writeTypedMark()` in `lib/queries/mtm.ts`);
 * this is the read side of that one rule.
 *
 * EQUITIES ARE UNCHANGED — `symbol → tradingsymbol`. Anything that is not
 * exactly `"equity"` reads the TRADED CONTRACT only: an unknown or missing
 * instrument type is treated as a contract because falling through to the
 * recorded close is a real stored number, while pricing a premium off spot is
 * not (invariant 6 again — the cheap failure over the expensive one).
 *
 * It is EXPORTED so `components/live/load-desk.ts` resolves the same rungs from
 * the same code. The two held the precedence separately, and drifting apart is
 * exactly how the desk and the tracker came to print different marks.
 */
export function storedMarkFor(
  t: { symbol: string; tradingsymbol: string; instrumentType: string | null },
  mtm: Map<string, number>,
): number | null {
  const contract = mtm.get(t.tradingsymbol.toUpperCase()) ?? null;
  if (t.instrumentType !== "equity") return contract;
  return mtm.get(t.symbol.toUpperCase()) ?? contract;
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
  trades: PositionTrade[],
  mtm: Map<string, number>,
  today: string,
  mtfMarginByBroker: Record<string, number> = {},
): OpenPosition[] {
  return trades
    .filter((t) => t.isOpen)
    .map((t) => {
      // Short (sell-to-open, e.g. a written CE/PE or a short future) has the
      // open leg on sellQty with buyQty still 0 — same convention used by
      // exposure.ts/app/risk/page.tsx and closePosition in lib/import/commit.ts.
      // MTF is long-only in India, so isMtf below is unaffected by this branch.
      const isShort = t.sellQty > t.buyQty;
      const qty = Math.abs(t.buyQty - t.sellQty) || (isShort ? t.sellQty : t.buyQty);
      const avgPrice = isShort ? t.avgSellPrice : t.avgBuyPrice;
      const invested = qty * avgPrice;
      // Equity: stored symbol → stored contract → close → entry.
      // Derivative: stored contract → close → entry (never the underlying's
      // cash mark — see `storedMarkFor` above, owner ruling A-1).
      const mtmPrice = storedMarkFor(t, mtm) ?? t.closingPrice ?? avgPrice;
      const currentValue = qty * mtmPrice;
      // Short profits when price falls: P&L = (entry − mtm) × qty, the mirror
      // of the long case (mtm − entry) × qty.
      const unrealised = Math.round((isShort ? invested - currentValue : currentValue - invested) * 100) / 100;
      const isMtf = t.segment === "eq_mtf";
      // Reuse the persisted funded amount (set at entry, reused by accrual/close —
      // never the full invested value, which assumes 100% broker financing).
      // A STORED 0 IS A STATED AMOUNT — the position paid for in full out of own
      // capital — and is kept, the same null-vs-0 rule every writer follows
      // (V3/X2, lib/import/commit.ts and lib/jobs/mtf-accrual.ts) and the same
      // one the Trades table's own cell already reads (`investedSummary` in
      // lib/domain/trade-columns.ts). Substituting the estimate for a stated 0
      // reported `ownCapital` and `roiOnCapitalPct` against a denominator the
      // journal never recorded (invariant 6). Only a null — a row predating both
      // the column and its first accrual pass — is estimated.
      const fundedAmount = isMtf
        ? t.mtfFundedAmount ?? defaultMtfFundedAmount(invested, mtfMarginByBroker[t.broker] ?? DEFAULT_MTF_OWN_MARGIN_PCT)
        : 0;
      // A PARTLY SOLD MTF LEG STATES NO OWN CAPITAL (v4.3.0 wave 2L, L2[0]).
      // `fundedAmount` above is the amount stored for the WHOLE buy leg, while
      // `invested` is only the REMAINING quantity × avg price — so
      // `invested − fundedAmount` goes NEGATIVE as soon as more than the
      // own-capital share has been sold, and the /equity and Live Desk money
      // totals silently subtracted that (100 @200 funded 15,000 with 40 sold
      // read −3,000). How a broker releases funding on a partial sale is the
      // broker's rule, not ours: pro-rating it (`funded × remaining ÷ bought`)
      // would state a figure the journal never recorded, so the row reports
      // null and every total says how many rows it left out (invariant 6).
      // A STATED funded 0 is no exception — one predicate, no special case
      // that invents a figure for a leg the journal only half describes.
      const partlySold = isMtf && t.sellQty > 0 && t.sellQty < t.buyQty;
      const ownCapital = !isMtf ? 0 : partlySold ? null : Math.round((invested - fundedAmount) * 100) / 100;
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
        daysHeld: daysBetween(isShort ? t.sellDate : t.buyDate, today),
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
        roiOnCapitalPct: isMtf && ownCapital != null && ownCapital > 0 ? Math.round((unrealised / ownCapital) * 10000) / 100 : null,
        interestPctOfProfit: isMtf && unrealised !== 0 ? Math.round((t.mtfInterest / Math.abs(unrealised)) * 10000) / 100 : null,
        breakevenPrice: null,
      };
    });
}

/**
 * THE one predicate behind every own-capital figure on screen (v4.3.0 wave 2L,
 * L2[0]). The per-row "Own capital" cell and the bucket KPI used to hold the
 * rule separately — the cell refused a non-positive value while the KPI summed
 * `ownCapital` straight across the book — so a partly sold MTF leg showed "—"
 * on its own row and quietly REDUCED the total on the same screen. Both read
 * this now, so they cannot disagree again.
 */
export function statesOwnCapital(p: Pick<OpenPosition, "isMtf" | "ownCapital">): boolean {
  return p.isMtf && p.ownCapital != null;
}

export interface OwnCapitalTotal {
  /** ₹ own capital, summed over the MTF rows that state one. */
  total: number;
  /** Broker-funded ₹ on those SAME rows, so a leverage ratio built from the
   *  two describes one book rather than two different sets of positions. */
  funded: number;
  /** MTF rows that state none (a partly sold leg). Never folded into `total`
   *  — it is a count to disclose, not a number to fill in. */
  unstated: number;
}

/** The own-capital total as it may honestly be shown, with what it left out. */
export function ownCapitalTotal(
  positions: Pick<OpenPosition, "isMtf" | "ownCapital" | "fundedAmount">[],
): OwnCapitalTotal {
  let total = 0;
  let funded = 0;
  let unstated = 0;
  for (const p of positions) {
    if (!p.isMtf) continue;
    if (!statesOwnCapital(p)) {
      unstated += 1;
      continue;
    }
    total += p.ownCapital ?? 0;
    funded += p.fundedAmount;
  }
  return { total: Math.round(total * 100) / 100, funded: Math.round(funded * 100) / 100, unstated };
}

/**
 * The one sentence every surface shows beside an own-capital total it had to
 * leave rows out of. Descriptive: it states WHAT is missing, never an estimate
 * of it (invariant 6). Null when the total is the whole book.
 */
export function ownCapitalNote(unstated: number): string | null {
  if (unstated <= 0) return null;
  return `own capital not stated for ${unstated} partly sold MTF ${unstated === 1 ? "row" : "rows"}`;
}
