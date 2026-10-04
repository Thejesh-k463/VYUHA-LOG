import { afterEach, describe, expect, it, vi } from "vitest";
import * as kotak from "@/lib/import/api/kotakneo";
import {
  KOTAK_LOGIN_BASE,
  assertKotakBaseUrl,
  fetchKotakTrades,
  kotakImportSource,
  kotakLogin,
  normalizeKotakTrades,
  toParsedFile,
  type KotakTradeRow,
} from "@/lib/import/api/kotakneo";
import { BrokerAuthExpired, isBrokerAuthExpired } from "@/lib/import/api/broker-auth-error";
import { KOTAK_TRADE_API_BROKERAGE_NOTE, PULL_UNVERIFIED_LABEL } from "@/lib/domain/broker-pull-disclosure";
import { totp } from "@/lib/totp";

/**
 * Kotak Neo Trade API native pull (v4.7.0 wave C6). DOCUMENTED, NOT YET
 * VERIFIED WITH A REAL ACCOUNT (ruling B2): every URL, header and body below is
 * Kotak's own docs + SDK (R10 §2, K-A1…K-S2), pinned so a live pull either fits
 * or fails visibly.
 */

const TODAY = "2026-10-04";
const SECRET = "JBSWY3DPEHPK3PXP";
const CREDS = { accessToken: "dash-token", mobileNumber: "9876543210", ucc: "AB123", mpin: "654321", totpSecret: SECRET };

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const json = (status: number, body: unknown) =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function stub(...responses: Response[]) {
  calls = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return responses[Math.min(i++, responses.length - 1)].clone();
  });
}
const hdr = (c: Call) => Object.fromEntries(Object.entries((c.init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const VIEW = json(200, { data: { token: "view-token", sid: "view-sid", rid: "r", kType: "View", status: "success" } });
const TRADE = (baseUrl?: string) =>
  json(200, { data: { token: "trade-token", sid: "trade-sid", rid: "r", kType: "Trade", ...(baseUrl === undefined ? {} : { baseUrl }) } });

const row = (over: Partial<KotakTradeRow> = {}): KotakTradeRow => ({
  trdSym: "IDEA-EQ",
  sym: "IDEA",
  exSeg: "nse_cm",
  trnsTp: "B",
  fldQty: 1,
  avgPrc: "9.39",
  flDt: "04-Oct-2026",
  flTm: "14:28:16",
  prod: "CNC",
  nOrdNo: "250122000001",
  ...over,
});

describe("read-only by surface", () => {
  it("the module exports no order, modify or funds capability", () => {
    expect(Object.keys(kotak).sort()).toEqual([
      "KOTAK_LOGIN_BASE",
      "assertKotakBaseUrl",
      "fetchKotakTrades",
      "kotakImportSource",
      "kotakLogin",
      "normalizeKotakTrades",
      "toParsedFile",
    ]);
    expect(KOTAK_LOGIN_BASE).toBe("https://mis.kotaksecurities.com/login/1.0");
  });
});

describe("assertKotakBaseUrl — the runtime pin on the session's baseUrl (review R10)", () => {
  it("accepts https on kotaksecurities.com and its subdomains", () => {
    expect(assertKotakBaseUrl("https://cis.kotaksecurities.com").hostname).toBe("cis.kotaksecurities.com");
    expect(assertKotakBaseUrl("https://mis.kotaksecurities.com/").hostname).toBe("mis.kotaksecurities.com");
    expect(assertKotakBaseUrl("https://kotaksecurities.com").hostname).toBe("kotaksecurities.com");
  });

  it("refuses http, look-alike hosts, credentials in the URL and junk", () => {
    for (const bad of [
      "http://cis.kotaksecurities.com",
      "https://kotaksecurities.com.evil.io",
      "https://evilkotaksecurities.com",
      "https://user:pw@cis.kotaksecurities.com",
      "wss://cis.kotaksecurities.com",
      "not a url",
      "",
    ]) {
      expect(() => assertKotakBaseUrl(bad), bad).toThrow(/refused/);
    }
  });
});

describe("kotakLogin", () => {
  it("tradeApiLogin (TOTP) → tradeApiValidate (MPIN) with the documented headers and bodies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T05:00:00Z"));
    stub(VIEW, TRADE("https://cis.kotaksecurities.com"));
    const s = await kotakLogin(CREDS);
    expect(s).toEqual({ token: "trade-token", sid: "trade-sid", baseUrl: "https://cis.kotaksecurities.com" });
    expect(calls).toHaveLength(2);

    expect(calls[0].url).toBe("https://mis.kotaksecurities.com/login/1.0/tradeApiLogin");
    expect(calls[0].init.method).toBe("POST");
    const h0 = hdr(calls[0]);
    expect(h0["authorization"]).toBe("dash-token");
    expect(h0["neo-fin-key"]).toBe("neotradeapi");
    expect(h0["content-type"]).toBe("application/json");
    expect(h0["sid"]).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      mobileNumber: "+919876543210",
      ucc: "AB123",
      totp: totp(SECRET, { nowSeconds: Math.floor(new Date("2026-10-04T05:00:00Z").getTime() / 1000) }),
    });

    expect(calls[1].url).toBe("https://mis.kotaksecurities.com/login/1.0/tradeApiValidate");
    expect(calls[1].init.method).toBe("POST");
    const h1 = hdr(calls[1]);
    expect(h1["authorization"]).toBe("dash-token");
    expect(h1["neo-fin-key"]).toBe("neotradeapi");
    expect(h1["sid"]).toBe("view-sid");
    expect(h1["auth"]).toBe("view-token");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ mpin: "654321" });
    for (const c of calls) expect(hdr(c)["x-forwarded-for"]).toBeUndefined();
  });

  it("a mobile already carrying its ISD code is sent as typed; an absent baseUrl falls back to the SDK's mis host (K-A8)", async () => {
    stub(VIEW, TRADE());
    const s = await kotakLogin({ ...CREDS, mobileNumber: "+91 98765 43210" });
    expect(JSON.parse(String(calls[0].init.body)).mobileNumber).toBe("+919876543210");
    expect(s.baseUrl).toBe("https://mis.kotaksecurities.com");
  });

  it("refuses a validate answer whose baseUrl is off kotaksecurities.com — before any trade-book call", async () => {
    stub(VIEW, TRADE("https://cis.kotaksecurities.com.evil.io"));
    await expect(kotakLogin(CREDS)).rejects.toThrow(/refused/);
    expect(calls).toHaveLength(2);
  });

  it("the login error shape {status:'error', message, errorCode} is a plain Error naming Kotak's message", async () => {
    stub(json(401, { status: "error", message: "Invalid credentials or TOTP.", errorCode: "401" }));
    const e = await kotakLogin(CREDS).catch((x) => x);
    expect(isBrokerAuthExpired(e)).toBe(false);
    expect(e.message).toContain("Invalid credentials or TOTP.");
    expect(e.message).toContain("TOTP rejected");
    stub(VIEW, json(200, { status: "error", message: "Invalid MPIN", errorCode: "400" }));
    await expect(kotakLogin(CREDS)).rejects.toThrow(/Invalid MPIN/);
  });
});

describe("fetchKotakTrades", () => {
  const SESSION = { token: "trade-token", sid: "trade-sid", baseUrl: "https://cis.kotaksecurities.com/" };

  it("GETs {baseUrl}/quick/user/trades with Auth, Sid, neo-fin-key and accept", async () => {
    stub(json(200, { stat: "Ok", stCode: 200, data: [row()] }));
    expect(await fetchKotakTrades(SESSION)).toHaveLength(1);
    expect(calls[0].url).toBe("https://cis.kotaksecurities.com/quick/user/trades");
    expect(calls[0].init.method).toBe("GET");
    const h = hdr(calls[0]);
    expect(h["auth"]).toBe("trade-token");
    expect(h["sid"]).toBe("trade-sid");
    expect(h["neo-fin-key"]).toBe("neotradeapi");
    expect(h["accept"]).toBe("application/json");
    expect(h["authorization"]).toBeUndefined();
    expect(h["x-forwarded-for"]).toBeUndefined();
  });

  it("compares stat case-insensitively ('Ok' in the docs repo, 'ok' in the SDK doc — R10 §4.1)", async () => {
    stub(json(200, { stat: "ok", stCode: 200, data: [row(), row()] }));
    expect(await fetchKotakTrades(SESSION)).toHaveLength(2);
    stub(json(200, { stat: "OK", stCode: 200, data: [] }));
    expect(await fetchKotakTrades(SESSION)).toEqual([]);
  });

  it("HTTP 401, HTTP 403 and stCode 1003 are BrokerAuthExpired('needsLogin'); a Not_Ok otherwise is a plain Error", async () => {
    for (const r of [json(401, undefined), json(403, { stat: "Not_Ok" }), json(200, { stat: "Not_Ok", emsg: "Invalid session", stCode: 1003 })]) {
      stub(r);
      const e = await fetchKotakTrades(SESSION).catch((x) => x);
      expect(isBrokerAuthExpired(e)).toBe(true);
      expect((e as BrokerAuthExpired).need).toBe("needsLogin");
      expect((e as BrokerAuthExpired).broker).toBe("kotakneo");
    }
    stub(json(200, { stat: "Not_Ok", emsg: "Something else", stCode: 5000 }));
    const e = await fetchKotakTrades(SESSION).catch((x) => x);
    expect(isBrokerAuthExpired(e)).toBe(false);
    expect(e.message).toContain("Something else");
  });

  it("re-checks the session's baseUrl and sends NOTHING to a foreign host", async () => {
    stub(json(200, { stat: "Ok", data: [] }));
    await expect(fetchKotakTrades({ ...SESSION, baseUrl: "https://evilkotaksecurities.com" })).rejects.toThrow(/refused/);
    expect(calls).toHaveLength(0);
  });

  it("kotakImportSource logs in afresh and pulls (nothing cached)", async () => {
    stub(VIEW, TRADE("https://cis.kotaksecurities.com"), json(200, { stat: "Ok", data: [row(), row({ trnsTp: "S", avgPrc: "9.50" })] }));
    const src = kotakImportSource(CREDS);
    expect(src).toMatchObject({ id: "kotakneo-api", broker: "kotakneo", kind: "api" });
    const trades = await src.fetchTrades({});
    expect(calls.map((c) => c.url)).toEqual([
      "https://mis.kotaksecurities.com/login/1.0/tradeApiLogin",
      "https://mis.kotaksecurities.com/login/1.0/tradeApiValidate",
      "https://cis.kotaksecurities.com/quick/user/trades",
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].grossPnl).toBe(0.11);
  });
});

describe("normalizeKotakTrades", () => {
  it("aggregates per symbol + product; equity bare; avgPrc STRING read; every trade carries Q5 + the unverified label", () => {
    const { trades, refused, notes } = normalizeKotakTrades(
      [row(), row({ fldQty: 2, avgPrc: "9.42", flTm: "14:30:00" }), row({ trnsTp: "S", fldQty: 3, avgPrc: "9.60", flTm: "15:10:59" })],
      TODAY,
    );
    expect(refused).toBe(0);
    expect(notes).toEqual([]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      broker: "kotakneo",
      tradingsymbol: "IDEA",
      buyQty: 3,
      sellQty: 3,
      buyValue: 28.23,
      sellValue: 28.8,
      grossPnl: 0.57,
      buyDate: TODAY,
      sellDate: TODAY,
      entryTime: "14:28",
      exitTime: "15:10",
      productHint: "delivery",
      exchangeHint: "NSE",
      sourceFile: "kotakneo-api",
    });
    expect(trades[0].executions).toHaveLength(3);
    expect(trades[0].importNotes).toEqual([KOTAK_TRADE_API_BROKERAGE_NOTE, `Kotak Neo pull: ${PULL_UNVERIFIED_LABEL}.`]);
    expect(KOTAK_TRADE_API_BROKERAGE_NOTE).toBe(
      "If you placed this order through Kotak's Trade API, Kotak charged ₹0 brokerage; Vyuha cannot tell from the fill, so your plan's brokerage is shown.",
    );
  });

  it("names a future from the stated fields (K-S1) — the OpenAlgo canonical grammar", () => {
    const { trades } = normalizeKotakTrades(
      [row({ trdSym: "TCS26JULFUT", sym: "TCS", exSeg: "nse_fo", optTp: "XX", expDt: "28 Jul, 2026", prod: "NRML", fldQty: 175, avgPrc: "3400.5" })],
      TODAY,
    );
    expect(trades[0].tradingsymbol).toBe("FUT TCS 28 Jul 2026");
    expect(trades[0].productHint).toBeNull();
    expect(trades[0].exchangeHint).toBe("NSE");
  });

  it("refuses — never coerces — an unreadable side, quantity, price or instrument, and counts the unnamed ones", () => {
    const { trades, refused, notes } = normalizeKotakTrades(
      [
        row({ trnsTp: "X" }),
        row({ fldQty: "abc" }),
        row({ fldQty: 0 }),
        row({ avgPrc: "" }),
        row({ avgPrc: "9,39x" }),
        row({ avgPrc: undefined }),
        row({ trdSym: "TCS26JULFUT", sym: "TCS", exSeg: "nse_fo", optTp: "XX", expDt: "sometime" }),
        row({ exSeg: "cde_fo", trdSym: "USDINR26OCTFUT", optTp: "XX", expDt: "28 Oct, 2026" }),
        row({ fldQty: "2", avgPrc: 9.5 }),
      ],
      TODAY,
    );
    expect(refused).toBe(8);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ buyQty: 2, avgBuyPrice: 9.5 });
    // D-C6-2: the currency fill is refused under its OWN note, not as unnamed.
    expect(notes.join(" ")).toContain("1 fill named no instrument");
    expect(notes.join(" ")).toContain("1 currency / NCDEX fill was refused");
  });

  it("maps CNC/MTF/MIS and leaves NRML to the classifier; flTm outside HH:MM:SS is null", () => {
    const by = (over: Partial<KotakTradeRow>) => normalizeKotakTrades([row(over)], TODAY).trades[0];
    expect(by({ prod: "MTF" }).productHint).toBe("mtf");
    expect(by({ prod: "MIS" }).productHint).toBe("intraday");
    expect(by({ prod: "NRML" }).productHint).toBeNull();
    expect(by({ exSeg: "bse_cm" }).exchangeHint).toBe("BSE");
    expect(by({ flTm: "2:28 PM" }).entryTime).toBeNull();
  });
});

describe("toParsedFile", () => {
  it("carries the documented-not-verified warning and the refusal count", () => {
    const pf = toParsedFile([], 1);
    expect(pf).toMatchObject({ sourceId: "kotakneo-api", broker: "kotakneo", format: "api" });
    expect(pf.warnings[0]).toContain(PULL_UNVERIFIED_LABEL);
    expect(pf.warnings.join(" ")).toContain("1 fill had no readable side");
  });

  it("BrokerAuthExpired carries broker + need", () => {
    const e = new BrokerAuthExpired("kotakneo", "needsLogin", "x");
    expect([e.broker, e.need]).toEqual(["kotakneo", "needsLogin"]);
  });
});
