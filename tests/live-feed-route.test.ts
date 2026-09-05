import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { OPENALGO_DISCLOSURE_VERSION } from "@/lib/domain/openalgo-disclosure";

/**
 * `/api/live/feed` — the Live Desk's feed settings, and the consent gate that
 * decides whether "openalgo" in a settings column may ever become a request.
 *
 * WHAT THIS FILE HOLDS TO ACCOUNT
 *   1. THE GATE IS SERVER-SIDE. Hiding a radio button is not a control. Asking
 *      for `openalgo` without a current acknowledgement is 403 AND stores
 *      nothing — the same precedent `app/api/import/broker/route.ts` set.
 *   2. A STORED PICK IS NOT CONSENT. Consent revoked (or restored from another
 *      machine, where the consent columns are machine state and do not travel)
 *      leaves the pick visible but the EFFECTIVE provider on `eod`, with a
 *      reason. A restore can never open a feed nobody here agreed to.
 *   3. IT IS A ROUTE HANDLER, not a server action (AGENTS.md) — the card posts
 *      and calls `router.refresh()`, so no sibling Settings card is remounted.
 *   4. THE MARK COMES FROM THE SERVER'S PROVIDER, once a day, and a price the
 *      client sent could never reach the journal.
 *
 * ONE temp database for the file (lib/db caches its connection on globalThis).
 * The route is imported DYNAMICALLY after `openTempDb()` because it imports
 * `@/lib/db` statically — a top-level import here would bind the connection
 * before the helper sets `VYUHA_DB_PATH`.
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

  it("offers exactly the three a user may pick — `mock` is a test pin, never a choice", async () => {
    const body = await (await get()).json();
    expect(body.providers.map((p: { id: string }) => p.id).sort()).toEqual(["eod", "manual", "openalgo"]);
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

describe("POST provider — the consent gate lives on the server", () => {
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
    // This is the RESTORE case: a backup carries the picker column, but the
    // two consent columns are machine state and do not travel.
    setConsent(false, null);
    const body = await (await get()).json();
    expect(body.feed.stored).toBe("openalgo");
    expect(body.feed.effective).toBe("eod");
    expect(body.feed.blockedReason).toBeTruthy();
    expect(body.health.provider).toBe("eod");
    setConsent(true, OPENALGO_DISCLOSURE_VERSION);
  });

  it("rejects a provider that is not pickable, and one that is not a provider at all", async () => {
    for (const provider of ["mock", "kite", "yahoo"]) {
      const res = await post({ action: "provider", provider });
      expect(res.status, provider).toBe(400);
    }
    expect(settingsRow()?.liveFeedProvider).toBe("openalgo");
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
