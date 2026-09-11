import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  assessDataQuality,
  staleOpenPairs,
  type QualityInputs,
  type QualityTrade,
} from "@/lib/analytics/data-quality";
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

  it("a staged lot, another broker, or another exchange never pairs", () => {
    expect(staleOpenPairs([lot({ staged: true }), sale()])).toEqual([]);
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

// ──────────────────────────────── the DB half ───────────────────────────────

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let route: typeof import("@/app/api/data-quality/close-stale/route");
let dq: typeof import("@/lib/queries/data-quality");
let trash: typeof import("@/lib/trash");

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
function seedPair(accountId: number, sym: string, hint: NormalizedTrade["productHint"] = "delivery") {
  t.db.insert(t.schema.accounts).values({ id: accountId, name: `stale-${sym}` }).run();
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
  });
});
