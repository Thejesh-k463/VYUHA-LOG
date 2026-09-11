import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { todayIstIso } from "@/lib/domain/trading-day";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 — AUTO-CLOSE SWITCHED OFF (owner ruling 2026-09-11, 06-ANSWERS
 * "v4.3.0 release-level-audit rulings", row 1).
 *
 * Wave 1's FIFO auto-close (R5) does not ship in 4.3.0. `lib/import/commit.ts`
 * is restored to v4.2.0 byte-for-byte (`git diff v4.2.0 -- lib/import/commit.ts`
 * is empty), so an import does exactly what v4.2.0 did with a SELL of a lot the
 * account already holds: the held row is never read as a lot and never
 * changes, and the SELL is written as its own new row. A BUY against a held
 * short is the same. The applier stays in git at d0eda00 and is rebuilt in
 * 4.3.1; its pure planner stays covered in tests/auto-close-fifo.test.ts.
 *
 * (i)–(iv) are the switch-off's red-on-revert pins: putting d0eda00's commit.ts
 * back turns (i) red (the lot is reduced to 60 and the sale adds no row).
 *
 * Cases 1–11 are the DB cases tests/auto-close-fifo.test.ts carried while
 * auto-close was live. They were MOVED here and rewritten to assert v4.2.0's
 * outcome for the same inputs; none was deleted. Case 3 is (ii).
 *
 * ONE temp database per FILE (AGENTS.md): `lib/db` caches its connection on
 * globalThis, so every case below owns its account id.
 */

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let dhan: typeof import("@/lib/import/api/dhan");
let angel: typeof import("@/lib/import/api/angelone");

const ROOT = path.resolve(__dirname, "..");
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

/** A sell-only row with no basis flag (a hand-built file row, or a short). */
const sellRow = (symbol: string, qty: number, price: number, date: string) =>
  trade({ tradingsymbol: symbol, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date });

/** A sell-only row whose cost basis the file could not state. */
const unknownSell = (symbol: string, qty: number, price: number, date: string) =>
  trade({
    tradingsymbol: symbol,
    sellQty: qty,
    avgSellPrice: price,
    sellValue: r2(qty * price),
    sellDate: date,
    basisUnknown: true,
  } as Partial<NormalizedTrade> & { tradingsymbol: string });

function parsed(trades: NormalizedTrade[], broker: NormalizedTrade["broker"] = "dhan"): ParsedFile {
  return {
    sourceId: broker === "zerodha" ? "zerodha-tradebook" : "dhan-gtr",
    broker,
    format: "tradebook",
    trades: trades.map((x) => ({ ...x, broker })),
    warnings: [],
  };
}

function newAccount(id: number, name: string) {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
}

/** The account's rows, oldest first. */
const rowsOf = (accountId: number) =>
  t.db
    .select()
    .from(t.schema.trades)
    .where(eq(t.schema.trades.accountId, accountId))
    .all()
    .sort((a, b) => a.id - b.id);

type Row = ReturnType<typeof rowsOf>[number];

/** 'close' audit entries on this account's rows — wave 1 wrote one per close. */
function closeAuditsFor(accountId: number) {
  const ids = new Set(rowsOf(accountId).map((r) => r.id));
  return t.db
    .select()
    .from(t.schema.auditLog)
    .all()
    .filter((a) => a.entity === "trade" && a.action === "close" && ids.has(a.entityId as number));
}

/** Wave 1's result sentence, in either source word. */
const saysClosed = (warnings: readonly string[] | undefined) =>
  (warnings ?? []).some((w) => /closed by this (file|pull)/.test(w));

// Siblings on the same helper (auto-close-identity, seams-v43-fix1) use this
// budget; it is for the Windows runner, which is >15x slower on SQLite-file
// work (AGENTS.md Testing). Measured locally (3 runs, 2026-09-11): the hook
// takes 1076-1142 ms, inside the 3 s local budget; every `it` is under 40 ms.
beforeAll(async () => {
  t = await openTempDb("auto-close-off", { seed: true });
  commit = await import("@/lib/import/commit");
  dhan = await import("@/lib/import/api/dhan");
  angel = await import("@/lib/import/api/angelone");
}, 120_000);
afterAll(() => t?.cleanup());

// ═══════════════════════ the switch-off's own pins ══════════════════════════

describe("(i) a basis-unknown SELL of a held long: the lot is untouched, the sale is its own row", () => {
  const ACC = 701;
  const buys = () => parsed([buyRow("TCS", 100, 100, "2026-04-01")], "zerodha");
  const sale = () => parsed([unknownSell("TCS", 40, 120, "2026-05-01")], "zerodha");
  let lotBefore: Row;

  it("the buy lands as an open long", () => {
    newAccount(ACC, "off-i");
    expect(commit.commitParsedFile(buys(), "buys.csv", null, ACC).added).toBe(1);
    lotBefore = { ...rowsOf(ACC)[0] };
    expect([lotBefore.buyQty, lotBefore.sellQty, lotBefore.isOpen, lotBefore.importNotes]).toEqual([100, 0, true, null]);
  });

  it("the preview plans no close: no autoClose field, one new row, one opening sell", () => {
    const p = commit.previewParsedFile(sale(), null, ACC);
    expect("autoClose" in p, "a close plan is wave 1's; v4.2.0's preview has none").toBe(false);
    expect(p.summary.newCount).toBe(1);
    expect(p.summary.dupCount).toBe(0);
    expect(p.shape.openingSells).toBe(1);
  });

  it("the commit writes the sale as its own row and leaves the lot exactly as it was", () => {
    const res = commit.commitParsedFile(sale(), "sells.csv", null, ACC);
    const rows = rowsOf(ACC);
    const lot = rows.find((r) => r.id === lotBefore.id)!;
    expect(lot.buyQty, "an import never reduces a held lot in 4.3.0").toBe(100);
    expect(res.added, "the sale is a new row, not a closing leg").toBe(1);
    expect(lot, "every column of the lot, as it was before the sale").toEqual(lotBefore);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id !== lotBefore.id)).toMatchObject({
      buyQty: 0,
      sellQty: 40,
      isOpen: true,
      acquisition: "unknown",
      sellDate: "2026-05-01",
    });
    expect(res.shape.openingSells).toBe(1);
    expect(saysClosed(res.warnings), "no sentence may claim a close").toBe(false);
  });

  it("no audit entry says an import closed anything", () => {
    expect(closeAuditsFor(ACC)).toEqual([]);
  });

  it("re-committing the same sale file is skipped by its own hash", () => {
    const again = commit.commitParsedFile(sale(), "sells.csv", null, ACC);
    expect([again.added, again.skipped]).toEqual([0, 1]);
    expect(rowsOf(ACC)).toHaveLength(2);
  });
});

// (ii) is the moved case 3: short 100 open, incoming BUY 100.
describe("(ii) · case 3 — a BUY against a held short: both rows open, the short unchanged", () => {
  const ACC = 603;
  let shortBefore: Row;
  // An F&O short: sold to open, with a known price, so NOT basis-unknown.
  const shortFile = () =>
    parsed([trade({ tradingsymbol: "NIFTY26MAYFUT", sellQty: 100, avgSellPrice: 100, sellValue: 10000, sellDate: "2026-04-01", productHint: null })]);
  const coverFile = () =>
    parsed([trade({ tradingsymbol: "NIFTY26MAYFUT", buyQty: 100, avgBuyPrice: 90, buyValue: 9000, buyDate: "2026-04-02", productHint: null })]);

  it("the short lands open, an F&O row with a known basis", () => {
    newAccount(ACC, "case-3");
    expect(commit.commitParsedFile(shortFile(), "short.csv", null, ACC).added).toBe(1);
    shortBefore = { ...rowsOf(ACC)[0] };
    expect(shortBefore.segment).toBe("future");
    expect([shortBefore.buyQty, shortBefore.sellQty, shortBefore.isOpen, shortBefore.acquisition]).toEqual([0, 100, true, null]);
  });

  it("the preview plans no cover", () => {
    const p = commit.previewParsedFile(coverFile(), null, ACC);
    expect("autoClose" in p).toBe(false);
    expect(p.summary.newCount).toBe(1);
  });

  it("the cover is its own open row, and the short is untouched", () => {
    const res = commit.commitParsedFile(coverFile(), "cover.csv", null, ACC);
    expect(res.added).toBe(1);
    const rows = rowsOf(ACC);
    expect(rows, "v4.2.0 writes the cover beside the short").toHaveLength(2);
    expect(rows[0]).toEqual(shortBefore);
    expect(rows[1]).toMatchObject({ buyQty: 100, sellQty: 0, isOpen: true, buyDate: "2026-04-02" });
    expect(saysClosed(res.warnings)).toBe(false);
    expect(closeAuditsFor(ACC)).toEqual([]);
  });
});

describe("(iii) broker-pull shapes landing in a held book", () => {
  it("Angel One: a pulled SELL of a held lot is stored as an OPEN SHORT with sell_date NULL and no basis flag", () => {
    // KNOWN PRE-EXISTING SHAPE, PENDING AN OWNER DECISION. Pinned here as
    // TODAY's behaviour, NOT as correct. lib/import/api/angelone.ts:321 (and
    // upstox.ts:214) write `sellDate: closed ? today : null` and no basisUnknown,
    // unchanged since v4.2.0, so a sell-only pull row is an open short with no
    // exit date — the phantom-short shape M-3 ruled wrong for Dhan only
    // (06-ANSWERS:269). The switch-off restores v4.2.0 and so restores this; the
    // adapters were deliberately not touched. It is carried with R72 to the
    // owner / 4.3.1. A change either way must redden this line and be seen.
    const ACC = 703;
    newAccount(ACC, "off-iii-angel");
    const pull = (side: "BUY" | "SELL", day: string) =>
      angel.toParsedFile(
        angel.normalizeAngelTrades(
          [
            {
              tradingsymbol: "TCS-EQ",
              exchange: "NSE",
              producttype: "DELIVERY",
              transactiontype: side,
              fillsize: 10,
              fillprice: side === "BUY" ? 100 : 110,
              filltime: "10:00:00",
            },
          ],
          day,
        ).trades,
      );
    expect(commit.commitParsedFile(pull("BUY", "2026-09-01"), "angelone-api-2026-09-01", null, ACC).added).toBe(1);
    const lot = { ...rowsOf(ACC)[0] };

    const res = commit.commitParsedFile(pull("SELL", "2026-09-02"), "angelone-api-2026-09-02", null, ACC);
    expect(res.added).toBe(1);
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    expect(rows[0], "the held lot is untouched").toEqual(lot);
    expect(rows[1]).toMatchObject({ buyQty: 0, sellQty: 10, isOpen: true, sellDate: null, acquisition: null });
  });

  it("Dhan /positions sell-only (M-3): the sale is dated the IST day and basis-unknown; the held lot is untouched", () => {
    const ACC = 704;
    newAccount(ACC, "off-iii-dhan");
    expect(commit.commitParsedFile(parsed([buyRow("INFY", 100, 100, "2026-09-07")]), "dhan-gtr.csv", null, ACC).added).toBe(1);
    const lot = { ...rowsOf(ACC)[0] };

    // A sell-only /v2/positions row: sold today out of a holding it cannot see.
    const sellOnly = {
      dhanClientId: "1000000009",
      tradingSymbol: "INFY",
      positionType: "CLOSED",
      exchangeSegment: "NSE_EQ",
      productType: "CNC",
      buyAvg: 0,
      buyQty: 0,
      sellAvg: 120,
      sellQty: 100,
      netQty: 0,
    };
    const pulled = dhan.toParsedFile(
      dhan.normalizeDhanPositions([sellOnly] as unknown as Parameters<typeof dhan.normalizeDhanPositions>[0], "2026-09-10"),
      null,
    );
    expect(pulled.format).toBe("api");

    const res = commit.commitParsedFile(pulled, "dhan-api-2026-09-10", null, ACC);
    expect(res.added).toBe(1);
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    expect(rows[0], "the held lot is untouched").toEqual(lot);
    expect(rows[1]).toMatchObject({ buyQty: 0, sellQty: 100, isOpen: true, sellDate: "2026-09-10", acquisition: "unknown" });
  });
});

describe("(iv) the switch-off is the v4.2.0 file, not a flag", () => {
  it("commit.ts neither imports the planner nor names it", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib/import/commit.ts"), "utf8");
    expect(src).not.toContain("close-open-lots");
    expect(src).not.toContain("planLotCloses");
  });
});

// ════════ the DB cases moved from tests/auto-close-fifo.test.ts (v4.2.0) ════════

describe("1 — long 100 open, incoming SELL 40", () => {
  const ACC = 601;
  const fileA = parsed([buyRow("TCS", 100, 100, "2026-04-01")]);
  const fileB = parsed([sellRow("TCS", 40, 120, "2026-05-01")]);
  let lotBefore: Row;
  let exitCharges = 0;

  it("the buy lands as an open long", () => {
    newAccount(ACC, "case-1");
    expect(commit.commitParsedFile(fileA, "buys.csv", null, ACC).added).toBe(1);
    lotBefore = { ...rowsOf(ACC)[0] };
    expect(lotBefore.isOpen).toBe(true);
    expect(lotBefore.buyQty).toBe(100);
  });

  it("the preview plans nothing: no autoClose field, and the sale is one new row", () => {
    const p = commit.previewParsedFile(fileB, null, ACC);
    expect("autoClose" in p).toBe(false);
    expect(p.summary.newCount).toBe(1);
    exitCharges = p.rows[0].chargesTotal;
  });

  it("the sale lands as its own open row; the lot is not reduced", () => {
    const res = commit.commitParsedFile(fileB, "sells.csv", null, ACC);
    expect(res.added).toBe(1);
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(lotBefore);
    expect(rows[1]).toMatchObject({ buyQty: 0, sellQty: 40, avgSellPrice: 120, sellDate: "2026-05-01", isOpen: true });
    expect(rows[1].acquisition, "this row states no basis flag, so none is invented").toBeNull();
    expect(saysClosed(res.warnings)).toBe(false);
  });

  it("so the book holds the long AND an open sale beside it — v4.2.0's shape, restored by the ruling", () => {
    const shorts = rowsOf(ACC).filter((r) => r.isOpen && r.sellQty > 0 && r.buyQty === 0);
    expect(shorts).toHaveLength(1);
    expect(rowsOf(ACC).filter((r) => r.isOpen && r.buyQty > 0)).toHaveLength(1);
  });

  it("each row carries its own bill: entry + exit, exactly, and nothing moved between them", () => {
    const [lot, sale] = rowsOf(ACC);
    expect(lot.chargesTotal).toBe(lotBefore.chargesTotal);
    expect(sale.chargesTotal, "what the preview priced is what the commit stored").toBe(exitCharges);
    expect(r2(lot.chargesTotal + sale.chargesTotal)).toBe(r2(lotBefore.chargesTotal + exitCharges));
  });

  it("writes no close audit entry", () => {
    expect(closeAuditsFor(ACC)).toEqual([]);
  });
});

describe("2 — lots of 50 (older) and 50 (newer), incoming SELL 70", () => {
  const ACC = 602;

  it("both lots are untouched and the sale is a third, open row", () => {
    newAccount(ACC, "case-2");
    commit.commitParsedFile(
      parsed([buyRow("INFY", 50, 100, "2026-04-01"), buyRow("INFY", 50, 110, "2026-04-10")]),
      "buys.csv", null, ACC,
    );
    const lots = rowsOf(ACC).map((r) => ({ ...r }));
    const res = commit.commitParsedFile(parsed([sellRow("INFY", 70, 120, "2026-05-01")]), "sells.csv", null, ACC);
    expect(res.added).toBe(1);

    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(3);
    expect(rows.slice(0, 2)).toEqual(lots);
    expect(rows.map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([
      [50, 0, true],
      [50, 0, true],
      [0, 70, true],
    ]);
  });
});

describe("4 — a SELL of a held lot is its own priced row; closePosition is the path that closes", () => {
  const AUTO = 604;
  const MANUAL = 605;

  it("the import prices the sale on its own; the manual close counts entry + exit once", () => {
    newAccount(AUTO, "case-4-auto");
    newAccount(MANUAL, "case-4-manual");
    const buys = () => parsed([buyRow("WIPRO", 100, 100, "2026-04-01")]);
    const sells = () => parsed([sellRow("WIPRO", 100, 120, "2026-05-01")]);

    commit.commitParsedFile(buys(), "buys.csv", null, AUTO);
    const entryCharges = rowsOf(AUTO)[0].chargesTotal;
    const exitCharges = commit.previewParsedFile(sells(), null, AUTO).rows[0].chargesTotal;
    commit.commitParsedFile(sells(), "sells.csv", null, AUTO);

    const auto = rowsOf(AUTO);
    expect(auto, "the lot and the sale, side by side").toHaveLength(2);
    expect(auto.map((r) => r.isOpen)).toEqual([true, true]);
    expect(auto[0].chargesTotal).toBe(entryCharges);
    expect(auto[1].chargesTotal).toBe(exitCharges);

    commit.commitParsedFile(buys(), "buys.csv", null, MANUAL);
    const manualId = rowsOf(MANUAL)[0].id;
    expect(commit.closePosition(manualId, 120, "2026-05-01").ok).toBe(true);
    const manual = rowsOf(MANUAL);
    expect(manual).toHaveLength(1);
    expect(manual[0].isOpen).toBe(false);
    expect(manual[0].grossPnl).toBe(2000); // (120 − 100) × 100
    // The manual path re-prices the whole pair, so it agrees with entry + exit
    // to within the statutory rupee-rounding of STT and stamp duty, applied
    // per call (lib/engine/charges.ts roundRupee).
    expect(Math.abs(manual[0].chargesTotal - r2(entryCharges + exitCharges))).toBeLessThanOrEqual(2);
  });
});

describe("5 — the same sell file imported twice", () => {
  const ACC = 606;

  it("the second is skipped by its own hash, and nothing is closed either time", () => {
    newAccount(ACC, "case-5");
    commit.commitParsedFile(parsed([buyRow("HDFCBANK", 100, 100, "2026-04-01")]), "buys.csv", null, ACC);
    const sells = () => parsed([sellRow("HDFCBANK", 40, 120, "2026-05-01")]);

    const first = commit.commitParsedFile(sells(), "sells.csv", null, ACC);
    expect([first.added, first.skipped]).toEqual([1, 0]);
    const after = rowsOf(ACC);

    const p = commit.previewParsedFile(sells(), null, ACC);
    expect("autoClose" in p).toBe(false);
    expect([p.summary.newCount, p.summary.dupCount]).toEqual([0, 1]);

    const second = commit.commitParsedFile(sells(), "sells.csv", null, ACC);
    expect([second.added, second.skipped]).toEqual([0, 1]);
    expect(saysClosed(second.warnings)).toBe(false);
    expect(rowsOf(ACC)).toEqual(after);
    expect(after.map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([
      [100, 0, true],
      [0, 40, true],
    ]);
  });
});

describe("6 — a sale in account B and an open lot in account A", () => {
  const A = 607;
  const B = 608;

  it("never touches the other account's position; B's sale lands in B", () => {
    newAccount(A, "case-6-a");
    newAccount(B, "case-6-b");
    commit.commitParsedFile(parsed([buyRow("SBIN", 100, 100, "2026-04-01")]), "buys.csv", null, A);
    const before = rowsOf(A);

    const res = commit.commitParsedFile(parsed([sellRow("SBIN", 40, 120, "2026-05-01")]), "sells.csv", null, B);
    expect(res.added).toBe(1);
    expect(saysClosed(res.warnings)).toBe(false);

    expect(rowsOf(A)).toEqual(before);
    expect(rowsOf(A)[0].isOpen).toBe(true);
    expect(rowsOf(A)[0].buyQty).toBe(100);
    expect(rowsOf(B)).toHaveLength(1);
    expect(rowsOf(B)[0]).toMatchObject({ buyQty: 0, sellQty: 40, isOpen: true });
  });
});

describe("7 — one file holding [BUY TCS 100 on the 7th, SELL TCS 100 on the 9th], as two single-sided rows", () => {
  const ACC = 609;
  // The shape a Dhan catch-up pull produces: a history BUY dated earlier in the
  // window and today's /positions SELL, in one parsed file, unpaired. v4.2.0
  // writes them as two rows — the open long + open sale M-2 was built to
  // prevent. Accepted by the ruling; 4.3.1 rebuilds it.
  const oneFile = () => parsed([buyRow("TCS", 100, 100, "2026-09-07"), sellRow("TCS", 100, 120, "2026-09-09")]);

  it("the preview plans no close and counts two new rows", () => {
    newAccount(ACC, "case-7");
    const p = commit.previewParsedFile(oneFile(), null, ACC);
    expect("autoClose" in p).toBe(false);
    expect(p.summary.newCount).toBe(2);
  });

  it("commits as TWO open rows — the long and the sale — and says no close", () => {
    const res = commit.commitParsedFile(oneFile(), "dhan-pull.csv", null, ACC);
    expect([res.added, res.skipped, res.total]).toEqual([2, 0, 2]);
    const rows = rowsOf(ACC);
    expect(rows.map((r) => [r.buyQty, r.sellQty, r.isOpen, r.buyDate, r.sellDate])).toEqual([
      [100, 0, true, "2026-09-07", null],
      [0, 100, true, null, "2026-09-09"],
    ]);
    // The import's net is the sum of the rows it wrote.
    expect(res.netPnl).toBeCloseTo(r2(rows[0].netPnl + rows[1].netPnl), 2);
    expect(saysClosed(res.warnings)).toBe(false);
  });

  it("and it wrote no close audit entry", () => {
    expect(closeAuditsFor(ACC)).toEqual([]);
  });

  it("re-importing the very same file changes nothing", () => {
    const before = rowsOf(ACC);
    const again = commit.commitParsedFile(oneFile(), "dhan-pull.csv", null, ACC);
    expect([again.added, again.skipped]).toEqual([0, 2]);
    expect(rowsOf(ACC)).toEqual(before);
  });
});

describe("8 — a basis-unknown SELL dated today (Dhan /positions)", () => {
  const WITH_LOT = 610;
  const NO_LOT = 611;
  const today = todayIstIso();
  // Constructed here rather than taken from the adapter: this pins what COMMIT
  // does with the shape, whoever produces it ((iii) runs the real adapter).
  const sale = (qty: number) => parsed([unknownSell("MARKSANS", qty, 250, today)]);

  it("beside an OPEN lot it is its own basis-unknown row, dated today; the lot is untouched", () => {
    newAccount(WITH_LOT, "case-8-lot");
    commit.commitParsedFile(parsed([buyRow("MARKSANS", 50, 200, "2026-08-01")]), "buys.csv", null, WITH_LOT);
    const lot = { ...rowsOf(WITH_LOT)[0] };
    expect("autoClose" in commit.previewParsedFile(sale(50), null, WITH_LOT)).toBe(false);

    expect(commit.commitParsedFile(sale(50), "positions.json", null, WITH_LOT).added).toBe(1);
    const rows = rowsOf(WITH_LOT);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(lot);
    expect(rows[1]).toMatchObject({ buyQty: 0, sellQty: 50, isOpen: true, sellDate: today, acquisition: "unknown" });
  });

  it("with NO lot it is stored basis-unknown, and a later BUY never 'covers' it", () => {
    newAccount(NO_LOT, "case-8-none");
    expect(commit.commitParsedFile(sale(50), "positions.json", null, NO_LOT).added).toBe(1);
    const [stored] = rowsOf(NO_LOT);
    expect(stored.isOpen).toBe(true);
    expect(stored.acquisition).toBe("unknown");

    // Pairing a purchase against an unknown-basis sale would fabricate a P&L (invariant 6).
    expect("autoClose" in commit.previewParsedFile(parsed([buyRow("MARKSANS", 50, 240, "2026-09-10")]), null, NO_LOT)).toBe(false);
    const res = commit.commitParsedFile(parsed([buyRow("MARKSANS", 50, 240, "2026-09-10")]), "buys.csv", null, NO_LOT);
    expect(res.added, "the buy is its own open row").toBe(1);
    const rows = rowsOf(NO_LOT);
    expect(rows).toHaveLength(2);
    expect(rows[0].acquisition).toBe("unknown");
    expect(rows[0].isOpen, "still an unpaired sale").toBe(true);
    expect(rows[0].buyQty).toBe(0);
    expect(rows[1].isOpen).toBe(true);
    expect(rows[1].sellQty).toBe(0);
  });
});

/** The charge columns a row carries, in the order commit.ts lists them. */
const CHARGE_COLUMNS = [
  "brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty",
  "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges",
] as const;

describe("9 — a SELL of HALF a lot is billed as the same SELL into an empty book; the lot keeps every paisa", () => {
  const HALF = 612;
  const REF = 613;

  it("the lot is byte-identical after the sale, and the sale's bill is its own, component by component", () => {
    newAccount(HALF, "case-9-half");
    newAccount(REF, "case-9-ref");
    commit.commitParsedFile(parsed([buyRow("HDFCBANK", 100, 100, "2026-04-01")]), "buys.csv", null, HALF);
    const entry = { ...rowsOf(HALF)[0] };
    // The component wave 1's split had to get right: SEBI's ₹10 per crore on a
    // ₹10,000 buy is ₹0.01. Nothing is split now, so nothing can be invented.
    expect(entry.sebi).toBe(0.01);

    const sale = () => parsed([sellRow("HDFCBANK", 50, 120, "2026-05-01")]);
    commit.commitParsedFile(sale(), "sells.csv", null, REF);
    const exit = { ...rowsOf(REF)[0] };

    commit.commitParsedFile(sale(), "sells.csv", null, HALF);
    const rows = rowsOf(HALF);
    expect(rows).toHaveLength(2);
    expect(rows[0], "not a paisa moved off the lot").toEqual(entry);
    const sold = rows[1];
    for (const k of CHARGE_COLUMNS) {
      expect(sold[k], `${k}: the sale's own bill`).toBe(exit[k]);
    }
    expect(sold.chargesTotal).toBe(exit.chargesTotal);
    expect(r2(rows[0].chargesTotal + sold.chargesTotal)).toBe(r2(entry.chargesTotal + exit.chargesTotal));
  });
});

describe("10 — rows the planner used to exclude still land as plain rows", () => {
  const UNKNOWN = 614;
  const MTF = 615;
  const today = todayIstIso();

  it("a basis-unknown SELL and a BUY behind it in the same file: two open rows, the sale still unknown-basis", () => {
    newAccount(UNKNOWN, "case-10-unknown");
    const oneFile = () => parsed([unknownSell("GRANULES", 40, 250, today), buyRow("GRANULES", 40, 240, "2026-09-10")]);

    expect("autoClose" in commit.previewParsedFile(oneFile(), null, UNKNOWN)).toBe(false);
    const res = commit.commitParsedFile(oneFile(), "positions-and-fills.csv", null, UNKNOWN);
    expect(res.added, "two rows, because neither closed the other").toBe(2);

    const rows = rowsOf(UNKNOWN);
    expect(rows).toHaveLength(2);
    expect(rows[0].acquisition, "the sale's basis is still unknown (invariant 6)").toBe("unknown");
    expect(rows[0].isOpen).toBe(true);
    expect(rows[0].buyQty).toBe(0);
    expect(rows[1].isOpen, "the buy is its own open lot, not a cover").toBe(true);
    expect(rows[1].buyQty).toBe(40);
    expect(rows[1].sellQty).toBe(0);
  });

  it("an eq_mtf BUY first, then a SELL of it in the same file: two open eq_mtf rows", () => {
    newAccount(MTF, "case-10-mtf");
    const mtfBuy = trade({ tradingsymbol: "SBIN", buyQty: 50, avgBuyPrice: 200, buyValue: 10000, buyDate: "2026-09-01", productHint: "mtf" });
    const mtfSell = trade({ tradingsymbol: "SBIN", sellQty: 50, avgSellPrice: 220, sellValue: 11000, sellDate: "2026-09-05", productHint: "mtf" });

    const res = commit.commitParsedFile(parsed([mtfBuy, mtfSell]), "mtf.csv", null, MTF);
    expect(res.added).toBe(2);
    const rows = rowsOf(MTF);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.segment === "eq_mtf")).toBe(true);
    expect(rows.every((r) => r.isOpen), "neither row closed the other").toBe(true);
  });
});

describe("11 — no close sentence after a file OR a pull", () => {
  const FROM_FILE = 616;
  const FROM_PULL = 617;
  const pulled = (trades: NormalizedTrade[]): ParsedFile => ({
    sourceId: "dhan-api",
    broker: "dhan",
    format: "api",
    trades,
    warnings: [],
  });

  it("a file import: the sale lands, and no sentence claims a close", () => {
    newAccount(FROM_FILE, "case-11-file");
    commit.commitParsedFile(parsed([buyRow("TCS", 100, 100, "2026-09-01")]), "buys.csv", null, FROM_FILE);
    const res = commit.commitParsedFile(parsed([sellRow("TCS", 100, 120, "2026-09-02")]), "sells.csv", null, FROM_FILE);
    expect(res.added).toBe(1);
    expect(saysClosed(res.warnings)).toBe(false);
  });

  it("a broker pull (format 'api'): the same, and never 'this file'", () => {
    newAccount(FROM_PULL, "case-11-pull");
    commit.commitParsedFile(pulled([buyRow("TCS", 100, 100, "2026-09-01")]), "dhan-api-2026-09-01", null, FROM_PULL);
    const res = commit.commitParsedFile(pulled([sellRow("TCS", 100, 120, "2026-09-02")]), "dhan-api-2026-09-02", null, FROM_PULL);
    expect(res.added).toBe(1);
    expect(saysClosed(res.warnings)).toBe(false);
    expect(res.warnings?.join(" | ") ?? "").not.toMatch(/this file/);
  });
});
