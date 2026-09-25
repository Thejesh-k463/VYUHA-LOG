import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";

/**
 * v4.6.0 W6 fix wave — the stateful sequences contract §2 required on a SHORT
 * (or a row that WAS one), driven through the real writers: commit, the
 * trades actions, the IPO route, the close, and the jobs. Plus finding 3: the
 * contract-note time enrichment routes a closed short's times by side.
 *
 * ONE temp database per FILE (AGENTS.md Testing). Every module that reaches
 * `@/lib/db` is imported dynamically, after `openTempDb` sets VYUHA_DB_PATH.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let actions: typeof import("@/app/trades/actions");
let ipoRoute: typeof import("@/app/api/ipos/route");
let bhav: typeof import("@/lib/import/mtm-bhavcopy");
let mtm: typeof import("@/lib/queries/mtm");
let autoMtm: typeof import("@/lib/jobs/auto-mtm");
let mtfAccrual: typeof import("@/lib/jobs/mtf-accrual");
let corp: typeof import("@/lib/corporate-actions-apply");
let positions: typeof import("@/lib/analytics/positions");

// Measured locally: migrate + seed + these imports is the one slow step (~2 s).
beforeAll(async () => {
  t = await openTempDb("side-sequences", { seed: true });
  commit = await import("@/lib/import/commit");
  actions = await import("@/app/trades/actions");
  ipoRoute = await import("@/app/api/ipos/route");
  bhav = await import("@/lib/import/mtm-bhavcopy");
  mtm = await import("@/lib/queries/mtm");
  autoMtm = await import("@/lib/jobs/auto-mtm");
  mtfAccrual = await import("@/lib/jobs/mtf-accrual");
  corp = await import("@/lib/corporate-actions-apply");
  positions = await import("@/lib/analytics/positions");
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
}, 30_000);
afterAll(() => t?.cleanup());

const nt = (o: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade =>
  ({
    broker: "zerodha", isin: null,
    buyQty: 0, avgBuyPrice: 0, buyValue: 0, sellQty: 0, avgSellPrice: 0, sellValue: 0,
    closingPrice: null, grossPnl: 0, unrealisedPnl: 0, buyDate: null, sellDate: null,
    productHint: null, exchangeHint: null, sourceFile: null, ...o,
  }) as NormalizedTrade;
const file = (trades: NormalizedTrade[]) => ({ sourceId: "zerodha", broker: "zerodha" as const, format: "tradebook", trades, warnings: [] });
const rowsOf = (sym: string) => t.db.select().from(t.schema.trades).all().filter((r) => r.tradingsymbol === sym);

describe("finding 3 — contract-note times on a closed SHORT go by side", () => {
  it("the first SELL fill is the entry and the last BUY fill the exit (a Nuvama / Dhan GTR row with no times)", () => {
    const FO = "NIFTY26NOV25400CE";
    const q = 75;
    expect(
      commit.commitParsedFile(
        file([nt({
          tradingsymbol: FO,
          sellQty: q, avgSellPrice: 122, sellValue: 122 * q, sellDate: "2026-09-01",
          buyQty: q, avgBuyPrice: 90, buyValue: 90 * q, buyDate: "2026-09-02",
          grossPnl: 32 * q, side: "short",
        })]),
        "ovn-no-times.csv", null, 1,
      ).added,
    ).toBe(1);
    const res = commit.commitParsedFile(
      {
        sourceId: "dhan-contract-note", broker: "zerodha", format: "contract-note", trades: [], warnings: [],
        enrich: [
          { symbol: FO, date: "2026-09-01", side: "sell", qty: 50, time: "09:20:00", instrumentType: "option" },
          { symbol: FO, date: "2026-09-01", side: "sell", qty: 25, time: "09:41:00", instrumentType: "option" },
          { symbol: FO, date: "2026-09-02", side: "buy", qty: 40, time: "13:05:00", instrumentType: "option" },
          { symbol: FO, date: "2026-09-02", side: "buy", qty: 35, time: "14:55:00", instrumentType: "option" },
        ],
      },
      "cn-ovn.pdf", null, 1,
    );
    expect(res.enrichApplied).toBe(2);
    const [row] = rowsOf(FO);
    // Before the fix: entryTime 13:05 (the buy-back) and exitTime 09:41 (the sale).
    expect([row.side, row.entryTime, row.exitTime]).toEqual(["short", "09:20:00", "14:55:00"]);
  });
});

// ─────────────── contract §2 — the sequences on a short (item 7) ───────────────

const TODAY = "2026-09-10";
const equitySale = (sym: string, qty: number, price: number, date: string, productHint: NormalizedTrade["productHint"] = "delivery") =>
  nt({ tradingsymbol: sym, productHint, exchangeHint: "NSE", sellQty: qty, avgSellPrice: price, sellValue: qty * price, sellDate: date, basisUnknown: true });
const one = (sym: string) => {
  const rows = rowsOf(sym);
  expect(rows).toHaveLength(1);
  return rows[0];
};
const legsOf = (r: { side: string | null; buyQty: number; sellQty: number; isOpen: boolean }) => [r.side, r.buyQty, r.sellQty, r.isOpen];
/** Unrealised P&L as the open-positions readers derive it from the stored marks. */
const unrealisedOf = (id: number) => {
  const open = t.db.select().from(t.schema.trades).all().filter((r) => r.isOpen);
  return positions.deriveOpenPositions(open, mtm.getMtmMap(), TODAY).find((p) => p.id === id)?.unrealised;
};
const ipoPost = async (body: Record<string, unknown>) => {
  const res = await ipoRoute.POST(new Request("http://localhost/api/ipos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; id?: number; message: string } };
};

describe("contract §2 — sequences on a short, through the real writers", () => {
  it("(a) equity opening sale → IPO link (buy leg + side long) → re-open → auto-MTM → close: the close SELLS, the mark reads (mark − buy) × qty", async () => {
    const SYM = "ACMEIPO";
    expect(commit.commitParsedFile(file([equitySale(SYM, 10, 600, "2026-08-10")]), "acme-sale.csv", null, 1).added).toBe(1);
    const sale = one(SYM);
    expect(legsOf(sale)).toEqual(["short", 0, 10, true]);

    const ipo = {
      name: "Acme IPO Limited", broker: "zerodha", exchange: "NSE", appliedPrice: 500, lotSize: 10, lotsApplied: 1,
      allotted: true, allottedQty: 10, appliedDate: "2026-07-20", allotmentDate: "2026-07-25", listingDate: "2026-07-28",
      listingPrice: 550, exitPrice: 600, exitDate: "2026-08-10",
    };
    const linked = await ipoPost({ ...ipo, tradeId: sale.id });
    expect(linked.status, linked.body.message).toBe(200);
    // The allotment is the buy leg; the row is flat and STATES long.
    expect([...legsOf(one(SYM)), one(SYM).avgBuyPrice]).toEqual(["long", 10, 10, false, 500]);

    // Re-open. The IPO record may not clear an exit whose sale carries the
    // file's own charges — it refuses and names the door: re-open the sale in
    // Trades. That is the editor.
    const refused = await ipoPost({ ...ipo, id: linked.body.id, exitPrice: null, exitDate: null });
    expect([refused.status, refused.body.message]).toEqual([409, expect.stringContaining("Re-open or change that sale in Trades")]);
    const reopened = commit.updateManualTrade(sale.id, { sellQty: 0, avgSellPrice: 0, sellDate: null });
    expect(reopened.ok, reopened.message).toBe(true);
    expect(legsOf(one(SYM))).toEqual(["long", 10, 0, true]);

    // Auto-MTM (the bhavcopy applier the job runs) marks it at 640: a LONG's (mark − buy) × qty.
    const r = bhav.applyBhavcopyMtm([
      "TradDt,BizDt,Sgmt,Src,FinInstrmTp,ISIN,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol",
      `${TODAY},${TODAY},CM,NSE,STK,INE000A01011,${SYM},EQ,630,645,625,640,1000`,
    ].join("\n"));
    expect([r.ok, r.priced]).toEqual([true, 1]);
    expect(unrealisedOf(sale.id)).toBe((640 - 500) * 10);
    expect(autoMtm.scanBreaches().filter((b) => b.id === sale.id).map((b) => b.side)).toEqual([]);

    // Close: SELLS the 10 — nothing is bought.
    const closed = commit.closePosition(sale.id, 650, TODAY);
    expect(closed.ok, closed.message).toBe(true);
    const after = one(SYM);
    expect([...legsOf(after), after.avgBuyPrice, after.avgSellPrice]).toEqual(["long", 10, 10, false, 500, 650]);
  });

  it("(b) setAcquisition on an opening sale → close: the close SELLS nothing more and buys nothing", async () => {
    const SYM = "BETAGIFT";
    commit.commitParsedFile(file([equitySale(SYM, 20, 300, "2026-08-12")]), "beta-sale.csv", null, 1);
    const sale = one(SYM);
    expect(legsOf(sale)).toEqual(["short", 0, 20, true]);
    const fd = new FormData();
    fd.set("tradeId", String(sale.id));
    fd.set("acquisition", "gift");
    fd.set("acquisitionPrice", "250");
    fd.set("acquisitionDate", "2026-07-01");
    const res = await actions.setAcquisitionAction({ ok: false, message: "" }, fd);
    expect(res.ok, res.message).toBe(true);
    // The basis is a LONG's entry: flat, stated long.
    expect([...legsOf(one(SYM)), one(SYM).avgBuyPrice]).toEqual(["long", 20, 20, true, 250]);
    // The close reads the row as the long it now states — a sell-side close,
    // never a 20-lot BUY to "cover" a short that no longer exists.
    const closed = commit.closePosition(sale.id, 320, TODAY);
    expect(closed.ok, closed.message).toBe(true);
    const after = one(SYM);
    expect([...legsOf(after), after.avgBuyPrice]).toEqual(["long", 20, 20, false, 250]);
  });

  it("(c) MTF accrual never bills interest on an open SHORT (MTF is long-only: the sale funds nothing)", () => {
    const SYM = "GAMMAMTF";
    commit.commitParsedFile(file([equitySale(SYM, 50, 100, "2026-08-20", "mtf")]), "gamma-mtf.csv", null, 1);
    const before = one(SYM);
    expect([before.segment, ...legsOf(before)]).toEqual(["eq_mtf", "short", 0, 50, true]);
    mtfAccrual.accrueMtfInterest(TODAY);
    const after = one(SYM);
    expect([after.mtfInterest, after.chargesTotal, after.netPnl, after.side]).toEqual([0, before.chargesTotal, before.netPnl, "short"]);
  });

  it("(d) a split on an open short scales the OPENING (sell) leg only, and the side stays short", () => {
    const FO = "INFY26OCT1500CE";
    commit.commitParsedFile(
      file([nt({ tradingsymbol: FO, sellQty: 100, avgSellPrice: 40, sellValue: 4000, sellDate: "2026-09-01", buyQty: 40, avgBuyPrice: 30, buyValue: 1200, buyDate: "2026-09-02", side: "short" })]),
      "infy-short.csv", null, 1,
    );
    const before = one(FO);
    expect([before.symbol, ...legsOf(before)]).toEqual(["INFY", "short", 40, 100, true]);
    const id = t.db.insert(t.schema.corporateActions).values({ symbol: "INFY", type: "split", exDate: "2026-09-05", fromUnits: 1, toUnits: 2 }).returning({ id: t.schema.corporateActions.id }).get().id;
    const res = corp.applyCorporateAction(id);
    expect([res.ok, res.positionsAdjusted]).toEqual([true, 1]);
    const after = one(FO);
    expect([...legsOf(after), after.avgSellPrice, after.sellValue, after.avgBuyPrice]).toEqual(["short", 40, 200, true, 20, 4000, 30]);
  });

  it("(e) the auto-MTM job never marks an F&O short at a cash close; on its own contract's mark it reads SHORT: (entry − mark) × qty, and a stop ABOVE entry breaches", () => {
    const FO = "NIFTY26OCT25700PE";
    commit.commitParsedFile(file([nt({ tradingsymbol: FO, sellQty: 75, avgSellPrice: 120, sellValue: 9000, sellDate: "2026-09-01", side: "short" })]), "nifty-short.csv", null, 1);
    const row = one(FO);
    expect(legsOf(row)).toEqual(["short", 0, 75, true]);
    // The bhavcopy applier skips a derivative rather than price it at a cash close.
    const r = bhav.applyBhavcopyMtm([
      "TradDt,BizDt,Sgmt,Src,FinInstrmTp,ISIN,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol",
      `${TODAY},${TODAY},CM,NSE,STK,INE000A01011,NIFTY,EQ,25000,25100,24900,25050,1000`,
    ].join("\n"));
    expect(r.derivativesSkipped).toBeGreaterThanOrEqual(1);
    expect(unrealisedOf(row.id)).toBe(0); // no mark of its own yet: entry, P&L 0
    // Its own contract's mark (the premium rose to 160), stored under the
    // contract as a positions pull / the live feed stores it: a SHORT loses.
    t.db.insert(t.schema.mtmPrices).values({ symbol: FO, tradingsymbol: FO, price: 160, asOfDate: TODAY }).run();
    expect(unrealisedOf(row.id)).toBe((120 - 160) * 75);
    t.sqlite.prepare("UPDATE trades SET sl_planned = 150 WHERE id = ?").run(row.id);
    const b = autoMtm.scanBreaches().find((x) => x.id === row.id);
    expect([b?.side, b?.kind, b?.mtm]).toEqual(["short", "sl", 160]);
  });
});
