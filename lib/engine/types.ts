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
}

/** Subset of charge_config the pure engine needs (broker × segment × exchange). */
export interface ChargeRates {
  broker: Broker;
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
  dpGstApplicable: boolean;
  dpMinValue: number;
  mtfInterestAnnual: number;
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
