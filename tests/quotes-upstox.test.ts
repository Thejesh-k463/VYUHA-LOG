import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  UPSTOX_CAPABILITIES,
  UPSTOX_LTP_PATH,
  UPSTOX_MAX_KEYS,
  UPSTOX_OHLC_MIN_INTERVAL_MS,
  UPSTOX_OHLC_PATH,
  UPSTOX_RATE_LIMIT_PER_SECOND,
  createUpstoxProvider,
  indexByInstrumentToken,
  planUpstoxKeys,
  quoteFromUpstox,
  upstoxFeedErrorMessage,
  upstoxInstrumentKey,
  type UpstoxGateState,
  type UpstoxGetter,
  type UpstoxHealth,
  type UpstoxLtpValue,
} from "@/lib/quotes/upstox";
import { quoteKeyId, type QuoteKey } from "@/lib/quotes/types";

/**
 * THE UPSTOX QUOTE PROVIDER (v4.2, rulings 4.2-1…4.2-8).
 *
 * NO NETWORK, EVER. There is no Upstox market-data sandbox, so the payloads
 * below are RECORDED shapes from Upstox's own v3 market-quote documentation and
 * the `instrument_token` field of a real trade book (2026-08-28, the same
 * `NSE_EQ|INE…` form `lib/import/api/upstox.ts` already reads). The gate reader,
 * the HTTPS GET and the clock are all injected, which is why every assertion
 * here is exact rather than timing-dependent.
 *
 * What this file holds to account is the six properties the adapter exists for:
 * paise at the edge, equities only, the response indexed by the key we SENT,
 * one OHLC call a minute, a 5 req/s guard that refuses, and a health() that
 * names the credential that died without inventing a source timestamp.
 */

const RELIANCE: QuoteKey = { symbol: "RELIANCE", exchange: "NSE" };
const TCS: QuoteKey = { symbol: "TCS", exchange: "NSE" };
const ISINS: Record<string, string> = {
  RELIANCE: "INE002A01018",
  TCS: "INE467B01029",
  INFY: "INE009A01021",
};
const isinOf = (symbol: string) => ISINS[symbol] ?? null;

const READY: UpstoxGateState = { state: "ready", creds: { accessToken: "analytics-token-123" } };

/**
 * One recorded `/v3/market-quote/ltp` payload. NOTE the map keys: Upstox
 * answers keyed by SEGMENT:TRADINGSYMBOL, never by the instrument key you sent.
 */
const LTP_PAYLOAD = {
  "NSE_EQ:RELIANCE": {
    last_price: 1418.35,
    instrument_token: "NSE_EQ|INE002A01018",
    volume: 91234,
    cp: 1405.5,
  },
  "NSE_EQ:TCS": {
    last_price: 3025.75,
    instrument_token: "NSE_EQ|INE467B01029",
    volume: 4567,
    cp: 3010.25,
  },
};

const OHLC_PAYLOAD = {
  "NSE_EQ:RELIANCE": {
    instrument_token: "NSE_EQ|INE002A01018",
    live_ohlc: { open: 1400.1, high: 1425, low: 1398.05, close: 1418.35, volume: 91234 },
  },
};

/** A getter that answers both endpoints and records every call. */
function recordingGetter(ltp: unknown = LTP_PAYLOAD, ohlc: unknown = OHLC_PAYLOAD) {
  const calls: { path: string; token: string }[] = [];
  const get = (async (path: string, token: string) => {
    calls.push({ path, token });
    return path.startsWith(UPSTOX_OHLC_PATH) ? ohlc : ltp;
  }) as UpstoxGetter;
  return { get, calls };
}

/* ───────────────────────────── instrument keys ──────────────────────────── */

describe("instrument keys — equities only, by ISIN", () => {
  it("builds SEGMENT|ISIN from the symbol, on both cash exchanges", () => {
    expect(upstoxInstrumentKey(RELIANCE, isinOf)).toBe("NSE_EQ|INE002A01018");
    expect(upstoxInstrumentKey({ symbol: "TCS", exchange: "BSE" }, isinOf)).toBe("BSE_EQ|INE467B01029");
  });

  it("sends NO derivative key — a contract keyed by an underlying's ISIN would be a wrong price", () => {
    const option: QuoteKey = { symbol: "TCS", exchange: "NFO", tradingsymbol: "TCS26SEP3000CE" };
    const future: QuoteKey = { symbol: "NIFTY", exchange: "NFO", tradingsymbol: "NIFTY26SEPFUT" };
    expect(upstoxInstrumentKey(option, isinOf)).toBeNull();
    expect(upstoxInstrumentKey(future, isinOf)).toBeNull();
    // A cash exchange with a DECORATED contract name is refused too — the same
    // test lib/quotes/mapping.ts applies before a bhavcopy may price a key.
    expect(upstoxInstrumentKey({ symbol: "TCS", exchange: "NSE", tradingsymbol: "TCS26SEP3000CE" }, isinOf)).toBeNull();
  });

  it("skips a symbol whose ISIN nothing in this build knows — never a zero, never a guess", () => {
    expect(upstoxInstrumentKey({ symbol: "NOSUCHSCRIP", exchange: "NSE" }, isinOf)).toBeNull();
    const plan = planUpstoxKeys([RELIANCE, { symbol: "NOSUCHSCRIP", exchange: "NSE" }], isinOf);
    expect(plan.instrumentKeys).toEqual(["NSE_EQ|INE002A01018"]);
    expect(plan.skippedNoIsin.map((k) => k.symbol)).toEqual(["NOSUCHSCRIP"]);
    expect(plan.skippedDerivatives).toEqual([]);
  });

  it("honours a pre-resolved instrument key on QuoteKey.token, and an ISIN in it", () => {
    expect(upstoxInstrumentKey({ symbol: "X", exchange: "NSE", token: "NSE_EQ|INE002A01018" }, () => null)).toBe(
      "NSE_EQ|INE002A01018",
    );
    expect(upstoxInstrumentKey({ symbol: "X", exchange: "NSE", token: "INE002A01018" }, () => null)).toBe(
      "NSE_EQ|INE002A01018",
    );
  });

  it("caps the request at Upstox's 500 keys instead of letting it be refused whole", () => {
    expect(UPSTOX_MAX_KEYS).toBe(500);
    expect(UPSTOX_CAPABILITIES.maxSubscriptions).toBe(UPSTOX_MAX_KEYS);
    const many: QuoteKey[] = Array.from({ length: 505 }, (_, i) => ({ symbol: `SYM${i}`, exchange: "NSE" as const }));
    const isins = (s: string) => `INE${String(s.replace("SYM", "")).padStart(3, "0")}A0101${s.length % 10}`;
    const plan = planUpstoxKeys(many, isins);
    expect(plan.instrumentKeys).toHaveLength(500);
    expect(plan.droppedOverCap).toBe(5);
    // Over 500 Upstox answers UDAPI100043 and prices NOTHING; one position too
    // many must not blank the whole desk.
    expect(new Set(plan.instrumentKeys).size).toBe(500);
  });

  it("counts derivatives and missing ISINs separately — the desk explains each differently", () => {
    const plan = planUpstoxKeys(
      [RELIANCE, { symbol: "TCS", exchange: "NFO", tradingsymbol: "TCS26SEP3000CE" }, { symbol: "WHO", exchange: "NSE" }],
      isinOf,
    );
    expect(plan.skippedDerivatives).toHaveLength(1);
    expect(plan.skippedNoIsin).toHaveLength(1);
  });
});

/* ───────────────────────────── the wire, decoded ────────────────────────── */

describe("the response is indexed by the key we SENT", () => {
  it("matches on instrument_token, not on the SEGMENT:TRADINGSYMBOL map key", () => {
    const byToken = indexByInstrumentToken(LTP_PAYLOAD);
    expect([...byToken.keys()]).toEqual(["NSE_EQ|INE002A01018", "NSE_EQ|INE467B01029"]);
    expect(byToken.get("NSE_EQ|INE002A01018")!.last_price).toBe(1418.35);
  });

  it("drops a row it cannot attribute rather than matching it by position", () => {
    const orphan: Record<string, UpstoxLtpValue> = { "NSE_EQ:RELIANCE": { last_price: 1418.35 } };
    const byToken = indexByInstrumentToken(orphan);
    expect(byToken.size).toBe(0);
  });

  it("survives a null or alien payload without throwing", () => {
    expect(indexByInstrumentToken(null).size).toBe(0);
    expect(indexByInstrumentToken(undefined).size).toBe(0);
  });
});

describe("quoteFromUpstox", () => {
  it("converts rupees to integer PAISE exactly once, and reads prevClose from cp", () => {
    const q = quoteFromUpstox(
      RELIANCE,
      LTP_PAYLOAD["NSE_EQ:RELIANCE"],
      OHLC_PAYLOAD["NSE_EQ:RELIANCE"],
      "2026-09-07T04:00:00.000Z",
    )!;
    expect(q.ltp).toBe(141835);
    expect(q.prevClose).toBe(140550);
    expect(q.dayOpen).toBe(140010);
    expect(q.dayHigh).toBe(142500);
    expect(q.dayLow).toBe(139805);
    expect(q.volume).toBe(91234);
    expect(q.source).toBe("upstox");
    expect(q.staleness).toBe("delayed");
    // NO source timestamp exists in the payload, so asOf is receipt time and
    // says nothing it was not told.
    expect(q.asOf).toBe("2026-09-07T04:00:00.000Z");
  });

  it("leaves the day figures null when no OHLC has been fetched — absent, not zero", () => {
    const q = quoteFromUpstox(TCS, { last_price: 3025.75, instrument_token: "NSE_EQ|INE467B01029" }, null, "x")!;
    expect(q.dayOpen).toBeNull();
    expect(q.dayHigh).toBeNull();
    expect(q.dayLow).toBeNull();
    expect(q.prevClose).toBeNull();
    expect(q.volume).toBeNull();
  });

  it("refuses a zero or negative last price rather than marking a position to nothing", () => {
    expect(quoteFromUpstox(TCS, { last_price: 0 }, null, "x")).toBeNull();
    expect(quoteFromUpstox(TCS, { last_price: -1 }, null, "x")).toBeNull();
    expect(quoteFromUpstox(TCS, { last_price: null }, null, "x")).toBeNull();
    expect(quoteFromUpstox(TCS, {}, null, "x")).toBeNull();
  });
});

/* ──────────────────────────────── snapshot ──────────────────────────────── */

describe("snapshot", () => {
  it("asks api.upstox.com for the comma list of instrument keys, with the token off the path", async () => {
    const { get, calls } = recordingGetter();
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => 0 });
    const map = await p.snapshot([RELIANCE, TCS]);

    expect(calls[0].path).toBe(
      `${UPSTOX_LTP_PATH}?instrument_key=NSE_EQ%7CINE002A01018,NSE_EQ%7CINE467B01029`,
    );
    expect(calls[0].token).toBe("analytics-token-123");
    // The token travels in the Authorization header the shared GET builds; it
    // must never appear in a path or a query string.
    expect(calls.every((c) => !c.path.includes("analytics-token-123"))).toBe(true);
    expect(map.get(quoteKeyId(RELIANCE))!.ltp).toBe(141835);
    expect(map.get(quoteKeyId(TCS))!.ltp).toBe(302575);
  });

  it("sends nothing at all when there is no key it can build", async () => {
    const { get, calls } = recordingGetter();
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => 0 });
    const map = await p.snapshot([{ symbol: "TCS", exchange: "NFO", tradingsymbol: "TCS26SEP3000CE" }]);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("refuses to send anything when the disclosure was never accepted", async () => {
    const { get, calls } = recordingGetter();
    const p = createUpstoxProvider({
      readGate: async () => ({ state: "disabled", reason: "The Upstox live-price disclosure has not been accepted." }),
      getImpl: get,
      isinOf,
    });
    await expect(p.snapshot([RELIANCE])).rejects.toThrow(/disclosure has not been accepted/);
    expect(calls).toHaveLength(0);
  });

  it("answers an empty key set with an empty map, not a request", async () => {
    const { get, calls } = recordingGetter();
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf });
    await expect(p.snapshot([])).resolves.toEqual(new Map());
    expect(calls).toHaveLength(0);
  });
});

/* ─────────────────────────── the once-a-minute OHLC ─────────────────────── */

describe("day OHLC is a second endpoint, called at most once a minute", () => {
  it("fetches it on the first poll and reuses it for every poll inside the minute", async () => {
    const { get, calls } = recordingGetter();
    let clock = 0;
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => clock });

    await p.snapshot([RELIANCE]);
    expect(calls.map((c) => c.path.split("?")[0])).toEqual([UPSTOX_LTP_PATH, UPSTOX_OHLC_PATH]);
    expect(calls[1].path).toContain("interval=1d");

    // Three more polls, still inside the minute: three LTP calls, no OHLC.
    for (const t of [3_000, 6_000, 59_999]) {
      clock = t;
      const map = await p.snapshot([RELIANCE]);
      // …and the day figures are still there, from the cached OHLC.
      expect(map.get(quoteKeyId(RELIANCE))!.dayHigh).toBe(142500);
    }
    expect(calls.filter((c) => c.path.startsWith(UPSTOX_OHLC_PATH))).toHaveLength(1);

    // A minute later, exactly one more.
    clock = UPSTOX_OHLC_MIN_INTERVAL_MS;
    await p.snapshot([RELIANCE]);
    expect(calls.filter((c) => c.path.startsWith(UPSTOX_OHLC_PATH))).toHaveLength(2);
  });

  it("keeps the last traded price when the OHLC call fails — the day figures are the only loss", async () => {
    const get = (async (path: string) => {
      if (path.startsWith(UPSTOX_OHLC_PATH)) throw new Error("Upstox /v3/market-quote/ohlc: HTTP 500");
      return LTP_PAYLOAD;
    }) as UpstoxGetter;
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => 0 });
    const q = (await p.snapshot([RELIANCE])).get(quoteKeyId(RELIANCE))!;
    expect(q.ltp).toBe(141835);
    expect(q.dayHigh).toBeNull();
  });
});

/* ──────────────────────────────── rate guard ────────────────────────────── */

describe("the self-imposed rate guard REFUSES, it never queues", () => {
  it("stops the 6th request in a second and says nothing was sent", async () => {
    expect(UPSTOX_RATE_LIMIT_PER_SECOND).toBe(5);
    const { get, calls } = recordingGetter();
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => 1000 });

    // Poll one: LTP + OHLC = 2 requests. Polls two and three: LTP only (the
    // OHLC is inside its minute) = 2 more. That is 4 of the 5.
    await p.snapshot([RELIANCE]);
    await p.snapshot([RELIANCE]);
    await p.snapshot([RELIANCE]);
    expect(calls).toHaveLength(4);

    await p.snapshot([RELIANCE]); // the 5th request
    expect(calls).toHaveLength(5);
    await expect(p.snapshot([RELIANCE])).rejects.toThrow(
      /rate guard stopped this request: at most 5 requests per second go to Upstox\. Nothing was sent\./,
    );
    // Refused, not queued: no sixth request was made, then or later.
    expect(calls).toHaveLength(5);
  });
});

/* ───────────────────────────────── health ───────────────────────────────── */

describe("health()", () => {
  const health = (p: ReturnType<typeof createUpstoxProvider>) => p.health() as Promise<UpstoxHealth>;

  it("says no-key when this account has no Upstox connection saved", async () => {
    const p = createUpstoxProvider({
      readGate: async () => ({ state: "no-key", reason: "No Upstox connection is saved for this account." }),
      getImpl: recordingGetter().get,
      isinOf,
    });
    const h = await health(p);
    expect(h.ok).toBe(false);
    expect(h.state).toBe("no-key");
    expect(h.reason).toMatch(/No Upstox connection is saved/);
  });

  it("says disabled when the disclosure is not acknowledged, and never throws when the gate does", async () => {
    const p = createUpstoxProvider({
      readGate: async () => {
        throw new Error("database is locked");
      },
      isinOf,
    });
    const h = await health(p);
    expect(h.ok).toBe(false);
    expect(h.state).toBe("disabled");
    expect(h.reason).toBe("database is locked");
  });

  it("names the ANALYTICS TOKEN when Upstox rejects it — not the import path's Static-IP sentence", async () => {
    const get = (async () => {
      // Verbatim from lib/import/api/upstox.ts's 401 branch, which is the right
      // sentence while SAVING a connection and the wrong one on a live desk.
      throw new Error(
        'Upstox refused the token (401). The Analytics token needs your Static IP registered at account.upstox.com → Apps → Static IPs',
      );
    }) as UpstoxGetter;
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => 0 });
    await expect(p.snapshot([RELIANCE])).rejects.toThrow(/UDAPI100050/);

    const h = await health(p);
    expect(h.ok).toBe(false);
    expect(h.state).toBe("unreachable");
    expect(h.reason).toMatch(/Analytics token/);
    expect(h.reason).toMatch(/UDAPI100050/);
    expect(h.reason).toMatch(/Import → Connect broker/);
  });

  it("reports OK, and counts what this feed cannot price instead of hiding it", async () => {
    const { get } = recordingGetter();
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => 0 });
    expect((await health(p)).ok).toBe(true);

    await p.snapshot([
      RELIANCE,
      { symbol: "TCS", exchange: "NFO", tradingsymbol: "TCS26SEP3000CE" },
      { symbol: "WHO", exchange: "NSE" },
    ]);
    const h = await health(p);
    expect(h.ok).toBe(true);
    expect(h.skippedDerivatives).toBe(1);
    expect(h.skippedNoIsin).toBe(1);
    expect(h.reason).toMatch(/2 position\(s\) are not priced by this feed/);
    expect(h.reason).toMatch(/keep their last stored mark/);
  });

  it("makes NO request of its own — the consent sheet names exactly one kind", async () => {
    const { get, calls } = recordingGetter();
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => 0 });
    await health(p);
    expect(calls).toHaveLength(0);
  });
});

describe("error messages", () => {
  it("maps the instrument-key cap to a sentence that names the cap", () => {
    const msg = upstoxFeedErrorMessage(new Error("Upstox /v3/market-quote/ltp: too many keys (UDAPI100043)"));
    expect(msg).toMatch(/UDAPI100043/);
    expect(msg).toMatch(/at most 500/);
  });

  it("passes an unrecognised failure through verbatim rather than dressing it up", () => {
    expect(upstoxFeedErrorMessage(new Error("Cannot reach Upstox: ETIMEDOUT"))).toBe(
      "Cannot reach Upstox: ETIMEDOUT",
    );
  });
});

/* ─────────────────────────────── capabilities ───────────────────────────── */

describe("the capability block", () => {
  it("promises equities, a 500 cap, a 1 s floor and a DELAYED staleness floor", () => {
    expect(UPSTOX_CAPABILITIES.id).toBe("upstox");
    expect(UPSTOX_CAPABILITIES.segments).toEqual(["NSE", "BSE"]);
    expect(UPSTOX_CAPABILITIES.maxSubscriptions).toBe(500);
    expect(UPSTOX_CAPABILITIES.minSnapshotIntervalMs).toBe(1000);
    expect(UPSTOX_CAPABILITIES.depth).toBe(0);
    // streaming:true is the ruling — subscribe() really emits, and the honesty
    // is carried by the staleness floor the desk renders.
    expect(UPSTOX_CAPABILITIES.streaming).toBe(true);
    expect(UPSTOX_CAPABILITIES.staleness).toBe("delayed");
    // The Analytics token lasts about a year, so no daily ritual is claimed.
    expect(UPSTOX_CAPABILITIES.requiresDailyAuth).toBe(false);
  });

  it("names api.upstox.com and no other host", () => {
    const hosts =
      UPSTOX_CAPABILITIES.egressDescription.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)?.map((h) => h.toLowerCase()) ?? [];
    expect([...new Set(hosts)]).toEqual(["api.upstox.com"]);
  });
});

/* ─────────────────────────────── subscribe ──────────────────────────────── */

describe("subscribe", () => {
  it("polls on the clamped interval and emits ONLY what changed", async () => {
    vi.useFakeTimers();
    try {
      let price = 1418.35;
      const get = (async (path: string) => {
        if (path.startsWith(UPSTOX_OHLC_PATH)) return OHLC_PAYLOAD;
        return { "NSE_EQ:RELIANCE": { last_price: price, instrument_token: "NSE_EQ|INE002A01018" } };
      }) as UpstoxGetter;
      let clock = 0;
      const p = createUpstoxProvider({
        readGate: async () => READY,
        getImpl: get,
        isinOf,
        now: () => clock,
        refreshSeconds: 99, // clamped to 5 s, not honoured
      });
      const seen: number[] = [];
      const stop = p.subscribe([RELIANCE], (q) => seen.push(q.ltp));

      clock = 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(seen).toEqual([141835]);

      // Same price: no second frame. Receipt time alone is not a change.
      clock = 10_000;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(seen).toEqual([141835]);

      price = 1420;
      clock = 15_000;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(seen).toEqual([141835, 142000]);

      stop();
      expect(() => stop()).not.toThrow(); // idempotent by contract
      clock = 20_000;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(seen).toEqual([141835, 142000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the request's AbortSignal fires, and never starts on an aborted one", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: recordingGetter().get, isinOf });
    const stop = p.subscribe([RELIANCE], () => {}, ctrl.signal);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });
});

/* ─────────────────── the two paths, pinned as LITERALS (A-9) ─────────────── */

/**
 * THE PATH PINS THE REST OF THE SUITE ASSUMED EXISTED.
 *
 * `tests/upstox-api.test.ts` says the shared `upstoxGet` is "held to
 * /market-quote/* only" by this file — and until v4.2's fix wave it was not:
 * the constants were only ever compared with themselves (`calls[0].path`
 * against `${UPSTOX_LTP_PATH}?…`), which stays green whatever the constant is
 * changed to. These are the literals, and the pin on what `upstoxGet` is ever
 * handed. It matters because that helper is the IPv4-pinned GET the IMPORT
 * path uses: a path built here reaches Upstox with the user's Analytics token
 * attached.
 */
describe("the market-quote paths, as literals", () => {
  it("are the two documented v3 market-quote endpoints and nothing else", () => {
    expect(UPSTOX_LTP_PATH).toBe("/v3/market-quote/ltp");
    expect(UPSTOX_OHLC_PATH).toBe("/v3/market-quote/ohlc");
    expect(UPSTOX_OHLC_PATH).toMatch(/^\/v3\/market-quote\//);
    expect(UPSTOX_LTP_PATH).toMatch(/^\/v3\/market-quote\//);
    // A path, never a URL: the host belongs to `upstoxGet` in
    // lib/import/api/upstox.ts, so there is one Upstox host in the tree.
    for (const p of [UPSTOX_LTP_PATH, UPSTOX_OHLC_PATH]) expect(p).not.toMatch(/https?:|upstox\.com/);
  });

  it("are the ONLY paths the adapter ever hands the shared GET", async () => {
    const { get, calls } = recordingGetter();
    const p = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => 0 });
    await p.snapshot([RELIANCE, TCS]);
    // A second poll a minute later, so the OHLC call is made again and both
    // branches of the once-a-minute rule are in the recorded set.
    const q = createUpstoxProvider({ readGate: async () => READY, getImpl: get, isinOf, now: () => 60_001 });
    await q.snapshot([RELIANCE]);

    expect(calls.length).toBeGreaterThanOrEqual(3);
    const paths = [...new Set(calls.map((c) => c.path.split("?")[0]))].sort();
    expect(paths).toEqual(["/v3/market-quote/ltp", "/v3/market-quote/ohlc"]);
    // Everything after the "?" is the query the adapter builds — nothing may
    // add a path segment to it.
    for (const c of calls) expect(c.path.split("?").length).toBeLessThanOrEqual(2);
  });
});

describe("the breadcrumb the Upstox messages name", () => {
  it("is Import → Connect broker, which is what the Import screen calls the card", () => {
    // The refused-token sentence is asserted above, on the health line. This
    // is the other one: the no-connection reason, which is built inside the
    // DB gate reader and so has no injectable seam (v4.2 fix A-11).
    const src = readFileSync(path.join(process.cwd(), "lib/quotes/upstox.ts"), "utf8");
    expect(src).toContain(
      "Paste your read-only Analytics token under Import → Connect broker, then pick Upstox in Settings → Live feed.",
    );
    expect(src, "the old screen name is still here").not.toContain("Import → Brokers");
  });
});
