// IND-7 — Physical-settlement / expiry obligation analytics (PURE, no DB/React).
//
// Indian market microstructure: SINGLE-STOCK F&O is **physically settled** at
// expiry (SEBI, phased in from Oct-2019), while INDEX F&O (NIFTY, BANKNIFTY,
// SENSEX, …) is **cash-settled**. Leaving a stock future — or an in-the-money
// stock option — open into expiry converts it into a *delivery obligation*:
//   • the underlying shares are taken/given in delivery (full notional);
//   • a physically settled contract carries **delivery STT on BOTH sides** at
//     the equity-delivery rate (0.1%; NSE FATAX38737, from 26 Jul 2018) — on
//     the cash close × qty for a future, on the STRIKE VALUE (strike × qty) for
//     an option, whether the option is long or short;
//   • **exercise STT** (0.15% of intrinsic since 1-Apr-2026, circular 02/2026
//     row 4(b)) is payable by the PURCHASER only — an exercised LONG pays it on
//     top of delivery STT, an assigned writer does not;
//   • INDEX options settle in cash and carry no delivery STT.
// Squaring off instead costs the premium/turnover STT (and, for a SHORT future,
// nothing at all: its square-off is a BUY, and futures STT is charged on the
// sell leg only). This module computes those obligations ahead of expiry.
//
// Rates: the equity-delivery STT comes from `charge_config` (never hard-coded);
// the option-exercise STT is a dated statutory default the caller may override.

import { todayIstIso } from "@/lib/domain/trading-day";
import { INDEX_UNDERLYINGS } from "@/lib/domain/constants";

const INDEX_SET = new Set<string>(INDEX_UNDERLYINGS);

const r2 = (n: number) => Math.round(n * 100) / 100;
const rupee = (n: number) => Math.round(n);

export type SettlementKind =
  | "stock_future" // physically settled — certain delivery if held to expiry
  | "stock_option" // physically settled IF in-the-money at expiry
  | "index_cash" // cash-settled (NIFTY etc.) — no delivery obligation
  | "commodity" // MCX — its own devolvement rules; surfaced separately
  | "not_derivative";

export type Moneyness = "ITM" | "OTM" | "unknown";
export type SettleResolution = "yes" | "if-ITM" | "no";
export type Warn = "danger" | "warn" | "info" | "none";

export interface SettlementInput {
  id: number;
  symbol: string; // underlying, e.g. RELIANCE / NIFTY
  tradingsymbol: string;
  segment: string; // stock_option | index_option | future | commodity_* | eq_*
  optionType: string | null; // CE | PE | null
  strike: number | null;
  expiry: string | null; // ISO date
  netQty: number; // absolute open quantity in SHARES (lots × lot size)
  side: "long" | "short";
  /**
   * Settlement reference price — the UNDERLYING's cash-segment price for BOTH
   * legs, and `null` when the book does not know it.
   *
   * For an option it judges moneyness (spot vs strike). For a future it is the
   * DELIVERY price: the exchange settles a stock future at the underlying's
   * cash close on expiry, not at the contract's own last traded price — so the
   * caller reads the same cash mark it reads for options, then the recorded
   * close, then the position's own side-aware entry (owner ruling C-1). This
   * doc used to say "futures price for futures", and the wave-2 caller followed
   * it; A-1's contract-mark precedence is for P&L, not for settlement.
   *
   * `null` means UNKNOWN and is carried through as an unknown notional — it is
   * never coerced to 0 (invariant 6).
   */
  refPrice: number | null;
}

export interface SettlementRates {
  /** Equity-delivery STT as a fraction (e.g. 0.001 = 0.1%) — from charge_config eq_delivery.
   *  Levied on BOTH sides of every physically settled contract: a stock
   *  future's delivery value and an ITM stock option's strike value. */
  deliverySttPct: number;
  /** STT on exercise of options, on intrinsic value (statutory default 0.15%
   *  since 1-Apr-2026 — FA 2026, NSE circular 02/2026 row 4(b)). */
  exerciseSttPct: number;
  /** Normal futures sell STT (on turnover) — for the square-off comparison. */
  futExitSttPct: number;
}

/**
 * Rates in force TODAY, per the Finance Act 2026 (assent 30 March 2026),
 * effective 1 April 2026 — NSE Circular Ref. No. 02/2026, Download Ref. No.
 * NSE/FATAX/73524 dated 31 March 2026, rows 4(b) and 4(c).
 *
 * These are deliberately the CURRENT rates and not effective-dated, because
 * settlement projects FORWARD: it prices what an open position would cost if
 * carried into an expiry that has not happened yet. There is no historical date
 * to resolve. `deliverySttPct` and `futExitSttPct` are overridden from
 * `charge_config` by the page (which does resolve by date); `exerciseSttPct`
 * has no charge_config column, because STT on EXERCISE is charged on intrinsic
 * value and is a different levy from the premium STT the option segments carry.
 *
 * Previously `exerciseSttPct` was 0.00125 and `futExitSttPct` 0.0002 — both the
 * pre-April-2026 figures, which understated the "STT jump" this module exists
 * to warn about.
 */
export const DEFAULT_SETTLEMENT_RATES: SettlementRates = {
  deliverySttPct: 0.001, // 0.1% equity delivery — unchanged by FA 2026 (circular rows 1 & 2)
  exerciseSttPct: 0.0015, // 0.15% on intrinsic — circular row 4(b), was 0.125% to 31-Mar-2026
  futExitSttPct: 0.0005, // 0.05% futures sell side — circular row 4(c), was 0.02% to 31-Mar-2026
};

export interface SettlementObligation {
  id: number;
  symbol: string;
  tradingsymbol: string;
  segment: string;
  kind: SettlementKind;
  physical: boolean; // physically-settled instrument class (stock F&O)
  expiry: string | null;
  dte: number | null; // days to expiry (null if no expiry on record)
  side: "long" | "short";
  netQty: number;
  optionType: string | null;
  strike: number | null;
  moneyness: Moneyness;
  intrinsicPerUnit: number | null;
  settles: SettleResolution; // will it physically settle if left open?
  deliveryAction: "Take delivery (buy)" | "Give delivery (sell)" | null;
  deliveryQty: number; // shares to take/give if it settles
  /** ₹ delivery value (strike×qty for options, refPrice×qty for futures).
   *  `null` = the reference price is unknown, so the value is unknown — the
   *  panel prints "—" and the totals exclude it (ruling C-1, invariant 6). */
  notional: number | null;
  fundsOrShares: string; // human note: cash needed / shares to deliver
  /** ₹ STT incurred on physical settlement: delivery STT on the delivery value
   *  (both sides), plus exercise STT on intrinsic for an exercised LONG option
   *  only — each rounded to the rupee separately (R77/R78). */
  physicalStt: number | null;
  /**
   * ₹ STT to square off now — SIDE-AWARE, because futures STT is SELL-SIDE
   * ONLY (`charge_config` carries the `future` segment as
   * `{ pct, side: "sell" }`, and `lib/engine/charges.ts` levies it on
   * `sellValue` alone). Squaring off a LONG is a SELL, so it costs the
   * sell-side rate × notional; squaring off a SHORT is a BUY, which STT does
   * not touch, so it costs ₹0 (owner ruling M-1).
   *
   * Futures only — null for options, whose exit STT rides the CURRENT PREMIUM
   * an offline journal does not know — and null when the notional is unknown.
   */
  exitStt: number | null;
  /** physicalStt − exitStt (extra bled by not squaring off). A SHORT future's
   *  exitStt is 0, so its jump is the WHOLE physicalStt. */
  sttJump: number | null;
  warn: Warn;
  reason: string;
}

export interface SettlementSummary {
  today: string;
  windowDays: number;
  total: number; // open derivative positions considered
  physicalCount: number; // physically-settled positions
  expiringPhysicalCount: number; // physical & within the warning window
  certainDeliveryCount: number; // positions that will settle (futures + ITM options)
  notionalAtRisk: number; // Σ notional of settling / likely-to-settle positions
  fundsNeeded: number; // Σ cash to take delivery (long settlements)
  /** How many settling positions the two totals above could NOT include,
   *  because their reference price is unknown. A total that silently swallowed
   *  them as ₹0 would read as "nothing more to worry about" (ruling C-1).
   *
   *  This is the exclusion count for `notionalAtRisk` and `physicalSttTotal`,
   *  which consider EVERY settling row. `fundsNeeded` has a narrower base and
   *  therefore its own count — see `unknownFundsCount`. */
  unknownNotionalCount: number;
  /** How many settling TAKE-DELIVERY positions `fundsNeeded` could not include,
   *  because their reference price is unknown.
   *
   *  `fundsNeeded` sums only "Take delivery (buy)" rows, so a give-delivery row
   *  is not something it left out — it is something it never wanted. Hanging
   *  `unknownNotionalCount` on that tile printed "Funds to take delivery ₹0 ·
   *  1 unknown" over a book whose single unknown row delivers SHARES and needs
   *  no cash at all (M-2). */
  unknownFundsCount: number;
  /** Σ physicalStt — the STT physical settlement WILL levy on positions that
   *  settle. This is deliberately NOT a "extra vs squaring off" delta: the
   *  delta is only computable for futures (exit STT rides notional). For an
   *  option, exiting means selling the option and paying premium STT on its
   *  CURRENT PREMIUM, which an offline journal does not know — the old total
   *  summed futures deltas with options ABSOLUTES under a delta label and
   *  overstated "extra" on any book with ITM options (v3.5.0 audit C3). */
  physicalSttTotal: number;
  /** The rates every figure above was computed with, so the panel's footer
   *  names the delivery-STT rate the page actually read from charge_config
   *  rather than a default it may not have used. */
  rates: SettlementRates;
  nearestExpiry: string | null;
  obligations: SettlementObligation[]; // physical first, then by dte asc
}

function daysBetween(from: string, to: string): number | null {
  const a = new Date(from + "T00:00:00").getTime();
  const b = new Date(to + "T00:00:00").getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function classifyKind(seg: string, symbol: string): SettlementKind {
  if (seg.startsWith("commodity")) return "commodity";
  if (seg === "index_option") return "index_cash";
  if (seg === "future") return INDEX_SET.has(symbol.toUpperCase()) ? "index_cash" : "stock_future";
  if (seg === "stock_option") return "stock_option";
  // A bare option on an index symbol that slipped classification:
  if (seg.endsWith("option") && INDEX_SET.has(symbol.toUpperCase())) return "index_cash";
  return "not_derivative";
}

/** Take/give-delivery direction for a settling option leg. */
function optionAction(side: "long" | "short", optionType: string | null) {
  const isCall = optionType === "CE";
  // long call / short put → you BUY (take) shares; long put / short call → you SELL (give) shares.
  const takes = (side === "long" && isCall) || (side === "short" && !isCall);
  return takes ? ("Take delivery (buy)" as const) : ("Give delivery (sell)" as const);
}

/**
 * @param inputs      open derivative positions
 * @param rates       STT rates (delivery from charge_config; exercise statutory)
 * @param today       ISO date "now"
 * @param windowDays  expiry-proximity warning window (default 7 calendar days)
 */
export function computeSettlement(
  inputs: SettlementInput[],
  rates: SettlementRates = DEFAULT_SETTLEMENT_RATES,
  today: string = todayIstIso(),
  windowDays = 7,
): SettlementSummary {
  const obligations: SettlementObligation[] = [];

  for (const p of inputs) {
    const kind = classifyKind(p.segment, p.symbol);
    if (kind === "not_derivative") continue;

    const physical = kind === "stock_future" || kind === "stock_option";
    const dte = p.expiry ? daysBetween(today, p.expiry) : null;
    const near = dte != null && dte <= windowDays;
    const approaching = dte != null && dte <= windowDays * 2;

    let moneyness: Moneyness = "unknown";
    let intrinsicPerUnit: number | null = null;
    let settles: SettleResolution = "no";
    let deliveryAction: SettlementObligation["deliveryAction"] = null;
    let deliveryQty = 0;
    let notional: number | null = 0;
    let physicalStt: number | null = null;
    let exitStt: number | null = null;
    let fundsOrShares = "—";
    let warn: Warn = "none";
    let reason = "";

    if (kind === "stock_future") {
      // The reference is the underlying's cash price. UNKNOWN stays unknown:
      // `?? 0` here printed "₹0" delivery value, "₹0" STT and a "₹0" STT jump
      // on a position that will certainly devolve — the panel's whole purpose
      // inverted by a coercion (ruling C-1, invariant 6).
      const px = p.refPrice;
      settles = "yes";
      deliveryAction = p.side === "long" ? "Take delivery (buy)" : "Give delivery (sell)";
      deliveryQty = p.netQty;
      notional = px == null ? null : r2(px * p.netQty);
      physicalStt = notional == null ? null : rupee(rates.deliverySttPct * notional);
      // SIDE-AWARE (owner ruling M-1). Futures STT is charged on the SELL leg
      // only, so squaring off a LONG (a sell) costs the rate × notional and
      // squaring off a SHORT (a buy) costs nothing. Side-blind, this charged a
      // short an exit STT it would never pay and shrank `sttJump` by that
      // amount — understating the very penalty this module warns about. A short
      // future's jump IS its whole delivery STT.
      exitStt =
        notional == null ? null : p.side === "long" ? rupee(rates.futExitSttPct * notional) : 0;
      fundsOrShares =
        p.side === "long"
          ? notional == null
            ? "cash to take delivery — settlement value unknown (no underlying price on record)"
            : `≈ ₹${rupee(notional)} cash to take delivery`
          : `deliver ${p.netQty} ${p.symbol} shares`;
      warn = near ? "danger" : approaching ? "warn" : "info";
      reason = `Stock future settles physically at expiry — ${deliveryAction.toLowerCase()} of ${p.netQty} shares.`;
    } else if (kind === "stock_option") {
      const strike = p.strike ?? 0;
      deliveryQty = p.netQty;
      notional = r2(strike * p.netQty);
      deliveryAction = optionAction(p.side, p.optionType);
      if (p.refPrice != null && strike > 0) {
        const isCall = p.optionType === "CE";
        const intr = isCall ? Math.max(p.refPrice - strike, 0) : Math.max(strike - p.refPrice, 0);
        intrinsicPerUnit = r2(intr);
        moneyness = intr > 0 ? "ITM" : "OTM";
        settles = intr > 0 ? "yes" : "no";
        if (intr > 0) {
          // R77/R78. A physically settled option carries delivery STT on its
          // strike value for BOTH sides (FATAX38737, from 26 Jul 2018; rate
          // from charge_config eq_delivery, invariant 3). Exercise STT (row
          // 4(b)) is payable by the PURCHASER only, so an assigned writer owes
          // none of it. This line used to charge every ITM leg the exercise
          // term alone — ₹75 on a short SBIN 1400 CE ×500 that owes ₹700.
          const delivery = rupee(rates.deliverySttPct * notional);
          const exercise = p.side === "long" ? rupee(rates.exerciseSttPct * intr * p.netQty) : 0;
          physicalStt = delivery + exercise;
        }
      } else {
        moneyness = "unknown";
        settles = "if-ITM"; // spot unknown — obligation is conditional
      }
      const takes = deliveryAction === "Take delivery (buy)";
      fundsOrShares = takes
        ? `≈ ₹${rupee(notional)} cash if exercised`
        : `deliver ${p.netQty} ${p.symbol} shares if exercised`;
      if (settles === "yes") warn = near ? "danger" : approaching ? "warn" : "info";
      else if (settles === "if-ITM") warn = near ? "warn" : approaching ? "info" : "none";
      else warn = near ? "info" : "none"; // OTM — will lapse worthless
      reason =
        settles === "no"
          ? "Out-of-the-money — expires worthless, no delivery."
          : settles === "yes"
            ? `In-the-money stock option — physical settlement: ${deliveryAction.toLowerCase()} ${p.netQty} shares.`
            : `Stock option — physical settlement IF in-the-money at expiry (enter underlying spot to confirm).`;
    } else if (kind === "index_cash") {
      settles = "no";
      warn = near ? "info" : "none";
      reason = "Index F&O is cash-settled — no delivery obligation.";
    } else {
      // commodity
      settles = "no";
      warn = near ? "info" : "none";
      reason = "MCX commodity — settlement/devolvement per exchange & broker; review separately.";
    }

    const sttJump = physicalStt != null && exitStt != null ? rupee(physicalStt - exitStt) : null;

    obligations.push({
      id: p.id,
      symbol: p.symbol,
      tradingsymbol: p.tradingsymbol,
      segment: p.segment,
      kind,
      physical,
      expiry: p.expiry,
      dte,
      side: p.side,
      netQty: p.netQty,
      optionType: p.optionType,
      strike: p.strike,
      moneyness,
      intrinsicPerUnit,
      settles,
      deliveryAction,
      deliveryQty,
      notional,
      fundsOrShares,
      physicalStt,
      exitStt,
      sttJump,
      warn,
      reason,
    });
  }

  // Sort: physical first, then nearest expiry first (nulls last), then bigger
  // notional (an unknown value sorts last within its expiry, never as ₹0).
  const rank = (o: SettlementObligation) => (o.physical ? 0 : 1);
  obligations.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.dte ?? Infinity) - (b.dte ?? Infinity) ||
      (b.notional ?? -1) - (a.notional ?? -1),
  );

  const physicalObs = obligations.filter((o) => o.physical);
  const settling = obligations.filter((o) => o.settles !== "no");
  const expiries = obligations.map((o) => o.expiry).filter((e): e is string => !!e).sort();

  return {
    today,
    windowDays,
    total: obligations.length,
    physicalCount: physicalObs.length,
    expiringPhysicalCount: physicalObs.filter((o) => o.dte != null && o.dte <= windowDays).length,
    certainDeliveryCount: obligations.filter((o) => o.settles === "yes").length,
    notionalAtRisk: r2(settling.reduce((s, o) => s + (o.notional ?? 0), 0)),
    fundsNeeded: r2(
      settling
        .filter((o) => o.deliveryAction === "Take delivery (buy)")
        .reduce((s, o) => s + (o.notional ?? 0), 0),
    ),
    unknownNotionalCount: settling.filter((o) => o.notional == null).length,
    // The SAME filter `fundsNeeded` reduces over — so the count is exactly what
    // that total left out, never what it never asked for (M-2).
    unknownFundsCount: settling.filter(
      (o) => o.deliveryAction === "Take delivery (buy)" && o.notional == null,
    ).length,
    physicalSttTotal: rupee(settling.reduce((s, o) => s + (o.physicalStt ?? 0), 0)),
    rates: { ...rates },
    nearestExpiry: expiries[0] ?? null,
    obligations,
  };
}
