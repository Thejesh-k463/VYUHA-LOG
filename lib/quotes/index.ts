/**
 * `lib/quotes` — the server entry point for the quote-provider boundary.
 *
 * Importing this pulls in the server-only providers (they read the journal
 * database). A CLIENT component must import `@/lib/quotes/types` instead,
 * which is pure and browser-safe; anything in `lib/license.ts`'s import graph
 * must stay browser-safe too, and that is the rule this split protects.
 */
export * from "./types";
export * from "./mapping";
export {
  DEFAULT_PROVIDER_ID,
  SHIPPED_PROVIDER_IDS,
  PLANNED_PROVIDER_IDS,
  allProviderCapabilities,
  createPlannedProvider,
  createProvider,
  getQuoteProvider,
  plannedCapabilities,
  resolveProviderId,
} from "./registry";
export { createMockProvider, MOCK_CAPABILITIES } from "./mock";
export { createManualProvider, MANUAL_CAPABILITIES, indexMarks, type ManualMarkRow, type ManualMarkReader } from "./manual";
export { createEodBhavcopyProvider, EOD_CAPABILITIES, type BarsReader, type CoverageReader } from "./eod-bhavcopy";
