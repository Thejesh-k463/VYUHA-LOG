import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq as eqOf } from "drizzle-orm";
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

  /**
   * D15 (v4.3.0 fix wave 2O, dates-charges#2, pre-existing) — AN UN-EXITED
   * ALLOTMENT IS BILLED NOTHING.
   *
   * `ipoHoldingCharges` returns null for a row with no sale, so `ipoEditCharges`
   * returned null and the save fell back to `computeCharges`, which prices the
   * allotment as an exchange PURCHASE; and because the /ipos sync writes no charges
   * for an OPEN holding, such a row states no charge at all — which
   * `statesNoCharges` makes a forced re-price on ANY save. A 10 @100 allotment
   * therefore got sttCtt 1, exchangeTxn 0.03, gst 0.01, chargesTotal 1.04 and
   * netPnl −1.04 written the first time the user saved a NOTE on it: money the
   * journal fabricates, against ruling row (1) (no purchase STT is due on an
   * allotment) and invariant 6.
   *
   * The IPO model prices an un-exited allotment at NOTHING, so the no-sale branch
   * returns the row's stored heads and drives the net AND the marker down the
   * not-repriced path. The engine fallback is never reached for an
   * allotment-derived row on any door (the preview takes the same branch, D14).
   */
  describe("D15 · an OPEN allotment is never billed purchase STT (dates-charges#2)", () => {
    const openAllotment = (symbol: string, over: Record<string, unknown> = {}) =>
      trade(symbol, {
        acquisition: "ipo", acquisitionPrice: 100, acquisitionDate: "2026-07-15",
        buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-07-15", isOpen: true,
        importNotes: "dedup-alias:xyz | " + NOTE,
        ...over,
      });
    const ZERO = Object.fromEntries([...HEADS.map((k) => [k, 0]), ["chargesTotal", 0]]);

    it("(a) a notes-only save leaves the ten heads, the total, the net and importNotes byte-identical", () => {
      const id = openAllotment("D15-NOTES");
      const before = tradeRow(id);
      expect(chargesOf(id)).toEqual(ZERO);

      expect(commit.updateManualTrade(id, { notes: "journal only" }).ok).toBe(true);

      const after = tradeRow(id);
      // THE assertions (HEAD: sttCtt 1, exchangeTxn 0.03, gst 0.01,
      // chargesTotal 1.04, netPnl -1.04, and the marker stripped).
      expect(chargesOf(id)).toEqual(ZERO);
      expect([after.netPnl, after.grossPnl]).toEqual([before.netPnl, before.grossPnl]);
      expect(after.importNotes).toBe(before.importNotes);
      expect(after.notes).toBe("journal only");
    });

    it("(b) a QUANTITY correction bills nothing either — the allotment is not a purchase on an exchange", () => {
      const id = openAllotment("D15-QTY");
      const before = tradeRow(id);

      expect(commit.updateManualTrade(id, { buyQty: 20, avgBuyPrice: 100 }).ok).toBe(true);

      const after = tradeRow(id);
      // THE assertions (HEAD: sttCtt 2, chargesTotal 2.07, netPnl -2.07).
      expect(chargesOf(id)).toEqual(ZERO);
      expect([after.buyQty, after.buyValue]).toEqual([20, 2000]);
      expect([after.netPnl, after.importNotes]).toEqual([before.netPnl, before.importNotes]);
    });

    it("(c) a NON-ipo row stating no charges is still priced on its first editor save", () => {
      const id = trade("D15-PLAIN", { isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500 });
      expect(commit.updateManualTrade(id, { notes: "journal only" }).ok).toBe(true);
      // Unchanged: `statesNoCharges` still prices a manual row, or an import whose
      // file carried no charge columns, on its first save.
      expect(tradeRow(id).chargesTotal).toBeGreaterThan(0);
    });
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

// ===========================================================================
// v4.3.0 fix wave 2O — B2O-DATES (D17, D20)
// ===========================================================================

/**
 * D17 (dates-charges#4, pre-existing) — THE THIRD WRITER REFUSES A STORED DATE
 * THAT STATES NO DAY.
 *
 * `updateManualTrade` computes `daysHeld` from `new Date(sellDate) − new
 * Date(buyDate)` where each side falls back to the STORED column when the patch
 * omits that field, with no `storedDateProblem` guard — so for an eq_mtf row
 * storing buy_date '9999-99-99', a patch that changes a price without sending the
 * dates took NaN into `computeCharges` and died with the
 * `NOT NULL constraint failed: trades.charges_total_paise` D3 removed from
 * `closePosition` (:1896) and `applyOverride` (:2625). `lib/domain/trading-day.ts`
 * already promised "ONE implementation for the three writers" and named two.
 */
describe("D17 · the editor refuses a stored date that states no day (dates-charges#4)", () => {
  const badStored = (symbol: string, over: Record<string, unknown> = {}) =>
    trade(symbol, {
      segment: "eq_mtf", buyDate: "9999-99-99", isOpen: false,
      sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02",
      mtfFundedAmount: 16000, grossPnl: 500, chargesTotal: 41.25, sttCtt: 15, netPnl: 458.75,
      ...over,
    });
  const SENTENCE =
    "This trade's stored buy date “9999-99-99” is not a real calendar day, so nothing can be priced from it. Correct the date in Edit trade first. Nothing was changed.";

  it("a price-only patch is refused with the shared sentence, and nothing is written", () => {
    const id = badStored("D17-PRICE");
    const before = tradeRow(id);

    // THE assertion (HEAD: this THROWS `NOT NULL constraint failed:
    // trades.charges_total_paise` — a 500, not an {ok:false}).
    expect(commit.updateManualTrade(id, { avgSellPrice: 160 })).toEqual({ ok: false, message: SENTENCE });
    expect(tradeRow(id)).toEqual(before);
  });

  it("a patch that CLEARS the unreadable date still saves, and one that SENDS a bad value is refused as before", () => {
    const id = badStored("D17-CLEAR");
    // Blank means clear, as every other field in this form does — the UI's own path.
    expect(commit.updateManualTrade(id, { buyDate: null, avgSellPrice: 160 }).ok).toBe(true);
    expect([tradeRow(id).buyDate, tradeRow(id).avgSellPrice]).toEqual([null, 160]);

    const other = badStored("D17-TYPED");
    const res = commit.updateManualTrade(other, { buyDate: "2026-02-31" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("2026-02-31");
    expect(tradeRow(other).buyDate).toBe("9999-99-99");
  });

  it("a NULL buy date is an unanswered field, not an unreadable one: it still saves at 0 days", () => {
    const id = badStored("D17-NULL", { buyDate: null });
    expect(commit.updateManualTrade(id, { avgSellPrice: 160 }).ok).toBe(true);
    expect(tradeRow(id).mtfInterest).toBe(0);
  });
});

/**
 * D20 (the owed guard, found by B2O-MTF; the reviewer's own rule "no third writer
 * may patch a staged parent") — after D6/D7 the ladder (`rebuildStagedTrade`) is
 * the SINGLE writer of a staged row's priced heads (invariant 5: parent = Σ legs).
 *
 * `updateManualTrade` (~:2404) and `applyOverride` (~:2617) wrote them directly
 * with no `staged` guard, while `closePosition` (~:1912), `closeStaleLot` and the
 * /ipos route all refuse a staged row: the editor's save rewrote the parent from
 * the flat aggregate with no knowledge of legs, and `statesNoCharges` made it fire
 * on a notes-only save.
 */
describe("D20 · a staged position's charges are written only by its ladder", () => {
  let staged: typeof import("@/lib/queries/staged");
  beforeAll(async () => {
    staged = await import("@/lib/queries/staged");
  });

  const ladder = (symbol: string) => {
    const id = trade(symbol, { staged: true });
    t.db
      .insert(t.schema.tradeLegs)
      .values([
        { tradeId: id, kind: "entry", seq: 1, tradeDate: "2026-01-20", qty: 10, price: 100 },
        { tradeId: id, kind: "entry", seq: 2, tradeDate: "2026-02-10", qty: 10, price: 120 },
      ])
      .run();
    expect(staged.rebuildStagedTrade(id).ok, symbol).toBe(true);
    return id;
  };
  const legTotal = (id: number) =>
    Math.round(
      t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === id).reduce((s, l) => s + l.chargesTotal, 0) * 100,
    ) / 100;
  /** The editor's own fields for a row it has not changed a number on. */
  const untouched = (id: number) => {
    const r = tradeRow(id);
    return { buyQty: r.buyQty, avgBuyPrice: r.avgBuyPrice, buyDate: r.buyDate, sellQty: r.sellQty, avgSellPrice: r.avgSellPrice, sellDate: r.sellDate };
  };

  it("(a) a notes-only save stores the note, and every priced head stays the ladder's", () => {
    const id = ladder("D20-NOTES");
    const before = tradeRow(id);
    const beforeCharges = chargesOf(id);
    expect(before.chargesTotal).toBe(legTotal(id));
    expect(before.chargesTotal).toBeGreaterThan(0);

    expect(commit.updateManualTrade(id, { ...untouched(id), notes: "journal only", setupTag: "breakout" }).ok).toBe(true);

    const after = tradeRow(id);
    // THE assertions: the note landed, and not one priced head moved off the ladder.
    expect([after.notes, after.setupTag]).toEqual(["journal only", "breakout"]);
    expect(chargesOf(id)).toEqual(beforeCharges);
    expect(after.chargesTotal).toBe(legTotal(id));
    expect([after.buyQty, after.avgBuyPrice, after.buyValue, after.netPnl, after.mtfInterest]).toEqual([
      before.buyQty, before.avgBuyPrice, before.buyValue, before.netPnl, before.mtfInterest,
    ]);
  });

  it("(a2) a staged row that STATES no charges is priced by the ladder, never by the flat engine", () => {
    // The reachable shape: a legacy staged row whose heads a release zeroed (Q-A's
    // release-once write, wave 2N), or one written before the ladder priced it.
    // `statesNoCharges` makes ANY save a forced re-price, and this writer had no
    // knowledge of legs — so a notes-only save priced the whole position as one
    // flat round trip and the parent stopped equalling Σ legs.
    const id = ladder("D20-ZEROED");
    const legs = legTotal(id);
    t.db
      .update(t.schema.trades)
      .set({ chargesTotal: 0, brokerage: 0, sttCtt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, ipft: 0, gst: 0, dpCharges: 0, mtfInterest: 0, pledgeCharges: 0, netPnl: 0 })
      .where(eqOf(t.schema.trades.id, id))
      .run();
    expect(tradeRow(id).chargesTotal).toBe(0);

    expect(commit.updateManualTrade(id, { ...untouched(id), notes: "journal only" }).ok).toBe(true);

    // THE assertions (HEAD: the flat engine's own bill for a 20 @110 round trip,
    // stamp duty billed once on the aggregate, against legs that state each
    // tranche's — parent 2.2 beside legs 3.2, measured).
    expect(tradeRow(id).chargesTotal).toBe(legs);
    expect(tradeRow(id).chargesTotal).toBe(legTotal(id));
    expect(tradeRow(id).notes).toBe("journal only");
  });

  /**
   * (a3) THE SHAPE THE WAVE 2O SEAM PASS MEASURED (`wave2o-seams.md` §5 defect 2,
   * fixH H7): a ladder whose weighted average does NOT round exactly. (a) and (a2)
   * above are built at 10 @100 + 10 @120, whose average (110) times its quantity
   * (20) IS the stored 2,200 — so they passed while D20's refusal was derived from a
   * RECOMPUTED `buyValue`, and every ladder built at two prices that round unevenly
   * was refused every save: notes, setup tag, stop, target, risk and the mark.
   *
   * 100 @100 + 50 @110 rolls up to `[buyQty 150, avgBuyPrice 103.33, buyValue
   * 15500]` while `r2(150 × 103.33)` is 15,499.50. The refusal is now decided by the
   * PATCH (`patchMovesChargeInput`, lib/domain/trade-edit.ts), and the roll-up is
   * written back verbatim rather than re-derived.
   */
  it("(a3) a notes-only save lands on a ladder whose weighted average does not round exactly, and its roll-up is untouched", () => {
    const id = trade("D20-ROUNDING", { staged: true });
    t.db
      .insert(t.schema.tradeLegs)
      .values([
        { tradeId: id, kind: "entry", seq: 1, tradeDate: "2026-01-20", qty: 100, price: 100 },
        { tradeId: id, kind: "entry", seq: 2, tradeDate: "2026-02-10", qty: 50, price: 110 },
      ])
      .run();
    expect(staged.rebuildStagedTrade(id).ok).toBe(true);
    const before = tradeRow(id);
    const beforeCharges = chargesOf(id);
    // The premise of the defect, measured on the fixture itself.
    expect(
      [before.buyQty, before.avgBuyPrice, before.buyValue, Math.round(before.buyQty * before.avgBuyPrice * 100) / 100],
      "the parent's roll-up is not its own rounded average × quantity",
    ).toEqual([150, 103.33, 15500, 15499.5]);

    const res = commit.updateManualTrade(id, { ...untouched(id), notes: "journal only", setupTag: "breakout" });

    // THE assertions (before the fix: {ok:false} with "This is a staged position
    // built from more than one fill…" and nothing saved, through BOTH doors).
    expect([res.ok, res.message]).toEqual([true, "Trade updated."]);
    const after = tradeRow(id);
    expect([after.notes, after.setupTag]).toEqual(["journal only", "breakout"]);
    // …and the 50 paise of rounding never reached the cost basis.
    expect([after.buyQty, after.avgBuyPrice, after.buyValue, after.netPnl]).toEqual([
      before.buyQty, before.avgBuyPrice, before.buyValue, before.netPnl,
    ]);
    expect(chargesOf(id)).toEqual(beforeCharges);
    expect(after.chargesTotal).toBe(legTotal(id));

    // The other half of D20 on the SAME row: a patch that really moves a fill is
    // still refused, so the fix widened nothing beyond the journal fields.
    const priced = commit.updateManualTrade(id, { ...untouched(id), avgBuyPrice: 130 });
    expect([priced.ok, priced.message.includes("staged position built from more than one fill")]).toEqual([false, true]);
    expect(tradeRow(id)).toEqual(after);
  });

  it("(b) a patch that moves a charge input on a staged row is refused, and nothing is written", () => {
    const id = ladder("D20-PRICE");
    const before = tradeRow(id);

    const res = commit.updateManualTrade(id, { ...untouched(id), avgBuyPrice: 130 });
    // THE assertions (HEAD: {ok:true} and the parent rewritten from the flat
    // aggregate — buyValue 2600 beside legs that state 2200).
    expect(res.ok).toBe(false);
    expect(res.message).toContain("This is a staged position built from more than one fill");
    expect(res.message).toContain("Nothing was changed.");
    expect(tradeRow(id)).toEqual(before);
    expect(before.chargesTotal).toBe(legTotal(id));
  });

  it("(c) applyOverride on a staged row is refused the same way, and writes no override row", () => {
    const id = ladder("D20-OVERRIDE");
    const before = tradeRow(id);
    const overrides = () => t.db.select().from(t.schema.classificationOverrides).all().length;
    const n = overrides();

    // THE assertions (HEAD: true, the parent re-priced as a flat eq_mtf round trip).
    expect(commit.applyOverride(id, { segment: "eq_mtf" })).toBe(false);
    expect(tradeRow(id)).toEqual(before);
    expect(overrides()).toBe(n);
  });
});
