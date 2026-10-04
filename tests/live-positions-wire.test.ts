import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { todayIstIso } from "@/lib/domain/trading-day";
import { isoMinusDays } from "@/lib/live/positions-view";
import type { LiveDeskData } from "@/components/live/desk-types";

/**
 * v4.7.0 wave C4 — builder A's WIRE, against a real (temp) database.
 *
 * Builder B renders the Positions tab from what `loadLiveDesk` ships, so the
 * shapes below are a contract. Four things here are expensive to get wrong
 * and invisible on screen:
 *
 *  1. THE FREE WIRE. `sizing` (capital + risk %) and `positions.capitalP` are
 *     PRO (D10/D5): a free payload must carry neither number, exactly as it
 *     carries no `pctOfCapital` (invariant 7 — hiding a cell is not gating).
 *  2. PARTIAL BOOKING on a SHORT (D6): a cover below the sale is a GAIN.
 *  3. THE INDUSTRY COHORT (D4): a user tag is sector-only, so `industry` is null
 *     and the row falls UP; a bundled-universe symbol carries its industry.
 *  4. `/trades?trade=<id>` (D12) is ACCOUNT-SCOPED (invariant 8): an id outside
 *     the selected account is NOT opened, and the page says so.
 *
 * Plus the one-line route change: `POST /api/positions/risk` revalidates `/live`.
 *
 * ONE temp database for the file (AGENTS.md Testing): `lib/db` caches its
 * connection on globalThis, and every module that reaches it is imported
 * DYNAMICALLY after `openTempDb` sets `VYUHA_DB_PATH`.
 */

const cache = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    cache.paths.push(p);
  },
  revalidateTag: () => {},
  unstable_cache: (fn: unknown) => fn,
}));

let t: TempDb;
let live: typeof import("@/components/live/load-desk");
let riskRoute: typeof import("@/app/api/positions/risk/route");
let tradesPage: (props: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;

const PRIMARY = 1;
const SWING = 2;
const TODAY = todayIstIso();

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

// Measured locally 2026-10-04: migrate + seed + the three dynamic imports
// (app/trades/page's client graph is the bulk) + one warm render ≈ 4.3 s —
// the same figure tests/dashboard-aggregate-db.test.ts records for app/page;
// every `it` is under 100 ms. 120 s is for the
// Windows CI runner (> 15× slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("live-positions-wire", { seed: true });
  live = await import("@/components/live/load-desk");
  riskRoute = await import("@/app/api/positions/risk/route");
  tradesPage = (await import("@/app/trades/page")).default as typeof tradesPage;

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
  t.db.update(t.schema.settings).set({ equityCapital: 1_000_000, selectedAccountId: 0 }).run();
  t.db.update(t.schema.riskConfig).set({ riskPctPpm: 10_000, stopAtrMultPermille: 2000 }).run();

  // A user's own sector tag — sector-level only (D4).
  t.db.insert(t.schema.instruments).values({ symbol: "ZZTAG", sector: "My Own Bucket" }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        id: 201, accountId: PRIMARY, symbol: "TCS", tradingsymbol: "TCS", isin: "INE467B01029", isOpen: true,
        buyQty: 10, avgBuyPrice: 3000, buyValue: 30_000, buyDate: "2026-08-01", slPlanned: 2800, trailingSl: 2900, targetPlanned: 3400,
      }),
      // A SHORT, partially covered: sold 100 @ ₹500, bought back 40 @ ₹450.
      tradeRow({
        id: 202, accountId: SWING, symbol: "ZZTAG", tradingsymbol: "ZZTAG", isOpen: true, segment: "eq_intraday",
        sellQty: 100, avgSellPrice: 500, sellValue: 50_000, buyQty: 40, avgBuyPrice: 450, buyValue: 18_000,
        sellDate: "2026-09-01", buyDate: "2026-09-02",
      }),
      // A derivative with a STORED expiry.
      tradeRow({
        id: 203, accountId: PRIMARY, symbol: "NIFTY", tradingsymbol: "NIFTY26DEC24000CE", isOpen: true,
        segment: "index_option", instrumentType: "option", exchange: "NFO", bucket: "active",
        buyQty: 75, avgBuyPrice: 100, buyValue: 7_500, buyDate: "2026-09-10", expiry: "2026-12-29", lotSize: 75,
      }),
    ])
    .run();

  t.db
    .insert(t.schema.priceHistory)
    .values([
      { symbol: "TCS", date: "2026-09-01", open: 2980, high: 3010, low: 2970, close: 3005, volume: 1000 },
      { symbol: "TCS", date: "2026-09-02", open: 3005, high: 3080, low: 3000, close: 3060, volume: 1200 },
      { symbol: "TCS", date: TODAY, open: 3060, high: 3120, low: 3050, close: 3100, volume: 900 },
    ])
    .run();

  t.db
    .insert(t.schema.corporateActions)
    .values([
      { symbol: "TCS", type: "bonus", exDate: isoMinusDays(TODAY, 10), fromUnits: 1, toUnits: 1 },
      { symbol: "TCS", type: "split", exDate: isoMinusDays(TODAY, 45), fromUnits: 1, toUnits: 2 },
      { symbol: "TCS", type: "dividend", exDate: isoMinusDays(TODAY, 5), dividendPerShare: 10 },
    ])
    .run();

  // Warm /trades once: its FIRST render pays ~0.5 s of one-off module/statement
  // work, which would otherwise land on whichever `it` happens to run first.
  await tradesPage({ searchParams: Promise.resolve({}) });
}, 120_000);

afterAll(() => t?.cleanup());

const rowOf = (d: LiveDeskData, id: number) => {
  const r = d.rows.find((x) => x.id === id);
  if (!r) throw new Error(`row ${id} missing from the desk`);
  return r;
};

describe("the Positions wire — Pro vs free", () => {
  it("Pro: sizing carries the bucket capital and the risk %; positions carries the settings and capital", async () => {
    selectAccount(0);
    const d = await live.loadLiveDesk({ pro: true });
    const tcs = rowOf(d, 201);
    expect(tcs.sizing).toEqual({ capitalP: 100_000_000, riskPpm: 10_000 });
    // The header's % of capital uses the heat strip's own denominator (total capital).
    expect(d.positions.capitalP).toBeGreaterThan(0);
    expect(d.positions.capitalP).toBe(d.heat?.capitalP);
    expect(d.positions.deployCapPpm).toBe(250_000);
    expect(d.positions.atrMultPermille).toBe(2000);
  });

  it("FREE: no sizing object and no capital anywhere on the Positions wire", async () => {
    selectAccount(0);
    const d = await live.loadLiveDesk({ pro: false });
    for (const r of d.rows) expect(r.sizing, `row ${r.id} shipped the calculator's capital on a free wire`).toBeNull();
    expect(d.positions.capitalP, "capital reached the free wire").toBeNull();
    const payload = JSON.stringify(d);
    expect(payload).not.toContain('"sizing":{');
    expect(payload).not.toContain("riskBudgetP");
    expect(payload).not.toContain('"kind":"ok"');
    // The free FACTS still ride: settings, levels, partials, chips.
    expect(d.positions.atrMultPermille).toBe(2000);
    expect(rowOf(d, 202).partial).not.toBeNull();
  });
});

describe("the Positions wire — row facts", () => {
  it("D6: a partially covered SHORT books a GAIN when it covered below the sale (before charges)", async () => {
    selectAccount(0);
    const d = await live.loadLiveDesk({ pro: false });
    expect(rowOf(d, 202).side).toBe("short");
    expect(rowOf(d, 202).partial).toEqual({ bookedPpm: 400_000, closedQty: 40, realisedGrossP: 200_000 });
    expect(rowOf(d, 201).partial).toBeNull();
  });

  it("D4: a user tag is sector-only (industry null → falls up); a bundled-universe symbol carries its industry", async () => {
    selectAccount(0);
    const d = await live.loadLiveDesk({ pro: false });
    const tag = rowOf(d, 202);
    expect(tag.classSource).toBe("user");
    expect(tag.sectorName).toBe("My Own Bucket");
    expect(tag.industry).toBeNull();
    const tcs = rowOf(d, 201);
    expect(tcs.classSource).toBe("taxonomy");
    expect(typeof tcs.industry).toBe("string");
    expect(tcs.industry!.length).toBeGreaterThan(0);
    expect(typeof tcs.sectorName).toBe("string");
  });

  it("P7 / P5 / D8 / D11: previous close, corporate-action chips, stored expiry and both stop levels", async () => {
    selectAccount(0);
    const d = await live.loadLiveDesk({ pro: false });
    const tcs = rowOf(d, 201);
    expect(tcs.prevCloseP, "today's own bar is not the previous close").toBe(306_000);
    expect(tcs.corpActions).toEqual([{ type: "bonus", exDate: isoMinusDays(TODAY, 10), fromUnits: 1, toUnits: 1 }]);
    expect(tcs.expiry).toBeNull();
    expect(tcs.slPlannedP).toBe(280_000);
    expect(tcs.trailingSlP).toBe(290_000);
    expect(tcs.effectiveStopP).toBe(290_000);
    expect(rowOf(d, 203).expiry).toBe("2026-12-29");
    expect(rowOf(d, 202).prevCloseP).toBeNull();
    expect(rowOf(d, 202).corpActions).toEqual([]);
  });
});

describe("POST /api/positions/risk revalidates /live (D11)", () => {
  it("a levels-only save writes the levels and revalidates the desk", async () => {
    cache.paths.length = 0;
    const res = await riskRoute.POST(
      new Request("http://localhost/api/positions/risk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tradeId: 201, originalSl: "2800", trailingSl: "2950", target: "3400" }),
      }),
    );
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(cache.paths).toContain("/live");
    expect(cache.paths).toEqual(expect.arrayContaining(["/risk", "/trades"]));
    const row = t.db.select().from(t.schema.trades).all().find((r) => r.id === 201)!;
    expect(row.trailingSl).toBe(2950);
  });
});

describe("RiskEditDialog, extracted (D11): /risk behaves as before", () => {
  it("/risk passes `invested` and `mark`, so it keeps the MTM / IV fields and the five-key body", async () => {
    const { readFileSync } = await import("node:fs");
    const cockpit = readFileSync("components/risk/risk-cockpit-client.tsx", "utf8");
    const dialog = readFileSync("components/risk/risk-edit-dialog.tsx", "utf8");
    expect(cockpit).toContain('import { RiskEditDialog } from "@/components/risk/risk-edit-dialog"');
    expect(cockpit, "the cockpit grew a second copy of the editor").not.toMatch(/function RiskEditDialog/);
    expect(cockpit).toMatch(/invested=\{editing\.invested\}/);
    expect(cockpit).toMatch(/mark=\{\{\s*mtm:\s*editing\.mtm,\s*impliedVol:\s*editing\.impliedVol,\s*optionType:\s*editing\.optionType\s*\}\}/);
    // The KEY SETS the dialog may post (C4 fix wave: `changedFields` then posts only the
    // keys the user changed, and an untouched save posts nothing — tests/v47-c4-fixes.test.ts).
    expect(dialog).toContain("{ tradeId, originalSl, trailingSl, target, mtmPrice, impliedVol }");
    expect(dialog).toContain(": { tradeId, originalSl, trailingSl, target }");
  });
});

type El = { type: unknown; props: Record<string, unknown> };
function findEl(node: unknown, match: (e: El) => boolean): El | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as El;
  if (match(el)) return el;
  return findEl(el.props.children, match);
}

const clientOf = (tree: unknown) => {
  const el = findEl(tree, (e) => "initialRows" in e.props && "initialFilters" in e.props);
  if (!el) throw new Error("TradesClient not found in the /trades tree");
  return el.props as { initialOpenTrade: { id: number; staged: boolean } | null };
};
const refusal = (tree: unknown) => findEl(tree, (e) => e.props["data-trade-link"] === "refused");

describe("/trades?trade=<id> is account-scoped (D12, invariant 8)", () => {
  it("a trade in ANOTHER account is not opened, and the page says so", async () => {
    selectAccount(PRIMARY);
    const tree = await tradesPage({ searchParams: Promise.resolve({ trade: "202" }) });
    expect(clientOf(tree).initialOpenTrade, "a SWING trade opened under the PRIMARY account").toBeNull();
    expect(refusal(tree)).toBeDefined();
  });

  it("the selected account's own trade opens; the aggregate view opens any", async () => {
    selectAccount(SWING);
    let tree = await tradesPage({ searchParams: Promise.resolve({ trade: "202" }) });
    expect(clientOf(tree).initialOpenTrade?.id).toBe(202);
    expect(refusal(tree)).toBeUndefined();
    selectAccount(0);
    tree = await tradesPage({ searchParams: Promise.resolve({ trade: "201" }) });
    expect(clientOf(tree).initialOpenTrade?.id).toBe(201);
  });

  it("a malformed id is ignored outright — nothing opened, nothing refused", async () => {
    selectAccount(0);
    for (const bad of ["0", "-3", "1.5", "abc", "1e3"]) {
      const tree = await tradesPage({ searchParams: Promise.resolve({ trade: bad }) });
      expect(clientOf(tree).initialOpenTrade, bad).toBeNull();
      expect(refusal(tree), bad).toBeUndefined();
    }
  });

  it("the URL contract: `trade` parses to a positive integer, serializes canonically, round-trips", async () => {
    const { parseTradesQuery, serializeTradesQuery, EMPTY_TRADES_QUERY } = await import("@/lib/domain/trades-query");
    expect(parseTradesQuery("?trade=202").trade).toBe(202);
    expect(parseTradesQuery("?trade=202&symbol=TCS")).toEqual({ ...EMPTY_TRADES_QUERY, trade: 202, symbol: "TCS" });
    for (const bad of ["0", "-1", "1.0", "0x10", "1e2", " ", "99999999999999999999"]) expect(parseTradesQuery(`?trade=${bad}`).trade, bad).toBeNull();
    expect(serializeTradesQuery({ trade: 202, view: "open" })).toBe("?trade=202&view=open");
    expect(parseTradesQuery(serializeTradesQuery({ trade: 7 })).trade).toBe(7);
  });

  it("the client seeds the dialogs from `initialOpenTrade` as INITIAL STATE — never a set-state-in-effect", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/trades/trades-client.tsx", "utf8");
    expect(src).toMatch(/useState<Trade \| null>\(initialOpenTrade\)/);
    expect(src).toMatch(/useState<Trade \| null>\(initialOpenTrade\?\.staged \? initialOpenTrade : null\)/);
    expect(src, "the deep link must not be applied by a state sync").not.toMatch(/setFullEditing\(\s*initialOpenTrade/);
  });

  it("an id that exists nowhere is refused in one line, never a crash", async () => {
    selectAccount(0);
    const tree = await tradesPage({ searchParams: Promise.resolve({ trade: "999999" }) });
    expect(clientOf(tree).initialOpenTrade).toBeNull();
    expect(refusal(tree)).toBeDefined();
  });
});
