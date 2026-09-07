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
  liveFeedAckGate,
  plannedCapabilities,
  resolveProviderId,
  selectProviderId,
  type PlannedProviderId,
} from "./registry";
export { createMockProvider, MOCK_CAPABILITIES } from "./mock";
export { createManualProvider, MANUAL_CAPABILITIES, indexMarks, type ManualMarkRow, type ManualMarkReader } from "./manual";
export { createEodBhavcopyProvider, EOD_CAPABILITIES, type BarsReader, type CoverageReader } from "./eod-bhavcopy";
export {
  createUpstoxProvider,
  planUpstoxKeys,
  upstoxInstrumentKey,
  UPSTOX_CAPABILITIES,
  UPSTOX_MAX_KEYS,
  UPSTOX_RATE_LIMIT_PER_SECOND,
  type UpstoxGateState,
  type UpstoxHealth,
} from "./upstox";
export {
  ANGELONE_CAPABILITIES,
  ANGELONE_HOURLY_BUDGET,
  ANGELONE_LOOKUPS_PER_CYCLE,
  ANGELONE_MAX_TOKENS_PER_CALL,
  ANGELONE_RATE_LIMIT_PER_SECOND,
  angelOneFeedErrorMessage,
  angelOneSessionExpiresAt,
  createAngelOneProvider,
  createHourlyBudget,
  isAngelSessionInvalid,
  planAngelOneBatches,
  quoteFromAngelOne,
  type AngelOneGateState,
  type AngelOneHealth,
  type AngelQuoteBatch,
  type AngelQuoteFetcher,
} from "./angelone";
export {
  ANGELONE_SEARCH_SCRIP_PATH,
  angelCashKey,
  angelDbTokenCache,
  angelTokenCacheKey,
  createAngelTokenResolver,
  pickAngelScripRow,
  resolvedAngelToken,
  splitAngelSymbol,
  type AngelExchange,
  type AngelScripRow,
  type AngelSearchScrip,
  type AngelTokenCache,
  type AngelTokenResolver,
  type ResolvedAngelToken,
} from "./angelone-tokens";
export { createRateGuard, DEFAULT_RATE_LIMIT_PER_SECOND, type RateGuard } from "./rate-guard";
