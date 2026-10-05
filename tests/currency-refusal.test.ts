import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// Pure modules only — neither reaches lib/db, so the temp-db helper still binds
// the connection first (the routes are imported dynamically in beforeAll).
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import * as currencyVenue from "@/lib/import/currency-venue";
import * as genericMapModule from "@/lib/import/generic-map";
import * as zerodhaModule from "@/lib/import/parsers/zerodha";
import { parseFyersRealisedPnl } from "@/lib/import/parsers/fyers-realised-pnl";
import {
  CURRENCY_NOT_PRICED,
  CURRENCY_RECONCILIATION_NOTE,
  currencyRefusalsOf,
  isCurrencyRow,
  parseZerodha,
  refuseCurrencyRows,
  statesCurrency,
  strandedCurrencyNotes,
} from "@/lib/import/parsers/zerodha";
import { parseFyersTradebook } from "@/lib/import/parsers/fyers-tradebook";
import { parseDhanCsv } from "@/lib/import/parsers/dhan-csv";
import { parseDhanGtr } from "@/lib/import/parsers/dhan-gtr";
import { parseNuvamaPnlReport } from "@/lib/import/parsers/nuvama-pnl-report";
import { parseAngelOneTaxPnl } from "@/lib/import/parsers/angelone-taxpnl";
import { parsePaytmTradebook } from "@/lib/import/parsers/paytm-tradebook";
import { parseGenericTable } from "@/lib/import/parsers/generic-table";
import { applyMapping, isCurrencyVenueCell, type ColumnMapping } from "@/lib/import/generic-map";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { normalizeAngelTrades, toParsedFile as angelToParsedFile, type AngelTradeRow } from "@/lib/import/api/angelone";
import { normalizeUpstoxTrades, toParsedFile as upstoxToParsedFile, type UpstoxTradeRow } from "@/lib/import/api/upstox";
import { normalizeOpenAlgoTrades, toParsedFile as openAlgoToParsedFile, type OpenAlgoTradeRow } from "@/lib/import/api/openalgo";
import { parseAngelOne, parseUpstox } from "@/lib/import/parsers/angelone-upstox";
import {
  dhanImportSource,
  normalizeDhanPositions,
  normalizeDhanTrades,
  toParsedFile as dhanToParsedFile,
  type DhanCurrencyRefusal,
  type DhanPositionRow,
  type DhanTradeRow,
} from "@/lib/import/api/dhan";
import { todayIstIso } from "@/lib/domain/trading-day";

/**
 * FE (fix a class, not a case): Angel One SmartAPI, Upstox, OpenAlgo and the
 * Angel One / Upstox FILE parser folded CDS into NSE exactly as Kite did. The
 * Upstox trade book is read over node:https (family 4), never fetch — so the
 * route cases below answer it through this stub, and every other https call
 * (none in this file) passes through untouched.
 */
const httpsStub = vi.hoisted(() => ({ upstoxRows: null as unknown[] | null }));
vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  type Cb = (res: unknown) => void;
  const request = ((opts: { host?: string }, cb: Cb) => {
    if (httpsStub.upstoxRows == null || opts?.host !== "api.upstox.com") {
      return (actual.request as unknown as (o: unknown, c: Cb) => unknown)(opts, cb);
    }
    const body = JSON.stringify({ status: "success", data: httpsStub.upstoxRows });
    const handlers: Record<string, (x?: unknown) => void> = {};
    const res = {
      statusCode: 200,
      setEncoding() {},
      on(ev: string, fn: (x?: unknown) => void) {
        handlers[ev] = fn;
        return res;
      },
    };
    const req = {
      on() {
        return req;
      },
      end() {
        cb(res);
        handlers.data?.(body);
        handlers.end?.();
      },
    };
    return req;
  }) as unknown as typeof actual.request;
  return { ...actual, default: { ...actual, request }, request };
});

/**
 * v4.7.0 release audit, owner answer Q4 + design review R5/R6 (builder FD).
 *
 * Kite (`lib/import/api/kite.ts`) folded CDS into NSE, and every Zerodha file
 * (`lib/import/parsers/zerodha.ts`) did the same, so a USDINR future was stored
 * as an NSE future and charged equity-F&O STT and stamp — no `charge_config`
 * row covers currency (invariant 3). Now a currency row is REFUSED, COUNTED and
 * NAMED ("currency derivatives are not priced by Vyuha"), exactly as the C6
 * pulls refuse it, on all four Zerodha shapes:
 *
 *   A  the tradebook — by its Exchange / Segment cell (CDS, BCD), or by the
 *      classified underlying when the row states no segment;
 *   B  the tax P&L — by its "Currency" SECTION label;
 *   C  the Console P&L — no segment at all, so by `classify().symbol` against
 *      lib/domain/currency-pairs.ts (R6: exact, never a tradingsymbol prefix);
 *   D  the Kite pull — exchange CDS / BCD, count + names through the REAL
 *      broker route into the summary (R5's plumbing);
 *
 * and a non-currency NSE future beside them is imported and priced exactly as
 * before (the preview row is compared with a file that never had the currency
 * rows). R5's stranded-open case: a refused contract still OPEN in the SAME
 * account (a currency BUY imported before v4.7.0) is NAMED in a note — and the
 * stored row is left exactly as it is.
 *
 * ONE temp database for the file (lib/db caches its connection on globalThis);
 * every case owns its own account. The only stub is `globalThis.fetch`.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let fileRoute: typeof import("@/app/api/import/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");

const A_HAS = 61; // holds an OPEN USDINR26OCTFUT (and an open November one)
const A_NONE = 62; // holds nothing currency at all
const A_CLOSED = 63; // holds a CLOSED USDINR26OCTFUT
const A_COMMIT = 64; // commit: the open row must survive untouched
const K_HAS = 65; // Kite pull, open USDINR26OCTFUT
const K_NONE = 66; // Kite pull, nothing open

const ctx = (filename: string, text: string) => ({ filename, text, buffer: undefined });

beforeAll(async () => {
  t = await openTempDb("currency-refusal", { seed: true });
  fileRoute = await import("@/app/api/import/route");
  brokerRoute = await import("@/app/api/import/broker/route");
  t.db
    .insert(t.schema.accounts)
    .values([A_HAS, A_NONE, A_CLOSED, A_COMMIT, K_HAS, K_NONE].map((id) => ({ id, name: `FD ${id}`, isDefault: false })))
    .run();
  const currencyRow = (accountId: number, tradingsymbol: string, isOpen: boolean) =>
    tradeRow({
      accountId,
      broker: "zerodha",
      bucket: "active",
      segment: "future",
      instrumentType: "future",
      exchange: "NSE",
      symbol: "USDINR",
      tradingsymbol,
      buyQty: 1,
      avgBuyPrice: 84,
      buyValue: 84,
      buyDate: "2026-09-30",
      ...(isOpen ? { isOpen: true } : { sellQty: 1, avgSellPrice: 84.5, sellValue: 84.5, sellDate: "2026-10-01" }),
    });
  t.db
    .insert(t.schema.trades)
    .values([
      currencyRow(A_HAS, "USDINR26OCTFUT", true),
      // Same pair, another month — must NOT be named (a classify key would tie them).
      currencyRow(A_HAS, "USDINR26NOVFUT", true),
      currencyRow(A_CLOSED, "USDINR26OCTFUT", false),
      currencyRow(A_COMMIT, "USDINR26OCTFUT", true),
      currencyRow(K_HAS, "USDINR26OCTFUT", true),
    ])
    .run();
});

afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Fixtures — synthetic, no client identifiers.
// ---------------------------------------------------------------------------

/** The real Console tradebook columns (Auction is the in-content fingerprint). */
const TB_HEAD =
  "Symbol,ISIN,Trade Date,Exchange,Segment,Series,Trade Type,Auction,Quantity,Price,Trade ID,Order ID,Order Execution Time";
const TB_NIFTY = [
  "NIFTY26OCTFUT,,2026-10-01,NFO,FO,,buy,false,75,25000,T1,O1,2026-10-01 09:20:00",
  "NIFTY26OCTFUT,,2026-10-01,NFO,FO,,sell,false,75,25100,T2,O2,2026-10-01 14:20:00",
];
const TB_CURRENCY = [
  // The venue says CDS.
  "USDINR26OCTFUT,,2026-10-01,CDS,CDS,,sell,false,1,84.1,T3,O3,2026-10-01 10:00:00",
  // The venue is BSE, the SEGMENT says BCD.
  "EURINR26OCT90.5PE,,2026-10-01,BSE,BCD,,buy,false,2,0.25,T4,O4,2026-10-01 11:00:00",
];
const tradebook = (rows: string[]) => `${[TB_HEAD, ...rows].join("\n")}\n`;

/** A tax P&L "Tradewise Exits" sheet as one CSV: preamble, then labelled sections. */
const TW_HEAD = "Symbol,Entry Date,Exit Date,Quantity,Buy Value,Sell Value,Profit,Turnover,Brokerage,Exchange Transaction Charges,IPFT,SEBI Charges,CGST,SGST,IGST,Stamp Duty,STT";
const TW_NIFTY = "NIFTY26OCTFUT,2026-10-01 09:20:00,2026-10-01 14:20:00,75,1875000,1882500,7500,7500,20,30,0.1,1.88,0,0,9.18,37.5,37.65";
const TW_USDINR = "USDINR26OCTFUT,2026-10-01 10:00:00,2026-10-02 10:00:00,1,84100,84200,100,100,20,0.35,0,0.01,0,0,3.66,0.01,0";
const taxpnl = (currencyRows: string[]) =>
  [
    "View Zerodha's guide on using tax reports for filing.",
    "F&O",
    TW_HEAD,
    TW_NIFTY,
    "Currency",
    TW_HEAD,
    ...currencyRows,
    "Commodity",
    TW_HEAD,
  ].join("\n") + "\n";

/** The Console P&L: no Trade Type, no segment column — aggregated rows only. */
const CONSOLE_HEAD = "Symbol,ISIN,Buy Quantity,Sell Quantity,Buy Value,Sell Value,Realized P&L";
const console_ = (rows: string[]) =>
  `${[CONSOLE_HEAD, "NIFTY26OCTFUT,,75,75,1875000,1882500,7500", ...rows].join("\n")}\n`;

const refusalOf = (warnings: string[]) => warnings.find((w) => w.includes(CURRENCY_NOT_PRICED));
const strandedOf = (warnings: string[]) => warnings.filter((w) => /is still open from an earlier import/.test(w));

// ===========================================================================
// A–C — the three Zerodha FILE shapes, at the parser
// ===========================================================================

describe("A — the Zerodha tradebook refuses a CDS / BCD row, counts it and names it", () => {
  it("both currency fills are refused; the NIFTY future is the same trade it was without them", () => {
    const withCcy = parseZerodha(ctx("zerodha-tradebook.csv", tradebook([...TB_NIFTY, ...TB_CURRENCY])));
    const without = parseZerodha(ctx("zerodha-tradebook.csv", tradebook(TB_NIFTY)));
    expect(withCcy.trades.map((x) => x.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(withCcy.trades).toEqual(without.trades); // imported exactly as before
    expect(withCcy.trades[0]!.exchangeHint).toBe("NSE");
    const note = refusalOf(withCcy.warnings);
    expect(note).toBe(
      `2 currency derivative fills were refused — ${CURRENCY_NOT_PRICED} (no charge profile covers them), so nothing was imported for: USDINR26OCTFUT, EURINR26OCT90.5PE.`,
    );
    expect(currencyRefusalsOf(withCcy)).toEqual(["USDINR26OCTFUT", "EURINR26OCT90.5PE"]);
    expect(refusalOf(without.warnings)).toBeUndefined();
  });

  it("a row that states NO segment is refused by its classified underlying (R6)", () => {
    const head = "Symbol,ISIN,Trade Date,Exchange,Trade Type,Quantity,Price,Order Execution Time";
    const out = parseZerodha(
      ctx(
        "zerodha-tradebook.csv",
        `${head}\nUSDINR26OCTFUT,,2026-10-01,NSE,buy,1,84,2026-10-01 10:00:00\nNIFTY26OCTFUT,,2026-10-01,NSE,buy,75,25000,2026-10-01 09:20:00\n`,
      ),
    );
    expect(out.trades.map((x) => x.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(currencyRefusalsOf(out)).toEqual(["USDINR26OCTFUT"]);
    expect(refusalOf(out.warnings)).toMatch(/^1 currency derivative fill was refused/);
  });
});

describe("B — the tax P&L refuses its 'Currency' section", () => {
  it("the Currency row is refused and named; the F&O row and the charges are unchanged", () => {
    const withCcy = parseZerodha(ctx("taxpnl.csv", taxpnl([TW_USDINR])));
    const without = parseZerodha(ctx("taxpnl.csv", taxpnl([])));
    expect(withCcy.format).toBe("taxpnl");
    expect(withCcy.trades.map((x) => x.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.sourceRows).toBe(1);
    expect(refusalOf(withCcy.warnings)).toMatch(/^1 currency derivative exit row was refused — .*: USDINR26OCTFUT\.$/);
    expect(currencyRefusalsOf(withCcy)).toEqual(["USDINR26OCTFUT"]);
  });

  it("a workbook whose ONLY rows are currency still parses as the tax P&L (0 trades, the note), never falls through", () => {
    const only = [
      "View Zerodha's guide on using tax reports for filing.",
      "Currency",
      TW_HEAD,
      TW_USDINR,
    ].join("\n");
    const out = parseZerodha(ctx("taxpnl.csv", `${only}\n`));
    expect(out.format).toBe("taxpnl");
    expect(out.trades).toEqual([]);
    expect(currencyRefusalsOf(out)).toEqual(["USDINR26OCTFUT"]);
  });
});

describe("C — the Console P&L (no segment) refuses a currency pair by its classified underlying", () => {
  it("USDINR / JPYINR futures and an EURUSD option are refused; NIFTY is untouched", () => {
    const rows = ["USDINR26OCTFUT,,1,1,84100,84200,100", "JPYINR26OCTFUT,,1,1,56000,56100,100", "EURUSD26OCT1.1CE,,1,1,10,12,2"];
    const withCcy = parseZerodha(ctx("zerodha-console-pnl.csv", console_(rows)));
    const without = parseZerodha(ctx("zerodha-console-pnl.csv", console_([])));
    expect(withCcy.format).toBe("console");
    expect(withCcy.trades.map((x) => x.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(withCcy.trades).toEqual(without.trades);
    expect(refusalOf(withCcy.warnings)).toMatch(/^3 currency derivative rows were refused — .*: USDINR26OCTFUT, JPYINR26OCTFUT, EURUSD26OCT1\.1CE\.$/);
  });
});

describe("the stranded-open matcher (pure)", () => {
  it("names an open row only on the EXACT contract — October never matches November", () => {
    expect(strandedCurrencyNotes(["USDINR26OCTFUT"], [{ tradingsymbol: "USDINR26NOVFUT" }])).toEqual([]);
    expect(strandedCurrencyNotes(["usdinr26octfut"], [{ tradingsymbol: "USDINR26OCTFUT" }, { tradingsymbol: "USDINR26OCTFUT" }])).toEqual([
      "USDINR26OCTFUT is still open from an earlier import — close or delete it by hand; Vyuha no longer prices currency.",
    ]);
  });
});

// ===========================================================================
// The FILE route — the stranded-open note, scoped to the target account
// ===========================================================================

function postFile(accountId: number, csv: string, mode: "preview" | "commit"): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([csv], "zerodha-tradebook.csv", { type: "text/csv" }));
  fd.append("mode", mode);
  fd.append("accountId", String(accountId));
  return fileRoute.POST(new Request("http://local/api/import", { method: "POST", body: fd }));
}

type PreviewRow = { tradingsymbol: string; segment: string; exchange: string; chargesTotal: number; netPnl: number };
const niftyOf = (rows: PreviewRow[]) => {
  const r = rows.find((x) => x.tradingsymbol === "NIFTY26OCTFUT")!;
  return { segment: r.segment, exchange: r.exchange, chargesTotal: r.chargesTotal, netPnl: r.netPnl };
};

describe("the file route names a refused contract still OPEN in the same account (R5)", () => {
  it("fires in the account that holds it open — and names only that contract", async () => {
    const json = await (await postFile(A_HAS, tradebook([...TB_NIFTY, ...TB_CURRENCY]), "preview")).json();
    expect(refusalOf(json.warnings)).toBeDefined();
    expect(strandedOf(json.warnings)).toEqual([
      "USDINR26OCTFUT is still open from an earlier import — close or delete it by hand; Vyuha no longer prices currency.",
    ]);
    // The non-currency future is priced exactly as a file without the currency rows prices it.
    const plain = await (await postFile(A_HAS, tradebook(TB_NIFTY), "preview")).json();
    expect(json.preview.rows.map((r: PreviewRow) => r.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(niftyOf(json.preview.rows)).toEqual(niftyOf(plain.preview.rows));
    expect(niftyOf(json.preview.rows).chargesTotal).toBeGreaterThan(0);
  });

  it("does NOT fire in another account (the open row lives in A_HAS), nor where the row is closed", async () => {
    for (const acct of [A_NONE, A_CLOSED]) {
      const json = await (await postFile(acct, tradebook([...TB_NIFTY, ...TB_CURRENCY]), "preview")).json();
      expect(refusalOf(json.warnings), `account ${acct} still gets the refusal`).toBeDefined();
      expect(strandedOf(json.warnings), `account ${acct}`).toEqual([]);
    }
  });

  it("a commit leaves the stored open row exactly as it was and stores no currency row", async () => {
    const rowsOf = () =>
      t.sqlite
        .prepare("SELECT tradingsymbol, is_open, buy_qty, sell_qty, buy_value_paise FROM trades WHERE account_id = ? ORDER BY id")
        .all(A_COMMIT) as { tradingsymbol: string; is_open: number; buy_qty: number; sell_qty: number; buy_value_paise: number }[];
    const before = rowsOf();
    const res = await postFile(A_COMMIT, tradebook([...TB_NIFTY, ...TB_CURRENCY]), "commit");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(strandedOf(json.warnings)).toHaveLength(1);
    const after = rowsOf();
    expect(after[0]).toEqual(before[0]); // untouched: still open, same quantity and value
    expect(after.map((r) => r.tradingsymbol)).toEqual(["USDINR26OCTFUT", "NIFTY26OCTFUT"]);
  });
});

// ===========================================================================
// D — the Kite pull, through the REAL broker route
// ===========================================================================

function postBroker(body: unknown): Promise<Response> {
  return brokerRoute.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const kiteFill = (tradingsymbol: string, exchange: string, transaction_type: string, quantity: number, average_price: number) => ({
  tradingsymbol,
  exchange,
  product: "NRML",
  transaction_type,
  quantity,
  average_price,
  fill_timestamp: "2026-10-05 10:00:00",
});
const KITE_NIFTY = [kiteFill("NIFTY26OCTFUT", "NFO", "BUY", 75, 25000), kiteFill("NIFTY26OCTFUT", "NFO", "SELL", 75, 25100)];
const KITE_CCY = [kiteFill("USDINR26OCTFUT", "CDS", "SELL", 1, 84.1), kiteFill("EURINR26OCTFUT", "BCD", "BUY", 2, 90.2)];

function stubKite(data: unknown[]) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (!String(url).startsWith("https://api.kite.trade/trades")) throw new Error(`TEST GUARD: unexpected ${url}`);
    return { ok: true, status: 200, json: async () => ({ status: "success", data }) } as unknown as Response;
  });
}

async function kitePreview(accountId: number, data: unknown[]) {
  vi.stubGlobal("fetch", () => {
    throw new Error("TEST GUARD: the save reached the network");
  });
  // One Kite app key per account: the same key in two accounts is refused as a rival connection (R4a).
  expect((await postBroker({ action: "save", broker: "zerodha", accountId, apiKey: `kitekey${accountId}`, accessToken: "days-token" })).status).toBe(200);
  stubKite(data);
  const res = await postBroker({ action: "pull", broker: "zerodha", accountId, mode: "preview" });
  expect(res.status).toBe(200);
  return (await res.json()) as { warnings: string[]; preview: { rows: PreviewRow[] } };
}

describe("D — a Kite CDS / BCD fill is refused, counted and named in the pull summary", () => {
  it("both fills refused + named; the stranded USDINR future named in its own account", async () => {
    const json = await kitePreview(K_HAS, [...KITE_NIFTY, ...KITE_CCY]);
    expect(refusalOf(json.warnings)).toBe(
      `2 currency derivative fills were refused — ${CURRENCY_NOT_PRICED} (no charge profile covers them), so nothing was imported for: USDINR26OCTFUT, EURINR26OCTFUT.`,
    );
    expect(json.preview.rows.map((r) => r.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(strandedOf(json.warnings)).toEqual([
      "USDINR26OCTFUT is still open from an earlier import — close or delete it by hand; Vyuha no longer prices currency.",
    ]);
  });

  it("the NFO future beside them is priced exactly as a pull without them prices it", async () => {
    const json = await kitePreview(K_HAS, [...KITE_NIFTY, ...KITE_CCY]);
    const plain = await kitePreview(K_HAS, KITE_NIFTY);
    expect(niftyOf(json.preview.rows)).toEqual(niftyOf(plain.preview.rows));
    expect(refusalOf(plain.warnings)).toBeUndefined();
  });

  it("no stranded note in an account with nothing open — the refusal still reaches the summary", async () => {
    const json = await kitePreview(K_NONE, [...KITE_NIFTY, ...KITE_CCY]);
    expect(refusalOf(json.warnings)).toBeDefined();
    expect(strandedOf(json.warnings)).toEqual([]);
  });
});

// ===========================================================================
// E — the SAME class in the other four mappers (builder FE): Angel One
// SmartAPI, Upstox, OpenAlgo and the Angel One / Upstox file parser each folded
// CDS into NSE. Each now refuses, counts and names a currency row, and the
// non-currency future beside it is the same trade it was without it.
// ===========================================================================

const TODAY = "2026-10-05";
const noteFor = (n: number, noun: string, names: string) =>
  `${n} currency derivative ${noun}${n === 1 ? " was" : "s were"} refused — ${CURRENCY_NOT_PRICED} (no charge profile covers them), so nothing was imported for: ${names}.`;

const angelFill = (over: Partial<AngelTradeRow>): AngelTradeRow => ({
  producttype: "CARRYFORWARD",
  filltime: "10:00:00",
  expirydate: "28OCT2026",
  strikeprice: -1,
  optiontype: "",
  ...over,
});
const ANGEL_NIFTY: AngelTradeRow[] = [
  angelFill({ tradingsymbol: "NIFTY26OCTFUT", exchange: "NFO", instrumenttype: "FUTIDX", transactiontype: "BUY", fillsize: 75, fillprice: 25000 }),
  angelFill({ tradingsymbol: "NIFTY26OCTFUT", exchange: "NFO", instrumenttype: "FUTIDX", transactiontype: "SELL", fillsize: 75, fillprice: 25100 }),
];
const ANGEL_CCY: AngelTradeRow[] = [
  angelFill({ tradingsymbol: "USDINR26OCTFUT", exchange: "CDS", instrumenttype: "FUTCUR", transactiontype: "SELL", fillsize: 1, fillprice: 84.1 }),
  angelFill({ tradingsymbol: "EURINR26OCTFUT", exchange: "BCD", instrumenttype: "FUTCUR", transactiontype: "BUY", fillsize: 2, fillprice: 90.2 }),
];

const upstoxFill = (tradingsymbol: string, exchange: string, transaction_type: string, quantity: number, average_price: number): UpstoxTradeRow => ({
  tradingsymbol,
  exchange,
  product: "D",
  transaction_type,
  quantity,
  average_price,
  order_timestamp: `${todayIstIso()} 10:00:00`,
});
const UPSTOX_NIFTY = [upstoxFill("NIFTY26OCTFUT", "NFO", "BUY", 75, 25000), upstoxFill("NIFTY26OCTFUT", "NFO", "SELL", 75, 25100)];
const UPSTOX_CCY = [upstoxFill("USDINR26OCTFUT", "CDS", "SELL", 1, 84.1), upstoxFill("EURINR26OCTFUT", "BCD", "BUY", 2, 90.2)];

const oaFill = (symbol: string, exchange: string, action: string, quantity: number, average_price: number): OpenAlgoTradeRow => ({
  action,
  symbol,
  exchange,
  product: "NRML",
  quantity,
  average_price,
  trade_value: quantity * average_price,
  timestamp: "10:00:00",
});
const OA_NIFTY = [oaFill("NIFTY28OCT26FUT", "NFO", "BUY", 75, 25000), oaFill("NIFTY28OCT26FUT", "NFO", "SELL", 75, 25100)];
const OA_CCY = [oaFill("USDINR26OCTFUT", "CDS", "SELL", 1, 84.1), oaFill("EURINR26OCTFUT", "BCD", "BUY", 2, 90.2)];

describe("E1 — the Angel One SmartAPI pull refuses a CDS / BCD fill, counts it and names it", () => {
  it("both currency fills refused + named (the name it WOULD have been stored under); NIFTY unchanged", () => {
    const withCcy = normalizeAngelTrades([...ANGEL_NIFTY, ...ANGEL_CCY], TODAY);
    const without = normalizeAngelTrades(ANGEL_NIFTY, TODAY);
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.trades.map((x) => [x.tradingsymbol, x.exchangeHint])).toEqual([["FUT NIFTY 28 Oct 2026", "NSE"]]);
    expect(withCcy.refused).toBe(0); // the "no readable side, quantity or price" count is not the currency count
    expect(withCcy.refusedContracts).toEqual(["FUT USDINR 28 Oct 2026", "FUT EURINR 28 Oct 2026"]);
    expect(withCcy.notes).toEqual([noteFor(2, "fill", "FUT USDINR 28 Oct 2026, FUT EURINR 28 Oct 2026")]);
    expect(without.notes).toEqual([]);
    const parsed = angelToParsedFile(withCcy.trades, withCcy.refused, withCcy.notes);
    expect(refusalOf(parsed.warnings)).toBe(withCcy.notes[0]);
  });

  it("a book of ONLY currency fills never says 'returned no fills'", () => {
    const only = normalizeAngelTrades(ANGEL_CCY, TODAY);
    expect(only.trades).toEqual([]);
    const parsed = angelToParsedFile(only.trades, only.refused, only.notes);
    expect(parsed.warnings.some((w) => /returned no fills/.test(w))).toBe(false);
    expect(refusalOf(parsed.warnings)).toBeDefined();
  });
});

describe("E2 — the Upstox pull refuses a CDS / BCD fill, counts it and names it", () => {
  it("both currency fills refused + named in the summary notes; NIFTY unchanged", () => {
    const withCcy = normalizeUpstoxTrades([...UPSTOX_NIFTY, ...UPSTOX_CCY], TODAY);
    const without = normalizeUpstoxTrades(UPSTOX_NIFTY, TODAY);
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.trades.map((x) => x.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(withCcy.refused).toBe(0);
    expect(withCcy.refusedContracts).toEqual(["USDINR26OCTFUT", "EURINR26OCTFUT"]);
    expect(refusalOf(withCcy.notes)).toBe(noteFor(2, "fill", "USDINR26OCTFUT, EURINR26OCTFUT"));
    // toParsedFile already spreads `notes`, so the unattended auto-pull carries the refusal too.
    const parsed = upstoxToParsedFile(withCcy);
    expect(refusalOf(parsed.warnings)).toBe(noteFor(2, "fill", "USDINR26OCTFUT, EURINR26OCTFUT"));
    expect(refusalOf(upstoxToParsedFile(without).warnings)).toBeUndefined();
  });

  it("a book of ONLY currency fills never says 'returned no fills'", () => {
    const parsed = upstoxToParsedFile(normalizeUpstoxTrades(UPSTOX_CCY, TODAY));
    expect(parsed.trades).toEqual([]);
    expect(parsed.warnings.some((w) => /returned no fills/.test(w))).toBe(false);
    expect(refusalOf(parsed.warnings)).toBeDefined();
  });
});

describe("E3 — the OpenAlgo pull refuses a CDS / BCD fill (never NSE / BSE), counts it and names it", () => {
  it("both currency fills refused + listed; NIFTY unchanged; not filed as an 'unpriceable exchange code'", () => {
    const withCcy = normalizeOpenAlgoTrades([...OA_NIFTY, ...OA_CCY], "groww", TODAY);
    const without = normalizeOpenAlgoTrades(OA_NIFTY, "groww", TODAY);
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.trades.map((x) => x.tradingsymbol)).toEqual(["FUT NIFTY 28 Oct 2026"]);
    expect(withCcy.refusedCurrency).toEqual(["USDINR26OCTFUT", "EURINR26OCTFUT"]);
    expect(withCcy.refusedByExchange).toEqual({});
    expect(withCcy.refused).toBe(0);
  });

  it("a book of ONLY currency fills says every row was refused — never 'no executions'", () => {
    const only = normalizeOpenAlgoTrades(OA_CCY, "groww", TODAY);
    const parsed = openAlgoToParsedFile("groww", only, [noteFor(2, "fill", "USDINR26OCTFUT, EURINR26OCTFUT")]);
    expect(parsed.trades).toEqual([]);
    expect(parsed.warnings.some((w) => /all 2 rows were refused/.test(w))).toBe(true);
    expect(refusalOf(parsed.warnings)).toBe(noteFor(2, "fill", "USDINR26OCTFUT, EURINR26OCTFUT"));
  });
});

/** Upstox's trade report (header verified 2026-08-20) — a currency row by venue, by segment, and by underlying alone. */
const UP_HEAD = "Date,Company,Amount,Exchange,Segment,Scrip Code,Instrument Type,Strike Price,Expiry,Trade Num,Trade Time,Side,Quantity,Price";
const UP_NIFTY = [
  "01-10-2026,NIFTY,1875000,NSE,FO,,FUTIDX,0,28-10-2026,T1,09:20:00,BUY,75,25000",
  "01-10-2026,NIFTY,1882500,NSE,FO,,FUTIDX,0,28-10-2026,T2,14:20:00,SELL,75,25100",
];
const UP_CCY = [
  "01-10-2026,USDINR,84.1,CDS,CD,,FUTCUR,0,28-10-2026,T3,10:00:00,SELL,1,84.1",
  "01-10-2026,EURINR,180.4,NSE,CD,,FUTCUR,0,28-10-2026,T4,11:00:00,BUY,2,90.2",
  "01-10-2026,JPYINR,56,,,,FUTCUR,0,28-10-2026,T5,12:00:00,BUY,1,56",
];
const upReport = (rows: string[]) => `${[UP_HEAD, ...rows].join("\n")}\n`;

/** Angel One's Trades_History table (header verified 2026-09-04). */
const AO_HEAD =
  "Scrip/Contract,Buy/Sell,Buy Price,Sell Price,Quantity,Brokerage,GST,STT,Sebi Tax,Exchange Turnover Charges,Stamp Duty,Other Charges,IPFT Charges,Order Type,Segment,Exchange,Order ID,Trade ID,Date";
const AO_NIFTY = [
  "FUTIDX NIFTY Oct 28 2026,Buy,25000,0,75,20,3.6,0,0.02,3.5,37.5,0,0.1,Carryforward,FO,NSE,O1,T1,10/1/26 0:00",
  "FUTIDX NIFTY Oct 28 2026,Sell,0,25100,75,20,3.6,37.65,0.02,3.5,0,0,0.1,Carryforward,FO,NSE,O2,T2,10/1/26 0:00",
];
const AO_CCY = [
  // The venue says CDS.
  "FUTCUR USDINR Oct 28 2026,Sell,0,84.1,1,20,3.6,0,0,0.01,0,0,0,Carryforward,Currency,CDS,O3,T3,10/1/26 0:00",
  // The venue says NSE and the segment FO — the classified underlying is still a pair (R6, exact).
  "OPTCUR EURINR Oct 28 2026 90.50 PE,Buy,0.25,0,2,20,3.6,0,0,0.01,0,0,0,Carryforward,FO,NSE,O4,T4,10/1/26 0:00",
];
const aoBook = (rows: string[]) => `${[AO_HEAD, ...rows].join("\n")}\n`;

describe("E4 — the Angel One / Upstox FILE parser refuses a currency row, counts it and names it", () => {
  it("Upstox trade report: by venue (CDS), by segment (CD) and by underlying (no venue) — NIFTY unchanged", () => {
    const withCcy = parseUpstox(ctx("trade_2026.csv", upReport([...UP_NIFTY, ...UP_CCY])));
    const without = parseUpstox(ctx("trade_2026.csv", upReport(UP_NIFTY)));
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.trades.map((x) => x.tradingsymbol)).toEqual(["NIFTY"]);
    expect(refusalOf(withCcy.warnings)).toBe(noteFor(3, "fill", "USDINR, EURINR, JPYINR"));
    expect(refusalOf(without.warnings)).toBeUndefined();
    // The stranded-open side channel app/api/import/route.ts reads (orchestrator
    // follow-up to FE: the file parser used to push the note only, so a file
    // import never named a currency row still OPEN from an earlier import).
    expect(currencyRefusalsOf(withCcy)).toEqual(["USDINR", "EURINR", "JPYINR"]);
    expect(currencyRefusalsOf(without)).toEqual([]);
  });

  it("Angel One Trades_History: by venue (CDS) and by classified underlying — NIFTY and its charges unchanged", () => {
    const withCcy = parseAngelOne(ctx("Trades_History_X.csv", aoBook([...AO_NIFTY, ...AO_CCY])));
    const without = parseAngelOne(ctx("Trades_History_X.csv", aoBook(AO_NIFTY)));
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.trades.map((x) => x.tradingsymbol)).toEqual(["FUT NIFTY 28 Oct 2026"]);
    expect(withCcy.sourceRows).toBe(without.sourceRows);
    expect(refusalOf(withCcy.warnings)).toBe(noteFor(2, "fill", "FUT USDINR 28 Oct 2026, OPT EURINR 28 Oct 2026 90.5 PE"));
    expect(currencyRefusalsOf(withCcy)).toEqual(["FUT USDINR 28 Oct 2026", "OPT EURINR 28 Oct 2026 90.5 PE"]);
  });

  it("an aggregated P&L report: a CDS row and a venue-less pair row are refused", () => {
    const head = "Symbol,Exchange,Buy Qty,Sell Qty,Buy Value,Sell Value,Realised P&L";
    const csv = (rows: string[]) => `${[head, "NIFTY26OCTFUT,NFO,75,75,1875000,1882500,7500", ...rows].join("\n")}\n`;
    const withCcy = parseAngelOne(ctx("angelone-pnl.csv", csv(["USDINR26OCTFUT,CDS,1,1,84,84.5,0.5", "JPYINR26OCTFUT,,1,1,56,56.1,0.1"])));
    const without = parseAngelOne(ctx("angelone-pnl.csv", csv([])));
    expect(withCcy.format).toBe("pnl-report");
    expect(withCcy.trades).toEqual(without.trades);
    expect(refusalOf(withCcy.warnings)).toBe(noteFor(2, "row", "USDINR26OCTFUT, JPYINR26OCTFUT"));
    expect(currencyRefusalsOf(withCcy)).toEqual(["USDINR26OCTFUT", "JPYINR26OCTFUT"]);
  });
});

// ===========================================================================
// F — the Angel One / Upstox / OpenAlgo pulls through the REAL broker route:
// the refusal reaches the summary, a refused contract still OPEN in the
// connection's account is named, and a COMMIT of a snapshot pull (Angel One,
// Upstox supersede today's earlier snapshot) leaves that open row untouched.
// ===========================================================================

const AO_HAS = 67;
const UP_HAS = 68;
const OA_HAS = 69;
const STRANDED = (s: string) => `${s} is still open from an earlier import — close or delete it by hand; Vyuha no longer prices currency.`;

describe("F — the Angel One, Upstox and OpenAlgo pull summaries", () => {
  let today = "";
  const fullRows = (accountId: number) =>
    t.sqlite.prepare("SELECT * FROM trades WHERE account_id = ? ORDER BY id").all(accountId) as Record<string, unknown>[];

  beforeAll(() => {
    today = todayIstIso();
    t.db
      .insert(t.schema.accounts)
      .values([AO_HAS, UP_HAS, OA_HAS].map((id) => ({ id, name: `FE ${id}`, isDefault: false })))
      .run();
    const open = (accountId: number, broker: string, tradingsymbol: string, sourceFile: string) =>
      tradeRow({
        accountId,
        broker,
        bucket: "active",
        segment: "future",
        instrumentType: "future",
        exchange: "NSE",
        symbol: "USDINR",
        tradingsymbol,
        buyQty: 1,
        avgBuyPrice: 84,
        buyValue: 84,
        // TODAY's earlier snapshot of the same pull — the row the supersede plan reads.
        buyDate: today,
        sourceFile,
        isOpen: true,
      });
    t.db
      .insert(t.schema.trades)
      .values([
        open(AO_HAS, "angelone", "FUT USDINR 28 Oct 2026", `angelone-api-${today}`),
        open(UP_HAS, "upstox", "USDINR26OCTFUT", `upstox-api-${today}`),
        open(OA_HAS, "groww", "USDINR26OCTFUT", `openalgo-groww-${today}`),
      ])
      .run();
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?, 'angelone', 'key', '', ?)")
      .run(AO_HAS, JSON.stringify({ clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" }));
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?, 'upstox', 'year-token', '', NULL)")
      .run(UP_HAS);
  });
  afterEach(() => {
    httpsStub.upstoxRows = null;
  });

  const stubAngel = (fills: AngelTradeRow[]) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const data = String(url).includes("loginByPassword") ? { jwtToken: "jwt" } : fills;
      return new Response(JSON.stringify({ status: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

  it("Angel One: refusal + stranded note in the preview; a commit leaves the open row exactly as it was", async () => {
    stubAngel([...ANGEL_NIFTY, ...ANGEL_CCY]);
    const res = await postBroker({ action: "pull", broker: "angelone", accountId: AO_HAS, mode: "preview" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { warnings: string[]; preview: { rows: PreviewRow[] } };
    expect(refusalOf(json.warnings)).toBe(noteFor(2, "fill", "FUT USDINR 28 Oct 2026, FUT EURINR 28 Oct 2026"));
    expect(strandedOf(json.warnings)).toEqual([STRANDED("FUT USDINR 28 Oct 2026")]);
    expect(json.preview.rows.map((r) => r.tradingsymbol)).toEqual(["FUT NIFTY 28 Oct 2026"]);

    const before = fullRows(AO_HAS);
    stubAngel([...ANGEL_NIFTY, ...ANGEL_CCY]);
    const commit = await postBroker({ action: "pull", broker: "angelone", accountId: AO_HAS, mode: "commit" });
    expect(commit.status).toBe(200);
    const after = fullRows(AO_HAS);
    expect(after[0]).toEqual(before[0]); // the supersede plan never treats a refused fill as the stored row vanishing
    expect(after.map((r) => r.tradingsymbol)).toEqual(["FUT USDINR 28 Oct 2026", "FUT NIFTY 28 Oct 2026"]);
  });

  it("Upstox: refusal + stranded note in the preview; a commit leaves the open row exactly as it was", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("TEST GUARD: Upstox is read over node:https, never fetch");
    });
    httpsStub.upstoxRows = [...UPSTOX_NIFTY, ...UPSTOX_CCY];
    const res = await postBroker({ action: "pull", broker: "upstox", accountId: UP_HAS, mode: "preview" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { warnings: string[]; preview: { rows: PreviewRow[] } };
    expect(refusalOf(json.warnings)).toBe(noteFor(2, "fill", "USDINR26OCTFUT, EURINR26OCTFUT"));
    expect(strandedOf(json.warnings)).toEqual([STRANDED("USDINR26OCTFUT")]);
    expect(json.preview.rows.map((r) => r.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);

    const before = fullRows(UP_HAS);
    const commit = await postBroker({ action: "pull", broker: "upstox", accountId: UP_HAS, mode: "commit" });
    expect(commit.status).toBe(200);
    const after = fullRows(UP_HAS);
    expect(after[0]).toEqual(before[0]);
    expect(after.map((r) => r.tradingsymbol)).toEqual(["USDINR26OCTFUT", "NIFTY26OCTFUT"]);
  });

  it("OpenAlgo: refusal + stranded note in the preview, scoped to the connection's account", async () => {
    t.sqlite
      .prepare("UPDATE settings SET openalgo_enabled = 1, openalgo_ack_version = ?")
      .run((await import("@/lib/domain/openalgo-disclosure")).OPENALGO_DISCLOSURE_VERSION);
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/auth/app-info")) {
        return new Response(JSON.stringify({ status: "success", version: "2.0.2.6", name: "OpenAlgo" }), { status: 200 });
      }
      if (String(url).endsWith("/api/v1/tradebook")) {
        return new Response(JSON.stringify({ status: "success", data: [...OA_NIFTY, ...OA_CCY] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`TEST GUARD: unexpected ${url}`);
    });
    const save = await postBroker({
      action: "save",
      broker: "openalgo",
      accountId: OA_HAS,
      apiKey: "oa-secret-key-fe-0001",
      host: "127.0.0.1:5000",
      underlyingBroker: "groww",
    });
    expect(save.status).toBe(200);
    const res = await postBroker({ action: "pull", broker: "openalgo:groww", accountId: OA_HAS, mode: "preview" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { warnings: string[]; preview: { rows: PreviewRow[] } };
    expect(refusalOf(json.warnings)).toBe(noteFor(2, "fill", "USDINR26OCTFUT, EURINR26OCTFUT"));
    expect(strandedOf(json.warnings)).toEqual([STRANDED("USDINR26OCTFUT")]);
    expect(json.preview.rows.map((r) => r.tradingsymbol)).toEqual(["FUT NIFTY 28 Oct 2026"]);
  });
});

// ===========================================================================
// G — the Dhan API pull (builder FG, the importer the prose pass found left):
// `exchangeOf` mapped NSE_CURRENCY / BSE_CURRENCY to NSE / BSE and the segment
// test kept currency rows "on the equity fallback", so a USDINR future pulled
// from Dhan was stored as an NSE EQUITY delivery row (`classify` of
// "USDINR-Oct2026-FUT" → eq_delivery, symbol "USDINR-Oct2026-FUT") and charged
// equity STT and stamp. Both Dhan endpoints the pull reads — today's
// /v2/positions and the catch-up /v2/trades history — now refuse, count and
// name a currency-segment row; the NSE_FNO future beside them is unchanged.
// The names are the RAW tradingSymbol: a currency segment never got a
// canonical OPT/FUT name, so that is what a pre-4.7.0 pull stored.
// ===========================================================================

const D_HAS = 70; // holds an OPEN USDINR-Oct2026-FUT from today's earlier Dhan snapshot + a CLOSED EURINR one
const D_NONE = 71; // holds nothing currency at all

const dhanPos = (over: Partial<DhanPositionRow>): DhanPositionRow => ({
  tradingSymbol: "NIFTY-Oct2026-FUT",
  positionType: "CLOSED",
  exchangeSegment: "NSE_FNO",
  productType: "MARGIN",
  buyAvg: 25000,
  buyQty: 75,
  sellAvg: 25100,
  sellQty: 75,
  netQty: 0,
  drvExpiryDate: "2026-10-27 14:30:00",
  drvOptionType: null,
  drvStrikePrice: 0,
  ...over,
});
const DHAN_POS_NIFTY = [dhanPos({})];
const DHAN_POS_CCY = [
  dhanPos({
    tradingSymbol: "USDINR-Oct2026-FUT", exchangeSegment: "NSE_CURRENCY", positionType: "SHORT",
    buyQty: 0, buyAvg: 0, sellQty: 1, sellAvg: 84.1, netQty: -1, drvExpiryDate: "2026-10-28 12:00:00",
  }),
  dhanPos({
    tradingSymbol: "EURINR-Oct2026-FUT", exchangeSegment: "BSE_CURRENCY", positionType: "LONG",
    buyQty: 2, buyAvg: 90.2, sellQty: 0, sellAvg: 0, netQty: 2, drvExpiryDate: "2026-10-28 12:00:00",
  }),
];

const dhanFill = (over: Partial<DhanTradeRow>): DhanTradeRow => ({
  exchangeTradeId: "N1",
  transactionType: "BUY",
  exchangeSegment: "NSE_FNO",
  productType: "MARGIN",
  tradingSymbol: "NIFTY-Oct2026-FUT",
  tradedQuantity: 75,
  tradedPrice: 25000,
  exchangeTime: "2026-10-01 09:20:00",
  drvExpiryDate: "2026-10-27 14:30:00",
  drvOptionType: null,
  drvStrikePrice: 0,
  ...over,
});
const DHAN_FILL_NIFTY = [
  dhanFill({}),
  dhanFill({ exchangeTradeId: "N2", transactionType: "SELL", tradedPrice: 25100, exchangeTime: "2026-10-01 14:20:00" }),
];
const DHAN_FILL_CCY = [
  dhanFill({
    exchangeTradeId: "C1", exchangeSegment: "NSE_CURRENCY", tradingSymbol: "USDINR-Oct2026-FUT", transactionType: "SELL",
    tradedQuantity: 1, tradedPrice: 84.1, exchangeTime: "2026-10-01 10:00:00", drvExpiryDate: "2026-10-28 12:00:00",
  }),
  dhanFill({
    exchangeTradeId: "C2", exchangeSegment: "BSE_CURRENCY", tradingSymbol: "EURINR-Oct2026-FUT", transactionType: "BUY",
    tradedQuantity: 2, tradedPrice: 90.2, exchangeTime: "2026-10-01 11:00:00", drvExpiryDate: "2026-10-28 12:00:00",
  }),
];
const DHAN_CCY_NAMES = "USDINR-Oct2026-FUT, EURINR-Oct2026-FUT";
const DHAN_NIFTY = "FUT NIFTY 27 Oct 2026";

describe("G1 — the Dhan pull refuses an NSE_CURRENCY / BSE_CURRENCY row, counts it and names it", () => {
  it("history fills: both refused + named; the NSE_FNO future is the same trade it was without them", () => {
    const withCcy = normalizeDhanTrades([...DHAN_FILL_NIFTY, ...DHAN_FILL_CCY]);
    const without = normalizeDhanTrades(DHAN_FILL_NIFTY);
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.trades.map((x) => [x.tradingsymbol, x.exchangeHint])).toEqual([[DHAN_NIFTY, "NSE"]]);
    expect(withCcy.refused).toBe(0); // the "no readable side, quantity, price or date" count is not the currency count
    expect(withCcy.refusedContracts).toEqual(["USDINR-Oct2026-FUT", "EURINR-Oct2026-FUT"]);
    expect(withCcy.notes).toEqual([noteFor(2, "fill", DHAN_CCY_NAMES)]);
    expect(without.refusedContracts).toEqual([]);
    expect(without.notes).toEqual([]);
  });

  // The positions normalizer is module-private (the read-only export surface is
  // pinned in tests/dhan-api.test.ts), so today's book is read the way the pull
  // reads it: dhanImportSource().fetchTrades over a stubbed /v2/positions.
  const dhanJwt = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  async function positionsPull(positions: DhanPositionRow[]) {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      if (u.host !== "api.dhan.co" || u.pathname !== "/v2/positions") throw new Error(`TEST GUARD: unexpected ${url}`);
      return new Response(JSON.stringify(positions), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const seen: DhanCurrencyRefusal[] = [];
    const trades = await dhanImportSource({ clientId: "1000000070", accessToken: dhanJwt() }).fetchTrades({
      onCurrencyRefused: (r) => seen.push(r),
    });
    expect(seen).toHaveLength(1); // told exactly once per pull
    return { trades, ...seen[0]! };
  }

  it("today's positions: both refused + named; normalizeDhanPositions never emits a currency row", async () => {
    const withCcy = await positionsPull([...DHAN_POS_NIFTY, ...DHAN_POS_CCY]);
    const without = await positionsPull(DHAN_POS_NIFTY);
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.trades.map((x) => [x.tradingsymbol, x.exchangeHint])).toEqual([[DHAN_NIFTY, "NSE"]]);
    expect(withCcy.contracts).toEqual(["USDINR-Oct2026-FUT", "EURINR-Oct2026-FUT"]);
    expect(withCcy.notes).toEqual([noteFor(2, "position", DHAN_CCY_NAMES)]);
    expect(without).toMatchObject({ contracts: [], notes: [] });
    expect(normalizeDhanPositions([...DHAN_POS_NIFTY, ...DHAN_POS_CCY], TODAY)).toEqual(normalizeDhanPositions(DHAN_POS_NIFTY, TODAY));
    // A currency row on which nothing traded is not a refusal — it is not a row at all.
    expect((await positionsPull([dhanPos({ ...DHAN_POS_CCY[0], sellQty: 0, netQty: 0 })])).notes).toEqual([]);
  });

  it("toParsedFile closes the summary with the notes; a book of ONLY currency never says 'returned no positions'", async () => {
    const pull = await positionsPull([...DHAN_POS_NIFTY, ...DHAN_POS_CCY]);
    expect(refusalOf(dhanToParsedFile(pull.trades, null, null, null, pull.notes).warnings)).toBe(pull.notes[0]);
    expect(refusalOf(dhanToParsedFile(pull.trades).warnings)).toBeUndefined();
    const only = await positionsPull(DHAN_POS_CCY);
    const parsed = dhanToParsedFile(only.trades, null, null, null, only.notes);
    expect(parsed.trades).toEqual([]);
    expect(parsed.warnings.some((w) => /returned no positions/.test(w))).toBe(false);
    expect(refusalOf(parsed.warnings)).toBe(noteFor(2, "position", DHAN_CCY_NAMES));
  });

  it("fetchTrades hands back BOTH endpoints' refusals (catch-up history + today's positions), names de-duplicated", async () => {
    const jwt = dhanJwt();
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      if (u.host !== "api.dhan.co") throw new Error(`TEST GUARD: unexpected ${url}`);
      const body =
        u.pathname === "/v2/positions"
          ? [...DHAN_POS_NIFTY, ...DHAN_POS_CCY]
          : /\/0$/.test(u.pathname)
            ? [...DHAN_FILL_NIFTY, ...DHAN_FILL_CCY]
            : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const seen: DhanCurrencyRefusal[] = [];
    const trades = await dhanImportSource({ clientId: "1000000070", accessToken: jwt }).fetchTrades({
      from: "2026-10-01",
      onCurrencyRefused: (r) => seen.push(r),
    });
    expect(trades.map((x) => x.tradingsymbol)).toEqual([DHAN_NIFTY, DHAN_NIFTY]);
    expect(seen).toEqual([
      {
        contracts: ["USDINR-Oct2026-FUT", "EURINR-Oct2026-FUT"],
        notes: [noteFor(2, "fill", DHAN_CCY_NAMES), noteFor(2, "position", DHAN_CCY_NAMES)],
      },
    ]);
  });
});

describe("G2 — the Dhan pull through the REAL broker route", () => {
  let today = "";
  const fullRows = (accountId: number) =>
    t.sqlite.prepare("SELECT * FROM trades WHERE account_id = ? ORDER BY id").all(accountId) as Record<string, unknown>[];
  const jwt = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");

  beforeAll(() => {
    today = todayIstIso();
    t.db
      .insert(t.schema.accounts)
      .values([D_HAS, D_NONE].map((id) => ({ id, name: `FG ${id}`, isDefault: false })))
      .run();
    // Exactly what a pre-4.7.0 Dhan pull stored for a currency future: the raw
    // symbol, classified as an NSE equity delivery row.
    const asStored = (tradingsymbol: string, sourceFile: string, day: string, open: boolean) =>
      tradeRow({
        accountId: D_HAS,
        broker: "dhan",
        bucket: "equity",
        segment: "eq_delivery",
        instrumentType: "equity",
        exchange: "NSE",
        symbol: tradingsymbol,
        tradingsymbol,
        buyQty: 1,
        avgBuyPrice: 84,
        buyValue: 84,
        buyDate: day,
        sourceFile,
        ...(open ? { isOpen: true } : { sellQty: 1, avgSellPrice: 84.5, sellValue: 84.5, sellDate: day }),
      });
    t.db
      .insert(t.schema.trades)
      .values([
        // TODAY's earlier snapshot of the same pull — the row the supersede plan reads.
        asStored("USDINR-Oct2026-FUT", `dhan-api-${today}`, today, true),
        // Closed — must never be named.
        asStored("EURINR-Oct2026-FUT", "dhan-api-2026-10-01", "2026-10-01", false),
      ])
      .run();
    // Plaintext columns read fine through readSecret (the compatibility path);
    // never pulled, so the pull reads today's /v2/positions only.
    for (const [accountId, clientId] of [[D_HAS, "1000000070"], [D_NONE, "1000000071"]] as const) {
      t.sqlite
        .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?, 'dhan', ?, ?, NULL)")
        .run(accountId, clientId, jwt());
    }
  });

  const stubDhan = (positions: DhanPositionRow[]) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      if (u.host !== "api.dhan.co" || u.pathname !== "/v2/positions") throw new Error(`TEST GUARD: unexpected ${url}`);
      return new Response(JSON.stringify(positions), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  const dhanPreview = async (accountId: number, positions: DhanPositionRow[]) => {
    stubDhan(positions);
    const res = await postBroker({ action: "pull", broker: "dhan", accountId, mode: "preview" });
    expect(res.status).toBe(200);
    return (await res.json()) as { warnings: string[]; preview: { rows: PreviewRow[] } };
  };
  const niftyRow = (rows: PreviewRow[]) => {
    const r = rows.find((x) => x.tradingsymbol === DHAN_NIFTY)!;
    return { segment: r.segment, exchange: r.exchange, chargesTotal: r.chargesTotal, netPnl: r.netPnl };
  };

  it("refusal + the stranded note for the OPEN row in the connection's account; the closed EURINR row is not named", async () => {
    const json = await dhanPreview(D_HAS, [...DHAN_POS_NIFTY, ...DHAN_POS_CCY]);
    expect(refusalOf(json.warnings)).toBe(noteFor(2, "position", DHAN_CCY_NAMES));
    expect(strandedOf(json.warnings)).toEqual([STRANDED("USDINR-Oct2026-FUT")]);
    expect(json.preview.rows.map((r) => r.tradingsymbol)).toEqual([DHAN_NIFTY]);
  });

  it("the NSE_FNO future beside them is priced exactly as a pull without them prices it", async () => {
    const json = await dhanPreview(D_NONE, [...DHAN_POS_NIFTY, ...DHAN_POS_CCY]);
    const plain = await dhanPreview(D_NONE, DHAN_POS_NIFTY);
    expect(niftyRow(json.preview.rows)).toEqual(niftyRow(plain.preview.rows));
    expect(niftyRow(json.preview.rows).segment).toBe("future");
    expect(refusalOf(plain.warnings)).toBeUndefined();
  });

  it("another account: the refusal reaches the summary, but no stranded note (the open row lives in D_HAS)", async () => {
    const json = await dhanPreview(D_NONE, [...DHAN_POS_NIFTY, ...DHAN_POS_CCY]);
    expect(refusalOf(json.warnings)).toBe(noteFor(2, "position", DHAN_CCY_NAMES));
    expect(strandedOf(json.warnings)).toEqual([]);
  });

  it("a commit (snapshot supersede on) leaves the stored open row exactly as it was and stores no currency row", async () => {
    const before = fullRows(D_HAS);
    stubDhan([...DHAN_POS_NIFTY, ...DHAN_POS_CCY]);
    const commit = await postBroker({ action: "pull", broker: "dhan", accountId: D_HAS, mode: "commit" });
    expect(commit.status).toBe(200);
    const after = fullRows(D_HAS);
    // The supersede plan maps INCOMING rows onto stored ones; a refused row is
    // not incoming, so the stored open row never looks vanished or replaced.
    expect(after.slice(0, 2)).toEqual(before);
    expect(after.map((r) => r.tradingsymbol)).toEqual(["USDINR-Oct2026-FUT", "EURINR-Oct2026-FUT", DHAN_NIFTY]);
  });
});

// ===========================================================================
// H — the SEVEN file paths that had NO currency check (v4.7.0 money audit):
// Fyers tradebook, Dhan P&L, Dhan GTR, Nuvama P&L report, Angel One tax P&L,
// Paytm tradebook and the generic column mapper. ONE shared guard
// (`refuseCurrencyRows`, called by app/api/import/route.ts straight after the
// parser) refuses a row by its classified underlying or by its own stated
// venue. The parsers whose file STATES a venue / segment also refuse a row
// there, so a currency contract whose NAME is outside
// lib/domain/currency-pairs.ts is still caught — AUDINR below is synthetic (no
// such contract is listed) and stands for exactly that case.
//
// Every layout is the parser's own verified header (copied from its existing
// test); the rows are synthetic.
// ===========================================================================

const nt = (tradingsymbol: string, over: Partial<NormalizedTrade> = {}): NormalizedTrade => ({
  broker: "dhan",
  tradingsymbol,
  isin: null,
  buyQty: 1,
  avgBuyPrice: 10,
  buyValue: 10,
  sellQty: 1,
  avgSellPrice: 11,
  sellValue: 11,
  closingPrice: null,
  grossPnl: 1,
  unrealisedPnl: 0,
  buyDate: "2026-10-01",
  sellDate: "2026-10-01",
  productHint: null,
  exchangeHint: null,
  sourceFile: "synthetic.csv",
  ...over,
});
const parsedOf = (trades: NormalizedTrade[]): ParsedFile => ({
  sourceId: "dhan-csv",
  broker: "dhan",
  format: "pnl",
  trades,
  warnings: ["an earlier warning"],
});
const refusalsOf = (warnings: string[]) => warnings.filter((w) => w.includes(CURRENCY_NOT_PRICED));
const symbolsOf = (p: ParsedFile) => p.trades.map((x) => x.tradingsymbol);

describe("H1 — the shared guard (pure): refuseCurrencyRows", () => {
  it("removes the currency future and option, keeps the equity and the equity-F&O row; ONE note, count 2, both names", () => {
    const p = parsedOf([nt("USDINR26OCTFUT"), nt("RELIANCE"), nt("OPT USDINR 28 Oct 2026 84.5 CE"), nt("NIFTY26OCTFUT")]);
    const out = refuseCurrencyRows(p);
    expect(out).toBe(p);
    expect(symbolsOf(out)).toEqual(["RELIANCE", "NIFTY26OCTFUT"]);
    expect(out.warnings).toEqual(["an earlier warning", noteFor(2, "row", "USDINR26OCTFUT, OPT USDINR 28 Oct 2026 84.5 CE")]);
    expect(currencyRefusalsOf(out)).toEqual(["USDINR26OCTFUT", "OPT USDINR 28 Oct 2026 84.5 CE"]);
  });

  it("a row whose OWN venue states currency is refused whatever its name; a pair as a mere PREFIX is not (R6)", () => {
    // `exchangeHint` is typed NSE / BSE / MCX, but the Dhan GTR hands the file's raw cell through.
    const onCds = nt("FUT AUDINR 28 Oct 2026", { exchangeHint: "CDS" as unknown as NormalizedTrade["exchangeHint"] });
    const out = refuseCurrencyRows(parsedOf([onCds, nt("USDINRBEES"), nt("NIFTY26OCTFUT", { exchangeHint: "NSE" })]));
    expect(symbolsOf(out)).toEqual(["USDINRBEES", "NIFTY26OCTFUT"]);
    expect(refusalsOf(out.warnings)).toEqual([noteFor(1, "row", "FUT AUDINR 28 Oct 2026")]);
    expect(isCurrencyRow(nt("USDINRBEES"))).toBe(false);
    expect(isCurrencyRow(nt("USDINR26OCTFUT"))).toBe(true);
  });

  it("nothing to refuse: the file comes back untouched — no note, no names; a second pass adds nothing", () => {
    const clean = parsedOf([nt("RELIANCE"), nt("NIFTY26OCTFUT")]);
    const trades = clean.trades;
    expect(refuseCurrencyRows(clean).trades).toBe(trades);
    expect(clean.warnings).toEqual(["an earlier warning"]);
    expect(currencyRefusalsOf(clean)).toEqual([]);

    const once = refuseCurrencyRows(parsedOf([nt("USDINR26OCTFUT"), nt("RELIANCE")]));
    const warnings = [...once.warnings];
    refuseCurrencyRows(once);
    expect(once.warnings).toEqual(warnings);
    expect(currencyRefusalsOf(once)).toEqual(["USDINR26OCTFUT"]);
  });

  const STATES = ["CDS", "BCD", "CD", "cds", "Currency", "Currency Derivatives", "NSE-CDS", "NSE_CURRENCY", "BSE_CURRENCY", "NSE CD", "BSE-BCD"];
  const DOES_NOT = ["NSE", "BSE", "NFO", "BFO", "MCX", "NCDEX", "EQ", "FO", "NSE_EQ", "NSE_FNO", "MCX_COMM", "Derivatives", "Capital Market", ""];
  it.each(STATES)("a venue cell '%s' states currency", (cell) => {
    expect(statesCurrency(cell)).toBe(true);
    expect(isCurrencyVenueCell(cell)).toBe(true);
  });
  it.each(DOES_NOT)("a venue cell '%s' does not", (cell) => {
    expect(statesCurrency(cell)).toBe(false);
    expect(isCurrencyVenueCell(cell)).toBe(false);
  });
});

describe("H2 — the guard MERGES with a parser's own refusals, and adds nothing where the parser already refused", () => {
  it("names are the UNION, exactly one NEW note, the parser's note intact", () => {
    const p = parseZerodha(ctx("zerodha-tradebook.csv", tradebook([...TB_NIFTY, ...TB_CURRENCY])));
    const parserNote = noteFor(2, "fill", "USDINR26OCTFUT, EURINR26OCT90.5PE");
    expect(refusalsOf(p.warnings)).toEqual([parserNote]);
    p.trades.push(nt("GBPINR26OCTFUT", { broker: "zerodha" })); // a currency row the parser did not see
    refuseCurrencyRows(p);
    expect(symbolsOf(p)).toEqual(["NIFTY26OCTFUT"]);
    expect(refusalsOf(p.warnings)).toEqual([parserNote, noteFor(1, "row", "GBPINR26OCTFUT")]);
    expect(currencyRefusalsOf(p)).toEqual(["USDINR26OCTFUT", "EURINR26OCT90.5PE", "GBPINR26OCTFUT"]);
  });

  it.each([
    ["Zerodha tradebook", () => parseZerodha(ctx("zerodha-tradebook.csv", tradebook([...TB_NIFTY, ...TB_CURRENCY])))],
    ["Zerodha tax P&L", () => parseZerodha(ctx("taxpnl.csv", taxpnl([TW_USDINR])))],
    ["Zerodha Console P&L", () => parseZerodha(ctx("zerodha-console-pnl.csv", console_(["USDINR26OCTFUT,,1,1,84100,84200,100"])))],
    ["Upstox trade report", () => parseUpstox(ctx("trade_2026.csv", upReport([...UP_NIFTY, ...UP_CCY])))],
    ["Angel One Trades_History", () => parseAngelOne(ctx("Trades_History_X.csv", aoBook([...AO_NIFTY, ...AO_CCY])))],
  ] as const)("%s: trades, warnings, counts and names do NOT move through the guard", (_label, parse) => {
    const p = parse();
    const before = { trades: [...p.trades], warnings: [...p.warnings], names: [...currencyRefusalsOf(p)], sourceRows: p.sourceRows };
    expect(before.names.length).toBeGreaterThan(0); // the parser did refuse something
    expect(refuseCurrencyRows(p)).toBe(p);
    expect(p.trades).toEqual(before.trades);
    expect(p.warnings).toEqual(before.warnings);
    expect([...currencyRefusalsOf(p)]).toEqual(before.names);
    expect(p.sourceRows).toBe(before.sourceRows);
  });
});

// ── Fyers tradebook ─────────────────────────────────────────────────────────
const FY_HEAD = [
  "Report Title,Tradebook report,,,,,,,,,",
  "Date Range,From 01/10/2026 to 01/10/2026,,,,,,,,,",
  ",,,,,,,,,,",
  "Symbol name,Symbol code,Date & time,Side,Product type,Qty,Traded price,Total value,Segment,Exchange order ID,OMS order ID",
];
const FY_NIFTY = [
  'NIFTY26OCTFUT,NIFTY FUT,"01 Oct 2026, 02:20:00 PM",SELL,Intraday,75,25100,"18,82,500.00",Derivatives,1300000000000002,2610010000002',
  'NIFTY26OCTFUT,NIFTY FUT,"01 Oct 2026, 09:20:00 AM",BUY,Intraday,75,25000,"18,75,000.00",Derivatives,1300000000000001,2610010000001',
];
// The Segment cell says Currency; the name is outside the pair list.
const FY_SEGMENT = 'AUDINR26OCTFUT,AUDINR FUT,"01 Oct 2026, 10:00:00 AM",BUY,Overnight,1000,55.5,"55,500.00",Currency,1300000000000003,2610010000003';
// The Segment cell says Derivatives; only the classified underlying says currency.
const FY_BYNAME = 'USDINR26OCTFUT,USDINR FUT,"01 Oct 2026, 11:00:00 AM",SELL,Overnight,1000,84.1,"84,100.00",Derivatives,1300000000000004,2610010000004';
const fyers = (rows: string[]) => parseFyersTradebook(ctx("FYERS_tradebook_CCY.csv", [...FY_HEAD, ...rows].join("\n")));

describe("H3a — Fyers tradebook", () => {
  it("a fill whose Segment cell states currency is refused AT THE PARSER, named, never paired", () => {
    const withCcy = fyers([...FY_NIFTY, FY_SEGMENT]);
    const without = fyers(FY_NIFTY);
    expect(symbolsOf(withCcy)).toEqual(["NIFTY26OCTFUT"]);
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.sourceRows).toBe(2);
    expect(refusalOf(withCcy.warnings)).toBe(noteFor(1, "fill", "AUDINR26OCTFUT"));
    expect(currencyRefusalsOf(withCcy)).toEqual(["AUDINR26OCTFUT"]);
    expect(refusalOf(without.warnings)).toBeUndefined();
  });

  it("a pair the Segment cell calls 'Derivatives' is refused by the guard, by its classified underlying", () => {
    const out = refuseCurrencyRows(fyers([...FY_NIFTY, FY_BYNAME, FY_SEGMENT]));
    expect(symbolsOf(out)).toEqual(["NIFTY26OCTFUT"]);
    expect(out.trades).toEqual(fyers(FY_NIFTY).trades);
    expect(refusalsOf(out.warnings)).toEqual([noteFor(1, "fill", "AUDINR26OCTFUT"), noteFor(1, "row", "USDINR26OCTFUT")]);
    expect(currencyRefusalsOf(out)).toEqual(["AUDINR26OCTFUT", "USDINR26OCTFUT"]);
  });
});

// ── Dhan P&L (CSV) — no venue cell at all: the guard is the only check ───────
const DP_HEAD = [
  "PnL report,From 01-10-2026 to 05-10-2026",
  "Name,TESTUSER",
  "UCC,TEST0001",
  "",
  "Scrip Name,Buy Qty.,Avg. Buy Price,Buy Value,Sell Qty.,Avg. Sell Price,Sell Value,Closing Price,Realised P&L,Realised P&L %,Unrealised P&L,Unrealised P&L %",
  '"A2ETEST ALPHA","100","250.00","25000.00","100","262.00","26200.00","0.00","1200.00","4.80","0.00","0.00"',
  '"FUT NIFTY 27 Oct 2026","75","25000.00","1875000.00","75","25100.00","1882500.00","0.00","7500.00","0.40","0.00","0.00"',
];
const DP_CCY = [
  '"FUT USDINR 28 Oct 2026","1000","84.00","84000.00","1000","84.10","84100.00","0.00","100.00","0.12","0.00","0.00"',
  '"OPT EURINR 28 Oct 2026 90.5 PE","1000","0.25","250.00","1000","0.30","300.00","0.00","50.00","20.00","0.00","0.00"',
];
const DP_NAMES = "FUT USDINR 28 Oct 2026, OPT EURINR 28 Oct 2026 90.5 PE";
const dhanPnl = (rows: string[]) => `${[...DP_HEAD, ...rows].join("\n")}\n`;

describe("H3b — Dhan P&L export (names only)", () => {
  it("the USDINR future and the EURINR option are refused by the guard; the equity and the NIFTY future are untouched", () => {
    const out = refuseCurrencyRows(parseDhanCsv(ctx("Dhan_PnL_report.csv", dhanPnl(DP_CCY))));
    const without = parseDhanCsv(ctx("Dhan_PnL_report.csv", dhanPnl([])));
    expect(symbolsOf(out)).toEqual(["A2ETEST ALPHA", "FUT NIFTY 27 Oct 2026"]);
    expect(out.trades).toEqual(without.trades);
    expect(refusalOf(out.warnings)).toBe(noteFor(2, "row", DP_NAMES));
    expect(currencyRefusalsOf(out)).toEqual(DP_NAMES.split(", "));
  });
});

// ── Dhan Global Transaction Report ──────────────────────────────────────────
const GTR_HEADER = "Date,Scrip Name,Exchange,Bill No.,Buy Qty.,Buy Value,Sell Qty.,Sell Value,Brokerage,GST,STT,SEBI Fees,Stamp Duty,Txn. Charges,Oth. Charges,Gross Amount";
const GTR_SCRIP = "OPT NIFTY 29 Sep 2026 24500 CE";
// Charges 59.61 + 26.21 = 85.82; gross 9150 − 6750 = 2400.
const GTR_NIFTY = [
  `"01 Sep 2026 00:00:00","${GTR_SCRIP}","NSE","B1","0","0.00","75","9150.00","40.00","7.20","9.15","0.01","0.00","3.25","0.00","9090.39"`,
  `"02 Sep 2026 00:00:00","${GTR_SCRIP}","NSE","B2","75","6750.00","0","0.00","20.00","3.60","0.00","0.01","0.20","2.40","0.00","-6776.21"`,
];
// One currency bill: charges 24.21, gross 100.
const gtrCcy = (scrip: string, exchange: string) =>
  `"01 Sep 2026 00:00:00","${scrip}","${exchange}","B3","1000","84000.00","1000","84100.00","20.00","3.60","0.00","0.01","0.10","0.50","0.00","75.79"`;
const gtrFile = (lines: string[], gross: number, charges: number) =>
  [
    "Global transction report,From 01-09-2026 to 02-09-2026",
    "Name,TESTUSER",
    "UCC,TEST0001A",
    "",
    GTR_HEADER,
    ...lines,
    "",
    `Net P&L,${(gross - charges).toFixed(2)},Brokerage,0,Gross P&L,${gross},Total Charges,${charges}`,
  ].join("\n");
const GTR_NAME = "Dhan_GlobalTransction_Report_01-09-2026_02-09-2026.csv";
const gtr = (lines: string[], gross: number, charges: number) => parseDhanGtr(ctx(GTR_NAME, gtrFile(lines, gross, charges)));

describe("H3c — Dhan Global Transaction Report", () => {
  it("a bill whose Exchange cell says CDS is refused AT THE PARSER and named; the NSE bills are the same position they were", () => {
    const withCcy = gtr([...GTR_NIFTY, gtrCcy("FUT AUDINR 28 Sep 2026", "CDS")], 2500, 110.03);
    const without = gtr(GTR_NIFTY, 2400, 85.82);
    expect(symbolsOf(withCcy)).toEqual([GTR_SCRIP]);
    expect(withCcy.trades).toEqual(without.trades); // same charges, to the paisa
    expect(withCcy.trades.map((x) => x.exchangeHint)).toEqual(["NSE"]);
    expect(withCcy.sourceRows).toBe(2);
    expect(refusalOf(withCcy.warnings)).toBe(noteFor(1, "row", "FUT AUDINR 28 Sep 2026"));
    expect(currencyRefusalsOf(withCcy)).toEqual(["FUT AUDINR 28 Sep 2026"]);
    // The refused bill's ₹24.21 is not an unexplained footer difference.
    expect(withCcy.warnings.filter((w) => /Please report this file|differ from the positions/i.test(w))).toEqual([]);
  });

  it("a report whose ONLY bill is currency: no trades, the refusal note — not 'no transaction rows'", () => {
    const only = gtr([gtrCcy("FUT USDINR 28 Sep 2026", "BCD")], 100, 24.21);
    expect(only.trades).toEqual([]);
    // v4.8.0 CU (R6): this pin gained the reconciliation sentence — the report's footer (`reported`) still
    // includes the refused bill. Nothing else in it moved.
    expect(only.warnings).toEqual([noteFor(1, "row", "FUT USDINR 28 Sep 2026"), CURRENCY_RECONCILIATION_NOTE]);
  });

  it("no cost basis is derived from a footer that still includes a refused currency bill (invariant 6)", () => {
    // A holding sold with no purchase in the window: 10 shares for ₹5,000, true cost ₹4,000 (gross 1,000), charges 17.01.
    const orphan = `"02 Sep 2026 00:00:00","A2ETEST IPOSTK","NSE","B4","0","0.00","10","5000.00","10.00","1.80","5.00","0.01","0.00","0.20","0.00","4982.99"`;
    const alone = gtr([orphan], 1000, 17.01);
    expect(alone.trades.map((x) => x.suggestedBasisPrice)).toEqual([400]); // the footer derivation, when the footer is the book
    // With the CDS bill refused the footer's gross (1,100) covers a trade the book does not hold: 390 would be wrong.
    const withCcy = gtr([orphan, gtrCcy("FUT USDINR 28 Sep 2026", "CDS")], 1100, 41.22);
    expect(symbolsOf(withCcy)).toEqual(["A2ETEST IPOSTK"]);
    expect(withCcy.trades.map((x) => x.suggestedBasisPrice ?? null)).toEqual([null]);
    expect(withCcy.warnings.filter((w) => /recovered the missing cost|derived from the footer/.test(w))).toEqual([]);
  });

  it("a pair billed with Exchange = NSE is refused by the guard, by its classified underlying", () => {
    const out = refuseCurrencyRows(gtr([...GTR_NIFTY, gtrCcy("FUT USDINR 28 Sep 2026", "NSE")], 2500, 110.03));
    expect(symbolsOf(out)).toEqual([GTR_SCRIP]);
    expect(refusalOf(out.warnings)).toBe(noteFor(1, "row", "FUT USDINR 28 Sep 2026"));
    expect(currencyRefusalsOf(out)).toEqual(["FUT USDINR 28 Sep 2026"]);
  });
});

// ── Nuvama P&L report ───────────────────────────────────────────────────────
const NV_HEADER = ["", "Isin", "Instrument", "TxnDate", "TxnType", "Action", "Quantity", "Price", "Brok", "STax/GST on Brokerage", "STT", "Stamp Duty", "Sebi Fees", "Txn Charges", "Tax on Txn Charges", "Other Charges", "Cumulative Quantity", "Net Charges", "Delete Flag"];
// Each line bills 20 + 3.6 + 0.01 + 0.3 + 0.05 = 23.96.
const nvLine = (instrument: string, date: string, venue: string, action: "Buy" | "Sell", qty: number, price: number, cum: number) =>
  ["", "", instrument, date, venue, action, qty, price, 20, 3.6, 0, 0, 0.01, 0.3, 0.05, 0, cum, 23.96, "False"];
const NV_NIFTY_INST = "NIFTY-OPT-29Sep2026-CE-24500-NSE";
const NV_NIFTY = [nvLine(NV_NIFTY_INST, "01-Sep-26", "NSE", "Sell", 75, 122, -75), nvLine(NV_NIFTY_INST, "02-Sep-26", "NSE", "Buy", 75, 90, 0)];
function nuvama(lines: unknown[][]): ParsedFile {
  const pre = (title: string) => [["Nuvama Wealth and Investment Limited"], [title], ["Period as on : 01-Sep-2026 to 22-Sep-2026"], ["Calculation Method : FIFO"]];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Nuvama Wealth and Investment Limited"], ["Summary"]]), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...pre("Detail Realised"), NV_HEADER, ...lines, ["DISCLAIMER"]]), "Detail Realised");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...pre("Unrealised Details"), NV_HEADER, ["DISCLAIMER"]]), "Unrealised Details");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Dividend"]]), "Dividend");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Understanding the Report"]]), "Understanding the Report");
  return parseNuvamaPnlReport({ filename: "NUVAMA_PnL_Report_CCY.xlsx", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer });
}

describe("H3d — Nuvama P&L report (the pull's rule: CDS / BCD / NCDEX refused by name)", () => {
  it("a CDS line, a BCD line named only by its closing token and an NCDEX line are refused AT THE PARSER; NIFTY is unchanged", () => {
    const withCcy = nuvama([
      ...NV_NIFTY,
      nvLine("USDINR-FUT-28Oct2026-CDS", "01-Sep-26", "CDS", "Buy", 1000, 84, 1000),
      nvLine("EURINR-OPT-28Oct2026-PE-90.5-BCD", "01-Sep-26", "", "Buy", 1000, 0.25, 1000),
      nvLine("DHANIYA-FUT-20Oct2026-NCDEX", "01-Sep-26", "NCDEX", "Buy", 10, 7000, 10),
    ]);
    const without = nuvama(NV_NIFTY);
    expect(symbolsOf(withCcy)).toEqual(["OPT NIFTY 29 Sep 2026 24500 CE"]);
    expect(withCcy.trades).toEqual(without.trades);
    expect(withCcy.sourceRows).toBe(2);
    expect(withCcy.reported?.totalCharges).toBe(without.reported?.totalCharges);
    // Named as the book would hold them, so a row stored before v4.7.0 can be matched.
    expect(refusalOf(withCcy.warnings)).toBe(noteFor(2, "row", "FUT USDINR 28 Oct 2026, OPT EURINR 28 Oct 2026 90.5 PE"));
    expect(currencyRefusalsOf(withCcy)).toEqual(["FUT USDINR 28 Oct 2026", "OPT EURINR 28 Oct 2026 90.5 PE"]);
    expect(withCcy.warnings.filter((w) => /NCDEX/.test(w))).toEqual([
      "1 NCDEX line was refused: NCDEX contracts are not imported from this report (no charge profile covers them), so nothing was imported for: FUT DHANIYA 20 Oct 2026.",
    ]);
    expect(without.warnings.filter((w) => /NCDEX/.test(w) || w.includes(CURRENCY_NOT_PRICED))).toEqual([]);
  });

  it("a pair the report places on NSE is refused by the guard, by its classified underlying", () => {
    const out = refuseCurrencyRows(nuvama([...NV_NIFTY, nvLine("GBPINR-FUT-28Oct2026-NSE", "01-Sep-26", "NSE", "Buy", 1000, 105, 1000)]));
    expect(symbolsOf(out)).toEqual(["OPT NIFTY 29 Sep 2026 24500 CE"]);
    expect(refusalOf(out.warnings)).toBe(noteFor(1, "row", "FUT GBPINR 28 Oct 2026"));
  });
});

// ── Angel One tax P&L ────────────────────────────────────────────────────────
// SYNTHETIC SEGMENT VALUES. The ONLY `Segment` values a real Angel One Tax P&L has shown are `NSEFO` and `BSEFO`
// (tests/fixtures/redacted/angelone-taxpnl-fy2026-27.xlsx). The `CDS` and `NFO` cells below were INVENTED for
// these tests — nobody has seen Angel One print them — and stand for "a segment the shared venue rule reads as
// currency" and "an unverified segment" respectively. Since v4.8.0 CU (R2) the parser reads the column.
function angelTax(deriv: unknown[][]): ParsedFile {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Angel One Limited (formerly known as Angel Broking Limited)"], ["Client Basic Information"]]), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(deriv), "Derivatives Trade Details");
  return parseAngelOneTaxPnl({ filename: "statement.xlsx", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer });
}
const AT_OPT_HEAD = ["Segment", "Symbol Name", "Expiry date", "Strike Price", "Option Type", "Qty", "Buy Date", "Sell date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Total Charges and Statutory", "STT", "Taxable P&L", "Turnover"];
const AT_FUT_HEAD = ["Segment", "Symbol Name", "Expiry date", "Qty", "Buy Date", "Sell date", "Avg Buy Price", "Buy Value", "Avg Sell Price", "Sell Value", "Total Charges and Statutory", "STT", "Taxable P&L", "Turnover"];
const AT_BANKNIFTY = ["NFO", "BANKNIFTY", "31-07-2026", "15", "01-07-2026", "05-07-2026", "50000", "750000", "50500", "757500", "150", "80", "7270", "1507500"];

describe("H3e — Angel One tax P&L (SYNTHETIC 'CDS' / 'NFO' Segment cells — only NSEFO and BSEFO have been seen on a real export)", () => {
  it("a USDINR future and an EURINR option in the derivatives sheet (synthetic Segment 'CDS') are refused; BANKNIFTY keeps its stated charges", () => {
    const out = refuseCurrencyRows(
      angelTax([
        ["Futures"],
        AT_FUT_HEAD,
        AT_BANKNIFTY,
        ["CDS", "USDINR", "29-07-2026", "1000", "01-07-2026", "05-07-2026", "84", "84000", "84.1", "84100", "30", "0", "70", "168100"],
        [],
        ["Options"],
        AT_OPT_HEAD,
        ["CDS", "EURINR", "29-07-2026", "90.5", "PE", "1000", "01-07-2026", "05-07-2026", "0.25", "250", "0.3", "300", "30", "0", "20", "550"],
      ]),
    );
    const without = angelTax([["Futures"], AT_FUT_HEAD, AT_BANKNIFTY]);
    expect(symbolsOf(out)).toEqual(["FUT BANKNIFTY 31 Jul 2026"]);
    expect(out.trades).toEqual(without.trades);
    expect(refusalOf(out.warnings)).toBe(noteFor(2, "row", "FUT USDINR 29 Jul 2026, OPT EURINR 29 Jul 2026 90.5 PE"));
    expect(currencyRefusalsOf(out)).toEqual(["FUT USDINR 29 Jul 2026", "OPT EURINR 29 Jul 2026 90.5 PE"]);
  });
});

// ── Paytm Money tradebook ───────────────────────────────────────────────────
const PT_HEADER = ["Date", "Script", "ISIN", "Exchange", "Product Type", "Type", "Quantity", "Price", "Brokerage", "ETT", "GST", "STT", "SEBI", "Stamp Duty", "Order Number", "Trade Number", "Trade Time"];
const ptRow = (script: string, exchange: string, side: "Buy" | "Sell", qty: number, price: number, id: string, time: string) =>
  ["01-10-2026", script, "", exchange, "EQ", side, qty, price, 20, 3, 4.14, 0, 0.1, 0.5, `O${id}`, `T${id}`, time];
const PT_NIFTY = [ptRow("NIFTY26OCTFUT", "NSE", "Buy", 75, 25000, "1", "09:20:00"), ptRow("NIFTY26OCTFUT", "NSE", "Sell", 75, 25100, "2", "14:20:00")];
function paytm(rows: unknown[][]): ParsedFile {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["UCC"], ["Name"], ["PAN Number"], ["Period"], PT_HEADER, ...rows]), "Sheet1");
  return parsePaytmTradebook({ filename: "Paytm Money - Tradebook CCY.xlsx", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer });
}

describe("H3f — Paytm Money tradebook", () => {
  it("an execution whose Exchange cell says CDS is refused AT THE PARSER, before it touches a position or the charge totals", () => {
    const withCcy = paytm([...PT_NIFTY, ptRow("AUDINR26OCTFUT", "CDS", "Buy", 1000, 55.5, "3", "10:00:00")]);
    const without = paytm(PT_NIFTY);
    expect(symbolsOf(withCcy)).toEqual(["NIFTY26OCTFUT"]);
    expect(withCcy.trades).toEqual(without.trades); // charges apportioned without the refused fill's
    expect(withCcy.sourceRows).toBe(2);
    expect(refusalOf(withCcy.warnings)).toBe(noteFor(1, "fill", "AUDINR26OCTFUT"));
    expect(currencyRefusalsOf(withCcy)).toEqual(["AUDINR26OCTFUT"]);
    expect(refusalOf(without.warnings)).toBeUndefined();
  });

  it("a pair the file places on NSE is refused by the guard, by its classified underlying", () => {
    const out = refuseCurrencyRows(paytm([...PT_NIFTY, ptRow("USDINR26OCTFUT", "NSE", "Buy", 1000, 84, "3", "10:00:00")]));
    expect(symbolsOf(out)).toEqual(["NIFTY26OCTFUT"]);
    expect(refusalOf(out.warnings)).toBe(noteFor(1, "row", "USDINR26OCTFUT"));
  });
});

// ── The generic column mapper ───────────────────────────────────────────────
const GM_HEADERS = ["Date", "Symbol", "Type", "Qty", "Price", "Exchange"];
const GM_MAP: ColumnMapping = { date: 0, tradingsymbol: 1, side: 2, qty: 3, price: 4, exchange: 5 };
const GM_OPTS = { broker: "kotakneo" as const, filename: "kotak-export.csv" };
const GM_NIFTY = [
  ["01-10-2026", "NIFTY26OCTFUT", "BUY", "75", "25000", "NSE"],
  ["01-10-2026", "NIFTY26OCTFUT", "SELL", "75", "25100", "NSE"],
];
const gmCcy = (symbol: string, exchange: string) => ["01-10-2026", symbol, "BUY", "1000", "55.5", exchange];
const gmCsv = (rows: string[][]) => `${[GM_HEADERS, ...rows].map((r) => r.join(",")).join("\n")}\n`;
const gmCtx = (rows: string[][]) => ({ ...ctx(GM_OPTS.filename, gmCsv(rows)), generic: { broker: GM_OPTS.broker, mapping: GM_MAP } });
/** v4.8.0 CU / R5 — the mapper's own NCDEX sentence (it mirrors the Nuvama report's). */
const GM_NCDEX_NOTE = (n: number, names: string) =>
  `${n} NCDEX row${n === 1 ? " was" : "s were"} refused: NCDEX contracts are not imported from this file (no charge profile covers them), so nothing was imported for: ${names}.`;

describe("H3g — the generic column mapper", () => {
  it.each(["CDS", "BCD", "NSE-CDS", "NSE_CURRENCY", "BSE_CURRENCY", "Currency", "cd"])(
    "an execution whose exchange cell says '%s' is refused as currency — never mapped to NSE",
    (venue) => {
      const r = applyMapping(GM_HEADERS, [...GM_NIFTY, gmCcy("AUDINR26OCTFUT", venue)], GM_MAP, GM_OPTS);
      const without = applyMapping(GM_HEADERS, GM_NIFTY, GM_MAP, GM_OPTS);
      expect(r.trades).toEqual(without.trades);
      expect(r.refusedCurrency).toEqual(["AUDINR26OCTFUT"]);
      expect(r.skipped).toBe(1); // not counted as a line read …
      expect(r.warnings).toEqual(without.warnings); // … and not called unreadable
      expect(without.refusedCurrency).toEqual([]);
    },
  );

  it("a round-trip (P&L-shaped) row on a currency venue is refused the same way", () => {
    const headers = ["Scrip", "Buy Qty", "Buy Price", "Sell Qty", "Sell Price", "Exchange"];
    const m: ColumnMapping = { tradingsymbol: 0, buyQty: 1, avgBuyPrice: 2, sellQty: 3, avgSellPrice: 4, exchange: 5 };
    const r = applyMapping(headers, [["RELIANCE", "10", "2400", "10", "2500", "NSE"], ["AUDINR26OCTFUT", "1000", "55", "1000", "55.5", "NSE_CURRENCY"]], m, GM_OPTS);
    expect(r.trades.map((x) => [x.tradingsymbol, x.exchangeHint])).toEqual([["RELIANCE", "NSE"]]);
    expect(r.refusedCurrency).toEqual(["AUDINR26OCTFUT"]);
    expect(r.skipped).toBe(1);
  });

  // v4.8.0 CU (R9): the mechanism changed, the observable did not. The names used to reach the guard through a
  // WeakMap keyed on the `trades` array; `parseGenericTable` now writes them itself (`withCurrencyRefusals`).
  it("through parseGenericTable + the guard: ONE shared note for the venue row and the by-name row, both named", () => {
    const parsedAlone = parseGenericTable(gmCtx([...GM_NIFTY, gmCcy("AUDINR26OCTFUT", "NSE-CDS"), gmCcy("USDINR26OCTFUT", "NSE")]));
    // The new mechanism: the file carries the note and the names BEFORE the guard runs …
    expect(refusalsOf(parsedAlone.warnings)).toEqual([noteFor(2, "row", "AUDINR26OCTFUT, USDINR26OCTFUT")]);
    expect(currencyRefusalsOf(parsedAlone)).toEqual(["AUDINR26OCTFUT", "USDINR26OCTFUT"]);
    // … and nothing depends on the trades array's identity any more.
    parsedAlone.trades = [...parsedAlone.trades];
    expect("mappedCurrencyRefusalsOf" in genericMapModule).toBe(false);
    const out = refuseCurrencyRows(parsedAlone);
    const without = parseGenericTable(gmCtx(GM_NIFTY));
    expect(symbolsOf(out)).toEqual(["NIFTY26OCTFUT"]);
    expect(out.trades).toEqual(without.trades);
    expect(refusalsOf(out.warnings)).toEqual([noteFor(2, "row", "AUDINR26OCTFUT, USDINR26OCTFUT")]);
    expect(currencyRefusalsOf(out)).toEqual(["AUDINR26OCTFUT", "USDINR26OCTFUT"]);
  });
});

// ── The route seam: every file passes the guard between parse and preview ────
const H_HAS = 72; // holds an OPEN "FUT USDINR 28 Oct 2026" from a pre-v4.7.0 Dhan P&L import
const H_NONE = 73;

describe("H4 — app/api/import/route.ts runs the guard on every parser's result", () => {
  beforeAll(() => {
    t.db
      .insert(t.schema.accounts)
      .values([H_HAS, H_NONE].map((id) => ({ id, name: `H ${id}`, isDefault: false })))
      .run();
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({
          accountId: H_HAS,
          broker: "dhan",
          bucket: "active",
          segment: "future",
          instrumentType: "future",
          exchange: "NSE",
          symbol: "USDINR",
          tradingsymbol: "FUT USDINR 28 Oct 2026",
          buyQty: 1000,
          avgBuyPrice: 84,
          buyValue: 84000,
          buyDate: "2026-09-30",
          isOpen: true,
        }),
      ])
      .run();
  });

  function postNamed(accountId: number, name: string, body: string, extra: Record<string, string> = {}): Promise<Response> {
    const fd = new FormData();
    fd.append("file", new File([body], name, { type: "text/csv" }));
    fd.append("mode", "preview");
    fd.append("accountId", String(accountId));
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fileRoute.POST(new Request("http://local/api/import", { method: "POST", body: fd }));
  }
  type Preview = { detected: { sourceId: string }; warnings: string[]; preview: { rows: PreviewRow[] } };
  const pricedOf = (rows: PreviewRow[]) =>
    rows
      .map((r) => ({ tradingsymbol: r.tradingsymbol, segment: r.segment, exchange: r.exchange, chargesTotal: r.chargesTotal, netPnl: r.netPnl }))
      .sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol));

  it("a Dhan P&L export (a parser with NO currency check): the preview carries the note and no currency row, and names the stranded open one", async () => {
    const res = await postNamed(H_HAS, "Dhan_PnL_report.csv", dhanPnl(DP_CCY));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Preview;
    expect(json.detected.sourceId).toBe("dhan-csv");
    expect(refusalOf(json.warnings)).toBe(noteFor(2, "row", DP_NAMES));
    expect(strandedOf(json.warnings)).toEqual([STRANDED("FUT USDINR 28 Oct 2026")]);
    // The rows beside them are priced exactly as a file that never had the currency rows prices them.
    const plain = (await (await postNamed(H_HAS, "Dhan_PnL_report.csv", dhanPnl([]))).json()) as Preview;
    expect(pricedOf(json.preview.rows).map((r) => r.tradingsymbol)).toEqual(["A2ETEST ALPHA", "FUT NIFTY 27 Oct 2026"]);
    expect(pricedOf(json.preview.rows)).toEqual(pricedOf(plain.preview.rows));
    expect(refusalOf(plain.warnings)).toBeUndefined();
    // Another account: the refusal, no stranded note.
    const other = (await (await postNamed(H_NONE, "Dhan_PnL_report.csv", dhanPnl(DP_CCY))).json()) as Preview;
    expect(refusalOf(other.warnings)).toBe(noteFor(2, "row", DP_NAMES));
    expect(strandedOf(other.warnings)).toEqual([]);
  });

  it("a Dhan GTR with one CDS bill and one NSE position previews the NSE row and names the CDS one — the file no longer fails whole", async () => {
    const res = await postNamed(H_NONE, GTR_NAME, gtrFile([...GTR_NIFTY, gtrCcy("FUT USDINR 28 Sep 2026", "CDS")], 2500, 110.03));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Preview;
    expect(json.detected.sourceId).toBe("dhan-gtr");
    expect(json.preview.rows.map((r) => [r.tradingsymbol, r.exchange])).toEqual([[GTR_SCRIP, "NSE"]]);
    expect(refusalOf(json.warnings)).toBe(noteFor(1, "row", "FUT USDINR 28 Sep 2026"));
  });

  it("the generic mapper through the route: the venue-refused row reaches the ONE note with the by-name row", async () => {
    const res = await postNamed(H_NONE, GM_OPTS.filename, gmCsv([...GM_NIFTY, gmCcy("AUDINR26OCTFUT", "CDS"), gmCcy("USDINR26OCTFUT", "NSE")]), {
      mapping: JSON.stringify({ broker: GM_OPTS.broker, mapping: GM_MAP }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Preview;
    expect(json.detected.sourceId).toBe("generic-table");
    expect(json.preview.rows.map((r) => r.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(refusalsOf(json.warnings)).toEqual([noteFor(2, "row", "AUDINR26OCTFUT, USDINR26OCTFUT")]);
  });

  // v4.8.0 CU / R5 — synthetic rows. Before the fix the NCDEX cell reached `buildRow` as the row's venue and
  // `findRates` THREW "No charge_config for kotakneo / default / future / NCDEX" out of the route handler: the
  // WHOLE file failed on a raw engine message (confirmed red against the unfixed tree before the fix was written).
  it("R5 · the generic mapper through the route: an NCDEX row is refused and NAMED, and the rest of the file previews", async () => {
    const res = await postNamed(H_NONE, GM_OPTS.filename, gmCsv([...GM_NIFTY, gmCcy("DHANIYA26OCTFUT", "NCDEX")]), {
      mapping: JSON.stringify({ broker: GM_OPTS.broker, mapping: GM_MAP }),
    });
    const json = (await res.json()) as Preview & { error?: string };
    expect(json.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(json.preview.rows.map((r) => r.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(json.warnings.filter((w) => /NCDEX/.test(w))).toEqual([GM_NCDEX_NOTE(1, "DHANIYA26OCTFUT")]);
    expect(refusalsOf(json.warnings)).toEqual([]);
  });
});

// ===========================================================================
// v4.8.0 wave CU — the residuals the v4.7.0 release session recorded
// (docs/DECISIONS.md 2026-10-05, "the fortieth"): R2 Angel One Tax P&L's
// Segment column, R3 the Angel One / Upstox parser's compound venue cells,
// R5 NCDEX in the generic mapper, R6 reconciliation honesty, R7 a row refused
// by NAME is no longer counted, R8 the one client-importable rule module,
// R9 no WeakMap between the mapper and the guard. (R4, manual entry, lives in
// tests/currency-manual-entry.test.ts.) Every row below is SYNTHETIC; AUDINR
// and CADINR are names outside lib/domain/currency-pairs.ts — no such contract
// is listed — so only a venue / segment cell can refuse them.
// ===========================================================================

describe("R8 — lib/import/currency-venue.ts owns the rule, and stays client-importable", () => {
  it("generic-map.ts and parsers/zerodha.ts RE-EXPORT it: the same functions, not copies", () => {
    expect(genericMapModule.isCurrencyVenueCell).toBe(currencyVenue.isCurrencyVenueCell);
    expect(zerodhaModule.isCurrencyContract).toBe(currencyVenue.isCurrencyContract);
    expect(zerodhaModule.statesCurrency).toBe(currencyVenue.statesCurrency);
    expect(zerodhaModule.CURRENCY_NOT_PRICED).toBe(currencyVenue.CURRENCY_NOT_PRICED);
  });

  it("its WHOLE import graph is five pure files — no papaparse, no xlsx, no node:, no DB, no React", () => {
    const root = process.cwd();
    const IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\s[^;]*?from\s+"([^"]+)"|(?:^|\n)[ \t]*import\s+"([^"]+)"/g;
    const importsOf = (file: string) => [...fs.readFileSync(file, "utf8").matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]!);
    const resolve = (spec: string, from: string): string | null => {
      const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
      if (base == null) return null; // a bare specifier: a package or a node: built-in
      const hit = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((c) => fs.existsSync(c));
      if (!hit) throw new Error(`unresolved import ${spec} from ${from}`);
      return hit;
    };
    const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
    const seen = new Set<string>();
    const bare: string[] = [];
    const queue = [path.join(root, "lib/import/currency-venue.ts")];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(file)) {
        const next = resolve(spec, file);
        if (next == null) bare.push(`${rel(file)} -> ${spec}`);
        else queue.push(next);
      }
    }
    expect(bare).toEqual([]);
    expect([...seen].map(rel).sort()).toEqual([
      "lib/domain/constants.ts",
      "lib/domain/currency-pairs.ts",
      "lib/engine/classify.ts",
      "lib/engine/types.ts",
      "lib/import/currency-venue.ts",
    ]);
  });

  it("the two client-side readers import the rule from it, never from a parser", () => {
    const form = fs.readFileSync(path.join(process.cwd(), "components/trades/manual-trade-form.tsx"), "utf8");
    expect(form.startsWith('"use client";')).toBe(true);
    expect(form).toMatch(/from "@\/lib\/import\/currency-venue"/);
    expect(form).not.toMatch(/from "@\/lib\/import\/parsers\//);
    const mapper = fs.readFileSync(path.join(process.cwd(), "lib/import/generic-map.ts"), "utf8");
    expect(mapper).toMatch(/from "\.\/currency-venue"/);
    expect(mapper).not.toMatch(/from "\.\/parsers\//);
  });
});

describe("R3 — the Angel One / Upstox FILE parser reads a COMPOUND currency venue cell (the shared rule)", () => {
  it("Upstox trade report: Exchange = NSE_CURRENCY, and Segment = NSE-CDS — names outside the pair list", () => {
    const rows = [
      "01-10-2026,AUDINR,55.5,NSE_CURRENCY,FO,,FUTCUR,0,28-10-2026,T6,10:30:00,BUY,1,55.5",
      "01-10-2026,CADINR,61,NSE,NSE-CDS,,FUTCUR,0,28-10-2026,T7,10:40:00,BUY,1,61",
    ];
    const withCcy = parseUpstox(ctx("trade_2026.csv", upReport([...UP_NIFTY, ...rows])));
    const without = parseUpstox(ctx("trade_2026.csv", upReport(UP_NIFTY)));
    expect(withCcy.trades).toEqual(without.trades);
    expect(refusalOf(withCcy.warnings)).toBe(noteFor(2, "fill", "AUDINR, CADINR"));
    expect(currencyRefusalsOf(withCcy)).toEqual(["AUDINR", "CADINR"]);
  });

  it("an aggregated P&L report: Exchange = BSE_CURRENCY is refused — it used to be stored on BSE", () => {
    const head = "Symbol,Exchange,Buy Qty,Sell Qty,Buy Value,Sell Value,Realised P&L";
    const csv = (rows: string[]) => `${[head, "NIFTY26OCTFUT,NFO,75,75,1875000,1882500,7500", ...rows].join("\n")}\n`;
    const withCcy = parseAngelOne(ctx("angelone-pnl.csv", csv(["AUDINR26OCTFUT,BSE_CURRENCY,1,1,55,55.5,0.5"])));
    const without = parseAngelOne(ctx("angelone-pnl.csv", csv([])));
    expect(withCcy.trades).toEqual(without.trades);
    expect(refusalOf(withCcy.warnings)).toBe(noteFor(1, "row", "AUDINR26OCTFUT"));
  });
});

describe("R2 — Angel One Tax P&L reads its Segment column (SYNTHETIC cells; only NSEFO and BSEFO are verified)", () => {
  const fut = (segment: string, symbol: string) => [segment, symbol, "31-07-2026", "15", "01-07-2026", "05-07-2026", "50000", "750000", "50500", "757500", "150", "80", "7270", "1507500"];
  const unverified = (w: string[]) => w.filter((x) => /Segment Vyuha has not seen/.test(x));

  it("NSEFO, BSEFO, a blank cell and a sheet with NO Segment column all import with no segment warning", () => {
    const stated = angelTax([["Futures"], AT_FUT_HEAD, fut("NSEFO", "BANKNIFTY"), fut("nsefo", "NIFTY"), fut("", "FINNIFTY"), fut("BSEFO", "SENSEX")]);
    expect(symbolsOf(stated)).toEqual(["FUT BANKNIFTY 31 Jul 2026", "FUT NIFTY 31 Jul 2026", "FUT FINNIFTY 31 Jul 2026", "FUT SENSEX 31 Jul 2026"]);
    expect(unverified(stated.warnings)).toEqual([]);
    const older = angelTax([["Futures"], AT_FUT_HEAD.slice(1), fut("", "BANKNIFTY").slice(1)]);
    expect(symbolsOf(older)).toEqual(["FUT BANKNIFTY 31 Jul 2026"]);
    expect(unverified(older.warnings)).toEqual([]);
  });

  it("a segment the shared venue rule reads as currency is refused AT THE PARSER, whatever the name", () => {
    const out = angelTax([["Futures"], AT_FUT_HEAD, fut("NSEFO", "BANKNIFTY"), fut("CDS", "AUDINR"), fut("NSE_CURRENCY", "CADINR")]);
    expect(symbolsOf(out)).toEqual(["FUT BANKNIFTY 31 Jul 2026"]);
    expect(refusalsOf(out.warnings)).toEqual([noteFor(2, "row", "FUT AUDINR 31 Jul 2026, FUT CADINR 31 Jul 2026")]);
    expect(currencyRefusalsOf(out)).toEqual(["FUT AUDINR 31 Jul 2026", "FUT CADINR 31 Jul 2026"]);
    expect(unverified(out.warnings)).toEqual([]);
  });

  it("any OTHER unverified segment is IMPORTED — never refused on the segment alone — and named in a warning", () => {
    const out = angelTax([["Futures"], AT_FUT_HEAD, fut("NSEFO", "BANKNIFTY"), fut("NFO", "NIFTY"), fut("MCXFO", "CRUDEOIL")]);
    expect(symbolsOf(out)).toEqual(["FUT BANKNIFTY 31 Jul 2026", "FUT NIFTY 31 Jul 2026", "FUT CRUDEOIL 31 Jul 2026"]);
    expect(refusalsOf(out.warnings)).toEqual([]);
    expect(unverified(out.warnings)).toEqual([
      "2 derivative rows state a Segment Vyuha has not seen on a real Angel One Tax P&L — the only ones verified are NSEFO and BSEFO: FUT NIFTY 31 Jul 2026 (NFO), FUT CRUDEOIL 31 Jul 2026 (MCXFO). They were imported as the file names them; check the segment and charges on those rows.",
    ]);
  });

  const REAL = path.join(process.cwd(), "tests/fixtures/redacted/angelone-taxpnl-fy2026-27.xlsx");
  // The real file states NSEFO on two rows and BSEFO on one (a SENSEX option) — read 2026-10-05. The brief for
  // this wave named NSEFO alone; this test is what showed BSEFO, so both are the verified set.
  it.skipIf(!fs.existsSync(REAL))("the REAL redacted export: its Segments are the verified ones, so it draws no warning and no refusal", () => {
    const real = parseAngelOneTaxPnl({ filename: "angelone-taxpnl-fy2026-27.xlsx", buffer: fs.readFileSync(REAL) });
    expect(real.trades.length).toBeGreaterThan(0);
    expect(unverified(real.warnings)).toEqual([]);
    expect(refusalsOf(real.warnings)).toEqual([]);
  });
});

describe("R5 — NCDEX in the generic column mapper: refused and NAMED, the rest of the file imports", () => {
  it("executions: its own sentence, not 'unreadable', not counted as a line read, never a trade on NCDEX or NSE", () => {
    const r = applyMapping(GM_HEADERS, [...GM_NIFTY, gmCcy("DHANIYA26OCTFUT", "NCDEX"), gmCcy("JEERAUNJHA26OCTFUT", "ncdex")], GM_MAP, GM_OPTS);
    const without = applyMapping(GM_HEADERS, GM_NIFTY, GM_MAP, GM_OPTS);
    expect(r.trades).toEqual(without.trades);
    expect(r.refusedNcdex).toEqual(["DHANIYA26OCTFUT", "JEERAUNJHA26OCTFUT"]);
    expect(r.refusedCurrency).toEqual([]);
    expect(r.skipped).toBe(2);
    expect(r.warnings).toEqual([...without.warnings, GM_NCDEX_NOTE(2, "DHANIYA26OCTFUT, JEERAUNJHA26OCTFUT")]);
    expect(without.refusedNcdex).toEqual([]);
  });

  it("round trips (P&L-shaped): the same", () => {
    const headers = ["Scrip", "Buy Qty", "Buy Price", "Sell Qty", "Sell Price", "Exchange"];
    const m: ColumnMapping = { tradingsymbol: 0, buyQty: 1, avgBuyPrice: 2, sellQty: 3, avgSellPrice: 4, exchange: 5 };
    const r = applyMapping(headers, [["RELIANCE", "10", "2400", "10", "2500", "NSE"], ["DHANIYA26OCTFUT", "10", "7000", "10", "7100", "NCDEX"]], m, GM_OPTS);
    expect(r.trades.map((x) => [x.tradingsymbol, x.exchangeHint])).toEqual([["RELIANCE", "NSE"]]);
    expect(r.refusedNcdex).toEqual(["DHANIYA26OCTFUT"]);
    expect(r.skipped).toBe(1);
    expect(r.warnings).toEqual([GM_NCDEX_NOTE(1, "DHANIYA26OCTFUT")]);
  });

  it("MCX beside it is still imported on MCX — the refusal is NCDEX's alone; and the file's line count excludes the refused row", () => {
    const r = applyMapping(GM_HEADERS, [gmCcy("CRUDEOIL26OCTFUT", "MCX"), gmCcy("DHANIYA26OCTFUT", "NCDEX")], GM_MAP, GM_OPTS);
    expect(r.trades.map((x) => [x.tradingsymbol, x.exchangeHint])).toEqual([["CRUDEOIL26OCTFUT", "MCX"]]);
    const parsed = parseGenericTable(gmCtx([...GM_NIFTY, gmCcy("DHANIYA26OCTFUT", "NCDEX")]));
    expect(parsed.sourceRows).toBe(2);
    expect(parsed.warnings).toContain(GM_NCDEX_NOTE(1, "DHANIYA26OCTFUT"));
  });
});

describe("R7 — a row refused by NAME is not counted: sourceRows and the parser's 'N → M' line state what was imported", () => {
  const arrowLine = (p: ParsedFile) => p.warnings.find((w) => w.includes(" → "));
  /** The parser alone already refused it, so the guard that runs next adds nothing. */
  const guardAddsNothing = (p: ParsedFile) => {
    const before = { warnings: [...p.warnings], trades: [...p.trades], sourceRows: p.sourceRows };
    refuseCurrencyRows(p);
    expect({ warnings: p.warnings, trades: p.trades, sourceRows: p.sourceRows }).toEqual(before);
  };

  it("Fyers tradebook: '2 fills → 1 position', sourceRows 2 — the USDINR fill never paired", () => {
    const p = fyers([...FY_NIFTY, FY_BYNAME]);
    const without = fyers(FY_NIFTY);
    expect(p.trades).toEqual(without.trades);
    expect(p.sourceRows).toBe(2);
    expect(arrowLine(p)).toMatch(/^2 fills → 1 position /);
    expect(arrowLine(p)).toBe(arrowLine(without));
    expect(refusalsOf(p.warnings)).toEqual([noteFor(1, "row", "USDINR26OCTFUT")]);
    guardAddsNothing(p);
  });

  it("Dhan GTR: a pair billed on NSE leaves sourceRows at 2 and its charges out of the figure the book is conserved to", () => {
    const p = gtr([...GTR_NIFTY, gtrCcy("FUT USDINR 28 Sep 2026", "NSE")], 2500, 110.03);
    const without = gtr(GTR_NIFTY, 2400, 85.82);
    expect(p.trades).toEqual(without.trades);
    expect(p.sourceRows).toBe(2);
    expect(p.warnings.filter((w) => /Please report this file/i.test(w))).toEqual([]);
    expect(refusalsOf(p.warnings)).toEqual([noteFor(1, "row", "FUT USDINR 28 Sep 2026")]);
    guardAddsNothing(p);
  });

  it("Nuvama P&L report: '2 statement lines → 1 position', sourceRows 2, the line's bill not in the book's charges", () => {
    const p = nuvama([...NV_NIFTY, nvLine("GBPINR-FUT-28Oct2026-NSE", "01-Sep-26", "NSE", "Buy", 1000, 105, 1000)]);
    const without = nuvama(NV_NIFTY);
    expect(p.trades).toEqual(without.trades);
    expect(p.sourceRows).toBe(2);
    expect(arrowLine(p)).toMatch(/^2 statement lines .* → 1 position\./);
    expect(p.reported?.totalCharges).toBe(without.reported?.totalCharges);
    expect(refusalsOf(p.warnings)).toEqual([noteFor(1, "row", "FUT GBPINR 28 Oct 2026")]);
    guardAddsNothing(p);
  });

  it("Paytm tradebook: sourceRows 2, and the refused execution's charges are apportioned to nobody", () => {
    const p = paytm([...PT_NIFTY, ptRow("USDINR26OCTFUT", "NSE", "Buy", 1000, 84, "3", "10:00:00")]);
    const without = paytm(PT_NIFTY);
    expect(p.trades).toEqual(without.trades);
    expect(p.sourceRows).toBe(2);
    expect(refusalsOf(p.warnings)).toEqual([noteFor(1, "row", "USDINR26OCTFUT")]);
    guardAddsNothing(p);
  });

  it("the generic mapper: the by-name row is in refusedCurrency and out of sourceRows", () => {
    const r = applyMapping(GM_HEADERS, [...GM_NIFTY, gmCcy("USDINR26OCTFUT", "NSE")], GM_MAP, GM_OPTS);
    expect(r.refusedCurrency).toEqual(["USDINR26OCTFUT"]);
    expect(r.skipped).toBe(1);
    const p = parseGenericTable(gmCtx([...GM_NIFTY, gmCcy("USDINR26OCTFUT", "NSE")]));
    const without = parseGenericTable(gmCtx(GM_NIFTY));
    expect(p.trades).toEqual(without.trades);
    expect(p.sourceRows).toBe(2);
    expect(p.sourceRows).toBe(without.sourceRows);
    // USDINRBEES on the same venue is NOT a pair: imported, counted.
    expect(parseGenericTable(gmCtx([...GM_NIFTY, gmCcy("USDINRBEES", "NSE")])).sourceRows).toBe(3);
    guardAddsNothing(p);
  });

  it("Zerodha tradebook: a pair under a NON-currency segment is refused before it is counted — '2 fills → 1 position'", () => {
    const p = parseZerodha(ctx("zerodha-tradebook.csv", tradebook([...TB_NIFTY, "USDINR26OCTFUT,,2026-10-01,NFO,FO,,buy,false,1,84,T9,O9,2026-10-01 10:00:00"])));
    const without = parseZerodha(ctx("zerodha-tradebook.csv", tradebook(TB_NIFTY)));
    expect(p.trades).toEqual(without.trades);
    expect(p.sourceRows).toBe(2);
    expect(arrowLine(p)).toMatch(/^2 fills → 1 position /);
    expect(refusalsOf(p.warnings)).toEqual([noteFor(1, "fill", "USDINR26OCTFUT")]);
    guardAddsNothing(p);
  });

  it("Zerodha tax P&L: a pair filed under the F&O label is refused before it is counted — '1 exit row → 1 position'", () => {
    const sheet = ["View Zerodha's guide on using tax reports for filing.", "F&O", TW_HEAD, TW_NIFTY, TW_USDINR].join("\n");
    const p = parseZerodha(ctx("taxpnl.csv", `${sheet}\n`));
    expect(p.format).toBe("taxpnl");
    expect(symbolsOf(p)).toEqual(["NIFTY26OCTFUT"]);
    expect(p.sourceRows).toBe(1);
    expect(arrowLine(p)).toMatch(/^1 exit row → 1 position /);
    expect(refusalsOf(p.warnings)).toEqual([noteFor(1, "exit row", "USDINR26OCTFUT")]);
    guardAddsNothing(p);
  });
});

describe("R6 — reconciliation honesty: the file's own totals still include the refused rows, and the import says so ONCE", () => {
  const recon = (w: string[]) => w.filter((x) => x === CURRENCY_RECONCILIATION_NOTE);

  it("pure: written when the file states `reported` totals or `reference` rows; once, however many refusals; never otherwise", () => {
    const withTotals: ParsedFile = { ...parsedOf([nt("USDINR26OCTFUT"), nt("RELIANCE")]), reported: { totalCharges: 10 } };
    refuseCurrencyRows(withTotals);
    expect(withTotals.warnings).toEqual(["an earlier warning", noteFor(1, "row", "USDINR26OCTFUT"), CURRENCY_RECONCILIATION_NOTE]);
    withTotals.trades.push(nt("EURINR26OCTFUT"));
    refuseCurrencyRows(withTotals);
    expect(refusalsOf(withTotals.warnings)).toHaveLength(2);
    expect(recon(withTotals.warnings)).toHaveLength(1);

    const withReference: ParsedFile = { ...parsedOf([nt("USDINR26OCTFUT")]), reference: [{ scope: "scrip", key: "RELIANCE", figures: { grossPnl: 1 } }] };
    expect(recon(refuseCurrencyRows(withReference).warnings)).toHaveLength(1);

    // The file states no figures of its own: nothing to be out of step with.
    expect(recon(refuseCurrencyRows(parsedOf([nt("USDINR26OCTFUT")])).warnings)).toEqual([]);
    expect(recon(refuseCurrencyRows({ ...parsedOf([nt("USDINR26OCTFUT")]), reported: {} }).warnings)).toEqual([]);
    // Nothing refused: no sentence, whatever the file states.
    expect(recon(refuseCurrencyRows({ ...parsedOf([nt("RELIANCE")]), reported: { totalCharges: 10 } }).warnings)).toEqual([]);
    // It is not itself a refusal note (every `refusalsOf` pin in this file filters on the reason phrase).
    expect(CURRENCY_RECONCILIATION_NOTE.includes(CURRENCY_NOT_PRICED)).toBe(false);
  });

  it("Zerodha Console P&L: its Summary total cannot be corrected (no per-row charges) — kept AS STATED, with the note", () => {
    const file = (rows: string[]) => `${["Summary", "Charges,123.45", "Realized P&L,7600", "", CONSOLE_HEAD, "NIFTY26OCTFUT,,75,75,1875000,1882500,7500", ...rows].join("\n")}\n`;
    const withCcy = parseZerodha(ctx("zerodha-console-pnl.csv", file(["USDINR26OCTFUT,,1,1,84100,84200,100"])));
    const without = parseZerodha(ctx("zerodha-console-pnl.csv", file([])));
    expect(withCcy.reported).toEqual({ charges: 123.45, realisedPnl: 7600 });
    expect(withCcy.reported).toEqual(without.reported);
    expect(recon(withCcy.warnings)).toHaveLength(1);
    expect(recon(without.warnings)).toEqual([]);
  });

  const fyersPnl = (gross: number, rows: string[]) =>
    parseFyersRealisedPnl(
      ctx(
        "FYERS_realised_pnl_CCY.csv",
        [
          "Report Title,Realised P&L report",
          "Date Range,From 01/10/2026 to 05/10/2026",
          `Gross P&L,${gross}`,
          "Total charges,150",
          "",
          "Symbol name,Symbol code,Segment,Gross P&L,Buy qty,Sell qty,Buy price,Sell price",
          "NSE:NIFTY26OCTFUT,NIFTY FUT,Derivatives,7500,75,75,25000,25100",
          ...rows,
        ].join("\n"),
      ),
    );
  const scrips = (p: ParsedFile) => (p.reference ?? []).filter((r) => r.scope === "scrip").map((r) => r.key);

  it("Fyers Realised P&L: a currency contract gets NO reference row — by its Segment cell, else by its name; the totals block is kept", () => {
    const withCcy = fyersPnl(7700, [
      "NSE:USDINR26OCTFUT,USDINR FUT,Derivatives,100,1000,1000,84,84.1", // by name
      "NSE:AUDINR26OCTFUT,AUDINR FUT,Currency,100,1000,1000,55,55.1", // by its Segment cell
    ]);
    const without = fyersPnl(7500, []);
    expect(scrips(withCcy)).toEqual(["NIFTY26OCTFUT"]);
    expect(scrips(withCcy)).toEqual(scrips(without));
    expect(withCcy.sourceRows).toBe(1);
    expect(withCcy.trades).toEqual([]);
    // The file's own figures, exactly as it states them — currency rows and all.
    expect([withCcy.reported?.grossPnl, withCcy.reported?.totalCharges]).toEqual([7700, 150]);
    expect(refusalsOf(withCcy.warnings)).toEqual([noteFor(2, "row", "USDINR26OCTFUT, AUDINR26OCTFUT")]);
    expect(currencyRefusalsOf(withCcy)).toEqual(["USDINR26OCTFUT", "AUDINR26OCTFUT"]);
    expect(recon(withCcy.warnings)).toHaveLength(1);
    // Every row was READ (the sum still equals the stated Gross P&L), so no "rows were not read" alarm.
    expect(withCcy.warnings.filter((w) => /some rows were not read/.test(w))).toEqual([]);
    expect(withCcy.warnings.some((w) => /^1 contract figures were read/.test(w))).toBe(true);
    expect(refusalsOf(without.warnings)).toEqual([]);
    expect(recon(without.warnings)).toEqual([]);
  });
});
