import { afterEach, describe, expect, it, vi } from "vitest";
import * as nuvama from "@/lib/import/api/nuvama";
import {
  NUVAMA_EQ_BASE,
  NUVAMA_LOGIN_BASE,
  extractNuvamaRequestId,
  fetchNuvamaTrades,
  normalizeNuvamaTrades,
  nuvamaImportSource,
  nuvamaLogin,
  nuvamaLoginUrl,
  toParsedFile,
  type NuvamaSession,
  type NuvamaTradeRow,
} from "@/lib/import/api/nuvama";
import { BrokerAuthExpired, isBrokerAuthExpired } from "@/lib/import/api/broker-auth-error";
import { PULL_UNVERIFIED_LABEL } from "@/lib/domain/broker-pull-disclosure";
import { FYERS_NUVAMA_EQUITY_UNVERIFIED } from "@/lib/import/parsers/fyers-tradebook";
import { nuvamaTradingsymbol } from "@/lib/import/pull-symbols";

/**
 * Nuvama APIConnect native pull (v4.7.0 wave C6). DOCUMENTED, NOT YET VERIFIED
 * WITH A REAL ACCOUNT (owner Q4): URLs, headers, bodies and the status-code
 * rules are Nuvama's docs + SDK 2.0.12 (R10 §2, N-A1…N-S1). The two SDK
 * behaviours Vyuha does NOT copy — X-Forwarded-For and a hard-coded AppIdKey —
 * are pinned absent here.
 */

const TODAY = "2026-10-04";
const KEY = "nuvama-key";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
function stub(...responses: Response[]) {
  calls = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return responses[Math.min(i++, responses.length - 1)].clone();
  });
}
const hdr = (c: Call) => Object.fromEntries(Object.entries((c.init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));

afterEach(() => vi.unstubAllGlobals());

const VENDOR = (headers: Record<string, string> = {}) => res(200, { msg: "vendor-session", success: false }, headers);
const LOGINDATA = (headers: Record<string, string> = {}, accs: Record<string, string> = { eqAccID: "EQ123", coAccID: "CO456" }) =>
  res(200, { appID: "a", data: { type: "t", auth: "jsession-auth", lgnData: { accTyp: "COMEQ", accs } } }, headers);

const SESSION = (): NuvamaSession => ({ auth: "jsession-auth", sourceToken: "vendor-session", userId: "EQ123", appIdKey: null, accTyp: "COMEQ" });

const row = (over: Partial<NuvamaTradeRow> = {}): NuvamaTradeRow => ({
  trdSym: "SBIN-EQ",
  sym: "3045_NSE",
  exc: "NSE",
  trsTyp: "B",
  fldQty: "10",
  flQty: "10",
  flPrc: "800.50",
  prdCode: "CNC",
  flDt: "04-Oct-2026",
  flTim: "10:15:33",
  ...over,
});

describe("read-only by surface", () => {
  it("the module exports no order, modify or funds capability", () => {
    expect(Object.keys(nuvama).sort()).toEqual([
      "NUVAMA_EQ_BASE",
      "NUVAMA_LOGIN_BASE",
      "extractNuvamaRequestId",
      "fetchNuvamaTrades",
      "normalizeNuvamaTrades",
      "nuvamaImportSource",
      "nuvamaLogin",
      "nuvamaLoginUrl",
      "toParsedFile",
    ]);
    expect(NUVAMA_LOGIN_BASE).toBe("https://nc.nuvamawealth.com/edelmw-login/login/");
    expect(NUVAMA_EQ_BASE).toBe("https://nc.nuvamawealth.com/edelmw-eq/eq/");
  });
});

describe("login helpers", () => {
  it("nuvamaLoginUrl is the documented browser login (N-A1)", () => {
    expect(nuvamaLoginUrl("k y")).toBe("https://www.nuvamawealth.com/api-connect/login?api_key=k%20y");
  });

  it("extractNuvamaRequestId: the bare value, or requestId / reqId / request_id BY NAME; else null", () => {
    expect(extractNuvamaRequestId("abc123XYZ")).toBe("abc123XYZ");
    expect(extractNuvamaRequestId("https://127.0.0.1/?requestId=r-111")).toBe("r-111");
    expect(extractNuvamaRequestId("https://127.0.0.1/?state=x&reqId=r-222")).toBe("r-222");
    expect(extractNuvamaRequestId("request_id=r-333&x=1")).toBe("r-333");
    expect(extractNuvamaRequestId("https://127.0.0.1/?token=zzz&state=x")).toBeNull();
    expect(extractNuvamaRequestId("two words")).toBeNull();
    expect(extractNuvamaRequestId("")).toBeNull();
  });
});

describe("nuvamaLogin", () => {
  it("loginvendor {pwd} with Source → logindata {reqId} with SourceToken; no X-Forwarded-For, no AppIdKey of Vyuha's own", async () => {
    stub(VENDOR(), LOGINDATA());
    const s = await nuvamaLogin({ apiKey: KEY, apiSecret: "the-secret", reqId: "req-1" });
    expect(s).toEqual({ auth: "jsession-auth", sourceToken: "vendor-session", userId: "EQ123", appIdKey: null, accTyp: "COMEQ" });
    expect(calls).toHaveLength(2);

    expect(calls[0].url).toBe("https://nc.nuvamawealth.com/edelmw-login/login/accounts/loginvendor/nuvama-key/");
    expect(calls[0].init.method).toBe("POST");
    const h0 = hdr(calls[0]);
    expect(h0["source"]).toBe(KEY);
    expect(h0["content-type"]).toBe("application/json");
    expect(h0["appidkey"]).toBeUndefined();
    expect(h0["authorization"]).toBeUndefined();
    expect(h0["sourcetoken"]).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ pwd: "the-secret" });

    expect(calls[1].url).toBe("https://nc.nuvamawealth.com/edelmw-login/login/accounts/logindata/");
    expect(calls[1].init.method).toBe("POST");
    const h1 = hdr(calls[1]);
    expect(h1["sourcetoken"]).toBe("vendor-session");
    expect(h1["appidkey"]).toBeUndefined();
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ reqId: "req-1" });
    for (const c of calls) expect(hdr(c)["x-forwarded-for"]).toBeUndefined();
  });

  it("an AppIdKey a RESPONSE carries is echoed on the next call and returned with the session (review R11')", async () => {
    stub(VENDOR({ AppIdKey: "server-key-1" }), LOGINDATA({ AppIdKey: "server-key-2" }));
    const s = await nuvamaLogin({ apiKey: KEY, apiSecret: "x", reqId: "r" });
    expect(hdr(calls[0])["appidkey"]).toBeUndefined();
    expect(hdr(calls[1])["appidkey"]).toBe("server-key-1");
    expect(s.appIdKey).toBe("server-key-2");
  });

  it("userId falls back to coAccID when eqAccID is absent (N-A11)", async () => {
    stub(VENDOR(), LOGINDATA({}, { coAccID: "CO456" }));
    expect((await nuvamaLogin({ apiKey: KEY, apiSecret: "x", reqId: "r" })).userId).toBe("CO456");
  });

  it("logindata 222 (request id expired) and 401 are BrokerAuthExpired('needsLogin'); a bad secret is a plain Error", async () => {
    stub(VENDOR(), res(222, { msg: "Request id expired" }));
    const e1 = await nuvamaLogin({ apiKey: KEY, apiSecret: "x", reqId: "r" }).catch((x) => x);
    expect(isBrokerAuthExpired(e1)).toBe(true);
    expect([(e1 as BrokerAuthExpired).broker, (e1 as BrokerAuthExpired).need]).toEqual(["nuvama", "needsLogin"]);

    stub(VENDOR(), res(401, { error: { errCd: "EGN0011", errMsg: "Session Expired" } }));
    expect(isBrokerAuthExpired(await nuvamaLogin({ apiKey: KEY, apiSecret: "x", reqId: "r" }).catch((x) => x))).toBe(true);

    stub(res(400, { error: { errMsg: "Invalid vendor credentials" } }));
    const e3 = await nuvamaLogin({ apiKey: KEY, apiSecret: "x", reqId: "r" }).catch((x) => x);
    expect(isBrokerAuthExpired(e3)).toBe(false);
    expect(e3.message).toContain("Invalid vendor credentials");
    expect(calls).toHaveLength(1);

    stub(VENDOR(), res(200, { data: { auth: "", lgnData: { accs: {} } } }));
    const e4 = await nuvamaLogin({ apiKey: KEY, apiSecret: "x", reqId: "r" }).catch((x) => x);
    expect(isBrokerAuthExpired(e4)).toBe(false);
  });
});

describe("fetchNuvamaTrades — status read explicitly, never res.ok", () => {
  it("GETs tradebook/v1/{userId}/ with Authorization, Source, SourceToken → data.trade[] (singular)", async () => {
    stub(res(200, { appID: "a", data: { trade: [row(), row()] } }));
    const rows = await fetchNuvamaTrades(SESSION(), KEY);
    expect(rows).toHaveLength(2);
    expect(calls[0].url).toBe("https://nc.nuvamawealth.com/edelmw-eq/eq/tradebook/v1/EQ123/");
    expect(calls[0].init.method).toBe("GET");
    const h = hdr(calls[0]);
    expect(h["authorization"]).toBe("jsession-auth");
    expect(h["source"]).toBe(KEY);
    expect(h["sourcetoken"]).toBe("vendor-session");
    expect(h["appidkey"]).toBeUndefined();
    expect(h["x-forwarded-for"]).toBeUndefined();
  });

  it("222 is an EMPTY book (ETRD0002) — zero trades, not an error", async () => {
    stub(res(222, { error: { errCd: "ETRD0002", errMsg: "Seems like there are no trades in your trade book." } }));
    expect(await fetchNuvamaTrades(SESSION(), KEY)).toEqual([]);
  });

  it("401, or a body naming EGN0011 / Session Expired, is BrokerAuthExpired('needsLogin')", async () => {
    for (const r of [
      res(401, { config: {}, error: { actCd: "52", errCd: "EGN0011", errMsg: "Session Expired" } }),
      res(200, { error: { errCd: "EGN0011", errMsg: "Session Expired" } }),
    ]) {
      stub(r);
      const e = await fetchNuvamaTrades(SESSION(), KEY).catch((x) => x);
      expect(isBrokerAuthExpired(e)).toBe(true);
      expect((e as BrokerAuthExpired).need).toBe("needsLogin");
    }
  });

  it("any other status throws a plain Error (a 403 names the static-IP rule)", async () => {
    stub(res(403, { error: { errMsg: "Forbidden" } }));
    const e = await fetchNuvamaTrades(SESSION(), KEY).catch((x) => x);
    expect(isBrokerAuthExpired(e)).toBe(false);
    expect(e.message).toContain("static IP");
    stub(res(500, "oops"));
    await expect(fetchNuvamaTrades(SESSION(), KEY)).rejects.toThrow(/HTTP 500/);
  });

  it("echoes the session's AppIdKey, and a fresh one from the response replaces it in place", async () => {
    const s = { ...SESSION(), appIdKey: "cached-key" };
    stub(res(200, { data: { trade: [] } }, { AppIdKey: "rotated-key" }));
    await fetchNuvamaTrades(s, KEY);
    expect(hdr(calls[0])["appidkey"]).toBe("cached-key");
    expect(s.appIdKey).toBe("rotated-key");
  });

  it("nuvamaImportSource pulls with the cached session", async () => {
    stub(res(200, { data: { trade: [row(), row({ trsTyp: "S", flPrc: "810", flTim: "14:00:00" })] } }));
    const src = nuvamaImportSource({ apiKey: KEY, session: SESSION() });
    expect(src).toMatchObject({ id: "nuvama-api", broker: "nuvama", kind: "api" });
    const trades = await src.fetchTrades({});
    expect(trades).toHaveLength(1);
    expect(trades[0].grossPnl).toBe(95);
  });
});

describe("normalizeNuvamaTrades", () => {
  it("aggregates per symbol + product from STRING fields; equity carries both labels", () => {
    const { trades, refused, notes } = normalizeNuvamaTrades(
      [row(), row({ fldQty: "5", flPrc: "801" }), row({ trsTyp: "S", fldQty: "15", flPrc: "810", flTim: "04-Oct-2026 14:45:01" })],
      TODAY,
    );
    expect(refused).toBe(0);
    expect(notes).toEqual([]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      broker: "nuvama",
      tradingsymbol: "SBIN",
      isin: null,
      buyQty: 15,
      sellQty: 15,
      buyValue: 12010,
      sellValue: 12150,
      grossPnl: 140,
      buyDate: TODAY,
      sellDate: TODAY,
      entryTime: "10:15",
      exitTime: "14:45",
      productHint: "delivery",
      exchangeHint: "NSE",
      sourceFile: "nuvama-api",
    });
    expect(trades[0].importNotes).toEqual([`Nuvama pull: ${PULL_UNVERIFIED_LABEL}.`, `${FYERS_NUVAMA_EQUITY_UNVERIFIED}.`]);
  });

  it("an ISIN-shaped trdSym sets isin and resolves through the bundled chain (N-S1)", () => {
    const r = row({ trdSym: "INE062A01020" });
    const { trades } = normalizeNuvamaTrades([r], TODAY);
    expect(trades[0].isin).toBe("INE062A01020");
    expect(trades[0].tradingsymbol).toBe(nuvamaTradingsymbol({ trdSym: "INE062A01020", sym: r.sym, exc: r.exc }));
  });

  it("a derivative is named through nuvamaInstrument and carries only the unverified label", () => {
    const r = row({ trdSym: "NIFTY-OPT-22Sep2026-PE-23550-NSE", exc: "NFO", prdCode: "NRML", fldQty: "75", flPrc: "120.5" });
    const { trades } = normalizeNuvamaTrades([r], TODAY);
    expect(trades[0].tradingsymbol).toMatch(/^OPT NIFTY /);
    expect(trades[0].tradingsymbol).toBe(nuvamaTradingsymbol({ trdSym: r.trdSym!, exc: "NFO" }));
    expect(trades[0].productHint).toBeNull();
    expect(trades[0].importNotes).toEqual([`Nuvama pull: ${PULL_UNVERIFIED_LABEL}.`]);
  });

  it("refuses — never coerces — and reads qty from fldQty ONLY (no flQty fallback)", () => {
    const { trades, refused, notes } = normalizeNuvamaTrades(
      [
        row({ trsTyp: "" }),
        row({ fldQty: "", flQty: "10" }),
        row({ fldQty: "ten" }),
        row({ fldQty: "0" }),
        row({ flPrc: "" }),
        row({ flPrc: "N/A" }),
        row({ trdSym: "", sym: "" }),
        row({ fldQty: "3", flPrc: "1,000.25" }),
      ],
      TODAY,
    );
    expect(refused).toBe(7);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ buyQty: 3, avgBuyPrice: 1000.25 });
    expect(notes.join(" ")).toContain("1 fill named no instrument");
  });

  it("maps CNC/MTF/MIS/INTRADAY; flTim outside a 24-hour HH:MM:SS is null", () => {
    const by = (over: Partial<NuvamaTradeRow>) => normalizeNuvamaTrades([row(over)], TODAY).trades[0];
    expect(by({ prdCode: "MTF" }).productHint).toBe("mtf");
    expect(by({ prdCode: "MIS" }).productHint).toBe("intraday");
    expect(by({ prdCode: "INTRADAY" }).productHint).toBe("intraday");
    expect(by({ exc: "BSE" }).exchangeHint).toBe("BSE");
    expect(by({ flTim: "1696405533000" }).entryTime).toBeNull();
    expect(by({ flTim: "10:15 AM" }).entryTime).toBeNull();
  });

  it("seam D-C6-2 — CDS / BCD / NCDEX rows are refused, counted and named in the notes; MCX is kept", () => {
    const fut = { opTyp: "FUT", dpExpDt: "28Oct2026", prdCode: "NRML" };
    const { trades, refused, notes } = normalizeNuvamaTrades(
      [
        row({ ...fut, trdSym: "USDINR26OCTFUT", sym: "USDINR", exc: "CDS", fldQty: "1000", flPrc: "88.10" }),
        row({ ...fut, trdSym: "USDINR26OCTFUT", sym: "USDINR", exc: "BCD", fldQty: "1000", flPrc: "88.10" }),
        row({ ...fut, trdSym: "CASTOR26OCTFUT", sym: "CASTOR", exc: "NCDEX", fldQty: "5", flPrc: "6000" }),
        // the report grammar's own exchange token, with no `exc` stated
        row({ trdSym: "USDINR-FUT-28Oct2026-CDS", sym: "", exc: "", fldQty: "1000", flPrc: "88.10" }),
        row({ ...fut, trdSym: "CRUDEOIL26OCTFUT", sym: "CRUDEOIL", exc: "MCX", fldQty: "1", flPrc: "6000" }),
      ],
      TODAY,
    );
    expect(refused).toBe(4);
    expect(trades.map((t) => [t.tradingsymbol, t.exchangeHint])).toEqual([["FUT CRUDEOIL 28 Oct 2026", "MCX"]]);
    expect(notes).toContain("4 currency / NCDEX fills were refused: currency / NCDEX contracts are not imported by this pull (no charge profile covers them).");
    expect(nuvamaTradingsymbol({ trdSym: "USDINR26OCTFUT", sym: "USDINR", exc: "CDS", opTyp: "FUT", dpExpDt: "28Oct2026" })).toBeNull();
  });
});

describe("toParsedFile", () => {
  it("carries the documented-not-verified warning (owner Q4)", () => {
    const pf = toParsedFile([], 0, ["n"]);
    expect(pf).toMatchObject({ sourceId: "nuvama-api", broker: "nuvama", format: "api" });
    expect(pf.warnings[0]).toContain(PULL_UNVERIFIED_LABEL);
    expect(pf.warnings).toContain("n");
    expect(new BrokerAuthExpired("nuvama", "needsLogin", "m").need).toBe("needsLogin");
  });
});
