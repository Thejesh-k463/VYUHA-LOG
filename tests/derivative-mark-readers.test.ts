import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * The THREE remaining readers of a stored mark, against a real (temp) database.
 *
 * OWNER RULING A-1 (v4.2 fix wave) has ONE implementation — `storedMarkFor()`
 * in `lib/analytics/positions.ts`: a row whose `instrumentType` is not
 * `"equity"` reads a mark stored under its OWN tradingsymbol, then its
 * recorded close, then its entry price — NEVER `mtm[symbol]`, which for a
 * derivative is the UNDERLYING. `mtm_prices` is keyed on `symbol`, and a
 * derivative trade carries its underlying there.
 *
 * The fix wave converted `deriveOpenPositions()` and `components/live/load-desk.ts`
 * and missed three readers, each of which kept the old underlying-first rung:
 *
 *  B-1  `app/risk/page.tsx` — the `ExposureInput.mtm` fed to `computeExposure`,
 *       and with it risk-at-stop, to-target %, margin and the SEBI radar. An
 *       open NIFTY 23500 CE (75 × ₹120) beside a stored cash `NIFTY = 23450`
 *       (the documented bulk-paste spot the Greeks panel needs) printed
 *       +₹17,49,750 unrealised — a number nothing in the book ever traded
 *       (invariant 6). The same page's futures settlement `refPrice` read the
 *       underlying's cash mark under a comment claiming it used the futures
 *       price, so the delivery notional was struck off spot.
 *
 *  B-2  `app/reports/performance/page.tsx` — the open-position leg of
 *       `unrealisedPaise`, which feeds `terminalPaise` and with it the XIRR
 *       flows and the stated terminal value. `open` is every open row (no
 *       equity filter), so the same NIFTY 23500 CE booked +17,49,750 of
 *       unrealised P&L into the money-weighted return, and the RELIANCE
 *       future was marked at the RELIANCE cash 1,400 instead of its own
 *       contract mark 1,450 — a LOSS on a position that had gained.
 *
 *  B-3  `lib/jobs/auto-mtm.ts` `scanBreaches()` — the same rung fed
 *       `detectBreaches`, so every EOD run and every /risk render raised
 *       "NIFTY: mark 23450 has reached your target 150" on an option whose
 *       premium had gone nowhere.
 *
 * WHY A DATABASE. Both readers are the mapping from stored rows to a pure
 * engine's input — the behaviour under test IS that mapping, so a pure unit
 * test of the engine cannot see it and would only agree with itself. The risk
 * page is therefore CALLED and the props it hands its panels are read off the
 * returned element tree, then run through the real `computeExposure`.
 *
 * `lib/db` is imported DYNAMICALLY, through `openTempDb`, and everything that
 * reaches it is imported after — a static import anywhere in this file's graph
 * binds the connection before the helper sets `VYUHA_DB_PATH`. ONE temp
 * database per FILE (`lib/db` caches its connection on `globalThis`).
 */

let t: TempDb;
let riskPage: () => unknown;
let computeExposure: typeof import("@/lib/analytics/exposure").computeExposure;
let scanBreaches: typeof import("@/lib/jobs/auto-mtm").scanBreaches;

const ACCOUNT = 1;
const OPTION_ID = 901;
const EQUITY_ID = 902;
const FUTURE_ID = 903;
/**
 * One CLOSED, DATED row. `/reports/performance` renders an empty state — and
 * with it no XIRR block at all — while `computePerformance` sees zero trading
 * days, and `dailyPnl` buckets on the exit date. So the B-2 assertions need a
 * realised day to exist. It is a plain equity, so it changes nothing the B-1 /
 * B-3 cases read (both are open-position surfaces, and both assert by id).
 */
const CLOSED_ID = 904;
const CLOSED_NET_PNL = 500;
/**
 * OWNER RULING C-1 (fix wave 3) — the SETTLEMENT reference of a stock future.
 * A future is settled by the exchange at the UNDERLYING's cash-segment close,
 * so these two rows are shaped like the production case wave 2 could not price:
 * sell-to-open (`buyQty 0`, so `avgBuyPrice` is still 0 until it is covered),
 * `closingPrice: null` as every import writes it, and no contract-keyed mark —
 * because nothing in the app writes one for a future.
 */
const SHORT_FUT_ID = 905;
const SHORT_FUT_TRADINGSYMBOL = "FUT TCS 24 SEP 2026";
const TCS_SPOT = 2100;
const SHORT_FUT_ENTRY = 1410;
/** …and the same row for an underlying with NO cash mark on record at all. */
const UNKNOWN_FUT_ID = 906;
const UNKNOWN_FUT_TRADINGSYMBOL = "FUT WIPRO 24 SEP 2026";

/**
 * T-1 (v4.2 fix wave 4) — THE TWO LOWER RUNGS OF THE SETTLEMENT LADDER.
 *
 * `app/risk/page.tsx` resolves a future's settlement reference as
 *   cash mark  →  nonZero(closingPrice)  →  nonZero(side-aware entry)
 * and until now every fixture in this file (and in the seam file) stopped at
 * rung 1: both C-1 futures carry a cash mark, and the third carries nothing at
 * all. So DELETING rung 2, or making rung 3 side-blind (`avgBuyPrice` for both
 * signs — the exact bug C-1 fixed), left the whole suite green. The two rows
 * below are the fixtures that reach each rung, and each one carries a DIFFERENT
 * non-zero value on the rung beneath it, so a collapse is visible as a wrong
 * rupee figure rather than as an absence.
 */
const CLOSE_FUT_ID = 907;
const CLOSE_FUT_TRADINGSYMBOL = "FUT HDFCBANK 24 SEP 2026";
/** Rung 2 — the recorded close. HDFCBANK has no `mtm_prices` row of any kind. */
const CLOSE_FUT_CLOSE = 1750;
/** …and the rung BELOW it, deliberately different, so a fallthrough shows. */
const CLOSE_FUT_ENTRY = 1700;

const SIDE_FUT_ID = 908;
const SIDE_FUT_TRADINGSYMBOL = "FUT ITC 24 SEP 2026";
/** Rung 3 on a SHORT — the sell price is the entry, and the only price it has. */
const SIDE_FUT_SELL = 480;
/** A partially-covered short carries a buy price too. A side-blind rung reads
 *  THIS one, and lands 20% low on the delivery obligation. */
const SIDE_FUT_BUY = 400;
const SIDE_FUT_QTY = 500;

/** The CASH spot of the underlying — the trap this file exists for. */
const NIFTY_SPOT = 23450;
const OPT_TRADINGSYMBOL = "OPT NIFTY 25 JUN 2026 23500 CE";
const FUT_TRADINGSYMBOL = "FUT RELIANCE 24 SEP 2026";
/** The underlying's cash mark, and the contract's own recorded mark. */
const RELIANCE_SPOT = 1400;
const RELIANCE_FUT_MARK = 1450;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (n: number) => iso(new Date(Date.now() + n * 86400000));

/** Collect every `props[key]` in a React element tree (the page is never rendered). */
function collectProps(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const n of node) collectProps(n, key, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props) {
    if (key in props) out.push(props[key]);
    collectProps(props.children, key, out);
  }
  return out;
}

type ExposureInput = Parameters<typeof computeExposure>[0][number];

let inputs: ExposureInput[];
let settlement: import("@/lib/analytics/settlement").SettlementSummary;
/** Every text node of the rendered-element tree of /reports/performance, joined. */
let perfText: string;
/** The capital base that page resolved, read from the same database. */
let perfCapital: number;

/**
 * Concatenate every string/number leaf of a React element tree.
 *
 * The performance report never puts its unrealised total in a prop — it flows
 * into `terminalPaise` and is STATED, in the XIRR footnote, as
 * "… over ₹X terminal value". So the observable is that text.
 */
function flattenText(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) flattenText(n, out);
    return out;
  }
  if (typeof node === "object") {
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) flattenText(props.children, out);
  }
  return out;
}

beforeAll(async () => {
  t = await openTempDb("derivative-mark-readers", { seed: true });
  ({ computeExposure } = await import("@/lib/analytics/exposure"));
  ({ scanBreaches } = await import("@/lib/jobs/auto-mtm"));
  riskPage = (await import("@/app/risk/page")).default as () => unknown;

  t.db.update(t.schema.settings).set({ equityCapital: 1_000_000, activeCapital: 1_000_000 }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      // An open index CALL. Its premium went 120 → 130; the underlying sits at 23,450.
      tradeRow({
        id: OPTION_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "index_option",
        instrumentType: "option",
        symbol: "NIFTY",
        tradingsymbol: OPT_TRADINGSYMBOL,
        optionType: "CE",
        strike: 23500,
        expiry: plusDays(20),
        buyQty: 75,
        sellQty: 0,
        avgBuyPrice: 120,
        closingPrice: 130,
        targetPlanned: 150,
        isOpen: true,
      }),
      // CONTROL — an equity row must still read its cash mark.
      tradeRow({
        id: EQUITY_ID,
        accountId: ACCOUNT,
        symbol: "TCS",
        tradingsymbol: "TCS",
        instrumentType: "equity",
        buyQty: 10,
        sellQty: 0,
        avgBuyPrice: 2000,
        closingPrice: 2010,
        targetPlanned: 2050,
        isOpen: true,
      }),
      // A stock FUTURE with a mark of its own recorded under its contract.
      tradeRow({
        id: FUTURE_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        symbol: "RELIANCE",
        tradingsymbol: FUT_TRADINGSYMBOL,
        expiry: plusDays(10),
        buyQty: 500,
        sellQty: 0,
        avgBuyPrice: 1410,
        closingPrice: 1420,
        isOpen: true,
      }),
      // C-1 — a SHORT stock future on an underlying that HAS a cash mark.
      tradeRow({
        id: SHORT_FUT_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        symbol: "TCS",
        tradingsymbol: SHORT_FUT_TRADINGSYMBOL,
        expiry: plusDays(10),
        buyQty: 0,
        sellQty: 500,
        avgBuyPrice: 0, // sell-to-open: 0 until the position is covered
        avgSellPrice: SHORT_FUT_ENTRY,
        closingPrice: null,
        isOpen: true,
      }),
      // C-1 — the same row with NOTHING to price it: no cash mark for WIPRO,
      // no close, and no entry price either. Unknown must stay unknown.
      tradeRow({
        id: UNKNOWN_FUT_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        symbol: "WIPRO",
        tradingsymbol: UNKNOWN_FUT_TRADINGSYMBOL,
        expiry: plusDays(10),
        buyQty: 0,
        sellQty: 300,
        avgBuyPrice: 0,
        avgSellPrice: 0,
        closingPrice: null,
        isOpen: true,
      }),
      // T-1 rung 2 — NO cash mark for HDFCBANK anywhere in mtm_prices, but the
      // row carries a recorded close. Sell-to-open, so `avgBuyPrice` is 0 and
      // the entry rung underneath is `avgSellPrice`, a different figure.
      tradeRow({
        id: CLOSE_FUT_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        symbol: "HDFCBANK",
        tradingsymbol: CLOSE_FUT_TRADINGSYMBOL,
        expiry: plusDays(10),
        buyQty: 0,
        sellQty: 500,
        avgBuyPrice: 0,
        avgSellPrice: CLOSE_FUT_ENTRY,
        closingPrice: CLOSE_FUT_CLOSE,
        isOpen: true,
      }),
      // T-1 rung 3 — no cash mark, no close, and BOTH entry prices non-zero
      // (a short 600 partially covered by 100). Only the side-aware rung reads
      // the sell price; a side-blind one reads 400 and understates delivery.
      tradeRow({
        id: SIDE_FUT_ID,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        symbol: "ITC",
        tradingsymbol: SIDE_FUT_TRADINGSYMBOL,
        expiry: plusDays(10),
        buyQty: 100,
        sellQty: 600,
        avgBuyPrice: SIDE_FUT_BUY,
        avgSellPrice: SIDE_FUT_SELL,
        closingPrice: null,
        isOpen: true,
      }),
      // A closed, dated equity — see CLOSED_ID above.
      tradeRow({
        id: CLOSED_ID,
        accountId: ACCOUNT,
        symbol: "INFY",
        tradingsymbol: "INFY",
        buyQty: 10,
        sellQty: 10,
        avgBuyPrice: 1500,
        avgSellPrice: 1550,
        buyDate: plusDays(-30),
        sellDate: plusDays(-5),
        netPnl: CLOSED_NET_PNL,
        grossPnl: CLOSED_NET_PNL,
        isOpen: false,
      }),
    ])
    .run();

  t.db
    .insert(t.schema.mtmPrices)
    .values([
      // Cash marks — what a bulk paste / bhavcopy leaves behind. NIFTY is here
      // because the Greeks panel needs the underlying's spot.
      { symbol: "NIFTY", tradingsymbol: "NIFTY", price: NIFTY_SPOT, asOfDate: "2026-09-04" },
      { symbol: "TCS", tradingsymbol: "TCS", price: TCS_SPOT, asOfDate: "2026-09-04" },
      { symbol: "RELIANCE", tradingsymbol: "RELIANCE", price: RELIANCE_SPOT, asOfDate: "2026-09-04" },
      // …and the future's OWN mark, keyed on its contract.
      {
        symbol: FUT_TRADINGSYMBOL,
        tradingsymbol: FUT_TRADINGSYMBOL,
        price: RELIANCE_FUT_MARK,
        asOfDate: "2026-09-04",
      },
    ])
    .run();

  const perfPage = (await import("@/app/reports/performance/page")).default as () => unknown;
  ({ totalCapital: perfCapital } = (await import("@/lib/queries/capital")).getBucketCapital());
  perfText = flattenText(perfPage()).join("");

  const tree = riskPage();
  inputs = collectProps(tree, "inputs")[0] as ExposureInput[];
  settlement = collectProps(tree, "summary").find(
    (s): s is import("@/lib/analytics/settlement").SettlementSummary =>
      !!s && typeof s === "object" && "obligations" in (s as object),
  )!;
});

afterAll(() => t?.cleanup());

describe("B-1 /risk never prices a derivative at the underlying's cash mark", () => {
  it("hands computeExposure the option's own close, not the 23,450 spot", () => {
    const opt = inputs.find((p) => p.id === OPTION_ID)!;
    expect(opt.mtm).not.toBe(NIFTY_SPOT);
    expect(opt.mtm).toBe(130);

    const exposure = computeExposure(inputs, 1_000_000);
    const row = exposure.positions.find((p) => p.id === OPTION_ID)!;
    // (close − entry) × qty = (130 − 120) × 75. The bug printed
    // (23450 − 120) × 75 = 17,49,750.
    expect(row.unrealised).toBe(750);
    expect(row.currentValue).toBe(9750);
  });

  it("CONTROL: an equity row still reads its cash mark", () => {
    const eq = inputs.find((p) => p.id === EQUITY_ID)!;
    expect(eq.mtm).toBe(2100);
    const exposure = computeExposure(inputs, 1_000_000);
    expect(exposure.positions.find((p) => p.id === EQUITY_ID)!.unrealised).toBe(1000);
  });

  it("the Greeks/settlement spot map is untouched — the option still sees 23,450", () => {
    // The `spot` rung reads getSpotMap() ON PURPOSE (Black-Scholes needs the
    // underlying). A-1 is about the PREMIUM, not the spot.
    expect(inputs.find((p) => p.id === OPTION_ID)!.spot).toBe(NIFTY_SPOT);
  });

  /**
   * C-1 — the ONE place A-1's contract-mark precedence is the wrong reference.
   * The exchange settles a stock future at the UNDERLYING's cash-segment close,
   * so the delivery notional is struck off the same `spot` map the option
   * branch reads — and when nothing prices the underlying, the value is
   * UNKNOWN, not ₹0 (invariant 6). Wave 2 read `storedMarkFor() ?? close ??
   * avgBuyPrice`, which in production is null ?? null ?? 0 on a sell-to-open
   * future, so this panel printed "₹0" delivery value and "₹0" STT jump on a
   * position that will certainly devolve into 500 shares.
   */
  it("C-1 futures settlement values delivery at the UNDERLYING's cash mark", () => {
    const ob = settlement.obligations.find((o) => o.id === FUTURE_ID)!;
    expect(ob.kind).toBe("stock_future");
    // notional = the underlying's cash mark × qty…
    expect(ob.notional).toBe(RELIANCE_SPOT * 500);
    // …and NOT the contract's own mark, which A-1 keeps for P&L only.
    expect(ob.notional).not.toBe(RELIANCE_FUT_MARK * 500);
    expect(ob.physicalStt).toBe(Math.round(0.001 * RELIANCE_SPOT * 500)); // 700
  });

  it("C-1 a SHORT sell-to-open future is valued at the cash mark, never ₹0", () => {
    const ob = settlement.obligations.find((o) => o.id === SHORT_FUT_ID)!;
    expect(ob.side).toBe("short");
    expect(ob.settles).toBe("yes");
    // The wave-2 chain was null ?? null ?? avgBuyPrice(0) → ₹0 for this row.
    expect(ob.notional).not.toBe(0);
    expect(ob.notional).toBe(TCS_SPOT * 500); // 10,50,000
    expect(ob.physicalStt).toBe(1050); // 0.1% of it
    // M-1 (wave 4): squaring a SHORT future off is a BUY, and futures STT is a
    // SELL-side levy — so there is no exit STT to net off, and the jump is the
    // WHOLE delivery STT. This pin asserted 1050 − 525, i.e. a ₹525 exit charge
    // this position would never have paid, which UNDERSTATED the jump by half.
    expect(ob.exitStt).toBe(0);
    expect(ob.sttJump).toBe(1050);
    // …and not the side-blind entry rung either (avgSellPrice is the fallback,
    // used only when nothing prices the underlying).
    expect(ob.notional).not.toBe(SHORT_FUT_ENTRY * 500);
  });

  /**
   * T-1 — the ladder's lower rungs, each reached by a fixture of its own. See
   * the CLOSE_FUT_ID / SIDE_FUT_ID header above for why they exist.
   */
  it("T-1 rung 2: no cash mark on the underlying → the RECORDED CLOSE prices the delivery", () => {
    const ob = settlement.obligations.find((o) => o.id === CLOSE_FUT_ID)!;
    expect(ob.kind).toBe("stock_future");
    expect(ob.settles).toBe("yes");
    expect(ob.notional).toBe(CLOSE_FUT_CLOSE * 500); // 8,75,000
    // Delete rung 2 and this falls through to the entry rung below it.
    expect(ob.notional).not.toBe(CLOSE_FUT_ENTRY * 500);
    expect(ob.notional).not.toBeNull();
  });

  it("T-1 rung 3: nothing prices it but its own entry, and the entry is read SIDE-AWARE", () => {
    const ob = settlement.obligations.find((o) => o.id === SIDE_FUT_ID)!;
    expect(ob.side).toBe("short");
    expect(ob.netQty).toBe(SIDE_FUT_QTY);
    expect(ob.notional).toBe(SIDE_FUT_SELL * SIDE_FUT_QTY); // 2,40,000
    // A side-blind rung (`avgBuyPrice` for both signs) prices this row at
    // ₹2,00,000 — 17% short of the shares it will actually have to deliver.
    expect(ob.notional).not.toBe(SIDE_FUT_BUY * SIDE_FUT_QTY);
  });

  it("C-1 with no cash mark, no close and no entry the notional stays UNKNOWN", () => {
    const ob = settlement.obligations.find((o) => o.id === UNKNOWN_FUT_ID)!;
    expect(ob.settles).toBe("yes"); // it still devolves — only its value is unknown
    expect(ob.notional).toBeNull();
    expect(ob.notional).not.toBe(0);
    expect(ob.physicalStt).toBeNull();
    expect(ob.sttJump).toBeNull();
    // The totals exclude it and say how many they excluded.
    expect(settlement.unknownNotionalCount).toBe(1);
    // Every OTHER settling row on this book, each priced off the rung it
    // reaches: cash mark (×2), recorded close, side-aware entry.
    expect(settlement.notionalAtRisk).toBe(
      RELIANCE_SPOT * 500 + TCS_SPOT * 500 + CLOSE_FUT_CLOSE * 500 + SIDE_FUT_SELL * SIDE_FUT_QTY,
    );
  });

  it("C-1 CONTROL: the option branch still reads the underlying's spot", () => {
    const ob = settlement.obligations.find((o) => o.id === OPTION_ID)!;
    // NIFTY is cash-settled, so it carries no delivery obligation — but the
    // moneyness it resolved is the spot rung, unchanged by C-1.
    expect(ob.kind).toBe("index_cash");
    expect(inputs.find((p) => p.id === OPTION_ID)!.spot).toBe(NIFTY_SPOT);
  });
});

describe("B-3 scanBreaches never alerts a derivative at the underlying's cash mark", () => {
  it("raises no breach on the option while its own premium is short of the target", () => {
    const breaches = scanBreaches();
    expect(breaches.find((b) => b.id === OPTION_ID)).toBeUndefined();
  });

  it("CONTROL: the equity row still breaches on its cash mark", () => {
    const b = scanBreaches().find((x) => x.id === EQUITY_ID)!;
    expect(b.kind).toBe("target");
    expect(b.message).toContain("TCS: mark 2100 has reached your target 2050");
  });

  it("raises the breach on the option's own CLOSE once that passes the target", () => {
    t.sqlite.prepare("UPDATE trades SET closing_price = ? WHERE id = ?").run(160, OPTION_ID);
    const b = scanBreaches().find((x) => x.id === OPTION_ID)!;
    expect(b.kind).toBe("target");
    expect(b.mtm).toBe(160);
    expect(b.message).toContain("mark 160 has reached your target 150");
    t.sqlite.prepare("UPDATE trades SET closing_price = ? WHERE id = ?").run(130, OPTION_ID);
  });
});

describe("B-2 /reports/performance never prices a derivative at the underlying's cash mark", () => {
  /** (mark − entry) × qty, per row, with the mark each row is entitled to. */
  const OPTION_UNREALISED = (130 - 120) * 75; //      750  — its own close, no contract mark stored
  const EQUITY_UNREALISED = (2100 - 2000) * 10; //  1,000  — the cash mark, unchanged for equities
  const FUTURE_UNREALISED = (1450 - 1410) * 500; // 20,000 — the FUTURE's own mark, not RELIANCE cash
  const UNREALISED = OPTION_UNREALISED + EQUITY_UNREALISED + FUTURE_UNREALISED; // 21,750

  /** What the underlying-first rung produced: spot premium + a phantom future loss. */
  const UNREALISED_AT_UNDERLYING =
    (NIFTY_SPOT - 120) * 75 + EQUITY_UNREALISED + (RELIANCE_SPOT - 1410) * 500; // 17,45,750

  /** The ₹ figure the XIRR footnote states as the terminal value. */
  function statedTerminal(): number {
    const m = /over\s*₹\s*([\d,]+)\s*terminal value/.exec(perfText);
    expect(m, `no terminal-value figure in the page text: ${perfText.slice(0, 200)}`).not.toBeNull();
    return Number(m![1].replace(/,/g, ""));
  }

  it("the page states a capital base at all (else the XIRR block would not render)", () => {
    expect(perfCapital).toBeGreaterThan(0);
  });

  it("books the option at its own close and the future at its own contract mark", () => {
    // The ledger is empty and exactly one trade is closed, so the stated
    // terminal value is the capital base + that realised P&L + the unrealised
    // leg — and the unrealised leg is the only unknown in it.
    expect(statedTerminal() - perfCapital - CLOSED_NET_PNL).toBe(UNREALISED);
  });

  it("never books the 23,450 spot premium or the RELIANCE cash mark", () => {
    // (C-10) A second `not.toContain(String(NIFTY_SPOT - 120))` line stood here
    // and could never fire: every rupee on that page goes through `inr()`, so
    // the digits "23330" are never adjacent in the text. The line above is the
    // real negative — it reads the stated terminal value and compares numbers.
    expect(statedTerminal() - perfCapital - CLOSED_NET_PNL).not.toBe(UNREALISED_AT_UNDERLYING);
  });
});
