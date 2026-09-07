import "server-only";
import { openAlgoGate } from "@/lib/domain/openalgo-disclosure";
import { createEodBhavcopyProvider, EOD_CAPABILITIES } from "./eod-bhavcopy";
import { createManualProvider, MANUAL_CAPABILITIES } from "./manual";
import { createMockProvider, MOCK_CAPABILITIES } from "./mock";
import { isFeedAckCurrent, type LiveFeedDisclosureId } from "@/lib/domain/live-feed-disclosure";
import { clampRefreshSeconds, createOpenAlgoProvider, OPENALGO_CAPABILITIES } from "./openalgo";
import { createUpstoxProvider, UPSTOX_CAPABILITIES } from "./upstox";
import { ANGELONE_CAPABILITIES, createAngelOneProvider } from "./angelone";
import {
  ANGELONE_FEED_ENABLED,
  NotEnabledError,
  OPENALGO_FEED_ENABLED,
  UPSTOX_FEED_ENABLED,
  type ProviderCapabilities,
  type ProviderHealth,
  type ProviderId,
  type QuoteProvider,
} from "./types";

/**
 * The provider registry — which provider the desk runs, and the rule that
 * makes the privacy sheet enforceable.
 *
 * REGISTRY RULE (03D §1.2, spec §4.1): a provider is selectable only if every
 * host named in `capabilities.egressDescription` already has a line in
 * `docs/client/PRIVACY.md`. `tests/quotes-egress-guard.test.ts` reads that file
 * and enforces it over EVERY entry below, shipped and planned.
 *
 * SELECTION SOURCE (v4.1, migration 0067): `settings.live_feed_provider`,
 * read by the ASYNC `resolveLiveFeedProviderId()` below. The sync
 * `getQuoteProvider(stored)` keeps taking the stored value as an ARGUMENT,
 * with `VYUHA_QUOTE_PROVIDER` as the dev/e2e override and `eod` as the
 * default: this module must not import `@/lib/db` statically, or importing the
 * registry would bind the SQLite connection ahead of
 * `tests/helpers/temp-db.ts` for every test that touches it.
 *
 * CONSENT IS RE-CHECKED AT SELECTION, not trusted from the stored string
 * (`selectProviderId()`): "openalgo" resolves to `openalgo` only when the
 * integration is on AND the acknowledgement covers the disclosure as it reads
 * today. A restored backup carries the picker value but not the consent (the
 * consent columns are machine state), so a restore falls back to `eod` instead
 * of opening a feed nobody on THIS machine agreed to.
 *
 * v4.2 adds the BROKER feeds under the same rule, with their own storage:
 * `settings.live_feed_ack_json` (migration 0069) is a provider id → accepted
 * disclosure version map, and `liveFeedAckGate()` reads it with `===`. One
 * column serves BOTH brokers with no second migration: `upstox` ships behind
 * `UPSTOX_FEED_ENABLED` and `angelone` behind `ANGELONE_FEED_ENABLED` (ruling
 * 4.2-9 — Angel One ships ON in 4.2.0), each gated on its OWN key in that
 * column, so consenting to one broker's feed never opens the other's.
 *
 * SERVER-ONLY: three of the four shipped providers read the journal database
 * or the network. Client components import `@/lib/quotes/types` (pure), never
 * this file.
 */

export const DEFAULT_PROVIDER_ID: ProviderId = "eod";

/**
 * Built AND selectable in this release.
 *
 * `openalgo` joined this list in v4.1 (owner ruling, `OPENALGO_FEED_ENABLED`).
 * It was built in v4.0 and withheld from here, from the route's pickable set
 * and from the Settings radios, so `resolveProviderId()` — which validates a
 * stored value against this list plus the planned ones — collapsed a stored
 * `"openalgo"` to the end-of-day default. Being listed here is SELECTABILITY,
 * never permission: `selectProviderId()` below still re-checks the consent
 * pair, and flipping the constant back removes it everywhere at once.
 */
export const SHIPPED_PROVIDER_IDS: readonly ProviderId[] = [
  "eod",
  "manual",
  "mock",
  ...(OPENALGO_FEED_ENABLED ? (["openalgo"] as const) : []),
  // v4.2 ships the Upstox feed behind ONE constant, exactly as v4.1 shipped
  // OpenAlgo's. Being listed here is SELECTABILITY, never permission:
  // `selectProviderId()` re-checks the stored acknowledgement below.
  ...(UPSTOX_FEED_ENABLED ? (["upstox"] as const) : []),
  // …and v4.2 ships Angel One the same way (ruling 4.2-9). The line was
  // written before the adapter existed, and shipping it really was the one
  // edit the comment promised: `ANGELONE_FEED_ENABLED` went true.
  ...(ANGELONE_FEED_ENABLED ? (["angelone"] as const) : []),
];

/** Every id that MAY be planned — the type the notes and labels are keyed on. */
const PLANNABLE_IDS = ["kite", "upstox", "dhan", "angelone"] as const;
export type PlannedProviderId = (typeof PLANNABLE_IDS)[number];

/**
 * Typed, listed, and deliberately not built — see `createPlannedProvider()`.
 *
 * `upstox` and `angelone` BOTH left this list in v4.2 (their adapters are
 * `lib/quotes/upstox.ts` and `lib/quotes/angelone.ts`), and either comes back
 * the moment its constant is flipped off: the withheld state and the planned
 * state are the same state, so one constant withdraws the feature from the
 * shipped list, the picker and the route at once. `kite` and `dhan` are here
 * for the ordinary reason — nothing is built.
 */
export const PLANNED_PROVIDER_IDS: readonly PlannedProviderId[] = PLANNABLE_IDS.filter(
  (id) => !(id === "upstox" && UPSTOX_FEED_ENABLED) && !(id === "angelone" && ANGELONE_FEED_ENABLED),
);

const PLANNED_NOTES: Record<PlannedProviderId, string> = {
  kite: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
  upstox: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
  dhan: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
  angelone:
    "the adapter exists (lib/quotes/angelone.ts) and this release has withheld it — ANGELONE_FEED_ENABLED is false, and flipping it back to true returns the feed to the shipped list, the picker and the route at once.",
};

const PLANNED_LABELS: Record<PlannedProviderId, string> = {
  kite: "Zerodha Kite Connect (not enabled in this release)",
  upstox: "Upstox (not enabled in this release)",
  dhan: "Dhan (not enabled in this release)",
  angelone: "Angel One SmartAPI (not enabled in this release)",
};

/**
 * Capabilities of a provider that is switched off.
 *
 * `egressDescription` names NO host on purpose: a provider that cannot run
 * makes no request, and writing its future host here would put a claim in the
 * privacy surface that the current release does not honour. The host arrives in the same
 * release as the consent sheet and the PRIVACY line — not before.
 */
export function plannedCapabilities(id: PlannedProviderId): ProviderCapabilities {
  return {
    id,
    label: PLANNED_LABELS[id],
    streaming: false,
    maxSubscriptions: 0,
    minSnapshotIntervalMs: 0,
    depth: 0,
    segments: [],
    staleness: "delayed",
    requiresDailyAuth: false,
    egressDescription: "None. This provider is disabled in this release and makes no request.",
  };
}

/** A typed provider that refuses, loudly, everywhere except `health()`. */
export function createPlannedProvider(id: PlannedProviderId): QuoteProvider {
  const note = PLANNED_NOTES[id];
  return {
    id,
    capabilities: plannedCapabilities(id),
    async snapshot() {
      throw new NotEnabledError(id, note);
    },
    subscribe() {
      throw new NotEnabledError(id, note);
    },
    // health() never throws — that is the contract, and it is exactly how the
    // desk learns to show "not enabled" instead of a blank pill.
    async health(): Promise<ProviderHealth> {
      return { ok: false, reason: `Not enabled in this release — ${note}` };
    },
  };
}

const ALL_IDS: readonly ProviderId[] = [...SHIPPED_PROVIDER_IDS, ...PLANNED_PROVIDER_IDS];

function isPlanned(id: ProviderId): id is PlannedProviderId {
  return (PLANNED_PROVIDER_IDS as readonly string[]).includes(id);
}

/** PURE. An unknown or empty stored value resolves to the default, never to a throw. */
export function resolveProviderId(raw: string | null | undefined): ProviderId {
  const v = (raw ?? "").trim().toLowerCase();
  return (ALL_IDS as readonly string[]).includes(v) ? (v as ProviderId) : DEFAULT_PROVIDER_ID;
}

export function createProvider(id: ProviderId, refreshSeconds?: number): QuoteProvider {
  // THE BROKER FEEDS ARE DECIDED FIRST, before `isPlanned()` narrows their ids
  // away. Upstox: the adapter re-reads the acknowledgement and the saved
  // Analytics token on every call, so building one is never the same as being
  // allowed to use one — and with the flag off it falls through to the planned
  // branch below and refuses.
  if (id === "upstox" && UPSTOX_FEED_ENABLED) {
    return createUpstoxProvider({ refreshSeconds: clampRefreshSeconds(refreshSeconds) });
  }
  // Angel One: the adapter re-reads the acknowledgement and the saved
  // credentials on every call, so building one is never the same as being
  // allowed to use one. `refreshSeconds` is NOT passed — the cadence is the
  // open-position count (ruling 4.2-4) and the slider is ignored for this
  // provider, which is stated here as well as in the adapter so a future
  // reader does not "fix" the omission. With the flag off it falls through to
  // the planned branch below and refuses, rather than falling through to the
  // end-of-day default and pricing a book from a source the user never picked.
  if (id === "angelone" && ANGELONE_FEED_ENABLED) return createAngelOneProvider();
  if (isPlanned(id)) return createPlannedProvider(id);
  if (id === "mock") return createMockProvider();
  if (id === "manual") return createManualProvider();
  // The OpenAlgo provider gates ITSELF on every call (consent, then a saved
  // key/host), so building one is never the same as being allowed to use one.
  if (id === "openalgo") return createOpenAlgoProvider({ refreshSeconds: clampRefreshSeconds(refreshSeconds) });
  return createEodBhavcopyProvider();
}

/**
 * PURE. The stored acknowledgement for ONE broker feed → may it run?
 *
 * `live_feed_ack_json` (migration 0069) holds provider id → accepted disclosure
 * version, and `isFeedAckCurrent()` compares with `===`: an older version, an
 * absent key or an unreadable blob is NO consent. A restored backup carries the
 * picker column but not this one (machine state), so a restore falls back to
 * `eod` instead of opening a broker feed nobody on THIS machine agreed to.
 */
export function liveFeedAckGate(
  ackJson: string | null | undefined,
  id: LiveFeedDisclosureId,
): { allowed: boolean; reason?: string } {
  if (isFeedAckCurrent(ackJson, id)) return { allowed: true };
  return {
    allowed: false,
    reason:
      "The live-price disclosure for this broker has not been accepted on this machine, or it has changed since you accepted it. Open Settings → Live feed and read it to continue.",
  };
}

/** The settings columns and the consents that decide the feed. */
export interface LiveFeedSelection {
  liveFeedProvider: string | null | undefined;
  openalgoEnabled: boolean;
  openalgoAckVersion: string | null | undefined;
  /**
   * `settings.live_feed_ack_json` — provider id → accepted disclosure version
   * (v4.2, migration 0069). OPTIONAL so a caller written before this column
   * existed keeps compiling; absent means no broker feed is acknowledged, which
   * is the safe reading of a missing consent.
   */
  liveFeedAckJson?: string | null;
}

/**
 * The name a WITHHELD feed is called by on screen — short, and a broker's, not
 * a constant's. `PLANNED_LABELS` cannot serve here: it already carries its own
 * "(not enabled in this release)" tail, which would read twice in a sentence
 * that says the same thing.
 */
const WITHHELD_FEED_LABELS: Partial<Record<ProviderId, string>> = {
  upstox: "Upstox",
  angelone: "Angel One",
  kite: "Zerodha Kite Connect",
  dhan: "Dhan",
  openalgo: "OpenAlgo",
};

/**
 * PURE. Is this id one THIS BUILD does not offer — and if so, what does the
 * user get told? `null` means the build ships it.
 *
 * THE RELEASE SWITCH OUTRANKS THE STORED CONSENT (v4.2 fix wave 2). The
 * acknowledgement in `live_feed_ack_json` is written when the sheet is
 * accepted and is NOT touched by a release switch, so an install that accepted
 * Angel One's sheet on a build that offered it kept a current ack after moving
 * to a build that withholds it. `selectProviderId()` checked only that ack, so
 * the withheld feed came back EFFECTIVE — with `stored === effective` there was
 * no block for the card to state, and the card has no radio for a withheld id,
 * so the state was stated nowhere while the desk built the PLANNED stub whose
 * `health()` names `ANGELONE_FEED_ENABLED` to a paying customer. That breaks
 * the promise written at `lib/quotes/types.ts` ("a stored
 * `live_feed_provider = 'upstox'` collapses to the end-of-day default again")
 * and the one in `SHIPPED_PROVIDER_IDS` above ("flipping the constant back
 * removes it everywhere at once").
 *
 * THE SENTENCE NAMES NO CONSTANT. It is shown to a customer, so it says what
 * is running and why, not which identifier in the source is false.
 */
export function withheldFeedReason(id: ProviderId): string | null {
  if ((SHIPPED_PROVIDER_IDS as readonly string[]).includes(id)) return null;
  const label = WITHHELD_FEED_LABELS[id] ?? id;
  return `This build does not offer the ${label} feed; the desk stays on end-of-day prices.`;
}

/**
 * PURE. The stored picker value → the provider that may actually run.
 *
 * The ONLY way to reach `openalgo` is all FOUR of: the release ships it
 * (`OPENALGO_FEED_ENABLED`, true since v4.1 — without it `resolveProviderId()`
 * already collapses the stored value to the default), the column says so,
 * the integration is on, and the acknowledgement is current. Anything else
 * falls back to the default — silently, because a picker value is a preference
 * and a missing consent is not an error the user made.
 */
export function selectProviderId(sel: LiveFeedSelection): ProviderId {
  const id = resolveProviderId(sel.liveFeedProvider);
  // THE RELEASE SWITCH IS CHECKED FIRST, BEFORE ANY CONSENT. `upstox` and
  // `angelone` are in `PLANNABLE_IDS`, so with their constant off they survive
  // `resolveProviderId()` as PLANNED ids instead of being collapsed the way an
  // unknown string is — and a planned id must never be the effective feed. A
  // stored acknowledgement cannot outrank this: consent is permission to run a
  // feed this build offers, never permission to run one it does not.
  if (withheldFeedReason(id) !== null) return DEFAULT_PROVIDER_ID;
  if (id === "openalgo") {
    const gate = openAlgoGate({ enabled: sel.openalgoEnabled, ackVersion: sel.openalgoAckVersion });
    return gate.allowed ? "openalgo" : DEFAULT_PROVIDER_ID;
  }
  // The broker feeds are gated the same way, on the per-provider version in
  // `live_feed_ack_json`. Reaching here means the build OFFERS the feed, so
  // the acknowledgement is the only remaining question.
  if (id === "upstox" || id === "angelone") {
    return liveFeedAckGate(sel.liveFeedAckJson, id).allowed ? id : DEFAULT_PROVIDER_ID;
  }
  return id;
}

/** The stored feed settings, as `resolveLiveFeed()` returns them. */
export interface LiveFeedState {
  /** What the user picked, verbatim — the Settings card renders this. */
  stored: ProviderId;
  /** What will actually run once consent is applied. */
  effective: ProviderId;
  refreshSeconds: number;
  /** Set when `stored` and `effective` differ, in the user's words. */
  blockedReason?: string;
}

/**
 * Read the feed settings. ASYNC because `@/lib/db` is imported lazily — see
 * the module header; a static import here breaks every temp-database test.
 */
export async function resolveLiveFeed(): Promise<LiveFeedState> {
  const { db } = await import("@/lib/db");
  const { settings } = await import("@/lib/db/schema");
  const row = db
    .select({
      liveFeedProvider: settings.liveFeedProvider,
      liveFeedRefreshSeconds: settings.liveFeedRefreshSeconds,
      openalgoEnabled: settings.openalgoEnabled,
      openalgoAckVersion: settings.openalgoAckVersion,
      liveFeedAckJson: settings.liveFeedAckJson,
    })
    .from(settings)
    .limit(1)
    .all()[0];
  const sel: LiveFeedSelection = {
    liveFeedProvider: row?.liveFeedProvider ?? DEFAULT_PROVIDER_ID,
    openalgoEnabled: row?.openalgoEnabled ?? false,
    openalgoAckVersion: row?.openalgoAckVersion ?? null,
    liveFeedAckJson: row?.liveFeedAckJson ?? null,
  };
  const stored = resolveProviderId(sel.liveFeedProvider);
  const effective = selectProviderId(sel);
  // Whichever feed was picked, the reason shown is that feed's own gate — and
  // a feed this build does not OFFER is answered by the release switch, not by
  // its consent gate, which would otherwise report "allowed" and leave the
  // block with no words at all (v4.2 fix wave 2).
  const reason =
    withheldFeedReason(stored) ??
    (stored === "upstox" || stored === "angelone"
      ? liveFeedAckGate(sel.liveFeedAckJson, stored)
      : openAlgoGate({ enabled: sel.openalgoEnabled, ackVersion: sel.openalgoAckVersion })
    ).reason;
  return {
    stored,
    effective,
    refreshSeconds: clampRefreshSeconds(row?.liveFeedRefreshSeconds ?? undefined),
    ...(stored !== effective ? { blockedReason: reason } : {}),
  };
}

/* ───────────────── one live-feed instance per process (A-2) ─────────────── */

/**
 * ONE INSTANCE PER PROCESS — because the session, the rate guard and the hourly
 * budget live INSIDE the instance (v4.2 fix A-2).
 *
 * `createProvider()` is a factory, and the broker adapters keep their whole
 * session in closure variables: Angel One's jwt and its "one login, then 60 s
 * of silence" retry stamp, both brokers' 1-req/s guard, Angel One's rolling
 * 4,000-an-hour budget, and the `lastError` `health()` reports. A fresh
 * instance per CALLER therefore meant a fresh session per caller — and there
 * are four callers on one /live visit (the SSR desk load, every EventSource
 * open, the Settings health line, the "Save today's mark" button). That is two
 * Angel One logins for one visit, a wrong PIN re-sent on every stream open, a
 * per-instance ceiling that is not the ceiling the consent sheet promises, and
 * a health line built from an instance that has never made a request saying
 * "connected". The consent sheet says "signs in once each trading day", and
 * this cache is what makes that sentence true.
 *
 * IT IS A CACHE, AND A CACHE MUST EXPIRE. The key carries everything that would
 * make the stored session the WRONG session: the provider id, the account the
 * connection is read through (invariant 8), the acknowledgement column, the
 * OpenAlgo consent pair, the refresh slider, and a fingerprint of the broker
 * connection rows themselves (id, `updated_at` and a digest of the stored
 * ciphertext). So a regenerated token, a re-saved PIN, a new consent, a changed
 * slider or a switched account all build a NEW instance and drop the old one —
 * a single slot, never a map, because the desk runs one feed at a time and a
 * map of live sessions is a leak.
 *
 * WHICH PROVIDERS. Only the three that hold per-instance state worth sharing.
 * `eod`, `manual` and `mock` keep no session, no guard and no credential, so
 * memoising them would buy nothing and hide the mock's per-instance walk.
 * OpenAlgo's only per-instance state IS its rate guard — sharing it is what
 * makes its published ceiling true process-wide — and it re-reads its gate on
 * every call, so there is nothing in it that must not be shared.
 */
let cachedLiveFeedProvider: { key: string; provider: QuoteProvider } | null = null;

/** The ids whose instance is shared. Everything else is built per call. */
const MEMOISED_PROVIDER_IDS: readonly ProviderId[] = ["angelone", "upstox", "openalgo"];

/** Which `broker_connections` rows each feed reads — the same rule its gate uses. */
const FEED_CONNECTION_MATCH: Partial<Record<ProviderId, (broker: string) => boolean>> = {
  angelone: (b) => b === "angelone",
  upstox: (b) => b === "upstox",
  // `like('openalgo%')` in the adapter's own gate reader.
  openalgo: (b) => b.startsWith("openalgo"),
};

/**
 * A short digest of the stored credential columns — NEVER the credential.
 *
 * FNV-1a, 32 bits, because this is a change detector and not a security
 * boundary: `updated_at` alone would miss two saves inside one millisecond, and
 * putting the ciphertext itself in a process-lived cache key would keep a
 * second copy of a secret alive for no reason.
 */
function credentialDigest(...parts: (string | null | undefined)[]): string {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part ?? "");
    for (let i = 0; i < s.length; i += 1) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
    h = Math.imul(h ^ 0x1f, 0x01000193) >>> 0; // a separator, so a|b ≠ ab
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Everything that decides WHICH instance this is. `@/lib/db` is imported
 * lazily, like everything else in this module.
 */
async function liveFeedInstanceKey(id: ProviderId, refreshSeconds: number): Promise<string> {
  const { db } = await import("@/lib/db");
  const { settings, brokerConnections } = await import("@/lib/db/schema");
  const { getSelectedAccountId } = await import("@/lib/queries/accounts");
  const row = db
    .select({
      ack: settings.liveFeedAckJson,
      openalgoEnabled: settings.openalgoEnabled,
      openalgoAckVersion: settings.openalgoAckVersion,
    })
    .from(settings)
    .limit(1)
    .all()[0];

  // ACCOUNT SCOPE (invariant 8): the connection every adapter reads is the one
  // for the SELECTED account, so switching account must not reuse the session
  // minted from another book's credential. Id 0 is the aggregate view, where
  // the adapters take the most recently updated row — so every candidate row
  // goes into the key and any change to any of them rebuilds the instance.
  const accountId = getSelectedAccountId();
  const matches = FEED_CONNECTION_MATCH[id];
  let credentials = "none";
  if (matches) {
    const rows = db
      .select({
        id: brokerConnections.id,
        accountId: brokerConnections.accountId,
        broker: brokerConnections.broker,
        apiKey: brokerConnections.apiKey,
        authJson: brokerConnections.authJson,
        updatedAt: brokerConnections.updatedAt,
      })
      .from(brokerConnections)
      .all()
      .filter((r) => matches(String(r.broker ?? "")) && (accountId > 0 ? r.accountId === accountId : true));
    credentials =
      rows
        .map((r) => `${r.id}@${r.updatedAt}#${credentialDigest(r.apiKey, r.authJson)}`)
        .sort()
        .join(",") || "none";
  }

  return [
    id,
    refreshSeconds,
    accountId,
    // Two temp databases in one process are two different books; keying on the
    // file keeps a test's instance out of the next test's database.
    process.env.VYUHA_DB_PATH ?? "",
    row?.ack ?? "",
    row?.openalgoEnabled ? 1 : 0,
    row?.openalgoAckVersion ?? "",
    credentials,
  ].join("|");
}

/**
 * Drop the shared instance. For tests and for any caller that has just
 * invalidated something the key cannot see; a settings or connection write
 * needs no reset, because the key already carries both.
 */
export function resetLiveFeedProviderCache(): void {
  cachedLiveFeedProvider = null;
}

/**
 * The provider the stored settings actually allow, built and ready.
 *
 * `feed.effective` can never be a WITHHELD id — `selectProviderId()` collapses
 * one to `eod` before any consent is consulted — so no memo key is ever built
 * for a planned provider and the desk cannot end up holding the planned stub.
 * `VYUHA_QUOTE_PROVIDER` is the deliberate exception: it is the dev/e2e
 * override, set by the operator on this machine, never by stored user state.
 */
export async function getLiveFeedProvider(): Promise<QuoteProvider> {
  const feed = await resolveLiveFeed();
  const env = process.env.VYUHA_QUOTE_PROVIDER;
  const id = env && env.trim() ? resolveProviderId(env) : feed.effective;
  if (!MEMOISED_PROVIDER_IDS.includes(id)) return createProvider(id, feed.refreshSeconds);

  const key = await liveFeedInstanceKey(id, feed.refreshSeconds);
  if (cachedLiveFeedProvider && cachedLiveFeedProvider.key === key) return cachedLiveFeedProvider.provider;
  const provider = createProvider(id, feed.refreshSeconds);
  cachedLiveFeedProvider = { key, provider };
  return provider;
}

/**
 * The provider this request runs. `stored` is the settings value once a column
 * exists; `VYUHA_QUOTE_PROVIDER` wins over it so e2e and vitest can pin the
 * mock without touching the user's database.
 */
export function getQuoteProvider(stored?: string | null): QuoteProvider {
  const env = process.env.VYUHA_QUOTE_PROVIDER;
  return createProvider(resolveProviderId(env && env.trim() ? env : stored));
}

/**
 * Every capability block in the registry — what the egress guard iterates.
 *
 * OpenAlgo's block is listed UNCONDITIONALLY, as it already was in v4.0 where
 * the provider was built but not selectable: the adapter exists, so its
 * declared egress must keep being held to the privacy sheet whichever way
 * `OPENALGO_FEED_ENABLED` points. A capability block that disappeared with the
 * feature flag would be a guard that stops guarding exactly when the code is
 * easiest to change.
 */
export function allProviderCapabilities(): ProviderCapabilities[] {
  return [
    EOD_CAPABILITIES,
    MANUAL_CAPABILITIES,
    MOCK_CAPABILITIES,
    OPENALGO_CAPABILITIES,
    // Listed UNCONDITIONALLY, for the same reason OpenAlgo's is: the adapter
    // exists, so its declared egress must keep being held to the privacy sheet
    // whichever way `UPSTOX_FEED_ENABLED` points. A capability block that
    // disappeared with the feature flag would be a guard that stops guarding
    // exactly when the code is easiest to change. (`upstox` leaves
    // PLANNED_PROVIDER_IDS when the flag is on, so there is still exactly one
    // block per id either way — the filter below keeps that true if the flag is
    // ever turned off, when `upstox` rejoins the planned list.)
    UPSTOX_CAPABILITIES,
    // Angel One's block is listed unconditionally for the same reason, and it
    // is the one that matters most: its declared host is the only claim the
    // egress guard can hold `lib/quotes/angelone.ts` to.
    ANGELONE_CAPABILITIES,
    ...PLANNED_PROVIDER_IDS.filter((id) => id !== "upstox" && id !== "angelone").map(plannedCapabilities),
  ];
}
