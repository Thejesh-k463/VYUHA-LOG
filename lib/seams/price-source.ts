/**
 * Seam for market-price providers (MTM). v1 ships only the manual/EOD source
 * (bulk paste in the Position Trackers). A future live/EOD feed (e.g. an NSE/MCX
 * wrapper) implements this interface and drops in without touching the trackers.
 *
 * Out of scope for v1 — do NOT implement live feeds here.
 */
export interface PriceQuote {
  symbol: string;
  price: number;
  asOf: string; // ISO datetime
}

export interface PriceSource {
  id: string;
  label: string;
  kind: "manual" | "eod" | "live";
  /** Fetch the latest price for each symbol. */
  getQuotes(symbols: string[]): Promise<PriceQuote[]>;
}

/** The only source wired in v1: prices entered manually (mtm_prices table). */
export const MANUAL_PRICE_SOURCE: Pick<PriceSource, "id" | "label" | "kind"> = {
  id: "manual",
  label: "Manual / EOD entry",
  kind: "manual",
};
