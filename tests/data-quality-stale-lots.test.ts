import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  assessDataQuality,
  hasRecordedBasis,
  staleOpenPairs,
  staleSaleRows,
  type QualityInputs,
  type QualityTrade,
} from "@/lib/analytics/data-quality";
import { computeCharges } from "@/lib/engine/charges";
import { findRates } from "@/lib/engine/rates";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * R26 (v4.3.0) — Data Quality lists the stale open rows and closes them with
 * the sale the book already stored (owner ruling R10 half b, 06-ANSWERS:224;
 * with auto-close OFF, 06-ANSWERS:353, it is the only remedy).
 *
 * v4.2.0 stored a SELL of a held lot as its own row: an open, sell-only row
 * beside the long it actually closed, and for a Dhan /positions pull with
 * `sell_date` NULL. The pure half pairs such a row with the lot; the DB half
 * drives the real route handler and the real `closeStaleLot`.
 *
 * ONE temp database per FILE (AGENTS.md): `lib/db` caches its connection on
 * globalThis, so the DB cases run one after another on it, each in its own
 * account with its own symbol.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// StaleLotFix calls `useRouter`, which needs a mounted app router: a framework stub.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

// ─────────────────────────────── the pure half ──────────────────────────────

let seq = 0;
const q = (p: Partial<QualityTrade> = {}): QualityTrade => ({
  id: ++seq,
  isOpen: true,
  acquisition: null,
  acquisitionPrice: null,
  closingPrice: null,
  slPlanned: 1,
  riskAmount: 1,
  segment: "eq_delivery",
  mtfFundedAmount: null,
  instrumentType: "equity",
  expiry: null,
  strike: null,
  optionType: null,
  symbol: "MARKSANS",
  tradingsymbol: "MARKSANS",
  accountId: 1,
  broker: "dhan",
  exchange: "NSE",
  buyQty: 0,
  sellQty: 0,
  avgBuyPrice: 0,
  avgSellPrice: 0,
  buyDate: null,
  sellDate: null,
  createdAt: "2026-08-20 04:00:00",
  staged: false,
  ...p,
});

/** An open long: BUY 100 @ 200 on 2026-08-20. */
const lot = (p: Partial<QualityTrade> = {}) => q({ buyQty: 100, avgBuyPrice: 200, buyDate: "2026-08-20", ...p });
/**
 * v4.2.0's Dhan /positions sale: sell-only, open, `sell_date` NULL, pulled at
 * 00:30 IST on 2026-08-28 — which is still 2026-08-27 in UTC, the clock
 * SQLite's `datetime('now')` keeps.
 */
const sale = (p: Partial<QualityTrade> = {}) =>
  q({ sellQty: 100, avgSellPrice: 250, sellDate: null, createdAt: "2026-08-27 19:00:00", ...p });

const inputs = (trades: QualityTrade[]): QualityInputs => ({
  trades,
  markedTradeIds: new Set(trades.map((t) => t.id)),
  knownSymbols: new Set(trades.map((t) => t.symbol.toUpperCase())),
  ipoLinkedTradeIds: new Set(),
  staleMtmCount: 0,
  missingAttachmentFiles: 0,
});

const staleIssues = (trades: QualityTrade[]) => assessDataQuality(inputs(trades)).issues.filter((i) => i.code === "stale_open");

describe("staleOpenPairs + the stale_open issue (pure)", () => {
  it("MARKSANS BUY 100 open + a sell-only 100 with no date: one critical issue on the lot, one-click", () => {
    const L = lot();
    const S = sale();
    const issues = staleIssues([L, S]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "critical", count: 1, href: "/data-quality#stale-open", ids: [L.id] });

    expect(staleOpenPairs([L, S])).toEqual([
      expect.objectContaining({
        lotId: L.id,
        saleId: S.id,
        side: "long",
        lotQty: 100,
        saleQty: 100,
        salePrice: 250,
        // The IST day of the pull, not the UTC one — and flagged as derived.
        saleDate: "2026-08-28",
        saleDateStated: false,
        oneClick: true,
      }),
    ]);
  });

  it("a basis-unknown sale (M-3's Dhan shape) pairs the same way — the lot IS its basis", () => {
    const L = lot();
    const S = sale({ acquisition: "unknown", sellDate: "2026-08-28" });
    expect(staleOpenPairs([L, S]).map((p) => [p.lotId, p.saleId, p.saleDateStated, p.oneClick])).toEqual([[L.id, S.id, true, true]]);
  });

  it("a same-day pair is listed ONCE — the sale is never also read as a short the buy covered", () => {
    const L = lot({ buyDate: "2026-08-28" });
    const S = sale({ sellDate: "2026-08-28" });
    expect(staleOpenPairs([L, S])).toHaveLength(1);
    expect(staleIssues([L, S])[0].ids).toEqual([L.id]);

    // The same on a derivative, where a sell-only row CAN be a genuine short:
    // each row takes one role, so the pair still appears once, read forward.
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const fBuy = lot({ ...F, buyDate: "2026-08-28" });
    const fSell = sale({ ...F, sellDate: "2026-08-28" });
    expect(staleOpenPairs([fBuy, fSell]).map((p) => [p.lotId, p.saleId, p.side])).toEqual([[fBuy.id, fSell.id, "long"]]);
  });

  it("another account's sale pairs with nothing", () => {
    expect(staleIssues([lot({ accountId: 1 }), sale({ accountId: 2 })])).toEqual([]);
  });

  it("a sale dated BEFORE the buy pairs with nothing (and a delivery sale is never a short)", () => {
    const L = lot({ buyDate: "2026-08-20" });
    const S = sale({ sellDate: "2026-08-10" });
    expect(staleOpenPairs([L, S])).toEqual([]);
    expect(staleIssues([L, S])).toEqual([]);
  });

  it("SELL 40 against 100 open is listed, with no one-click", () => {
    const L = lot();
    const S = sale({ sellQty: 40 });
    const [p] = staleOpenPairs([L, S]);
    expect([p.lotId, p.saleId, p.lotQty, p.saleQty, p.oneClick]).toEqual([L.id, S.id, 100, 40, false]);
    expect(staleIssues([L, S])[0].ids).toEqual([L.id]);
  });

  it("an eq_mtf lot is listed (the remedy prices MTF interest from the confirmed date)", () => {
    const L = lot({ segment: "eq_mtf" });
    const S = sale({ segment: "eq_mtf" });
    expect(staleOpenPairs([L, S]).map((p) => [p.lotId, p.oneClick])).toEqual([[L.id, true]]);
  });

  it("another broker or another exchange never pairs", () => {
    // RE-PINNED (W2-FIXD2, seam defect D2): this line asserted that a staged lot
    // never pairs — measured before: []; after: one listed pair, never
    // one-click. The decided P1/P2 rule lists EVERY open lot with a later sale
    // row in its book; the staged cases live in their own describe below.
    expect(staleOpenPairs([lot({ staged: true }), sale()]).map((p) => [p.staged, p.oneClick])).toEqual([[true, false]]);
    expect(staleOpenPairs([lot(), sale({ broker: "zerodha" })])).toEqual([]);
    expect(staleOpenPairs([lot(), sale({ exchange: "BSE" })])).toEqual([]);
  });

  it("rows without the identity fields (an older caller) are skipped, not guessed at", () => {
    const bare = (p: Partial<QualityTrade>): QualityTrade => {
      const r = q(p) as Partial<QualityTrade>;
      delete r.accountId;
      delete r.tradingsymbol;
      return r as QualityTrade;
    };
    expect(staleIssues([bare({ buyQty: 100, buyDate: "2026-08-20" }), bare({ sellQty: 100, sellDate: "2026-08-28" })])).toEqual([]);
  });
});

describe("W2-FIXD2 (seam D2) — a staged lot is listed against its sale, and never offered the one-step join (pure)", () => {
  it("a holding bought in two fills on one day (ONE staged row of 100) + a sale of 100: listed for all 100, no one-click", () => {
    const L = lot({ staged: true, buyDate: "2026-09-07" });
    const S = sale({ acquisition: "unknown", sellDate: "2026-09-08" });
    const pairs = staleOpenPairs([L, S]);
    expect(pairs.map((p) => [p.lotId, p.saleId, p.lotQty, p.matchedQty, p.staged, p.oneClick])).toEqual([[L.id, S.id, 100, 100, true, false]]);
    expect(staleIssues([L, S])[0].ids, "the critical stale_open issue counts it").toEqual([L.id]);
    // Listed as a PAIR, so the sale is not also a stale_sale warning.
    expect(saleIssues([L, S])).toEqual([]);
  });

  it("a staged short (a contract sold in two fills) is listed the same way, never one-click", () => {
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const short = q({ ...F, staged: true, sellQty: 50, avgSellPrice: 100, sellDate: "2026-09-01" });
    const cover = q({ ...F, buyQty: 50, avgBuyPrice: 90, buyDate: "2026-09-03" });
    expect(staleOpenPairs([short, cover]).map((p) => [p.lotId, p.side, p.matchedQty, p.staged, p.oneClick])).toEqual([[short.id, "short", 50, true, false]]);
  });
});

// ─────────── W2-DQ P1 / P2 / P3 (v4.3.0 fix wave 2) — the pure half ─────────

const saleIssues = (trades: QualityTrade[]) => assessDataQuality(inputs(trades)).issues.filter((i) => i.code === "stale_sale");

describe("W2-DQ P1 — sales are allocated to lots oldest lot first, and every lot a sale reaches is listed", () => {
  it("L1 100 (09-01) + L2 100 (09-02) + one SELL 200 (09-05): BOTH lots listed, neither one-click", () => {
    const L1 = lot({ buyDate: "2026-09-01" });
    const L2 = lot({ buyDate: "2026-09-02" });
    const S = sale({ sellQty: 200, sellDate: "2026-09-05" });
    expect(staleOpenPairs([L1, L2, S]).map((p) => [p.lotId, p.saleId, p.lotQty, p.saleQty, p.oneClick])).toEqual([
      [L1.id, S.id, 100, 200, false],
      [L2.id, S.id, 100, 200, false],
    ]);
    expect(staleOpenPairs([L1, L2, S]).map((p) => p.matchedQty), "the sale's excess carries to the next lot").toEqual([100, 100]);
    const [issue] = staleIssues([L1, L2, S]);
    expect([issue.count, issue.ids]).toEqual([2, [L1.id, L2.id]]);
  });

  it("whole sale rows covering whole lots exactly stay one-click, each with its own lot (FIFO)", () => {
    const L1 = lot({ buyDate: "2026-09-01" });
    const L2 = lot({ buyDate: "2026-09-02" });
    const S1 = sale({ sellDate: "2026-09-05" });
    const S2 = sale({ sellDate: "2026-09-06" });
    expect(staleOpenPairs([S2, L2, S1, L1]).map((p) => [p.lotId, p.saleId, p.matchedQty, p.oneClick])).toEqual([
      [L1.id, S1.id, 100, true],
      [L2.id, S2.id, 100, true],
    ]);
  });

  it("a lot covered by PART of a sale is listed without the button, and so is the lot that took the rest", () => {
    const L1 = lot({ buyDate: "2026-09-01" });
    const L2 = lot({ buyQty: 50, buyDate: "2026-09-02" });
    const S = sale({ sellQty: 150, sellDate: "2026-09-05" });
    expect(staleOpenPairs([L1, L2, S]).map((p) => [p.lotId, p.lotQty, p.matchedQty, p.oneClick])).toEqual([
      [L1.id, 100, 100, false],
      [L2.id, 50, 50, false],
    ]);
  });

  it("a sale is never allocated to a lot dated after it, and a lot no sale reaches is a holding, not listed", () => {
    const L1 = lot({ buyDate: "2026-09-01" });
    const later = lot({ buyDate: "2026-09-06" });
    const S = sale({ sellQty: 200, sellDate: "2026-09-05" });
    expect(staleOpenPairs([L1, later, S]).map((p) => [p.lotId, p.matchedQty])).toEqual([[L1.id, 100]]);

    const held = lot({ buyDate: "2026-09-02" });
    const S100 = sale({ sellDate: "2026-09-05" });
    expect(staleOpenPairs([L1, held, S100]).map((p) => [p.lotId, p.saleId, p.oneClick])).toEqual([[L1.id, S100.id, true]]);
    expect(staleIssues([L1, held, S100])[0].ids).toEqual([L1.id]);
  });
});

describe("W2-DQ P3 — a sale whose basis the user recorded is never a stale-close candidate", () => {
  it("a CLOSED ESOP sale at 50 beside a held market lot: no pair, no stale_open (was a CRITICAL one-click)", () => {
    const L = lot({ buyDate: "2026-08-01" });
    const S = sale({ isOpen: false, acquisition: "esop", acquisitionPrice: 50, sellDate: "2026-08-15" });
    expect(staleOpenPairs([L, S]).map((p) => [p.lotId, p.saleId, p.lotQty, p.saleQty, p.oneClick])).toEqual([]);
    expect(staleIssues([L, S])).toEqual([]);
    // It is not a stale sale either: it is closed, and its basis is the user's.
    expect(saleIssues([L, S])).toEqual([]);
  });

  it("either half of a recorded basis is enough; 'unknown' with no price is not a recorded basis", () => {
    expect(hasRecordedBasis({ acquisition: "esop", acquisitionPrice: null })).toBe(true);
    expect(hasRecordedBasis({ acquisition: "unknown", acquisitionPrice: 50 })).toBe(true);
    expect(hasRecordedBasis({ acquisition: "unknown", acquisitionPrice: null })).toBe(false);
    expect(hasRecordedBasis({ acquisition: null, acquisitionPrice: 0 })).toBe(false);
    const L = lot({ buyDate: "2026-08-01" });
    expect(staleOpenPairs([L, sale({ acquisition: "gift", sellDate: "2026-08-15" })])).toEqual([]);
    expect(staleOpenPairs([L, sale({ acquisition: "unknown", acquisitionPrice: 50, sellDate: "2026-08-15" })])).toEqual([]);
  });

  it("the short pass reads the same rule: a purchase with a recorded basis never covers a short", () => {
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const short = q({ ...F, sellQty: 50, avgSellPrice: 100, sellDate: "2026-09-01" });
    const cover = q({ ...F, buyQty: 50, avgBuyPrice: 90, buyDate: "2026-09-03" });
    expect(staleOpenPairs([short, cover]).map((p) => [p.lotId, p.side])).toEqual([[short.id, "short"]]);
    expect(staleOpenPairs([short, { ...cover, acquisitionPrice: 90 }])).toEqual([]);
  });
});

describe("W2-DQ P2 — a closing-trade row left open after its position closed is a WARNING (pure)", () => {
  it("delivery: sales 40 + 60 beside a CLOSED lot 100 entered before them are listed; nothing is stale_open", () => {
    const L = lot({ isOpen: false, sellQty: 100, avgSellPrice: 250, buyDate: "2026-08-20", sellDate: "2026-08-28" });
    const S40 = sale({ sellQty: 40, sellDate: "2026-08-28" });
    const S60 = sale({ sellQty: 60, sellDate: "2026-08-29" });
    const report = assessDataQuality(inputs([L, S40, S60]));
    expect(report.issues.filter((i) => i.code === "stale_open")).toEqual([]);
    const [issue] = report.issues.filter((i) => i.code === "stale_sale");
    expect(issue).toMatchObject({ severity: "warning", count: 2, href: "/data-quality#stale-open", ids: [S40.id, S60.id] });
    expect(`${issue.title} ${issue.detail}`).not.toMatch(/\b(delete|should|must|recommend|consider|suggest)\b/i);
    expect(staleSaleRows([L, S40, S60]).map((s) => [s.saleId, s.side, s.saleQty, s.closedLotIds])).toEqual([
      [S40.id, "long", 40, [L.id]],
      [S60.id, "long", 60, [L.id]],
    ]);
  });

  it("narrow: no closed lot, a closed lot entered AFTER the sale, a sale still paired, or a recorded basis — no warning", () => {
    const S = sale({ sellDate: "2026-08-28" });
    expect(saleIssues([q({ symbol: "OTHER", tradingsymbol: "OTHER" }), S])).toEqual([]);
    const closedLater = lot({ isOpen: false, sellQty: 100, buyDate: "2026-09-01", sellDate: "2026-09-02" });
    expect(saleIssues([closedLater, S])).toEqual([]);
    const closed = lot({ isOpen: false, sellQty: 100, buyDate: "2026-08-01", sellDate: "2026-08-02" });
    const open = lot({ buyDate: "2026-08-20" });
    expect(saleIssues([closed, open, S]), "an open lot still pairs it: stale_open's job").toEqual([]);
    expect(saleIssues([closed, sale({ acquisition: "esop", sellDate: "2026-08-28" })])).toEqual([]);
  });

  it("mirrored for a short, and never in a segment that cannot hold a short", () => {
    const F = { segment: "future", instrumentType: "future", symbol: "NIFTY", tradingsymbol: "NIFTY26SEPFUT" };
    const coveredShort = q({ ...F, isOpen: false, sellQty: 50, buyQty: 50, sellDate: "2026-09-01", buyDate: "2026-09-02" });
    const purchase = q({ ...F, buyQty: 50, avgBuyPrice: 90, buyDate: "2026-09-03" });
    expect(staleSaleRows([coveredShort, purchase]).map((s) => [s.saleId, s.side, s.closedLotIds])).toEqual([
      [purchase.id, "short", [coveredShort.id]],
    ]);
    // Delivery: a closed round trip then a new buy is a holding, never a purchase against a short.
    const roundTrip = lot({ isOpen: false, sellQty: 100, buyDate: "2026-09-01", sellDate: "2026-09-01" });
    expect(staleSaleRows([roundTrip, lot({ buyDate: "2026-09-03" })])).toEqual([]);
  });
});

// ──────────────────────────────── the DB half ───────────────────────────────

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let route: typeof import("@/app/api/data-quality/close-stale/route");
let dq: typeof import("@/lib/queries/data-quality");
let trash: typeof import("@/lib/trash");
let identity: typeof import("@/lib/import/broker-identity");
let ratesDb: typeof import("@/lib/engine/rates-db");
let StaleLotFix: typeof import("@/components/quality/stale-lot-fix").StaleLotFix;

const r2 = (n: number) => Math.round(n * 100) / 100;

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "dhan",
    isin: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    grossPnl: 0,
    unrealisedPnl: 0,
    buyDate: null,
    sellDate: null,
    productHint: "delivery",
    exchangeHint: "NSE",
    sourceFile: null,
    ...over,
  } as NormalizedTrade;
}

const parsed = (trades: NormalizedTrade[]): ParsedFile => ({
  sourceId: "dhan-api",
  broker: "dhan",
  format: "api",
  trades,
  warnings: [],
});

const buyFile = (sym: string, hint: NormalizedTrade["productHint"] = "delivery") =>
  parsed([trade({ tradingsymbol: sym, buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-20", productHint: hint })]);
const saleFile = (sym: string, hint: NormalizedTrade["productHint"] = "delivery") =>
  parsed([trade({ tradingsymbol: sym, sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-28", productHint: hint })]);

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get();
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

/**
 * A lot and v4.2.0's stored sale of it, through the REAL importer: the buy, then
 * the pull's sale as its own row — re-dated to what v4.2.0's Dhan adapter
 * wrote (`sellDate: closed ? today : null`) and stamped on the pull day.
 */
function seedPair(accountId: number, sym: string, hint: NormalizedTrade["productHint"] = "delivery", name = `stale-${sym}`) {
  t.db.insert(t.schema.accounts).values({ id: accountId, name }).run();
  expect(commit.commitParsedFile(buyFile(sym, hint), "dhan-api-2026-08-20", null, accountId).added).toBe(1);
  expect(commit.commitParsedFile(saleFile(sym, hint), "dhan-api-2026-08-28", null, accountId).added).toBe(1);
  const [L, S] = rowsOf(accountId);
  expect([S.buyQty, S.sellQty, S.isOpen], "v4.2.0 stores the sale as an open sell-only row").toEqual([0, 100, true]);
  t.db
    .update(t.schema.trades)
    .set({ sellDate: null, createdAt: "2026-08-28 05:00:00" })
    .where(eq(t.schema.trades.id, S.id))
    .run();
  return { L: row(L.id)!, S: row(S.id)! };
}

async function post(body: unknown) {
  const res = await route.POST(
    new Request("http://local/api/data-quality/close-stale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as { ok: boolean; message: string; code?: string } };
}

// Measured locally (2026-09-11): the hook takes ~1.1 s (migrate + seed), inside
// the 3 s local budget. The raised timeout is for the Windows runner, which is
// >15x slower on SQLite-file work (AGENTS.md Testing), as on the sibling files.
beforeAll(async () => {
  t = await openTempDb("stale-lots", { seed: true });
  commit = await import("@/lib/import/commit");
  route = await import("@/app/api/data-quality/close-stale/route");
  dq = await import("@/lib/queries/data-quality");
  trash = await import("@/lib/trash");
  identity = await import("@/lib/import/broker-identity");
  ratesDb = await import("@/lib/engine/rates-db");
  ({ StaleLotFix } = await import("@/components/quality/stale-lot-fix"));
}, 120_000);
afterAll(() => t?.cleanup());

describe("closing a stale lot with its recorded sale (POST /api/data-quality/close-stale)", () => {
  const ACC = 801;
  let L: NonNullable<ReturnType<typeof row>>;
  let S: NonNullable<ReturnType<typeof row>>;

  it("the account-scoped query lists the pair, with the pull day offered as the date", () => {
    ({ L, S } = seedPair(ACC, "MARKSANS"));
    selectAccount(ACC);
    const pairs = dq.getStaleOpenPairs();
    expect(pairs.map((p) => [p.lotId, p.saleId, p.oneClick, p.saleDate, p.saleDateStated, p.blocked])).toEqual([
      [L.id, S.id, true, "2026-08-28", false, null],
    ]);
    const issue = dq.getDataQualityReport().issues.find((i) => i.code === "stale_open");
    expect(issue?.ids).toEqual([L.id]);
  });

  it("refuses a write with no confirmed date", async () => {
    const { status, json } = await post({ lotId: L.id, saleId: S.id });
    expect([status, json.ok]).toEqual([400, false]);
    expect(row(L.id)!.isOpen).toBe(true);
  });

  it("closes the lot at the sale's price and quantity on the confirmed date, carrying both stored bills", async () => {
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect(json.message).toMatch(/Deleted items/);
    expect([status, json.ok]).toEqual([200, true]);

    const closed = row(L.id)!;
    expect(closed).toMatchObject({
      isOpen: false,
      buyQty: 100,
      sellQty: 100,
      avgBuyPrice: 200,
      avgSellPrice: 250,
      sellValue: 25000,
      buyDate: "2026-08-20",
      sellDate: "2026-08-28",
      grossPnl: 5000,
      unrealisedPnl: 0,
    });
    // Both sides stated a bill, so neither is re-derived (never both for one side).
    expect(closed.chargesTotal).toBe(r2(L.chargesTotal + S.chargesTotal));
    expect(closed.netPnl).toBe(r2(5000 - closed.chargesTotal));
    expect(closed.importNotes ?? "").toContain(`dedup-alias:${S.dedupHash}`);
  });

  it("the sale row is gone from the book and sits in Deleted items", () => {
    expect(row(S.id)).toBeUndefined();
    expect(rowsOf(ACC).map((r) => r.id)).toEqual([L.id]);
    const snap = trash.listTrashSnapshots().find((s) => s.reason.includes(`#${L.id}`));
    expect(snap).toMatchObject({ accountId: ACC, trades: 1, symbols: ["MARKSANS"] });
  });

  it("the audit trail records the close on the lot and the delete of the sale", () => {
    const audits = t.db.select().from(t.schema.auditLog).all();
    expect(audits.filter((a) => a.entity === "trade" && a.entityId === L.id && a.action === "close")).toHaveLength(1);
    expect(audits.filter((a) => a.entity === "trade" && a.entityId === S.id && a.action === "delete")).toHaveLength(1);
  });

  it("re-pulling the sale is skipped: the lot answers to the sale's record", () => {
    const again = commit.commitParsedFile(saleFile("MARKSANS"), "dhan-api-2026-08-28", null, ACC);
    expect([again.added, again.skipped]).toEqual([0, 1]);
    expect(dq.getStaleOpenPairs()).toEqual([]);
  });

  it("a second POST is refused and changes nothing", async () => {
    const before = row(L.id);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect(json.ok).toBe(false);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(row(L.id)).toEqual(before);
  });
});

describe("refusals", () => {
  it("a POST while another book is selected is refused (invariant 8/9)", async () => {
    const { L, S } = seedPair(802, "BEL");
    selectAccount(801);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([403, false, "OTHER_ACCOUNT"]);
    expect(rowsOf(802)).toEqual([L, S]);
  });

  it("a sale carrying the user's own notes is refused and stays listed with the reason", async () => {
    const { L, S } = seedPair(803, "VBL");
    t.db.update(t.schema.trades).set({ notes: "sold on the results" }).where(eq(t.schema.trades.id, S.id)).run();
    selectAccount(803);
    const [listed] = dq.getStaleOpenPairs();
    expect([listed.lotId, listed.saleId]).toEqual([L.id, S.id]);
    expect(listed.blocked).toMatch(/journal entries \(notes\)/);

    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([409, false, "JOURNAL"]);
    expect(json.message).toMatch(/Nothing was changed/);
    expect(rowsOf(803).map((r) => [r.id, r.isOpen])).toEqual([
      [L.id, true],
      [S.id, true],
    ]);
  });

  it("a date before the position was opened is refused", async () => {
    const { L, S } = seedPair(804, "SBIN", "mtf");
    selectAccount(804);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-01" });
    expect([status, json.code]).toEqual([400, "BAD_DATE"]);
    expect(row(L.id)!.isOpen).toBe(true);
  });
});

describe("an eq_mtf lot: interest runs to the CONFIRMED date, exactly as the manual close prices it", () => {
  it("joined with an edited date, it carries the same MTF interest as closePosition on a twin lot", async () => {
    const [L, S] = rowsOf(804);
    expect(L.segment).toBe("eq_mtf");
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-09-05" });
    expect([status, json.ok]).toEqual([200, true]);

    t.db.insert(t.schema.accounts).values({ id: 805, name: "stale-twin" }).run();
    commit.commitParsedFile(buyFile("SBIN", "mtf"), "dhan-api-2026-08-20", null, 805);
    const [twin] = rowsOf(805);
    expect(commit.closePosition(twin.id, 250, "2026-09-05").ok).toBe(true);

    const joined = row(L.id)!;
    const manual = row(twin.id)!;
    expect(joined.sellDate).toBe("2026-09-05");
    expect(manual.mtfInterest).toBeGreaterThan(0);
    expect(joined.mtfInterest).toBe(manual.mtfInterest);
    expect(joined.pledgeCharges).toBe(manual.pledgeCharges);
    expect(joined.mtfFundedAmount).toBe(manual.mtfFundedAmount);

    // R26-T (W2-DQ) — the joined row's chargesTotal, GST and net P&L, derived
    // WITHOUT reading anything closeStaleLot wrote: each side's bill as the
    // importer STORED it (L and S above were read before the join), plus the
    // MTF interest and pledge fee (with the GST on the fee) priced by
    // computeCharges over charge_config for the confirmed holding period.
    // Measured 2026-09-14: 209.69 / 12.13 / 4,790.31 (the re-check's figures).
    expect(L.mtfInterest + L.pledgeCharges + S.mtfInterest + S.pledgeCharges, "neither side carried MTF parts to replace").toBe(0);
    const rates = findRates(ratesDb.loadRatesMap(), "dhan", "eq_mtf", "NSE", "2026-09-05");
    const DAYS_HELD = 16; // 2026-08-20 → 2026-09-05, counted by hand
    const mtf = computeCharges(
      { segment: "eq_mtf", buyValue: 0, sellValue: 0, buyQty: 0, sellQty: 0, buyOrderCount: 0, sellOrderCount: 0, mtf: { fundedAmount: manual.mtfFundedAmount!, daysHeld: DAYS_HELD, pledgeScrips: 1 } },
      rates,
    );
    expect(mtf.mtfInterest, "the independent pricing agrees with the twin's interest").toBe(manual.mtfInterest);
    const expectedTotal = r2(L.chargesTotal + S.chargesTotal + mtf.total);
    expect(joined.chargesTotal).toBe(expectedTotal);
    expect(joined.gst).toBe(r2(L.gst + S.gst + mtf.gst));
    expect(joined.netPnl).toBe(r2(5000 - expectedTotal));
  });
});

// ──────────── W2-DQ P3 / P2 / P4 (v4.3.0 fix wave 2) — the DB half ──────────

describe("W2-DQ P3 — a recorded-basis sale is refused by the join itself", () => {
  it("an ESOP sale at 50 beside a held lot: POST close-stale gives NO_PAIR and changes neither row", async () => {
    const ACC = 806;
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-esop" }).run();
    const buy = parsed([trade({ tradingsymbol: "LTIM", buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-01" })]);
    const sell = parsed([trade({ tradingsymbol: "LTIM", sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-15" })]);
    expect(commit.commitParsedFile(buy, "ltim-buy", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell, "ltim-sell", null, ACC).added).toBe(1);
    const [L, S] = rowsOf(ACC);
    // The user confirmed the sale's basis: an ESOP allotment at 50, closed.
    t.db.update(t.schema.trades).set({ isOpen: false, acquisition: "esop", acquisitionPrice: 50 }).where(eq(t.schema.trades.id, S.id)).run();
    selectAccount(ACC);
    const before = rowsOf(ACC);

    expect(dq.getStaleOpenPairs()).toEqual([]);
    expect(dq.getDataQualityReport().issues.filter((i) => i.code === "stale_open")).toEqual([]);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-15" });
    expect([status, json.ok, json.code]).toEqual([409, false, "NO_PAIR"]);
    expect(rowsOf(ACC)).toEqual(before);
  });
});

describe("W2-DQ P2 — after the manual close, the sale rows are listed as a warning", () => {
  it("lot 100 with sales 40 + 60, closed by closePosition: both sale rows listed, stale_open 0, nothing removed", () => {
    const ACC = 807;
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-manual" }).run();
    const sell = (qty: number, day: string) =>
      parsed([trade({ tradingsymbol: "BHEL", sellQty: qty, avgSellPrice: 250, sellValue: 250 * qty, sellDate: day })]);
    expect(commit.commitParsedFile(buyFile("BHEL"), "bhel-buy", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell(40, "2026-08-28"), "bhel-s40", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell(60, "2026-08-29"), "bhel-s60", null, ACC).added).toBe(1);
    const [L, S40, S60] = rowsOf(ACC);
    selectAccount(ACC);
    // The partial path: listed, no button — the card links to the manual close.
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.matchedQty, p.oneClick])).toEqual([
      [L.id, S40.id, 40, false],
      [L.id, S60.id, 60, false],
    ]);

    expect(commit.closePosition(L.id, 250, "2026-08-29").ok).toBe(true);

    const report = dq.getDataQualityReport();
    expect(report.issues.filter((i) => i.code === "stale_open")).toEqual([]);
    const warning = report.issues.find((i) => i.code === "stale_sale");
    expect(warning).toMatchObject({ severity: "warning", count: 2, ids: [S40.id, S60.id], href: "/data-quality#stale-open" });
    const section = dq.getStaleOpenSection();
    expect(section.pairs).toEqual([]);
    expect(section.sales.map((s) => [s.saleId, s.saleQty, s.closedLotIds])).toEqual([
      [S40.id, 40, [L.id]],
      [S60.id, 60, [L.id]],
    ]);
    expect(rowsOf(ACC).map((r) => r.id), "listed, never removed").toEqual([L.id, S40.id, S60.id]);

    // The stale section the warning links to renders them, with no join button.
    const html = renderToStaticMarkup(React.createElement(StaleLotFix, section));
    expect(html).toContain('id="stale-open"');
    expect(html).toContain("Closing trades with no open position left to close");
    expect(html.match(/data-stale-sales/g)).toHaveLength(1);
    expect(html).toContain("recorded sale 40");
    expect(html).toContain("recorded sale 60");
    expect(html).not.toContain("Close with the recorded sale");
  });
});

describe("W2-DQ P4 — a lot joined with its recorded sale stays a cross-account copy of its joined twin", () => {
  /** Seed the same Dhan lot + sale into `accounts`, then join it in `joinIn` through the real route. */
  async function seedTwins(accounts: number[], joinIn: number[], sym: string) {
    const seeded = accounts.map((acc) => ({ acc, ...seedPair(acc, sym, "delivery", `stale-${sym}-${acc}`) }));
    for (const s of seeded.filter((x) => joinIn.includes(x.acc))) {
      selectAccount(s.acc);
      const { status } = await post({ lotId: s.L.id, saleId: s.S.id, exitDate: "2026-08-28" });
      expect(status).toBe(200);
    }
    selectAccount(0);
    return seeded;
  }

  it("joined in BOTH books: every copy is removable under each hash, and the fix takes the joined lot", async () => {
    const [a, b] = await seedTwins([808, 809], [808, 809], "HAL");
    const groups = identity.listDuplicateTradeGroups().filter((g) => g.symbol === "HAL");
    expect(groups.map((g) => g.dedupHash).sort()).toEqual([a.L.dedupHash, a.S.dedupHash].sort());
    for (const g of groups) {
      expect(g.accounts.map((x) => [x.id, x.removable]), `under ${g.dedupHash === a.L.dedupHash ? "the buy" : "the sale"} hash`).toEqual([
        [808, true],
        [809, true],
      ]);
    }
    expect(identity.duplicateTradeIdsIn("dhan", a.L.dedupHash, 808)).toEqual([a.L.id]);
    expect(identity.duplicateTradeIdsIn("dhan", a.S.dedupHash, 809)).toEqual([b.L.id]);
  });

  it("joined in ONE book only: that copy is still not removable, under either hash (fixA S3b's shape)", async () => {
    const [a, b] = await seedTwins([810, 811], [810], "BEML");
    const groups = identity.listDuplicateTradeGroups().filter((g) => g.symbol === "BEML");
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.accounts.map((x) => [x.id, x.removable])).toEqual([[810, false], [811, true]]);
    expect(identity.duplicateTradeIdsIn("dhan", a.L.dedupHash, 810)).toEqual([]);
    expect(identity.duplicateTradeIdsIn("dhan", a.L.dedupHash, 811)).toEqual([b.L.id]);
  });
});

// ─────────── W2-FIXD2 (seam D2) — a STAGED lot: listed, refused, linked ─────────

describe("W2-FIXD2 — a staged lot (bought in two fills) and its recorded sale: listed, the join refuses it, the card links to the ladder", () => {
  const ACC = 812;
  const SYM = "TATASTEEL";
  let L: NonNullable<ReturnType<typeof row>>;
  let S: NonNullable<ReturnType<typeof row>>;
  const legsOf = (tradeId: number) =>
    t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, tradeId)).all().sort((a, b) => a.seq - b.seq);

  it("the real importer stores ONE staged row of 100 with two entry legs, and the query lists it against all 100", () => {
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "stale-staged" }).run();
    const buy = parsed([
      trade({
        tradingsymbol: SYM,
        buyQty: 100,
        avgBuyPrice: 200,
        buyValue: 20000,
        buyDate: "2026-08-20",
        executions: [
          { side: "buy", qty: 10, price: 200, date: "2026-08-20", time: "10:00:00" },
          { side: "buy", qty: 90, price: 200, date: "2026-08-20", time: "10:05:00" },
        ],
      }),
    ]);
    expect(commit.commitParsedFile(buy, "staged-buy", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(saleFile(SYM), "staged-sale", null, ACC).added).toBe(1);
    [L, S] = rowsOf(ACC);
    expect([L.staged, L.isOpen, L.buyQty, S.sellQty, S.isOpen]).toEqual([true, true, 100, 100, true]);
    expect(legsOf(L.id).map((g) => [g.kind, g.qty])).toEqual([["entry", 10], ["entry", 90]]);

    selectAccount(ACC);
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.matchedQty, p.staged, p.oneClick, p.blocked])).toEqual([
      [L.id, S.id, 100, true, false, null],
    ]);
    expect(dq.getDataQualityReport().issues.find((i) => i.code === "stale_open")?.ids).toEqual([L.id]);
  });

  it("POST close-stale refuses the staged lot with STAGED and changes neither row nor the ladder", async () => {
    const beforeRows = rowsOf(ACC);
    const beforeLegs = legsOf(L.id);
    const { status, json } = await post({ lotId: L.id, saleId: S.id, exitDate: "2026-08-28" });
    expect([status, json.ok, json.code]).toEqual([409, false, "STAGED"]);
    expect(json.message).toMatch(/staged position/);
    expect(json.message).toMatch(/Nothing was changed/);
    expect(rowsOf(ACC)).toEqual(beforeRows);
    expect(legsOf(L.id)).toEqual(beforeLegs);
  });

  it("closeStaleLot itself refuses it too, whatever the screen offered (defence in depth)", () => {
    const res = commit.closeStaleLot(L.id, S.id, "2026-08-28");
    expect([res.ok, res.code]).toEqual([false, "STAGED"]);
    expect(row(L.id)!.isOpen).toBe(true);
    expect(row(S.id)).toBeDefined();
  });

  it("the card lists the pair with no join button, and links to the position in Trades where its ladder books the exit", () => {
    const html = renderToStaticMarkup(React.createElement(StaleLotFix, { pairs: dq.getStaleOpenPairs() }));
    const text = html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ");
    expect(text).toContain("open 100 @ 200.00 since 2026-08-20");
    expect(html).not.toContain("Close with the recorded sale");
    expect(text).toContain("staged position");
    expect(html).toContain(`href="/trades?symbol=${SYM}&amp;view=open"`);
    expect(text).not.toMatch(/\b(should|must|recommend|consider|suggest)\b/i);
  });
});
