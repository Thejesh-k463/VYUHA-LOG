/**
 * The quote-provider boundary — PURE (03D §1.2, spec §4.1).
 *
 * No DB, no React, no `node:*`, no `fetch`, no `Date.now()`. Everything a
 * provider needs from the outside world is passed in, which is what makes the
 * conformance suite in `tests/quotes-provider.test.ts` possible at all.
 *
 * MONEY: every price on the wire is integer PAISE (invariant 1). The DB keeps
 * per-unit prices as REAL rupees on purpose — they are levels — so the paise
 * conversion happens exactly once, at the provider edge, in `toPaise()`.
 *
 * DEVIATION from 03D §1.2, logged here because other waves consume this type:
 * `subscribe()` takes a callback and returns an `Unsubscribe`, instead of
 * returning an async-iterator `QuoteStream`. The only consumer in v4.0 is
 * `app/api/live/stream/route.ts`, which coalesces ticks into one frame per
 * 250 ms; an iterator would have to buffer or drop between `next()` calls and
 * would hand the route a backpressure policy it then has to undo. The
 * connection state the `QuoteStream.state` field carried is reported by
 * `health()` instead, which every provider already has to implement.
 */

/** Integer paise. Never rupees, never a float. */
export type Paise = number;

export type Exchange = "NSE" | "BSE" | "NFO" | "BFO" | "MCX" | "CDS";

/** Every provider Vyuha knows about — shipped or planned. */
export type ProviderId =
  | "mock"
  | "manual"
  | "eod"
  | "openalgo"
  | "kite"
  | "upstox"
  | "dhan"
  | "angelone";

/** How stale the caller MUST assume a price is. Never a guess, never upgraded. */
export type Staleness = "tick" | "delayed" | "eod" | "manual";

export interface QuoteKey {
  /** Underlying scrip, upper-cased by convention ("RELIANCE"). */
  symbol: string;
  exchange: Exchange;
  /** Derivatives: the traded contract. Distinguishes two strikes of one symbol. */
  tradingsymbol?: string;
  /** Provider-native instrument id, resolved by the provider itself. */
  token?: string;
}

export interface Quote {
  key: QuoteKey;
  ltp: Paise;
  prevClose: Paise | null;
  dayOpen: Paise | null;
  dayHigh: Paise | null;
  dayLow: Paise | null;
  volume: number | null;
  /**
   * When the PRICE was true AT THE SOURCE — not when we received it. An EOD
   * quote from Thursday's bhavcopy says Thursday 15:30, whatever time it is
   * now; that is the whole point of the field.
   */
  asOf: string;
  staleness: Staleness;
  /** Shown in the UI next to every number, so a mark can always be traced. */
  source: ProviderId;
}

export interface ProviderCapabilities {
  id: ProviderId;
  label: string;
  /** True only when `subscribe()` is a real push. Polling still reports false. */
  streaming: boolean;
  maxSubscriptions: number;
  minSnapshotIntervalMs: number;
  depth: 0 | 5 | 20 | 30;
  segments: Exchange[];
  /** Truthful staleness floor — the UI renders this, never a guess. */
  staleness: Staleness;
  /** Set when the provider needs a fresh session most trading days. */
  requiresDailyAuth: boolean;
  /**
   * One human sentence naming every host this provider can cause a request to.
   * "None." when it makes none. `tests/quotes-egress-guard.test.ts` reads every
   * host out of this string and refuses any that `docs/client/PRIVACY.md` does
   * not already cover — that is the registry rule, mechanised.
   */
  egressDescription: string;
}

/** Keyed by `quoteKeyId()`. */
export type QuoteMap = Map<string, Quote>;

export type TickListener = (quote: Quote) => void;

/** Idempotent: calling it twice must not throw and must not double-detach. */
export type Unsubscribe = () => void;

/** Why a provider cannot run right now. `health()` NEVER throws. */
export interface ProviderHealth {
  ok: boolean;
  reason?: string;
}

export interface QuoteProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Point-in-time. MUST work for every provider, including EOD ones. */
  snapshot(keys: readonly QuoteKey[], signal?: AbortSignal): Promise<QuoteMap>;
  /**
   * Push. A non-streaming provider returns a no-op unsubscribe and emits
   * nothing rather than pretending — `capabilities.streaming` is the contract.
   */
  subscribe(keys: readonly QuoteKey[], onTick: TickListener, signal?: AbortSignal): Unsubscribe;
  /** Never throws. Returns why it cannot run right now. */
  health(): Promise<ProviderHealth>;
}

/**
 * Stable map key for a quote. The traded contract wins when there is one:
 * two strikes of NIFTY share a `symbol` and would otherwise collide.
 */
export function quoteKeyId(key: QuoteKey): string {
  const scrip = (key.tradingsymbol ?? key.symbol).trim().toUpperCase();
  return `${key.exchange}:${scrip}`;
}

/** Rupees (how the DB stores a per-unit price) → paise (how a Quote carries it). */
export function toPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

/** Paise → rupees, for the render edge only. */
export function fromPaise(paise: Paise): number {
  return paise / 100;
}

/**
 * Thrown by a provider that exists as a type but not as a feature. `code` is
 * the stable wire value a route maps to HTTP 501/409.
 */
export class NotEnabledError extends Error {
  readonly code = "PROVIDER_NOT_ENABLED" as const;
  constructor(readonly providerId: ProviderId, note: string) {
    super(`The ${providerId} quote provider is not enabled in v4.0 — ${note}`);
    this.name = "NotEnabledError";
  }
}
