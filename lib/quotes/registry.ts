import "server-only";
import { createEodBhavcopyProvider, EOD_CAPABILITIES } from "./eod-bhavcopy";
import { createManualProvider, MANUAL_CAPABILITIES } from "./manual";
import { createMockProvider, MOCK_CAPABILITIES } from "./mock";
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
 * SELECTION SOURCE: v4.0 has no settings column for the provider — `settings`
 * is a fixed-column single row and `lib/db/schema.ts` belongs to W0, whose
 * migration `0064` extends `risk_config` only. So the stored value is an
 * ARGUMENT here (`getQuoteProvider(stored)`), with `VYUHA_QUOTE_PROVIDER` as
 * the dev/e2e override, and the default is `eod`. When a settings column
 * lands, one call site changes and nothing else.
 *
 * SERVER-ONLY: two of the three shipped providers read the journal database.
 * Client components import `@/lib/quotes/types` (pure), never this file.
 */

export const DEFAULT_PROVIDER_ID: ProviderId = "eod";

/** Built and selectable in v4.0. */
export const SHIPPED_PROVIDER_IDS = ["eod", "manual", "mock"] as const;

/** Typed, listed, and deliberately not built — see `createPlannedProvider()`. */
export const PLANNED_PROVIDER_IDS = ["openalgo", "kite", "upstox", "dhan", "angelone"] as const;

const PLANNED_NOTES: Record<(typeof PLANNED_PROVIDER_IDS)[number], string> = {
  openalgo: "v4.1 ships it against the bridge you already run on 127.0.0.1, behind the existing OpenAlgo disclosure.",
  kite: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
  upstox: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
  dhan: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
  angelone: "v4.2+ — a broker feed needs its own consent sheet, its own privacy line and the broker's own data-fee disclosure.",
};

const PLANNED_LABELS: Record<(typeof PLANNED_PROVIDER_IDS)[number], string> = {
  openalgo: "OpenAlgo bridge (not enabled in v4.0)",
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

export function createProvider(id: ProviderId): QuoteProvider {
  if (isPlanned(id)) return createPlannedProvider(id);
  if (id === "mock") return createMockProvider();
  if (id === "manual") return createManualProvider();
  return createEodBhavcopyProvider();
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
    ...PLANNED_PROVIDER_IDS.map(plannedCapabilities),
  ];
}
