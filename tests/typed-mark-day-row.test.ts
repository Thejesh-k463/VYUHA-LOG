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
let commit: typeof import("@/lib/import/commit");

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
  commit = await import("@/lib/import/commit");

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
        body: JSON.stringify({ tradeId, mtmPrice: 0, originalSl: 2950 }),
      }),
    );
    expect(res.status, "a typed 0 is not a mark and must not replace the day's row").toBe(400);
    // A 400 means NOTHING was saved: the stop sent beside the 0 must not have
    // landed, or the dialog's "failed" toast sits over a half-persisted form.
    const trade = t.db.select().from(t.schema.trades).all().find((r) => r.id === tradeId);
    expect(trade?.slPlanned ?? null, "the 400 was returned after the stops were written").toBeNull();
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

describe("each layer of the tradingsymbol carry reds on its own (fix wave 3 audit, T1)", () => {
  it("the helper carries the held row's tradingsymbol when the caller does not know it", () => {
    mtm.writeTypedMark({ symbol: "TCS", tradingsymbol: "TCS-EQ", price: 3120, asOfDate: DAY });
    mtm.writeTypedMark({ symbol: "TCS", price: 3100, asOfDate: DAY }); // no tradingsymbol key at all
    const rows = rowsFor("TCS");
    expect(rows.map((r) => r.price)).toEqual([3100]);
    expect(rows[0]?.tradingsymbol, "the helper blanked (or replaced with the symbol) the feed's tradingsymbol").toBe("TCS-EQ");
  });

  it("the paste hands over the open trade's tradingsymbol rather than leaning on the carry", async () => {
    mtm.writeTypedMark({ symbol: "TCS", tradingsymbol: "TCS-EQ", price: 3120, asOfDate: DAY });
    await typedViaBulkPaste(3100);
    const rows = rowsFor("TCS");
    expect(rows.map((r) => r.price)).toEqual([3100]);
    // The seeded trade's tradingsymbol is "TCS"; a paste that passed nothing
    // would have carried "TCS-EQ" from the held row instead.
    expect(rows[0]?.tradingsymbol, "the paste did not pass the trade's tradingsymbol").toBe("TCS");
  });
});

describe("the trade form's own mark writers follow the same rule (fix wave 3 audit, M2)", () => {
  it("editing a trade's Current price after the automatic mark replaces the day's row", async () => {
    await liveDoor(3120);
    expect(commit.updateManualTrade(tradeId, { currentPrice: 3100 }).ok).toBe(true);
    expect(rowsFor("TCS").map((r) => r.price), "the edit door queued its mark behind the automatic row").toEqual([3100]);
    expect(mtm.getMtmMap().get("TCS")).toBe(3100);
  });
});

describe("the bulk paste refuses what it cannot read rather than storing a wrong mark (fix wave 3 audit, M3)", () => {
  it("a thousands-grouped price in the comma form is read as one number, not as ₹3 with a ₹100.50 stop", async () => {
    await liveDoor(3120);
    const form = new FormData();
    form.set("prices", "TCS, 3,100.50");
    form.set("asOf", DAY);
    const res = await equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
    expect(rowsFor("TCS").map((r) => r.price), "'3,100.50' was read as a ₹3 mark").toEqual([3100.5]);
    expect(res.ok).toBe(true);
    const trade = t.db.select().from(t.schema.trades).all().find((r) => r.id === tradeId);
    expect(trade?.slPlanned ?? null, "'100.50' was read as a stop").toBeNull();
  });

  it("the space form with a grouped price reads the same way, and a lakh grouping too", async () => {
    const form = new FormData();
    form.set("prices", "TCS 3,100.50\nRELIANCE 1,23,456.00");
    form.set("asOf", DAY);
    await equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
    expect(rowsFor("TCS").map((r) => r.price)).toEqual([3100.5]);
    expect(rowsFor("TCS 3")).toEqual([]);
    expect(rowsFor("RELIANCE").map((r) => r.price)).toEqual([123456]);
  });

  it("the form's own placeholder lines and 3-digit prices with 3-digit stops are read (an earlier guard refused them)", async () => {
    const form = new FormData();
    form.set("prices", "TCS, 724.35, 705, 715, 760\nRELIANCE, 800, 790\nNIFTY,234");
    form.set("asOf", DAY);
    const res = await equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
    expect(res.ok).toBe(true);
    expect(rowsFor("TCS").map((r) => r.price)).toEqual([724.35]);
    expect(rowsFor("RELIANCE").map((r) => r.price)).toEqual([800]);
    expect(rowsFor("NIFTY").map((r) => r.price)).toEqual([234]);
    const trade = t.db.select().from(t.schema.trades).all().find((r) => r.id === tradeId);
    expect(trade?.slPlanned).toBe(705);
  });

  it("a plain comma-separated line with 4-digit prices is still read", async () => {
    const form = new FormData();
    form.set("prices", "TCS,3120,3000,2950");
    form.set("asOf", DAY);
    const res = await equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
    expect(res.ok).toBe(true);
    expect(rowsFor("TCS").map((r) => r.price)).toEqual([3120]);
  });

  it("a future as-of date is refused — it would outrank every real day for decades", async () => {
    const form = new FormData();
    form.set("prices", "TCS 3100");
    form.set("asOf", "2062-09-04");
    const res = await equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("future");
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM mtm_prices").get()).toEqual({ n: 0 });
  });

  it("a well-shaped but impossible date (month 13) is refused too — the ranges in the regex are load-bearing", async () => {
    const form = new FormData();
    form.set("prices", "TCS 3100");
    form.set("asOf", "2026-13-45");
    const res = await equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
    expect(res.ok).toBe(false);
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM mtm_prices").get()).toEqual({ n: 0 });
  });

  it("an as-of date that is not YYYY-MM-DD is refused before anything is written", async () => {
    const form = new FormData();
    form.set("prices", "TCS 3100");
    form.set("asOf", "07-09-2026");
    const res = await equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("YYYY-MM-DD");
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM mtm_prices").get()).toEqual({ n: 0 });
  });
});

describe("a typed mark on an option or future is refused at every door (owner ruling, fix wave 3 audit, M1)", () => {
  let optionId = 0;
  beforeAll(() => {
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: ACCOUNT,
          symbol: "RELIANCE",
          tradingsymbol: "RELIANCE25SEP3000CE",
          instrumentType: "option",
          segment: "stock_option",
          bucket: "active",
          exchange: "NSE",
          isOpen: true,
          buyQty: 250,
          avgBuyPrice: 40,
        }),
      )
      .run();
    optionId = t.db.select().from(t.schema.trades).all().find((r) => r.symbol === "RELIANCE")!.id;
  });

  it("the risk dialog answers 400 and the underlying's cash mark survives", async () => {
    mtm.writeTypedMark({ symbol: "RELIANCE", tradingsymbol: "RELIANCE", price: 3120, asOfDate: DAY });
    const res = await riskRoute.POST(
      new Request("http://local/api/positions/risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradeId: optionId, mtmPrice: 42.5 }),
      }),
    );
    expect(res.status, "the option premium replaced RELIANCE's cash mark").toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(mtm.DERIVATIVE_MARK_MESSAGE);
    expect(rowsFor("RELIANCE").map((r) => r.price)).toEqual([3120]);
  });

  it("the risk dialog's full save on an option still lands the stops — only the mark is refused", async () => {
    mtm.writeTypedMark({ symbol: "RELIANCE", tradingsymbol: "RELIANCE", price: 3120, asOfDate: DAY });
    const res = await riskRoute.POST(
      new Request("http://local/api/positions/risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The dialog's real shape: it pre-fills and sends a price on EVERY save.
        body: JSON.stringify({ tradeId: optionId, mtmPrice: 42.5, originalSl: 30, target: 60 }),
      }),
    );
    expect(res.status, "refusing the mark must not refuse the stops beside it").toBe(200);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain("not stored");
    const trade = t.db.select().from(t.schema.trades).all().find((r) => r.id === optionId);
    expect(trade?.slPlanned).toBe(30);
    expect(trade?.targetPlanned).toBe(60);
    expect(rowsFor("RELIANCE").map((r) => r.price), "the premium still landed under the underlying").toEqual([3120]);
  });

  it("the paste is NOT a derivative door: its line names the underlying, so an index level is stored even for a derivatives-only book", async () => {
    const form = new FormData();
    form.set("prices", "RELIANCE 3125");
    form.set("asOf", DAY);
    const res = await equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
    expect(res.ok).toBe(true);
    expect(rowsFor("RELIANCE").map((r) => r.price), "the options book lost its only typed spot source").toEqual([3125]);
  });

  it("the edit form keeps the trade but does not store the premium, and says so", () => {
    mtm.writeTypedMark({ symbol: "RELIANCE", tradingsymbol: "RELIANCE", price: 3120, asOfDate: DAY });
    const r = commit.updateManualTrade(optionId, { currentPrice: 42.5 });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("not stored");
    expect(rowsFor("RELIANCE").map((r) => r.price)).toEqual([3120]);
  });

  it("a pasted 0 line is named in the message, not silently dropped", async () => {
    const form = new FormData();
    form.set("prices", "TCS 0 2950");
    form.set("asOf", DAY);
    const res = await equity.saveMtmPrices({ ok: false, message: "", updated: 0 }, form);
    expect(res.message).toContain("price of 0");
    expect(rowsFor("TCS")).toEqual([]);
  });
});

describe("the create door and the bhavcopy job, the two writers no earlier test drove (fix wave 3b audit, T1/T4)", () => {
  const NL = String.fromCharCode(10);
  const manual = (tradingsymbol: string, qty: number, price: number) => ({
    broker: "zerodha" as const,
    tradingsymbol,
    isin: null,
    buyQty: qty, avgBuyPrice: price, buyValue: qty * price,
    sellQty: 0, avgSellPrice: 0, sellValue: 0,
    closingPrice: null, grossPnl: 0, unrealisedPnl: 0,
    buyDate: null, sellDate: null, productHint: null, exchangeHint: null, sourceFile: "manual",
  });

  it("a Current price typed on the create form replaces the automatic row (the door bare-inserted before)", async () => {
    await liveDoor(3120);
    const res = commit.commitManualTrade(manual("TCS", 5, 2990), { currentPrice: 3100 });
    expect(res.id).toBeTruthy();
    expect(rowsFor("TCS").map((r) => r.price), "the create door queued its mark behind the automatic row").toEqual([3100]);
  });

  it("a Current price on an F&O create is not stored under the underlying", () => {
    mtm.writeTypedMark({ symbol: "RELIANCE", tradingsymbol: "RELIANCE", price: 3120, asOfDate: DAY });
    const res = commit.commitManualTrade(manual("OPT RELIANCE 30 Sep 2026 3000 CE", 250, 40), { currentPrice: 42.5 });
    expect(res.id).toBeTruthy();
    expect(rowsFor("RELIANCE").map((r) => r.price), "the premium replaced the underlying's cash mark").toEqual([3120]);
  });

  it("the Auto-MTM bhavcopy job replaces a typed mark with the exchange close — the sentence's third clause", async () => {
    await typedViaRiskDialog(3100);
    const bhav = await import("@/lib/import/mtm-bhavcopy");
    const text = [
      "TradDt,BizDt,Sgmt,Src,FinInstrmTp,ISIN,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol",
      "2026-09-04,2026-09-04,CM,NSE,STK,INE467B01029,TCS,EQ,3000,3040,2990,3010,45000",
    ].join(NL);
    const r = bhav.applyBhavcopyMtm(text);
    expect(r.ok).toBe(true);
    expect(rowsFor("TCS").map((x) => x.price), "the docs say the bhavcopy job replaces a typed mark; it did not").toEqual([3010]);
  });
});
