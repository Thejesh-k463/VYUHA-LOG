import type { Trade } from "@/lib/db/schema";
import { plannedRewardRisk } from "@/lib/risk/calculators";
import { sideOf } from "@/lib/domain/side";

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

/**
 * The four shapes in which an open MTF row states NO own capital (D7, v4.3.0
 * wave 2N). Each is a different fact about the row, and each has a different
 * remedy, so the totals count them separately instead of calling them all
 * "partly sold" (which three of the four are not).
 *
 *   partlySold  — part of the leg is sold; the stored funding covers the WHOLE
 *                 buy leg, and how a broker releases it on a partial sale is
 *                 the broker's rule, not ours.
 *   overSold    — the sells exceed the buys (the import's own `stale_sale`
 *                 shape): `invested` is the remainder priced off the SALE,
 *                 against the whole buy leg's funding — it went −8,000.
 *   sellToOpen  — no buy leg at all, so the difference describes nothing.
 *   unpriced    — the journal never recorded what the broker funded. EVERY
 *                 imported MTF buy starts here, and since M1 it stays here
 *                 until a writer the user drove states the amount.
 */
export type OwnCapitalUnstated = "partlySold" | "overSold" | "sellToOpen" | "unpriced" | null;

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
  /** MTF only: what the broker financed, as the JOURNAL RECORDS IT.
   *  NULL when the row was never priced — no estimate reaches a screen
   *  (D7/wave 2N, close-readers#1). Non-MTF stays 0. */
  fundedAmount: number | null;
  /** MTF only: invested − fundedAmount (what you actually put in).
   *  NULL unless the row is a plain held buy leg with a stated funded amount —
   *  see `ownCapitalUnstated` and the note at the computation below. Non-MTF
   *  stays 0. */
  ownCapital: number | null;
  /** WHY this row states no own capital, for the note beside every total that
   *  had to leave it out (invariant 6: a count and a reason, never a fill-in).
   *  Null when the row states one, and on every non-MTF row. */
  ownCapitalUnstated: OwnCapitalUnstated;
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
): OpenPosition[] {
  return trades
    .filter((t) => t.isOpen)
    .map((t) => {
      // Short (sell-to-open, e.g. a written CE/PE or a short future) has the
      // open leg on sellQty with buyQty still 0 — same convention used by
      // exposure.ts/app/risk/page.tsx and closePosition in lib/import/commit.ts.
      // MTF is long-only in India, so isMtf below is unaffected by this branch.
      const isShort = sideOf(t) === "short";
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
      // WHAT THE BROKER FUNDED, AS THE JOURNAL RECORDS IT — never an estimate
      // (D7, v4.3.0 wave 2N, close-readers#1). A STORED 0 IS A STATED AMOUNT —
      // the position paid for in full out of own capital — and is kept, the same
      // null-vs-0 rule every writer follows (V3/X2, lib/import/commit.ts and
      // lib/jobs/mtf-accrual.ts) and the same one the Trades table's own cell
      // already reads (`investedSummary` in lib/domain/trade-columns.ts).
      //
      // A NULL used to be replaced by `defaultMtfFundedAmount(invested, …)`,
      // justified by "a row predating both the column and its first accrual
      // pass". M1 removed that accrual write-back, so null is now the NORMAL,
      // PERMANENT state of every imported MTF buy: /risk said "not priced" and
      // /trades said "funding not yet resolved" about the same row /equity
      // priced at the 25% margin default, as money, in a KPI (invariant 6).
      const fundedAmount = isMtf ? t.mtfFundedAmount : 0;
      // THE ONE PREDICATE: an open MTF row states own capital only when it is a
      // PLAIN HELD BUY LEG whose funding the journal recorded. Everything else
      // states none, and says which of the four things it is.
      //
      // `fundedAmount` is the amount stored for the WHOLE buy leg, while
      // `invested` is only the REMAINING quantity × avg price, so
      // `invested − fundedAmount` describes the row only while nothing has been
      // sold: it read −3,000 on a 40-of-100 sale (L2[0]), −8,000 when the sells
      // exceeded the buys, and on a sell-to-open row it was 25% of a SALE with
      // no buy leg behind it at all. Pro-rating (`funded × remaining ÷ bought`)
      // would state how the broker releases funding on a partial sale — the
      // broker's rule, not ours. So the row reports null and every total says
      // how many rows it left out, and why (invariant 6).
      const ownCapitalUnstated: OwnCapitalUnstated = !isMtf
        ? null
        : t.buyQty <= 0
          ? "sellToOpen"
          : // A QUANTITY fact (sold at least what was bought), not a direction read.
            t.sellQty >= t.buyQty // side-scan: quantity
            ? "overSold"
            : t.sellQty > 0
              ? "partlySold"
              : t.mtfFundedAmount == null
                ? "unpriced"
                : null;
      // Exactly `isMtf && buyQty > 0 && sellQty === 0 && mtfFundedAmount != null`
      // — the ladder above is its complement, stated as reasons.
      const ownCapital =
        !isMtf || ownCapitalUnstated != null
          ? isMtf
            ? null
            : 0
          : Math.round((invested - (fundedAmount ?? 0)) * 100) / 100;
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
        fundedAmount: fundedAmount == null ? null : Math.round(fundedAmount * 100) / 100,
        ownCapital,
        ownCapitalUnstated,
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

export interface UnstatedWhy {
  partlySold: number;
  overSold: number;
  sellToOpen: number;
  unpriced: number;
}

export interface OwnCapitalTotal {
  /** ₹ own capital, summed over the MTF rows that state one. */
  total: number;
  /** Broker-funded ₹ on those SAME rows, so a leverage ratio built from the
   *  two describes one book rather than two different sets of positions. */
  funded: number;
  /** MTF rows that state none. Never folded into `total` — it is a count to
   *  disclose, not a number to fill in. */
  unstated: number;
  /** MTF rows INSIDE `total` / `funded`, so a figure built from the pair can say
   *  which rows it describes (D8, wave 2O: the leverage row states its inputs). */
  stating: number;
  /** …broken down by reason, because the four have four different remedies and
   *  calling them all "partly sold" described three of them wrongly (D7). */
  unstatedWhy: UnstatedWhy;
}

/**
 * WHAT THE BOOK RECORDS AS BROKER-FUNDED — the ONE figure behind the /equity
 * "MTF funded" KPI face, the dialog's "Broker-funded" row and /targets' MTF card
 * (D8, v4.3.0 fix wave 2O — mtf#2 ≡ seams#0).
 *
 * `ownCapitalTotal.funded` is the funding of the rows that state OWN CAPITAL, a
 * deliberately narrower set: it exists so a leverage ratio describes one book.
 * Wave 2N pointed the KPI FACE at it, and a book of two partly sold MTF rows each
 * recording ₹16,000 then read "MTF funded ₹0" while the cells below it printed
 * 16,000 and /targets stated ₹32,000. A partly sold leg's FUNDED amount IS
 * stated — it is the whole leg, which is exactly what Q-B keeps accruing interest
 * on; only its own capital is unstatable. So the face reads THIS: every MTF row
 * that states its funding, with a count of the rows that state none (invariant 6 —
 * disclosed, never estimated).
 *
 * `stated` is the count of rows inside `funded`, so a label can say "n of m"
 * without re-deriving the rule at the call site.
 */
export interface MtfFundedStated {
  /** ₹ the book records as broker-funded, over every MTF row that states it. */
  funded: number;
  /** MTF rows inside `funded` (a stated 0 is one of them — V3/X2). */
  stated: number;
  /** MTF rows that state no funded amount. A count to disclose, never a figure. */
  unstated: number;
}

export function mtfFundedStated(positions: Pick<OpenPosition, "isMtf" | "fundedAmount">[]): MtfFundedStated {
  let funded = 0;
  let stated = 0;
  let unstated = 0;
  for (const p of positions) {
    if (!p.isMtf) continue;
    const rowFunded = p.fundedAmount;
    if (rowFunded == null) {
      unstated += 1;
      continue;
    }
    funded += rowFunded;
    stated += 1;
  }
  return { funded: Math.round(funded * 100) / 100, stated, unstated };
}

/** The own-capital total as it may honestly be shown, with what it left out. */
export function ownCapitalTotal(
  positions: Pick<OpenPosition, "isMtf" | "ownCapital" | "fundedAmount" | "ownCapitalUnstated">[],
): OwnCapitalTotal {
  let total = 0;
  let funded = 0;
  let unstated = 0;
  let stating = 0;
  const why: UnstatedWhy = { partlySold: 0, overSold: 0, sellToOpen: 0, unpriced: 0 };
  for (const p of positions) {
    if (!p.isMtf) continue;
    const own = p.ownCapital;
    const rowFunded = p.fundedAmount;
    // Own AND funded from the SAME rows. A `?? 0` on either would put a row
    // the journal cannot describe into a figure it is counted in.
    if (own == null || rowFunded == null) {
      unstated += 1;
      // D9 (wave 2O, mtf#4): the reason the tally reports is the one the USER CAN
      // ACT ON. A row that is partly sold AND states no funding was counted as
      // "partly sold", so /equity's note named the sale, the "no funded amount
      // yet" hint (keyed on `unstatedWhy.unpriced`) never appeared, and /targets
      // and /risk called the same row "not recorded" — three screens, two
      // reasons, one row. `p.ownCapitalUnstated` keeps its SHAPE meaning.
      const why_ = mtfDashReason(p);
      if (why_) why[why_] += 1;
      continue;
    }
    total += own;
    funded += rowFunded;
    stating += 1;
  }
  return { total: Math.round(total * 100) / 100, funded: Math.round(funded * 100) / 100, unstated, stating, unstatedWhy: why };
}

const UNSTATED_LABEL: Record<keyof UnstatedWhy, string> = {
  partlySold: "partly sold",
  overSold: "over-sold",
  sellToOpen: "sell-to-open",
  unpriced: "unpriced",
};

/**
 * The one sentence every surface shows beside an own-capital total it had to
 * leave rows out of. Descriptive: it states WHAT is missing and WHY, never an
 * estimate of it (invariant 6). Null when the total is the whole book.
 *
 * A bare COUNT is still accepted (older call sites), and then the sentence
 * states the count without a reason rather than claiming one it was not told.
 */
export function ownCapitalNote(t: OwnCapitalTotal | number): string | null {
  const unstated = typeof t === "number" ? t : t.unstated;
  if (unstated <= 0) return null;
  const noun = `MTF ${unstated === 1 ? "row" : "rows"}`;
  if (typeof t === "number") return `own capital not stated for ${unstated} ${noun}`;
  const parts = (Object.keys(UNSTATED_LABEL) as (keyof UnstatedWhy)[])
    .filter((k) => t.unstatedWhy[k] > 0)
    .map((k) => `${t.unstatedWhy[k]} ${UNSTATED_LABEL[k]}`);
  if (parts.length === 0) return `own capital not stated for ${unstated} ${noun}`;
  return `own capital not stated for ${parts.join(", ")} ${noun}`;
}

/**
 * WHO FUNDED THIS POSITION, as the journal records it — the one rule behind the
 * tracker's funding filter and its "MTF-funded positions" count.
 *
 * "user" is a STATED 0 (paid for in full, and every non-MTF row), "broker" is a
 * stated positive amount, and NULL is neither: a row the journal never priced
 * belongs in no bucket, where `fundedAmount <= 0` used to file it under "user
 * funded" and `> 0` hid it from both (close-readers#1).
 */
export function fundingSide(p: Pick<OpenPosition, "fundedAmount">): "user" | "broker" | null {
  const funded = p.fundedAmount;
  if (funded == null) return null;
  return funded > 0 ? "broker" : "user";
}

/**
 * Q-B (owner ruling, wave 2N): a row with a sale on it keeps accruing interest
 * on the WHOLE stated funded amount until it closes — no funding is treated as
 * released for the units already sold, because how a broker releases it is the
 * broker's rule. The figure is not changed; it is LABELLED, with this one
 * sentence, wherever it is shown.
 */
export const MTF_INTEREST_WHOLE_LEG_NOTE = "interest estimated on the whole funded amount until the row closes";

/**
 * Does this row's accrued interest carry the Q-B caveat?
 *
 * D9 (wave 2O): only a row that STATES its funding can. Under Q-A a row with no
 * recorded funded amount accrues nothing at all, so "interest estimated on the
 * whole funded amount" describes no figure on it — the desk printed that sentence
 * beside a dash, against funding it did not have.
 */
export function interestOnWholeLeg(p: Pick<OpenPosition, "isMtf" | "fundedAmount" | "ownCapitalUnstated">): boolean {
  return (
    p.isMtf &&
    p.fundedAmount != null &&
    (p.ownCapitalUnstated === "partlySold" || p.ownCapitalUnstated === "overSold")
  );
}

/**
 * WHY an MTF money block on any surface shows a dash — the reason the user can
 * act on, ahead of the shape (D9, v4.3.0 fix wave 2O — mtf#4).
 *
 * `ownCapitalUnstated` answers "what shape is this row?" and keeps doing so (the
 * Live Desk wire ships it verbatim). This answers "what should the screen say?":
 * an MTF row whose funded amount the journal never recorded reports `unpriced`,
 * because recording it is the one remedy that exists, and every other surface
 * (/risk "not priced", /targets "funding not recorded", Data Quality's
 * `mtf_funding`) already says exactly that about the same row. A row that STATES
 * its funding reports its shape, so a sell-to-open or over-sold row is never
 * promised a remedy that cannot make its own capital statable.
 */
export function mtfDashReason(
  p: Pick<OpenPosition, "isMtf" | "fundedAmount" | "ownCapitalUnstated">,
): OwnCapitalUnstated {
  if (!p.isMtf) return null;
  if (p.fundedAmount == null) return "unpriced";
  return p.ownCapitalUnstated;
}
