import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { planLotCloses, splitByRemainder, type IncomingRow, type OpenLot } from "@/lib/import/close-open-lots";
import { todayIstIso } from "@/lib/domain/trading-day";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * R5 (v4.2.1) — a pull or a file that SELLS something this account is already
 * long closes that position FIFO instead of opening a short beside it.
 *
 * Before this, `is_open` was decided one row at a time (`buyQty !== sellQty`)
 * and FIFO existed only inside one parsed file, so the book could hold a long
 * 100 and a short 40 in the same symbol, with no realised P&L anywhere.
 *
 * ONE temp database per FILE (AGENTS.md) — `lib/db` caches its connection on
 * globalThis — so every case below uses its own account id instead.
 */

let t: TempDb;
let commit: typeof import("@/lib/import/commit");

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

/** A buy-only row: an open long once committed. */
const buyRow = (symbol: string, qty: number, price: number, date: string) =>
  trade({ tradingsymbol: symbol, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date });

/** A sell-only row: the closing leg this ruling is about (or an open short). */
const sellRow = (symbol: string, qty: number, price: number, date: string) =>
  trade({ tradingsymbol: symbol, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date });

function parsed(trades: NormalizedTrade[]): ParsedFile {
  return { sourceId: "dhan-gtr", broker: "dhan", format: "tradebook", trades, warnings: [] };
}

function newAccount(id: number, name: string) {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
}

const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all();

beforeAll(async () => {
  t = await openTempDb("auto-close-fifo", { seed: true });
  commit = await import("@/lib/import/commit");
}, 120_000);
afterAll(() => t?.cleanup());

// ───────────────────────────── the pure planner ─────────────────────────────

describe("planLotCloses — the decision, with no database in sight", () => {
  const lot = (over: Partial<OpenLot> & { id: number }): OpenLot => ({
    accountId: 1,
    broker: "dhan",
    tradingsymbol: "TCS",
    segment: "eq_delivery",
    exchange: "NSE",
    side: "long",
    qty: 100,
    price: 100,
    value: 10000,
    charges: 20,
    date: "2026-04-01",
    ...over,
  });
  const row = (over: Partial<IncomingRow> & { key: string }): IncomingRow => ({
    accountId: 1,
    broker: "dhan",
    tradingsymbol: "TCS",
    segment: "eq_delivery",
    exchange: "NSE",
    side: "sell",
    qty: 40,
    price: 120,
    value: 4800,
    charges: 10,
    date: "2026-05-01",
    ...over,
  });

  it("takes the OLDEST lot first, and splits it by quantity", () => {
    const plan = planLotCloses(
      [lot({ id: 2, qty: 50, value: 5500, price: 110, date: "2026-04-10" }), lot({ id: 1, qty: 50, value: 5000 })],
      [row({ key: "s1", qty: 70, value: 8400 })],
    );
    expect(plan.closes.map((c) => [c.lotId, c.qty])).toEqual([[1, 50], [2, 20]]);
    expect(plan.closes[0].fullyConsumed).toBe(true);
    expect(plan.closes[1].fullyConsumed).toBe(false);
    expect(plan.remainders).toEqual([
      { lotId: 1, qty: 0, value: 0, charges: 0 },
      { lotId: 2, qty: 30, value: 3300, charges: 12 },
    ]);
    expect(plan.untouched).toEqual([]);
  });

  it("only ever matches the OPPOSITE side", () => {
    expect(planLotCloses([lot({ id: 1 })], [row({ key: "b1", side: "buy" })]).closes).toEqual([]);
    expect(planLotCloses([lot({ id: 1, side: "short", qty: 40 })], [row({ key: "s1" })]).closes).toEqual([]);
    expect(planLotCloses([lot({ id: 1, side: "short", qty: 40 })], [row({ key: "b1", side: "buy" })]).closes)
      .toHaveLength(1);
  });

  it("never crosses an account, a broker, a symbol or a segment", () => {
    const l = lot({ id: 1 });
    expect(planLotCloses([l], [row({ key: "a", accountId: 2 })]).closes).toEqual([]);
    expect(planLotCloses([l], [row({ key: "b", broker: "zerodha" })]).closes).toEqual([]);
    expect(planLotCloses([l], [row({ key: "c", tradingsymbol: "INFY" })]).closes).toEqual([]);
    expect(planLotCloses([l], [row({ key: "d", segment: "eq_intraday" })]).closes).toEqual([]);
    expect(planLotCloses([l], [row({ key: "e", exchange: "BSE" })]).closes).toEqual([]);
  });

  it("reports the quantity that closed nothing, and leaves the input untouched", () => {
    const lots = [lot({ id: 1, qty: 30, value: 3000 })];
    const plan = planLotCloses(lots, [row({ key: "s1", qty: 100, value: 12000 })]);
    expect(plan.closes).toHaveLength(1);
    expect(plan.untouched).toEqual([{ key: "s1", qty: 70 }]);
    expect(lots[0].qty, "the planner is pure — it may not mutate the book").toBe(30);
  });
});

describe("splitByRemainder — one component, two parts, never a paisa invented", () => {
  it("the slice takes its rounded share and the remainder takes what is LEFT", () => {
    // The two figures the round-2 audit named: independent rounding turned
    // ₹1.25 sold half into ₹1.26, and a ₹0.01 SEBI fee into ₹0.02.
    expect(splitByRemainder(1.25, 0.5)).toEqual({ slice: 0.63, keep: 0.62 });
    expect(splitByRemainder(0.01, 0.5)).toEqual({ slice: 0.01, keep: 0 });
    expect(splitByRemainder(20, 0.4)).toEqual({ slice: 8, keep: 12 });
    expect(splitByRemainder(0.01, 1), "a whole take leaves nothing behind").toEqual({ slice: 0.01, keep: 0 });
    expect(splitByRemainder(0, 0.5)).toEqual({ slice: 0, keep: 0 });
  });

  it("holds for EVERY paise figure a 50/50 split can meet", () => {
    for (let paise = 0; paise <= 500; paise++) {
      const total = r2(paise / 100);
      const { slice, keep } = splitByRemainder(total, 0.5);
      expect(r2(slice + keep), `${total} split in half`).toBe(total);
    }
  });
});

// ─────────────────────── case 1: partial close of a long ────────────────────

describe("1 — long 100 open, incoming SELL 40", () => {
  const ACC = 601;
  const fileA = parsed([buyRow("TCS", 100, 100, "2026-04-01")]);
  const fileB = parsed([sellRow("TCS", 40, 120, "2026-05-01")]);
  let entryCharges = 0;
  let exitCharges = 0;

  it("the buy lands as an open long", () => {
    newAccount(ACC, "case-1");
    expect(commit.commitParsedFile(fileA, "buys.csv", null, ACC).added).toBe(1);
    const [open] = rowsOf(ACC);
    expect(open.isOpen).toBe(true);
    expect(open.buyQty).toBe(100);
    entryCharges = open.chargesTotal;
  });

  it("7 — the preview says how many open positions the file would close", () => {
    const p = commit.previewParsedFile(fileB, null, ACC);
    expect(p.autoClose?.closes).toBe(1);
    expect(p.autoClose?.positions).toEqual([{ symbol: "TCS", qty: 40 }]);
    exitCharges = p.rows[0].chargesTotal;
  });

  it("closes 40 of it: the open row is reduced to 60 and ONE closed row appears", () => {
    const res = commit.commitParsedFile(fileB, "sells.csv", null, ACC);
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);

    const open = rows.filter((r) => r.isOpen);
    expect(open).toHaveLength(1);
    expect(open[0].buyQty).toBe(60);
    expect(open[0].buyValue).toBe(6000);
    expect(open[0].sellQty, "the reduced lot is still a pure long").toBe(0);

    const closed = rows.filter((r) => !r.isOpen);
    expect(closed).toHaveLength(1);
    expect(closed[0].buyQty).toBe(40);
    expect(closed[0].sellQty).toBe(40);
    expect(closed[0].avgBuyPrice).toBe(100);
    expect(closed[0].avgSellPrice).toBe(120);
    expect(closed[0].buyDate).toBe("2026-04-01");
    expect(closed[0].sellDate).toBe("2026-05-01");
    // Realised: (sell − buy) × 40, minus the charges the closing leg carries.
    expect(closed[0].grossPnl).toBe(800);
    expect(closed[0].netPnl).toBe(r2(800 - closed[0].chargesTotal));
    expect(res.warnings?.join(" | ")).toMatch(/1 open position in this account was closed by this file/);
  });

  it("and the incoming row is NOT a new open short", () => {
    const shorts = rowsOf(ACC).filter((r) => r.isOpen && r.sellQty > 0 && r.buyQty === 0);
    expect(shorts).toEqual([]);
  });

  it("the charges are conserved: entry + exit, EXACTLY, no paisa counted twice", () => {
    const rows = rowsOf(ACC);
    const total = r2(rows.reduce((s, r) => s + r.chargesTotal, 0));
    // M-1 (round 2): exact, not toBeCloseTo(…, 1). A tolerance of half a rupee
    // cannot see the defect this pins — the slice and the remainder rounding
    // the same component independently and both keeping the paisa.
    expect(total, "entry + exit, to the paisa").toBe(r2(entryCharges + exitCharges));
    const closed = rows.find((r) => !r.isOpen)!;
    const open = rows.find((r) => r.isOpen)!;
    expect(r2(closed.chargesTotal + open.chargesTotal)).toBe(total);
    expect(closed.chargesTotal).toBeCloseTo(r2(entryCharges * 0.4 + exitCharges), 1);
  });

  it("writes one audit entry per close", () => {
    const closed = rowsOf(ACC).find((r) => !r.isOpen)!;
    const audit = t.db.select().from(t.schema.auditLog).all()
      .filter((a) => a.entity === "trade" && a.action === "close" && a.entityId === closed.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].summary).toMatch(/TCS closed 40 @ 120 by import/);
  });
});

// ───────────────────── case 2: FIFO across two open lots ────────────────────

describe("2 — lots of 50 (older) and 50 (newer), incoming SELL 70", () => {
  const ACC = 602;

  it("consumes the older lot whole and leaves 30 of the newer one", () => {
    newAccount(ACC, "case-2");
    commit.commitParsedFile(
      parsed([buyRow("INFY", 50, 100, "2026-04-01"), buyRow("INFY", 50, 110, "2026-04-10")]),
      "buys.csv", null, ACC,
    );
    commit.commitParsedFile(parsed([sellRow("INFY", 70, 120, "2026-05-01")]), "sells.csv", null, ACC);

    const rows = rowsOf(ACC).sort((a, b) => a.id - b.id);
    expect(rows).toHaveLength(3);

    const older = rows[0];
    expect(older.isOpen, "the older lot went entirely").toBe(false);
    expect(older.buyQty).toBe(50);
    expect(older.sellQty).toBe(50);
    expect(older.avgSellPrice).toBe(120);
    expect(older.grossPnl).toBe(1000); // (120 − 100) × 50

    const newer = rows[1];
    expect(newer.isOpen).toBe(true);
    expect(newer.buyQty).toBe(30);
    expect(newer.buyValue).toBe(3300);

    const slice = rows[2];
    expect(slice.isOpen).toBe(false);
    expect(slice.buyQty).toBe(20);
    expect(slice.avgBuyPrice).toBe(110);
    expect(slice.grossPnl).toBe(200); // (120 − 110) × 20
  });
});

// ─────────────────────── case 3: covering a short lot ───────────────────────

describe("3 — short 100 open, incoming BUY 100", () => {
  const ACC = 603;

  it("covers it in place, with the realised sign the right way round", () => {
    newAccount(ACC, "case-3");
    commit.commitParsedFile(parsed([sellRow("NIFTY26MAY", 100, 100, "2026-04-01")]), "short.csv", null, ACC);
    expect(rowsOf(ACC)[0].isOpen).toBe(true);

    commit.commitParsedFile(parsed([buyRow("NIFTY26MAY", 100, 90, "2026-04-02")]), "cover.csv", null, ACC);
    const rows = rowsOf(ACC);
    expect(rows, "a cover completes the row, it does not add one").toHaveLength(1);
    const r = rows[0];
    expect(r.isOpen).toBe(false);
    expect(r.sellQty).toBe(100);
    expect(r.buyQty).toBe(100);
    expect(r.sellDate, "the open leg keeps its own date").toBe("2026-04-01");
    expect(r.buyDate, "the cover is the closing leg").toBe("2026-04-02");
    // Sold at 100, bought back at 90: a short that made money.
    expect(r.grossPnl).toBe(1000);
    expect(r.netPnl).toBe(r2(1000 - r.chargesTotal));
  });
});

// ──────────────── case 4: charges once, against the manual path ─────────────

describe("4 — the closing leg's charges, measured against closePosition", () => {
  const AUTO = 604;
  const MANUAL = 605;

  it("counts entry + exit exactly once, and lands where the manual close lands", () => {
    newAccount(AUTO, "case-4-auto");
    newAccount(MANUAL, "case-4-manual");
    const buys = () => parsed([buyRow("WIPRO", 100, 100, "2026-04-01")]);

    commit.commitParsedFile(buys(), "buys.csv", null, AUTO);
    const entryCharges = rowsOf(AUTO)[0].chargesTotal;
    const exitCharges = commit.previewParsedFile(
      parsed([sellRow("WIPRO", 100, 120, "2026-05-01")]), null, AUTO,
    ).rows[0].chargesTotal;
    commit.commitParsedFile(parsed([sellRow("WIPRO", 100, 120, "2026-05-01")]), "sells.csv", null, AUTO);

    commit.commitParsedFile(buys(), "buys.csv", null, MANUAL);
    const manualId = rowsOf(MANUAL)[0].id;
    expect(commit.closePosition(manualId, 120, "2026-05-01").ok).toBe(true);

    const auto = rowsOf(AUTO)[0];
    const manual = rowsOf(MANUAL)[0];

    // ONCE: the closed row carries the entry charges it inherited plus the
    // exit charges of the incoming row — nothing else, and nothing twice.
    expect(auto.chargesTotal).toBeCloseTo(r2(entryCharges + exitCharges), 1);
    expect(rowsOf(AUTO)).toHaveLength(1);

    // The manual path re-prices the whole pair from scratch, so the two agree
    // to within the statutory rupee-rounding of STT and stamp duty, which is
    // applied per call (lib/engine/charges.ts roundRupee).
    expect(auto.grossPnl).toBe(manual.grossPnl);
    expect(Math.abs(auto.chargesTotal - manual.chargesTotal)).toBeLessThanOrEqual(2);
    expect(Math.abs(auto.netPnl - manual.netPnl)).toBeLessThanOrEqual(2);
  });
});

// ───────────────────────── case 5: import it twice ──────────────────────────

describe("5 — the same file imported twice", () => {
  const ACC = 606;

  it("skips the second as a duplicate and closes nothing more", () => {
    newAccount(ACC, "case-5");
    commit.commitParsedFile(parsed([buyRow("HDFCBANK", 100, 100, "2026-04-01")]), "buys.csv", null, ACC);
    const sells = () => parsed([sellRow("HDFCBANK", 40, 120, "2026-05-01")]);

    const first = commit.commitParsedFile(sells(), "sells.csv", null, ACC);
    expect(first.skipped).toBe(0);
    const after = rowsOf(ACC).map((r) => [r.id, r.buyQty, r.sellQty, r.isOpen]);

    const second = commit.commitParsedFile(sells(), "sells.csv", null, ACC);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.warnings?.join(" | ")).not.toMatch(/closed by this file/);
    expect(rowsOf(ACC).map((r) => [r.id, r.buyQty, r.sellQty, r.isOpen])).toEqual(after);
    // Absolute, not just unchanged: a second close would leave 20 open and two
    // closed rows. The lot is still 60 and there is still exactly one close.
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isOpen).map((r) => r.buyQty)).toEqual([60]);
    expect(rows.filter((r) => !r.isOpen).map((r) => r.sellQty)).toEqual([40]);
    expect(commit.previewParsedFile(sells(), null, ACC).autoClose?.closes).toBe(0);
  });
});

// ─────────────────────── case 6: accounts stay separate ─────────────────────

describe("6 — a sale in account B and an open lot in account A", () => {
  const A = 607;
  const B = 608;

  it("never touches the other account's position", () => {
    newAccount(A, "case-6-a");
    newAccount(B, "case-6-b");
    commit.commitParsedFile(parsed([buyRow("SBIN", 100, 100, "2026-04-01")]), "buys.csv", null, A);
    const before = rowsOf(A);

    const res = commit.commitParsedFile(parsed([sellRow("SBIN", 40, 120, "2026-05-01")]), "sells.csv", null, B);
    expect(res.added).toBe(1);
    expect(res.warnings?.join(" | ")).not.toMatch(/closed by this file/);

    expect(rowsOf(A)).toEqual(before);
    expect(rowsOf(A)[0].isOpen).toBe(true);
    expect(rowsOf(A)[0].buyQty).toBe(100);
    // Account B keeps the old behaviour: a sale with no lot of its own.
    expect(rowsOf(B)).toHaveLength(1);
    expect(rowsOf(B)[0].isOpen).toBe(true);
  });
});

// ──────────── case 7 (M-2): a BUY and a later SELL in the SAME file ─────────

describe("7 — one file holding [BUY TCS 100 on the 7th, SELL TCS 100 on the 9th]", () => {
  const ACC = 609;
  // Exactly the shape a Dhan catch-up pull produces: a history BUY dated
  // earlier in the window, and today's /positions SELL, in one parsed file.
  const oneFile = () =>
    parsed([buyRow("TCS", 100, 100, "2026-09-07"), sellRow("TCS", 100, 120, "2026-09-09")]);

  it("the preview already says the file closes one position", () => {
    newAccount(ACC, "case-7");
    const p = commit.previewParsedFile(oneFile(), null, ACC);
    expect(p.autoClose?.closes).toBe(1);
    expect(p.autoClose?.positions).toEqual([{ symbol: "TCS", qty: 100 }]);
  });

  it("commits as ONE closed row with realised P&L — not an open long beside an open short", () => {
    const res = commit.commitParsedFile(oneFile(), "dhan-pull.csv", null, ACC);
    const rows = rowsOf(ACC);
    expect(rows, "two source rows, one position").toHaveLength(1);

    const r = rows[0];
    expect(r.isOpen).toBe(false);
    expect(r.buyQty).toBe(100);
    expect(r.sellQty).toBe(100);
    expect(r.buyDate).toBe("2026-09-07");
    expect(r.sellDate).toBe("2026-09-09");
    expect(r.grossPnl).toBe(2000); // (120 − 100) × 100
    expect(r.netPnl).toBe(r2(2000 - r.chargesTotal));

    // One row was added to the book; the sell became its closing leg.
    expect(res.added).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.total).toBe(2);
    // The import's net is the book's net — the open row's charges are not
    // counted once as an open row and again inside the close.
    expect(res.netPnl).toBe(r.netPnl);
    expect(res.warnings?.join(" | ")).toMatch(/1 open position in this account was closed by this file/);
  });

  it("and it wrote the same audit trail a cross-file close writes", () => {
    const closed = rowsOf(ACC)[0];
    const audit = t.db.select().from(t.schema.auditLog).all()
      .filter((a) => a.entity === "trade" && a.action === "close" && a.entityId === closed.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].summary).toMatch(/TCS closed 100 @ 120 by import/);
  });

  it("re-importing the very same file changes nothing", () => {
    const before = rowsOf(ACC).map((r) => [r.id, r.buyQty, r.sellQty, r.isOpen]);
    const again = commit.commitParsedFile(oneFile(), "dhan-pull.csv", null, ACC);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(2);
    expect(rowsOf(ACC).map((r) => [r.id, r.buyQty, r.sellQty, r.isOpen])).toEqual(before);
  });
});

// ──────── case 8 (M-3): a sell-only row whose cost basis is unknown ─────────

describe("8 — a basis-unknown SELL dated today (Dhan /positions)", () => {
  const WITH_LOT = 610;
  const NO_LOT = 611;
  const today = todayIstIso();
  // Constructed here rather than imported from the adapter: this pins what
  // COMMIT does with the shape, whoever produces it.
  const unknownSell = (qty: number) =>
    parsed([
      trade({
        tradingsymbol: "MARKSANS",
        sellQty: qty,
        avgSellPrice: 250,
        sellValue: r2(qty * 250),
        sellDate: today,
        basisUnknown: true,
      } as Partial<NormalizedTrade> & { tradingsymbol: string }),
    ]);

  it("closes an OPEN lot the account holds, dated today — basisUnknown does not exclude it", () => {
    newAccount(WITH_LOT, "case-8-lot");
    commit.commitParsedFile(parsed([buyRow("MARKSANS", 50, 200, "2026-08-01")]), "buys.csv", null, WITH_LOT);
    expect(commit.previewParsedFile(unknownSell(50), null, WITH_LOT).autoClose?.closes).toBe(1);

    commit.commitParsedFile(unknownSell(50), "positions.json", null, WITH_LOT);
    const rows = rowsOf(WITH_LOT);
    expect(rows).toHaveLength(1);
    expect(rows[0].isOpen).toBe(false);
    expect(rows[0].sellDate, "the close is dated by the incoming row").toBe(today);
    expect(rows[0].buyDate).toBe("2026-08-01");
    expect(rows[0].grossPnl).toBe(2500); // (250 − 200) × 50
    expect(rows[0].acquisition, "the basis was known all along — the book held it").toBeNull();
  });

  it("with NO lot it is stored basis-unknown, and a later BUY never 'covers' it", () => {
    newAccount(NO_LOT, "case-8-none");
    expect(commit.commitParsedFile(unknownSell(50), "positions.json", null, NO_LOT).added).toBe(1);
    const [stored] = rowsOf(NO_LOT);
    expect(stored.isOpen).toBe(true);
    expect(stored.acquisition).toBe("unknown");

    // A purchase must NOT read that row as a short lot: its cost basis is
    // unknown, so pairing against it would fabricate a P&L (invariant 6).
    expect(commit.previewParsedFile(parsed([buyRow("MARKSANS", 50, 240, "2026-09-10")]), null, NO_LOT)
      .autoClose?.closes).toBe(0);
    const res = commit.commitParsedFile(parsed([buyRow("MARKSANS", 50, 240, "2026-09-10")]), "buys.csv", null, NO_LOT);
    expect(res.added, "the buy is its own open row").toBe(1);
    const rows = rowsOf(NO_LOT).sort((a, b) => a.id - b.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].acquisition).toBe("unknown");
    expect(rows[0].isOpen, "still an unpaired sale").toBe(true);
    expect(rows[0].buyQty).toBe(0);
    expect(rows[1].isOpen).toBe(true);
    expect(rows[1].sellQty).toBe(0);
  });
});

// ───── case 9 (M-1, round 2): one component, one split, no invented paisa ────

/** The charge columns a close apportions, in the order commit.ts lists them. */
const CHARGE_COLUMNS = [
  "brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty",
  "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges",
] as const;

describe("9 — a lot sold in HALF: the charges split by remainder, never twice", () => {
  const HALF = 612;
  const REF = 613;

  it("an odd-paisa component goes whole to the slice and the remainder keeps 0", () => {
    newAccount(HALF, "case-9-half");
    newAccount(REF, "case-9-ref");
    commit.commitParsedFile(parsed([buyRow("HDFCBANK", 100, 100, "2026-04-01")]), "buys.csv", null, HALF);
    const entry = { ...rowsOf(HALF)[0] };
    // The component this case exists for: SEBI's ₹10 per crore on a ₹10,000
    // buy is ₹0.01, and 0.01 is the one figure a 50/50 split cannot halve.
    expect(entry.sebi, "an odd paisa is what a 50/50 split cannot halve").toBe(0.01);

    // The SAME sale committed where nothing is open — its own, unsplit bill.
    const sale = () => parsed([sellRow("HDFCBANK", 50, 120, "2026-05-01")]);
    commit.commitParsedFile(sale(), "sells.csv", null, REF);
    const exit = { ...rowsOf(REF)[0] };

    commit.commitParsedFile(sale(), "sells.csv", null, HALF);
    const open = rowsOf(HALF).find((r) => r.isOpen)!;
    const closed = rowsOf(HALF).find((r) => !r.isOpen)!;
    expect(open.buyQty).toBe(50);

    expect(open.sebi, "₹0.01 halved is not ₹0.01 twice").toBe(0);
    expect(closed.sebi, "the whole paisa moved onto the slice, with the exit's own").toBe(
      r2(entry.sebi + exit.sebi),
    );
    for (const k of CHARGE_COLUMNS) {
      expect(r2((open[k] ?? 0) + (closed[k] ?? 0)), `${k} conserved to the paisa`).toBe(
        r2((entry[k] ?? 0) + (exit[k] ?? 0)),
      );
    }
    expect(r2(open.chargesTotal + closed.chargesTotal), "the totals follow the components").toBe(
      r2(entry.chargesTotal + exit.chargesTotal),
    );
  });
});

// ───── case 10 (T-1): the SAME-FILE exclusions, with the excluded row FIRST ──

describe("10 — a row this file just wrote is a lot only when it may be one", () => {
  const UNKNOWN = 614;
  const MTF = 615;
  const today = todayIstIso();

  it("a basis-unknown SELL is never a short lot the BUY BEHIND IT in the same file covers", () => {
    newAccount(UNKNOWN, "case-10-unknown");
    // The order is the point: the sell is written first, so only
    // `lotFromNewRow`'s basisUnknown clause stops it entering the book.
    const oneFile = () =>
      parsed([
        trade({
          tradingsymbol: "GRANULES",
          sellQty: 40,
          avgSellPrice: 250,
          sellValue: 10000,
          sellDate: today,
          basisUnknown: true,
        } as Partial<NormalizedTrade> & { tradingsymbol: string }),
        buyRow("GRANULES", 40, 240, "2026-09-10"),
      ]);

    expect(commit.previewParsedFile(oneFile(), null, UNKNOWN).autoClose?.closes ?? 0).toBe(0);
    const res = commit.commitParsedFile(oneFile(), "positions-and-fills.csv", null, UNKNOWN);
    expect(res.added, "two rows, because neither closed the other").toBe(2);

    const rows = rowsOf(UNKNOWN).sort((a, b) => a.id - b.id);
    expect(rows, "the buy did NOT cover the unpriced sale").toHaveLength(2);
    expect(rows[0].acquisition, "the sale's basis is still unknown (invariant 6)").toBe("unknown");
    expect(rows[0].isOpen).toBe(true);
    expect(rows[0].buyQty).toBe(0);
    expect(rows[1].isOpen, "the buy is its own open lot, not a cover").toBe(true);
    expect(rows[1].buyQty).toBe(40);
    expect(rows[1].sellQty).toBe(0);
  });

  it("an eq_mtf BUY first, then a SELL of it in the same file, closes nothing", () => {
    newAccount(MTF, "case-10-mtf");
    // Two independent clauses refuse this pairing — `lotFromNewRow`'s eq_mtf
    // exclusion and `incomingFromParsed`'s — because only closePosition prices
    // a funded position's accrued interest. This pins the BEHAVIOUR; it does
    // not isolate either clause, and deleting one alone leaves it green.
    const mtfBuy = trade({
      tradingsymbol: "SBIN",
      buyQty: 50,
      avgBuyPrice: 200,
      buyValue: 10000,
      buyDate: "2026-09-01",
      productHint: "mtf",
    });
    const mtfSell = trade({
      tradingsymbol: "SBIN",
      sellQty: 50,
      avgSellPrice: 220,
      sellValue: 11000,
      sellDate: "2026-09-05",
      productHint: "mtf",
    });

    const res = commit.commitParsedFile(parsed([mtfBuy, mtfSell]), "mtf.csv", null, MTF);
    expect(res.added).toBe(2);
    const rows = rowsOf(MTF).sort((a, b) => a.id - b.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.segment === "eq_mtf")).toBe(true);
    expect(rows.every((r) => r.isOpen), "neither row closed the other").toBe(true);
  });
});
