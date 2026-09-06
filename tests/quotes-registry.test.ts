import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_ID,
  PLANNED_PROVIDER_IDS,
  SHIPPED_PROVIDER_IDS,
  allProviderCapabilities,
  createPlannedProvider,
  createProvider,
  getQuoteProvider,
  resolveProviderId,
  selectProviderId,
} from "@/lib/quotes/registry";
import { NotEnabledError, OPENALGO_FEED_ENABLED } from "@/lib/quotes/types";
import { OPENALGO_DISCLOSURE_VERSION } from "@/lib/domain/openalgo-disclosure";

/**
 * The registry: which provider runs, and what happens to the ones v4.0
 * deliberately did not build. Nothing here touches the database — creating a
 * provider must stay free, or every page that asks "which provider?" pays for
 * a connection it never uses.
 */

afterEach(() => {
  delete process.env.VYUHA_QUOTE_PROVIDER;
});

describe("selection", () => {
  it("defaults to the end-of-day provider — v4.0 is EOD-only", () => {
    expect(DEFAULT_PROVIDER_ID).toBe("eod");
    expect(getQuoteProvider().id).toBe("eod");
    expect(getQuoteProvider(null).id).toBe("eod");
    expect(getQuoteProvider("").id).toBe("eod");
  });

  it("resolves a stored value, case-insensitively, and falls back on nonsense", () => {
    expect(resolveProviderId("mock")).toBe("mock");
    expect(resolveProviderId("  MANUAL ")).toBe("manual");
    expect(resolveProviderId("kite")).toBe("kite");
    expect(resolveProviderId("chartink")).toBe("eod");
    expect(resolveProviderId(undefined)).toBe("eod");
  });

  it("resolves a stored 'openalgo' to itself now the release ships it — and CONSENT still decides", () => {
    // v4.1 flipped the release switch, so "openalgo" is a known selectable id
    // and no longer collapses to the default like an unknown string. What did
    // NOT change is the gate: `selectProviderId` re-reads the consent pair on
    // every selection, so a restored backup (picker column present, consent
    // columns empty — they are machine state) still runs end-of-day.
    expect(OPENALGO_FEED_ENABLED).toBe(true);
    expect(resolveProviderId("openalgo")).toBe("openalgo");
    const ACK = OPENALGO_DISCLOSURE_VERSION;
    expect(
      selectProviderId({ liveFeedProvider: "openalgo", openalgoEnabled: true, openalgoAckVersion: ACK }),
      "a current acknowledgement is the only thing that opens the feed",
    ).toBe("openalgo");
    expect(
      selectProviderId({ liveFeedProvider: "openalgo", openalgoEnabled: false, openalgoAckVersion: ACK }),
      "integration off",
    ).toBe("eod");
    expect(
      selectProviderId({ liveFeedProvider: "openalgo", openalgoEnabled: true, openalgoAckVersion: null }),
      "never acknowledged",
    ).toBe("eod");
    expect(
      selectProviderId({ liveFeedProvider: "openalgo", openalgoEnabled: true, openalgoAckVersion: "0" }),
      "acknowledged an older disclosure",
    ).toBe("eod");
  });

  it("keeps the adapter and its consent gate intact — nothing was ever deleted to withhold it", () => {
    // v4.0 withheld only the SELECTABILITY: the provider still built, and its
    // capability block was still policed by the egress guard. v4.1 needed one
    // constant flipped and none of this written again — which is why both
    // assertions still read the same as they did then.
    expect(createProvider("openalgo").id).toBe("openalgo");
    expect(allProviderCapabilities().some((c) => c.id === "openalgo")).toBe(true);
  });

  it("lets the environment pin the mock, over any stored value — that is how e2e runs offline", () => {
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    expect(getQuoteProvider("eod").id).toBe("mock");
  });

  it("builds each shipped provider under its own id", () => {
    for (const id of SHIPPED_PROVIDER_IDS) expect(createProvider(id).id).toBe(id);
  });
});

describe("the providers v4.0 did NOT build", () => {
  it("keeps them typed and listed, but never selectable by accident", () => {
    for (const id of PLANNED_PROVIDER_IDS) {
      expect(SHIPPED_PROVIDER_IDS as readonly string[]).not.toContain(id);
    }
  });

  it("throws NotEnabledError with the version note from snapshot and subscribe", async () => {
    const kite = createProvider("kite");
    await expect(kite.snapshot([])).rejects.toBeInstanceOf(NotEnabledError);
    await expect(kite.snapshot([])).rejects.toThrow(/not enabled in this release/i);
    expect(() => kite.subscribe([], () => {})).toThrow(NotEnabledError);

    // `openalgo` was the example here until v4.1 built it; a broker feed is
    // the remaining planned shape, and its note names the version that would
    // ship it (v4.2+), not the one that shipped OpenAlgo.
    const upstox = createPlannedProvider("upstox");
    await expect(upstox.snapshot([])).rejects.toThrow(/v4\.2/);
    try {
      await upstox.snapshot([]);
      expect.unreachable("a disabled provider must refuse");
    } catch (e) {
      expect((e as NotEnabledError).code).toBe("PROVIDER_NOT_ENABLED");
      expect((e as NotEnabledError).providerId).toBe("upstox");
    }
  });

  it("still answers health() instead of throwing — the pill needs a reason, not a crash", async () => {
    for (const id of PLANNED_PROVIDER_IDS) {
      const h = await createPlannedProvider(id).health();
      expect(h.ok).toBe(false);
      expect(h.reason).toMatch(/not enabled in this release/i);
    }
  });

  it("promises no capability it cannot keep", () => {
    for (const id of PLANNED_PROVIDER_IDS) {
      const c = createPlannedProvider(id).capabilities;
      expect(c.streaming).toBe(false);
      expect(c.maxSubscriptions).toBe(0);
      expect(c.segments).toEqual([]);
      expect(c.label).toMatch(/not enabled in this release/i);
    }
  });
});

describe("the capability catalogue", () => {
  it("carries exactly one block per known provider id", () => {
    const ids = allProviderCapabilities().map((c) => c.id).sort();
    // Every shipped id and every planned id. `openalgo` is a shipped id since
    // v4.1; the `push` below is what covered it while it was built-but-withheld,
    // and it stays because the catalogue must list the block either way — the
    // egress guard reads this catalogue, and a declared host must keep being
    // held to the privacy sheet whether or not the feature is switched on.
    const expected = [...SHIPPED_PROVIDER_IDS, ...PLANNED_PROVIDER_IDS];
    if (!OPENALGO_FEED_ENABLED) expected.push("openalgo");
    expect(ids).toEqual(expected.sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
