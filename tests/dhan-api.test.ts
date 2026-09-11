import { describe, it, expect, vi, afterEach } from "vitest";
import * as dhan from "@/lib/import/api/dhan";
import {
  normalizeDhanPositions, productHintOf, exchangeOf, toParsedFile,
  canonicalDerivativeName, markOf,
  dhanAuthUrl, mintDhanAccessToken, resolveDhanAccessToken, jwtLooksUnexpired,
  fetchDhanPositions, dhanTotpEnrolled, DHAN_TOTP_ACK_VERSION,
  type DhanPositionRow,
} from "@/lib/import/api/dhan";
import { dedupHash } from "@/lib/import/dedup";
import { classify } from "@/lib/engine/classify";
import { totp } from "@/lib/totp";
import { todayIstIso } from "@/lib/domain/trading-day";

const row = (p: Partial<DhanPositionRow>): DhanPositionRow => ({
  tradingSymbol: "TCS",
  positionType: "LONG",
  exchangeSegment: "NSE_EQ",
  productType: "CNC",
  buyAvg: 0, buyQty: 0, sellAvg: 0, sellQty: 0, netQty: 0,
  ...p,
});

describe("productHintOf — the whole reason this integration exists", () => {
  it("maps MTF, which no Dhan FILE can express", () => {
    expect(productHintOf("MTF")).toBe("mtf");
    expect(productHintOf("mtf")).toBe("mtf");
  });

  it("maps the products a file could already infer", () => {
    expect(productHintOf("CNC")).toBe("delivery");
    expect(productHintOf("INTRADAY")).toBe("intraday");
  });

  it("treats cover and bracket orders as intraday — they cannot be anything else", () => {
    expect(productHintOf("CO")).toBe("intraday");
    expect(productHintOf("BO")).toBe("intraday");
  });

  it("returns null for MARGIN and unknown types, leaving the symbol to decide", () => {
    // MARGIN is the F&O carry-forward product; the classifier reads the segment
    // off the symbol, and an equity hint would only fight it.
    expect(productHintOf("MARGIN")).toBeNull();
    expect(productHintOf("SOMETHING_NEW")).toBeNull();
  });
});

describe("exchangeOf", () => {
  it("maps the segment prefixes Dhan actually sends", () => {
    expect(exchangeOf("NSE_EQ")).toBe("NSE");
    expect(exchangeOf("NSE_FNO")).toBe("NSE");
    expect(exchangeOf("BSE_EQ")).toBe("BSE");
    expect(exchangeOf("MCX_COMM")).toBe("MCX");
  });

  it("returns null rather than guessing on an unknown segment", () => {
    expect(exchangeOf("XYZ_ABC")).toBeNull();
    expect(exchangeOf("")).toBeNull();
  });
});

describe("normalizeDhanPositions", () => {
  const TODAY = "2026-07-29";

  it("marks an MTF position as MTF, with a note saying it was STATED not inferred", () => {
    const [t] = normalizeDhanPositions(
      [row({ tradingSymbol: "TATASTEEL", productType: "MTF", buyQty: 500, buyAvg: 160, netQty: 500 })],
      TODAY,
    );
    expect(t.productHint).toBe("mtf");
    expect(t.buyValue).toBe(80000);
    expect(t.importNotes?.join(" ")).toMatch(/stated by the Dhan API as MTF/i);
  });

  it("treats a same-day round trip as CLOSED and dates both legs today", () => {
    const [t] = normalizeDhanPositions(
      [row({ productType: "INTRADAY", buyQty: 100, buyAvg: 3300, sellQty: 100, sellAvg: 3345, netQty: 0, realizedProfit: 4500 })],
      TODAY,
    );
    expect(t.buyDate).toBe(TODAY);
    expect(t.sellDate).toBe(TODAY);
    expect(t.grossPnl).toBe(4500);
    expect(t.productHint).toBe("intraday");
  });

  it("leaves an open position without a sell date", () => {
    const [t] = normalizeDhanPositions(
      [row({ productType: "CNC", buyQty: 40, buyAvg: 3345.8, netQty: 40, unrealizedProfit: 6122 })],
      TODAY,
    );
    expect(t.sellDate).toBeNull();
    expect(t.buyDate).toBe(TODAY);
    expect(t.unrealisedPnl).toBe(6122);
    expect(t.grossPnl).toBe(0);
  });

  it("prefers the BROKER'S realised profit over our own subtraction", () => {
    // Dhan nets charges and averages its own way; its number is authoritative.
    const [t] = normalizeDhanPositions(
      [row({ buyQty: 10, buyAvg: 100, sellQty: 10, sellAvg: 110, netQty: 0, realizedProfit: 97.5 })],
      TODAY,
    );
    expect(t.grossPnl).toBe(97.5); // not the naive 100
  });

  it("falls back to the legs when realisedProfit is absent", () => {
    const [t] = normalizeDhanPositions(
      [row({ buyQty: 10, buyAvg: 100, sellQty: 10, sellAvg: 110, netQty: 0 })],
      TODAY,
    );
    expect(t.grossPnl).toBe(100);
  });

  it("skips rows where nothing was traded", () => {
    expect(normalizeDhanPositions([row({ buyQty: 0, sellQty: 0 })], TODAY)).toHaveLength(0);
  });

  it("never sets an execution time — the endpoint carries only aggregates", () => {
    const out = normalizeDhanPositions([row({ buyQty: 1, buyAvg: 10, netQty: 1 })], TODAY);
    expect(out[0].entryTime).toBeNull();
    expect(out[0].exitTime).toBeNull();
  });

  it("handles an empty book without throwing", () => {
    expect(normalizeDhanPositions([], TODAY)).toEqual([]);
  });
});

// Values in this block are from a REAL /v2/positions payload (2026-08-26, the
// first live pull that ever returned F&O fills). That pull found the defect
// these tests pin: the API's hyphenated symbols fell through parseInstrumentName
// to the equity branch, so ten option positions were charged equity STT.
describe("canonicalDerivativeName — F&O names built from Dhan's STATED drv* fields", () => {
  it("builds the canonical OPT name for a stock option (real row)", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "BANKINDIA-Sep2026-155-CE", exchangeSegment: "NSE_FNO", productType: "MARGIN",
        drvExpiryDate: "2026-09-29 14:30:00", drvOptionType: "CALL", drvStrikePrice: 155.0,
      })),
    ).toBe("OPT BANKINDIA 29 Sep 2026 155 CE");
  });

  it("builds the canonical OPT name for a BSE index option (real row)", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "SENSEX-Aug2026-77300-PE", exchangeSegment: "BSE_FNO", productType: "INTRADAY",
        drvExpiryDate: "2026-08-27 15:30:00", drvOptionType: "PUT", drvStrikePrice: 77300.0,
      })),
    ).toBe("OPT SENSEX 27 Aug 2026 77300 PE");
  });

  it("builds a FUT name when the row has an expiry but no option type", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "NIFTY-Sep2026-FUT", exchangeSegment: "NSE_FNO", productType: "MARGIN",
        drvExpiryDate: "2026-09-29 14:30:00", drvOptionType: "NA", drvStrikePrice: 0,
      })),
    ).toBe("FUT NIFTY 29 Sep 2026");
  });

  it("keeps a fractional strike fractional and an integer strike bare", () => {
    const base = {
      exchangeSegment: "NSE_FNO", drvExpiryDate: "2026-09-29 14:30:00", drvOptionType: "CALL" as const,
    };
    expect(
      canonicalDerivativeName(row({ ...base, tradingSymbol: "X-CE", drvStrikePrice: 88.5 })),
    ).toBe("OPT X 29 Sep 2026 88.5 CE");
    expect(
      canonicalDerivativeName(row({ ...base, tradingSymbol: "X-CE", drvStrikePrice: 78200.0 })),
    ).toBe("OPT X 29 Sep 2026 78200 CE");
  });

  it("returns null for an equity row — Dhan's sentinels are 0001-01-01 / NA / 0 (real row)", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "GAJA", exchangeSegment: "NSE_EQ", productType: "INTRADAY",
        drvExpiryDate: "0001-01-01", drvOptionType: "NA", drvStrikePrice: 0.0,
      })),
    ).toBeNull();
  });

  it("returns null rather than guessing when an F&O row states no usable expiry", () => {
    expect(
      canonicalDerivativeName(row({
        tradingSymbol: "BANKINDIA-Sep2026-155-CE", exchangeSegment: "NSE_FNO",
        drvExpiryDate: "0001-01-01", drvOptionType: "CALL", drvStrikePrice: 155,
      })),
    ).toBeNull();
  });

  it("the canonical name actually classifies as an option with the right exchange", () => {
    const name = canonicalDerivativeName(row({
      tradingSymbol: "SENSEX-Aug2026-78200-CE", exchangeSegment: "BSE_FNO",
      drvExpiryDate: "2026-08-27 15:30:00", drvOptionType: "CALL", drvStrikePrice: 78200,
    }))!;
    const cls = classify({ tradingsymbol: name, exchangeHint: exchangeOf("BSE_FNO"), productHint: null });
    expect(cls.instrumentType).toBe("option");
    expect(cls.segment).toBe("index_option");
    expect(cls.exchange).toBe("BSE");
    expect(cls.expiry).toBe("2026-08-27");
    expect(cls.strike).toBe(78200);
    expect(cls.optionType).toBe("CE");
  });
});

describe("markOf — the broker's own mark for an open position", () => {
  it("reproduces Dhan's displayed LTP from entry ± unrealised/qty (real rows)", () => {
    // Dhan's UI showed LTP 1.30 / 2.90 / 38.25 for these exact positions.
    expect(markOf(row({ buyAvg: 1.7, buyQty: 5200, netQty: 5200, unrealizedProfit: -2080 }))).toBe(1.3);
    expect(markOf(row({ buyAvg: 2.85, buyQty: 1275, netQty: 1275, unrealizedProfit: 63.75 }))).toBe(2.9);
    expect(markOf(row({ buyAvg: 41.2, buyQty: 175, netQty: 175, unrealizedProfit: -516.25 }))).toBe(38.25);
  });

  it("derives a short position's mark from the SELL side", () => {
    expect(markOf(row({ sellAvg: 50, sellQty: 100, netQty: -100, unrealizedProfit: 500 }))).toBe(45);
  });

  it("returns null for a closed position and when no unrealised figure is stated", () => {
    expect(markOf(row({ buyQty: 100, sellQty: 100, netQty: 0, unrealizedProfit: 0 }))).toBeNull();
    expect(markOf(row({ buyQty: 100, netQty: 100, unrealizedProfit: undefined }))).toBeNull();
  });
});

describe("normalizeDhanPositions — derivatives (the 2026-08-26 defect, end to end)", () => {
  const TODAY = "2026-08-26";

  it("commits an option under its canonical name with the broker's mark", () => {
    const [t] = normalizeDhanPositions(
      [row({
        tradingSymbol: "BANKINDIA-Sep2026-155-CE", exchangeSegment: "NSE_FNO", productType: "MARGIN",
        buyAvg: 1.7, buyQty: 5200, netQty: 5200, unrealizedProfit: -2080,
        drvExpiryDate: "2026-09-29 14:30:00", drvOptionType: "CALL", drvStrikePrice: 155,
      })],
      TODAY,
    );
    expect(t.tradingsymbol).toBe("OPT BANKINDIA 29 Sep 2026 155 CE");
    expect(t.closingPrice).toBe(1.3);
    expect(t.unrealisedPnl).toBe(-2080);
    expect(t.importNotes).toBeNull();
  });

  it("keeps the raw name and SAYS SO when an F&O row's stated facts are incomplete", () => {
    const [t] = normalizeDhanPositions(
      [row({
        tradingSymbol: "MYSTERY-THING", exchangeSegment: "NSE_FNO", productType: "MARGIN",
        buyAvg: 10, buyQty: 1, netQty: 1,
        drvExpiryDate: "0001-01-01", drvOptionType: "NA", drvStrikePrice: 0,
      })],
      TODAY,
    );
    expect(t.tradingsymbol).toBe("MYSTERY-THING");
    expect(t.importNotes?.join(" ")).toMatch(/stated no usable expiry\/strike/i);
  });

  it("leaves an equity symbol untouched", () => {
    const [t] = normalizeDhanPositions(
      [row({ tradingSymbol: "GAJA", exchangeSegment: "NSE_EQ", productType: "INTRADAY",
        buyAvg: 176.41, buyQty: 850, sellAvg: 173.84, sellQty: 850, netQty: 0,
        drvExpiryDate: "0001-01-01", drvOptionType: "NA", drvStrikePrice: 0 })],
      TODAY,
    );
    expect(t.tradingsymbol).toBe("GAJA");
    expect(t.closingPrice).toBeNull();
  });
});

describe("toParsedFile", () => {
  const TODAY = "2026-07-29";

  it("says plainly when MTF was found, and that it needed no confirming", () => {
    const trades = normalizeDhanPositions(
      [row({ productType: "MTF", buyQty: 500, buyAvg: 160, netQty: 500 })],
      TODAY,
    );
    const p = toParsedFile(trades);
    expect(p.broker).toBe("dhan");
    expect(p.warnings.join(" ")).toMatch(/1 position is MTF according to Dhan itself/i);
    expect(p.warnings.join(" ")).toMatch(/need no confirmation/i);
  });

  it("says so when there is no MTF, rather than staying silent", () => {
    const trades = normalizeDhanPositions([row({ productType: "CNC", buyQty: 1, buyAvg: 10, netQty: 1 })], TODAY);
    expect(toParsedFile(trades).warnings.join(" ")).toMatch(/No MTF positions/i);
  });

  it("explains an empty pull instead of looking broken", () => {
    expect(toParsedFile([]).warnings.join(" ")).toMatch(/current trading day/i);
  });
});

// ---------------------------------------------------------------------------
// PIN + TOTP auth (v3.6.0, decision #2). A valid base32 secret and a fake JWT
// whose exp claim we control; fetch is stubbed so every request is inspected.
// ---------------------------------------------------------------------------

const SECRET = "JBSWY3DPEHPK3PXP"; // valid base32, the docs' example secret
const CLIENT = "1000000009";
const PIN = "123456";

/** A structurally valid JWT with a chosen exp (seconds). */
const fakeJwt = (expSeconds: number) =>
  ["e30", Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url"), "sig"].join(".");

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

describe("dhanAuthUrl — the generateAccessToken request shape", () => {
  it("targets auth.dhan.co with clientId, pin and the code as query params", () => {
    const url = new URL(dhanAuthUrl(CLIENT, PIN, "654321"));
    expect(url.origin).toBe("https://auth.dhan.co");
    expect(url.pathname).toBe("/app/generateAccessToken");
    expect(url.searchParams.get("dhanClientId")).toBe(CLIENT);
    expect(url.searchParams.get("pin")).toBe(PIN);
    expect(url.searchParams.get("totp")).toBe("654321");
  });
});

describe("jwtLooksUnexpired", () => {
  it("trusts only a decodable exp in the future", () => {
    const now = Date.now();
    expect(jwtLooksUnexpired(fakeJwt(Math.floor(now / 1000) + 3600), now)).toBe(true);
    expect(jwtLooksUnexpired(fakeJwt(Math.floor(now / 1000) - 60), now)).toBe(false);
    expect(jwtLooksUnexpired("not-a-jwt", now)).toBe(false);
    expect(jwtLooksUnexpired("", now)).toBe(false);
  });

  // An `exp` above 1e11 cannot be seconds (that is the year 5138) — it is an
  // issuer stating milliseconds. The old `exp * 1000` read a millisecond exp
  // that was already in the PAST as alive for ~50,000 years, so a dead token
  // was reused forever and the mint path never ran.
  it("reads a MILLISECOND exp correctly in both directions (red-on-revert: the past one read as alive)", () => {
    const now = Date.now();
    expect(jwtLooksUnexpired(fakeJwt((Math.floor(now / 1000) + 3600) * 1000), now)).toBe(true);
    expect(jwtLooksUnexpired(fakeJwt((Math.floor(now / 1000) - 60) * 1000), now)).toBe(false);
  });
});

describe("jwtExpiresAt — the exp claim as ISO, for the mode label", () => {
  it("normalises seconds and milliseconds to the same instant, and refuses to guess otherwise", () => {
    const expSec = 1_788_600_000; // 2026-09-04T08:00:00Z
    const iso = new Date(expSec * 1000).toISOString();
    expect(dhan.jwtExpiresAt(fakeJwt(expSec))).toBe(iso);
    expect(dhan.jwtExpiresAt(fakeJwt(expSec * 1000))).toBe(iso);
    expect(dhan.jwtExpiresAt("not-a-jwt")).toBeNull();
    expect(dhan.jwtExpiresAt(["e30", Buffer.from("{}").toString("base64url"), "x"].join("."))).toBeNull();
  });
});

describe("mintDhanAccessToken", () => {
  it("POSTs to generateAccessToken with a freshly minted 6-digit code and returns the token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { accessToken: "minted-jwt", expiryTime: "2026-09-03T09:00:00" });
    });
    const token = await mintDhanAccessToken({ clientId: CLIENT, pin: PIN, totpSecret: SECRET });
    expect(token).toBe("minted-jwt");
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(u.host).toBe("auth.dhan.co");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(u.searchParams.get("dhanClientId")).toBe(CLIENT);
    expect(u.searchParams.get("pin")).toBe(PIN);
    // The code is minted at call time from the enrolled secret (RFC 6238);
    // it must be a 6-digit code, and it must be OUR totp()'s output for the
    // same secret at (roughly) the same instant — allow the adjacent step.
    const sent = u.searchParams.get("totp")!;
    expect(sent).toMatch(/^\d{6}$/);
    const nowSec = Math.floor(Date.now() / 1000);
    expect([totp(SECRET, { nowSeconds: nowSec }), totp(SECRET, { nowSeconds: nowSec - 30 })]).toContain(sent);
  });

  it("names the step on a PIN rejection", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(400, { errorMessage: "Invalid pin" }));
    await expect(mintDhanAccessToken({ clientId: CLIENT, pin: PIN, totpSecret: SECRET })).rejects.toThrow(
      /generateAccessToken: Invalid pin.*PIN rejected/i,
    );
  });

  it("hints at clock drift on a TOTP rejection — the Angel One lesson", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(400, { errorMessage: "Invalid totp" }));
    await expect(mintDhanAccessToken({ clientId: CLIENT, pin: PIN, totpSecret: SECRET })).rejects.toThrow(
      /clock.*drifted clock produces valid-looking wrong codes/i,
    );
  });

  it("names the unverified API-toggle possibility on a generic 400 — never a cryptic failure", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(400, { errorMessage: "Bad request" }));
    await expect(mintDhanAccessToken({ clientId: CLIENT, pin: PIN, totpSecret: SECRET })).rejects.toThrow(
      /Trading APIs are enabled.*unverified/i,
    );
  });

  it("refuses a 200 with no accessToken rather than passing undefined onward, echoing the body", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, { something: "else" }));
    await expect(mintDhanAccessToken({ clientId: CLIENT, pin: PIN, totpSecret: SECRET })).rejects.toThrow(
      /no accessToken in the response.*something/i,
    );
  });

  // LIVE-VERIFIED 2026-09-02 on the owner's account: Dhan reports auth
  // failures as HTTP 200 with {"message": "...", "status": "error"}.
  it('parses the error-in-200 envelope — "Invalid TOTP" gets the clock-drift hint', async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, { message: "Invalid TOTP", status: "error" }));
    await expect(mintDhanAccessToken({ clientId: CLIENT, pin: PIN, totpSecret: SECRET })).rejects.toThrow(
      /Invalid TOTP.*drifted clock produces valid-looking wrong codes/i,
    );
  });

  it("names the 2-minute mint rate limit and says the cache clears it (live-verified envelope)", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, { message: "Token can be generated once every 2 minutes.", status: "error" }),
    );
    await expect(mintDhanAccessToken({ clientId: CLIENT, pin: PIN, totpSecret: SECRET })).rejects.toThrow(
      /once every 2 minutes.*reuses the day's token/i,
    );
  });
});

describe("resolveDhanAccessToken — reuse-first ordering (Dhan mints at most one token per 2 minutes, live-verified 2026-09-02)", () => {
  it("REUSES a stored unexpired token without calling the mint endpoint — preview → commit must not double-mint", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      hosts.push(new URL(url).host);
      return jsonResponse(200, { accessToken: "minted-jwt" });
    });
    const stored = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const r = await resolveDhanAccessToken({ clientId: CLIENT, pin: PIN, totpSecret: SECRET, accessToken: stored });
    expect(r).toEqual({ token: stored, minted: false });
    expect(hosts).toEqual([]); // red-on-revert: mint-first ordering calls auth.dhan.co here
  });

  it("mints (and says so, for the caller to persist) when the stored token is expired", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      hosts.push(new URL(url).host);
      return jsonResponse(200, { accessToken: "minted-jwt" });
    });
    const r = await resolveDhanAccessToken({
      clientId: CLIENT, pin: PIN, totpSecret: SECRET,
      accessToken: fakeJwt(Math.floor(Date.now() / 1000) - 60),
    });
    expect(r).toEqual({ token: "minted-jwt", minted: true });
    expect(hosts).toContain("auth.dhan.co");
  });

  it("mints when no token is stored at all", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, { accessToken: "minted-jwt" }));
    await expect(resolveDhanAccessToken({ clientId: CLIENT, pin: PIN, totpSecret: SECRET })).resolves.toEqual({
      token: "minted-jwt",
      minted: true,
    });
  });

  it("refuses with guidance naming BOTH ways out when the mint fails and the stored token is expired", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(400, { errorMessage: "Invalid totp" }));
    await expect(
      resolveDhanAccessToken({
        clientId: CLIENT, pin: PIN, totpSecret: SECRET,
        accessToken: fakeJwt(Math.floor(Date.now() / 1000) - 60),
      }),
    ).rejects.toThrow(/No unexpired stored token.*fix the PIN\/TOTP secret.*paste a fresh 24-hour token/i);
  });

  it("uses the pasted token untouched in legacy mode (no PIN/secret) — even unreadable, and never calls the mint endpoint", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      hosts.push(new URL(url).host);
      return jsonResponse(200, {});
    });
    // Non-JWT garbage passes through untouched: Dhan's own 401 (with the
    // 24-hour hint) is the honest judge in paste-only mode.
    await expect(resolveDhanAccessToken({ clientId: CLIENT, accessToken: "pasted-anything" })).resolves.toEqual({
      token: "pasted-anything",
      minted: false,
    });
    expect(hosts).toEqual([]);
  });

  it("refuses plainly when there is nothing to auth with", async () => {
    await expect(resolveDhanAccessToken({ clientId: CLIENT })).rejects.toThrow(/reconnect Dhan/i);
  });
});

describe("dhanTotpEnrolled — pin+totp WITHOUT the recorded consent is NOT enrolled", () => {
  it("requires all three: pin, totpSecret and the stamped totpAckVersion", () => {
    expect(dhanTotpEnrolled({ pin: PIN, totpSecret: SECRET, totpAckVersion: 1 })).toBe(true);
    // The legacy shape (saved before the server-side consent gate existed):
    // credentials present, consent never recorded → not enrolled. The mint
    // path is skipped and auto-pull calls the connection ineligible.
    expect(dhanTotpEnrolled({ pin: PIN, totpSecret: SECRET })).toBe(false);
    expect(dhanTotpEnrolled({ pin: PIN, totpAckVersion: 1 })).toBe(false);
    expect(dhanTotpEnrolled({ totpSecret: SECRET, totpAckVersion: 1 })).toBe(false);
    expect(dhanTotpEnrolled(null)).toBe(false);
    expect(dhanTotpEnrolled(undefined)).toBe(false);
  });

  it("accepts any FUTURE ack version but never a zero/garbage one", () => {
    expect(dhanTotpEnrolled({ pin: PIN, totpSecret: SECRET, totpAckVersion: 2 })).toBe(true);
    expect(dhanTotpEnrolled({ pin: PIN, totpSecret: SECRET, totpAckVersion: 0 })).toBe(false);
    expect(dhanTotpEnrolled({ pin: PIN, totpSecret: SECRET, totpAckVersion: NaN })).toBe(false);
  });

  // The required version is a PARAMETER defaulting to DHAN_TOTP_ACK_VERSION
  // (v3.8.0 fix wave, finder 3 item 4). The check used to be the literal
  // `>= 1`, so bumping the constant to force re-consent left every v1 blob
  // enrolled and the re-consent silently never happened.
  it("a v1 blob is NOT enrolled once the required ack version is 2", () => {
    const v1 = { pin: PIN, totpSecret: SECRET, totpAckVersion: 1 };
    expect(dhanTotpEnrolled(v1, 2)).toBe(false);
    expect(dhanTotpEnrolled({ ...v1, totpAckVersion: 2 }, 2)).toBe(true);
    // The default is the shipped constant, and the route imports the same one.
    expect(dhanTotpEnrolled(v1)).toBe(true);
    expect(DHAN_TOTP_ACK_VERSION).toBe(1);
  });
});

describe("fetchDhanPositions in TOTP mode — mint feeds the positions call (red-on-revert)", () => {
  it("mints first, then sends the MINTED token as the access-token header", async () => {
    const calls: Array<{ host: string; path: string; headers?: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ host: u.host, path: u.pathname, headers: init?.headers as Record<string, string> });
      if (u.host === "auth.dhan.co") return jsonResponse(200, { accessToken: "minted-jwt" });
      return jsonResponse(200, [] as DhanPositionRow[]);
    });
    await fetchDhanPositions({ clientId: CLIENT, pin: PIN, totpSecret: SECRET });
    expect(calls.map((c) => c.host)).toEqual(["auth.dhan.co", "api.dhan.co"]);
    expect(calls[1]!.path).toBe("/v2/positions");
    expect(calls[1]!.headers?.["access-token"]).toBe("minted-jwt");
  });
});

describe("retry-on-401 — a REVOKED but unexpired-looking token mints once and retries once (owner ruling 2026-09-04)", () => {
  const stored = () => fakeJwt(Math.floor(Date.now() / 1000) + 3600);

  /** fetch that answers api.dhan.co per call from `apiStatuses` and mints "fresh-jwt" at auth.dhan.co. */
  function stub(apiStatuses: number[]) {
    const calls: Array<{ host: string; token?: string }> = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const token = (init?.headers as Record<string, string> | undefined)?.["access-token"];
      calls.push({ host: u.host, token });
      if (u.host === "auth.dhan.co") return jsonResponse(200, { accessToken: "fresh-jwt" });
      const status = apiStatuses[n++] ?? 200;
      return status === 200 ? jsonResponse(200, [] as DhanPositionRow[]) : jsonResponse(status, { errorMessage: "Invalid token" });
    });
    return calls;
  }

  it("401 then 200: the reused token is dropped, one mint, the retry carries the fresh token, onMinted persists it", async () => {
    const calls = stub([401, 200]);
    const minted: string[] = [];
    const creds = { clientId: CLIENT, pin: PIN, totpSecret: SECRET, accessToken: stored() };
    const rows = await fetchDhanPositions(creds, (t) => minted.push(t));
    expect(rows).toEqual([]);
    // Red-on-revert: the old dhanGet threw on the first 401 — one api call, no mint.
    expect(calls.map((c) => c.host)).toEqual(["api.dhan.co", "auth.dhan.co", "api.dhan.co"]);
    expect(calls[2]!.token).toBe("fresh-jwt");
    expect(minted).toEqual(["fresh-jwt"]);
    // The in-process cache is updated too, so a second call this pull reuses the fresh token.
    expect(creds.accessToken).toBe("fresh-jwt");
  });

  it("the first request really did carry the stored (revoked) token", async () => {
    const calls = stub([401, 200]);
    const token = stored();
    await fetchDhanPositions({ clientId: CLIENT, pin: PIN, totpSecret: SECRET, accessToken: token });
    expect(calls[0]!.token).toBe(token);
  });

  it("401 twice: exactly one mint, then the existing hint surfaces — never a loop", async () => {
    const calls = stub([401, 401]);
    await expect(fetchDhanPositions({ clientId: CLIENT, pin: PIN, totpSecret: SECRET, accessToken: stored() })).rejects.toThrow(
      /Dhan API: Invalid token.*access token expired or wrong/i,
    );
    expect(calls.map((c) => c.host)).toEqual(["api.dhan.co", "auth.dhan.co", "api.dhan.co"]);
  });

  // A 403 is NOT an authentication verdict by itself (v3.8.0 fix wave, finder
  // 3 item 3). Dhan answers a PERMISSIONS problem — a segment or data API the
  // account is not subscribed to — with 403 too, and the old
  // `status === 401 || status === 403` retry spent the one mint allowed per 2
  // minutes on a token that was never the problem, overwrote the stored token
  // with it, and then told the user their token had expired. So a 403 mints
  // only when the BODY names one of Dhan's authentication error codes.
  it("a bare permissions 403 does NOT mint: one call, no auth.dhan.co, and the message does not blame the token", async () => {
    const calls: Array<{ host: string }> = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      calls.push({ host: u.host });
      if (u.host === "auth.dhan.co") return jsonResponse(200, { accessToken: "fresh-jwt" });
      return jsonResponse(403, { errorMessage: "This data API is not subscribed for this account" });
    });
    await expect(fetchDhanPositions({ clientId: CLIENT, pin: PIN, totpSecret: SECRET, accessToken: stored() })).rejects.toThrow(
      /not subscribed[\s\S]*forbidden without naming an authentication failure/i,
    );
    // Red on revert: the old rejected-on-403 rule made this
    // ["api.dhan.co", "auth.dhan.co", "api.dhan.co"] — a burnt mint.
    expect(calls.map((c) => c.host)).toEqual(["api.dhan.co"]);
  });

  it("a 403 whose body names an auth failure (DH-901) still mints once and retries", async () => {
    const calls: Array<{ host: string }> = [];
    let n = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      calls.push({ host: u.host });
      if (u.host === "auth.dhan.co") return jsonResponse(200, { accessToken: "fresh-jwt" });
      return n++ === 0
        ? jsonResponse(403, { errorCode: "DH-901", errorType: "Invalid_Authentication", errorMessage: "Invalid token" })
        : jsonResponse(200, [] as DhanPositionRow[]);
    });
    await fetchDhanPositions({ clientId: CLIENT, pin: PIN, totpSecret: SECRET, accessToken: stored() });
    expect(calls.map((c) => c.host)).toEqual(["api.dhan.co", "auth.dhan.co", "api.dhan.co"]);
  });

  // DH-902 is NOT an authentication code. Dhan's annexure calls it "Invalid
  // Access": the account is not subscribed to the Data APIs, or has no access
  // to the Trading APIs. Minting cannot fix a permissions verdict — it just
  // spends the one mint allowed per 2 minutes and then blames a good token.
  it("a 403 naming DH-902 (Invalid_Access) does NOT mint — it is a PERMISSIONS refusal", async () => {
    const calls: Array<{ host: string }> = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      calls.push({ host: u.host });
      if (u.host === "auth.dhan.co") return jsonResponse(200, { accessToken: "fresh-jwt" });
      return jsonResponse(403, {
        errorCode: "DH-902",
        errorType: "Invalid_Access",
        errorMessage: "Client not subscribed to Data APIs",
      });
    });
    let err: Error | undefined;
    try {
      await fetchDhanPositions({ clientId: CLIENT, pin: PIN, totpSecret: SECRET, accessToken: stored() });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // Red-on-revert: `/^DH-?90[12]$/` made this ["api.dhan.co", "auth.dhan.co",
    // "api.dhan.co"] — the burnt mint this whole rule exists to prevent.
    expect(calls.map((c) => c.host)).toEqual(["api.dhan.co"]);
    // …and it must read as a permissions problem, never as token advice.
    expect(err!.message).toMatch(/forbidden without naming an authentication failure/i);
    expect(err!.message).toMatch(/enabled for the data\/segment being pulled/i);
    expect(err!.message, "DH-902 must not blame the token").not.toMatch(/access token expired or wrong/i);
  });

  it("an errorType of Invalid_Access alone (no code) is still not an auth failure", async () => {
    const calls: Array<{ host: string }> = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      calls.push({ host: u.host });
      if (u.host === "auth.dhan.co") return jsonResponse(200, { accessToken: "fresh-jwt" });
      return jsonResponse(403, { errorType: "Invalid_Access", errorMessage: "No access to Trading APIs" });
    });
    await expect(fetchDhanPositions({ clientId: CLIENT, pin: PIN, totpSecret: SECRET, accessToken: stored() })).rejects.toThrow(
      /forbidden without naming an authentication failure/i,
    );
    // Red-on-revert: `invalid[_ -]?(authentication|access)` matched this too.
    expect(calls.map((c) => c.host)).toEqual(["api.dhan.co"]);
  });

  it("paste-only mode NEVER mints: a 401 surfaces the hint with no auth.dhan.co call", async () => {
    const calls = stub([401, 200]);
    await expect(fetchDhanPositions({ clientId: CLIENT, accessToken: stored() })).rejects.toThrow(/access token expired or wrong/i);
    expect(calls.map((c) => c.host)).toEqual(["api.dhan.co"]);
  });

  it("a 401 on a token minted in THIS call is not retried (the mint itself is the retry)", async () => {
    const calls = stub([401, 200]);
    await expect(fetchDhanPositions({ clientId: CLIENT, pin: PIN, totpSecret: SECRET })).rejects.toThrow(/access token expired or wrong/i);
    expect(calls.map((c) => c.host)).toEqual(["auth.dhan.co", "api.dhan.co"]);
  });

  it("when the re-mint itself fails, the message names BOTH the rejection and the mint failure", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      if (u.host === "auth.dhan.co") return jsonResponse(200, { message: "Invalid TOTP", status: "error" });
      n++;
      return jsonResponse(401, { errorMessage: "Invalid token" });
    });
    await expect(fetchDhanPositions({ clientId: CLIENT, pin: PIN, totpSecret: SECRET, accessToken: stored() })).rejects.toThrow(
      /Invalid token.*Re-minting after that rejection also failed.*Invalid TOTP/i,
    );
    expect(n).toBe(1);
  });
});

describe("read-only by surface", () => {
  it("the module exports no order, funds or modification capability", () => {
    // The whole security argument for storing a PERMANENT second factor is
    // that this code path CANNOT trade. Enforced by the module surface — this
    // pin makes adding an order method a CI failure, not a review comment.
    expect(Object.keys(dhan).sort()).toEqual([
      "DHAN_MAX_PULL_RANGE_DAYS",
      "DHAN_TOTP_ACK_VERSION",
      "DHAN_TRADES_MAX_PAGES",
      "canonicalDerivativeName",
      "catchUpRange",
      "dhanAuthUrl",
      "dhanImportSource",
      "dhanTotpEnrolled",
      "exchangeOf",
      "fetchDhanHoldings",
      "fetchDhanPositions",
      "fetchDhanTrades",
      "jwtExpiresAt",
      "jwtLooksUnexpired",
      "markOf",
      "mintDhanAccessToken",
      "normalizeDhanPositions",
      "normalizeDhanTrades",
      "productHintOf",
      "resolveDhanAccessToken",
      "toParsedFile",
    ]);
  });
});

// ---------------------------------------------------------------------------
// R6 (v4.2.1) — the CATCH-UP pull. `/v2/positions` is the current day's book,
// so a connection last pulled five days ago silently lost four days: the pull
// button fetched today, stamped lastPullAt, and the gap never came back. Dhan
// publishes a trade-history endpoint (GET /v2/trades/{from}/{to}/{page},
// dhanhq.co/docs/v2/statements/, verified 2026-09-09) and this is it wired in.
// ---------------------------------------------------------------------------

describe("catchUpRange — what a pull should ask for, given the last one", () => {
  const TODAY = "2026-09-09";

  it("asks from the IST DAY of the last pull, inclusive, to today", () => {
    expect(dhan.catchUpRange("2026-09-04T10:00:00Z", TODAY)).toEqual({ from: "2026-09-04", to: TODAY });
    // 19:00Z is already the next day in India — the one +5:30 definition.
    expect(dhan.catchUpRange("2026-09-04T19:00:00Z", TODAY)).toEqual({ from: "2026-09-05", to: TODAY });
  });

  it("returns null when there is no gap to fetch", () => {
    expect(dhan.catchUpRange(null, TODAY)).toBeNull();
    expect(dhan.catchUpRange(undefined, TODAY)).toBeNull();
    expect(dhan.catchUpRange("not-a-date", TODAY)).toBeNull();
    // Already pulled today: today's book is what /positions is for.
    expect(dhan.catchUpRange("2026-09-09T03:00:00Z", TODAY)).toBeNull();
  });

  it("never asks for a window wider than the 90-day cap", () => {
    expect(dhan.DHAN_MAX_PULL_RANGE_DAYS).toBe(90);
    // A connection last pulled a year ago is clamped to the cap, not refused:
    // the rest of that history is a file import, which is what files are for.
    // C-6: …and the clamp NAMES what it left out — the last-pull day up to the
    // day before the floor — rather than dropping it without a word.
    expect(dhan.catchUpRange("2025-09-09T10:00:00Z", TODAY)).toEqual({
      from: "2026-06-11",
      to: TODAY,
      unfetched: { from: "2025-09-09", to: "2026-06-10" },
    });
    const span =
      (Date.parse(TODAY) - Date.parse(dhan.catchUpRange("2025-09-09T10:00:00Z", TODAY)!.from)) / 86_400_000;
    expect(span).toBe(90);
  });
});

describe("fetchTrades({from,to}) — the paged trade history", () => {
  const stored = () => fakeJwt(Math.floor(Date.now() / 1000) + 3600);
  const creds = () => ({ clientId: CLIENT, accessToken: stored() });

  const trade = (p: Partial<dhan.DhanTradeRow>): dhan.DhanTradeRow => ({
    exchangeTradeId: "TR-1",
    orderId: "OR-1",
    transactionType: "SELL",
    exchangeSegment: "NSE_EQ",
    productType: "CNC",
    tradingSymbol: "TCS",
    tradedQuantity: 10,
    tradedPrice: 3500.5,
    exchangeTime: "2026-09-07 10:15:00",
    ...p,
  });

  /** Stub api.dhan.co: `/positions` answers `positions`, `/trades/{f}/{t}/{p}`
   *  answers `pages[p] ?? []`. Every pathname is recorded in order. */
  function stub(pages: dhan.DhanTradeRow[][], positions: DhanPositionRow[] = []) {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      paths.push(u.pathname);
      if (u.pathname === "/v2/positions") return jsonResponse(200, positions);
      const m = /^\/v2\/trades\/[\d-]+\/[\d-]+\/(\d+)$/.exec(u.pathname);
      if (m) return jsonResponse(200, pages[Number(m[1])] ?? []);
      return jsonResponse(404, { errorMessage: `unexpected path ${u.pathname}` });
    });
    return paths;
  }

  it("requests page 0, then 1, and stops at the first empty page", async () => {
    const paths = stub([[trade({ exchangeTradeId: "A" })], []]);
    await dhan.dhanImportSource(creds()).fetchTrades({ from: "2026-09-05", to: "2026-09-09" });
    expect(paths.filter((p) => p.includes("/trades/"))).toEqual([
      "/v2/trades/2026-09-05/2026-09-09/0",
      "/v2/trades/2026-09-05/2026-09-09/1",
    ]);
    // Today's book still comes from /positions, exactly as before.
    expect(paths).toContain("/v2/positions");
  });

  it("makes NO /trades request at all when no range is given", async () => {
    const paths = stub([[trade({})]], []);
    const out = await dhan.dhanImportSource(creds()).fetchTrades({});
    expect(paths).toEqual(["/v2/positions"]);
    expect(out).toEqual([]);
  });

  it("stops at the page cap rather than looping on an endpoint that never empties", async () => {
    expect(dhan.DHAN_TRADES_MAX_PAGES).toBe(50);
    const never = new Proxy([] as dhan.DhanTradeRow[][], {
      get: (_t, k) => (typeof k === "string" && /^\d+$/.test(k) ? [trade({ exchangeTradeId: `T${k}` })] : undefined),
    });
    const paths = stub(never);
    await dhan.dhanImportSource(creds()).fetchTrades({ from: "2026-06-11", to: "2026-09-09" });
    expect(paths.filter((p) => p.includes("/trades/"))).toHaveLength(dhan.DHAN_TRADES_MAX_PAGES);
  });

  it("C-6: the page cap is REPORTED — truncated, with the oldest and newest fill date actually read", async () => {
    const never = new Proxy([] as dhan.DhanTradeRow[][], {
      get: (_t, k) =>
        typeof k === "string" && /^\d+$/.test(k)
          ? [trade({ exchangeTradeId: `T${k}`, exchangeTime: `2026-07-${String(10 + (Number(k) % 20)).padStart(2, "0")} 10:00:00` })]
          : undefined,
    });
    stub(never);
    const reads: dhan.DhanHistoryRead[] = [];
    await dhan
      .dhanImportSource(creds())
      .fetchTrades({ from: "2026-06-11", to: "2026-09-09", onHistory: (r) => reads.push(r) });
    expect(reads).toEqual([{ pages: 50, truncated: true, oldest: "2026-07-10", newest: "2026-07-29" }]);

    const pf = toParsedFile([], { from: "2026-06-11", to: "2026-09-09" }, reads[0]);
    const line =
      "Truncated: this pull stopped at the 50-page limit of Dhan's trade history, so fills between 2026-06-11 and 2026-09-09 may be missing. The fills it read are dated 2026-07-10 to 2026-07-29. To be sure every fill is in, import a Dhan tradebook for 2026-06-11 to 2026-09-09.";
    expect(pf.warnings).toContain(line);
    expect(pf.unfetched).toEqual([{ from: "2026-06-11", to: "2026-09-09", reason: "page-cap", message: line }]);
  });

  it("C-6: a walk that reaches an empty page is NOT truncated, and states nothing extra", async () => {
    stub([[trade({ exchangeTradeId: "A", exchangeTime: "2026-09-07 10:00:00" })], []]);
    const reads: dhan.DhanHistoryRead[] = [];
    await dhan
      .dhanImportSource(creds())
      .fetchTrades({ from: "2026-09-05", to: "2026-09-09", onHistory: (r) => reads.push(r) });
    expect(reads).toEqual([{ pages: 2, truncated: false, oldest: "2026-09-07", newest: "2026-09-07" }]);
    const pf = toParsedFile([], { from: "2026-09-05", to: "2026-09-09" }, reads[0]);
    expect(pf.unfetched).toEqual([]);
    expect(pf.warnings.some((w) => /Truncated/.test(w))).toBe(false);
  });

  it("maps a SELL fill to a sell execution with its quantity, price and STATED charges", async () => {
    stub([
      [
        trade({
          exchangeTradeId: "S-1",
          transactionType: "SELL",
          tradingSymbol: "TCS",
          tradedQuantity: 4,
          tradedPrice: 3500,
          isin: "INE467B01029",
          brokerageCharges: 20,
          serviceTax: 3.6,
          stt: 14,
          sebiTax: 0.14,
          exchangeTransactionCharges: 4.2,
          stampDuty: 0,
          exchangeTime: "2026-09-07 10:15:00",
        }),
      ],
      [],
    ]);
    const out = await dhan.dhanImportSource(creds()).fetchTrades({ from: "2026-09-05", to: "2026-09-09" });
    expect(out).toHaveLength(1);
    const t = out[0]!;
    expect(t.broker).toBe("dhan");
    expect(t.tradingsymbol).toBe("TCS");
    expect(t.isin).toBe("INE467B01029");
    expect(t.sellQty).toBe(4);
    expect(t.avgSellPrice).toBe(3500);
    expect(t.sellValue).toBe(14000);
    expect(t.buyQty).toBe(0);
    expect(t.sellDate).toBe("2026-09-07");
    expect(t.executions).toEqual([{ side: "sell", qty: 4, price: 3500, date: "2026-09-07", time: "10:15" }]);
    // Charges the broker ACTUALLY levied are stated per fill here — they are
    // stored as truth, never recomputed (AGENTS.md, reportedCharges).
    expect(t.reportedCharges).toMatchObject({
      brokerage: 20,
      gst: 3.6,
      sttCtt: 14,
      sebi: 0.14,
      exchangeTxn: 4.2,
      stampDuty: 0,
      total: 41.94,
    });
    // A sell with no purchase in the window has an unknowable cost basis.
    expect(t.basisUnknown).toBe(true);
    expect(t.grossPnl).toBe(0);
  });

  it("pairs a buy and a later sell into ONE closed position across days", async () => {
    stub([
      [
        trade({ exchangeTradeId: "B", transactionType: "BUY", tradedQuantity: 5, tradedPrice: 100, exchangeTime: "2026-09-05 09:30:00" }),
        trade({ exchangeTradeId: "S", transactionType: "SELL", tradedQuantity: 5, tradedPrice: 110, exchangeTime: "2026-09-07 14:00:00" }),
      ],
      [],
    ]);
    const out = await dhan.dhanImportSource(creds()).fetchTrades({ from: "2026-09-05", to: "2026-09-09" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      buyQty: 5, sellQty: 5, buyDate: "2026-09-05", sellDate: "2026-09-07", grossPnl: 50, basisUnknown: false,
    });
  });

  it("dedupes a fill by exchangeTradeId when it comes back on two pages", async () => {
    const dup = trade({ exchangeTradeId: "SAME", transactionType: "BUY", tradedQuantity: 3, tradedPrice: 200 });
    stub([[dup], [{ ...dup }], []]);
    const out = await dhan.dhanImportSource(creds()).fetchTrades({ from: "2026-09-05", to: "2026-09-09" });
    expect(out).toHaveLength(1);
    // Red on revert: without the dedupe this is 6 shares for ₹1,200.
    expect(out[0]!.buyQty).toBe(3);
    expect(out[0]!.buyValue).toBe(600);
  });

  it("counts a fill ONCE when the history and today's positions both state it", async () => {
    const today = todayIstIso();
    const position: DhanPositionRow = {
      tradingSymbol: "INFY", positionType: "LONG", exchangeSegment: "NSE_EQ", productType: "MTF",
      buyAvg: 1500, buyQty: 2, sellAvg: 0, sellQty: 0, netQty: 2,
    };
    stub(
      [
        [
          trade({
            exchangeTradeId: "TODAY-1", transactionType: "BUY", tradingSymbol: "INFY", productType: "MTF",
            tradedQuantity: 2, tradedPrice: 1500, exchangeTime: `${today} 09:20:00`,
          }),
        ],
        [],
      ],
      [position],
    );
    const out = await dhan.dhanImportSource(creds()).fetchTrades({ from: "2026-06-11", to: today });
    const infy = out.filter((t) => t.tradingsymbol === "INFY");
    expect(infy).toHaveLength(1);
    expect(infy[0]!.buyQty).toBe(2);
    // …and the surviving row is the POSITIONS one — the only source that
    // states MTF outright, which is why this integration exists.
    expect(infy[0]!.productHint).toBe("mtf");
  });

  it("names an F&O fill from Dhan's own drv* fields, never from the symbol's shape", async () => {
    stub([
      [
        trade({
          exchangeTradeId: "F-1", transactionType: "BUY", exchangeSegment: "NSE_FNO", productType: "MARGIN",
          tradingSymbol: "NIFTY-Sep2026-25000-CE", tradedQuantity: 75, tradedPrice: 120,
          drvExpiryDate: "2026-09-24", drvOptionType: "CALL", drvStrikePrice: 25000,
          exchangeTime: "2026-09-07 11:00:00",
        }),
      ],
      [],
    ]);
    const out = await dhan.dhanImportSource(creds()).fetchTrades({ from: "2026-09-05", to: "2026-09-09" });
    expect(out[0]!.tradingsymbol).toBe("OPT NIFTY 24 Sep 2026 25000 CE");
    expect(out[0]!.exchangeHint).toBe("NSE");
  });

  it("refuses a fill with no readable side, quantity, price or date rather than coercing it", async () => {
    stub([
      [
        trade({ exchangeTradeId: "X1", transactionType: "", tradedQuantity: 5, tradedPrice: 10 }),
        trade({ exchangeTradeId: "X2", tradedQuantity: 0 }),
        trade({ exchangeTradeId: "X3", tradedPrice: 0 }),
        trade({ exchangeTradeId: "X4", exchangeTime: undefined, createTime: undefined }),
      ],
      [],
    ]);
    const out = await dhan.dhanImportSource(creds()).fetchTrades({ from: "2026-09-05", to: "2026-09-09" });
    expect(out).toEqual([]);
    expect(dhan.normalizeDhanTrades([]).refused).toBe(0);
  });
});

describe("toParsedFile — a catch-up pull says which days it covered", () => {
  it("names the window, and keeps the no-range warnings byte-identical", () => {
    const withRange = toParsedFile([], { from: "2026-09-04", to: "2026-09-09" });
    // C-4 (fix wave C): the reason given is the one that is true of EVERY
    // range catchUpRange returns (`day < today`). "Older than the previous
    // trading day" was false on every routine next-day pull.
    expect(withRange.warnings[0]).toBe(
      "Catch-up pull: fills from 2026-09-04 to 2026-09-09 were read from Dhan's trade history, because the last pull ran before today. Today's book still comes from /v2/positions, and re-pulled fills are de-duplicated on commit.",
    );
    // Without a range NOTHING about the wording changes — the daily pull is
    // the same pull it always was.
    expect(toParsedFile([]).warnings).toEqual(withRange.warnings.slice(1));
    expect(toParsedFile([], null).warnings).toEqual(withRange.warnings.slice(1));
  });

  it("C-4: a routine next-day pull is described truthfully — no trading-day claim at all", () => {
    const range = dhan.catchUpRange("2026-09-08T10:00:00Z", "2026-09-09")!;
    expect(range).toEqual({ from: "2026-09-08", to: "2026-09-09" });
    const first = toParsedFile([], range).warnings[0];
    expect(first).toMatch(/^Catch-up pull: fills from 2026-09-08 to 2026-09-09 /);
    expect(first).not.toMatch(/trading day/);
  });
});

/**
 * C-6 (v4.3.0 fix wave C, owner ruling "Say it plainly", 06-ANSWERS "v4.3.0
 * C-6 / C-7 rulings"). A connection idle longer than DHAN_MAX_PULL_RANGE_DAYS
 * was clamped with no word: lastPullAt then moved to now, the missed-pulls line
 * cleared, and the older fills were never fetched. The clamp stays (no new Dhan
 * traffic) — what changes is that the pull NAMES the dates it left out and the
 * remedy, and hands the span to its caller so it can be kept.
 */
describe("C-6 — a clamped pull names the dates it did not fetch, and the remedy", () => {
  const TODAY = "2026-09-09";

  it("catchUpRange carries `unfetched` exactly when it clamps", () => {
    expect(dhan.catchUpRange("2026-05-01T05:00:00Z", TODAY)).toEqual({
      from: "2026-06-11",
      to: TODAY,
      unfetched: { from: "2026-05-01", to: "2026-06-10" },
    });
    // One day before the floor: a one-day span.
    expect(dhan.catchUpRange("2026-06-10T05:00:00Z", TODAY)).toEqual({
      from: "2026-06-11",
      to: TODAY,
      unfetched: { from: "2026-06-10", to: "2026-06-10" },
    });
    // ON the floor: the whole gap fits, nothing is left out.
    const onFloor = dhan.catchUpRange("2026-06-11T05:00:00Z", TODAY)!;
    expect(onFloor).toEqual({ from: "2026-06-11", to: TODAY });
    expect("unfetched" in onFloor).toBe(false);
    // The `day < today` threshold is unchanged.
    expect(dhan.catchUpRange("2026-09-09T03:00:00Z", TODAY)).toBeNull();
  });

  it("toParsedFile states the unfetched dates and the tradebook remedy, verbatim, and hands the span back", () => {
    const pf = toParsedFile([], dhan.catchUpRange("2026-05-01T05:00:00Z", TODAY));
    const line =
      "Not fetched: fills from 2026-05-01 to 2026-06-10. The last pull ran on 2026-05-01, and a pull reads at most 90 days of Dhan's trade history, so this one started at 2026-06-11. To bring those fills in, import a Dhan tradebook for 2026-05-01 to 2026-06-10.";
    expect(pf.warnings[1]).toBe(line);
    expect(pf.unfetched).toEqual([{ from: "2026-05-01", to: "2026-06-10", reason: "range-cap", message: line }]);
    // A pull the cap did not touch hands back nothing.
    expect(toParsedFile([], { from: "2026-09-04", to: TODAY }).unfetched).toEqual([]);
    expect(toParsedFile([]).unfetched).toEqual([]);
  });

  it("carries no SEBI-forbidden verb — a statement of what was read, and where the rest is", () => {
    const pf = toParsedFile([], dhan.catchUpRange("2026-05-01T05:00:00Z", TODAY), {
      pages: 50,
      truncated: true,
      oldest: "2026-07-01",
      newest: "2026-09-08",
    });
    for (const w of pf.warnings) expect(w).not.toMatch(/\b(recommend|suggest|should|consider|buy|sell)\b/i);
    expect(pf.unfetched.map((u) => u.reason)).toEqual(["range-cap", "page-cap"]);
  });
});

// ===========================================================================
// M-1 (audit round 1, 2026-09-10) — a fill's charges belong to ONE position.
//
// Both books below are the skeptic's own probes. Summing every fill inside a
// position's [buyDate, sellDate] window double-counted charges wherever two
// windows overlapped (₹44 stored from ₹22 charged, ₹66 from ₹44), and listed
// fills a position never consumed — which is what commit.ts's
// stagedFromExecutions turns into trade_legs summing 200 on a 100-share row.
// ===========================================================================
describe("normalizeDhanTrades — every fill lands in exactly ONE position (M-1)", () => {
  const fill = (
    id: string,
    side: "BUY" | "SELL",
    qty: number,
    price: number,
    date: string,
    brokerage = 11,
  ): dhan.DhanTradeRow => ({
    exchangeTradeId: id,
    orderId: `O-${id}`,
    transactionType: side,
    exchangeSegment: "NSE_EQ",
    productType: "CNC",
    tradingSymbol: "TCS",
    tradedQuantity: qty,
    tradedPrice: price,
    exchangeTime: `${date} 10:00:00`,
    brokerageCharges: brokerage,
  });

  it("splits one buy fill between the closed and the open row PRO-RATA, never twice (probe 1)", () => {
    const { trades } = dhan.normalizeDhanTrades([
      fill("B", "BUY", 200, 100, "2026-09-01"),
      fill("S", "SELL", 100, 110, "2026-09-02"),
    ]);
    expect(trades).toHaveLength(2);
    const closed = trades.find((t) => t.buyQty > 0 && t.sellQty > 0)!;
    const open = trades.find((t) => t.sellQty === 0)!;

    // ₹22 was charged; ₹22 is what the two rows carry BETWEEN them.
    expect(closed.reportedCharges!.total! + open.reportedCharges!.total!).toBe(22);
    // The buy fill's ₹11 splits by the quantity each row took (100 / 100); the
    // sell fill's ₹11 is the closed row's alone.
    expect(closed.reportedCharges!.total).toBe(16.5);
    expect(open.reportedCharges!.total).toBe(5.5);

    // …and neither row lists a share it never took.
    expect(closed.executions).toEqual([
      { side: "buy", qty: 100, price: 100, date: "2026-09-01", time: "10:00" },
      { side: "sell", qty: 100, price: 110, date: "2026-09-02", time: "10:00" },
    ]);
    expect(open.executions).toEqual([
      { side: "buy", qty: 100, price: 100, date: "2026-09-01", time: "10:00" },
    ]);
  });

  it("gives each closed position its OWN FIFO pair of fills, not the date window (probe 2)", () => {
    const { trades } = dhan.normalizeDhanTrades([
      fill("B1", "BUY", 100, 100, "2026-09-01"),
      fill("B2", "BUY", 100, 100, "2026-09-02"),
      fill("S1", "SELL", 100, 110, "2026-09-03"),
      fill("S2", "SELL", 100, 110, "2026-09-04"),
    ]);
    expect(trades).toHaveLength(2);
    const [p1, p2] = trades;
    expect(p1).toMatchObject({ buyQty: 100, buyDate: "2026-09-01", sellDate: "2026-09-03" });
    expect(p2).toMatchObject({ buyQty: 100, buyDate: "2026-09-02", sellDate: "2026-09-04" });

    // ₹44 charged, ₹44 stored — ₹22 on each pair, not ₹33 on each.
    expect(p1.reportedCharges!.total).toBe(22);
    expect(p2.reportedCharges!.total).toBe(22);
    expect(p1.reportedCharges!.total! + p2.reportedCharges!.total!).toBe(44);

    // The list commit.ts reads: two fills, and the buy side sums to buyQty.
    expect(p1.executions).toHaveLength(2);
    expect(p1.executions!.map((e) => e.date)).toEqual(["2026-09-01", "2026-09-03"]);
    expect(p2.executions!.map((e) => e.date)).toEqual(["2026-09-02", "2026-09-04"]);
    expect(p1.executions!.filter((e) => e.side === "buy").reduce((s, e) => s + e.qty, 0)).toBe(p1.buyQty);
  });

  it("conserves the charge total over a re-entered symbol, and every row's executions sum to its own quantity", () => {
    const rows = [
      fill("B1", "BUY", 200, 100, "2026-09-01", 11),
      fill("S1", "SELL", 50, 105, "2026-09-02", 7),
      fill("B2", "BUY", 100, 102, "2026-09-03", 13),
      fill("S2", "SELL", 150, 108, "2026-09-04", 9),
      fill("S3", "SELL", 120, 109, "2026-09-05", 5),
    ];
    const { trades } = dhan.normalizeDhanTrades(rows);
    const stored = trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0);
    // ₹45 charged, ₹45 stored — no tolerance at all: a fill's last take carries
    // the remainder, so the split rows sum to the fills' own charges (D1).
    expect(Math.round(stored * 100) / 100).toBe(45);

    for (const t of trades) {
      const ex = t.executions ?? [];
      expect(ex.filter((e) => e.side === "buy").reduce((s, e) => s + e.qty, 0)).toBe(t.buyQty);
      expect(ex.filter((e) => e.side === "sell").reduce((s, e) => s + e.qty, 0)).toBe(t.sellQty);
    }
  });

  // D1 (seam audit, 2026-09-10) — a THREE-way split is where a per-share
  // pro-rata rounds the same rupee three times: ₹11 × 100/300 = 3.67 stored
  // thrice is ₹11.01, so ₹44 charged came out as ₹44.01. Conservation is
  // EXACT, not ±₹0.01: the last take of a fill carries the remainder.
  it("splits one buy fill THREE ways to the paisa — ₹44 charged is ₹44 stored, exactly (D1)", () => {
    const { trades } = dhan.normalizeDhanTrades([
      fill("B", "BUY", 300, 100, "2026-09-01"),
      fill("S1", "SELL", 100, 110, "2026-09-02"),
      fill("S2", "SELL", 100, 111, "2026-09-03"),
      fill("S3", "SELL", 100, 112, "2026-09-04"),
    ]);
    expect(trades).toHaveLength(3);

    const stored = trades.reduce((s, t) => s + (t.reportedCharges?.total ?? 0), 0);
    expect(
      Math.round(stored * 100) / 100,
      "the stored charges must equal the ₹44 Dhan levied on its four fills, to the paisa",
    ).toBe(44);
    // Two takes get the rounded share, the LAST take the remainder — never a
    // fourth rounded copy of the same rupee.
    expect(trades.map((t) => t.reportedCharges!.total).sort((a, b) => b! - a!)).toEqual([14.67, 14.67, 14.66]);
    // The same rule per COMPONENT, not just on the total.
    const brokerage = trades.reduce((s, t) => s + (t.reportedCharges?.brokerage ?? 0), 0);
    expect(Math.round(brokerage * 100) / 100).toBe(44);
  });
});

// ===========================================================================
// M-3 (audit round 1, 2026-09-10) — a SELL-ONLY /positions row.
//
// The user sold today what they held from before any import. The row is in
// TODAY's book, so the sale is today's by definition; leaving sellDate null
// wrote a closed trade with no exit date (or a phantom short), and tomorrow's
// catch-up re-fetch of the same sale hashed differently and landed twice.
// ===========================================================================
describe("normalizeDhanPositions — a sell-only row (M-3)", () => {
  const TODAY = "2026-09-09";
  const sellOnlyRow = () =>
    row({ tradingSymbol: "TCS", productType: "CNC", sellQty: 10, sellAvg: 3500.5, netQty: -10, realizedProfit: 1200 });

  it("dates the sale TODAY and states that its cost basis is unknown", () => {
    const [t] = normalizeDhanPositions([sellOnlyRow()], TODAY);
    expect(t.sellDate).toBe(TODAY);
    expect(t.buyDate).toBeNull();
    expect(t.buyQty).toBe(0);
    expect(t.sellQty).toBe(10);
    expect(t.avgSellPrice).toBe(3500.5);
    expect(t.sellValue).toBe(35005);
    expect(t.basisUnknown).toBe(true);
    expect(t.importNotes?.join(" ")).toMatch(/cost basis/i);
  });

  it("hashes IDENTICALLY to the same sale arriving as a history fill dated today", () => {
    const [pos] = normalizeDhanPositions([sellOnlyRow()], TODAY);
    const { trades } = dhan.normalizeDhanTrades([
      {
        exchangeTradeId: "S-TODAY",
        transactionType: "SELL",
        exchangeSegment: "NSE_EQ",
        productType: "CNC",
        tradingSymbol: "TCS",
        tradedQuantity: 10,
        tradedPrice: 3500.5,
        exchangeTime: `${TODAY} 14:45:00`,
      },
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].sellDate).toBe(TODAY);
    // This equality is the dedup that stops tomorrow's catch-up window (which
    // is inclusive of the stamp day) from writing the sale a second time.
    expect(dedupHash(pos)).toBe(dedupHash(trades[0]));
  });

  it("leaves a BUY-ONLY row byte-identical", () => {
    expect(
      normalizeDhanPositions(
        [row({ tradingSymbol: "INFY", productType: "MTF", buyQty: 40, buyAvg: 1500, netQty: 40, unrealizedProfit: 6000 })],
        TODAY,
      ),
    ).toStrictEqual([
      {
        broker: "dhan",
        tradingsymbol: "INFY",
        isin: null,
        buyQty: 40,
        avgBuyPrice: 1500,
        buyValue: 60000,
        sellQty: 0,
        avgSellPrice: 0,
        sellValue: 0,
        closingPrice: 1650,
        grossPnl: 0,
        unrealisedPnl: 6000,
        buyDate: TODAY,
        sellDate: null,
        productHint: "mtf",
        exchangeHint: "NSE",
        sourceFile: "dhan-api",
        entryTime: null,
        exitTime: null,
        importNotes: ["Product stated by the Dhan API as MTF — not inferred."],
      },
    ]);
  });

  it("leaves a same-day ROUND TRIP row byte-identical", () => {
    expect(
      normalizeDhanPositions(
        [row({ productType: "INTRADAY", buyQty: 100, buyAvg: 3300, sellQty: 100, sellAvg: 3345, netQty: 0, realizedProfit: 4500 })],
        TODAY,
      ),
    ).toStrictEqual([
      {
        broker: "dhan",
        tradingsymbol: "TCS",
        isin: null,
        buyQty: 100,
        avgBuyPrice: 3300,
        buyValue: 330000,
        sellQty: 100,
        avgSellPrice: 3345,
        sellValue: 334500,
        closingPrice: null,
        grossPnl: 4500,
        unrealisedPnl: 0,
        buyDate: TODAY,
        sellDate: TODAY,
        productHint: "intraday",
        exchangeHint: "NSE",
        sourceFile: "dhan-api",
        entryTime: null,
        exitTime: null,
        importNotes: null,
      },
    ]);
  });
});
