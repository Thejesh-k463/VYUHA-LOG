// Central domain vocabulary. Imported by the classifier, charges engine, and UI.

export const BROKERS = ["dhan", "zerodha", "groww"] as const;
export type Broker = (typeof BROKERS)[number];

export const BUCKETS = ["equity", "active"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const SEGMENTS = [
  "eq_delivery",
  "eq_mtf",
  "eq_intraday",
  "index_option",
  "stock_option",
  "commodity_future",
  "commodity_option",
  "future",
] as const;
export type Segment = (typeof SEGMENTS)[number];

export const INSTRUMENT_TYPES = ["equity", "option", "future"] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export const EXCHANGES = ["NSE", "BSE", "MCX"] as const;
export type Exchange = (typeof EXCHANGES)[number];

export type OptionType = "CE" | "PE";

export const BROKER_LABELS: Record<Broker, string> = {
  dhan: "Dhan",
  zerodha: "Zerodha",
  groww: "Groww",
};

// Display names only — the DB/API bucket value stays "active" everywhere.
// Deliberately NO ₹ amount here: capital is user-editable in Settings, so a
// baked-in figure goes stale the moment someone changes it. Pages that need
// the live number read it from settings and render it themselves.
export const BUCKET_LABELS: Record<Bucket, string> = {
  equity: "Equity",
  active: "Trade F&O",
};

export const SEGMENT_LABELS: Record<Segment, string> = {
  eq_delivery: "Equity Delivery",
  eq_mtf: "Equity MTF",
  eq_intraday: "Equity Intraday",
  index_option: "Index Options",
  stock_option: "Stock Options",
  commodity_future: "Commodity Futures",
  commodity_option: "Commodity Options",
  future: "Futures",
};

export const SEGMENT_BUCKET: Record<Segment, Bucket> = {
  eq_delivery: "equity",
  eq_mtf: "equity",
  eq_intraday: "active",
  index_option: "active",
  stock_option: "active",
  commodity_future: "active",
  commodity_option: "active",
  future: "active",
};

// Index option underlyings (NSE except SENSEX/BANKEX which are BSE).
export const INDEX_UNDERLYINGS = [
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
  "SENSEX",
  "BANKEX",
] as const;

export const BSE_INDEX_UNDERLYINGS = ["SENSEX", "BANKEX"] as const;

// MCX commodity underlyings.
export const COMMODITY_UNDERLYINGS = [
  "CRUDEOIL",
  "CRUDEOILM",
  "GOLD",
  "GOLDM",
  "GOLDPETAL",
  "SILVER",
  "SILVERM",
  "SILVERMIC",
  "NATURALGAS",
  "COPPER",
  "ZINC",
  "ALUMINIUM",
  "LEAD",
  "NICKEL",
  "MENTHAOIL",
  "COTTON",
] as const;

// Agri commodities have a lower SEBI fee (₹1/crore) — none of the above are agri
// except COTTON / MENTHAOIL (treated as agri for the SEBI slab).
export const AGRI_COMMODITIES = ["COTTON", "MENTHAOIL"] as const;
