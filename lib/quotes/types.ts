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

/**
 * THE ONE SWITCH THAT SHIPS OR WITHHOLDS THE OPENALGO FEED (owner ruling).
 * v4.0 withheld it: it was absent from the shipped provider list, from the
 * route's pickable set and from the Settings radios, and a stored
 * `live_feed_provider = 'openalgo'` resolved to the end-of-day default
 * (`resolveProviderId()`). **v4.1 SHIPS IT** — this line is `true`, and that
 * was the whole of the change: the adapter (`lib/quotes/openalgo.ts`), its
 * tests, its capability block, its consent sheet and migration 0067 were all
 * built in 4.0 and only withheld.
 *
 * IT IS A RELEASE SWITCH, NOT A CONSENT. Being pickable is not permission to
 * run: `selectProviderId()` re-checks BOTH halves of the acknowledgement at
 * every selection, and `/api/live/feed` answers 403 and stores nothing until
 * they hold. Flipping this back to `false` withdraws the feature from all
 * four places at once, with no other edit.
 *
 * It lives in the PURE types module on purpose: `registry.ts` is
 * `server-only`, and the Settings card is a client component that has to read
 * the same fact.
 *
 * Typed `boolean` rather than left as the literal `true` so that the code
 * guarded by it stays type-checked instead of narrowing to dead branches.
 */
export const OPENALGO_FEED_ENABLED: boolean = true;

/**
 * THE SAME ONE SWITCH, FOR THE UPSTOX FEED (v4.2, owner ruling).
 *
 * `true` here is what moves `upstox` out of `PLANNED_PROVIDER_IDS` and into
 * `SHIPPED_PROVIDER_IDS`, puts the radio on the Settings card and lets the feed
 * route accept the id. Flipping it back to `false` withdraws the feature from
 * all of them at once with no other edit, and a stored
 * `live_feed_provider = 'upstox'` collapses to the end-of-day default again.
 *
 * IT IS A RELEASE SWITCH, NOT A CONSENT — the same distinction OpenAlgo's
 * constant carries. Being pickable is not permission to run: `selectProviderId()`
 * re-checks the acknowledgement stored in `settings.live_feed_ack_json` at every
 * selection (`isFeedAckCurrent`, strict `===` against
 * `LIVE_FEED_DISCLOSURE_VERSIONS.upstox`), so a restored backup carries the
 * picker value but never the consent.
 *
 * PURE MODULE ON PURPOSE: `registry.ts` is `server-only` and the Settings card
 * is a client component that has to read the same fact.
 */
export const UPSTOX_FEED_ENABLED: boolean = true;

/**
 * THE SAME ONE SWITCH, FOR THE ANGEL ONE FEED (v4.2, owner ruling 4.2-9).
 *
 * `true` — Angel One SHIPS ON in 4.2.0. The adapter is `lib/quotes/angelone.ts`
 * and its token resolver is `lib/quotes/angelone-tokens.ts`; the consent
 * storage it needed already existed (`settings.live_feed_ack_json`, migration
 * 0069, a provider-id → version map), which is why shipping it added a sheet
 * and a constant and NO second migration for the consent.
 *
 * IT IS A RELEASE SWITCH, NOT A CONSENT. Flipping it back to `false` returns
 * `angelone` to `PLANNED_PROVIDER_IDS`, removes the radio and makes the feed
 * route refuse the id — all with no other edit — while
 * `selectProviderId()` re-checks `isFeedAckCurrent(json, "angelone")` at every
 * selection either way. A restored backup carries the picker value and never
 * the consent.
 *
 * PURE MODULE ON PURPOSE: `registry.ts` is `server-only` and the Settings card
 * is a client component that has to read the same fact. Typed `boolean` rather
 * than the literal so the guarded code stays type-checked.
 */
export const ANGELONE_FEED_ENABLED: boolean = true;

/**
 * THE ANGEL ONE CADENCE LADDER (v4.2, owner ruling 4.2-4 — BINDING).
 *
 * Angel One's poll interval is decided by HOW MANY OPEN POSITIONS the selected
 * account holds, and by nothing else: the Live Desk refresh slider is IGNORED
 * for this provider. That is not a UI simplification, it is the rate budget
 * made visible — Angel One takes at most 50 exchange tokens per quote request
 * and Vyuha sends at most one request a second, so a book of N positions needs
 * ceil(N/50) seconds of wire time before it can be re-polled at all. The three
 * tiers are exactly that arithmetic with headroom:
 *
 *      ≤ 50 positions  → 1 request  → 3 s
 *   51–200 positions  → 2–4 requests → 5 s
 *  201–500 positions  → 5–10 requests → 10 s
 *
 * A slider set to 1 s on a 300-position book would ask for ten requests a
 * second, which Angel One would refuse and Vyuha would refuse first — so the
 * honest thing is to not offer the choice and to SAY which tier is in force.
 *
 * PURE, and exported from the pure module on purpose: the adapter times its
 * poll with it and the Settings/Live Desk card renders the same sentence from
 * the same function, so the number on screen cannot drift from the number in
 * the timer.
 */
export const ANGELONE_CADENCE_TIERS: readonly { maxOpenPositions: number; seconds: 3 | 5 | 10 }[] = [
  { maxOpenPositions: 50, seconds: 3 },
  { maxOpenPositions: 200, seconds: 5 },
  { maxOpenPositions: 500, seconds: 10 },
];

/**
 * PURE. Open-position count → the seconds between Angel One polls.
 *
 * Beyond the last tier the SLOWEST cadence stands rather than an extrapolation:
 * `capabilities.maxSubscriptions` is 500, so a larger book is already being
 * truncated somewhere, and speeding up in response to "too many" is the wrong
 * direction. A zero or negative count gets the fastest tier — there is nothing
 * to poll, and the number is only ever used to size a timer.
 */
export function angelOneCadenceSeconds(openCount: number): 3 | 5 | 10 {
  const n = Number.isFinite(openCount) ? openCount : 0;
  for (const tier of ANGELONE_CADENCE_TIERS) {
    if (n <= tier.maxOpenPositions) return tier.seconds;
  }
  return ANGELONE_CADENCE_TIERS[ANGELONE_CADENCE_TIERS.length - 1].seconds;
}

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
    super(`The ${providerId} quote provider is not enabled in this release — ${note}`);
    this.name = "NotEnabledError";
  }
}
