import "server-only";
import { openAlgoGate } from "@/lib/domain/openalgo-disclosure";
import { createEodBhavcopyProvider, EOD_CAPABILITIES } from "./eod-bhavcopy";
import { createManualProvider, MANUAL_CAPABILITIES } from "./manual";
import { createMockProvider, MOCK_CAPABILITIES } from "./mock";
import { clampRefreshSeconds, createOpenAlgoProvider, OPENALGO_CAPABILITIES } from "./openalgo";
import {
  NotEnabledError,
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
 * SERVER-ONLY: three of the four shipped providers read the journal database
 * or the network. Client components import `@/lib/quotes/types` (pure), never
 * this file.
 */

export const DEFAULT_PROVIDER_ID: ProviderId = "eod";

/** Built and selectable. `openalgo` joined in v4.1 (owner answers Q20/Q21). */
export const SHIPPED_PROVIDER_IDS = ["eod", "manual", "mock", "openalgo"] as const;

/** Typed, listed, and deliberately not built — see `createPlannedProvider()`. */
export const PLANNED_PROVIDER_IDS = ["kite", "upstox", "dhan", "angelone"] as const;

const PLANNED_NOTES: Record<(typeof PLANNED_PROVIDER_IDS)[number], string> = {
  kite: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
  upstox: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
  dhan: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
  angelone: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
};

const PLANNED_LABELS: Record<(typeof PLANNED_PROVIDER_IDS)[number], string> = {
  kite: "Zerodha Kite Connect (not enabled in v4.0)",
  upstox: "Upstox (not enabled in v4.0)",
  dhan: "Dhan (not enabled in v4.0)",
  angelone: "Angel One SmartAPI (not enabled in v4.0)",
};

/**
 * Capabilities of a provider that is switched off.
 *
 * `egressDescription` names NO host on purpose: a provider that cannot run
 * makes no request, and writing its future host here would put a claim in the
 * privacy surface that v4.0 does not honour. The host arrives in the same
 * release as the consent sheet and the PRIVACY line — not before.
 */
export function plannedCapabilities(id: (typeof PLANNED_PROVIDER_IDS)[number]): ProviderCapabilities {
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
    egressDescription: "None. This provider is disabled in v4.0 and makes no request.",
  };
}

/** A typed provider that refuses, loudly, everywhere except `health()`. */
export function createPlannedProvider(id: (typeof PLANNED_PROVIDER_IDS)[number]): QuoteProvider {
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
      return { ok: false, reason: `Not enabled in v4.0 — ${note}` };
    },
  };
}

const ALL_IDS: readonly ProviderId[] = [...SHIPPED_PROVIDER_IDS, ...PLANNED_PROVIDER_IDS];

function isPlanned(id: ProviderId): id is (typeof PLANNED_PROVIDER_IDS)[number] {
  return (PLANNED_PROVIDER_IDS as readonly string[]).includes(id);
}

/** PURE. An unknown or empty stored value resolves to the default, never to a throw. */
export function resolveProviderId(raw: string | null | undefined): ProviderId {
  const v = (raw ?? "").trim().toLowerCase();
  return (ALL_IDS as readonly string[]).includes(v) ? (v as ProviderId) : DEFAULT_PROVIDER_ID;
}

export function createProvider(id: ProviderId, refreshSeconds?: number): QuoteProvider {
  if (isPlanned(id)) return createPlannedProvider(id);
  if (id === "mock") return createMockProvider();
  if (id === "manual") return createManualProvider();
  // The OpenAlgo provider gates ITSELF on every call (consent, then a saved
  // key/host), so building one is never the same as being allowed to use one.
  if (id === "openalgo") return createOpenAlgoProvider({ refreshSeconds: clampRefreshSeconds(refreshSeconds) });
  return createEodBhavcopyProvider();
}

/** The two settings columns and the consent pair that decide the feed. */
export interface LiveFeedSelection {
  liveFeedProvider: string | null | undefined;
  openalgoEnabled: boolean;
  openalgoAckVersion: string | null | undefined;
}

/**
 * PURE. The stored picker value → the provider that may actually run.
 *
 * The ONLY way to reach `openalgo` is all three of: the column says so, the
 * integration is on, and the acknowledgement is current. Anything else falls
 * back to the default — silently, because a picker value is a preference and a
 * missing consent is not an error the user made.
 */
export function selectProviderId(sel: LiveFeedSelection): ProviderId {
  const id = resolveProviderId(sel.liveFeedProvider);
  if (id !== "openalgo") return id;
  const gate = openAlgoGate({ enabled: sel.openalgoEnabled, ackVersion: sel.openalgoAckVersion });
  return gate.allowed ? "openalgo" : DEFAULT_PROVIDER_ID;
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
    })
    .from(settings)
    .limit(1)
    .all()[0];
  const sel: LiveFeedSelection = {
    liveFeedProvider: row?.liveFeedProvider ?? DEFAULT_PROVIDER_ID,
    openalgoEnabled: row?.openalgoEnabled ?? false,
    openalgoAckVersion: row?.openalgoAckVersion ?? null,
  };
  const stored = resolveProviderId(sel.liveFeedProvider);
  const effective = selectProviderId(sel);
  const gate = openAlgoGate({ enabled: sel.openalgoEnabled, ackVersion: sel.openalgoAckVersion });
  return {
    stored,
    effective,
    refreshSeconds: clampRefreshSeconds(row?.liveFeedRefreshSeconds ?? undefined),
    ...(stored !== effective ? { blockedReason: gate.reason } : {}),
  };
}

/** The provider the stored settings actually allow, built and ready. */
export async function getLiveFeedProvider(): Promise<QuoteProvider> {
  const feed = await resolveLiveFeed();
  const env = process.env.VYUHA_QUOTE_PROVIDER;
  if (env && env.trim()) return createProvider(resolveProviderId(env), feed.refreshSeconds);
  return createProvider(feed.effective, feed.refreshSeconds);
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

/** Every capability block in the registry — what the egress guard iterates. */
export function allProviderCapabilities(): ProviderCapabilities[] {
  return [
    EOD_CAPABILITIES,
    MANUAL_CAPABILITIES,
    MOCK_CAPABILITIES,
    OPENALGO_CAPABILITIES,
    ...PLANNED_PROVIDER_IDS.map(plannedCapabilities),
  ];
}
