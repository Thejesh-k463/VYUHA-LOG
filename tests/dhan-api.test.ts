import { describe, it, expect, vi, afterEach } from "vitest";
import * as dhan from "@/lib/import/api/dhan";
import {
  normalizeDhanPositions, productHintOf, exchangeOf, toParsedFile,
  canonicalDerivativeName, markOf,
  dhanAuthUrl, mintDhanAccessToken, resolveDhanAccessToken, jwtLooksUnexpired,
  fetchDhanPositions, dhanTotpEnrolled, DHAN_TOTP_ACK_VERSION,
  type DhanPositionRow,
} from "@/lib/import/api/dhan";
import { classify } from "@/lib/engine/classify";
import { totp } from "@/lib/totp";

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
      "DHAN_TOTP_ACK_VERSION",
      "canonicalDerivativeName",
      "dhanAuthUrl",
      "dhanImportSource",
      "dhanTotpEnrolled",
      "exchangeOf",
      "fetchDhanHoldings",
      "fetchDhanPositions",
      "jwtExpiresAt",
      "jwtLooksUnexpired",
      "markOf",
      "mintDhanAccessToken",
      "normalizeDhanPositions",
      "productHintOf",
      "resolveDhanAccessToken",
      "toParsedFile",
    ]);
  });
});
