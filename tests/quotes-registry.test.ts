import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_ID,
  PLANNED_PROVIDER_IDS,
  SHIPPED_PROVIDER_IDS,
  allProviderCapabilities,
  createPlannedProvider,
  createProvider,
  getLiveFeedProvider,
  getQuoteProvider,
  liveFeedAckGate,
  liveFeedInstanceKey,
  resetLiveFeedProviderCache,
  resolveProviderId,
  selectProviderId,
  withheldFeedReason,
} from "@/lib/quotes/registry";
import {
  ANGELONE_FEED_ENABLED,
  NotEnabledError,
  OPENALGO_FEED_ENABLED,
  UPSTOX_FEED_ENABLED,
} from "@/lib/quotes/types";
import { OPENALGO_DISCLOSURE_VERSION } from "@/lib/domain/openalgo-disclosure";
import { LIVE_FEED_DISCLOSURE_VERSIONS, withFeedAck } from "@/lib/domain/live-feed-disclosure";
import { openTempDb, type TempDb } from "./helpers/temp-db";

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

/**
 * v4.2 fix wave 2 — A RELEASE SWITCH OUTRANKS A STORED CONSENT.
 *
 * `SHIPPED_PROVIDER_IDS`' own comment promises that "flipping the constant back
 * removes it everywhere at once", and `lib/quotes/types.ts` promises that a
 * stored `live_feed_provider` then "collapses to the end-of-day default again".
 * It did not. `selectProviderId()` checked only the ACKNOWLEDGEMENT for the two
 * broker feeds, and the acknowledgement column is untouched by the flag — so
 * someone who accepted the sheet on a build that offered Angel One and then
 * moved to a build that withholds it kept a withheld feed as `effective`. The
 * Settings card has no radio for it and, because `stored === effective`, no
 * block either, so the state was stated NOWHERE; the desk meanwhile built the
 * PLANNED stub, whose `health()` names `ANGELONE_FEED_ENABLED` to a customer.
 *
 * The flag is mocked because it is TRUE in this build, and the broken spelling
 * and the correct one agree while it is.
 */
describe("a feed this build WITHHOLDS is never effective, acknowledged or not", () => {
  const ANGEL_ACK = withFeedAck(null, "angelone"); // '{"angelone":"1"}'
  const UPSTOX_ACK = withFeedAck(null, "upstox");
  const base = { liveFeedProvider: "angelone", openalgoEnabled: false, openalgoAckVersion: null };

  /** The REAL registry, re-imported with the ONE release flag off. */
  async function withAngelOneWithheld(
    fn: (off: typeof import("@/lib/quotes/registry")) => Promise<void> | void,
  ): Promise<void> {
    vi.resetModules();
    vi.doMock("@/lib/quotes/types", async () => ({
      ...(await vi.importActual<typeof import("@/lib/quotes/types")>("@/lib/quotes/types")),
      ANGELONE_FEED_ENABLED: false,
    }));
    try {
      await fn(await import("@/lib/quotes/registry"));
    } finally {
      vi.doUnmock("@/lib/quotes/types");
      vi.resetModules();
    }
  }

  it("collapses a withheld pick to end-of-day even when its acknowledgement is CURRENT", async () => {
    await withAngelOneWithheld((off) => {
      expect(off.SHIPPED_PROVIDER_IDS as readonly string[]).not.toContain("angelone");
      // The id still RESOLVES — it is a planned id again, which is what keeps
      // its capability block in the catalogue and under the egress guard.
      expect(off.resolveProviderId("angelone")).toBe("angelone");
      // …and it is never SELECTED, whatever the consent column says.
      expect(
        off.selectProviderId({ ...base, liveFeedAckJson: ANGEL_ACK }),
        "a withheld feed was made effective by a stored acknowledgement",
      ).toBe("eod");
      expect(off.selectProviderId({ ...base, liveFeedAckJson: null }), "flag off, no ack").toBe("eod");
      // The sibling feed this build still ships is untouched by the switch.
      expect(
        off.selectProviderId({
          liveFeedProvider: "upstox",
          openalgoEnabled: false,
          openalgoAckVersion: null,
          liveFeedAckJson: UPSTOX_ACK,
        }),
      ).toBe("upstox");
    });
  });

  it("states WHY, in the user's words, and never names the source-file constant", async () => {
    await withAngelOneWithheld((off) => {
      const reason = off.withheldFeedReason("angelone");
      expect(reason).toBe("This build does not offer the Angel One feed; the desk stays on end-of-day prices.");
      // SEBI-safe: a customer is told what is running, not which constant is false.
      expect(reason).not.toContain("ANGELONE_FEED_ENABLED");
      expect(reason).not.toMatch(/[A-Z_]{6,}/);
      // A shipped feed is not withheld, so it has no such reason at all.
      expect(off.withheldFeedReason("upstox")).toBeNull();
      expect(off.withheldFeedReason("eod")).toBeNull();
    });
  });

  it("CONTROL — with the flag ON the same acknowledgement opens the feed", () => {
    expect(ANGELONE_FEED_ENABLED).toBe(true);
    expect(selectProviderId({ ...base, liveFeedAckJson: ANGEL_ACK })).toBe("angelone");
    expect(withheldFeedReason("angelone")).toBeNull();
    // …and a never-built id is withheld in EVERY build, which is the same rule.
    expect(withheldFeedReason("kite")).toContain("does not offer");
    expect(
      selectProviderId({ liveFeedProvider: "kite", openalgoEnabled: false, openalgoAckVersion: null }),
      "a planned id must never be the effective feed",
    ).toBe("eod");
  });
});

/**
 * C-3 (v4.2 fix wave 3) — THE MEMO COMMENT QUOTES THE SHEET, SO IT MUST QUOTE
 * THE CURRENT ONE.
 *
 * The one-instance-per-process comment justifies the cache by quoting the
 * consent sheet's sign-in promise. Fix wave 2 (B-7) disproved that promise as
 * written — the sign-in is a PROCESS rule, and this cache is the process it is
 * a rule about — so the comment was left quoting a sentence no surface says any
 * more, which is how the next reader "restores" the wrong one.
 */
describe("the one-instance comment quotes the sheet that shipped", () => {
  /** `*`-prefixed and hard-wrapped: a quoted sentence straddles three lines. */
  const flatten = (rel: string) =>
    readFileSync(path.join(process.cwd(), rel), "utf8")
      .replace(/^\s*\*\s?/gm, " ")
      .replace(/\s+/g, " ");

  it("states the process rule and its cap, not the calendar claim", () => {
    const src = flatten("lib/quotes/registry.ts");
    expect(src, "the comment still quotes the sentence B-7 disproved").not.toContain(
      '"signs in once each trading day"',
    );
    expect(src).toContain(
      "signed in at most once a day while Vyuha stays open, again after a relaunch, after Angel One's 5 AM IST session flush, or when the credentials are re-saved",
    );
    expect(src, "the comment omits the C-2 cap the same instance now holds").toContain(
      "caps a refused login at three attempts",
    );
  });

  /**
   * D-1 (owner ruling, 2026-09-08) — THE ACCOUNT SWITCH IS THE FIFTH TRIGGER,
   * AND THIS COMMENT IS WHERE THE CODE ADMITS IT.
   *
   * The key below already carries the selected account, so switching account
   * rebuilds the instance and the next poll signs in again — and resets the
   * refused-login count with it. The sheet named four triggers and not that
   * one. The comment quotes the sheet, so it must quote the fifth clause too:
   * a reader who "restores" the four-trigger quote here is the person who
   * would next delete the trigger from the sheet.
   */
  it("names the account switch as a sign-in trigger, the way the sheet now does", () => {
    const src = flatten("lib/quotes/registry.ts");
    expect(src, "the memo comment does not quote the fifth trigger").toContain(
      "and again when the selected account is switched",
    );
    // …and the comment must not be the only place it is true: the key really
    // does mix the account in, which is what makes the sentence a fact.
    const raw = readFileSync(path.join(process.cwd(), "lib/quotes/registry.ts"), "utf8");
    const at = raw.indexOf("async function liveFeedInstanceKey(");
    expect(at, "liveFeedInstanceKey() is gone — the trigger list has nothing to stand on").toBeGreaterThan(-1);
    const body = raw.slice(at, raw.indexOf("\n}", at));
    expect(body).toContain("getSelectedAccountId()");
    expect(body).toMatch(/return \[[^\]]*\baccountId\b/);
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

/* ===========================================================================
 * S-2 (v4.2 fix wave 5, owner ruling) - THE MEMO KEY IS SCOPED PER PROVIDER.
 *
 * `liveFeedInstanceKey()` used to mix `live_feed_ack_json` WHOLE, plus the
 * OpenAlgo consent pair, into the key of EVERY memoised provider. So flipping
 * the OpenAlgo switch in Settings -> Integrations
 * (components/settings/settings-form.tsx:250 -> app/api/settings/route.ts)
 * rebuilt a live Angel One instance: a fresh session on the next poll, with
 * `jwt = null` and BOTH ceilings back at zero (C-2 refused logins, C-1 session
 * invalidations). Ruling D-1 makes this key's field list the sign-in trigger
 * list a customer is shown, and no surface names an OpenAlgo toggle - so the
 * key, not the copy, was the thing that was wrong.
 *
 * THE OWNER'S REQUIREMENT: a user may hold an OpenAlgo key, a broker's
 * credentials, or BOTH, and every item is its own. So each provider's key
 * carries its OWN identity, its OWN consent and its OWN `broker_connections`
 * rows, and nothing of anyone else's. These tests run the REAL registry
 * against a real (temp) database, because the key is read out of that database
 * and an assertion about the source text would prove nothing about the value.
 *
 * ONE TEMP DATABASE PER FILE (AGENTS.md) - this is that one.
 * ======================================================================== */
describe("S-2  one memo key per provider: OpenAlgo and a broker share no field", () => {
  let t: TempDb;

  const ACCOUNT = 1;
  const SECOND_ACCOUNT = 2;
  /** Distinct per row, so a key can be searched for the OTHER row's stamp. */
  const ANGEL_SAVED_AT = "2026-09-08T09:00:00.000Z";
  const OPENALGO_SAVED_AT = "2026-09-08T10:11:12.000Z";
  const ANGEL_ACK = withFeedAck(null, "angelone");
  const OPENALGO_ACK = OPENALGO_DISCLOSURE_VERSION;

  beforeAll(async () => {
    t = await openTempDb("quotes-registry-s2", { seed: true });
    // The dev/e2e override outranks the stored pick; nothing here may read a
    // provider the operator's shell chose.
    delete process.env.VYUHA_QUOTE_PROVIDER;
    // A SECOND live account, so `0` is genuinely the aggregate VIEW and not a
    // single-account book resolved to its one account (`getSelectedAccountId`).
    t.db.insert(t.schema.accounts).values({ id: SECOND_ACCOUNT, name: "Swing", isDefault: false }).run();
  });

  afterAll(() => {
    resetLiveFeedProviderCache();
    t?.cleanup();
  });

  /** Every test starts from an empty cache, so a memo hit is never inherited. */
  beforeEach(() => {
    resetLiveFeedProviderCache();
  });

  type SettingsPatch = Partial<{
    liveFeedProvider: string;
    liveFeedAckJson: string | null;
    openalgoEnabled: boolean;
    openalgoAckVersion: string | null;
    selectedAccountId: number;
    liveFeedRefreshSeconds: number;
  }>;

  /**
   * A settings write, exactly as the route makes it - and DELIBERATELY without
   * `resetLiveFeedProviderCache()`. Resetting the cache would rebuild the
   * instance whatever the key said, which is the one thing these tests must
   * not do: the key is the subject.
   */
  const setSettings = (patch: SettingsPatch) => t.db.update(t.schema.settings).set(patch).run();

  /** Save (or re-save) one broker's credentials for one account. */
  function saveConnection(broker: string, accountId: number, updatedAt: string, secret = "s") {
    t.sqlite.prepare("DELETE FROM broker_connections WHERE broker = ? AND account_id = ?").run(broker, accountId);
    t.db
      .insert(t.schema.brokerConnections)
      .values({
        accountId,
        broker,
        apiKey: `${broker}-api-key-${secret}`,
        accessToken: "",
        authJson: JSON.stringify({ clientCode: "S5KEY01", pin: "9137", totpSecret: secret }),
        updatedAt,
      })
      .run();
  }

  const clearConnections = () => t.db.delete(t.schema.brokerConnections).run();

  /** CONFIGURATION 1 - an OpenAlgo key and nothing else. */
  function configOpenAlgoOnly() {
    clearConnections();
    saveConnection("openalgo", ACCOUNT, OPENALGO_SAVED_AT);
    setSettings({
      liveFeedProvider: "openalgo",
      liveFeedAckJson: null,
      openalgoEnabled: true,
      openalgoAckVersion: OPENALGO_ACK,
      selectedAccountId: ACCOUNT,
      liveFeedRefreshSeconds: 3,
    });
  }

  /** CONFIGURATION 2 - a broker's own credentials and nothing else. */
  function configBrokerOnly() {
    clearConnections();
    saveConnection("angelone", ACCOUNT, ANGEL_SAVED_AT);
    setSettings({
      liveFeedProvider: "angelone",
      liveFeedAckJson: ANGEL_ACK,
      openalgoEnabled: false,
      openalgoAckVersion: null,
      selectedAccountId: ACCOUNT,
      liveFeedRefreshSeconds: 3,
    });
  }

  /** CONFIGURATION 3 - BOTH, which is the configuration S-2 was found in. */
  function configBoth(pick: "angelone" | "openalgo") {
    clearConnections();
    saveConnection("angelone", ACCOUNT, ANGEL_SAVED_AT);
    saveConnection("openalgo", ACCOUNT, OPENALGO_SAVED_AT);
    setSettings({
      liveFeedProvider: pick,
      liveFeedAckJson: ANGEL_ACK,
      openalgoEnabled: true,
      openalgoAckVersion: OPENALGO_ACK,
      selectedAccountId: ACCOUNT,
      liveFeedRefreshSeconds: 3,
    });
  }

  /* ---- (1) each provider's key is its own -------------------------------- */

  it("1a  an Angel One key carries no OpenAlgo field - the toggle and the sheet leave it byte-identical", async () => {
    configBoth("angelone");
    const key = await liveFeedInstanceKey("angelone", 3);
    expect(key, "the Angel One key names the OpenAlgo integration").not.toContain("openalgo");
    expect(key, "the Angel One key carries the OpenAlgo credential row's stamp").not.toContain(OPENALGO_SAVED_AT);
    expect(key, "the Angel One key lost its own credential row").toContain(ANGEL_SAVED_AT);

    // THE TWO OPENALGO GESTURES, performed against a live Angel One pick.
    setSettings({ openalgoEnabled: false });
    expect(
      await liveFeedInstanceKey("angelone", 3),
      "flipping the OpenAlgo integration changed the Angel One instance key",
    ).toBe(key);
    setSettings({ openalgoAckVersion: "0" });
    expect(
      await liveFeedInstanceKey("angelone", 3),
      "an OpenAlgo acknowledgement changed the Angel One instance key",
    ).toBe(key);
    // ...and saving an OpenAlgo key is not an Angel One gesture either.
    saveConnection("openalgo", ACCOUNT, "2026-09-08T23:00:00.000Z", "rotated");
    expect(await liveFeedInstanceKey("angelone", 3), "an OpenAlgo key rotation re-keyed Angel One").toBe(key);
  });

  it("1b  an OpenAlgo key carries no broker field - no Angel One digest, no Angel One ack", async () => {
    configBoth("openalgo");
    const key = await liveFeedInstanceKey("openalgo", 3);
    expect(key, "the OpenAlgo key carries an Angel One credential row").not.toContain(ANGEL_SAVED_AT);
    expect(key, "the OpenAlgo key lost its own credential row").toContain(OPENALGO_SAVED_AT);

    // THE TWO BROKER GESTURES, performed against a live OpenAlgo pick.
    setSettings({ liveFeedAckJson: withFeedAck(withFeedAck(null, "angelone"), "upstox") });
    expect(
      await liveFeedInstanceKey("openalgo", 3),
      "a broker acknowledgement changed the OpenAlgo instance key",
    ).toBe(key);
    saveConnection("angelone", ACCOUNT, "2026-09-08T23:30:00.000Z", "resaved");
    expect(
      await liveFeedInstanceKey("openalgo", 3),
      "re-saving the Angel One credentials changed the OpenAlgo instance key",
    ).toBe(key);
  });

  it("1c  the three memoised keys are disjoint in every configuration a user can hold", async () => {
    /** The credential fingerprint is the LAST field of the key. */
    const creds = (k: string) => k.split("|").at(-1)!;
    for (const [label, apply, owners] of [
      ["OpenAlgo only", configOpenAlgoOnly, ["openalgo"]],
      ["broker only", configBrokerOnly, ["angelone"]],
      ["both", () => configBoth("angelone"), ["angelone", "openalgo"]],
    ] as const) {
      apply();
      const keys = {
        angelone: await liveFeedInstanceKey("angelone", 3),
        openalgo: await liveFeedInstanceKey("openalgo", 3),
        upstox: await liveFeedInstanceKey("upstox", 3),
      };
      const all = Object.values(keys);
      expect(new Set(all).size, `${label}: two providers share one instance key`).toBe(3);
      for (const [id, key] of Object.entries(keys)) {
        expect(key.startsWith(`${id}|`), `${label}: ${id}'s key does not lead with its own id`).toBe(true);
        // A broker never reads an OpenAlgo row and an OpenAlgo feed never reads
        // a broker's - FEED_CONNECTION_MATCH, the rule each gate already uses.
        // So a provider with no saved rows of its OWN keys on nothing, however
        // many rows the other one has.
        const owned = (owners as readonly string[]).includes(id);
        expect(creds(key) !== "none", `${label}: ${id} keys on rows that are not its own`).toBe(owned);
      }
      // ...and where BOTH are configured the two fingerprints are of different
      // rows, so neither could ever be mistaken for the other.
      if (owners.length === 2) expect(creds(keys.angelone)).not.toBe(creds(keys.openalgo));
    }
  });

  it("1d  refreshSeconds is in the key of the providers that CONSUME it, and only those", async () => {
    // `createProvider()` hands the slider to Upstox (:181) and to OpenAlgo
    // (:197) and NOT to Angel One (:191), whose cadence is the open-position
    // count (ruling 4.2-4). A field the adapter cannot read is a rebuild - and
    // therefore an undisclosed sign-in - for nothing.
    configBoth("angelone");
    expect(
      await liveFeedInstanceKey("angelone", 10),
      "the slider re-keys Angel One, which never reads it",
    ).toBe(await liveFeedInstanceKey("angelone", 3));
    expect(await liveFeedInstanceKey("openalgo", 10)).not.toBe(await liveFeedInstanceKey("openalgo", 3));
    expect(await liveFeedInstanceKey("upstox", 10)).not.toBe(await liveFeedInstanceKey("upstox", 3));
  });

  /* ---- (2) neither side disturbs the other's live instance ---------------- */

  it("2a  flipping the OpenAlgo integration does not sign the Angel One account in again", async () => {
    configBoth("angelone");
    const before = await getLiveFeedProvider();
    expect(before.id).toBe("angelone");
    expect(await getLiveFeedProvider(), "the memo missed on an unchanged database").toBe(before);

    // THE GESTURE - Settings -> Integrations -> OpenAlgo off.
    setSettings({ openalgoEnabled: false });
    expect(
      await getLiveFeedProvider(),
      "flipping the OpenAlgo switch rebuilt the Angel One instance: an undisclosed sign-in, both ceilings cleared",
    ).toBe(before);

    // THE OTHER GESTURE - the OpenAlgo sheet acknowledged.
    setSettings({ openalgoEnabled: true, openalgoAckVersion: "0" });
    expect(await getLiveFeedProvider(), "an OpenAlgo acknowledgement rebuilt the Angel One instance").toBe(before);
  });

  it("2b  a broker acknowledgement or credential re-save does not rebuild the OpenAlgo instance", async () => {
    configBoth("openalgo");
    const before = await getLiveFeedProvider();
    expect(before.id).toBe("openalgo");

    setSettings({ liveFeedAckJson: withFeedAck(withFeedAck(null, "angelone"), "upstox") });
    expect(
      await getLiveFeedProvider(),
      "accepting a broker sheet rebuilt the OpenAlgo instance and dropped its shared rate guard",
    ).toBe(before);

    saveConnection("angelone", ACCOUNT, "2026-09-09T01:00:00.000Z", "resaved");
    expect(await getLiveFeedProvider(), "re-saving the Angel One credentials rebuilt the OpenAlgo instance").toBe(
      before,
    );
  });

  /* ---- (3) the disclosed triggers still rebuild --------------------------- */

  it("3a  the disclosed Angel One triggers still build a NEW instance", async () => {
    configBrokerOnly();
    const first = await getLiveFeedProvider();
    expect(first.id).toBe("angelone");

    // TRIGGER - the account picker, including to and from All accounts (D-1).
    setSettings({ selectedAccountId: SECOND_ACCOUNT });
    const onSwing = await getLiveFeedProvider();
    expect(onSwing, "a switched account reused the other book's session").not.toBe(first);
    setSettings({ selectedAccountId: 0 });
    expect(await getLiveFeedProvider(), "the All-accounts view reused an account's session").not.toBe(onSwing);

    // TRIGGER - the credentials re-saved (a new updated_at and a new digest).
    setSettings({ selectedAccountId: ACCOUNT });
    const before = await getLiveFeedProvider();
    saveConnection("angelone", ACCOUNT, "2026-09-09T02:00:00.000Z", "rotated");
    expect(await getLiveFeedProvider(), "a re-saved credential kept the old session").not.toBe(before);
  });

  it("3b  the Angel One ack ENTRY is still in its key - only the other broker's is not", async () => {
    // A stale version collapses the feed to end-of-day, so this trigger is
    // asserted on the key rather than on an instance: the entry is what the
    // key must carry, and the SIBLING entry is what it must ignore.
    configBrokerOnly();
    const key = await liveFeedInstanceKey("angelone", 3);
    setSettings({ liveFeedAckJson: JSON.stringify({ angelone: "0" }) });
    expect(
      await liveFeedInstanceKey("angelone", 3),
      "the Angel One acknowledgement left the key - accepting the sheet would not rebuild the instance",
    ).not.toBe(key);
    setSettings({ liveFeedAckJson: withFeedAck(withFeedAck(null, "angelone"), "upstox") });
    expect(await liveFeedInstanceKey("angelone", 3), "acknowledging the UPSTOX sheet re-keyed Angel One").toBe(key);
  });

  /* ---- (4) the memo still hits ------------------------------------------- */

  it("4  a same-key call returns the SAME instance in all three configurations", async () => {
    for (const [label, apply, id] of [
      ["OpenAlgo only", configOpenAlgoOnly, "openalgo"],
      ["broker only", configBrokerOnly, "angelone"],
      ["both, OpenAlgo picked", () => configBoth("openalgo"), "openalgo"],
      ["both, Angel One picked", () => configBoth("angelone"), "angelone"],
    ] as const) {
      resetLiveFeedProviderCache();
      apply();
      const a = await getLiveFeedProvider();
      expect(a.id, `${label}: the wrong feed is effective`).toBe(id);
      expect(await getLiveFeedProvider(), `${label}: the memo missed and opened a second session`).toBe(a);
    }
  });
});
