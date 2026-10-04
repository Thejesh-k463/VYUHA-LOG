import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "@/package.json";
import * as fyers from "@/lib/import/api/fyers";
import {
  FYERS_API,
  exchangeFyersAuthCode,
  extractFyersAuthCode,
  fetchFyersProfileId,
  fetchFyersTradeBook,
  fyersAppIdHash,
  fyersImportSource,
  fyersLoginUrl,
  normalizeFyersTrades,
  toParsedFile,
  type FyersTradeRow,
} from "@/lib/import/api/fyers";
import { BrokerAuthExpired, isBrokerAuthExpired } from "@/lib/import/api/broker-auth-error";
import { PULL_UNVERIFIED_LABEL } from "@/lib/domain/broker-pull-disclosure";
import { FYERS_NUVAMA_EQUITY_UNVERIFIED } from "@/lib/import/parsers/fyers-tradebook";

/**
 * Fyers API v3 native pull (v4.7.0 wave C6). Hosts, headers and bodies are
 * pinned to Fyers' own SDK + Postman (R10 §2, F-A1…F-D2); the row mapping is
 * pinned over the DOCUMENTED field types — no real response has been seen
 * (owner Q4), so a live pull either fits these or is refused visibly.
 */

const TODAY = "2026-10-04";
const APP = "XC4EOD67IM-100";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
function stub(...responses: Response[]) {
  calls = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return r.clone();
  });
}
const hdr = (c: Call) => Object.fromEntries(Object.entries((c.init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));

afterEach(() => vi.unstubAllGlobals());

const row = (over: Partial<FyersTradeRow> = {}): FyersTradeRow => ({
  symbol: "NSE:SBIN-EQ",
  side: 1,
  tradedQty: 10,
  tradePrice: 800.5,
  tradeValue: 8005,
  productType: "CNC",
  exchange: 10,
  segment: 10,
  orderDateTime: "04-Oct-2026 10:15:33",
  orderNumber: "23100400012345",
  tradeNumber: "1",
  exchangeOrderNo: "1100000012345",
  clientId: "XY12345",
  ...over,
});

describe("read-only by surface", () => {
  it("the module exports no order, modify or funds capability", () => {
    expect(Object.keys(fyers).sort()).toEqual([
      "FYERS_API",
      "exchangeFyersAuthCode",
      "extractFyersAuthCode",
      "fetchFyersProfileId",
      "fetchFyersTradeBook",
      "fyersAppIdHash",
      "fyersImportSource",
      "fyersLoginUrl",
      "normalizeFyersTrades",
      "toParsedFile",
    ]);
  });

  it("names exactly one host (F-A1)", () => {
    expect(FYERS_API).toBe("https://api-t1.fyers.in/api/v3");
  });
});

describe("login helpers", () => {
  it("fyersLoginUrl is the documented generate-authcode URL (F-A2/A3)", () => {
    expect(fyersLoginUrl({ appId: APP, redirectUri: "https://127.0.0.1/", state: "vyuha" })).toBe(
      "https://api-t1.fyers.in/api/v3/generate-authcode?client_id=XC4EOD67IM-100&redirect_uri=https%3A%2F%2F127.0.0.1%2F&response_type=code&state=vyuha",
    );
  });

  it("extractFyersAuthCode takes auth_code BY NAME from a URL, a query string or a bare code", () => {
    const code = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc_DEF-123";
    expect(extractFyersAuthCode(`https://127.0.0.1/?s=ok&code=200&auth_code=${code}&state=vyuha`)).toBe(code);
    expect(extractFyersAuthCode(`  s=ok&code=200&auth_code=${code}  `)).toBe(code);
    expect(extractFyersAuthCode(code)).toBe(code);
    // `code=200` is NOT the auth code — the name decides, never the position.
    expect(extractFyersAuthCode("https://127.0.0.1/?s=ok&code=200&state=vyuha")).toBeNull();
    expect(extractFyersAuthCode("")).toBeNull();
    expect(extractFyersAuthCode("not a code at all")).toBeNull();
  });

  it("fyersAppIdHash is sha256 hex of '<appId>:<secret>' (F-A5; vector pinned, cross-checked with sha256sum)", () => {
    expect(fyersAppIdHash(APP, "SECRET123")).toBe("49e2141e36a776fdbdd6a74096bf1b579666467bab52a0b93ace892be7a3f8df");
  });
});

describe("exchangeFyersAuthCode", () => {
  it("POSTs validate-authcode with the documented body, version 3 and a named User-Agent — and no Authorization", async () => {
    stub(json(200, { s: "ok", code: 200, message: "", access_token: "day-token", refresh_token: "r" }));
    await expect(exchangeFyersAuthCode({ appId: APP, secret: "SECRET123", code: "authcode-xyz" })).resolves.toEqual({ accessToken: "day-token" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api-t1.fyers.in/api/v3/validate-authcode");
    expect(calls[0].init.method).toBe("POST");
    const h = hdr(calls[0]);
    expect(h["version"]).toBe("3");
    expect(h["user-agent"]).toBe(`Vyuha/${pkg.version}`);
    expect(h["content-type"]).toBe("application/json");
    expect(h["authorization"]).toBeUndefined();
    expect(h["x-forwarded-for"]).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      grant_type: "authorization_code",
      appIdHash: "49e2141e36a776fdbdd6a74096bf1b579666467bab52a0b93ace892be7a3f8df",
      code: "authcode-xyz",
    });
  });

  it("a stated token error (-16) or HTTP 401 is BrokerAuthExpired('needsAuthCode'); any other refusal is a plain Error", async () => {
    stub(json(200, { s: "error", code: -16, message: "Could not authenticate the user" }));
    const e1 = await exchangeFyersAuthCode({ appId: APP, secret: "s", code: "c" }).catch((e) => e);
    expect(isBrokerAuthExpired(e1)).toBe(true);
    expect((e1 as BrokerAuthExpired).need).toBe("needsAuthCode");
    expect((e1 as BrokerAuthExpired).broker).toBe("fyers");

    stub(json(401, { s: "error", code: -99, message: "unauthorised" }));
    expect(isBrokerAuthExpired(await exchangeFyersAuthCode({ appId: APP, secret: "s", code: "c" }).catch((e) => e))).toBe(true);

    stub(json(200, { s: "error", code: -50, message: "Invalid app id" }));
    const e3 = await exchangeFyersAuthCode({ appId: APP, secret: "s", code: "c" }).catch((e) => e);
    expect(e3).toBeInstanceOf(Error);
    expect(isBrokerAuthExpired(e3)).toBe(false);
    expect(String(e3.message)).toContain("Invalid app id");
  });
});

describe("fetchFyersTradeBook / fetchFyersProfileId", () => {
  it("GETs /tradebook with Authorization '<appId>:<token>', version 3 and the named User-Agent", async () => {
    stub(json(200, { s: "ok", code: 200, message: "", tradeBook: [row()] }));
    const rows = await fetchFyersTradeBook(APP, "day-token");
    expect(rows).toHaveLength(1);
    expect(calls[0].url).toBe("https://api-t1.fyers.in/api/v3/tradebook");
    expect(calls[0].init.method).toBe("GET");
    const h = hdr(calls[0]);
    expect(h["authorization"]).toBe(`${APP}:day-token`);
    expect(h["version"]).toBe("3");
    expect(h["user-agent"]).toBe(`Vyuha/${pkg.version}`);
    expect(h["x-forwarded-for"]).toBeUndefined();
  });

  it("an empty book is []; token codes -8/-15/-16/-17 and HTTP 401 are typed; a 500 or a bare 403 are plain Errors", async () => {
    stub(json(200, { s: "ok", code: 200, message: "", tradeBook: [] }));
    expect(await fetchFyersTradeBook(APP, "t")).toEqual([]);
    for (const code of [-8, -15, -16, -17]) {
      stub(json(200, { s: "error", code, message: "token" }));
      const e = await fetchFyersTradeBook(APP, "t").catch((x) => x);
      expect(isBrokerAuthExpired(e), String(code)).toBe(true);
      expect((e as BrokerAuthExpired).need).toBe("needsAuthCode");
    }
    stub(json(401, undefined));
    expect(isBrokerAuthExpired(await fetchFyersTradeBook(APP, "t").catch((x) => x))).toBe(true);
    stub(json(500, { s: "error", code: -1, message: "boom" }));
    const e5 = await fetchFyersTradeBook(APP, "t").catch((x) => x);
    expect(isBrokerAuthExpired(e5)).toBe(false);
    expect(e5.message).toContain("boom");
    stub(new Response("", { status: 403 }));
    const e6 = await fetchFyersTradeBook(APP, "t").catch((x) => x);
    expect(isBrokerAuthExpired(e6)).toBe(false);
    expect(e6.message).toContain("HTTP 403");
  });

  it("profile: data.fy_id, or null when Fyers states none; a token error is typed", async () => {
    stub(json(200, { s: "ok", code: 200, data: { fy_id: "XY12345", name: "x" } }));
    expect(await fetchFyersProfileId(APP, "t")).toBe("XY12345");
    expect(calls[0].url).toBe("https://api-t1.fyers.in/api/v3/profile");
    expect(hdr(calls[0])["authorization"]).toBe(`${APP}:t`);
    stub(json(200, { s: "ok", code: 200, data: {} }));
    expect(await fetchFyersProfileId(APP, "t")).toBeNull();
    stub(json(200, { s: "error", code: -15, message: "invalid token" }));
    expect(isBrokerAuthExpired(await fetchFyersProfileId(APP, "t").catch((x) => x))).toBe(true);
  });

  it("fyersImportSource reads the trade book with the saved token and normalises it", async () => {
    stub(json(200, { s: "ok", code: 200, tradeBook: [row(), row({ side: -1, tradePrice: 810, orderDateTime: "04-Oct-2026 14:01:00" })] }));
    const src = fyersImportSource({ appId: APP, accessToken: "tok" });
    expect(src).toMatchObject({ id: "fyers-api", broker: "fyers", kind: "api" });
    const trades = await src.fetchTrades({});
    expect(trades).toHaveLength(1);
    expect(trades[0].grossPnl).toBe(95);
  });
});

describe("normalizeFyersTrades", () => {
  it("aggregates a same-day round trip per symbol + product, every fill kept, equity named bare", () => {
    const { trades, refused, notes, clientId } = normalizeFyersTrades(
      [row(), row({ tradedQty: 5, tradePrice: 801 }), row({ side: -1, tradedQty: 15, tradePrice: 810, orderDateTime: "04-Oct-2026 14:45:01" })],
      TODAY,
    );
    expect(refused).toBe(0);
    expect(notes).toEqual([]);
    expect(clientId).toBe("XY12345");
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t).toMatchObject({
      broker: "fyers",
      tradingsymbol: "SBIN",
      buyQty: 15,
      sellQty: 15,
      buyValue: 12010,
      sellValue: 12150,
      avgBuyPrice: 800.67,
      grossPnl: 140,
      buyDate: TODAY,
      sellDate: TODAY,
      entryTime: "10:15",
      exitTime: "14:45",
      productHint: "delivery",
      exchangeHint: "NSE",
      sourceFile: "fyers-api",
    });
    expect(t.executions).toHaveLength(3);
    expect(t.importNotes).toEqual([`Fyers pull: ${PULL_UNVERIFIED_LABEL}.`, "Fyers series EQ (NSE:SBIN-EQ).", `${FYERS_NUVAMA_EQUITY_UNVERIFIED}.`]);
  });

  it("a derivative keeps the Fyers FILE's compact name and carries only the unverified label", () => {
    const { trades } = normalizeFyersTrades(
      [row({ symbol: "NSE:NIFTY24NOV22500CE", segment: 11, productType: "INTRADAY", tradedQty: 75, tradePrice: 120 })],
      TODAY,
    );
    expect(trades[0].tradingsymbol).toBe("NIFTY24NOV22500CE");
    expect(trades[0].productHint).toBe("intraday");
    expect(trades[0].importNotes).toEqual([`Fyers pull: ${PULL_UNVERIFIED_LABEL}.`]);
    // Bought only — open, undated sale, no P&L.
    expect(trades[0]).toMatchObject({ buyQty: 75, sellQty: 0, sellDate: null, grossPnl: 0 });
  });

  it("refuses — never coerces — a fill with no readable side, quantity, price or symbol", () => {
    const { trades, refused, notes } = normalizeFyersTrades(
      [
        row({ side: 0 }),
        row({ side: "x" as unknown as number }),
        row({ tradedQty: "abc" }),
        row({ tradedQty: 0 }),
        row({ tradedQty: 2.5 }),
        row({ tradePrice: undefined }),
        row({ tradePrice: "" }),
        row({ tradePrice: -5 }),
        row({ symbol: "WHAT:IS THIS" }),
        row({ tradedQty: "4", tradePrice: "800.00" }),
      ],
      TODAY,
    );
    expect(refused).toBe(9);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ buyQty: 4, avgBuyPrice: 800 });
    expect(notes.join(" ")).toContain("1 fill's symbol could not be read");
  });

  it("skips an NDIR mirror row only on the file's FULL three-part signature (review R11)", () => {
    const mirror = row({ side: -1, productType: "-", exchangeOrderNo: "NDIR123456", orderDateTime: "04-Oct-2026 12:00:00 AM" });
    const { trades, refused, notes } = normalizeFyersTrades([row(), mirror], TODAY);
    expect(refused).toBe(0);
    expect(trades).toHaveLength(1);
    expect(trades[0].sellQty).toBe(0);
    expect(notes[0]).toContain("1 mirror row was skipped");
    // Two signs out of three is a real fill — kept.
    const twoSigns = row({ side: -1, productType: "-", exchangeOrderNo: "1100000099999", orderDateTime: "04-Oct-2026 12:00:00 AM" });
    const kept = normalizeFyersTrades([row(), twoSigns], TODAY);
    expect(kept.trades.reduce((s, t) => s + t.sellQty, 0)).toBe(10);
    expect(kept.notes).toEqual([]);
  });

  it("maps products like the Fyers file (CNC/MARGIN → delivery, INTRADAY → intraday) plus MTF; exchanges 10/11/12", () => {
    const by = (over: Partial<FyersTradeRow>) => normalizeFyersTrades([row(over)], TODAY).trades[0];
    expect(by({ productType: "MARGIN" }).productHint).toBe("delivery");
    expect(by({ productType: "MTF" }).productHint).toBe("mtf");
    expect(by({ productType: "BO" }).productHint).toBeNull();
    expect(by({ exchange: 11, symbol: "MCX:CRUDEOIL26OCTFUT", segment: 20 }).exchangeHint).toBe("MCX");
    expect(by({ exchange: 12, symbol: "BSE:SBIN-A" }).exchangeHint).toBe("BSE");
    expect(by({ exchange: 99 }).exchangeHint).toBeNull();
  });

  it("reads HH:MM only from the pinned orderDateTime shapes — anything else is null", () => {
    const t = (s: string) => normalizeFyersTrades([row({ orderDateTime: s })], TODAY).trades[0].entryTime;
    expect(t("04-Oct-2026 09:05:33")).toBe("09:05");
    expect(t("2026-10-04 13:20:00")).toBe("13:20");
    expect(t("2026-10-04T13:20:00")).toBe("13:20");
    expect(t("04/10/2026 01:20:00 PM")).toBeNull();
    expect(t("1696405533")).toBeNull();
    expect(t("")).toBeNull();
  });

  it("clientId is the rows' own when they agree, null when they disagree or none states one", () => {
    expect(normalizeFyersTrades([row(), row({ clientId: "ZZ999" })], TODAY).clientId).toBeNull();
    expect(normalizeFyersTrades([row({ clientId: undefined })], TODAY).clientId).toBeNull();
  });

  it("a sale with no buy in today's book is dated today with an unknown basis (Angel One's QS-AO shape)", () => {
    const { trades } = normalizeFyersTrades([row({ side: -1 })], TODAY);
    expect(trades[0]).toMatchObject({ sellDate: TODAY, buyDate: null, basisUnknown: true, grossPnl: 0 });
  });

  it("seam D-C6-2 — segment 12 (CD) and a CDS/BCD/NCDEX prefix are refused, counted and named; segment 20 (COM, MCX) is kept", () => {
    const { trades, refused, notes } = normalizeFyersTrades(
      [
        row({ symbol: "NSE:USDINR26OCTFUT", productType: "MARGIN", exchange: 10, segment: 12 }),
        row({ symbol: "NSE:USDINR26OCTFUT", productType: "MARGIN", exchange: 10, segment: "12" }),
        row({ symbol: "BCD:USDINR26OCTFUT", productType: "MARGIN", exchange: 12, segment: undefined }),
        row({ symbol: "NCDEX:CASTOR26OCTFUT", productType: "MARGIN", exchange: 10, segment: undefined }),
        row({ symbol: "MCX:CRUDEOIL26OCTFUT", productType: "MARGIN", exchange: 11, segment: 20 }),
      ],
      TODAY,
    );
    expect(refused).toBe(4);
    expect(trades.map((t) => [t.tradingsymbol, t.exchangeHint])).toEqual([["CRUDEOIL26OCTFUT", "MCX"]]);
    expect(notes).toEqual(["4 currency / NCDEX fills were refused: currency / NCDEX contracts are not imported by this pull (no charge profile covers them)."]);
  });
});

describe("toParsedFile", () => {
  it("always carries the documented-not-verified warning (owner Q4), plus refusals and notes", () => {
    const pf = toParsedFile([], 2, ["a note"]);
    expect(pf).toMatchObject({ sourceId: "fyers-api", broker: "fyers", format: "api" });
    expect(pf.warnings[0]).toContain(PULL_UNVERIFIED_LABEL);
    expect(pf.warnings.join(" ")).toContain("2 fills had no readable side");
    expect(pf.warnings).toContain("a note");
  });

  it("BrokerAuthExpired is a real Error subclass", () => {
    const e = new BrokerAuthExpired("fyers", "needsAuthCode", "x");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BrokerAuthExpired");
    const foreign = Object.assign(new Error("y"), { name: "BrokerAuthExpired", need: "needsLogin", broker: "nuvama" });
    expect(isBrokerAuthExpired(foreign)).toBe(true);
    expect(isBrokerAuthExpired(new Error("z"))).toBe(false);
    expect(isBrokerAuthExpired(Object.assign(new Error("w"), { name: "BrokerAuthExpired", need: "other" }))).toBe(false);
  });
});
