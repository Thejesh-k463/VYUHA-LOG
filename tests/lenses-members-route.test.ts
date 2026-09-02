import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * `/api/lenses/members` — the drill-down's on-demand read (v3.7.0).
 *
 * /lenses used to hand the browser the whole book so it could rebuild the
 * groups itself: ~9.3 MB of RSC flight per visit on the 25,001-trade perf
 * book, to render a list of 45 rows. The page now ships the group rows and
 * this route answers the click.
 *
 * That is only a RENDER change if the array this route returns is the array
 * the client used to receive — same projection, same rows, SAME ORDER, same
 * account scope. Everything the drill-down shows is derived from it: the
 * table, the top-5 winners/losers ledger, the distinct-instrument count, and
 * the DELETE preview. So this file compares the route's answer against the
 * page's own code path over the same database, group by group, for all six
 * lenses — the equivalence the perf pass rests on, tested against real I/O
 * rather than asserted.
 *
 * One temp database per FILE (AGENTS.md); every import is dynamic so
 * `VYUHA_DB_PATH` is set before anything binds `lib/db`.
 */

let t: TempDb;
let route: typeof import("@/app/api/lenses/members/route");
let q: typeof import("@/lib/queries/trades");
let dom: typeof import("@/lib/domain/lenses");
let edge: typeof import("@/lib/domain/lens-edge");
let license: typeof import("@/lib/queries/license");

const PRIMARY = 1;
const SWING = 2;

const get = async (qs: string) => {
  const res = await route.GET(new Request(`http://local/api/lenses/members${qs}`));
  return { status: res.status, body: await res.json() };
};

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

/** The page's own path: the projection, the pure grouping, the ids in order. */
/**
 * The page path, resolved once per lens and reused.
 *
 * This USED to re-read the whole book, re-read the batches and re-run the
 * grouping on every single call — and it is called once per group, ~45 times
 * across the six lenses, on top of the six reads in the loop below. Locally
 * that was merely wasteful; on the Windows CI runner it blew vitest's 5 s
 * default and failed the one job the release gate depends on, while ubuntu
 * and macOS passed. Caching cannot weaken the assertion: the route under test
 * is a GET, nothing mutates between calls, and the comparison is still against
 * an INDEPENDENT derivation through lensGroups/groupIds rather than against
 * the route's own output.
 */
let bookCache: { trades: ReturnType<typeof q.getLensTrades>; batches: { id: number; fileName: string; broker: string; importedAt: string }[] } | null = null;

function book() {
  if (!bookCache) {
    bookCache = {
      trades: q.getLensTrades(),
      batches: q.getImportBatches().map((b) => ({
        id: b.id, fileName: b.fileName, broker: b.broker, importedAt: b.importedAt ?? "",
      })),
    };
  }
  return bookCache;
}

const groupsCache = new Map<string, ReturnType<typeof dom.lensGroups>>();

function lensGroupsOnce(lens: Parameters<typeof dom.lensGroups>[0]) {
  const hit = groupsCache.get(String(lens));
  if (hit) return hit;
  const { trades, batches } = book();
  const groups = dom.lensGroups(lens, trades, { batches, playbooks: [] });
  groupsCache.set(String(lens), groups);
  return groups;
}

function pageMembers(lens: Parameters<typeof dom.lensGroups>[0], key: string) {
  const { trades } = book();
  const group = lensGroupsOnce(lens).find((g) => g.key === key);
  if (!group) return null;
  const byId = new Map(trades.map((x) => [x.id, x]));
  return dom.groupIds(group, trades).map((id) => byId.get(id)!);
}

beforeAll(async () => {
  t = await openTempDb("lenses-members", { seed: true });
  route = await import("@/app/api/lenses/members/route");
  q = await import("@/lib/queries/trades");
  dom = await import("@/lib/domain/lenses");
  edge = await import("@/lib/domain/lens-edge");
  license = await import("@/lib/queries/license");

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
  t.db.insert(t.schema.importBatches).values([
    { id: 5, accountId: PRIMARY, broker: "dhan", fileName: "may.csv", rowCount: 2, status: "completed" },
  ]).run();

  // May holds three closed trades, June an open one and a closed one, so no
  // group is a singleton and no lens is a single group.
  t.db.insert(t.schema.trades).values([
    tradeRow({ accountId: PRIMARY, symbol: "TCS", tradingsymbol: "TCS", setupTag: "breakout", importBatchId: 5,
      buyDate: "2026-05-02", sellDate: "2026-05-09", netPnl: 1234.5, grossPnl: 1300, chargesTotal: 65.5,
      buyValue: 100000, sellValue: 101300, brokerage: 40, sttCtt: 18.3, gst: 7.2 }),
    tradeRow({ accountId: PRIMARY, symbol: "INFY", tradingsymbol: "INFY", broker: "zerodha", segment: "eq_mtf",
      setupTag: "fade", buyDate: "2026-05-11", sellDate: "2026-05-30", netPnl: -412.4, grossPnl: -350,
      chargesTotal: 62.4, buyValue: 80000, sellValue: 79650, brokerage: 35, sttCtt: 20.1, gst: 7.3 }),
    tradeRow({ accountId: PRIMARY, symbol: "WIPRO", tradingsymbol: "WIPRO", importBatchId: 5,
      buyDate: "2026-05-19", sellDate: "2026-05-21", netPnl: 55.55, grossPnl: 80, chargesTotal: 24.45,
      buyValue: 20000, sellValue: 20080, brokerage: 12, sttCtt: 8.4, gst: 4.05 }),
    tradeRow({ accountId: PRIMARY, symbol: "SBIN", tradingsymbol: "SBIN", broker: "groww", segment: "eq_intraday",
      buyDate: "2026-06-25", isOpen: true, netPnl: 0, grossPnl: 0, chargesTotal: 0, buyValue: 15000 }),
    tradeRow({ accountId: PRIMARY, symbol: "ITC", tradingsymbol: "ITC", broker: "zerodha", segment: "future",
      buyDate: "2026-06-01", sellDate: "2026-06-06", netPnl: 908.1, grossPnl: 950, chargesTotal: 41.9,
      buyValue: 60000, sellValue: 60950, brokerage: 25, sttCtt: 12, gst: 4.9 }),
    // Another book entirely — invariant 8 says it must never appear below.
    tradeRow({ accountId: SWING, symbol: "RELIANCE", tradingsymbol: "RELIANCE",
      buyDate: "2026-05-04", sellDate: "2026-05-15", netPnl: 777.7, grossPnl: 800, chargesTotal: 22.3,
      buyValue: 50000, sellValue: 50800, brokerage: 15, sttCtt: 5, gst: 2.3 }),
  ]).run();

  // A group big enough for the insight rules to FIRE. Every GROUP_RULE carries
  // a sample floor of 10 and the May/June rows above are three closed trades,
  // so on that group the Pro branch below would be vacuous whichever way it
  // went — `insights` is simply absent when no rule fires, exactly as it is on
  // an unlicensed copy. July 2026 is modelled on the rules' own contract
  // fixture: four long-held winners, then twelve short-held losers in an
  // unbroken run, with "breakout" and one ₹50k trade owning the losing total.
  // FIVE rules fire, so the answer has to be CAPPED to be correct.
  t.db.insert(t.schema.trades).values([
    ...Array.from({ length: 4 }, (_, i) =>
      tradeRow({ accountId: PRIMARY, symbol: "TCS", tradingsymbol: "TCS", setupTag: "trend",
        buyDate: "2026-07-01", sellDate: `2026-07-1${1 + i}`,
        netPnl: 2000, grossPnl: 3500, chargesTotal: 1500,
        buyValue: 100000, sellValue: 103500, brokerage: 900, sttCtt: 400, gst: 200 })),
    ...Array.from({ length: 12 }, (_, i) => {
      const netPnl = i === 0 ? -50000 : i <= 5 ? -3000 : -1000;
      const sym = i === 0 ? "HDFCBANK" : "TCS";
      return tradeRow({ accountId: PRIMARY, symbol: sym, tradingsymbol: sym,
        setupTag: i <= 5 ? "breakout" : i % 2 ? "reversal" : null,
        buyDate: `2026-07-${String(15 + i).padStart(2, "0")}`,
        sellDate: `2026-07-${String(17 + i).padStart(2, "0")}`,
        netPnl, grossPnl: netPnl + 1500, chargesTotal: 1500,
        buyValue: 100000, sellValue: 100000 + netPnl + 1500,
        brokerage: 900, sttCtt: 400, gst: 200 });
    }),
  ]).run();

  selectAccount(PRIMARY);
});

afterAll(() => t?.cleanup());

describe("it refuses what it cannot resolve", () => {
  it("400s on a lens that is not one of the six", async () => {
    expect((await get("?lens=weather&key=month:2026-05")).status).toBe(400);
    expect((await get("?key=month:2026-05")).status).toBe(400);
    expect((await get("?lens=month")).status).toBe(400);
  });

  it("404s on a group key that is not in this book — never an empty success", async () => {
    // An empty 200 would render as "this group has no trades", which is a
    // statement about the user's record rather than about a stale key.
    const res = await get("?lens=month&key=month:1999-01");
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

describe("the members are the page's own array", () => {
  it("every group of every lens returns exactly what the page path resolves, in order", async () => {
    for (const lens of dom.LENSES) {
      const groups = lensGroupsOnce(lens.kind);
      expect(groups.length, `${lens.kind} produced no groups`).toBeGreaterThan(0);

      for (const g of groups) {
        const res = await get(`?lens=${lens.kind}&key=${encodeURIComponent(g.key)}`);
        expect(res.status, `${g.key}`).toBe(200);
        const wanted = pageMembers(lens.kind, g.key)!;
        expect(
          res.body.members.map((m: { id: number }) => m.id),
          `${lens.kind}/${g.key} returned a different set or a different order`,
        ).toEqual(wanted.map((m) => m.id));
        // The count the group row shows is the count the drill-down holds.
        expect(res.body.members).toHaveLength(g.count);
      }
    }
  }, 60_000); // every group of six lenses, one awaited route call each — CI runners are slower than this machine

  it("ships the 19-column projection, not the whole row", async () => {
    const res = await get("?lens=month&key=month:2026-05");
    const keys = Object.keys(res.body.members[0]).sort();
    expect(keys).toEqual(Object.keys(pageMembers("month", "month:2026-05")![0]).sort());
    // The columns the projection exists to leave behind.
    for (const dropped of ["notes", "mistakeTags", "strike", "dedupHash", "reviewedAt"]) {
      expect(keys, `${dropped} is back on the drill-down wire`).not.toContain(dropped);
    }
  });

  it("charge heads are aggregated over the SAME rows, closed only", async () => {
    const res = await get("?lens=month&key=month:2026-05");
    const ids = new Set(pageMembers("month", "month:2026-05")!.map((m) => m.id));
    const rows = q.getLensChargeRows().filter((c) => ids.has(c.id));
    expect(res.body.chargeHeads).toEqual(edge.lensChargeHeads(rows));
    expect(res.body.chargeHeads.total).toBeGreaterThan(0);
  });

  // The paywall, both ways round. What this replaces was one branch on
  // `getEntitlement().pro` whose Pro side read
  // `expect(res.body.insights?.length ?? 0).toBeLessThanOrEqual(CAP)` — and
  // `undefined?.length ?? 0` is 0, so `0 <= 3` passed for EVERY response,
  // including one carrying no `insights` key at all. The else side was dead
  // code: a seeded temp DB ships trial_started_at NULL, getEntitlement()
  // stamps it on first read, and the copy is therefore on trial.
  it("a Pro copy is sent insights, and the allow-list caps them", async () => {
    expect(license.getEntitlement().pro, "a seeded temp DB is on trial — this must be the Pro branch").toBe(true);
    const res = await get("?lens=month&key=month:2026-07");
    expect("insights" in res.body, "the route stopped sending insights at all").toBe(true);
    expect(Array.isArray(res.body.insights)).toBe(true);
    expect(res.body.insights.length).toBeGreaterThanOrEqual(1);
    expect(res.body.insights.length).toBeLessThanOrEqual(edge.GROUP_INSIGHT_CAP);
    // Five GROUP_RULES fire on this group, so the cap is what trims the answer:
    // a route that assembled `insights` itself instead of going through
    // toLensRow would hand the drill-down all five.
    expect(res.body.insights.length).toBe(edge.GROUP_INSIGHT_CAP);
  });

  it("an unlicensed copy is sent no insights key at all — and its journal is untouched", async () => {
    const before = t.db.select({ t: t.schema.settings.trialStartedAt }).from(t.schema.settings).get();
    try {
      // No key, and a trial that started long before TRIAL_DAYS ago. This is
      // the only way to reach the unlicensed branch in this file.
      t.db.update(t.schema.settings).set({ licenseKey: null, trialStartedAt: "2020-01-01T00:00:00.000Z" }).run();
      expect(license.getEntitlement().pro).toBe(false);

      const res = await get("?lens=month&key=month:2026-07");
      expect(res.status).toBe(200);
      expect("insights" in res.body, "an unlicensed copy was sent insights").toBe(false);
      // Invariant 7 — the record itself is never gated, only the reading of it.
      expect(res.body.members).toHaveLength(16);
      expect(res.body.chargeHeads.total).toBeGreaterThan(0);
    } finally {
      t.db.update(t.schema.settings).set({ trialStartedAt: before?.t ?? null }).run();
    }
  });
});

describe("the account boundary holds (invariant 8)", () => {
  it("a group resolves inside the selected account, and the other book is invisible", async () => {
    selectAccount(PRIMARY);
    const primary = await get("?lens=month&key=month:2026-05");
    expect(primary.body.members.map((m: { symbol: string }) => m.symbol)).not.toContain("RELIANCE");

    selectAccount(SWING);
    const swing = await get("?lens=month&key=month:2026-05");
    expect(swing.body.members.map((m: { symbol: string }) => m.symbol)).toEqual(["RELIANCE"]);
    // …and the aggregate view sees both books at once, as everywhere else.
    selectAccount(0);
    const all = await get("?lens=month&key=month:2026-05");
    expect(all.body.members).toHaveLength(4);

    selectAccount(PRIMARY);
  });
});
