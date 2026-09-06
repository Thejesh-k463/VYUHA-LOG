import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { toPaise, type Quote, type QuoteKey } from "@/lib/quotes/types";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * G1 — A TYPED MARK IS ALWAYS THE DAY'S MARK (owner ruling, v4.1 fix wave 3).
 *
 * THE BUG THIS FILE PINS. `mtm_prices` has no unique key on (symbol,
 * as_of_date), and every reader — `getMtmMap()`/`getSpotMap()`
 * (lib/queries/mtm.ts), `indexMarks()` (lib/quotes/manual.ts) and the surfaces
 * behind them — orders by `as_of_date DESC` with NO tiebreak and takes the
 * FIRST row per symbol, which SQLite returns in rowid order. The two TYPED
 * writers (the risk dialog's route and the bulk MTM paste action) used a bare
 * INSERT, so a price typed AFTER the automatic 15:31 write
 * (`persistDailyMarks`, which deletes-then-inserts) landed in a second row
 * BEHIND the feed's — stored, and silently ignored by every figure on screen.
 * Nothing looked broken: the dialog said "Saved.", and the desk kept printing
 * the feed's number.
 *
 * WHAT IS ASSERTED, in both orders, because only one of them was broken:
 *   - feed first, then typed  → ONE row, the TYPED price, and `getMtmMap()`
 *     reads it (this is the finding);
 *   - typed first, then feed  → ONE row, still the TYPED price (the live
 *     door's skip-a-held-row rule, which must NOT have regressed).
 *
 * REAL HALVES, NOT DOUBLES: the real `catchUpDailyMark`/`persistDailyMarks`
 * against a real migrated database, and the real `POST` handler of
 * `app/api/positions/risk/route.ts` and the real `saveMtmPrices` action. A
 * double for either would assert the fix against itself.
 *
 * ONE temp database for the whole FILE: `lib/db` caches its connection on
 * globalThis, so a second `openTempDb()` here would silently reuse the first.
 * Everything that touches the DB is imported DYNAMICALLY, after the helper has
 * set `VYUHA_DB_PATH`.
 */

let t: TempDb;
let persist: typeof import("@/lib/quotes/persist-mark");
let riskRoute: typeof import("@/app/api/positions/risk/route");
let equity: typeof import("@/app/equity/actions");
let mtm: typeof import("@/lib/queries/mtm");

const ACCOUNT = 1;
/** Friday 2026-09-04, 16:00 IST — after the 15:30 close, so the feed may mark. */
const FRI_1600 = new Date("2026-09-04T10:30:00Z");
const DAY = "2026-09-04";

/** The provider the automatic door accepts: it streams, and it is not `mock`. */
const STREAMING = { id: "openalgo" as const, streaming: true };

let tradeId = 0;

function quote(symbol: string, rupees: number): Quote {
  const key: QuoteKey = { symbol, exchange: "NSE" };
  return {
    key,
    ltp: toPaise(rupees),
    prevClose: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    volume: null,
    asOf: FRI_1600.toISOString(),
    staleness: "delayed",
    source: "openalgo",
  };
}

/** Every row of the day for one symbol, oldest rowid first. */
function rowsFor(symbol: string) {
  return t.db
    .select()
    .from(t.schema.mtmPrices)
    .all()
    .filter((r) => r.symbol === symbol && r.asOfDate === DAY);
}

/** The AUTOMATIC door, exactly as the SSE route and the desk render call it. */
async function liveDoor(rupees: number) {
  return persist.catchUpDailyMark(STREAMING, [quote("TCS", rupees)], { now: FRI_1600 });
}

/** The risk dialog's own write path: the real route handler, a real Request. */
async function typedViaRiskDialog(rupees: number) {
  const res = await riskRoute.POST(
    new Request("http://local/api/positions/risk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeId, mtmPrice: rupees }),
    }),
  );
  expect(res.status).toBe(200);
  return res;
}

/** The bulk MTM paste panel's own write path: the real server action. */
async function typedViaBulkPaste(rupees: number) {
  const form = new FormData();
  form.set("prices", `TCS ${rupees}`);
  form.set("asOf", DAY);
  return equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
}

beforeAll(async () => {
  t = await openTempDb("typed-mark", { seed: true });
  persist = await import("@/lib/quotes/persist-mark");
  riskRoute = await import("@/app/api/positions/risk/route");
  equity = await import("@/app/equity/actions");
  mtm = await import("@/lib/queries/mtm");

  t.db.update(t.schema.settings).set({ selectedAccountId: ACCOUNT }).run();
  t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        accountId: ACCOUNT,
        symbol: "TCS",
        tradingsymbol: "TCS",
        isOpen: true,
        buyQty: 10,
        avgBuyPrice: 3000,
      }),
    )
    .run();
  tradeId = t.db.select().from(t.schema.trades).all()[0].id;
});

afterAll(() => {
  vi.useRealTimers();
  t?.cleanup();
});

beforeEach(() => {
  // The typed writers date the mark with `todayIstIso()` off the machine
  // clock, so the day is pinned rather than assumed — a CI box in UTC would
  // otherwise write the mark to a different day than the feed did.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FRI_1600);
  t.sqlite.prepare("DELETE FROM mtm_prices").run();
  t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
});

describe("a mark typed AFTER the automatic one is the day's mark (G1)", () => {
  it("the risk dialog replaces the feed's row instead of queueing behind it", async () => {
    const auto = await liveDoor(3120);
    expect(auto?.written, "the automatic 15:31 door wrote nothing to type over").toBe(true);
    expect(rowsFor("TCS").map((r) => r.price)).toEqual([3120]);

    await typedViaRiskDialog(3100);

    // THE USER-VISIBLE HALF FIRST: the map every position figure reads must
    // agree with the screen the user typed into. This is the assertion the
    // finding was invisible to — the row WAS written, it was simply never the
    // one read, so "Saved." was true and the desk still showed the feed's
    // 3120.
    expect(mtm.getMtmMap().get("TCS")).toBe(3100);
    // …and ONE row for (TCS, the IST day), not two, holding the typed price.
    const rows = rowsFor("TCS");
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(3100);
    expect(rows[0].asOfDate).toBe(DAY);
  });

  it("and the live door does not take it back on the next connect", async () => {
    await liveDoor(3120);
    await typedViaRiskDialog(3100);

    // Every reconnect crosses the server's mark door again (F3 re-opens the
    // stream at 15:31, and the desk's server render calls it too).
    const again = await liveDoor(3120);
    expect(again?.written, "the day already holds a mark, whoever wrote it").toBe(false);
    expect(rowsFor("TCS")).toHaveLength(1);
    expect(mtm.getMtmMap().get("TCS")).toBe(3100);
  });

  it("the bulk MTM paste replaces it too — both typed doors, one rule", async () => {
    await liveDoor(3120);

    const r = await typedViaBulkPaste(3100);
    expect(r.ok).toBe(true);
    expect(r.updated).toBe(1);

    const rows = rowsFor("TCS");
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(3100);
    expect(mtm.getMtmMap().get("TCS")).toBe(3100);
  });

  it("typing twice in one day leaves one row, not three", async () => {
    await typedViaRiskDialog(3100);
    await typedViaRiskDialog(3105);
    await typedViaBulkPaste(3110);
    const rows = rowsFor("TCS");
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(3110);
  });
});

describe("a mark typed BEFORE the close still wins the day (unchanged)", () => {
  it("the automatic door skips a symbol whose row the user already typed", async () => {
    await typedViaRiskDialog(3100);
    expect(rowsFor("TCS").map((r) => r.price)).toEqual([3100]);

    const auto = await liveDoor(3120);
    expect(auto?.written, "the feed overwrote a mark the user typed").toBe(false);

    const rows = rowsFor("TCS");
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(3100);
    expect(mtm.getMtmMap().get("TCS")).toBe(3100);
  });
});

describe("a typed mark must be a PRICE — the seam pass for fix wave 3 typed a 0 and erased the day's real mark", () => {
  it("the risk dialog refuses 0 with a 400 and the automatic row survives", async () => {
    await liveDoor(3120);
    const res = await riskRoute.POST(
      new Request("http://local/api/positions/risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradeId, mtmPrice: 0 }),
      }),
    );
    expect(res.status, "a typed 0 is not a mark and must not replace the day's row").toBe(400);
    expect(rowsFor("TCS").map((r) => r.price)).toEqual([3120]);
    expect(mtm.getMtmMap().get("TCS")).toBe(3120);
  });

  it("the bulk paste skips a 0 line and the automatic row survives", async () => {
    await liveDoor(3120);
    await typedViaBulkPaste(0);
    expect(rowsFor("TCS").map((r) => r.price), "a pasted 0 deleted the real mark").toEqual([3120]);
  });

  it("writeTypedMark itself refuses zero and negatives (the backstop for a third caller)", () => {
    expect(() => mtm.writeTypedMark({ symbol: "TCS", price: 0, asOfDate: DAY })).toThrow(RangeError);
    expect(() => mtm.writeTypedMark({ symbol: "TCS", price: -1, asOfDate: DAY })).toThrow(RangeError);
    expect(rowsFor("TCS")).toHaveLength(0);
  });

  it("the bulk paste keeps the tradingsymbol the feed recorded, so the desk can still price the row", async () => {
    await liveDoor(3120);
    expect(rowsFor("TCS")[0]?.tradingsymbol).toBe("TCS");
    await typedViaBulkPaste(3100);
    const rows = rowsFor("TCS");
    expect(rows.map((r) => r.price)).toEqual([3100]);
    expect(rows[0]?.tradingsymbol, "the replacement row blanked the feed's tradingsymbol").toBe("TCS");
  });
});
