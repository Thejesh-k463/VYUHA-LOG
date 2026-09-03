import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRO_FEATURES } from "@/lib/license";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * GET /api/search — Search v1 (v3.8), against a real two-account database.
 *
 * The account is whatever the sidebar selected (`getSelectedAccountId()`),
 * never a client parameter; 0 is the All-accounts view. Gated screens are
 * shown locked with what unlocks them, and a user's own trade rows are never
 * locked — not even under a lapsed trial.
 *
 * One temp database per FILE; every import is dynamic so VYUHA_DB_PATH is
 * set before anything binds lib/db.
 */

let t: TempDb;
let route: typeof import("@/app/api/search/route");
let license: typeof import("@/lib/queries/license");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

let primaryTradeId = 0;
let swingTradeId = 0;

const get = async (qs: string) => {
  const res = await route.GET(new Request(`http://local/api/search${qs}`));
  return { status: res.status, headers: res.headers, body: await res.json() };
};

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

/** A seeded temp DB is on trial (Pro). Lapse it, or restore it. */
function setEntitlement(pro: boolean) {
  t.db
    .update(t.schema.settings)
    .set({ licenseKey: null, trialStartedAt: pro ? new Date().toISOString() : "2020-01-01T00:00:00.000Z" })
    .run();
  expect(license.getEntitlement().pro).toBe(pro);
}

type Result = { source: string; id: number | string; title: string; href: string; locked: boolean; unlocks?: string };

beforeAll(async () => {
  t = await openTempDb("search-route", { seed: true });
  route = await import("@/app/api/search/route");
  license = await import("@/lib/queries/license");

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
  const rows = t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({ accountId: PRIMARY, symbol: "TCS", notes: "breakout retest", buyDate: "2026-07-01", sellDate: "2026-07-03" }),
      tradeRow({ accountId: SWING, symbol: "INFY", notes: "breakout retest", buyDate: "2026-07-02", sellDate: "2026-07-02" }),
    ])
    .returning({ id: t.schema.trades.id })
    .all();
  primaryTradeId = rows[0].id;
  swingTradeId = rows[1].id;
  t.db.insert(t.schema.playbooks).values({ name: "Gap fade", description: "Fade the opening gap into VWAP", rules: ["wait for the first 15m close"] }).run();
});

afterAll(() => t?.cleanup());

describe("validation", () => {
  it("400 on a blank q", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?q=")).status).toBe(400);
    expect((await get("?q=%20%20")).status).toBe(400);
  });

  it("400 when cat names no known source", async () => {
    expect((await get("?q=kou&cat=nope")).status).toBe(400);
  });

  it("answers no-store, so a cached answer cannot outlive an account switch", async () => {
    selectAccount(PRIMARY);
    const res = await get("?q=kou");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("account scope", () => {
  it("'kou' finds the note only in the selected account…", async () => {
    selectAccount(PRIMARY);
    const trades = ((await get("?q=kou&cat=trades")).body.results as Result[]).filter((r) => r.source === "trades");
    expect(trades.map((r) => r.id)).toEqual([primaryTradeId]);
    expect(trades[0].href).toBe("/trades?symbol=TCS&from=2026-07-01&to=2026-07-03");

    selectAccount(SWING);
    const swing = ((await get("?q=kou&cat=trades")).body.results as Result[]).filter((r) => r.source === "trades");
    expect(swing.map((r) => r.id)).toEqual([swingTradeId]);
  });

  it("…and in both when All accounts (0) is selected", async () => {
    selectAccount(ALL);
    const trades = ((await get("?q=kou&cat=trades")).body.results as Result[]).filter((r) => r.source === "trades");
    expect(trades.map((r) => r.id).sort()).toEqual([primaryTradeId, swingTradeId].sort());
  });

  it("playbooks are global — found whichever account is selected", async () => {
    for (const id of [PRIMARY, SWING, ALL]) {
      selectAccount(id);
      const hits = ((await get("?q=gap&cat=playbooks")).body.results as Result[]).filter((r) => r.source === "playbooks");
      expect(hits.map((r) => r.title), `account ${id}`).toEqual(["Gap fade"]);
      expect(hits[0].locked).toBe(false);
    }
  });
});

describe("gating", () => {
  const riskLabel = PRO_FEATURES.find((f) => f.href === "/risk")!.label;

  it("a Pro-gated screen is shown locked with what unlocks it under a free entitlement…", async () => {
    setEntitlement(false);
    const body = (await get("?q=portfolio%20risk&cat=screens,help")).body;
    const screen = (body.results as Result[]).find((r) => r.source === "screens" && r.href === "/risk");
    expect(screen).toBeDefined();
    expect(screen!.locked).toBe(true);
    expect(screen!.unlocks).toBe(riskLabel);
    const help = (body.results as Result[]).find((r) => r.source === "help" && r.href === "/risk");
    expect(help?.locked).toBe(true);
    expect(help?.unlocks).toBe(riskLabel);
    // A free screen in the same answer is not locked.
    const free = (body.results as Result[]).find((r) => r.source === "screens" && r.href === "/");
    expect(free?.locked ?? false).toBe(false);
  });

  it("…and unlocked under Pro", async () => {
    setEntitlement(true);
    const body = (await get("?q=portfolio%20risk&cat=screens")).body;
    const screen = (body.results as Result[]).find((r) => r.source === "screens" && r.href === "/risk");
    expect(screen).toMatchObject({ locked: false });
    expect(screen!.unlocks).toBeUndefined();
  });

  it("a trade result is never locked under free — the core journal (invariant 7)", async () => {
    setEntitlement(false);
    selectAccount(ALL);
    const trades = ((await get("?q=kou")).body.results as Result[]).filter((r) => r.source === "trades");
    expect(trades).toHaveLength(2);
    for (const r of trades) {
      expect(r.locked).toBe(false);
      expect(r.unlocks).toBeUndefined();
    }
    setEntitlement(true);
  });
});

describe("shape", () => {
  it("caps every source at 50 and reports the categories and timing", async () => {
    selectAccount(ALL);
    t.db.transaction((tx) => {
      for (let i = 0; i < 60; i++) tx.insert(t.schema.trades).values(tradeRow({ accountId: PRIMARY, symbol: `CAP${i}`, notes: `overflow ${i}` })).run();
    });
    const body = (await get("?q=overflow")).body;
    expect(body.ok).toBe(true);
    expect(body.cap).toBe(50);
    expect(body.categories).toEqual(["trades", "symbols", "playbooks", "instruments", "sessions", "challans", "help", "screens"]);
    expect(typeof body.tookMs).toBe("number");
    const counts = new Map<string, number>();
    for (const r of body.results as Result[]) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
    for (const [source, n] of counts) expect(n, source).toBeLessThanOrEqual(50);
    expect(counts.get("trades")).toBe(50);
  });
});
