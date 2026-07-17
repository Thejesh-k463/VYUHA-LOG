// IND-7 — Physical-settlement / expiry obligation analytics (PURE, no DB/React).
//
// Indian market microstructure: SINGLE-STOCK F&O is **physically settled** at
// expiry (SEBI, phased in from Oct-2019), while INDEX F&O (NIFTY, BANKNIFTY,
// SENSEX, …) is **cash-settled**. Leaving a stock future — or an in-the-money
// stock option — open into expiry converts it into a *delivery obligation*:
//   • you must take/give delivery of the underlying shares (full notional), and
//   • the position is charged **equity-delivery STT (0.1%) on the whole notional**,
//     plus STT on exercise (0.125% on intrinsic) — vs the tiny premium/turnover STT
//     of simply squaring off. This "STT jump" + the surprise delivery is a classic
//     retail money-trap. This module flags those obligations ahead of expiry.
//
// Rates: the equity-delivery STT comes from `charge_config` (never hard-coded);
// the option-exercise STT is a dated statutory default the caller may override.

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
  /** Settlement reference price: futures price for futures, underlying SPOT for options (if known). */
  refPrice: number | null;
}

export interface SettlementRates {
  /** Equity-delivery STT as a fraction (e.g. 0.001 = 0.1%) — from charge_config eq_delivery. */
  deliverySttPct: number;
  /** STT on exercise of options, on intrinsic value (statutory default 0.125%). */
  exerciseSttPct: number;
  /** Normal futures sell STT (on turnover) — for the square-off comparison. */
  futExitSttPct: number;
}

export const DEFAULT_SETTLEMENT_RATES: SettlementRates = {
  deliverySttPct: 0.001, // 0.1% equity delivery (fallback; page overrides from charge_config)
  exerciseSttPct: 0.00125, // 0.125% on intrinsic — STT on exercised options
  futExitSttPct: 0.0002, // 0.02% futures sell side
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
  notional: number; // ₹ delivery value (strike×qty for options, refPrice×qty for futures)
  fundsOrShares: string; // human note: cash needed / shares to deliver
  physicalStt: number | null; // ₹ STT incurred on physical settlement
  exitStt: number | null; // ₹ STT to square off now (futures only; null for options)
  sttJump: number | null; // physicalStt − exitStt (extra bled by not squaring off)
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
  sttJumpTotal: number; // Σ sttJump where computable
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
  today: string = new Date().toISOString().slice(0, 10),
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
    let notional = 0;
    let physicalStt: number | null = null;
    let exitStt: number | null = null;
    let fundsOrShares = "—";
    let warn: Warn = "none";
    let reason = "";

    if (kind === "stock_future") {
      const px = p.refPrice ?? 0;
      settles = "yes";
      deliveryAction = p.side === "long" ? "Take delivery (buy)" : "Give delivery (sell)";
      deliveryQty = p.netQty;
      notional = r2(px * p.netQty);
      physicalStt = rupee(rates.deliverySttPct * notional);
      exitStt = rupee(rates.futExitSttPct * notional);
      fundsOrShares =
        p.side === "long" ? `≈ ₹${rupee(notional)} cash to take delivery` : `deliver ${p.netQty} ${p.symbol} shares`;
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
        if (intr > 0) physicalStt = rupee(rates.exerciseSttPct * intr * p.netQty);
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

  // Sort: physical first, then nearest expiry first (nulls last), then bigger notional.
  const rank = (o: SettlementObligation) => (o.physical ? 0 : 1);
  obligations.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.dte ?? Infinity) - (b.dte ?? Infinity) ||
      b.notional - a.notional,
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
    notionalAtRisk: r2(settling.reduce((s, o) => s + o.notional, 0)),
    fundsNeeded: r2(
      settling
        .filter((o) => o.deliveryAction === "Take delivery (buy)")
        .reduce((s, o) => s + o.notional, 0),
    ),
    sttJumpTotal: rupee(settling.reduce((s, o) => s + (o.sttJump ?? o.physicalStt ?? 0), 0)),
    nearestExpiry: expiries[0] ?? null,
    obligations,
  };
}
