import "server-only";
import { getBenchmarkCloses } from "@/lib/queries/benchmark";

// IND-12 — India VIX reuses the existing benchmarkPrices table/route/panel (it's
// already a generic symbol/date/close series with a CSV-paste UI); VIX is just
// another symbol, "INDIAVIX". NSE publishes a downloadable "India VIX Historical
// Data" CSV in the same DATE,CLOSE shape the benchmark loader already parses.
export const VIX_SYMBOL = "INDIAVIX";

/** Most recent recorded India VIX close, or null if none loaded yet. */
export function getLatestVixClose(): number | null {
  const rows = getBenchmarkCloses(VIX_SYMBOL);
  return rows.length ? rows[rows.length - 1].close : null;
}
