import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/* ─────────────────────────────────────────────────────────────────────────────
 * SEAM TESTS — the v4.2 FIX WAVE (A-1 … A-13).
 *
 * Five builders owned DISJOINT files, so nothing in the wave ran the two halves
 * of a crossing value together. Every test below BUILDS the value where its
 * producer builds it (the real function against a real temp database, never a
 * literal), hands it across exactly as the product does (a `FeedInfo` field, an
 * SSE frame parsed from JSON, a JSON response body from the real route
 * handler), and asserts the CONSUMER'S OUTPUT — the sentence on the screen, the
 * mark in paise, the number of logins that reached the wire.
 *
 * NOTHING ON EITHER SIDE OF A SEAM IS MOCKED. The only stub in this file is
 * `fetch` in X5, which is the BROKER — the far side of the network, not the far
 * side of the seam; both halves under test (`load-desk.ts` and `registry.ts`)
 * run for real.
 *
 * OWNERSHIP (disjoint, by builder):
 *   B1  lib/analytics/positions.ts, components/live/load-desk.ts, desk-types.ts
 *   B2  lib/quotes/registry.ts, angelone.ts, upstox.ts
 *   B3  lib/live/stream-link.ts, components/live/desk-copy.ts, tracker-client.tsx,
 *       components/settings/live-feed-card.tsx, app/api/live/feed/route.ts
 *   B4  lib/domain/*, lib/live/connect-prompt.ts, docs/*
 *   B5  lib/quotes/manual.ts
 *
 * ── THE CROSSING VALUES ──────────────────────────────────────────────────────
 *
 * id | crossing value           | producer (file:line)                       | consumer (file:line)                          | unit / shape            | tests
 * ---|--------------------------|--------------------------------------------|-----------------------------------------------|-------------------------|-------
 * X1 | FeedInfo.symbolCount     | B1 components/live/load-desk.ts:245,454     | B3 components/live/desk-copy.ts:347            | int count of quote KEYS | X1a–e
 *    |   (deduped subscription) |    (`symbolCount = snapshotKeys.length`)    |    `deskAngelOneCadence().feedSymbolCount`     | null = "not known"      |
 * X2 | LinkState.symbolCount    | B3 app/api/live/stream/route.ts:211         | B3 lib/live/stream-link.ts:202 parseSymbolCount| int, SSE JSON `symbols` | X2a–c
 *    |   (the live frame)       |    (`symbols: keys.length`)                 | → desk-copy.ts:349 / live-feed-card.ts:~230    |                         |
 * X3 | the STORED/QUOTED mark   | B5 lib/quotes/manual.ts:127 (isCashKey)     | B1 load-desk.ts:310 storedMarkFor → DeskRow    | paise, per-unit price   | X3a–e
 *    |   of a derivative        | B1 lib/analytics/positions.ts:79            |    `markP`                                     |                         |
 * X4 | feed.blockedReason       | B3 app/api/live/feed/route.ts:256 (GET)     | B3 live-feed-card.tsx:280 feedBlockState /    | string, JSON body       | X4a–b
 *    |   + stored vs effective  | B2 lib/quotes/registry.ts resolveLiveFeed   |    feedHealthText                              |                         |
 * X5 | the live-feed INSTANCE   | B2 lib/quotes/registry.ts:457               | B1 load-desk.ts:199 getLiveFeedProvider()      | one object, one session | X5a–c
 * X6 | health.reason / state    | B2 lib/quotes/angelone.ts:389,738           | B1 load-desk.ts:251 → B3 desk pill /           | string; state enum      | X6a–b
 *    |                          |                                             | B4 lib/live/connect-prompt.ts:91              |                         |
 *
 * ONE temp database for the whole file (`lib/db` caches its connection on
 * globalThis — AGENTS.md). Everything server-only is imported DYNAMICALLY inside
 * `beforeAll`, after the helper has set `VYUHA_DB_PATH`.
 * ────────────────────────────────────────────────────────────────────────── */

/* PURE modules — none of these reaches lib/db, so a static import is safe. */
import {
  ANGELONE_CADENCE_NO_COUNT,
  angelOneCadenceLine,
  deskAngelOneCadence,
} from "@/components/live/desk-copy";
import {
  FEED_BLOCKED_HEALTH,
  REVIEW_CONSENT_CTA,
  angelOneCadenceText,
  feedBlockState,
  feedHealthText,
  type FeedState,
} from "@/components/settings/live-feed-card";
import { showConnectPrompt } from "@/lib/live/connect-prompt";
import { LINK_IDLE, createStreamLink, type LinkState, type StreamSource } from "@/lib/live/stream-link";
import type { QuoteKey } from "@/lib/quotes/types";

let t: TempDb;
let live: typeof import("@/components/live/load-desk");
let registry: typeof import("@/lib/quotes/registry");
let route: typeof import("@/app/api/live/feed/route");
let persistMark: typeof import("@/lib/quotes/persist-mark");
let disclosure: typeof import("@/lib/domain/live-feed-disclosure");
let quoteKeyId: typeof import("@/lib/quotes/types").quoteKeyId;

/** The DERIVATIVE book: an option, a short option, and two equity controls. */
const BOOK_DERIV = 1;
/** The WINDOWED book: 51 open trades over 50 distinct scrips (the tier edge). */
const BOOK_WIDE = 2;
/** The EMPTY book: nothing open. `0` is a fact; `null` is "not known". */
const BOOK_EMPTY = 3;

const OPT_TCS = "OPT TCS 30 JUN 2026 2500 CE";
const OPT_INFY = "OPT INFY 30 JUL 2026 1500 PE";
/** ₹2,057.50 — the CASH close of TCS, and the number a contract must never wear. */
const TCS_SPOT = 2057.5;
/** ₹1,450.00 — the CASH close of INFY, same trap on the short side. */
const INFY_SPOT = 1450;

/** A valid base32 TOTP secret, so `angelOneLogin` reaches `fetch` rather than throwing first. */
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function setFeed(provider: string, ack: string | null) {
  t.db.update(t.schema.settings).set({ liveFeedProvider: provider, liveFeedAckJson: ack }).run();
  registry.resetLiveFeedProviderCache();
}

function get(): Promise<Response> {
  return route.GET(new Request("http://127.0.0.1:3011/api/live/feed", { headers: { host: "127.0.0.1:3011" } }));
}

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://127.0.0.1:3011/api/live/feed", {
      method: "POST",
      headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** The GET body, as the Settings card reads it. */
interface FeedBody {
  feed: FeedState;
  health: { ok: boolean; state?: string; latencyMs: number | null; reason: string };
  angelone: { connected: boolean; ackCurrent: boolean; openCount: number };
  lastLiveMarkDate: string | null;
}

beforeAll(async () => {
  t = await openTempDb("seams-v42-fix", { seed: true });
  live = await import("@/components/live/load-desk");
  registry = await import("@/lib/quotes/registry");
  route = await import("@/app/api/live/feed/route");
  persistMark = await import("@/lib/quotes/persist-mark");
  disclosure = await import("@/lib/domain/live-feed-disclosure");
  ({ quoteKeyId } = await import("@/lib/quotes/types"));

  t.db.insert(t.schema.accounts).values([{ id: BOOK_WIDE, name: "Wide" }, { id: BOOK_EMPTY, name: "Empty" }]).run();
  t.db.update(t.schema.settings).set({ equityCapital: 5_000_000 }).run();

  // ── BOOK_DERIV — the A-1 trap, both signs, plus its equity control ────────
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        id: 401, accountId: BOOK_DERIV, symbol: "TCS", tradingsymbol: "TCS",
        isOpen: true, buyQty: 10, avgBuyPrice: 2000, buyDate: "2026-06-01",
      }),
      // The LONG option. Its `symbol` is the underlying — that IS the trap.
      tradeRow({
        id: 402, accountId: BOOK_DERIV, bucket: "active", segment: "stock_option", instrumentType: "option",
        exchange: "NFO", symbol: "TCS", tradingsymbol: OPT_TCS, optionType: "CE", strike: 2500,
        expiry: "2026-06-30", isOpen: true, buyQty: 875, avgBuyPrice: 2.75, closingPrice: 3.1,
        buyDate: "2026-06-01",
      }),
      // The SHORT option — the same seam with the sign reversed.
      tradeRow({
        id: 403, accountId: BOOK_DERIV, bucket: "active", segment: "stock_option", instrumentType: "option",
        exchange: "NFO", symbol: "INFY", tradingsymbol: OPT_INFY, optionType: "PE", strike: 1500,
        expiry: "2026-07-30", isOpen: true, sellQty: 1200, avgSellPrice: 4, closingPrice: 3.5,
        sellDate: "2026-06-02",
      }),
      // The SHORT equity control: the symbol rung is unchanged for cash.
      tradeRow({
        id: 404, accountId: BOOK_DERIV, symbol: "INFY", tradingsymbol: "INFY",
        isOpen: true, sellQty: 100, avgSellPrice: 1500, sellDate: "2026-06-02",
      }),
    ])
    .run();

  // ── BOOK_WIDE — 51 open trades, 50 distinct scrips ────────────────────────
  const wide = [];
  for (let i = 1; i <= 50; i += 1) {
    const sym = `SEAM${String(i).padStart(2, "0")}`;
    wide.push(
      tradeRow({ accountId: BOOK_WIDE, symbol: sym, tradingsymbol: sym, isOpen: true, buyQty: 10, avgBuyPrice: 100, buyDate: "2026-06-01" }),
    );
  }
  // The 51st row: a pyramided second entry in SEAM01. Two ROWS, one KEY.
  wide.push(
    tradeRow({ accountId: BOOK_WIDE, symbol: "SEAM01", tradingsymbol: "SEAM01", isOpen: true, buyQty: 5, avgBuyPrice: 104, buyDate: "2026-06-02" }),
  );
  t.db.insert(t.schema.trades).values(wide).run();

  // The stored CASH marks. Both are keyed on `symbol`, which is what makes a
  // contract's `symbol` rung dangerous: it resolves to the underlying's price.
  t.db
    .insert(t.schema.mtmPrices)
    .values([
      { symbol: "TCS", tradingsymbol: "TCS", price: TCS_SPOT, asOfDate: "2026-06-05" },
      { symbol: "INFY", tradingsymbol: "INFY", price: INFY_SPOT, asOfDate: "2026-06-05" },
    ])
    .run();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => {
  t?.cleanup();
});

/* ═══════════════════════════════════════════════════════════════════════════
 * X1 — `FeedInfo.symbolCount`: B1 counts the DEDUPED keys, B3 states the cadence
 *
 * B1 dedupes the SSR subscription on `quoteKeyId()` and publishes the count;
 * B3 prints a sentence whose interval is arithmetic over it. Neither builder
 * could see the other: the pre-wave desk printed `angelOneCadenceLine(rows.length)`
 * and the pre-wave loader handed the provider one key per POSITION. A 51-row /
 * 50-key book is exactly where those two numbers cross the cadence tier — 50
 * keys is 3 s and one call, 51 rows is 5 s and two calls — so this book proves
 * BOTH halves at once, on the sentence the user reads.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("X1 — the deduped SSR key count reaches the Angel One cadence sentence", () => {
  it("X1a  51 open trades over 50 scrips → symbolCount 50, and the desk says 3 seconds / 1 call", async () => {
    selectAccount(BOOK_WIDE);
    setFeed("eod", null);

    const data = await live.loadLiveDesk({ pro: true });

    // The producer's own output: 51 rows on the desk, 50 subscriptions.
    expect(data.rows).toHaveLength(51);
    expect(data.feed.symbolCount).toBe(50);

    // Handed across exactly as `tracker-client.tsx` hands it: no stream is open
    // yet, so the live count is null and the SSR count is what the sentence uses.
    const sentence = deskAngelOneCadence({
      providerId: "angelone",
      linkSymbolCount: null,
      feedSymbolCount: data.feed.symbolCount,
    });

    expect(sentence).toBe(
      "Refreshes every 3 seconds — Angel One allows about one request a second, and your 50 open positions take 1 call per refresh.",
    );
    // The number the desk used to print, from its ROW count — a different tier,
    // a different call count, beside a poll running at 3 s.
    expect(sentence).not.toBe(angelOneCadenceLine(data.rows.length));
    expect(sentence).not.toContain("every 5 seconds");
    expect(sentence).not.toContain("2 calls");
  });

  it("X1b  the SSR count is the same number the stream route subscribes with", async () => {
    selectAccount(BOOK_WIDE);
    setFeed("eod", null);

    const data = await live.loadLiveDesk({ pro: true });
    // `openPositionKeys()` is the rule `app/api/live/stream/route.ts` applies to
    // the same book (persist-mark.ts holds the shared copy). One sentence on two
    // surfaces requires one denominator; this is that denominator, twice.
    const streamKeys = await persistMark.openPositionKeys();

    expect(data.feed.symbolCount).toBe(streamKeys.length);
    expect(new Set(streamKeys.map(quoteKeyId)).size).toBe(50);
  });

  it("X1c  a book with nothing open publishes 0 — a fact — and the sentence says 0", async () => {
    selectAccount(BOOK_EMPTY);
    setFeed("eod", null);

    const data = await live.loadLiveDesk({ pro: true });

    expect(data.rows).toHaveLength(0);
    // 0, NOT null: the provider was asked for nothing and answered. The desk
    // knows the size of this book, and it is zero.
    expect(data.feed.symbolCount).toBe(0);
    expect(
      deskAngelOneCadence({ providerId: "angelone", linkSymbolCount: null, feedSymbolCount: data.feed.symbolCount }),
    ).toBe(
      "Refreshes every 3 seconds — Angel One allows about one request a second, and your 0 open positions take 1 call per refresh.",
    );
  });

  it("X1d  a provider that THREW publishes null, and the sentence states no count at all", async () => {
    selectAccount(BOOK_WIDE);
    // Angel One, consented, with no connection saved: `snapshot()` throws the
    // gate's reason before any count exists. Inventing 0 here would state that
    // this account's book is empty (invariant 6).
    setFeed("angelone", disclosure.withFeedAck(null, "angelone"));

    const data = await live.loadLiveDesk({ pro: true });

    expect(data.feed.providerId).toBe("angelone");
    expect(data.feed.symbolCount).toBeNull();
    expect(
      deskAngelOneCadence({ providerId: "angelone", linkSymbolCount: null, feedSymbolCount: data.feed.symbolCount }),
    ).toBe(ANGELONE_CADENCE_NO_COUNT);
    // …and the countless sentence names no interval, because there is none.
    expect(ANGELONE_CADENCE_NO_COUNT).not.toMatch(/every \d+ seconds/);
  });

  it("X1e  at 00:15 IST (18:45 UTC the day before) the count is unmoved and the day has rolled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 2026-06-30T18:45:00Z is 2026-07-01T00:15 IST — the day boundary the desk
    // must cross with the IST date, not the UTC one.
    vi.setSystemTime(new Date("2026-06-30T18:45:00.000Z"));
    selectAccount(BOOK_WIDE);
    setFeed("eod", null);

    const data = await live.loadLiveDesk({ pro: true });

    expect(data.today).toBe("2026-07-01");
    expect(data.feed.symbolCount).toBe(50);
    expect(
      deskAngelOneCadence({ providerId: "angelone", linkSymbolCount: null, feedSymbolCount: data.feed.symbolCount }),
    ).toContain("your 50 open positions take 1 call");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * X2 — the LIVE frame's `symbols`: the stream route's number, through
 * `stream-link.ts`, into the SAME sentence the Settings card prints.
 *
 * The frame is built here exactly as `app/api/live/stream/route.ts:211` builds
 * it (`symbols: keys.length`, inside the `snapshot` event) and is handed over
 * the wire as the wire really carries it: a JSON STRING on a MessageEvent.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The three `EventSource` members the link uses, and nothing else. */
class FakeSource implements StreamSource {
  readyState = 1;
  private readonly listeners = new Map<string, ((ev: Event) => void)[]>();
  addEventListener(type: string, listener: (ev: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  close(): void {
    this.readyState = 2;
  }
  /** A named SSE frame. `data` is serialised, because the wire serialises it. */
  emit(type: string, data?: unknown): void {
    const ev = (data === undefined ? {} : { data: JSON.stringify(data) }) as unknown as Event;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

function linkHarness() {
  const sources: FakeSource[] = [];
  const states: LinkState[] = [];
  const link = createStreamLink<ReturnType<typeof setTimeout>>({
    createSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    isHidden: () => false,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
    schedulePaint: () => 1,
    cancelPaint: () => {},
    random: () => 0,
    onState: (s) => states.push(s),
    onQuotes: () => {},
  });
  return { link, sources, states, last: () => states.at(-1) ?? LINK_IDLE };
}

/** The snapshot frame the route sends, for a subscription of `n` keys. */
function snapshotFrame(n: number) {
  return {
    accountId: BOOK_WIDE,
    provider: "angelone",
    capabilities: { id: "angelone", streaming: true },
    health: { ok: true },
    marketOpen: true,
    symbols: n,
    // One real quote, in the shape the route serialises: "live" is earned by a
    // quote-bearing frame, and a snapshot with none is only "connected".
    quotes: [
      {
        key: { symbol: "SEAM01", exchange: "NSE", tradingsymbol: "SEAM01" },
        ltp: 10_400,
        prevClose: 10_000,
        asOf: "2026-09-07T05:00:00.000Z",
        staleness: "delayed",
      },
    ],
  };
}

describe("X2 — the open stream's own count outranks the server render's, and both surfaces say one sentence", () => {
  it("X2a  the snapshot frame's `symbols` becomes LinkState.symbolCount and survives the ticks after it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T05:00:00.000Z")); // 10:30 IST, a Monday
    const h = linkHarness();
    h.link.open();

    h.sources[0].emit("snapshot", snapshotFrame(50));
    expect(h.last().symbolCount).toBe(50);
    expect(h.last().phase).toBe("live");

    // Every later frame carries no count; the last stated one must stand, or the
    // sentence would blink back to "no count" on the first heartbeat.
    h.sources[0].emit("heartbeat", { at: Date.now() });
    expect(h.last().symbolCount).toBe(50);

    // A count is a fact about a CONNECTION: putting the feed down drops it, so
    // nothing carries a stale subscription size into the next one.
    h.link.pause();
    expect(h.last().phase).toBe("paused");
    expect(h.last().symbolCount).toBeNull();
  });

  it("X2b  the live count wins over a stale SSR count, and the desk sentence is byte-identical to the card's", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T05:00:00.000Z"));
    selectAccount(BOOK_WIDE);
    setFeed("eod", null);
    // The SSR count, from the real loader — one page render older than the frame.
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.feed.symbolCount).toBe(50);

    const h = linkHarness();
    h.link.open();
    // The stream is subscribed to a WIDER book than the render captured (the
    // user opened a position in another tab). 51 keys crosses the tier.
    h.sources[0].emit("snapshot", snapshotFrame(51));

    const desk = deskAngelOneCadence({
      providerId: "angelone",
      linkSymbolCount: h.last().symbolCount,
      feedSymbolCount: data.feed.symbolCount,
    });
    // The poll that is actually running is the 51-key one, so the sentence is its.
    expect(desk).toBe(
      "Refreshes every 5 seconds — Angel One allows about one request a second, and your 51 open positions take 2 calls per refresh.",
    );
    expect(desk).not.toBe(angelOneCadenceLine(data.feed.symbolCount));

    // Ruling 4.2-4: ONE sentence on both surfaces. The Settings card builds it
    // from the route's own `angelone.openCount`; byte-identical or it is two.
    expect(angelOneCadenceText({ connected: true, ackCurrent: true, openCount: 51 })).toBe(desk);
  });

  it("X2c  the tier edge is the KEY count: 50 and 51 are different sentences on both surfaces", () => {
    const at50 = deskAngelOneCadence({ providerId: "angelone", linkSymbolCount: 50, feedSymbolCount: null });
    const at51 = deskAngelOneCadence({ providerId: "angelone", linkSymbolCount: 51, feedSymbolCount: null });
    expect(at50).toContain("every 3 seconds");
    expect(at51).toContain("every 5 seconds");
    expect(at50).not.toBe(at51);
    expect(angelOneCadenceText({ connected: true, ackCurrent: true, openCount: 50 })).toBe(at50);
    expect(angelOneCadenceText({ connected: true, ackCurrent: true, openCount: 51 })).toBe(at51);
    // A provider that is not Angel One states no cadence at all.
    expect(deskAngelOneCadence({ providerId: "upstox", linkSymbolCount: 50, feedSymbolCount: 50 })).toBeNull();
    // The card, before its own fetch has answered, says so rather than "0".
    expect(angelOneCadenceText(undefined)).not.toContain("0 open positions");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * X3 — the mark of a derivative: B5's QUOTE door and B1's STORED door together.
 *
 * `mtm_prices` is keyed on `symbol`, and a derivative trade carries its
 * UNDERLYING there. There are TWO doors into that map on the desk and they were
 * fixed by two different builders: the manual provider's `snapshot()` (B5,
 * `isCashKey`) and `storedMarkFor()` (B1). A quote OUTRANKS a stored mark in
 * `load-desk.ts`, so either door alone still prints the underlying's cash price
 * as the contract's premium. Only both halves together give the right number,
 * which is why this test exists and neither builder's own tests can be it.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("X3 — a contract is never priced at its underlying's cash mark, through BOTH doors", () => {
  it("X3a  the LONG option reads its own close, not TCS spot, with the real manual provider running", async () => {
    selectAccount(BOOK_DERIV);
    setFeed("manual", null);

    const data = await live.loadLiveDesk({ pro: true });
    expect(data.feed.providerId).toBe("manual");

    const opt = data.rows.find((r) => r.id === 402);
    // ₹3.10, the contract's own recorded close, in paise (invariant 1).
    expect(opt?.markP).toBe(310);
    // ₹2,057.50 — the underlying's cash mark. It reached this row through the
    // quote door before B5 and through the stored door before B1.
    expect(opt?.markP).not.toBe(205_750);
    // 875 × (₹3.10 − ₹2.75) = ₹306.25 — not the +₹17,97,906.25 spot printed.
    expect(opt?.unrealisedP).toBe(30_625);
    expect(opt?.unrealisedP).not.toBe(179_790_625);
  });

  it("X3b  the SHORT option too — the wrong mark reverses the sign as well as the size", async () => {
    selectAccount(BOOK_DERIV);
    setFeed("manual", null);

    const data = await live.loadLiveDesk({ pro: true });
    const short = data.rows.find((r) => r.id === 403);

    expect(short?.side).toBe("short");
    // ₹3.50, its own close.
    expect(short?.markP).toBe(350);
    expect(short?.markP).not.toBe(145_000); // INFY spot, in paise
    // Short profits when the premium falls: 1200 × (₹4.00 − ₹3.50) = ₹600.
    expect(short?.unrealisedP).toBe(60_000);
    // The underlying's cash mark would have printed a loss of ₹17,35,200 on a
    // position that is ₹600 up — the sign itself is wrong, not just the size.
    expect(short!.unrealisedP).toBeGreaterThan(0);
  });

  it("X3c  the EQUITY controls are unchanged — long and short both still read the cash mark", async () => {
    selectAccount(BOOK_DERIV);
    setFeed("manual", null);

    const data = await live.loadLiveDesk({ pro: true });
    const longEq = data.rows.find((r) => r.id === 401);
    const shortEq = data.rows.find((r) => r.id === 404);

    expect(longEq?.markP).toBe(205_750);
    expect(longEq?.staleness).toBe("manual");
    expect(shortEq?.markP).toBe(145_000);
    expect(shortEq?.side).toBe("short");
    // 100 × (₹1,500 − ₹1,450) = ₹5,000 to the good on a short.
    expect(shortEq?.unrealisedP).toBe(500_000);
  });

  it("X3d  the manual provider's own door refuses the contract key and answers the cash key", async () => {
    selectAccount(BOOK_DERIV);
    setFeed("manual", null);

    // The REAL provider the desk just used, built by the REAL registry.
    const provider = await registry.getLiveFeedProvider();
    const cash: QuoteKey = { symbol: "TCS", exchange: "NSE", tradingsymbol: "TCS" };
    const contract: QuoteKey = { symbol: "TCS", exchange: "NFO", tradingsymbol: OPT_TCS };

    const snap = await provider.snapshot([cash, contract]);

    expect(snap.get(quoteKeyId(cash))?.ltp).toBe(205_750);
    // No mark is not a zero mark: the contract is simply absent, so the desk
    // falls through to its own close instead of wearing TCS's price.
    expect(snap.has(quoteKeyId(contract))).toBe(false);
  });

  it("X3e  the licence changes nothing about the mark — free and Pro price the book identically", async () => {
    selectAccount(BOOK_DERIV);
    setFeed("manual", null);

    const pro = await live.loadLiveDesk({ pro: true });
    const free = await live.loadLiveDesk({ pro: false });

    expect(free.rows.map((r) => [r.id, r.markP])).toEqual(pro.rows.map((r) => [r.id, r.markP]));
    expect(free.rows.find((r) => r.id === 402)?.markP).toBe(310);
    // …and the Pro-only figures still leave as null on the free wire (Q55).
    expect(free.heat).toBeNull();
    expect(pro.heat).not.toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * X4 — a BLOCKED feed: the route's verdict, through the JSON body, into the
 * card's block and its health line.
 *
 * `resolveLiveFeed()` (B2) falls back to `eod` when the stored pick's
 * acknowledgement is not current, and the route (B3) publishes `blockedReason`
 * for every provider. The card rendered it only for OpenAlgo, and its health
 * line described the EFFECTIVE provider — so a blocked Upstox showed a checked
 * radio and a health line about end-of-day. The two halves are run together
 * here through the REAL handler on the REAL database, never a fixture.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("X4 — the route's blocked verdict reaches the card's block and its health line", () => {
  it("X4a  stored Upstox with no acknowledgement → blocked, with the route's own sentence and a way back to the sheet", async () => {
    selectAccount(BOOK_DERIV);
    t.db.delete(t.schema.brokerConnections).run();
    t.db
      .insert(t.schema.brokerConnections)
      .values({ accountId: BOOK_DERIV, broker: "upstox", apiKey: "k", accessToken: "tok" })
      .run();
    setFeed("upstox", null);

    const body = (await (await get()).json()) as FeedBody;

    // The producer: the pick is stored, and it is NOT what runs.
    expect(body.feed.stored).toBe("upstox");
    expect(body.feed.effective).toBe("eod");
    expect(body.feed.blockedReason).toBeTruthy();

    // The consumer, on the value exactly as the wire carried it.
    const block = feedBlockState(body.feed);
    expect(block).not.toBeNull();
    expect(block?.reason).toBe(body.feed.blockedReason);
    expect(block?.reviewProvider).toBe("upstox");
    expect(REVIEW_CONSENT_CTA).toBe("Review and accept");

    // The health line states the PICK, not the fallback that is running.
    const line = feedHealthText({ health: body.health, blocked: block !== null, lastLiveMarkDate: body.lastLiveMarkDate });
    expect(line).toBe(FEED_BLOCKED_HEALTH);
    expect(line).not.toContain("Feed OK");
    // `body.health` is END-OF-DAY's health — the sentence the card used to print
    // over a feed the user picked and was not getting.
    expect(line).not.toContain(body.health.reason);
  });

  it("X4b  accepting the sheet through the real route unblocks it, and the health line goes back to describing the feed", async () => {
    selectAccount(BOOK_DERIV);
    expect((await post({ action: "ack", provider: "upstox" })).status).toBe(200);
    registry.resetLiveFeedProviderCache();

    const body = (await (await get()).json()) as FeedBody;

    expect(body.feed.stored).toBe("upstox");
    expect(body.feed.effective).toBe("upstox");
    expect(body.feed.blockedReason).toBeUndefined();

    const block = feedBlockState(body.feed);
    expect(block).toBeNull();
    // The health line goes back to describing the running feed — which is now
    // the one the user picked, so "Feed OK" is finally a true sentence about it.
    const line = feedHealthText({ health: body.health, blocked: false, lastLiveMarkDate: null });
    expect(line).not.toBe(FEED_BLOCKED_HEALTH);
    expect(body.health.ok).toBe(true);
    expect(line).toMatch(/^Feed OK/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * X5 — ONE live-feed instance per process, counted in LOGINS.
 *
 * The consent sheet says Vyuha "signs in once each trading day". Before A-2,
 * `getLiveFeedProvider()` built a fresh adapter per CALLER, and the session
 * lives inside the adapter — so the SSR desk load and the stream open were two
 * sign-ins on one visit. This runs the two REAL callers against one temp
 * database and counts the requests that reach the wire. `fetch` is stubbed
 * because it is the BROKER; both sides of the seam are the real modules.
 * ══════════════════════════════════════════════════════════════════════════ */
function connectAngelOne(apiKey: string, updatedAt?: string) {
  t.db.delete(t.schema.brokerConnections).run();
  t.db
    .insert(t.schema.brokerConnections)
    .values({
      accountId: BOOK_DERIV,
      broker: "angelone",
      apiKey,
      accessToken: "",
      authJson: JSON.stringify({ clientCode: "C1", pin: "1234", totpSecret: TOTP_SECRET }),
      ...(updatedAt ? { updatedAt } : {}),
    })
    .run();
}

/** Counts the sign-ins that reached the wire. Angel One refuses every one. */
function countLogins(): { logins: () => number } {
  let logins = 0;
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String((input as { url?: string })?.url ?? input);
    if (url.includes("loginByPassword")) logins += 1;
    return new Response(JSON.stringify({ status: false, message: "refused by the seam test", errorcode: "AB1004" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { logins: () => logins };
}

describe("X5 — the SSR desk and the next caller share ONE Angel One session", () => {
  it("X5a  loadLiveDesk() and a second getLiveFeedProvider() are one instance and ONE sign-in", async () => {
    selectAccount(BOOK_DERIV);
    connectAngelOne("api-key-1");
    setFeed("angelone", disclosure.withFeedAck(null, "angelone"));
    const c = countLogins();

    // Caller 1 — the SSR desk load (B1), for real, all the way to the adapter.
    const first = await registry.getLiveFeedProvider();
    await live.loadLiveDesk({ pro: true });
    // Caller 2 — the stream route's acquisition, i.e. the registry again.
    const second = await registry.getLiveFeedProvider();
    await second.snapshot([{ symbol: "TCS", exchange: "NSE", tradingsymbol: "TCS" }]).catch(() => new Map());

    // The session, the retry stamp and the rate guard live INSIDE the adapter,
    // so the number of INSTANCES is the number of sign-ins. One visit, one
    // sign-in — which is the sentence the consent sheet prints.
    expect(c.logins()).toBe(1);
    expect(second).toBe(first);
  });

  it("X5b  a re-saved credential builds a NEW instance, and that one signs in again", async () => {
    selectAccount(BOOK_DERIV);
    connectAngelOne("api-key-1");
    setFeed("angelone", disclosure.withFeedAck(null, "angelone"));
    const c = countLogins();

    const before = await registry.getLiveFeedProvider();
    await before.snapshot([{ symbol: "TCS", exchange: "NSE", tradingsymbol: "TCS" }]).catch(() => new Map());
    expect(c.logins()).toBe(1);

    // The user pastes a new PIN. The cache key carries the row's id, its
    // `updated_at` and a digest of the stored ciphertext, so this must not be
    // served the session minted from the old credential.
    connectAngelOne("api-key-2", "2030-01-01T00:00:00.000Z");
    const after = await registry.getLiveFeedProvider();
    expect(after).not.toBe(before);

    await after.snapshot([{ symbol: "TCS", exchange: "NSE", tradingsymbol: "TCS" }]).catch(() => new Map());
    expect(c.logins()).toBe(2);
  });

  it("X5c  a new acknowledgement, and an explicit reset, each drop the shared instance", async () => {
    selectAccount(BOOK_DERIV);
    connectAngelOne("api-key-1");
    setFeed("angelone", disclosure.withFeedAck(null, "angelone"));

    const base = await registry.getLiveFeedProvider();
    expect(await registry.getLiveFeedProvider()).toBe(base);

    // A consent written through the REAL route handler.
    expect((await post({ action: "ack", provider: "upstox" })).status).toBe(200);
    const afterAck = await registry.getLiveFeedProvider();
    expect(afterAck).not.toBe(base);

    registry.resetLiveFeedProviderCache();
    expect(await registry.getLiveFeedProvider()).not.toBe(afterAck);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * X6 — the adapter's own sentence and its STATE, through the loader, onto the
 * desk pill and into B4's connect prompt.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("X6 — the broker's health crosses into the desk", () => {
  it("X6a  the adapter's no-connection sentence reaches the desk pill naming a screen that exists (A-11)", async () => {
    selectAccount(BOOK_WIDE); // an account with no Angel One connection
    t.db.delete(t.schema.brokerConnections).run();
    setFeed("angelone", disclosure.withFeedAck(null, "angelone"));

    const data = await live.loadLiveDesk({ pro: true });

    expect(data.feed.providerId).toBe("angelone");
    // The string is written in lib/quotes/angelone.ts (B2) and read on the desk
    // (B1 → B3). B4 renamed the breadcrumb in the docs and the copy modules;
    // this is the runtime path that proves the rename reached the pill.
    expect(data.feed.reason).toContain("Import → Connect broker");
    expect(data.feed.reason).not.toContain("Import → Brokers");
  });

  it("X6b  DEFECT — the desk reports `disabled` where the same provider tells the route `no-key`, so the connect prompt can never fire", async () => {
    selectAccount(BOOK_WIDE);
    t.db.delete(t.schema.brokerConnections).run();
    setFeed("angelone", disclosure.withFeedAck(null, "angelone"));

    // The SAME provider, the SAME database, two surfaces.
    const body = (await (await get()).json()) as FeedBody;
    const data = await live.loadLiveDesk({ pro: true });

    // The route asks `provider.health()` directly and gets the truth.
    expect(body.health.state).toBe("no-key");

    // The desk asks `snapshot()` FIRST; with an open book the adapter throws the
    // gate's reason, and `load-desk.ts:250` rebuilds health from the message
    // alone — the `state` is lost and `desk-types.ts` falls back to "disabled".
    // Q24's once-a-day prompt only fires on `no-key` / `unreachable`, so the one
    // prompt that would send the user to the screen the pill names is dead
    // for exactly the state it exists for.
    expect(data.feed.healthState).toBe("no-key");
    expect(showConnectPrompt({ providerId: data.feed.providerId, healthState: data.feed.healthState }, null)).toBe(true);
  });
});
