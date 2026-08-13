// IMPORT-SOURCE METADATA — the CLIENT-SAFE leaf of the parser registry.
//
// `lib/import/detect.ts` remains the single source of truth for what Vyuha
// can import (AGENTS.md), but it statically imports every parser — and the
// parsers pull in papaparse and the 399 KB xlsx module. The import screen
// only ever needed `dropzoneHint()`, a six-line string join, yet it shipped
// the whole stack to the browser (~400 KB of the /import bundle, measured
// 2026-08-10). This module carries ONLY the metadata; detect.ts builds its
// runtime registry FROM this list, so the two cannot drift — and
// `tests/import-registry.test.ts` still asserts the UI copy derives from the
// registry, which is now literally this array.
//
// Import from here in client components. Import detect.ts only server-side.

import type { Broker } from "@/lib/domain/constants";

export interface ImportSourceMeta {
  sourceId: string;
  label: string;
  /** Named broker, or null for the sniffers that ask instead of guessing. */
  broker: Broker | null;
  tab: "transactions" | "pnl" | "both";
  /** The dropzone-hint fragment — the copy the user actually reads. */
  hint: string;
}

export const IMPORT_SOURCES: readonly ImportSourceMeta[] = [
  { sourceId: "dhan-gtr", label: "Dhan Global Transaction Report (CSV)", broker: "dhan", tab: "transactions", hint: "Dhan transaction report" },
  { sourceId: "dhan-csv", label: "Dhan P&L (CSV)", broker: "dhan", tab: "pnl", hint: "Dhan CSV" },
  { sourceId: "groww-xlsx", label: "Groww Stocks P&L (XLSX)", broker: "groww", tab: "pnl", hint: "Groww XLSX" },
  { sourceId: "groww-orders", label: "Groww Stocks Order History (XLSX)", broker: "groww", tab: "transactions", hint: "Groww order history" },
  { sourceId: "zerodha", label: "Zerodha Tradebook / Console (CSV/XLSX)", broker: "zerodha", tab: "both", hint: "Zerodha tradebook / Console" },
  { sourceId: "angelone", label: "Angel One Tradebook / P&L (CSV/XLSX)", broker: "angelone", tab: "both", hint: "Angel One" },
  { sourceId: "angelone-taxpnl", label: "Angel One Tax P&L (XLSX)", broker: "angelone", tab: "pnl", hint: "Angel One tax P&L" },
  { sourceId: "upstox", label: "Upstox Tradebook / P&L (CSV/XLSX)", broker: "upstox", tab: "both", hint: "Upstox" },
  { sourceId: "paytm-tradebook", label: "Paytm Money Tradebook (XLSX)", broker: "paytm", tab: "transactions", hint: "Paytm Money tradebook" },
  // PDF is a TEXT EXTRACTOR, not an importer, and the copy has to say so:
  // lib/import/parsers/pdf.ts returns `trades: []` on every path because no
  // broker PDF layout has been calibrated yet. It was labelled "Broker P&L
  // (PDF)" and sold alongside the six real parsers, so a buyer reasonably
  // expected trades out of it and got none.
  { sourceId: "pdf", label: "PDF statement — reads the text, does not import trades", broker: null, tab: "pnl", hint: "PDF (text only, no trades)" },
  { sourceId: "generic-table", label: "Any other broker — map the columns (CSV/XLSX)", broker: null, tab: "both", hint: "any other broker (map columns)" },
];

/**
 * The dropzone hint for a tab, generated from the registry so it cannot drift.
 * The generic source is always last — it is the fallback, not a headline.
 */
export function dropzoneHint(tab: "transactions" | "pnl"): string {
  const parts = IMPORT_SOURCES.filter((p) => p.tab === tab || p.tab === "both")
    .sort((a, b) => Number(a.sourceId === "generic-table") - Number(b.sourceId === "generic-table"))
    .map((p) => p.hint);
  return [...new Set(parts)].join(" · ");
}

/** Brokers with a dedicated, auto-detecting parser. */
export function brokersWithNativeParser(): Broker[] {
  return [...new Set(IMPORT_SOURCES.map((p) => p.broker).filter((b): b is Broker => b != null))];
}
