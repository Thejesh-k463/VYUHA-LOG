import { describe, expect, it } from "vitest";
import {
  parseTradesQuery, serializeTradesQuery, isEmptyTradesQuery, EMPTY_TRADES_QUERY, TRADES_QUERY_VIEWS,
  type TradesQuery,
} from "@/lib/domain/trades-query";
import { TRADE_VIEWS } from "@/lib/analytics/trade-status";
import { assessDataQuality, type QualityTrade } from "@/lib/analytics/data-quality";
import { optionsSellerReport, sellerKpiDetails, type SellerTrade } from "@/lib/analytics/options-seller";

/**
 * WS7 — the `/trades?…` deep-link contract.
 *
 * Every link the app emits toward /trades goes through ONE serializer, and the
 * page reads it through ONE parser. Three properties matter: a symbol with a
 * reserved character survives the round trip (`&`, `%`); the serializer is
 * canonical (stable order, defaults omitted) so `parse ∘ serialize` is the
 * identity; and no surface can emit a link the page will not honour — the last
 * one is what turned `/trades?basis=unknown` and `/trades?view=open` into
 * dead links for a release.
 */

const q = (over: Partial<TradesQuery> = {}): TradesQuery => ({ ...EMPTY_TRADES_QUERY, ...over });

describe("parseTradesQuery", () => {
  const cases: [string, string, Partial<TradesQuery>][] = [
    ["empty", "", {}],
    ["bare question mark", "?", {}],
    ["add=manual", "?add=manual", { add: "manual" }],
    ["add=open", "?add=open", { add: "open" }],
    ["add with an unknown value is dropped", "?add=wizard", {}],
    ["symbol", "?symbol=RELIANCE", { symbol: "RELIANCE" }],
    ["symbol with & is DECODED", "?symbol=M%26M", { symbol: "M&M" }],
    ["symbol with % is DECODED", "?symbol=50%25", { symbol: "50%" }],
    ["symbol with + (encoded) is decoded", "?symbol=A%2BB", { symbol: "A+B" }],
    ["leading ? is optional", "symbol=TCS&view=open", { symbol: "TCS", view: "open" }],
    ["from/to window", "?from=2026-06-01&to=2026-06-17", { from: "2026-06-01", to: "2026-06-17" }],
    ["Search v1 shape: empty from/to are dropped", "?symbol=INFY&from=&to=", { symbol: "INFY" }],
    ["a date that is not YYYY-MM-DD is dropped", "?from=01-06-2026&to=yesterday", {}],
    ["realised=1", "?realised=1", { realised: true }],
    ["realised=true", "?realised=true", { realised: true }],
    ["realised=0 is false", "?realised=0", {}],
    ["segment in SEGMENTS", "?segment=index_option", { segment: "index_option" }],
    ["segment not in SEGMENTS is dropped", "?segment=crypto", {}],
    ["basis=unknown", "?basis=unknown", { basis: "unknown" }],
    ["basis with another value is dropped", "?basis=known", {}],
    ["view=open", "?view=open", { view: "open" }],
    ["view=closed", "?view=closed", { view: "closed" }],
    ["view=closed-loss (outcome views are honoured too)", "?view=closed-loss", { view: "closed-loss" }],
    ["view=all is the default and normalises to null", "?view=all", {}],
    ["view not offered by the select is dropped", "?view=profitable", {}],
    ["unknown keys are ignored", "?foo=bar&page=3&symbol=SBIN", { symbol: "SBIN" }],
    ["every key at once", "?add=open&symbol=NIFTY&from=2026-01-01&to=2026-01-31&realised=1&segment=index_option&basis=unknown&view=open",
      { add: "open", symbol: "NIFTY", from: "2026-01-01", to: "2026-01-31", realised: true, segment: "index_option", basis: "unknown", view: "open" }],
  ];
  it.each(cases)("%s", (_name, search, expected) => {
    expect(parseTradesQuery(search)).toEqual(q(expected));
  });

  it("never throws on garbage", () => {
    for (const s of ["?%", "?%E0%A4", "?=&&==?", "?symbol=%ZZ", "&&&", "?symbol"]) {
      expect(() => parseTradesQuery(s)).not.toThrow();
    }
  });

  it("offers exactly the views the /trades select offers", () => {
    expect([...TRADES_QUERY_VIEWS]).toEqual(TRADE_VIEWS.map((v) => v.value));
  });
});

describe("serializeTradesQuery", () => {
  const cases: [string, Partial<TradesQuery>, string][] = [
    ["nothing set → empty string (pathname stays a valid href)", {}, ""],
    ["add=open", { add: "open" }, "?add=open"],
    ["symbol is encoded", { symbol: "M&M" }, "?symbol=M%26M"],
    ["percent is encoded", { symbol: "50%" }, "?symbol=50%25"],
    ["realised=1", { realised: true }, "?realised=1"],
    ["realised=false is omitted", { realised: false }, ""],
    ["view=all is a default and omitted", { view: "all" }, ""],
    ["empty strings are omitted", { symbol: "", from: "", to: "", segment: "" }, ""],
    ["stable key order regardless of input order",
      { view: "open", basis: "unknown", segment: "eq_mtf", realised: true, to: "2026-02-02", from: "2026-01-01", symbol: "X", add: "manual" },
      "?add=manual&symbol=X&from=2026-01-01&to=2026-02-02&realised=1&segment=eq_mtf&basis=unknown&view=open"],
    ["the dashboard day drill-down", { from: "2026-06-17", to: "2026-06-17", realised: true }, "?from=2026-06-17&to=2026-06-17&realised=1"],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(serializeTradesQuery(input)).toBe(expected);
  });

  it("parse ∘ serialize is the identity for every valid query", () => {
    const samples: TradesQuery[] = [
      q(),
      q({ symbol: "M&M", view: "open" }),
      q({ symbol: "50% off & more", segment: "stock_option", realised: true }),
      q({ add: "manual", basis: "unknown" }),
      q({ from: "2026-06-01", to: "2026-06-30", realised: true, view: "closed-loss" }),
      q({ symbol: "A+B C", segment: "eq_delivery", view: "staged" }),
    ];
    for (const s of samples) expect(parseTradesQuery(serializeTradesQuery(s))).toEqual(s);
  });

  it("isEmptyTradesQuery is true only when nothing is set", () => {
    expect(isEmptyTradesQuery(q())).toBe(true);
    expect(isEmptyTradesQuery(q({ view: "all" }))).toBe(true);
    expect(isEmptyTradesQuery(q({ view: "open" }))).toBe(false);
    expect(isEmptyTradesQuery(q({ basis: "unknown" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// "No dead link" guard: every `/trades?…` href these two modules emit must
// parse to a NON-EMPTY query (the page would otherwise show the unfiltered
// table) and must already be canonical (serialize(parse(href)) === href).
// ---------------------------------------------------------------------------

function collectTradesHrefs(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.startsWith("/trades?")) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectTradesHrefs(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectTradesHrefs(v, out);
  }
  return out;
}

function expectLiveLink(href: string) {
  const parsed = parseTradesQuery(href.slice("/trades".length));
  expect(isEmptyTradesQuery(parsed), `${href} parses to nothing — the page would ignore it`).toBe(false);
  expect(`/trades${serializeTradesQuery(parsed)}`, `${href} is not canonical`).toBe(href);
}

describe("no dead /trades links", () => {
  it("data-quality: every /trades?… href it emits is honoured by the page", () => {
    const t = (over: Partial<QualityTrade>): QualityTrade => ({
      id: 1, isOpen: false, acquisition: null, acquisitionPrice: null, closingPrice: null, slPlanned: null,
      riskAmount: null, segment: "eq_delivery", mtfFundedAmount: null, instrumentType: "equity", expiry: null,
      strike: null, optionType: null, symbol: "X", ...over,
    });
    const report = assessDataQuality({
      trades: [
        t({ id: 1, acquisition: "unknown", acquisitionPrice: null }),          // unknown_basis → /trades?basis=unknown
        t({ id: 2, isOpen: true, slPlanned: null, riskAmount: null }),         // missing_stop  → /trades?view=open
        t({ id: 3, segment: "eq_mtf", mtfFundedAmount: null }),
        t({ id: 4, instrumentType: "option", expiry: null }),
      ],
      markedTradeIds: new Set([2]),
      knownSymbols: new Set(["X"]),
      ipoLinkedTradeIds: new Set(),
      staleMtmCount: 1,
      missingAttachmentFiles: 1,
    });
    const hrefs = collectTradesHrefs(report.issues.map((i) => i.href));
    // Guard the guard: the two links this test exists for must be present.
    expect(hrefs).toContain("/trades?basis=unknown");
    expect(hrefs).toContain("/trades?view=open");
    for (const h of hrefs) expectLiveLink(h);
  });

  it("options-seller: every /trades?… href it emits is honoured, and a symbol with & survives", () => {
    const seller = (over: Partial<SellerTrade> = {}): SellerTrade => ({
      id: 1, symbol: "NIFTY", segment: "index_option", sellQty: 50, buyQty: 50, avgSellPrice: 100, avgBuyPrice: 40,
      netPnl: 2900, riskAmount: 10000, entryIv: 20, exitIv: 15, entryDte: 7, hedgeStatus: "hedged",
      expiryOutcome: "squared_off", adjustmentGroup: null, isOpen: false, ...over,
    });
    const trades = [
      seller({ id: 1 }),
      seller({ id: 2, symbol: "M&M", tradingsymbol: "M&M26JUN3000CE", segment: "stock_option", netPnl: -800 }),
      seller({ id: 3, isOpen: true, buyQty: 0, avgBuyPrice: 0, netPnl: 500 }),
    ];
    const details = sellerKpiDetails(trades, optionsSellerReport(trades));
    const hrefs = collectTradesHrefs(details);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expectLiveLink(h);
    // The `&` in M&M must come back as a symbol, not split the query.
    const mm = hrefs.find((h) => h.includes("M%26M"));
    expect(mm, "expected an M&M link").toBeTruthy();
    const parsed = parseTradesQuery(mm!.slice("/trades".length));
    expect(parsed.symbol).toMatch(/^M&M/);
    expect(parsed.segment).toBe("stock_option");
    // The realised footer link is honoured too.
    expect(hrefs).toContain("/trades?realised=1");
  });
});
