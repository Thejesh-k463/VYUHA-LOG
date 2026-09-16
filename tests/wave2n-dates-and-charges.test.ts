import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 fix wave 2N — B-DATES-CHARGES (D2, D3, D4), from the wave-2L re-check's
 * `ipo` unit: new_defects[0] (medium, 2M-introduced), [1] (broken, pre-existing)
 * and [2] (silent wrong number, earlier-4.3.0).
 *
 * D2 — POST /api/ipos compared its link inputs on the RAW stored day against the
 *      NORMALISED one it was about to store, so a notes-only save of a LEGACY
 *      day-first row ('20-02-2026') differed on `acquisitionDate` and was refused
 *      409 (STAGED over a laddered holding, "has a sale recorded in Trades" over a
 *      holding with its own sale). Both sides are folded through the shared
 *      calendar now — and the stored exit date's READABILITY is carried as a flag
 *      computed BEFORE the fold, so Y2's ignore-date allowance keeps firing for a
 *      legacy row exactly as it did (measured by the design reviewer: the bare fold
 *      flips `syncOwnsClose` true → false and a clear-exit save 409s CLOSE_IN_TRADES).
 *
 * D3 — `closePosition` / `applyOverride` / the MTF accrual read the STORED buy and
 *      sell dates raw. A stored '9999-99-99' (what the pre-2L writer made of a typed
 *      '99-99-9999') is an Invalid Date: the close threw
 *      `NOT NULL constraint failed: trades.charges_total_paise` and the accrual
 *      silently ZEROED the row's stored interest, charges and net; a stored
 *      '2026-02-31' rolled forward to 03-03 and billed days the row does not state.
 *
 * D4 — the trade editor re-priced EVERY save, a notes-only one included, because it
 *      prices an allotment as a delivery round trip while the /ipos sync prices it
 *      the IPO way (sell side + the allotment's stamp; no purchase STT is due). So
 *      an IPO-synced holding lost the sync's charges and its provenance marker on
 *      any editor visit, and an IMPORTED row lost the broker's own bill (owner
 *      ruling F1 made general).
 *
 * ONE temp database per FILE (AGENTS.md Testing).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let ipoRoute: typeof import("@/app/api/ipos/route");
let q: typeof import("@/lib/queries/ipos");
let accrual: typeof import("@/lib/jobs/mtf-accrual");
let ipo: typeof import("@/lib/analytics/ipo");
let loadRatesMap: typeof import("@/lib/engine/rates-db").loadRatesMap;
let NOTE: string;

beforeAll(async () => {
  t = await openTempDb("wave2n-dates-and-charges", { seed: true });
  commit = await import("@/lib/import/commit");
  ipoRoute = await import("@/app/api/ipos/route");
  q = await import("@/lib/queries/ipos");
  accrual = await import("@/lib/jobs/mtf-accrual");
  ipo = await import("@/lib/analytics/ipo");
  ({ loadRatesMap } = await import("@/lib/engine/rates-db"));
  ({ IPO_SYNC_CHARGES_NOTE: NOTE } = await import("@/lib/analytics/ipo-link"));
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
}, 120_000);
afterAll(() => t?.cleanup());

const post = (body: unknown) =>
  ipoRoute.POST(new Request("http://local/api/ipos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

let seq = 0;
const trade = (symbol: string, over: Record<string, unknown> = {}) =>
  t.db
    .insert(t.schema.trades)
    .values({
      accountId: 1, broker: "zerodha", bucket: "equity", segment: "eq_delivery", instrumentType: "equity", exchange: "NSE",
      symbol, tradingsymbol: symbol, dedupHash: `w2n-${symbol}-${++seq}`,
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-01-20", isOpen: true,
      ...over,
    })
    .returning({ id: t.schema.trades.id })
    .get()!.id;

const tradeRow = (id: number) => t.db.select().from(t.schema.trades).all().find((r) => r.id === id)!;

const ipoRow = (name: string, over: Record<string, unknown> = {}) =>
  t.db
    .insert(t.schema.ipos)
    .values({ accountId: 1, name, appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, ...over })
    .returning({ id: t.schema.ipos.id })
    .get()!.id;

const named = (name: string) => t.db.select().from(t.schema.ipos).all().filter((r) => r.name === name);

/** IpoForm.save()'s payload: every stored field sent back, verbatim. */
const payload = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id, name, broker: "", exchange: "NSE", board: "mainboard", category: "", discountPerShare: "",
  appliedPrice: "100", lotSize: "10", lotsApplied: "1", allotted: true, allottedQty: 10, listingPrice: "",
  exitPrice: "", appliedDate: "", allotmentDate: "", listingDate: "", exitDate: "", notes: "", ...over,
});

const json = async (res: Response) => (await res.json()) as { ok: boolean; code?: string; message: string };

const HEADS = ["brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty", "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges"] as const;
const chargesOf = (id: number) => {
  const r = tradeRow(id) as unknown as Record<string, number>;
  return Object.fromEntries([...HEADS.map((k) => [k, r[k]]), ["chargesTotal", r.chargesTotal]]);
};

// ===========================================================================
// D2 — the /ipos save compares link inputs on NORMALISED days on both sides
// ===========================================================================

describe("D2 · a legacy day-first allotment day is compared like for like (ipo#0)", () => {
  it("(a) a notes-only save of an IPO linked to a LADDERED holding is saved (200), and the ladder is untouched", async () => {
    const held = trade("D2-LADDER", { staged: true, buyQty: 30, avgBuyPrice: 110, buyValue: 3300 });
    const before = tradeRow(held);
    const id = ipoRow("D2-LADDER", { allottedQty: 30, lotSize: 30, allotmentDate: "20-02-2026", tradeId: held });

    const res = await post(payload(id, "D2-LADDER", { allottedQty: 30, lotSize: "30", allotmentDate: "20-02-2026", notes: "only a note changed" }));
    // THE assertion (HEAD: 409 STAGED, "Record this change on that ladder. Nothing was saved.").
    expect([res.status, (await json(res)).ok]).toEqual([200, true]);
    expect(named("D2-LADDER").map((r) => r.notes)).toEqual(["only a note changed"]);
    expect(tradeRow(held)).toEqual(before);
  });

  it("(b) the same legacy value over a holding with its OWN sale is saved and the holding is left as it is", async () => {
    const held = trade("D2-SOLD", {
      isOpen: false, sellQty: 10, avgSellPrice: 152, sellValue: 1520, sellDate: "2026-03-02", grossPnl: 520, netPnl: 520,
    });
    const before = tradeRow(held);
    const id = ipoRow("D2-SOLD", { allotmentDate: "20-02-2026", exitPrice: 150, exitDate: "2026-03-01", tradeId: held });

    const res = await post(
      payload(id, "D2-SOLD", { allotmentDate: "20-02-2026", exitPrice: "150", exitDate: "2026-03-01", notes: "noted" }),
    );
    const body = await json(res);
    // THE assertion (HEAD: 409 "The linked holding has a sale recorded in Trades…").
    expect([res.status, body.ok]).toEqual([200, true]);
    expect(body.message).toContain("left as it is");
    expect(named("D2-SOLD").map((r) => r.notes)).toEqual(["noted"]);
    expect(tradeRow(held)).toEqual(before);
  });

  it("(c) a legacy day-first EXIT date that IS the trade's ISO sell date: the save syncs the holding", async () => {
    const held = trade("D2-EXITDAY", {
      isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-02-20", grossPnl: 500, netPnl: 500,
    });
    const id = ipoRow("D2-EXITDAY", { allotmentDate: "2026-01-20", exitPrice: 150, exitDate: "20-02-2026", tradeId: held });

    const res = await post(
      payload(id, "D2-EXITDAY", { allotmentDate: "2026-01-20", exitPrice: "150", exitDate: "20-02-2026", notes: "noted" }),
    );
    const body = await json(res);
    // THE assertion (HEAD: 200 but "left as it is" — the sale was never recognised
    // as this IPO's own exit, so the holding kept no charges and no marker).
    expect([res.status, body.ok]).toEqual([200, true]);
    expect(body.message).toContain("cost basis and mark were updated");
    const after = tradeRow(held);
    expect([after.acquisition, after.acquisitionPrice, after.acquisitionDate]).toEqual(["ipo", 100, "2026-01-20"]);
    // …and nothing is invented for it: the record still STORES a day-first exit
    // date, which /ipos itself reads as not yet priced (N13, invariant 6), so the
    // holding keeps no charges and the two pages state the same thing.
    const view = q.getIposComputed().rows.find((r) => r.name === "D2-EXITDAY")!;
    expect([view.unpriced, after.chargesTotal]).toEqual([true, 0]);
  });

  /**
   * The design reviewer's MEASURED trap, and the reason `linkInput` carries
   * `exitDateWasReadable` computed on the RAW value: a BARE fold makes a legacy
   * day-first exit date readable, so `syncOwnsClose` stops ignoring it (Y2) and
   * answers FALSE for a row whose Trades sale was corrected to another day — the
   * sync's OWN charges then freeze on the next re-price, and a clear-exit save
   * 409s CLOSE_IN_TRADES. Green on HEAD by construction (Y2 works today): this is
   * the regression guard for that hunk, proved by reverting the flag alone.
   */
  it("(d) Y2 survives the fold: the sync still owns the close it wrote for a legacy row whose sale sits on another day", async () => {
    const held = trade("D2-Y2", {
      isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02",
      grossPnl: 500, chargesTotal: 5, sttCtt: 5, netPnl: 495, importNotes: NOTE,
    });
    const id = ipoRow("D2-Y2", { allotmentDate: "2026-01-20", exitPrice: 150, exitDate: "20-02-2026", tradeId: held });

    // The user corrects the exit DATE on /ipos to the day the sale is recorded on.
    const res = await post(
      payload(id, "D2-Y2", { allotmentDate: "2026-01-20", exitPrice: "150", exitDate: "2026-03-02", notes: "dated" }),
    );
    expect([res.status, (await json(res)).ok]).toEqual([200, true]);
    const after = tradeRow(held);
    const view = q.getIposComputed().rows.find((r) => r.name === "D2-Y2")!;
    // THE assertion: the charges the sync wrote are re-priced for the corrected
    // exit (on a bare fold they freeze at 5, and /ipos states another net).
    expect([after.chargesTotal, after.netPnl]).toEqual([view.charges, view.netPnl]);
    expect(after.chargesTotal).not.toBe(5);
  });
});

// ===========================================================================
// D3 — a STORED date is resolved through the calendar, or the write is refused
// ===========================================================================

describe("D3 · a stored date that is not a real day prices nothing (ipo#1)", () => {
  it("closePosition refuses a stored buy date of '9999-99-99' with BAD_DATE, and writes nothing", () => {
    const id = trade("D3-CLOSE-NAN", { segment: "eq_mtf", buyDate: "9999-99-99", mtfFundedAmount: 750 });
    const before = tradeRow(id);
    // THE assertion (HEAD: throws `NOT NULL constraint failed: trades.charges_total_paise`).
    const res = commit.closePosition(id, 150, "2026-03-02");
    expect([res.ok, res.code]).toEqual([false, "BAD_DATE"]);
    expect(res.message).toContain("9999-99-99");
    expect(res.message).toContain("buy date");
    expect(tradeRow(id)).toEqual(before);
  });

  it("closePosition refuses a stored '2026-02-31' rather than billing it as 3 March", () => {
    const id = trade("D3-CLOSE-ROLL", { segment: "eq_mtf", buyDate: "2026-02-31", mtfFundedAmount: 750 });
    const before = tradeRow(id);
    const res = commit.closePosition(id, 150, "2026-06-02");
    // THE assertion (HEAD: ok true, MTF interest billed from 2026-03-03).
    expect([res.ok, res.code]).toEqual([false, "BAD_DATE"]);
    expect(res.message).toContain("2026-02-31");
    expect(tradeRow(id)).toEqual(before);
  });

  it("a NULL buy date still closes on the 0-day path, as before", () => {
    const id = trade("D3-CLOSE-NULL", { segment: "eq_mtf", buyDate: null, mtfFundedAmount: 750 });
    expect(commit.closePosition(id, 150, "2026-03-02").ok).toBe(true);
    expect([tradeRow(id).isOpen, tradeRow(id).mtfInterest]).toEqual([false, 0]);
  });

  it("applyOverride refuses a stored bad buy date instead of throwing, and writes nothing", () => {
    const id = trade("D3-OVERRIDE", {
      buyDate: "9999-99-99", isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500,
    });
    const before = tradeRow(id);
    // THE assertion (HEAD: throws the same NOT NULL constraint failure).
    expect(commit.applyOverride(id, { segment: "eq_mtf", isMtf: true })).toBe(false);
    expect(tradeRow(id)).toEqual(before);
  });

  it("the MTF accrual SKIPS a row whose stored buy date states no day — it never zeroes its stored money", () => {
    const nan = trade("D3-ACCRUAL-NAN", {
      segment: "eq_mtf", buyDate: "9999-99-99", mtfFundedAmount: 16000, mtfInterest: 100, chargesTotal: 150, grossPnl: 0, netPnl: -150,
    });
    const roll = trade("D3-ACCRUAL-ROLL", {
      segment: "eq_mtf", buyDate: "2026-02-31", mtfFundedAmount: 16000, mtfInterest: 100, chargesTotal: 150, grossPnl: 0, netPnl: -150,
    });
    const beforeNan = tradeRow(nan);
    const beforeRoll = tradeRow(roll);

    accrual.accrueMtfInterest("2026-09-15");

    // THE assertions (HEAD: '9999-99-99' → 0 days, so interest 100 → 0 and the
    // stored charges/net move with it; '2026-02-31' → 199 days and ₹636.80 billed).
    expect(tradeRow(nan)).toEqual(beforeNan);
    expect(tradeRow(roll)).toEqual(beforeRoll);
  });

  it("the re-tag dialog states the refusal rather than swallowing it", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/trades/trades-client.tsx"), "utf8");
    // The same calendar the save reads, from the pure module both graphs reach.
    expect(src).toMatch(/storedDateProblem/);
    expect(src).toMatch(/from "@\/lib\/domain\/trading-day"/);
  });
});

// ===========================================================================
// D4 — the editor re-prices only when a charge INPUT changed, and prices an
//      acquisition:'ipo' row the way the IPO model does
// ===========================================================================

describe("D4 · a save that changes no charge input changes no charge (ipo#2)", () => {
  /** An open holding + the IPO record that became it, synced to a priced exit. */
  const synced = async (name: string, exitPrice = "150") => {
    const held = trade(name);
    const id = ipoRow(name, { allotmentDate: "2026-01-20", tradeId: held });
    const res = await post(payload(id, name, { allotmentDate: "2026-01-20", exitPrice, exitDate: "2026-03-02" }));
    expect(res.status).toBe(200);
    return { held, id };
  };

  it("a notes-only editor save keeps the sync's charges AND its provenance marker", async () => {
    const { held } = await synced("D4-NOTES");
    const before = chargesOf(held);
    const beforeRow = tradeRow(held);
    expect(beforeRow.importNotes ?? "").toContain(NOTE);

    expect(commit.updateManualTrade(held, { notes: "a note" }).ok).toBe(true);

    const after = tradeRow(held);
    // THE assertions (HEAD: chargesTotal 37.97 → 52.72 with purchase STT added,
    // and importNotes emptied of the marker).
    expect(chargesOf(held)).toEqual(before);
    expect([after.netPnl, after.grossPnl]).toEqual([beforeRow.netPnl, beforeRow.grossPnl]);
    expect(after.importNotes ?? "").toContain(NOTE);
    expect(after.notes).toBe("a note");
  });

  it("after that notes save the next /ipos exit edit still re-prices the holding", async () => {
    const { held, id } = await synced("D4-REPRICE");
    const first = tradeRow(held).chargesTotal;
    expect(commit.updateManualTrade(held, { notes: "a note" }).ok).toBe(true);

    const res = await post(payload(id, "D4-REPRICE", { allotmentDate: "2026-01-20", exitPrice: "500", exitDate: "2026-03-02" }));
    expect(res.status).toBe(200);
    const after = tradeRow(held);
    const view = q.getIposComputed().rows.find((r) => r.name === "D4-REPRICE")!;
    // THE assertions (HEAD: the charges freeze at the ₹1,500 sale's figure while
    // price, gross and net follow the ₹5,000 one, and /ipos states another net).
    expect([after.avgSellPrice, after.sellValue, after.grossPnl]).toEqual([500, 5000, 4000]);
    expect(after.chargesTotal).not.toBe(first);
    expect([after.chargesTotal, after.netPnl]).toEqual([view.charges, view.netPnl]);
  });

  it("when it DOES re-price an acquisition:'ipo' holding it prices it as the IPO model does — no purchase STT", async () => {
    // The record names the holding's own broker, so record and holding state the
    // same facts and the two pricings are comparable figure for figure.
    const held = trade("D4-IPO-PRICE");
    const id = ipoRow("D4-IPO-PRICE", { broker: "zerodha", allotmentDate: "2026-01-20", tradeId: held });
    expect(
      (await post(payload(id, "D4-IPO-PRICE", { broker: "zerodha", allotmentDate: "2026-01-20", exitPrice: "150", exitDate: "2026-03-02" }))).status,
    ).toBe(200);

    expect(commit.updateManualTrade(held, { avgSellPrice: 160 }).ok).toBe(true);
    const after = tradeRow(held) as unknown as Record<string, number>;

    // The independent oracle: the /ipos model over the same facts (computeIpo +
    // the account's own charger), which is what the sync and the listing read.
    const oracle = ipo.computeIpo(
      {
        id: 0, name: "D4-IPO-PRICE", broker: "zerodha", exchange: "NSE", appliedPrice: 100, lotSize: 10, lotsApplied: 1,
        allotted: true, allottedQty: 10, listingPrice: null, exitPrice: 160, allotmentDate: "2026-01-20", exitDate: "2026-03-02",
      },
      q.sellChargerFor("zerodha", "NSE", "2026-03-02", loadRatesMap()),
    );
    // THE assertions (HEAD: the editor prices an allotment as a delivery ROUND
    // TRIP, so sttCtt carries purchase STT the allottee does not owe).
    expect(after.sttCtt).toBe(oracle.chargeBreakdown!.sttCtt);
    expect(after.chargesTotal).toBe(oracle.charges);
    expect(tradeRow(held).importNotes ?? "").not.toContain(NOTE);
  });

  it("an imported row with the BROKER's own charges keeps every one of them on a notes-only save (F1)", () => {
    const id = trade("D4-IMPORTED", {
      isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02",
      grossPnl: 500, chargesTotal: 41.25, brokerage: 20, sttCtt: 15, exchangeTxn: 0.5, sebi: 0.15, stampDuty: 1,
      ipft: 0.1, gst: 4.5, dpCharges: 0, netPnl: 458.75, importNotes: "dedup-alias:abc",
    });
    const before = chargesOf(id);

    expect(commit.updateManualTrade(id, { notes: "journal only" }).ok).toBe(true);

    // THE assertions (HEAD: all ten heads replaced by the engine's estimate).
    expect(chargesOf(id)).toEqual(before);
    expect([tradeRow(id).netPnl, tradeRow(id).importNotes]).toEqual([458.75, "dedup-alias:abc"]);
  });

  it("a risk-amount-only edit keeps the charges and recomputes R from the KEPT net", () => {
    const id = trade("D4-RISK", {
      isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02",
      grossPnl: 500, chargesTotal: 41.25, brokerage: 20, sttCtt: 15, exchangeTxn: 0.5, sebi: 0.15, stampDuty: 1,
      ipft: 0.1, gst: 4.5, netPnl: 458.75, riskAmount: 200, rMultiple: 2.29,
    });
    const before = chargesOf(id);

    expect(commit.updateManualTrade(id, { riskAmount: 100 }).ok).toBe(true);

    const after = tradeRow(id);
    // THE assertions: the money is the user's (F1), R follows the new risk.
    expect(chargesOf(id)).toEqual(before);
    expect([after.netPnl, after.riskAmount, after.rMultiple]).toEqual([458.75, 100, 4.59]);
  });
});
