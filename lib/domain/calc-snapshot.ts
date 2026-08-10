// TRADE-CALCULATOR PERSISTENCE (PURE, no DB/React).
//
// The calculator keeps ~20 free-typed fields, and half of them mean something
// different per mode: an equity entry of ₹2,450 is nonsense as an option
// premium. So persistence is ONE envelope holding TWO branches — the Equity
// inputs and the F&O inputs — plus the fields that are facts about the USER
// rather than the trade (broker, plan, last-active mode), which live at the
// top level so switching trade mode never switches your broker.
//
// Validation philosophy: this parses whatever localStorage held, which may be
// from a future version, hand-edited, or truncated. Every enum is clamped
// against the app's vocabulary and a bad value DROPS THE FIELD (undefined), so
// the component's own default holds. Free-text numeric fields pass through as
// strings untouched — the calculator already treats them as text inputs and
// guards every read with num()/posOrNull().

import { BROKERS, EXCHANGES, type OptionType } from "@/lib/domain/constants";

export const CALC_SNAPSHOT_KEY = "vyuha-calc";

/** The calculator's own vocabularies — mirrored here so the parser can clamp
 *  without importing a client component. Asserted against the component's
 *  dropdowns in tests/calc-snapshot.test.ts, so they cannot drift silently. */
export const CALC_EQUITY_PRODUCTS = ["eq_delivery", "eq_intraday", "eq_mtf"] as const;
export const CALC_FNO_INSTRUMENTS = [
  "stock_option",
  "index_option",
  "future",
  "commodity_future",
  "commodity_option",
] as const;

export interface CalcBranchShared {
  side?: "long" | "short";
  ticker?: string;
  exchange?: (typeof EXCHANGES)[number];
  entry?: string;
  sl?: string;
  target?: string;
  numTrades?: string;
  riskBudget?: string;
  desiredRR?: string;
}
export interface CalcEquityBranch extends CalcBranchShared {
  product?: (typeof CALC_EQUITY_PRODUCTS)[number];
  shares?: string;
  ownCapital?: string;
  holdDays?: string;
}
export interface CalcFnoBranch extends CalcBranchShared {
  instrument?: (typeof CALC_FNO_INSTRUMENTS)[number];
  lots?: string;
  lotSize?: string;
  optionType?: OptionType;
  strike?: string;
  spot?: string;
}

export interface CalcSnapshot {
  v: 1;
  mode?: "equity" | "fno";
  broker?: (typeof BROKERS)[number];
  plan?: string;
  equity: CalcEquityBranch;
  fno: CalcFnoBranch;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** A string field, or undefined — never coerce a number/object into text. */
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

/** A member of `allowed`, or undefined. */
function oneOf<T extends string>(x: unknown, allowed: readonly T[]): T | undefined {
  return typeof x === "string" && (allowed as readonly string[]).includes(x) ? (x as T) : undefined;
}

function parseShared(b: Record<string, unknown>): CalcBranchShared {
  return {
    side: oneOf(b.side, ["long", "short"] as const),
    ticker: str(b.ticker),
    exchange: oneOf(b.exchange, EXCHANGES),
    entry: str(b.entry),
    sl: str(b.sl),
    target: str(b.target),
    numTrades: str(b.numTrades),
    riskBudget: str(b.riskBudget),
    desiredRR: str(b.desiredRR),
  };
}

/**
 * Narrow whatever localStorage held into a snapshot, or null.
 *
 * Null means "nothing usable" — the component keeps its defaults. A snapshot
 * with SOME bad fields still returns; only the bad fields are dropped.
 */
export function parseCalcSnapshot(raw: string | null): CalcSnapshot | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!isRecord(p) || p.v !== 1) return null;
    const eq = isRecord(p.equity) ? p.equity : {};
    const fn = isRecord(p.fno) ? p.fno : {};
    return {
      v: 1,
      mode: oneOf(p.mode, ["equity", "fno"] as const),
      broker: oneOf(p.broker, BROKERS),
      plan: str(p.plan),
      equity: {
        ...parseShared(eq),
        product: oneOf(eq.product, CALC_EQUITY_PRODUCTS),
        shares: str(eq.shares),
        ownCapital: str(eq.ownCapital),
        holdDays: str(eq.holdDays),
      },
      fno: {
        ...parseShared(fn),
        instrument: oneOf(fn.instrument, CALC_FNO_INSTRUMENTS),
        lots: str(fn.lots),
        lotSize: str(fn.lotSize),
        optionType: oneOf(fn.optionType, ["CE", "PE"] as const),
        strike: str(fn.strike),
        spot: str(fn.spot),
      },
    };
  } catch {
    return null; // corrupt entry = defaults, never a crash
  }
}
