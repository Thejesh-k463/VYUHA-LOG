import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_ID,
  PLANNED_PROVIDER_IDS,
  SHIPPED_PROVIDER_IDS,
  allProviderCapabilities,
  createPlannedProvider,
  createProvider,
  getQuoteProvider,
  liveFeedAckGate,
  resolveProviderId,
  selectProviderId,
} from "@/lib/quotes/registry";
import {
  ANGELONE_FEED_ENABLED,
  NotEnabledError,
  OPENALGO_FEED_ENABLED,
  UPSTOX_FEED_ENABLED,
} from "@/lib/quotes/types";
import { OPENALGO_DISCLOSURE_VERSION } from "@/lib/domain/openalgo-disclosure";
import { LIVE_FEED_DISCLOSURE_VERSIONS, withFeedAck } from "@/lib/domain/live-feed-disclosure";

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

    // `openalgo` was the example here until v4.1 built it, and `upstox` until
    // v4.2 did (it is a SHIPPED id now — see the v4.2 block below). Kite is the
    // remaining planned broker feed, and its note names the version that would
    // ship it, not the one that shipped OpenAlgo.
    const dhan = createPlannedProvider("dhan");
    await expect(dhan.snapshot([])).rejects.toThrow(/v4\.2/);
    try {
      await dhan.snapshot([]);
      expect.unreachable("a disabled provider must refuse");
    } catch (e) {
      expect((e as NotEnabledError).code).toBe("PROVIDER_NOT_ENABLED");
      expect((e as NotEnabledError).providerId).toBe("dhan");
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

describe("v4.2 — BOTH broker feeds ship, each behind its own consent", () => {
  const ACK = withFeedAck(null, "upstox"); // '{"upstox":"1"}'
  const ANGEL_ACK = withFeedAck(null, "angelone"); // '{"angelone":"1"}'

  it("moves `upstox` out of the planned list and into the shipped one", () => {
    expect(UPSTOX_FEED_ENABLED).toBe(true);
    expect(SHIPPED_PROVIDER_IDS as readonly string[]).toContain("upstox");
    expect(PLANNED_PROVIDER_IDS as readonly string[]).not.toContain("upstox");
    expect(resolveProviderId("upstox")).toBe("upstox");
    expect(createProvider("upstox").id).toBe("upstox");
    expect(createProvider("upstox", 3).capabilities.staleness).toBe("delayed");
  });

  it("gates it on the STORED ACKNOWLEDGEMENT, exactly as OpenAlgo is gated", () => {
    const base = { liveFeedProvider: "upstox", openalgoEnabled: false, openalgoAckVersion: null };
    expect(LIVE_FEED_DISCLOSURE_VERSIONS.upstox).toBe("1");
    expect(selectProviderId({ ...base, liveFeedAckJson: ACK }), "a current acknowledgement").toBe("upstox");
    expect(selectProviderId({ ...base, liveFeedAckJson: null }), "never acknowledged").toBe("eod");
    expect(selectProviderId({ ...base, liveFeedAckJson: undefined }), "column absent").toBe("eod");
    expect(selectProviderId({ ...base, liveFeedAckJson: '{"upstox":"0"}' }), "an older disclosure").toBe("eod");
    expect(selectProviderId({ ...base, liveFeedAckJson: '{"angelone":"1"}' }), "another broker's consent").toBe("eod");
    expect(selectProviderId({ ...base, liveFeedAckJson: "not json" }), "an unreadable column").toBe("eod");
    // A restored backup carries the picker column but not the consent column
    // (machine state), which is exactly the middle case above.
    expect(liveFeedAckGate(null, "upstox").allowed).toBe(false);
    expect(liveFeedAckGate(ACK, "upstox").allowed).toBe(true);
    expect(liveFeedAckGate(null, "upstox").reason).toMatch(/Settings → Live feed/);
  });

  it("does NOT let an OpenAlgo consent open the Upstox feed, or the reverse", () => {
    expect(
      selectProviderId({
        liveFeedProvider: "upstox",
        openalgoEnabled: true,
        openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION,
        liveFeedAckJson: null,
      }),
    ).toBe("eod");
    expect(
      selectProviderId({
        liveFeedProvider: "openalgo",
        openalgoEnabled: false,
        openalgoAckVersion: null,
        liveFeedAckJson: ACK,
      }),
    ).toBe("eod");
  });

  it("SHIPS `angelone` too — ruling 4.2-9 turned the constant on", () => {
    // The line in SHIPPED_PROVIDER_IDS was written while the adapter did not
    // exist, promising that the constant would be the only edit. It was.
    expect(ANGELONE_FEED_ENABLED).toBe(true);
    expect(SHIPPED_PROVIDER_IDS as readonly string[]).toContain("angelone");
    expect(PLANNED_PROVIDER_IDS as readonly string[]).not.toContain("angelone");
    expect(resolveProviderId("angelone")).toBe("angelone");
    const angel = createProvider("angelone");
    expect(angel.id).toBe("angelone");
    // A real adapter, not the placeholder: the placeholder promises nothing
    // and names no host, and this one does both.
    expect(angel.capabilities.streaming).toBe(true);
    expect(angel.capabilities.egressDescription).toContain("apiconnect.angelone.in");
    expect(angel.capabilities.label).not.toMatch(/not enabled/i);
    expect(angel.capabilities.requiresDailyAuth, "Angel One clears every session at 5 AM IST").toBe(true);
    // The slider is IGNORED for this provider (ruling 4.2-4) — passing one
    // must not change what is built.
    expect(createProvider("angelone", 1).capabilities.minSnapshotIntervalMs).toBe(3000);
  });

  it("gates Angel One on ITS OWN key in the same column — one broker's consent is not the other's", () => {
    const base = { liveFeedProvider: "angelone", openalgoEnabled: false, openalgoAckVersion: null };
    expect(LIVE_FEED_DISCLOSURE_VERSIONS.angelone).toBe("1");
    expect(selectProviderId({ ...base, liveFeedAckJson: ANGEL_ACK }), "a current acknowledgement").toBe("angelone");
    expect(selectProviderId({ ...base, liveFeedAckJson: null }), "never acknowledged").toBe("eod");
    expect(selectProviderId({ ...base, liveFeedAckJson: ACK }), "the UPSTOX consent must not open it").toBe("eod");
    expect(selectProviderId({ ...base, liveFeedAckJson: '{"angelone":"0"}' }), "an older disclosure").toBe("eod");
    expect(selectProviderId({ ...base, liveFeedAckJson: "not json" }), "an unreadable column").toBe("eod");
    // …and the reverse: Angel One's consent does not open Upstox's feed.
    expect(
      selectProviderId({ liveFeedProvider: "upstox", openalgoEnabled: false, openalgoAckVersion: null, liveFeedAckJson: ANGEL_ACK }),
    ).toBe("eod");
    expect(liveFeedAckGate(ANGEL_ACK, "angelone").allowed).toBe(true);
    expect(liveFeedAckGate(null, "angelone").allowed).toBe(false);
    // Accepting both is one column and two keys — no second migration.
    const both = withFeedAck(ANGEL_ACK, "upstox");
    expect(selectProviderId({ ...base, liveFeedAckJson: both })).toBe("angelone");
    expect(
      selectProviderId({ liveFeedProvider: "upstox", openalgoEnabled: false, openalgoAckVersion: null, liveFeedAckJson: both }),
    ).toBe("upstox");
  });

  it("still has a planned provider that refuses, so the placeholder path is not dead code", async () => {
    const kite = createProvider("kite");
    expect(kite.capabilities.streaming).toBe(false);
    expect(kite.capabilities.egressDescription).toMatch(/^none\b/i);
    await expect(kite.snapshot([])).rejects.toBeInstanceOf(NotEnabledError);
  });

  it("carries both broker capability blocks whichever way the release switches point", () => {
    for (const [id, host] of [
      ["upstox", "api.upstox.com"],
      ["angelone", "apiconnect.angelone.in"],
    ] as const) {
      const block = allProviderCapabilities().filter((c) => c.id === id);
      expect(block, `exactly one block for ${id} — no planned duplicate`).toHaveLength(1);
      expect(block[0].egressDescription).toContain(host);
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
