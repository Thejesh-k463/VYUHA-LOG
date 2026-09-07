import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { OPENALGO_DISCLOSURE_VERSION } from "@/lib/domain/openalgo-disclosure";
import { FEED_BLOCKED_HEALTH, feedBlockState, feedHealthText } from "@/components/settings/live-feed-card";

/**
 * `/api/live/feed` — the Live Desk's feed settings, and the consent gate that
 * decides whether "openalgo" in a settings column may ever become a request.
 *
 * WHAT THIS FILE HOLDS TO ACCOUNT
 *   1. THE GATE IS SERVER-SIDE. Hiding a radio button is not a control. v4.0
 *      answered 400 because `OPENALGO_FEED_ENABLED` kept the id out of the zod
 *      enum entirely; v4.1 ships the feed, so the request parses and the
 *      CONSENT gate underneath (`selectProviderId`,
 *      `tests/quotes-registry.test.ts`) is what refuses it — 403, storing
 *      nothing, the same precedent `app/api/import/broker/route.ts` set.
 *   2. A STORED PICK IS NOT CONSENT. A column carrying "openalgo" (a restored
 *      backup) is shown as the pick and still runs `eod`, because the two
 *      consent columns are machine state and do not travel with a backup.
 *   3. IT IS A ROUTE HANDLER, not a server action (AGENTS.md) — the card posts
 *      and calls `router.refresh()`, so no sibling Settings card is remounted.
 *   4. THE MARK COMES FROM THE SERVER'S PROVIDER, once a day, and a price the
 *      client sent could never reach the journal.
 *
 * ONE temp database for the file (lib/db caches its connection on globalThis).
 * The route is imported DYNAMICALLY after `openTempDb()` because it imports
 * `@/lib/db` statically — a top-level import here would bind the connection
 * before the helper sets `VYUHA_DB_PATH`.
 *
 * NO MODULE-GRAPH SCAFFOLDING ANY MORE. The consent-gate block at the bottom
 * used to re-import the route under `vi.resetModules()` + a `vi.doMock` of
 * `@/lib/quotes/types` with `OPENALGO_FEED_ENABLED: true`, because the branch
 * was unreachable while the flag was false. v4.1 flipped the flag, so the
 * block runs against the SAME normally-imported route as everything above it —
 * a mocked constant proves the branch compiles, the real one proves it ships.
 */

let t: TempDb;
let route: typeof import("@/app/api/live/feed/route");

const SWING = 2;

function get(init: RequestInit = {}): Promise<Response> {
  return route.GET(
    new Request("http://127.0.0.1:3011/api/live/feed", { headers: { host: "127.0.0.1:3011" }, ...init }),
  );
}

function post(body: unknown, init: RequestInit = {}): Promise<Response> {
  return route.POST(
    new Request("http://127.0.0.1:3011/api/live/feed", {
      method: "POST",
      headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    }),
  );
}

function settingsRow() {
  return t.db.select().from(t.schema.settings).limit(1).all()[0];
}

function setConsent(enabled: boolean, ackVersion: string | null) {
  t.db.update(t.schema.settings).set({ openalgoEnabled: enabled, openalgoAckVersion: ackVersion }).run();
}

beforeAll(async () => {
  t = await openTempDb("live-feed-route", { seed: true });
  route = await import("@/app/api/live/feed/route");
  await import("@/lib/queries/trades");

  t.db.insert(t.schema.accounts).values([{ id: SWING, name: "Swing" }]).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: SWING }).run();
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({ accountId: SWING, symbol: "TCS", tradingsymbol: "TCS", isOpen: true, buyQty: 10, avgBuyPrice: 3000 }),
    ])
    .run();
});

afterAll(() => {
  delete process.env.VYUHA_QUOTE_PROVIDER;
  t?.cleanup();
});

describe("the endpoint answers the app itself and nothing else", () => {
  it("refuses a cross-site GET", async () => {
    const res = await get({ headers: { host: "127.0.0.1:3011", origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
  });

  it("refuses a cross-site POST before it parses the body", async () => {
    const res = await post(
      { action: "provider", provider: "openalgo" },
      { headers: { host: "127.0.0.1:3011", "content-type": "application/json", "sec-fetch-site": "cross-site", origin: "https://evil.example" } },
    );
    expect(res.status).toBe(403);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });
});

describe("GET — what the Settings card renders", () => {
  it("defaults to end-of-day, so an upgraded install changes no behaviour", async () => {
    const body = await (await get()).json();
    expect(body.ok).toBe(true);
    expect(body.feed.stored).toBe("eod");
    expect(body.feed.effective).toBe("eod");
    expect(body.feed.refreshSeconds).toBe(3);
  });

  it("offers exactly the four v4.2 ships — `mock` is a test pin, never a choice", async () => {
    const body = await (await get()).json();
    // `mock` is shipped-but-not-pickable: it is in SHIPPED_PROVIDER_IDS so e2e
    // can pin it through VYUHA_QUOTE_PROVIDER, and the route's PICKABLE filter
    // is what keeps it out of the picker. `upstox` AND `angelone` joined the
    // pickable set in v4.2, each behind its own release flag — and a SIXTH id
    // appearing here is the regression this list exists to catch.
    expect(body.providers.map((p: { id: string }) => p.id).sort()).toEqual([
      "angelone",
      "eod",
      "manual",
      "openalgo",
      "upstox",
    ]);
    for (const p of body.providers) {
      // The picker's label and its egress sentence come from the registry's
      // capability block, not from the JSX — and the id it is keyed by is the
      // capability's own id, never a second copy that could drift.
      expect(p.label.length).toBeGreaterThan(3);
      expect(p.egressDescription.endsWith(".")).toBe(true);
    }
  });

  it("reports the disclosure version the acknowledgement must match", async () => {
    const body = await (await get()).json();
    expect(body.openalgo.disclosureVersion).toBe(OPENALGO_DISCLOSURE_VERSION);
    expect(body.openalgo.ackCurrent).toBe(false);
    expect(body.health.provider).toBe("eod");
  });
});

describe("POST provider — what the picker may store", () => {
  it("stores the two that ask nothing of the user", async () => {
    for (const provider of ["manual", "eod"]) {
      const res = await post({ action: "provider", provider });
      expect(res.status, provider).toBe(200);
      expect(settingsRow()?.liveFeedProvider, provider).toBe(provider);
    }
  });

  it("rejects a provider that is not pickable, and one that is not a provider at all", async () => {
    for (const provider of ["mock", "kite", "yahoo"]) {
      const res = await post({ action: "provider", provider });
      expect(res.status, provider).toBe(400);
    }
    // openalgo is NOT in that list any more. v4.0 answered 400 for it because
    // OPENALGO_FEED_ENABLED kept the id out of the zod enum; v4.1 ships it, so
    // the body parses and the CONSENT gate answers instead. The two statuses
    // say different things on purpose — 400 is "no such option", 403 is "not
    // until the disclosure is acknowledged" — and the gate's four cases are
    // exercised in full at the bottom of this file.
    setConsent(false, null);
    const res = await post({ action: "provider", provider: "openalgo" });
    expect(res.status, "openalgo is refused by consent now, not by the enum").toBe(403);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });
});

describe("POST refresh-seconds — clamped to 1–5 (owner answer Q25)", () => {
  it("clamps rather than errors, in both directions", async () => {
    expect((await (await post({ action: "refresh-seconds", seconds: 99 })).json()).seconds).toBe(5);
    expect(settingsRow()?.liveFeedRefreshSeconds).toBe(5);
    expect((await (await post({ action: "refresh-seconds", seconds: 0 })).json()).seconds).toBe(1);
    expect(settingsRow()?.liveFeedRefreshSeconds).toBe(1);
  });

  it("refuses a body that is not one of the three actions", async () => {
    expect((await post({ action: "sell-everything" })).status).toBe(400);
    expect((await post({ action: "refresh-seconds", seconds: "three" })).status).toBe(400);
  });
});

describe("POST mark — one persisted mark per position per day, priced by the server", () => {
  // The button waives the 15:30 clock but NOT the weekend refusal (fix wave
  // 2026-09-06, M1). Against the real clock this block is red every Saturday
  // and Sunday, so it is pinned to a Friday, 16:00 IST.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T10:30:00Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("saves today's mark from the provider's own snapshot", async () => {
    // Pinned to the mock provider: the route must take its prices from the
    // server's provider, never from anything a caller sent.
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    const body = await (await post({ action: "mark" })).json();
    expect(body.ok).toBe(true);
    expect(body.marked).toBe(1);
    const rows = t.db.select().from(t.schema.mtmPrices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("TCS");
    expect(rows[0].price).toBeGreaterThan(0);
    expect(settingsRow()?.lastLiveMarkDate).toBe(body.date);
  });

  it("says so plainly on the second press of the same day, and writes nothing more", async () => {
    const body = await (await post({ action: "mark" })).json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("already saved");
    expect(t.db.select().from(t.schema.mtmPrices).all()).toHaveLength(1);
  });

  it("refuses with 400 when there is no open position to mark", async () => {
    t.sqlite.prepare("UPDATE trades SET is_open = 0").run();
    const res = await post({ action: "mark" });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("No open positions to mark.");
    delete process.env.VYUHA_QUOTE_PROVIDER;
  });
});

/**
 * F8 — THE BUTTON WAIVES THE CLOCK, AT THE ROUTE.
 *
 * `route.ts` passes `ignoreClock: true` to `persistDailyMarks()` — the whole
 * contract of "Save today's mark": the user asking is a better reason than
 * 15:30, and the once-a-day rule still holds. Nothing tested it. Every other
 * `action: "mark"` POST in this file runs at Friday 16:00 IST (and the seam
 * suite's runs at a Saturday), so the waiver could be deleted from the route
 * and all of them stayed green — the clock was already past the close.
 *
 * This block is the missing pin: 12:00 IST, mid-session, on a Friday. Without
 * the waiver the route answers "The session has not closed yet."
 */
describe("POST mark — mid-session, the button waives the CLOCK (F8)", () => {
  /** Friday 2026-09-04, 12:00 IST — inside the session, hours before the close. */
  beforeAll(() => {
    // `toFake: ["Date"]` only: the route awaits real dynamic imports on its way
    // to the provider and the database, and a fully faked timer set stalls the
    // module loader.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-04T06:30:00Z"));
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    // The block above closed every trade and left the day's rows behind; this
    // one needs an open cash position and a clean day (the mark is once per
    // (symbol, IST date) row).
    t.sqlite.prepare("UPDATE trades SET is_open = 1").run();
    t.sqlite.prepare("DELETE FROM mtm_prices").run();
    t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
  });
  afterAll(() => {
    vi.useRealTimers();
    delete process.env.VYUHA_QUOTE_PROVIDER;
  });

  it("writes at 12:00 IST — one row per open cash symbol, dated today", async () => {
    const res = await post({ action: "mark" });
    const body = await res.json();
    expect(body.ok, "the button must waive the 15:30 clock: " + body.message).toBe(true);
    expect(body.date).toBe("2026-09-04");

    const rows = t.db.select().from(t.schema.mtmPrices).all();
    expect(rows.map((r) => r.symbol)).toEqual(["TCS"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].asOfDate).toBe("2026-09-04");
    expect(rows[0].price).toBeGreaterThan(0);
    expect(body.marked).toBe(1);
  });

  it("…and still only once: a second press mid-session changes nothing", async () => {
    const before = t.db.select().from(t.schema.mtmPrices).all();
    const body = await (await post({ action: "mark" })).json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("already saved");
    expect(t.db.select().from(t.schema.mtmPrices).all().map((r) => r.price)).toEqual(before.map((r) => r.price));
  });
});

/**
 * THE CONSENT GATE, EXERCISED AGAINST THE ROUTE THIS RELEASE SHIPS.
 *
 * `route.ts` has always carried the gate (`openAlgoGate(…)` → 403), but while
 * `OPENALGO_FEED_ENABLED` was false the id was not in the zod enum, so every
 * request for it stopped one line earlier at a 400 and the gate was never
 * reached. These four cases therefore ran against a route re-imported under
 * `vi.resetModules()` + a `vi.doMock` of the constant — scaffolding that is
 * now DELETED, because v4.1 ships the feed and the branch is live in the same
 * module every other block here uses. A mocked constant only ever proved the
 * branch compiled.
 *
 * It runs LAST and puts the settings row back, because it is the only block
 * here that stores `openalgo` — the state the blocks above assert against is
 * `eod` with no consent.
 */
describe("POST provider — the consent gate, on the shipped route", () => {
  beforeAll(() => {
    setConsent(false, null);
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
  });

  afterAll(() => {
    setConsent(false, null);
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
  });

  it("openalgo really is pickable in this release — the four cases below are the GATE, not the enum", async () => {
    // Without this they could all be passing for the v4.0 reason (a 400 from
    // the zod enum) rather than exercising the acknowledgement check at all.
    const ids = (await (await get()).json()).providers.map((p: { id: string }) => p.id).sort();
    expect(ids).toContain("openalgo");
    expect(ids).toEqual(["angelone", "eod", "manual", "openalgo", "upstox"]);
  });

  it("refuses openalgo with 403 and stores NOTHING when the disclosure was never accepted", async () => {
    const res = await post({ action: "provider", provider: "openalgo" });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/openalgo/i);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });

  it("refuses it again when the integration is on but the acknowledgement is an OLD version", async () => {
    setConsent(true, "0");
    const res = await post({ action: "provider", provider: "openalgo" });
    expect(res.status).toBe(403);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });

  it("stores it once both halves are in place", async () => {
    setConsent(true, OPENALGO_DISCLOSURE_VERSION);
    const res = await post({ action: "provider", provider: "openalgo" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.feed.effective).toBe("openalgo");
    expect(settingsRow()?.liveFeedProvider).toBe("openalgo");
  });

  it("falls back to end-of-day the moment consent goes away — the pick survives, the feed does not", async () => {
    // The RESTORE case: a backup carries the picker column, but the two consent
    // columns are machine state and do not travel.
    setConsent(false, null);
    const body = await (await get()).json();
    expect(body.feed.stored).toBe("openalgo");
    expect(body.feed.effective).toBe("eod");
    expect(body.feed.blockedReason).toBeTruthy();
    expect(body.health.provider).toBe("eod");

    // A-6 — OpenAlgo'S OWN BEHAVIOUR IS UNCHANGED, and that is the point of
    // asserting it here. The card's blocked block is now derived from
    // `stored !== effective` for EVERY provider instead of from
    // `provider === "openalgo"`, so this case must keep rendering exactly what
    // v4.1 rendered: the route's sentence, and NO "Review and accept" control
    // — OpenAlgo's consent is given on the Integrations screen, not in a sheet
    // this card owns.
    const block = feedBlockState(body.feed);
    expect(block?.reason).toBe(body.feed.blockedReason);
    expect(block?.reviewProvider, "the card offered a sheet OpenAlgo does not have").toBeNull();
    // …and the health line no longer reports the end-of-day fallback as the
    // health of the feed the user picked.
    expect(feedHealthText({ health: body.health, blocked: block !== null })).toBe(FEED_BLOCKED_HEALTH);
  });
});
