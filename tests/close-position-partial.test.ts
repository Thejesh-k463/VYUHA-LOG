import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { computeCharges } from "@/lib/engine/charges";
import { findRates, pricingDate } from "@/lib/engine/rates";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { STALE_CLOSE_NOTE, withStaleCloseNote } from "@/lib/import/close-open-lots";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 fix wave 2H (H1) — the manual close of a PARTLY closed row, and the
 * Data Quality join note once a writer changes the joined close.
 *
 * (1) Silent wrong number, pre-existing (wave-2G re-check, unit "dq").
 * `closePosition` on an open long holding 100 bought / 60 sold wrote
 * sellQty = the remaining 40 and sellValue = 40 × exit: the 60 already sold
 * were dropped and the row closed with buyQty ≠ sellQty, so a +5,200 trade
 * booked as −9,800 (measured 2026-09-15). It now ADDS the exit to the existing
 * closing leg (a short mirrors it on the buy leg): the row closes 100 / 100,
 * the average is the weighted one (REAL), the value is rupees (invariant 1),
 * and a row with nothing on its closing side is written exactly as before.
 *
 * (2) M2 variant (c), the writer half. A lot joined from Data Quality carries
 * `STALE_CLOSE_NOTE` + its sale's alias, and `closedByStaleJoin` exempts it
 * from the ambiguity test. Once the trade editor changes its exit leg, or
 * `closePosition` closes it again, its close is no longer the join's, so the
 * two writers drop the note and keep every alias (identity for re-import
 * dedup). The sibling pair is then refused as AMBIGUOUS, as a close made
 * elsewhere must be.
 *
 * ONE temp database per FILE (AGENTS.md).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let dq: typeof import("@/lib/queries/data-quality");
let ratesDb: typeof import("@/lib/engine/rates-db");
let dialog: typeof import("@/components/trades/close-trade-dialog");
let previewRoute: typeof import("@/app/api/charges/preview/route");

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

const parsed = (trades: NormalizedTrade[]): ParsedFile => ({ sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings: [] });
const buyFile = (sym: string, qty: number, price: number, day: string) =>
  parsed([trade({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: price, buyValue: qty * price, buyDate: day })]);
const sellFile = (sym: string, qty: number, price: number, day: string) =>
  parsed([trade({ tradingsymbol: sym, sellQty: qty, avgSellPrice: price, sellValue: qty * price, sellDate: day })]);

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const newAccount = (id: number, name: string) => t.db.insert(t.schema.accounts).values({ id, name }).run();
const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const notesOf = (id: number) => (row(id).importNotes ?? "").split("|").map((s) => s.trim()).filter(Boolean);

/** The engine's bill over a row's stated aggregate — the same call closePosition makes. */
function billOver(r: ReturnType<typeof row>) {
  const rates = findRates(ratesDb.loadRatesMap(), "dhan", "eq_delivery", "NSE", pricingDate({ buyDate: r.buyDate, sellDate: r.sellDate }, "2026-09-15"));
  return computeCharges(
    {
      segment: "eq_delivery",
      buyValue: r.buyValue,
      sellValue: r.sellValue,
      buyQty: r.buyQty,
      sellQty: r.sellQty,
      buyOrderCount: r.buyOrderCount,
      sellOrderCount: r.sellOrderCount,
      mtf: null,
    },
    rates,
  );
}

// Measured locally (2026-09-15): the file's tests phase is 2.11 s with the six
// `it`s summing ~0.27 s, so the hook (migrate + seed) is ~1.9 s, inside the
// 3 s local budget. S1 added a second hook (the close dialog module + the
// preview route): tests phase 3.15 s with the nine `it`s summing ~0.64 s, so
// that hook is ~0.6 s. The raised timeouts are
// for the Windows runner, >15x slower on SQLite-file work (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("close-position-partial", { seed: true });
  commit = await import("@/lib/import/commit");
  dq = await import("@/lib/queries/data-quality");
  ratesDb = await import("@/lib/engine/rates-db");
}, 120_000);
// The close dialog module (React + the trades actions graph) and the preview
// route, in a hook of their own: a first import is a one-off cost that belongs
// in a hook, not in an `it`.
beforeAll(async () => {
  dialog = await import("@/components/trades/close-trade-dialog");
  previewRoute = await import("@/app/api/charges/preview/route");
}, 120_000);
afterAll(() => t?.cleanup());

describe("H1 (1) — closePosition closes the REMAINING quantity onto the existing closing leg", () => {
  it("a long bought 100 @200, sold 60 @250, closed @255: sell 100 for 25,200, gross +5,200, one more sell order", () => {
    const ACC = 944;
    newAccount(ACC, "close-partial-long");
    expect(commit.commitParsedFile(buyFile("CPX", 100, 200, "2026-08-20"), "cpx-buy", null, ACC).added).toBe(1);
    const [L] = rowsOf(ACC);
    expect(commit.updateManualTrade(L.id, { sellQty: 60, avgSellPrice: 250, sellDate: "2026-08-25" }).ok).toBe(true);
    const part = row(L.id);
    expect([part.isOpen, part.buyQty, part.sellQty, part.sellValue]).toEqual([true, 100, 60, 15000]);

    expect(commit.closePosition(L.id, 255, "2026-08-26").ok).toBe(true);
    const c = row(L.id);
    expect([c.isOpen, c.buyQty, c.sellQty]).toEqual([false, 100, 100]);
    expect([c.sellValue, c.avgSellPrice, c.sellDate]).toEqual([25200, 252, "2026-08-26"]);
    expect([c.buyValue, c.avgBuyPrice, c.buyDate]).toEqual([20000, 200, "2026-08-20"]);
    expect(c.grossPnl).toBe(5200); // 25,200 − 20,000 (60 @250 + 40 @255 against 100 @200)
    expect(c.realisedPct).toBe(26);
    // The 40 are a second exit order on top of the leg's one.
    expect(c.sellOrderCount).toBe(part.sellOrderCount + 1);
    // The bill is the engine's over the corrected aggregate (the whole row is re-priced, as before).
    const bill = billOver(c);
    expect(c.chargesTotal).toBe(bill.total);
    expect([c.sttCtt, c.stampDuty, c.dpCharges, c.gst]).toEqual([bill.sttCtt, bill.stampDuty, bill.dpCharges, bill.gst]);
    expect(c.netPnl).toBe(r2(5200 - bill.total));
  });

  it("the short mirror: sold 100 @250, covered 60 @200, closed @195: buy 100 for 19,800, gross +5,200", () => {
    const ACC = 945;
    newAccount(ACC, "close-partial-short");
    expect(commit.commitParsedFile(sellFile("CPXS", 100, 250, "2026-08-20"), "cpxs-sell", null, ACC).added).toBe(1);
    const [S] = rowsOf(ACC);
    expect(commit.updateManualTrade(S.id, { buyQty: 60, avgBuyPrice: 200, buyDate: "2026-08-25" }).ok).toBe(true);
    const part = row(S.id);
    expect([part.isOpen, part.buyQty, part.sellQty, part.buyValue]).toEqual([true, 60, 100, 12000]);

    expect(commit.closePosition(S.id, 195, "2026-08-26").ok).toBe(true);
    const c = row(S.id);
    expect([c.isOpen, c.buyQty, c.sellQty]).toEqual([false, 100, 100]);
    expect([c.buyValue, c.avgBuyPrice, c.buyDate]).toEqual([19800, 198, "2026-08-26"]);
    expect([c.sellValue, c.avgSellPrice, c.sellDate]).toEqual([25000, 250, "2026-08-20"]);
    expect(c.grossPnl).toBe(5200); // 25,000 − 19,800
    expect(c.buyOrderCount).toBe(part.buyOrderCount + 1);
    expect(c.chargesTotal).toBe(billOver(c).total);
  });

  it("a row with nothing on its closing side is written exactly as before (exit price kept, not value ÷ qty; one order)", () => {
    const ACC = 946;
    newAccount(ACC, "close-partial-none");
    expect(commit.commitParsedFile(buyFile("CPXN", 7, 200, "2026-08-20"), "cpxn-buy", null, ACC).added).toBe(1);
    const [L] = rowsOf(ACC);
    const before = row(L.id);
    expect(commit.closePosition(L.id, 250.555, "2026-08-26").ok).toBe(true);
    const c = row(L.id);
    // The pre-H1 derivation, stated by hand: qty = 7, value = round(7 × 250.555), price = the exit price itself.
    const exitValue = Math.round(250.555 * 7 * 100) / 100;
    expect(exitValue / 7, "the pin can tell a divided average from the exit price").not.toBe(250.555);
    expect([c.sellQty, c.avgSellPrice, c.sellValue, c.sellOrderCount]).toEqual([7, 250.555, exitValue, before.sellOrderCount || 1]);
    expect({ ...c, updatedAt: null }).toEqual({
      ...before,
      updatedAt: null,
      sellQty: 7,
      avgSellPrice: 250.555,
      sellValue: exitValue,
      sellDate: "2026-08-26",
      sellOrderCount: before.sellOrderCount || 1,
      isOpen: false,
      unrealisedPnl: 0,
      grossPnl: c.grossPnl,
      chargesTotal: c.chargesTotal,
      netPnl: c.netPnl,
      realisedPct: c.realisedPct,
      rMultiple: c.rMultiple,
      brokerage: c.brokerage,
      sttCtt: c.sttCtt,
      exchangeTxn: c.exchangeTxn,
      sebi: c.sebi,
      stampDuty: c.stampDuty,
      ipft: c.ipft,
      gst: c.gst,
      dpCharges: c.dpCharges,
      mtfInterest: c.mtfInterest,
      mtfFundedAmount: c.mtfFundedAmount,
      pledgeCharges: c.pledgeCharges,
    });
    expect(c.grossPnl).toBe(r2(exitValue - 1400));
    expect(c.chargesTotal).toBe(billOver(c).total);
  });
});

describe("S1 (seam E-c) — the Trades close dialog's live preview prices exactly what closePosition stores", () => {
  type Preview = { breakdown: { total: number }; grossPnl: number; netPnl: number };
  /** The trade as /trades ships it to the client: the slim projection, over JSON (order counts included since T2). */
  const wire = (id: number) => JSON.parse(JSON.stringify(slimOf(row(id)))) as import("@/lib/domain/slim-trade").SlimTrade;
  let slimOf: typeof import("@/lib/domain/slim-trade").toSlimTrade;
  beforeAll(async () => {
    ({ toSlimTrade: slimOf } = await import("@/lib/domain/slim-trade"));
  });
  /** The dialog's request as its effect builds it (the dates rule stated at its call site), sent to the real route. */
  async function previewOf(id: number, exitPrice: number, exitDate: string) {
    const tr = wire(id);
    const isShort = tr.sellQty > tr.buyQty;
    const body = dialog.closePreviewBody(tr, exitPrice, exitDate, {
      buyDate: isShort ? exitDate : tr.buyDate,
      sellDate: isShort ? tr.sellDate : exitDate,
    });
    const res = await previewRoute.POST(
      new Request("http://localhost/api/charges/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(200);
    return { body, preview: (await res.json()) as Preview };
  }

  it("long 100 @200 with 60 sold @250, closed @255 on 1 Apr: the preview is sell 100 for 25,200 and shows the stored gross / charges / net", async () => {
    const ACC = 949;
    newAccount(ACC, "close-preview-long");
    expect(commit.commitParsedFile(buyFile("CPXP", 100, 200, "2026-03-02"), "cpxp-buy", null, ACC).added).toBe(1);
    const [L] = rowsOf(ACC);
    expect(commit.updateManualTrade(L.id, { sellQty: 60, avgSellPrice: 250, sellDate: "2026-03-20" }).ok).toBe(true);

    const { body, preview } = await previewOf(L.id, 255, "2026-04-01");
    expect(commit.closePosition(L.id, 255, "2026-04-01").ok).toBe(true);
    const c = row(L.id);
    // THE assertions (on revert of the dialog's body: sell 40 for 10,200 and a
    // preview of gross 2,200 / charges 48.88 / net 2,151.12 beside this save).
    expect([body.buyQty, body.buyValue, body.sellQty, body.sellValue]).toEqual([c.buyQty, c.buyValue, c.sellQty, c.sellValue]);
    expect([preview.grossPnl, preview.breakdown.total, preview.netPnl]).toEqual([c.grossPnl, c.chargesTotal, c.netPnl]);
    expect([c.grossPnl, c.chargesTotal, c.netPnl]).toEqual([5200, 64.45, 5135.55]); // the seam's measured save
  });

  it("the short mirror: sold 100 @250, covered 60 @200, covered @195: the preview is buy 100 for 19,800 and shows the stored figures", async () => {
    const ACC = 950;
    newAccount(ACC, "close-preview-short");
    expect(commit.commitParsedFile(sellFile("CPXPS", 100, 250, "2026-08-20"), "cpxps-sell", null, ACC).added).toBe(1);
    const [S] = rowsOf(ACC);
    expect(commit.updateManualTrade(S.id, { buyQty: 60, avgBuyPrice: 200, buyDate: "2026-08-25" }).ok).toBe(true);

    const { body, preview } = await previewOf(S.id, 195, "2026-08-26");
    expect(commit.closePosition(S.id, 195, "2026-08-26").ok).toBe(true);
    const c = row(S.id);
    expect([body.buyQty, body.buyValue, body.sellQty, body.sellValue]).toEqual([100, 19800, 100, 25000]);
    expect([body.buyQty, body.buyValue, body.sellQty, body.sellValue]).toEqual([c.buyQty, c.buyValue, c.sellQty, c.sellValue]);
    expect([preview.grossPnl, preview.breakdown.total, preview.netPnl]).toEqual([c.grossPnl, c.chargesTotal, c.netPnl]);
    expect(preview.grossPnl).toBe(5200);
  });

  // T2 (seam re-run E-c residual): the wire row carried no order counts, so the
  // dialog sent the closing side as 1 + 1 orders and the route defaulted the open
  // side to 1, while closePosition bills the stored counts. A stock option sold
  // 100 @5 in 2 orders, 60 covered @3 in 3 orders, the rest covered @2 previewed
  // charges 72.12 / net 167.88 beside a save of 142.92 / 97.08 (probe 2026-09-15).
  it.each([
    ["dhan", 951],
    ["zerodha", 952],
  ] as const)("%s stock option sold 100 @5 in 2 orders, 60 covered @3 in 3 orders, covered @2: the preview bills the stored order counts (4 buy / 2 sell)", async (broker, ACC) => {
    newAccount(ACC, `close-preview-orders-${broker}`);
    const sym = `T2OPT${broker.toUpperCase()}`;
    const [ins] = t.db
      .insert(t.schema.trades)
      .values({
        accountId: ACC, broker, bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NSE",
        symbol: sym, tradingsymbol: `${sym}100CESEP26`, optionType: "CE", strike: 100, expiry: "2026-09-24",
        sellQty: 100, avgSellPrice: 5, sellValue: 500, sellDate: "2026-09-01", sellOrderCount: 2,
        buyQty: 60, avgBuyPrice: 3, buyValue: 180, buyDate: "2026-09-03", buyOrderCount: 3,
        grossPnl: 0, isOpen: true, dedupHash: `t2-${broker}`,
      })
      .returning({ id: t.schema.trades.id })
      .all();

    const { body, preview } = await previewOf(ins.id, 2, "2026-09-08");
    expect(commit.closePosition(ins.id, 2, "2026-09-08").ok).toBe(true);
    const c = row(ins.id);
    expect([c.buyQty, c.buyValue, c.buyOrderCount, c.sellQty, c.sellValue, c.sellOrderCount]).toEqual([100, 260, 4, 100, 500, 2]);
    // THE assertions (on revert: buyOrders 2 / sellOrders 1 → charges 72.12, net 167.88).
    expect([preview.grossPnl, preview.breakdown.total, preview.netPnl]).toEqual([c.grossPnl, c.chargesTotal, c.netPnl]);
    expect([preview.breakdown.total, preview.netPnl]).toEqual([142.92, 97.08]);
    expect([body.buyOrders, body.sellOrders]).toEqual([c.buyOrderCount, c.sellOrderCount]);
  });

  it("the dialog's effect sends closePreviewBody's body, and closePosition reads the same helper", () => {
    const src = (p: string) => fs.readFileSync(`${process.cwd()}/${p}`, "utf8");
    const dlg = src("components/trades/close-trade-dialog.tsx");
    const at = dlg.indexOf('fetch("/api/charges/preview"');
    expect(at).toBeGreaterThan(-1);
    expect(dlg.slice(at, dlg.indexOf("if (res.ok)", at))).toMatch(/body: JSON\.stringify\(\s*closePreviewBody\(trade, price, exitDate, \{/);
    const cp = src("lib/import/commit.ts");
    const fn = cp.slice(cp.indexOf("export function closePosition("), cp.indexOf("recordAudit(", cp.indexOf("export function closePosition(")));
    // V4: with the settings default for a closing leg gaining its first quantity.
    expect(fn).toMatch(/= closingAggregate\(t, exitPrice, defaults\);/);
    expect(fn, "no second copy of the closing-leg arithmetic").not.toMatch(/priorQty/);
  });
});

describe("H1 (2) — M2 variant (c): a joined lot whose close is re-made loses the join note and keeps its alias", () => {
  const ACC = 943;
  const SYM = "TRASHX";

  it("L1 100 @200 joined with S1 100 @250; editor sells 60, closePosition closes @255; the sibling pair is AMBIGUOUS", () => {
    newAccount(ACC, "variant-c");
    expect(commit.commitParsedFile(buyFile(SYM, 100, 200, "2026-08-20"), "vc-l1", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sellFile(SYM, 100, 250, "2026-08-25"), "vc-s1", null, ACC).added).toBe(1);
    const [L1, S1] = rowsOf(ACC);
    selectAccount(ACC);
    expect(commit.closeStaleLot(L1.id, S1.id, "2026-08-25").ok).toBe(true);
    const alias = `dedup-alias:${S1.dedupHash}`;
    expect(notesOf(L1.id)).toEqual(expect.arrayContaining([STALE_CLOSE_NOTE, alias]));

    // An edit that changes no exit-leg field keeps the note.
    expect(commit.updateManualTrade(L1.id, { notes: "journal only", setupTag: "vc" }).ok).toBe(true);
    expect(notesOf(L1.id)).toEqual(expect.arrayContaining([STALE_CLOSE_NOTE, alias]));

    expect(commit.updateManualTrade(L1.id, { sellQty: 60 }).ok).toBe(true);
    expect([row(L1.id).isOpen, row(L1.id).sellQty]).toEqual([true, 60]);
    expect(notesOf(L1.id), "the editor re-opened the joined close").not.toContain(STALE_CLOSE_NOTE);
    expect(notesOf(L1.id), "the alias is identity and survives").toContain(alias);

    expect(commit.closePosition(L1.id, 255, "2026-08-26").ok).toBe(true);
    expect([row(L1.id).isOpen, row(L1.id).sellQty, row(L1.id).sellValue]).toEqual([false, 100, 25200]);
    expect(notesOf(L1.id)).not.toContain(STALE_CLOSE_NOTE);
    expect(notesOf(L1.id)).toContain(alias);

    expect(commit.commitParsedFile(buyFile(SYM, 40, 210, "2026-08-22"), "vc-l2", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sellFile(SYM, 40, 255, "2026-08-26"), "vc-s2", null, ACC).added).toBe(1);
    const [, L2, S2] = rowsOf(ACC);
    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId, p.ambiguous, p.oneClick, p.closedLotIds])).toEqual([
      [L2.id, S2.id, true, false, [L1.id]],
    ]);
  });

  it("closePosition drops the note on its own: an open row still carrying it (a pre-H1 edit left it) closes without it", () => {
    const ACC2 = 947;
    newAccount(ACC2, "variant-c-close");
    expect(commit.commitParsedFile(buyFile("VCX", 100, 200, "2026-08-20"), "vcx-buy", null, ACC2).added).toBe(1);
    const [L] = rowsOf(ACC2);
    const aliasHash = "a".repeat(64);
    t.db.update(t.schema.trades).set({ importNotes: withStaleCloseNote("Imported from a pull", aliasHash) }).where(eq(t.schema.trades.id, L.id)).run();
    expect(commit.closePosition(L.id, 250, "2026-08-26").ok).toBe(true);
    expect(notesOf(L.id)).toEqual(["Imported from a pull", `dedup-alias:${aliasHash}`]);
  });

  it("the editor's short mirror: a closed row that reads short (covered after it sold) loses the note on a cover-price edit; a long keeps it", () => {
    const ACC3 = 948;
    newAccount(ACC3, "variant-c-short");
    const roundTrip = (sym: string, buyDate: string, sellDate: string) =>
      parsed([trade({ tradingsymbol: sym, buyQty: 10, avgBuyPrice: 200, buyValue: 2000, sellQty: 10, avgSellPrice: 250, sellValue: 2500, grossPnl: 500, buyDate, sellDate })]);
    expect(commit.commitParsedFile(roundTrip("VCSHORT", "2026-08-25", "2026-08-20"), "vc-short", null, ACC3).added).toBe(1);
    expect(commit.commitParsedFile(roundTrip("VCLONG", "2026-08-20", "2026-08-25"), "vc-long", null, ACC3).added).toBe(1);
    const [short, long] = rowsOf(ACC3);
    for (const r of [short, long]) {
      t.db.update(t.schema.trades).set({ importNotes: withStaleCloseNote(null, "b".repeat(64)) }).where(eq(t.schema.trades.id, r.id)).run();
    }
    expect(commit.updateManualTrade(short.id, { avgBuyPrice: 199 }).ok).toBe(true);
    expect(commit.updateManualTrade(long.id, { avgBuyPrice: 199 }).ok).toBe(true);
    expect(notesOf(short.id)).toEqual([`dedup-alias:${"b".repeat(64)}`]);
    expect(notesOf(long.id)).toEqual([STALE_CLOSE_NOTE, `dedup-alias:${"b".repeat(64)}`]);
  });
});
