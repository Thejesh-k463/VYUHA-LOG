import { afterEach, describe, expect, it, vi } from "vitest";
import * as kite from "../lib/import/api/kite";
import {
  exchangeKiteRequestToken,
  fetchKiteTrades,
  kiteChecksum,
  kiteLoginUrl,
  normalizeKiteTrades,
  type KiteTradeRow,
} from "../lib/import/api/kite";

const row = (over: Partial<KiteTradeRow>): KiteTradeRow => ({
  tradingsymbol: "ATGL",
  exchange: "NSE",
  product: "CNC",
  transaction_type: "BUY",
  quantity: 10,
  average_price: 600,
  fill_timestamp: "2026-07-11 10:02:31",
  ...over,
});

describe("normalizeKiteTrades", () => {
  it("aggregates executions per symbol+product into one round-trip", () => {
    const out = normalizeKiteTrades([
      row({ quantity: 10, average_price: 600 }),
      row({ quantity: 5, average_price: 610 }),
      row({ transaction_type: "SELL", quantity: 15, average_price: 620, fill_timestamp: "2026-07-11 14:30:00" }),
    ]);
    expect(out).toHaveLength(1);
    const t = out[0];
    expect(t.buyQty).toBe(15);
    expect(t.avgBuyPrice).toBeCloseTo((10 * 600 + 5 * 610) / 15, 2);
    expect(t.sellQty).toBe(15);
    expect(t.sellValue).toBe(9300);
    // gross = (620 − 603.33) × 15
    expect(t.grossPnl).toBeCloseTo(250, 0);
    expect(t.productHint).toBe("delivery");
    expect(t.broker).toBe("zerodha");
  });

  it("keeps earliest buy date and latest sell date across executions", () => {
    const out = normalizeKiteTrades([
      row({ fill_timestamp: "2026-07-11 11:00:00" }),
      row({ fill_timestamp: "2026-07-11 09:20:00" }),
      row({ transaction_type: "SELL", fill_timestamp: "2026-07-11 15:15:00" }),
    ]);
    expect(out[0].buyDate).toBe("2026-07-11");
    expect(out[0].sellDate).toBe("2026-07-11");
  });

  it("separates products and maps hints (MIS→intraday, NRML→null)", () => {
    const out = normalizeKiteTrades([
      row({ product: "MIS" }),
      row({ product: "NRML", tradingsymbol: "NIFTY26JUL24500CE", exchange: "NFO", quantity: 75, average_price: 120 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((t) => t.tradingsymbol === "ATGL")!.productHint).toBe("intraday");
    const opt = out.find((t) => t.tradingsymbol === "NIFTY26JUL24500CE")!;
    expect(opt.productHint).toBeNull();
    expect(opt.exchangeHint).toBe("NSE"); // NFO → NSE
  });

  it("leaves one-sided (open) groups with zero gross", () => {
    const out = normalizeKiteTrades([row({})]);
    expect(out[0].sellQty).toBe(0);
    expect(out[0].grossPnl).toBe(0);
  });

  it("skips zero-qty rows", () => {
    expect(normalizeKiteTrades([row({ quantity: 0 })])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Official session exchange (v3.6.0, decision #3 — NO enctoken).
// ---------------------------------------------------------------------------

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

describe("kiteChecksum — SHA-256(api_key + request_token + api_secret), hex", () => {
  it("reproduces a known vector (red-on-revert for the checksum function)", () => {
    // Vector computed once with node:crypto and PINNED — the test must not
    // recompute it with the same library it is checking.
    expect(kiteChecksum("kitekey123", "reqtok456", "apisecret789")).toBe(
      "bc7d98ddd3ffc790622fdde7e51d658bb6b61537d95025a758c98975ee210868",
    );
  });

  it("is order-sensitive — swapping token and secret is a different checksum", () => {
    expect(kiteChecksum("kitekey123", "apisecret789", "reqtok456")).not.toBe(
      kiteChecksum("kitekey123", "reqtok456", "apisecret789"),
    );
  });
});

describe("kiteLoginUrl", () => {
  it("is the documented Kite Connect login URL for the app", () => {
    expect(kiteLoginUrl("kitekey123")).toBe("https://kite.zerodha.com/connect/login?v=3&api_key=kitekey123");
  });
});

describe("exchangeKiteRequestToken — POST /session/token, form-encoded, checksum-signed", () => {
  it("sends api_key, request_token and the checksum with X-Kite-Version 3", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { status: "success", data: { access_token: "days-token", user_id: "AB1234" } });
    });
    const out = await exchangeKiteRequestToken({ apiKey: "kitekey123", apiSecret: "apisecret789", requestToken: "reqtok456" });
    expect(out.accessToken).toBe("days-token");
    // WHOSE session was minted — the route compares this against the id the
    // connection is bound to, so a wrong-account login cannot import another
    // person's tradebook. Discarding user_id here is what made that possible.
    expect(out.userId).toBe("AB1234");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.kite.trade/session/token");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Kite-Version"]).toBe("3");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(calls[0]!.init?.body));
    expect(body.get("api_key")).toBe("kitekey123");
    expect(body.get("request_token")).toBe("reqtok456");
    expect(body.get("checksum")).toBe("bc7d98ddd3ffc790622fdde7e51d658bb6b61537d95025a758c98975ee210868");
  });

  it("returns userId: null (never '') when Kite omits user_id, so 'unstated' is distinguishable", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, { status: "success", data: { access_token: "days-token" } }));
    const out = await exchangeKiteRequestToken({ apiKey: "k", apiSecret: "s", requestToken: "r" });
    expect(out.accessToken).toBe("days-token");
    expect(out.userId).toBeNull();
  });

  it("explains a rejected exchange — request_tokens are single-use and short-lived", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(403, { status: "error", message: "Token is invalid or has expired." }));
    await expect(
      exchangeKiteRequestToken({ apiKey: "k", apiSecret: "s", requestToken: "stale" }),
    ).rejects.toThrow(/session exchange: Token is invalid.*single-use.*paste a fresh one/i);
  });
});

describe("fetchKiteTrades — a dead session is recognisable, not just a string", () => {
  it("carries kiteStatus 403 and the daily-expiry guidance on a TokenException", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(403, { status: "error", message: "Incorrect `api_key` or `access_token`.", error_type: "TokenException" }),
    );
    const err = await fetchKiteTrades({ apiKey: "k", accessToken: "dead" }).catch((e) => e as Error & { kiteStatus?: number });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { kiteStatus?: number }).kiteStatus).toBe(403);
    expect((err as Error).message).toMatch(/6 AM IST.*request_token/i);
  });

  it("raw-paste mode still works untouched — the token goes straight into the auth header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { status: "success", data: [] as KiteTradeRow[] });
    });
    await expect(fetchKiteTrades({ apiKey: "kitekey123", accessToken: "pasted-token" })).resolves.toEqual([]);
    expect(calls[0]!.url).toBe("https://api.kite.trade/trades");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("token kitekey123:pasted-token");
  });
});

describe("read-only by surface", () => {
  it("the module exports no order, funds or modification capability", () => {
    // Same rule as Angel One and Dhan: the session-exchange upgrade must not
    // quietly widen what this code path can do. Export list pinned.
    expect(Object.keys(kite).sort()).toEqual([
      "exchangeKiteRequestToken",
      "fetchKiteTrades",
      "kiteChecksum",
      "kiteImportSource",
      "kiteLoginUrl",
      "normalizeKiteTrades",
      "toParsedFile",
    ]);
  });
});
