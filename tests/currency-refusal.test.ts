import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// Pure modules only — neither reaches lib/db, so the temp-db helper still binds
// the connection first (the routes are imported dynamically in beforeAll).
import {
  CURRENCY_NOT_PRICED,
  currencyRefusalsOf,
  parseZerodha,
  strandedCurrencyNotes,
} from "@/lib/import/parsers/zerodha";
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
