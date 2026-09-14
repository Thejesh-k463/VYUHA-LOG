import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import * as upstox from "@/lib/import/api/upstox";
import {
  canonicalUpstoxSymbol,
  exchangeOf,
  isDerivativeExchange,
  isinOf,
  normalizeUpstoxTrades,
  productHintOf,
  stripSeriesSuffix,
  toParsedFile,
  type UpstoxTradeRow,
} from "@/lib/import/api/upstox";
import { classify } from "@/lib/engine/classify";

/**
 * Rows in this file are from the REAL get-trades-for-day payload of
 * 2026-08-28 (11 fills across NSE/NFO/BFO, products D/I/MTF) — the first
 * native Upstox pull ever made. The traps these tests pin were all found in
 * that payload, not in the docs.
 */

const TODAY = "2026-08-28";

const fill = (over: Partial<UpstoxTradeRow> = {}): UpstoxTradeRow => ({
  exchange: "NSE",
  product: "D",
  tradingsymbol: "PRECWIRE-EQ",
  trading_symbol: "PRECWIRE-EQ",
  instrument_token: "NSE_EQ|INE372C01037",
  transaction_type: "BUY",
  quantity: 3,
  average_price: 443.3,
  order_timestamp: "2026-08-28 11:55:42",
  exchange_timestamp: "2026-08-28 17:25:42",
  ...over,
});

describe("mapping tables — verified against the live payload", () => {
  it("single-letter products map for equity; MTF arrives as the literal string", () => {
    expect(productHintOf("D", false)).toBe("delivery");
    expect(productHintOf("I", false)).toBe("intraday");
    expect(productHintOf("MTF", false)).toBe("mtf");
    expect(productHintOf("X", false)).toBeNull();
  });

  it("derivatives always hint null — Upstox labels an option CARRY as 'D'", () => {
    // Real row: NIFTY2690124350CE carried product "D" (their NRML); a
    // delivery hint on an option would only fight the classifier.
    expect(productHintOf("D", true)).toBeNull();
    expect(productHintOf("I", true)).toBeNull();
  });

  it("exchanges fold to the three the app knows", () => {
    expect(exchangeOf("NSE")).toBe("NSE");
    expect(exchangeOf("NFO")).toBe("NSE");
    expect(exchangeOf("BFO")).toBe("BSE");
    expect(exchangeOf("MCX_FO")).toBe("MCX");
    expect(exchangeOf("SOMETHING")).toBeNull();
  });

  it("derivative exchanges are NFO/BFO/MCX — currency stays out", () => {
    expect(isDerivativeExchange("NFO")).toBe(true);
    expect(isDerivativeExchange("BFO")).toBe(true);
    expect(isDerivativeExchange("NSE")).toBe(false);
    expect(isDerivativeExchange("CDS")).toBe(false);
  });

  it("the equity instrument_token carries the ISIN; F&O tokens do not", () => {
    expect(isinOf("NSE_EQ|INE372C01037")).toBe("INE372C01037");
    expect(isinOf("BSE_FO|859025")).toBeNull();
    expect(isinOf(undefined)).toBeNull();
  });

  it("NSE series suffixes strip so symbols line up across sources", () => {
    expect(stripSeriesSuffix("EBGNG-EQ")).toBe("EBGNG");
    expect(stripSeriesSuffix("PRECWIRE")).toBe("PRECWIRE");
  });
});

describe("canonicalUpstoxSymbol — the compact WEEKLY format, from real contracts", () => {
  it("parses the live payload's three option symbols", () => {
    // NIFTY2690124350CE = NIFTY, 2026, month 9, day 01 — 01 Sep 2026.
    expect(canonicalUpstoxSymbol("NIFTY2690124350CE", "NFO")).toBe("OPT NIFTY 01 Sep 2026 24350 CE");
    expect(canonicalUpstoxSymbol("NIFTY2690124000PE", "NFO")).toBe("OPT NIFTY 01 Sep 2026 24000 PE");
    expect(canonicalUpstoxSymbol("SENSEX2690378300CE", "BFO")).toBe("OPT SENSEX 03 Sep 2026 78300 CE");
  });

  it("reads the O/N/D month codes for Oct–Dec", () => {
    expect(canonicalUpstoxSymbol("NIFTY26O0724500CE", "NFO")).toBe("OPT NIFTY 07 Oct 2026 24500 CE");
    expect(canonicalUpstoxSymbol("NIFTY26D2924500PE", "NFO")).toBe("OPT NIFTY 29 Dec 2026 24500 PE");
  });

  it("REFUSES the monthly format — it states no expiry day, and calendars are not guessed", () => {
    expect(canonicalUpstoxSymbol("NIFTY26SEP24000CE", "NFO")).toBeNull();
    expect(canonicalUpstoxSymbol("NIFTY26SEPFUT", "NFO")).toBeNull();
  });

  it("never reshapes a symbol off the derivative exchanges", () => {
    expect(canonicalUpstoxSymbol("PRECWIRE-EQ", "NSE")).toBeNull();
  });

  it("the canonical name classifies as an index option on the right exchange", () => {
    const name = canonicalUpstoxSymbol("SENSEX2690378300CE", "BFO")!;
    const cls = classify({ tradingsymbol: name, exchangeHint: exchangeOf("BFO"), productHint: null });
    expect(cls.instrumentType).toBe("option");
    expect(cls.segment).toBe("index_option");
    expect(cls.exchange).toBe("BSE");
    expect(cls.expiry).toBe("2026-09-03");
    expect(cls.strike).toBe(78300);
  });
});

describe("normalizeUpstoxTrades — the 2026-08-28 live book, end to end", () => {
  it("aggregates the real MTF round trip and keeps the stated MTF product", () => {
    const { trades } = normalizeUpstoxTrades(
      [
        fill({ tradingsymbol: "EBGNG-EQ", trading_symbol: "EBGNG-EQ", product: "MTF", instrument_token: "NSE_EQ|INE18JU01028", transaction_type: "SELL", quantity: 5, average_price: 620.6, order_timestamp: "2026-08-28 11:53:57" }),
        fill({ tradingsymbol: "EBGNG-EQ", trading_symbol: "EBGNG-EQ", product: "MTF", instrument_token: "NSE_EQ|INE18JU01028", transaction_type: "BUY", quantity: 3, average_price: 621.9, order_timestamp: "2026-08-28 11:52:13" }),
        fill({ tradingsymbol: "EBGNG-EQ", trading_symbol: "EBGNG-EQ", product: "MTF", instrument_token: "NSE_EQ|INE18JU01028", transaction_type: "BUY", quantity: 2, average_price: 621.85, order_timestamp: "2026-08-28 11:52:13" }),
      ],
      TODAY,
    );
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.tradingsymbol).toBe("EBGNG");
    expect(t.isin).toBe("INE18JU01028");
    expect(t.productHint).toBe("mtf");
    expect(t.buyQty).toBe(5);
    expect(t.avgBuyPrice).toBe(621.88);
    expect(t.buyValue).toBe(3109.4);
    expect(t.grossPnl).toBe(r2(3103 - 3109.4));
  });

  it("reads times from order_timestamp, NEVER exchange_timestamp (the +05:30 trap)", () => {
    const { trades } = normalizeUpstoxTrades(
      [
        fill({ tradingsymbol: "SENSEX2690378300CE", trading_symbol: "SENSEX2690378300CE", exchange: "BFO", product: "I", instrument_token: "BSE_FO|859025", quantity: 20, average_price: 90.05, order_timestamp: "2026-08-28 11:46:39", exchange_timestamp: "2026-08-28 17:16:39" }),
        fill({ tradingsymbol: "SENSEX2690378300CE", trading_symbol: "SENSEX2690378300CE", exchange: "BFO", product: "I", instrument_token: "BSE_FO|859025", transaction_type: "SELL", quantity: 20, average_price: 90.8, order_timestamp: "2026-08-28 11:49:32", exchange_timestamp: "2026-08-28 17:19:32" }),
      ],
      TODAY,
    );
    const t = trades[0]!;
    expect(t.tradingsymbol).toBe("OPT SENSEX 03 Sep 2026 78300 CE");
    expect(t.entryTime).toBe("11:46");
    expect(t.exitTime).toBe("11:49");
    expect(t.productHint).toBeNull();
    expect(t.exchangeHint).toBe("BSE");
  });

  it("keeps the raw name and SAYS SO for a monthly-format derivative symbol", () => {
    const { trades, notes } = normalizeUpstoxTrades(
      [fill({ tradingsymbol: "NIFTY26SEP24000CE", trading_symbol: "NIFTY26SEP24000CE", exchange: "NFO", product: "D" })],
      TODAY,
    );
    expect(trades[0]!.tradingsymbol).toBe("NIFTY26SEP24000CE");
    expect(notes.join(" ")).toMatch(/does not parse as a weekly option/i);
  });

  it("refuses a fill with no readable side, quantity or price — counted, never coerced", () => {
    const { trades, refused } = normalizeUpstoxTrades(
      [fill({ quantity: 0 }), fill({ transaction_type: "??" }), fill({ average_price: 0 })],
      TODAY,
    );
    expect(trades).toHaveLength(0);
    expect(refused).toBe(3);
  });

  it("QS-AO: a sell-only row is dated today and basis-unknown — a sale out of a holding the book cannot see, not an undated short", () => {
    const { trades } = normalizeUpstoxTrades([fill({ transaction_type: "SELL", average_price: 450 })], TODAY);
    expect(trades[0]).toMatchObject({ buyQty: 0, sellQty: 3, buyDate: null, sellDate: TODAY, basisUnknown: true });
    expect(normalizeUpstoxTrades([fill(), fill({ transaction_type: "SELL" })], TODAY).trades[0]!.basisUnknown).toBeUndefined();
    expect(normalizeUpstoxTrades([fill()], TODAY).trades[0]!.basisUnknown).toBeUndefined();
  });
});

describe("R43 + QS-AO · a same-day re-pull replaces today's earlier row in place (commit, one temp database)", () => {
  // ONE temp database for this file (AGENTS.md); nothing above imports
  // `@/lib/db`. The hook's budget is the Windows runner's (AGENTS.md Testing):
  // locally the file's tests measured 1.52-1.65 s, the hook almost all of it (2026-09-14), inside the 3 s local budget.
  let t: TempDb;
  let commit: typeof import("@/lib/import/commit");
  const ACC = 902;
  const FILE = `upstox-api-${TODAY}`;
  const snap = { supersedeSnapshot: { fileName: FILE } };
  const rowsOf = () =>
    t.sqlite
      .prepare("SELECT id, buy_qty, sell_qty, is_open, sell_date, import_batch_id FROM trades WHERE account_id = ? ORDER BY id")
      .all(ACC) as { id: number; buy_qty: number; sell_qty: number; is_open: number; sell_date: string | null; import_batch_id: number }[];

  beforeAll(async () => {
    t = await openTempDb("upstox-api", { seed: true });
    commit = await import("@/lib/import/commit");
    t.db.insert(t.schema.accounts).values({ id: ACC, name: "upstox re-pull" }).run();
  }, 120_000);
  afterAll(() => t?.cleanup());

  it("pull 1 BUY (open), pull 2 the same day BUY + SELL: one row, closed, the same id and batch, and the commit says so", () => {
    const pull1 = toParsedFile(normalizeUpstoxTrades([fill()], TODAY));
    expect(commit.commitParsedFile(pull1, FILE, null, ACC, snap).added).toBe(1);
    const [first] = rowsOf();
    expect(first).toMatchObject({ buy_qty: 3, sell_qty: 0, is_open: 1, sell_date: null });

    const pull2 = toParsedFile(
      normalizeUpstoxTrades([fill(), fill({ transaction_type: "SELL", average_price: 450.1, order_timestamp: "2026-08-28 14:10:00" })], TODAY),
    );
    const pre = commit.previewParsedFile(pull2, null, ACC, FILE, snap);
    expect.soft([pre.summary.newCount, pre.summary.dupCount, pre.summary.supersededCount]).toEqual([0, 0, 1]);

    const res = commit.commitParsedFile(pull2, FILE, null, ACC, snap);
    expect.soft([res.added, res.skipped]).toEqual([0, 0]);
    expect.soft(res.warnings).toContain("1 position updated from today's earlier pull.");
    // THE assertion (two rows on revert).
    const rows = rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first!.id, buy_qty: 3, sell_qty: 3, is_open: 0, sell_date: TODAY, import_batch_id: first!.import_batch_id });
  });

  it("a stored row whose identity carries an alias (a Data Quality close) is never rewritten: the pull asks instead", () => {
    const other = { tradingsymbol: "ALIASED-EQ", trading_symbol: "ALIASED-EQ", instrument_token: "NSE_EQ|INE000A01001" };
    const pull1 = toParsedFile(normalizeUpstoxTrades([fill(other)], TODAY));
    expect(commit.commitParsedFile(pull1, FILE, null, ACC, snap).added).toBe(1);
    t.sqlite.prepare("UPDATE trades SET import_notes = ? WHERE account_id = ? AND tradingsymbol = 'ALIASED'").run(`dedup-alias:${"a".repeat(40)}`, ACC);

    const pull2 = toParsedFile(normalizeUpstoxTrades([fill(other), fill({ ...other, transaction_type: "SELL", average_price: 450 })], TODAY));
    const pre = commit.previewParsedFile(pull2, null, ACC, FILE, snap);
    // THE assertions (supersededCount 1 and no collision on revert of the alias guard).
    expect(pre.summary.supersededCount).toBe(0);
    expect(pre.crossSource?.risky).toBe(true);
    const aliased = () => t.sqlite.prepare("SELECT buy_qty, sell_qty FROM trades WHERE account_id = ? AND tradingsymbol = 'ALIASED'").all(ACC);
    const res = commit.commitParsedFile(pull2, FILE, null, ACC, snap);
    expect((res.warnings ?? []).some((w) => w.includes("updated from today's earlier pull"))).toBe(false);
    // A commit forced past the question adds the evening row beside the aliased one; it never rewrites it.
    expect(aliased()).toEqual([
      { buy_qty: 3, sell_qty: 0 },
      { buy_qty: 3, sell_qty: 3 },
    ]);
  });
});

describe("warnings say what a pull can and cannot know", () => {
  it("an empty book explains itself", () => {
    const p = toParsedFile({ trades: [], refused: 0, notes: [] });
    expect(p.warnings.join(" ")).toMatch(/CURRENT trading day/i);
  });

  it("a real pull states the verified mapping and surfaces refusals and notes", () => {
    const r = normalizeUpstoxTrades([fill()], TODAY);
    const p = toParsedFile({ ...r, refused: 2, notes: ["note about a symbol"] });
    expect(p.warnings.join(" ")).toMatch(/verified against a live trade book/i);
    expect(p.warnings.join(" ")).toMatch(/2 fills .*refused/i);
    expect(p.warnings.join(" ")).toMatch(/note about a symbol/);
    expect(p.broker).toBe("upstox");
  });
});

describe("read-only by surface", () => {
  it("the module exports no order, funds or modification capability", () => {
    expect(Object.keys(upstox).sort()).toEqual([
      "canonicalUpstoxSymbol",
      "exchangeOf",
      "fetchUpstoxTrades",
      "isDerivativeExchange",
      "isinOf",
      "normalizeUpstoxTrades",
      "productHintOf",
      "stripSeriesSuffix",
      "toParsedFile",
      // v4.2: the IPv4-pinned GET helper is exported so lib/quotes/upstox.ts
      // reuses it instead of forking a second https path. It is a GET, and
      // what holds it to `/v3/market-quote/*` is the block "the market-quote
      // paths, as literals" at the end of tests/quotes-upstox.test.ts, which
      // pins both constants as literals and asserts on the paths the adapter
      // really hands it. (That block was cited here before it existed — the
      // constants were only ever compared with themselves; fix A-9.)
      "upstoxGet",
      "upstoxImportSource",
    ]);
  });
});

const r2 = (n: number) => Math.round(n * 100) / 100;
