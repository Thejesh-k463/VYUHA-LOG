import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as angelone from "@/lib/import/api/angelone";
import { normalizeAngelTrades, productHintOf, exchangeOf, toParsedFile, type AngelTradeRow } from "@/lib/import/api/angelone";
// The live-feed adapters. Neither reaches `@/lib/db` except through a dynamic
// import inside a function, so a value import here binds no connection — and
// this file opens no temp database.
import { ANGELONE_QUOTE_MODE, ANGELONE_QUOTE_PATH, angelQuoteFetcher } from "@/lib/quotes/angelone";
import { ANGELONE_SEARCH_SCRIP_PATH, angelSearchScrip } from "@/lib/quotes/angelone-tokens";

/**
 * Angel One SmartAPI source. The row shape is INFERRED from the published
 * docs (candidate field names, defensive reads); these tests pin the MAPPING
 * so a live response either fits or is refused visibly — never coerced.
 */

const TODAY = "2026-08-12";

const fill = (over: Partial<AngelTradeRow> = {}): AngelTradeRow => ({
  tradingsymbol: "ACME-EQ",
  exchange: "NSE",
  producttype: "DELIVERY",
  transactiontype: "BUY",
  fillsize: "10",
  fillprice: "150.5",
  filltime: "10:15:33",
  ...over,
});

describe("normalizeAngelTrades", () => {
  it("aggregates a same-day round trip per symbol + product, fills preserved", () => {
    const { trades, refused } = normalizeAngelTrades(
      [fill(), fill({ fillsize: 5, fillprice: 151 }), fill({ transactiontype: "SELL", fillsize: 15, fillprice: 155, filltime: "14:45:01" })],
      TODAY,
    );
    expect(refused).toBe(0);
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.broker).toBe("angelone");
    expect(t.buyQty).toBe(15);
    expect(t.sellQty).toBe(15);
    expect(t.buyValue).toBe(10 * 150.5 + 5 * 151);
    expect(t.grossPnl).toBe(Math.round((15 * 155 - t.buyValue) * 100) / 100);
    expect(t.buyDate).toBe(TODAY);
    expect(t.sellDate).toBe(TODAY);
    expect(t.entryTime).toBe("10:15");
    expect(t.exitTime).toBe("14:45");
    expect(t.executions).toHaveLength(3);
  });

  it("keeps different products of one symbol apart — MTF and delivery are not one trade", () => {
    const { trades } = normalizeAngelTrades([fill(), fill({ producttype: "INTRADAY" })], TODAY);
    expect(trades).toHaveLength(2);
  });

  it("an unclosed buy stays open — no sell date is invented", () => {
    const { trades } = normalizeAngelTrades([fill()], TODAY);
    expect(trades[0].sellQty).toBe(0);
    expect(trades[0].sellDate).toBeNull();
    expect(trades[0].grossPnl).toBe(0);
  });

  it("accepts the camelCase field variants the docs also show", () => {
    const { trades } = normalizeAngelTrades(
      [{ tradingSymbol: "ZETA-EQ", exchange: "BSE", productType: "INTRADAY", transactionType: "SELL", fillSize: 7, fillPrice: 99, fillTime: "09:30:00" }],
      TODAY,
    );
    expect(trades).toHaveLength(1);
    // The NSE series suffix is stripped so Angel symbols line up with every
    // other source (verified live 2026-08-27: "HFCL-EQ" vs Dhan's "HFCL").
    expect(trades[0].tradingsymbol).toBe("ZETA");
    expect(trades[0].sellQty).toBe(7);
    expect(trades[0].exchangeHint).toBe("BSE");
  });

  it("refuses a fill with no readable side, quantity or price — counted, never coerced", () => {
    const { trades, refused } = normalizeAngelTrades(
      [fill({ fillsize: 0 }), fill({ transactiontype: "??" }), fill({ fillprice: "" })],
      TODAY,
    );
    expect(trades).toHaveLength(0);
    expect(refused).toBe(3);
  });
});

// Rows in this block are from the REAL trade book of 2026-08-27 — the first
// live Angel One pull that ever returned fills. It verified the row shape
// (previously INFERRED from docs) and found the same F&O defect the Dhan API
// had: raw symbols fell to the classifier's equity branch.
describe("canonicalAngelName — F&O names from Angel One's STATED fields", () => {
  const { canonicalAngelName } = angelone;

  it("builds the canonical name for a stock option (real row)", () => {
    expect(
      canonicalAngelName({
        tradingsymbol: "ICICIBANK29SEP261550CE", exchange: "NFO", instrumenttype: "OPTSTK",
        strikeprice: 1550, optiontype: "CE", expirydate: "29SEP2026",
      }),
    ).toBe("OPT ICICIBANK 29 Sep 2026 1550 CE");
  });

  it("takes the expiry from the STATED field, not the symbol — they disagreed live", () => {
    // Real row: the symbol says 26AUG, the stated expirydate says 27AUG2026.
    // A symbol-shape parser books the wrong expiry; the stated field wins.
    expect(
      canonicalAngelName({
        tradingsymbol: "SENSEX26AUG77600CE", exchange: "BFO", instrumenttype: "OPTIDX",
        strikeprice: 77600, optiontype: "CE", expirydate: "27AUG2026",
      }),
    ).toBe("OPT SENSEX 27 Aug 2026 77600 CE");
  });

  it("builds futures from the FUT instrument types", () => {
    expect(
      canonicalAngelName({
        tradingsymbol: "NIFTY29SEP26FUT", exchange: "NFO", instrumenttype: "FUTIDX",
        strikeprice: -1, optiontype: "", expirydate: "29SEP2026",
      }),
    ).toBe("FUT NIFTY 29 Sep 2026");
  });

  it("returns null for equity rows — sentinels are '', -1, '' (real row)", () => {
    expect(
      canonicalAngelName({
        tradingsymbol: "HFCL-EQ", exchange: "NSE", instrumenttype: "",
        strikeprice: -1, optiontype: "", expirydate: "",
      }),
    ).toBeNull();
  });

  it("returns null rather than guessing when an F&O row's stated facts are incomplete", () => {
    expect(
      canonicalAngelName({
        tradingsymbol: "MYSTERY", exchange: "NFO", instrumenttype: "OPTSTK",
        strikeprice: -1, optiontype: "", expirydate: "29SEP2026",
      }),
    ).toBeNull();
  });
});

describe("normalizeAngelTrades — the 2026-08-27 live book, end to end", () => {
  it("a real option round trip commits under its canonical name with times and product", () => {
    const { trades } = normalizeAngelTrades(
      [
        { tradingsymbol: "SENSEX26AUG77600CE", exchange: "BFO", producttype: "CARRYFORWARD",
          instrumenttype: "OPTIDX", strikeprice: 77600, optiontype: "CE", expirydate: "27AUG2026",
          transactiontype: "BUY", fillsize: "40", fillprice: 54.75, filltime: "10:18:49" },
        { tradingsymbol: "SENSEX26AUG77600CE", exchange: "BFO", producttype: "CARRYFORWARD",
          instrumenttype: "OPTIDX", strikeprice: 77600, optiontype: "CE", expirydate: "27AUG2026",
          transactiontype: "SELL", fillsize: "40", fillprice: 44.2, filltime: "10:44:47" },
      ],
      "2026-08-27",
    );
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.tradingsymbol).toBe("OPT SENSEX 27 Aug 2026 77600 CE");
    expect(t.exchangeHint).toBe("BSE");
    expect(t.productHint).toBeNull(); // CARRYFORWARD — the classifier decides
    expect(t.grossPnl).toBe(40 * 44.2 - 40 * 54.75);
    expect(t.entryTime).toBe("10:18");
    expect(t.exitTime).toBe("10:44");
    expect(t.importNotes).toBeNull();
  });

  it("keeps the raw name and SAYS SO when an F&O row's stated facts are incomplete", () => {
    const { trades } = normalizeAngelTrades(
      [{ tradingsymbol: "MYSTERY", exchange: "NFO", producttype: "CARRYFORWARD",
        instrumenttype: "OPTSTK", strikeprice: -1, optiontype: "", expirydate: "",
        transactiontype: "BUY", fillsize: "1", fillprice: 10, filltime: "10:00:00" }],
      "2026-08-27",
    );
    expect(trades[0]!.tradingsymbol).toBe("MYSTERY");
    expect(trades[0]!.importNotes?.join(" ")).toMatch(/stated no usable expiry\/strike\/option type/i);
  });

  it("a real MTF trade (producttype MARGIN, equity) hints mtf and loses its -EQ suffix", () => {
    const { trades } = normalizeAngelTrades(
      [{ tradingsymbol: "WABAG-EQ", exchange: "NSE", producttype: "MARGIN",
        instrumenttype: "", strikeprice: -1, optiontype: "", expirydate: "",
        transactiontype: "BUY", fillsize: "1", fillprice: 2163, filltime: "11:19:24" }],
      "2026-08-27",
    );
    expect(trades[0]!.tradingsymbol).toBe("WABAG");
    expect(trades[0]!.productHint).toBe("mtf");
  });
});

describe("mapping tables", () => {
  it("product hints mirror the Dhan source's reasoning", () => {
    expect(productHintOf("DELIVERY")).toBe("delivery");
    expect(productHintOf("MTF")).toBe("mtf");
    expect(productHintOf("INTRADAY")).toBe("intraday");
    expect(productHintOf("BO")).toBe("intraday");
    // The F&O carry product: the classifier decides the segment.
    expect(productHintOf("CARRYFORWARD")).toBeNull();
    // MARGIN is Angel One's MTF product on equity rows — a real MTF trade
    // arrived as producttype MARGIN in the live trade book (2026-08-27).
    expect(productHintOf("MARGIN")).toBe("mtf");
    expect(productHintOf(undefined)).toBeNull();
  });

  it("exchanges fold to the three the app knows, null otherwise", () => {
    expect(exchangeOf("NSE")).toBe("NSE");
    expect(exchangeOf("NFO")).toBe("NSE");
    expect(exchangeOf("BFO")).toBe("BSE");
    expect(exchangeOf("MCX")).toBe("MCX");
    expect(exchangeOf("SOMETHING")).toBeNull();
  });
});

describe("warnings say what a pull can and cannot know", () => {
  it("an empty book explains itself instead of looking broken", () => {
    const p = toParsedFile([], 0);
    expect(p.warnings.join(" ")).toMatch(/CURRENT trading day/i);
  });
  it("a real pull states the verified mapping and the refused count", () => {
    const { trades } = normalizeAngelTrades([fill()], TODAY);
    const p = toParsedFile(trades, 2);
    // Was "inferred from Angel One's documentation" until the mapping was
    // VERIFIED against a live trade book on 2026-08-27.
    expect(p.warnings.join(" ")).toMatch(/verified against a live trade book/i);
    expect(p.warnings.join(" ")).toMatch(/2 fills .*refused/i);
  });
});

describe("read-only by surface", () => {
  it("the module exports no order, funds or modification capability", () => {
    // The whole security argument for unattended sync is that this code path
    // CANNOT trade. That is enforced by the module surface, and this pin
    // makes adding an order method a CI failure instead of a review comment.
    //
    // v4.2 added THREE exports and no capability: `BASE`, `smartApiHeaders`
    // and `smartApiJson`, so the live-quote adapter builds its URLs, its
    // headers and its envelope handling from THIS module instead of forking a
    // second copy that could drift to a second host or a laxer error path.
    expect(Object.keys(angelone).sort()).toEqual([
      "BASE",
      "angelOneImportSource",
      "angelOneLogin",
      "canonicalAngelName",
      "exchangeOf",
      "fetchAngelTradeBook",
      "normalizeAngelTrades",
      "productHintOf",
      "smartApiHeaders",
      "smartApiJson",
      "stripSeriesSuffix",
      "toParsedFile",
    ]);
  });

  it("names exactly one host, and every Angel One URL in the tree is built from it", () => {
    expect(angelone.BASE).toBe("https://apiconnect.angelone.in");
  });
});

/**
 * THE SAME RULE, HELD OVER THE v4.2 LIVE-QUOTE ADAPTER.
 *
 * Angel One has NO read-only key. The jwt that reads a price is the jwt that
 * could place an order, and no setting, scope or key type removes that — so
 * the protection cannot be a claim about the credential and has to be a
 * property of the CODE. The consent sheet says, in the user's words, that
 * "Vyuha's Angel One code contains no order call at all and a test refuses to
 * let one be added". THIS is that test.
 *
 * It reads the SOURCE rather than the module surface, because the two quote
 * files export functions that take a path or a batch: an order call could be
 * added there without adding an export, and the export pin above would not
 * see it.
 */
describe("the live-quote adapter is held to the same rule (v4.2)", () => {
  const FILES = ["lib/quotes/angelone.ts", "lib/quotes/angelone-tokens.ts"] as const;
  const sourceOf = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

  /**
   * AN ALLOWLIST, NOT A DENYLIST (fix A-3).
   *
   * The first version of this test named the paths it refused
   * (`placeOrder|modifyOrder|cancelOrder`, a second `/order/v1/<verb>`), and a
   * denylist only ever refuses what somebody thought of. Two real SmartAPI
   * calls walked straight through it: the GTT namespace
   * (`/rest/secure/angelbroking/gtt/v1/createRule`, which places a resting
   * order and is not under `/order/v1/` at all) and a TEMPLATED path
   * (`/order/v1/${verb}`, whose `[A-Za-z]+` capture stopped at the `$`).
   *
   * So the rule is inverted: EVERY SmartAPI path fragment that appears
   * anywhere in these two files — literal, template or prose — must be part of
   * one of the three paths this release is allowed to reach. A new endpoint
   * fails by DEFAULT, which is the only way this test can be worth the words
   * the consent sheet spends on it.
   */
  const LOGIN_PATH = "/rest/auth/angelbroking/user/v1/loginByPassword";
  const ALLOWED_PATHS = [ANGELONE_QUOTE_PATH, ANGELONE_SEARCH_SCRIP_PATH, LOGIN_PATH] as const;
  /** The constants a URL may be built from — an identifier, never an expression. */
  const ALLOWED_PATH_CONSTANTS = ["ANGELONE_QUOTE_PATH", "ANGELONE_SEARCH_SCRIP_PATH"] as const;
  /** Any SmartAPI-shaped path fragment, INCLUDING one built by interpolation. */
  const PATH_TOKEN = /\/(?:rest|order|market|auth|secure|angelbroking|gtt|portfolio|funds)[A-Za-z0-9_/.${}-]*/g;

  it("the login path really is the one the import module uses", () => {
    // The allowlist's third member is anchored to the code, not to this file:
    // if the login endpoint ever moves, this fails rather than silently
    // allowlisting a path nobody calls.
    expect(sourceOf("lib/import/api/angelone.ts")).toContain(`\`\${BASE}${LOGIN_PATH}\``);
  });

  /** Every fragment that is not part of an allowed path. THE rule. */
  const strayPaths = (src: string): string[] =>
    [...new Set(src.match(PATH_TOKEN) ?? [])].filter((t) => !ALLOWED_PATHS.some((p) => p.includes(t)));

  it("names no SmartAPI path outside the three this release is allowed to reach", () => {
    for (const f of FILES) {
      const src = sourceOf(f);
      // A prose fragment ("/order/v1/") is a substring of searchScrip's path
      // and passes; a GTT rule path and a `${verb}` template are substrings of
      // nothing.
      expect(strayPaths(src), `${f} reaches a SmartAPI path this release may not use`).toEqual([]);
      // …and there really is a path here to check: a guard that matches
      // nothing passes for the wrong reason.
      expect((src.match(PATH_TOKEN) ?? []).length, `${f} names no SmartAPI path at all`).toBeGreaterThan(0);
    }
  });

  it("CATCHES the two endpoints the old denylist let through", () => {
    // Both of these passed the previous rule. The GTT namespace places a
    // resting order and is not under `/order/v1/` at all; the templated verb
    // defeated an `[A-Za-z]+` capture, which stopped at the `$`. A guard that
    // cannot be shown to fire is not a guard.
    const gtt = 'const RULE = "/rest/secure/angelbroking/gtt/v1/createRule";';
    const templated = "await fetch(`${BASE}/order/v1/${verb}`, { method: 'POST' });";
    expect(strayPaths(gtt)).toEqual(["/rest/secure/angelbroking/gtt/v1/createRule"]);
    expect(strayPaths(templated)).toEqual(["/order/v1/${verb}"]);
    // …while the three real paths are accepted, so the rule is not just "no".
    for (const p of ALLOWED_PATHS) expect(strayPaths(`const P = "${p}";`)).toEqual([]);
  });

  it("hands `fetch` a constant, never a path it assembled", () => {
    for (const f of FILES) {
      const src = sourceOf(f);
      for (const m of src.matchAll(/\bfetch\(\s*([^,]+),/g)) {
        const arg = m[1].trim();
        // `${BASE}${CONST}` and nothing else: one host string in the tree, and
        // a path that is an imported constant rather than an expression.
        const built = /^`\$\{BASE\}\$\{([A-Za-z_][A-Za-z0-9_]*)\}`$/.exec(arg);
        expect(built, `${f} builds its own URL: ${arg}`).not.toBeNull();
        expect(ALLOWED_PATH_CONSTANTS as readonly string[], `${f} interpolates ${built?.[1]}`).toContain(built![1]);
      }
    }
  });

  it("still names no order verb, and no fund or position endpoint", () => {
    // Kept beside the allowlist: a helper called `placeOrder` that builds no
    // path of its own would be invisible to a path rule.
    for (const f of FILES) {
      const src = sourceOf(f);
      expect(src, `${f} names an order verb`).not.toMatch(/placeOrder|modifyOrder|cancelOrder/i);
      expect(src, `${f} reaches a fund or position endpoint`).not.toMatch(
        /getRMS|getHolding|getPosition|convertPosition|getTradeBook/i,
      );
    }
  });

  it("names no host but apiconnect.angelone.in, and writes no URL of its own", () => {
    for (const f of FILES) {
      const src = sourceOf(f);
      // Every http(s) literal — there must be none: the base comes from
      // lib/import/api/angelone.ts, which is where the one host lives.
      expect([...src.matchAll(/https?:\/\/[^\s"'`)\]]+/g)].map((m) => m[0]), `${f} writes its own URL`).toEqual([]);
      // …and no OTHER vendor host appears even in a comment, which is how a
      // "just for testing" endpoint gets written.
      const hosts = new Set(
        (src.match(/\b(?:[a-z0-9-]+\.)+(?:com|in|io|net|org|co|dev|app|ai)\b/gi) ?? []).map((h) => h.toLowerCase()),
      );
      expect([...hosts].filter((h) => h !== "apiconnect.angelone.in"), `${f} names another host`).toEqual([]);
    }
  });

  it("makes its requests from ONE call site each — a second fetch is a second host", () => {
    for (const f of FILES) {
      const src = sourceOf(f);
      expect((src.match(/\bfetch\(/g) ?? []).length, `${f} has more than one fetch call site`).toBeLessThanOrEqual(1);
    }
  });

  it("writes nothing to the journal — the only table it touches is its own token cache", () => {
    for (const f of FILES) {
      const src = sourceOf(f);
      const tables = [...src.matchAll(/db\s*\.\s*(?:insert|update|delete)\(([A-Za-z]+)/g)].map((m) => m[1]);
      expect([...new Set(tables)], `${f} writes a journal table`).toEqual(
        f.endsWith("angelone-tokens.ts") ? ["angeloneInstrumentTokens"] : [],
      );
    }
  });
});

/**
 * THE DEFAULT FETCHERS, ON A STUBBED SOCKET (v4.2 fix A-8).
 *
 * Every other Angel One test injects `quoteImpl` / `searchImpl`, which is what
 * keeps them fast and socket-free — and it left the two functions that decide
 * the METHOD, the PATH, the mode and the body shape running in no test at all.
 * A typo in `mode`, a GET where SmartAPI wants a POST, or a PIN that leaked
 * into a header would have reached a live account before it reached a test.
 *
 * `fetch` is stubbed, so no socket is opened here either; what is asserted is
 * the request that WOULD have gone out, byte for byte, and the credentials
 * that must never be in it. Pattern: `tests/dhan-api.test.ts`, `kite-api`.
 */
describe("the live-feed requests Angel One actually receives", () => {
  const CREDS = { apiKey: "smartapi-key", clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" };
  const JWT = "jwt-for-the-day";

  interface Sent {
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: string;
    cache?: string;
  }

  /** Records the one request and answers with a SmartAPI envelope. */
  function stubFetch(payload: unknown, ok = true): { sent: Sent[] } {
    const sent: Sent[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init: Record<string, unknown> = {}) => {
      sent.push({
        url: String(input),
        method: init.method as string | undefined,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: String(init.body ?? ""),
        cache: init.cache as string | undefined,
      });
      return new Response(JSON.stringify(ok ? { status: true, data: payload } : { status: false, message: String(payload) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return { sent };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the OHLC quote to the one host and the one path, with the tokens grouped by exchange", async () => {
    const { sent } = stubFetch({ fetched: [{ exchange: "NSE", symbolToken: "3045", ltp: 812.5 }], unfetched: [] });

    const data = await angelQuoteFetcher(CREDS, JWT, { exchange: "NSE", tokens: ["3045", "11536"] });
    expect(data?.fetched?.[0]?.symbolToken).toBe("3045"); // the envelope is unwrapped, not returned whole

    expect(sent).toHaveLength(1);
    const req = sent[0];
    // Host and path as LITERALS — not the constants compared with themselves.
    expect(req.url).toBe("https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/");
    expect(req.url).toBe(`${angelone.BASE}${ANGELONE_QUOTE_PATH}`);
    expect(req.method).toBe("POST");
    expect(req.cache).toBe("no-store");

    const body = JSON.parse(req.body) as { mode: string; exchangeTokens: Record<string, string[]> };
    // OHLC, literally: it is the cheapest mode that carries the previous close
    // the desk renders as the day change. LTP mode would blank that column.
    expect(body.mode).toBe("OHLC");
    expect(ANGELONE_QUOTE_MODE).toBe("OHLC");
    expect(body.exchangeTokens).toEqual({ NSE: ["3045", "11536"] });
    // One exchange per request — the token spaces are per exchange.
    expect(Object.keys(body.exchangeTokens)).toEqual(["NSE"]);
  });

  it("carries the day's jwt as a Bearer token and NEVER the PIN or the TOTP secret", async () => {
    const { sent } = stubFetch({ fetched: [], unfetched: [] });
    await angelQuoteFetcher(CREDS, JWT, { exchange: "BSE", tokens: ["500112"] });

    const req = sent[0];
    expect(req.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(req.headers["X-PrivateKey"]).toBe(CREDS.apiKey);
    expect(req.headers["Content-Type"]).toBe("application/json");

    // The credential that could TRADE never leaves the login call. This is the
    // sentence the consent sheet spends on the jwt, asserted on the wire.
    const wire = `${req.url} ${JSON.stringify(req.headers)} ${req.body}`;
    expect(wire).not.toContain(CREDS.pin);
    expect(wire).not.toContain(CREDS.totpSecret);
    expect(wire).not.toContain(CREDS.clientCode);
  });

  it("POSTs searchScrip as { exchange, searchscrip } — one symbol, on the same host", async () => {
    const { sent } = stubFetch([{ exchange: "NSE", tradingsymbol: "SBIN-EQ", symboltoken: "3045" }]);

    const rows = await angelSearchScrip(CREDS, JWT, "NSE", "SBIN");
    expect(rows).toEqual([{ exchange: "NSE", tradingsymbol: "SBIN-EQ", symboltoken: "3045" }]);

    const req = sent[0];
    expect(req.url).toBe("https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/searchScrip");
    expect(req.url).toBe(`${angelone.BASE}${ANGELONE_SEARCH_SCRIP_PATH}`);
    expect(req.method).toBe("POST");
    expect(req.cache).toBe("no-store");
    expect(JSON.parse(req.body)).toEqual({ exchange: "NSE", searchscrip: "SBIN" });
    expect(req.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(`${JSON.stringify(req.headers)} ${req.body}`).not.toContain(CREDS.pin);
  });

  it("surfaces a refused envelope instead of returning an empty answer", async () => {
    const { sent } = stubFetch("AG8001: Invalid Token", false);
    await expect(angelQuoteFetcher(CREDS, JWT, { exchange: "NSE", tokens: ["3045"] })).rejects.toThrow(/AG8001/);
    expect(sent).toHaveLength(1);

    // …and searchScrip answers a NON-array payload with no rows rather than
    // letting `undefined` reach the row picker.
    const { sent: s2 } = stubFetch(null);
    await expect(angelSearchScrip(CREDS, JWT, "NSE", "NOSUCHSCRIP")).resolves.toEqual([]);
    expect(s2).toHaveLength(1);
  });
});
