import type {
  Broker,
  Bucket,
  Exchange,
  InstrumentType,
  OptionType,
  Segment,
} from "@/lib/domain/constants";

/** Product hint a parser can derive from a broker file (remark / product code). */
export type ProductHint = "intraday" | "delivery" | "mtf" | null;

/** Result of auto-classifying an instrument. */
export interface Classification {
  bucket: Bucket;
  segment: Segment;
  instrumentType: InstrumentType;
  exchange: Exchange;
  symbol: string;
  expiry: string | null; // ISO date
  strike: number | null;
  optionType: OptionType | null;
}

/** Input to the classifier. */
export interface ClassifyInput {
  tradingsymbol: string;
  broker?: Broker;
  isin?: string | null;
  productHint?: ProductHint;
  exchangeHint?: Exchange | null;
}

/** Parsed instrument-name structure (Dhan-style OPT/FUT or plain equity). */
export interface ParsedInstrument {
  kind: "option" | "future" | "equity";
  symbol: string;
  expiry: string | null;
  strike: number | null;
  optionType: OptionType | null;
}

/**
 * The normalized row shape every importer emits. Classifier + charges engine
 * both consume this. P&L from broker files is GROSS (pre-charges).
 */
export interface NormalizedTrade {
  broker: Broker;
  tradingsymbol: string;
  isin: string | null;
  buyQty: number;
  avgBuyPrice: number;
  buyValue: number;
  sellQty: number;
  avgSellPrice: number;
  sellValue: number;
  closingPrice: number | null;
  grossPnl: number;
  unrealisedPnl: number;
  buyDate: string | null;
  sellDate: string | null;
  productHint: ProductHint;
  exchangeHint: Exchange | null;
  sourceFile: string | null;
  /**
   * HH:MM of the opening and closing fill, when the source carries it.
   *
   * Tradebooks do; aggregated P&L reports do not, and null is the honest
   * answer there — the time-of-day analytics show an empty state rather than
   * inventing a session.
   */
  entryTime?: string | null;
  exitTime?: string | null;
  /**
   * The individual fills behind this aggregate, when the source file had them
   * (tradebook exports list every execution; P&L reports are pre-aggregated).
   *
   * Preserving them is what lets an imported position show its real entry
   * ladder instead of a single blended average. Two or more executions on the
   * opening side make the trade a staged position on commit.
   */
  executions?: Execution[] | null;
  /**
   * Charges the broker ACTUALLY levied on this trade, when the file states
   * them per row (a transaction/contract report does; a P&L summary does not).
   *
   * When present these are stored as the truth and the computed figures are
   * kept only as a cross-check. Reasoning: this is real money that really left
   * the account. Vyuha's engine cannot be more accurate about a charge than
   * the charge itself, and quietly storing a computed number that differs from
   * the contract note would make the journal disagree with the broker.
   */
  reportedCharges?: Partial<ChargeBreakdown> | null;
  /**
   * True when this row was SOLD without any matching purchase in the file —
   * the stock was acquired before the window, very often as an IPO allotment.
   *
   * Its cost basis is not merely unknown but unknowable from the file, so P&L
   * for it is meaningless until the user supplies one. Reporting a 100% gain
   * because buyValue is zero would be a fabrication.
   */
  basisUnknown?: boolean;
  /**
   * A per-share cost RECOVERED from the file's own footer for an unmatched
   * holding (see `deriveBasisFromFooter`). Offered as a suggestion the user
   * confirms — never applied silently, because it is arithmetic on a total
   * rather than a stated purchase price.
   */
  suggestedBasisPrice?: number | null;
  /**
   * True when `productHint` was INFERRED from the charge signature rather than
   * stated by the file. Surfaced in the UI so a derived fact never wears the
   * same clothes as a reported one.
   */
  productDerived?: boolean;
  /** Per-row provenance notes, carried through to the trade record. */
  importNotes?: string[] | null;
}

/** One executed fill from a broker tradebook. */
export interface Execution {
  side: "buy" | "sell";
  qty: number;
  price: number;
  date: string | null;
  time?: string | null;
}

/** Subset of charge_config the pure engine needs (broker × segment × exchange). */
export interface ChargeRates {
  /**
   * Start of the window this rate applies to, inclusive (`YYYY-MM-DD`).
   * Optional on the type so pure fixtures stay terse; absent means 1970-01-01.
   */
  effectiveFrom?: string;
  /** End of the window, EXCLUSIVE. Null/absent means open-ended. */
  effectiveTo?: string | null;

  broker: Broker;
  /** Pricing plan: "default" is the free tier most accounts are on. */
  plan: string;
  planLabel: string | null;
  /** Monthly subscription in rupees; 0 for a free plan. */
  subscriptionMonthly: number;
  segment: Segment;
  exchange: Exchange;
  brokerageFlat: number | null;
  brokeragePct: number;
  brokerageCap: number | null;
  brokerageFloor: number;
  sttPct: number;
  sttSide: "both" | "buy" | "sell" | "none";
  exchangeTxnPct: number;
  sebiPct: number;
  stampPct: number;
  ipftPct: number;
  gstPct: number;
  dpCharge: number;
  /**
   * Percentage DP charge, when the broker bills a share of the sale rather
   * than a flat fee (Kotak Neo: 0.04% subject to a ₹20 minimum). Zero for the
   * flat-fee brokers, which keeps their arithmetic byte-identical.
   *
   * When set, the charge is max(dpCharge, dpPct × sellValue) — `dpCharge`
   * becomes the FLOOR rather than the whole fee.
   */
  dpPct: number;
  dpGstApplicable: boolean;
  dpMinValue: number;
  mtfInterestAnnual: number;
  /**
   * True when the broker does not PUBLISH an MTF interest rate.
   *
   * Neither available option was honest on its own: seeding 0% advertises free
   * funding in the very report that exists to compare costs, and omitting the
   * row entirely makes `findRates` throw the moment such a trade is imported.
   * So the row exists — every other charge on it is real — and the unknown is
   * stated as a fact the comparison can act on.
   */
  mtfRateUnknown: boolean;
  mtfTiers: { upTo: number | null; rate: number }[] | null;
  pledgeCharge: number;
  unpledgeCharge: number;
}

/** Inputs to a single charge computation. */
export interface ChargeInput {
  segment: Segment;
  buyValue: number;
  sellValue: number;
  buyQty: number;
  sellQty: number;
  /** Executed orders per side (P&L files are aggregated; defaults to 1 each). */
  buyOrderCount?: number;
  sellOrderCount?: number;
  /** MTF financing, when known (closed trade). */
  mtf?: {
    fundedAmount: number;
    daysHeld: number;
    pledgeScrips?: number;
  } | null;
}

/** Full per-trade charge breakdown. */
export interface ChargeBreakdown {
  brokerage: number;
  sttCtt: number;
  exchangeTxn: number;
  sebi: number;
  stampDuty: number;
  ipft: number;
  gst: number;
  dpCharges: number;
  mtfInterest: number;
  pledgeCharges: number;
  total: number;
}
