import "server-only";
import { isFeedAckCurrent } from "@/lib/domain/live-feed-disclosure";
import { BASE, angelOneLogin, smartApiHeaders, smartApiJson, type AngelOneCredentials } from "@/lib/import/api/angelone";
import {
  angelCashKey,
  createAngelTokenResolver,
  type AngelExchange,
  type AngelSearchScrip,
  type AngelTokenCache,
  type AngelTokenResolver,
  type ResolvedAngelToken,
} from "./angelone-tokens";
import { createRateGuard, type RateGuard } from "./rate-guard";
import {
  angelOneCadenceSeconds,
  quoteKeyId,
  toPaise,
  type Paise,
  type ProviderCapabilities,
  type ProviderHealth,
  type Quote,
  type QuoteKey,
  type QuoteMap,
  type QuoteProvider,
  type TickListener,
  type Unsubscribe,
} from "./types";

/**
 * AngelOneProvider — live prices from the user's OWN Angel One account
 * (v4.2, owner rulings 4.2-4, 4.2-7, 4.2-8, 4.2-9).
 *
 * THE FEED WITH NO READ-ONLY KEY. Upstox has an Analytics token its own
 * contract makes incapable of trading; Angel One has nothing of the kind. The
 * jwt that reads a price could place an order, and there is no setting, scope
 * or key type that removes that. So the protection is not a claim about the
 * credential, it is a property of the CODE: this file and
 * `lib/quotes/angelone-tokens.ts` contain no order, modify or cancel path and
 * no URL under `/order/v1/` other than `searchScrip`, and
 * `tests/angelone-api.test.ts` greps both sources on every run so one cannot be
 * added quietly. The consent sheet says exactly that, in those words.
 *
 * SEVEN PROPERTIES THIS FILE IS RESPONSIBLE FOR
 * ---------------------------------------------
 * 1. PAISE AT THE EDGE (invariant 1). Angel One speaks rupees; `toPaise()` is
 *    applied exactly once, here, and nothing downstream sees a float rupee.
 * 2. NOT ONE JOURNAL WRITE. Ticks exist only in the listener's memory. The one
 *    thing this feed persists is the symbol → token mapping (migration 0070),
 *    which is a fact about the market and not about a book; the single stored
 *    price of the day is written by `lib/quotes/persist-mark.ts`.
 * 3. ONE LOGIN A DAY, ONE ATTEMPT AT A TIME, AND THREE IN ALL (ruling C-2).
 *    Angel One FLUSHES every session at 05:00 IST — the jwt's own `exp` claim
 *    is a red herring and trusting it would send a dead token all morning. The
 *    jwt is cached in memory until the next 05:00 IST and re-minted then, or
 *    immediately when an envelope says the session is invalid. A FAILED login
 *    is never retried in a loop: `generateTokens` is capped at 1,000/hour and a
 *    wrong PIN fails identically the second time, so the next attempt waits
 *    60 s and `health()` says why in the meantime — AND the attempts are
 *    COUNTED. After three consecutive refusals this instance stops signing in
 *    altogether: a PIN saved wrong once would otherwise be transmitted every
 *    60 s for as long as the desk is open (1,440 times a day), and the third
 *    identical refusal is not evidence a fourth will differ. A SUCCESSFUL
 *    login resets the count; a re-saved credential or a relaunch builds a new
 *    instance (`lib/quotes/registry.ts` keys its cache on `updated_at` plus a
 *    fingerprint of the stored ciphertext), which is how the user clears it.
 * 4. TWO CEILINGS, BOTH REFUSING (never queueing). One request a second
 *    (`createRateGuard(1)`), and a rolling 4,000 an hour. Angel One publishes
 *    1/s in one place and 10/s in another, and 5,000/hour; Vyuha takes the
 *    stricter of each published pair and leaves 20 % of the hour spare. A
 *    refusal is one visible gap on one poll; a queue would hand the desk a
 *    minute-old price and let the UI call it live.
 * 5. THE CADENCE IS THE BOOK'S SIZE, NOT A SLIDER (ruling 4.2-4). 3 / 5 / 10 s
 *    by open-position count, from `angelOneCadenceSeconds()` in the pure types
 *    module — the same function the Live Desk renders its sentence from.
 *    `refreshSeconds` is accepted and IGNORED, deliberately and visibly.
 * 6. NOTHING IS ZERO-FILLED. `unfetched` rows are counted and OMITTED, an
 *    unresolvable symbol is labelled, a derivative is never sent at all, and a
 *    non-positive last price is refused rather than marked (invariant 6).
 * 7. NO SOURCE TIME IS INVENTED. OHLC mode carries no timestamp, so `asOf` is
 *    RECEIPT time and `staleness` is "delayed". Outside market hours Angel One
 *    answers with the last session's prices and says nothing about when they
 *    were true — so neither does this file.
 *
 * DEVIATION, the same one OpenAlgo and Upstox record: `capabilities.streaming`
 * is TRUE while `subscribe()` is a POLL. The flag's contract in this codebase
 * is "subscribe() really emits", and the SSE route starts a subscription only
 * when it is set. The honesty the prose was protecting is carried by
 * `staleness: "delayed"`, which is what the desk renders.
 */

/** Vyuha's own ceiling. Angel One publishes 1/s in one place and 10/s in another. */
export const ANGELONE_RATE_LIMIT_PER_SECOND = 1;

/** Angel One's documented maximum exchange tokens in one quote request. */
export const ANGELONE_MAX_TOKENS_PER_CALL = 50;

/** Rolling hourly ceiling. Angel One publishes 5,000; Vyuha keeps 20 % spare. */
export const ANGELONE_HOURLY_BUDGET = 4000;

/**
 * searchScrip calls per poll cycle. Five, because resolution is what unblocks
 * pricing: a fresh 50-symbol book is fully resolved inside the first minute
 * (ten cycles) and the desk prices whatever is already resolved throughout.
 */
export const ANGELONE_LOOKUPS_PER_CYCLE = 5;

/**
 * The gap Vyuha holds between two requests to Angel One.
 *
 * THIS IS PACING, NOT A QUEUE. A snapshot of N positions is ceil(N/50) requests
 * by the API's own batch cap, and the cadence tiers were chosen to give each of
 * them a second (200 positions → 4 requests → a 5 s cycle). So the requests of
 * ONE snapshot are spaced a second apart while it runs, and nothing is ever
 * buffered between cycles: a batch that does not get out is DROPPED and
 * counted, and the next cycle starts from a clean sheet.
 */
export const ANGELONE_MIN_REQUEST_GAP_MS = 1000;

/** After a failed login, the earliest the next attempt may be made. */
export const ANGELONE_LOGIN_RETRY_MS = 60_000;

/**
 * Consecutive REFUSED logins after which this instance stops signing in
 * (owner ruling C-2, v4.2 fix wave 3).
 *
 * The 60 s stamp above spaces the attempts; it never ENDS them, so a wrong PIN
 * saved once was re-sent to Angel One every minute for as long as the desk
 * polled — up to 1,440 credential transmissions a day, each one refused for the
 * same reason as the first. Three is the cap because the second and third
 * attempts cover the failures that are not about the credential at all (a clock
 * that drifted a TOTP step, one bad response), and nothing after that is
 * evidence a fourth would differ.
 *
 * THE CAP IS PER INSTANCE, AND THAT IS THE RESET. The registry memoises one
 * instance per process keyed on the connection row's `updated_at` and a
 * fingerprint of the stored ciphertext, so re-saving the credentials builds a
 * fresh instance with a fresh count — and so does a relaunch. Nothing here is
 * persisted; a cap that outlived the process would be a lock-out.
 */
export const ANGELONE_MAX_LOGIN_ATTEMPTS = 3;

/**
 * What the desk is told once the cap is reached — VERBATIM, and the only
 * sentence this state produces. It names the three credentials and the screen
 * that holds them, because re-saving them is the ONLY thing that clears it.
 */
export const ANGELONE_LOGIN_CAPPED_REASON =
  "Angel One refused the login three times — re-save the client code, PIN and TOTP secret under Import → Connect broker.";

/** Angel One clears EVERY session at 05:00 IST, whatever the jwt's exp says. */
export const ANGELONE_SESSION_FLUSH_IST_HOUR = 5;

export const ANGELONE_QUOTE_PATH = "/rest/secure/angelbroking/market/v1/quote/";

/** OHLC is the cheapest mode that carries the previous close the desk needs. */
export const ANGELONE_QUOTE_MODE = "OHLC";

export const ANGELONE_CAPABILITIES: ProviderCapabilities = {
  id: "angelone",
  label: "Angel One",
  // A poll that really emits — see the deviation note in the header.
  streaming: true,
  maxSubscriptions: 500,
  minSnapshotIntervalMs: 3000,
  depth: 0,
  // Equities only in this release (ruling 4.2-8): NFO/BFO/MCX/CDS keys are
  // never sent, so they are not claimed here either.
  segments: ["NSE", "BSE"],
  staleness: "delayed",
  // Angel One flushes every session at 05:00 IST. This is the one provider for
  // which the flag is literally true every trading day.
  requiresDailyAuth: true,
  // The sign-in clause is a PROCESS rule, not a calendar one (B-7), and it now
  // states its own ceiling (C-2): the session lives in one memoised instance,
  // so "once a day" is true while that instance is, and a refused login stops
  // at three attempts instead of repeating every minute.
  egressDescription:
    "Requests go to apiconnect.angelone.in — your own Angel One account, using the client code, PIN and TOTP secret you saved for imports: signed in at most once a day while Vyuha stays open, again after a relaunch, after Angel One's 5 AM IST session flush, or when the credentials are re-saved; a refused login is retried at most three times. Only the exchange tokens of your open equity positions are sent, and no other host is contacted for prices.",
};

/* ─────────────────────────── the session, and its clock ─────────────────── */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PURE. When a session minted at `loginAtMs` stops being usable.
 *
 * Angel One clears every session at 05:00 IST — not 24 hours after login, and
 * NOT when the jwt's own `exp` claim says. A login at 09:15 IST is good until
 * 05:00 IST tomorrow; a login at 04:30 IST is good for thirty minutes. The
 * clock is an argument so a test can prove both without waiting for a morning.
 */
export function angelOneSessionExpiresAt(loginAtMs: number): number {
  const ist = loginAtMs + IST_OFFSET_MS;
  const dayStart = Math.floor(ist / DAY_MS) * DAY_MS;
  let flush = dayStart + ANGELONE_SESSION_FLUSH_IST_HOUR * 60 * 60 * 1000;
  if (flush <= ist) flush += DAY_MS;
  return flush - IST_OFFSET_MS;
}

/**
 * PURE. Does this failure mean the SESSION died, rather than the request being
 * wrong?
 *
 * Angel One's invalid/expired/missing-token codes are AG8001/AG8002/AG8003 and
 * the envelope carries `status:false` with the message; an HTTP 401 says the
 * same thing at a different layer. Anything else — a bad token id, a refused
 * batch — is NOT a reason to re-login, and treating it as one would spend the
 * 1,000/hour login budget on a problem a login cannot fix.
 */
export function isAngelSessionInvalid(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e);
  return /AG800[123]|invalid token|token expired|session expired|unauthor|\b401\b/i.test(raw);
}

/** PURE. An Angel One failure → the sentence the desk shows. */
export function angelOneFeedErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/totp/i.test(raw)) {
    return `Angel One refused the TOTP code (${raw}). Check the enrolled secret under Import → Connect broker and this machine's clock — a drifted clock produces valid-looking wrong codes. Prices stop arriving until it is fixed, and the desk keeps the last mark it had.`;
  }
  if (isAngelSessionInvalid(e)) {
    // The re-sign-in after the 05:00 IST flush is legitimate and stays. It is
    // the same attempt as any other, so it counts toward the C-2 cap only if it
    // is REFUSED — and this sentence says so rather than promising an unlimited
    // retry the code no longer performs.
    return `Angel One says the session is no longer valid (${raw}). Vyuha signs in again on the next poll; Angel One clears every session at 5 AM IST, so this is expected once a morning. If that sign-in is refused it is attempted three times in all, and then stopped.`;
  }
  if (/password|\bpin\b/i.test(raw)) {
    return `Angel One refused the login PIN (${raw}) — the login PIN, not the account password. Re-enter it under Import → Connect broker.`;
  }
  return raw;
}

/* ──────────────────────────── the hourly counter ────────────────────────── */

export interface AngelOneHourlyBudget {
  /** True when the request may go. False means REFUSE — never "try later". */
  take(now: number): boolean;
  /** Requests inside the rolling hour, for `health()`. */
  used(now: number): number;
}

/**
 * A rolling ONE-HOUR window, refusing past `limit`. Same policy as
 * `createRateGuard` at a different horizon — it lives here rather than in
 * `rate-guard.ts` because it is Angel One's published ceiling, not a shared
 * one, and the shared module belongs to every provider.
 */
export function createHourlyBudget(limit = ANGELONE_HOURLY_BUDGET): AngelOneHourlyBudget {
  const stamps: number[] = [];
  const trim = (now: number) => {
    while (stamps.length > 0 && now - stamps[0] >= 3_600_000) stamps.shift();
  };
  return {
    take(now: number): boolean {
      trim(now);
      if (stamps.length >= limit) return false;
      stamps.push(now);
      return true;
    },
    used(now: number): number {
      trim(now);
      return stamps.length;
    },
  };
}

/* ─────────────────────────── the wire, and its shapes ───────────────────── */

/** One instrument's OHLC block. Every field optional: a miss becomes null. */
export interface AngelQuoteRow {
  exchange?: string | null;
  tradingSymbol?: string | null;
  /** The token AS SENT — the only reliable way back to the QuoteKey. */
  symbolToken?: string | null;
  ltp?: number | string | null;
  open?: number | string | null;
  high?: number | string | null;
  low?: number | string | null;
  /** The PREVIOUS day's close in OHLC mode — this is `prevClose`, not today's. */
  close?: number | string | null;
}

export interface AngelQuoteData {
  fetched?: AngelQuoteRow[] | null;
  /** Tokens Angel One would not price. Counted; the rows stay unmarked. */
  unfetched?: unknown[] | null;
}

/** One quote request: one exchange, at most 50 tokens (grouped, never mixed). */
export interface AngelQuoteBatch {
  exchange: AngelExchange;
  tokens: string[];
}

/** The quote request, injected in tests so no test ever opens a socket. */
export type AngelQuoteFetcher = (
  creds: AngelOneCredentials,
  jwt: string,
  batch: AngelQuoteBatch,
) => Promise<AngelQuoteData | null>;

/**
 * The ONE quote request, on the ONE host. `BASE` comes from
 * `lib/import/api/angelone.ts` so there is a single host string in the tree.
 */
export const angelQuoteFetcher: AngelQuoteFetcher = async (creds, jwt, batch) => {
  const res = await fetch(`${BASE}${ANGELONE_QUOTE_PATH}`, {
    method: "POST",
    headers: smartApiHeaders(creds.apiKey, jwt),
    body: JSON.stringify({ mode: ANGELONE_QUOTE_MODE, exchangeTokens: { [batch.exchange]: batch.tokens } }),
    cache: "no-store",
  });
  return smartApiJson<AngelQuoteData>(res, "quote");
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function paiseOrNull(v: unknown): Paise | null {
  const n = num(v);
  return n == null ? null : toPaise(n);
}

/**
 * PURE. One `fetched` row → a `Quote`. Null when there is no usable last price.
 *
 * `close` IS `prevClose`. Angel One's OHLC mode states the PREVIOUS session's
 * close under that name, and reading it as today's close would print a day
 * change of zero on every row — a number that looks like a flat market rather
 * than like missing data.
 *
 * A zero or negative last price is not a price: refuse it rather than mark a
 * position to zero and print a −100 % day (invariant 6). `asOf` is RECEIPT time
 * because the payload states no source time — see property 7 in the header.
 */
export function quoteFromAngelOne(key: QuoteKey, row: AngelQuoteRow, receivedAtIso: string): Quote | null {
  const last = num(row.ltp);
  if (last == null || last <= 0) return null;
  return {
    key,
    ltp: toPaise(last),
    prevClose: paiseOrNull(row.close),
    dayOpen: paiseOrNull(row.open),
    dayHigh: paiseOrNull(row.high),
    dayLow: paiseOrNull(row.low),
    // OHLC mode carries no volume. Null, never a zero that renders as "no trades".
    volume: null,
    asOf: receivedAtIso,
    staleness: "delayed",
    source: "angelone",
  };
}

/**
 * PURE. Resolved tokens → the requests Angel One will accept.
 *
 * Grouped by EXCHANGE and then chunked at 50, because the token spaces are
 * per-exchange (the same digits are two different companies on NSE and BSE) and
 * a request that mixes them has to be un-mixed on the way back by a field the
 * response might omit. One exchange per request means the answer is
 * attributable by construction.
 *
 * The cap is applied HERE rather than left to the API: over 50 tokens Angel One
 * rejects the whole call, so one position too many would blank the entire desk
 * instead of costing one batch.
 */
export function planAngelOneBatches(
  tokens: readonly ResolvedAngelToken[],
  size = ANGELONE_MAX_TOKENS_PER_CALL,
): AngelQuoteBatch[] {
  const byExchange = new Map<AngelExchange, string[]>();
  for (const t of tokens) {
    const list = byExchange.get(t.exchange) ?? [];
    if (!list.includes(t.token)) list.push(t.token);
    byExchange.set(t.exchange, list);
  }
  const batches: AngelQuoteBatch[] = [];
  // NSE first, deterministically: a stable request order makes a truncated
  // cycle truncate the same way twice, which is what makes it diagnosable.
  for (const exchange of ["NSE", "BSE"] as const) {
    const list = byExchange.get(exchange);
    if (!list || list.length === 0) continue;
    for (let i = 0; i < list.length; i += size) {
      batches.push({ exchange, tokens: list.slice(i, i + size) });
    }
  }
  return batches;
}

/* ─────────────────────────────── credentials ────────────────────────────── */

export type AngelOneGateState =
  /** The Angel One feed disclosure was never accepted, or at an older version. */
  | { state: "disabled"; reason: string }
  /** Consent is in place but no usable Angel One connection is saved. */
  | { state: "no-key"; reason: string }
  | { state: "ready"; creds: AngelOneCredentials };

/** Injected in tests; the default reads settings + broker_connections. */
export type AngelOneGateReader = () => Promise<AngelOneGateState>;

/** `angelOneLogin`, injected in tests so no test ever opens a socket. */
export type AngelOneLogin = (creds: AngelOneCredentials) => Promise<{ jwtToken: string }>;

export interface AngelOneHealth extends ProviderHealth {
  state: "disabled" | "no-key" | "unreachable" | "ok";
  /** Symbols with an Angel One token in hand. */
  resolvedSymbols: number;
  /** Symbols Angel One had no usable row for — labelled, never guessed. */
  unresolvedSymbols: number;
  /** Symbols still waiting for their lazy lookup. */
  pendingSymbols: number;
  /** Positions this feed never sends: futures, options, other exchanges. */
  skippedDerivatives: number;
  /** Tokens Angel One would not price on the last poll. Omitted, not zeroed. */
  unfetched: number;
  /** Requests inside the rolling hour, out of `ANGELONE_HOURLY_BUDGET`. */
  hourlyBudgetUsed: number;
  /** Seconds between polls, from the cadence ladder (ruling 4.2-4). */
  cadenceSeconds: 3 | 5 | 10;
}

const NO_CONSENT_REASON =
  "The Angel One live-price disclosure has not been accepted on this machine. Open Settings → Live feed, read what the feed sends, and accept it to continue.";
const NO_KEY_REASON =
  "No Angel One connection is saved for this account. Save the API key, client code, PIN and TOTP secret under Import → Connect broker, then pick Angel One in Settings → Live feed.";

/**
 * Reads the SAME storage the import path uses: the per-provider acknowledgement
 * on `settings` (migration 0069), and the SmartAPI key plus the
 * `{clientCode, pin, totpSecret}` blob on `broker_connections`
 * (`broker = 'angelone'`, both vault ciphertext). Nothing new is stored for the
 * live feed — a second copy of a credential is a second thing to leak, and this
 * credential can trade.
 *
 * `@/lib/db` is imported LAZILY, like every other provider in this folder: a
 * static import would bind the SQLite connection at module-import time and
 * break `tests/helpers/temp-db.ts` for anything that touches the registry.
 *
 * ACCOUNT SCOPE (invariant 8): the connection is read through the selected
 * account when one is selected. In the All-accounts view (id 0, a view that
 * never receives a write — invariant 9) the most recently updated Angel One
 * connection wins, because a feed for "every book at once" has no single owner
 * and refusing outright would make the desk useless in the default view.
 */
async function readGateFromDb(): Promise<AngelOneGateState> {
  const { db } = await import("@/lib/db");
  const { settings, brokerConnections } = await import("@/lib/db/schema");
  const { readSecret } = await import("@/lib/vault");
  const { getSelectedAccountId } = await import("@/lib/queries/accounts");
  const { desc, eq } = await import("drizzle-orm");

  const s = db.select({ ack: settings.liveFeedAckJson }).from(settings).limit(1).all()[0];
  if (!isFeedAckCurrent(s?.ack ?? null, "angelone")) return { state: "disabled", reason: NO_CONSENT_REASON };

  const accountId = getSelectedAccountId();
  const rows = db
    .select({
      accountId: brokerConnections.accountId,
      apiKey: brokerConnections.apiKey,
      authJson: brokerConnections.authJson,
    })
    .from(brokerConnections)
    .where(eq(brokerConnections.broker, "angelone"))
    .orderBy(desc(brokerConnections.updatedAt))
    .all();
  const scoped = accountId > 0 ? rows.filter((r) => r.accountId === accountId) : rows;

  for (const row of scoped) {
    const key = readSecret(row.apiKey);
    const auth = readSecret(row.authJson);
    if (!key.ok || !key.value || !auth.ok || !auth.value) continue;
    let blob: { clientCode?: string; pin?: string; totpSecret?: string };
    try {
      blob = JSON.parse(auth.value) as typeof blob;
    } catch {
      continue;
    }
    if (!blob.clientCode || !blob.pin || !blob.totpSecret) continue;
    return {
      state: "ready",
      creds: { apiKey: key.value, clientCode: blob.clientCode, pin: blob.pin, totpSecret: blob.totpSecret },
    };
  }
  return { state: "no-key", reason: NO_KEY_REASON };
}

/* ──────────────────────────────── provider ──────────────────────────────── */

export interface AngelOneProviderOptions {
  readGate?: AngelOneGateReader;
  /**
   * ACCEPTED AND IGNORED (ruling 4.2-4). The registry passes the stored slider
   * value to every provider; Angel One's cadence comes from the open-position
   * count and nothing else. Named so the ignoring is visible in the signature
   * rather than surprising at the call site.
   */
  refreshSeconds?: number;
  /** Injected in tests so the guards, the session clock and `asOf` are exact. */
  now?: () => number;
  /** Injected in tests so the 1 s pacing costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  loginImpl?: AngelOneLogin;
  quoteImpl?: AngelQuoteFetcher;
  searchImpl?: AngelSearchScrip;
  tokenCache?: AngelTokenCache;
  resolver?: AngelTokenResolver;
  /** searchScrip calls per cycle; the default is `ANGELONE_LOOKUPS_PER_CYCLE`. */
  lookupsPerCycle?: number;
}

export function createAngelOneProvider(opts: AngelOneProviderOptions = {}): QuoteProvider {
  const readGate = opts.readGate ?? readGateFromDb;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const login: AngelOneLogin = opts.loginImpl ?? angelOneLogin;
  const doQuote: AngelQuoteFetcher = opts.quoteImpl ?? angelQuoteFetcher;
  const lookupsPerCycle = opts.lookupsPerCycle ?? ANGELONE_LOOKUPS_PER_CYCLE;
  const resolver: AngelTokenResolver =
    opts.resolver ?? createAngelTokenResolver({ search: opts.searchImpl, cache: opts.tokenCache, now });

  const guard: RateGuard = createRateGuard(ANGELONE_RATE_LIMIT_PER_SECOND);
  const budget = createHourlyBudget(ANGELONE_HOURLY_BUDGET);

  /** In memory only, and only until Angel One's 05:00 IST flush. */
  let jwt: string | null = null;
  let jwtUntil = 0;
  let lastLoginFailAt: number | null = null;
  let lastLoginError: string | null = null;
  /**
   * CONSECUTIVE refused logins (ruling C-2). Reset by a success, never
   * persisted, and never incremented by a refusal of Vyuha's OWN guards — those
   * send nothing, so they are not evidence about the credential.
   */
  let consecutiveLoginFailures = 0;
  let lastError: string | null = null;
  let lastRequestAt: number | null = null;

  /** What the last snapshot could not price, for `health()`. */
  let lastResolved = 0;
  let lastUnresolved = 0;
  let lastPending = 0;
  let lastSkipped = 0;
  let lastUnfetched = 0;
  let lastCadence: 3 | 5 | 10 = angelOneCadenceSeconds(0);

  /**
   * One request slot: paced to a second, then checked against BOTH ceilings.
   *
   * The pacing is what makes the ceilings satisfiable — a snapshot of 200
   * positions is four requests and its cadence tier gives it five seconds. The
   * guards are what makes the ceilings TRUE: if the pacing is ever wrong, the
   * request is refused rather than sent, and the refusal reaches the user as a
   * gap plus a reason instead of as a broker-side ban.
   */
  async function slot(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (lastRequestAt != null) {
      const wait = lastRequestAt + ANGELONE_MIN_REQUEST_GAP_MS - now();
      if (wait > 0) await sleep(wait);
    }
    const t = now();
    if (!guard.take(t)) {
      return {
        ok: false,
        reason: `Vyuha's own rate guard stopped this request: at most ${ANGELONE_RATE_LIMIT_PER_SECOND} request per second goes to Angel One. Nothing was sent.`,
      };
    }
    if (!budget.take(t)) {
      return {
        ok: false,
        reason: `Vyuha's own hourly ceiling stopped this request: at most ${ANGELONE_HOURLY_BUDGET} requests an hour go to Angel One. Nothing was sent, and the count falls as the hour rolls forward.`,
      };
    }
    lastRequestAt = t;
    return { ok: true };
  }

  /** True once three consecutive logins have been REFUSED (ruling C-2). */
  function loginCapReached(): boolean {
    return consecutiveLoginFailures >= ANGELONE_MAX_LOGIN_ATTEMPTS;
  }

  /**
   * The jwt, minted at most once a day, at most once a minute after a failure,
   * and at most three times in a row when it keeps being refused. ONE attempt,
   * never a loop, and never for ever — see property 3 in the header.
   */
  async function session(creds: AngelOneCredentials): Promise<string> {
    const t = now();
    if (jwt && t < jwtUntil) return jwt;
    // THE CAP IS CHECKED BEFORE THE CLOCK. Past three refusals the 60 s stamp
    // is irrelevant: no attempt is made again on this instance at any hour, so
    // the credential stops going out entirely rather than going out slower.
    if (loginCapReached()) throw new Error(ANGELONE_LOGIN_CAPPED_REASON);
    if (lastLoginFailAt != null && t - lastLoginFailAt < ANGELONE_LOGIN_RETRY_MS) {
      throw new Error(lastLoginError ?? "The last Angel One sign-in failed; the next attempt is a minute away.");
    }
    const allowed = await slot();
    if (!allowed.ok) throw new Error(allowed.reason);
    try {
      const { jwtToken } = await login(creds);
      jwt = jwtToken;
      jwtUntil = angelOneSessionExpiresAt(t);
      lastLoginFailAt = null;
      lastLoginError = null;
      // A SUCCESS RESETS THE COUNT — the cap is about three refusals in a row,
      // not about three refusals ever. The morning re-sign-in after the 05:00
      // IST flush therefore starts from zero on a session that worked.
      consecutiveLoginFailures = 0;
      return jwtToken;
    } catch (e) {
      jwt = null;
      jwtUntil = 0;
      lastLoginFailAt = t;
      lastLoginError = angelOneFeedErrorMessage(e);
      consecutiveLoginFailures += 1;
      // The third refusal reports the cap itself, so the sentence the user is
      // left looking at is the one that says what to do about it.
      throw new Error(loginCapReached() ? ANGELONE_LOGIN_CAPPED_REASON : lastLoginError);
    }
  }

  function invalidateSession(): void {
    jwt = null;
    jwtUntil = 0;
  }

  async function snapshot(keys: readonly QuoteKey[], _signal?: AbortSignal): Promise<QuoteMap> {
    const out: QuoteMap = new Map();
    if (keys.length === 0) return out;
    const gate = await readGate();
    if (gate.state !== "ready") throw new Error(gate.reason);
    lastCadence = angelOneCadenceSeconds(keys.length);

    let token: string;
    try {
      token = await session(gate.creds);
      lastError = null;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      throw new Error(lastError);
    }

    // RESOLUTION FIRST: an unresolved symbol cannot be priced at all, so the
    // cycle's early seconds go to the lookups that unblock it.
    const resolved = await resolver.resolve(keys, {
      creds: gate.creds,
      jwt: token,
      budget: lookupsPerCycle,
      pace: async () => (await slot()).ok,
    });
    lastResolved = resolved.tokens.size;
    lastUnresolved = resolved.unresolved.length;
    lastPending = resolved.pending.length;
    lastSkipped = resolved.skipped.length;
    if (resolved.lookupError) {
      lastError = angelOneFeedErrorMessage(resolved.lookupError);
      if (isAngelSessionInvalid(resolved.lookupError)) invalidateSession();
    }

    /** `${exchange}|${token}` → the QuoteKey that asked for it. */
    const byToken = new Map<string, QuoteKey>();
    for (const key of keys) {
      const cash = angelCashKey(key);
      if (!cash) continue;
      const hit = resolved.tokens.get(cash.id);
      if (!hit) continue;
      byToken.set(`${hit.exchange}|${hit.token}`, key);
    }
    const batches = planAngelOneBatches([...resolved.tokens.values()]);
    if (batches.length === 0) return out;

    const receivedAt = new Date(now()).toISOString();
    let unfetched = 0;
    for (const batch of batches) {
      const allowed = await slot();
      if (!allowed.ok) {
        // REFUSED, NOT QUEUED. The remaining batches are dropped and the next
        // cycle starts clean; the rows they would have priced keep their last
        // mark and the reason is on the health pill.
        lastError = allowed.reason;
        break;
      }
      let data: AngelQuoteData | null;
      try {
        data = await doQuote(gate.creds, token, batch);
      } catch (e) {
        lastError = angelOneFeedErrorMessage(e);
        if (isAngelSessionInvalid(e)) invalidateSession();
        break;
      }
      unfetched += Array.isArray(data?.unfetched) ? data.unfetched.length : 0;
      for (const row of data?.fetched ?? []) {
        const exchange = String(row?.exchange ?? "").trim().toUpperCase();
        const rowToken = String(row?.symbolToken ?? "").trim();
        // Attributed by the token that was SENT, never by the tradingsymbol:
        // a near-match on a name puts one company's price on another's row.
        const key = byToken.get(`${exchange}|${rowToken}`);
        if (!key) continue;
        const quote = quoteFromAngelOne(key, row, receivedAt);
        if (quote) out.set(quoteKeyId(key), quote);
      }
    }
    lastUnfetched = unfetched;
    return out;
  }

  return {
    id: "angelone",
    capabilities: ANGELONE_CAPABILITIES,
    snapshot,

    /**
     * Poll `snapshot()` on the CADENCE LADDER and emit ONLY what changed.
     *
     * The interval is `angelOneCadenceSeconds(keys.length)` — the count of
     * positions being watched IS the open-position count of the selected
     * account, because that is what the desk subscribes with. The slider is not
     * consulted (ruling 4.2-4).
     *
     * There is no first poll on subscribe: the SSE route sends a snapshot on
     * connect, and a poll here would repeat it as a tick a moment later. A poll
     * that fails is swallowed — the desk keeps the last price it had, and
     * `health()` is what explains a session that died.
     */
    subscribe(keys: readonly QuoteKey[], onTick: TickListener, signal?: AbortSignal): Unsubscribe {
      if (keys.length === 0 || signal?.aborted) return () => {};
      const periodMs = angelOneCadenceSeconds(keys.length) * 1000;
      lastCadence = angelOneCadenceSeconds(keys.length);
      let stopped = false;
      let inFlight = false;
      const lastSeen = new Map<string, string>();

      const poll = async () => {
        if (stopped || inFlight) return;
        inFlight = true;
        try {
          const map = await snapshot(keys, signal);
          if (stopped) return;
          for (const [id, q] of map) {
            // Change = the numbers a desk renders. Receipt time alone is not a
            // change; emitting on it would push a frame every poll forever.
            const sig = `${q.ltp}|${q.dayHigh}|${q.dayLow}|${q.prevClose}`;
            if (lastSeen.get(id) === sig) continue;
            lastSeen.set(id, sig);
            onTick(q);
          }
        } catch {
          /* one failed poll is not the end of the subscription */
        } finally {
          inFlight = false;
        }
      };

      const timer = setInterval(() => void poll(), periodMs);
      const stop: Unsubscribe = () => {
        if (stopped) return; // idempotent, by contract
        stopped = true;
        clearInterval(timer);
        signal?.removeEventListener("abort", stop);
      };
      signal?.addEventListener("abort", stop);
      return stop;
    },

    /**
     * NEVER throws, and MAKES NO REQUEST OF ITS OWN.
     *
     * The consent sheet names exactly two kinds of request — the daily sign-in
     * and the price poll — so a probe call would be a third nobody was told
     * about, and on this provider a probe would ALSO burn a login. What
     * health() reports is the gate, the last poll's outcome, how many positions
     * this feed cannot price and why, and how much of the hourly budget is
     * spent — which is the set of numbers a user needs when a row shows no mark.
     */
    async health(): Promise<AngelOneHealth> {
      const counts = {
        resolvedSymbols: lastResolved,
        unresolvedSymbols: lastUnresolved,
        pendingSymbols: lastPending,
        skippedDerivatives: lastSkipped,
        unfetched: lastUnfetched,
        hourlyBudgetUsed: budget.used(now()),
        cadenceSeconds: lastCadence,
      };
      let gate: AngelOneGateState;
      try {
        gate = await readGate();
      } catch (e) {
        return {
          ok: false,
          state: "disabled",
          ...counts,
          reason: e instanceof Error ? e.message : "The Angel One feed settings could not be read.",
        };
      }
      if (gate.state === "disabled") return { ok: false, state: "disabled", ...counts, reason: gate.reason };
      if (gate.state === "no-key") return { ok: false, state: "no-key", ...counts, reason: gate.reason };
      // A CAPPED INSTANCE ARRIVES HERE, and this is the branch that reports it
      // (ruling C-2). Once the cap is reached `session()` throws
      // ANGELONE_LOGIN_CAPPED_REASON before anything else in `snapshot()` runs,
      // so `lastError` IS that sentence, verbatim — a second branch testing the
      // counter here could never fire, and a guard that cannot fire is worse
      // than no guard.
      //
      // `unreachable`, not `no-key`: a connection IS saved — it was refused —
      // and `no-key` is defined one screen up as "no usable Angel One
      // connection is saved". Both states open the desk's once-a-day connect
      // prompt (`lib/live/connect-prompt.ts`), and its Angel One headline is
      // chosen by PROVIDER, not by state, so the user is sent to Import →
      // Connect broker either way; `unreachable` is the one whose documented
      // meaning ("saved, but the broker sign-in is the common cause") is true
      // here.
      if (lastError) return { ok: false, state: "unreachable", ...counts, reason: lastError };

      const notPriced = counts.unresolvedSymbols + counts.skippedDerivatives;
      return {
        ok: true,
        state: "ok",
        ...counts,
        reason:
          `Angel One is connected with your own account, polling every ${counts.cadenceSeconds} seconds.` +
          (notPriced === 0
            ? ""
            : // THE B-5 FALLBACK, IN THE B-5 WORDS (v4.2 fix wave 2). This
              // sentence is published by the GET verbatim and printed by the
              // SAME Settings card that prints the B-5 footnote, so on a book
              // holding a derivative the card states both promises at once. The
              // tail once named a value nothing writes — no writer stores a
              // CONTRACT-keyed mark, so there is no such number to keep; what
              // the row shows is its recorded close, then A DASH (ruling C-11,
              // fix wave 3: the row prints "—", never the entry price, and this
              // clause is byte-identical on the card, the sheets, the help and
              // the docs).
              ` ${notPriced} position(s) are not priced by this feed — ${counts.skippedDerivatives} futures/options and ${counts.unresolvedSymbols} Angel One has no matching scrip for — and each shows the position's recorded close, or a dash when no close is recorded.`) +
          (counts.pendingSymbols === 0 ? "" : ` ${counts.pendingSymbols} more are still being looked up.`),
      };
    },
  };
}
