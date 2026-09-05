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
} from "@/lib/quotes/registry";
import { NotEnabledError } from "@/lib/quotes/types";

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
    await expect(kite.snapshot([])).rejects.toThrow(/not enabled in v4\.0/i);
    expect(() => kite.subscribe([], () => {})).toThrow(NotEnabledError);

    const openalgo = createPlannedProvider("openalgo");
    await expect(openalgo.snapshot([])).rejects.toThrow(/v4\.1/);
    try {
      await openalgo.snapshot([]);
      expect.unreachable("a disabled provider must refuse");
    } catch (e) {
      expect((e as NotEnabledError).code).toBe("PROVIDER_NOT_ENABLED");
      expect((e as NotEnabledError).providerId).toBe("openalgo");
    }
  });

  it("still answers health() instead of throwing — the pill needs a reason, not a crash", async () => {
    for (const id of PLANNED_PROVIDER_IDS) {
      const h = await createPlannedProvider(id).health();
      expect(h.ok).toBe(false);
      expect(h.reason).toMatch(/not enabled in v4\.0/i);
    }
  });

  it("promises no capability it cannot keep", () => {
    for (const id of PLANNED_PROVIDER_IDS) {
      const c = createPlannedProvider(id).capabilities;
      expect(c.streaming).toBe(false);
      expect(c.maxSubscriptions).toBe(0);
      expect(c.segments).toEqual([]);
      expect(c.label).toMatch(/not enabled/i);
    }
  });
});

describe("the capability catalogue", () => {
  it("carries exactly one block per known provider id", () => {
    const ids = allProviderCapabilities().map((c) => c.id).sort();
    expect(ids).toEqual([...SHIPPED_PROVIDER_IDS, ...PLANNED_PROVIDER_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
