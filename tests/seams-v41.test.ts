/**
 * v4.1.0 WAVE SEAMS — the crossings no single builder ran both halves of.
 *
 * The wave was cut into disjoint file sets (A feed-flag, B copy, C results_date
 * + lockedInProfit, D sizing + atlas, E e2e). Disjoint sets prevent edit
 * conflicts; they also guarantee that nobody executed the two halves of a
 * crossing together. This file does exactly that, and nothing else: it MOCKS
 * NEITHER SIDE and it changes no production code.
 *
 * ┌ THE SEAM TABLE ────────────────────────────────────────────────────────────
 * │ crossing value          producer (file:line)                consumer (file:line)                      unit        test
 * │ 1–5 s refresh bound     lib/quotes/openalgo.ts:57-58        lib/domain/openalgo-disclosure.ts:126     seconds     "the 1-5 s cadence the disclosure states is the cadence the adapter clamps to"
 * │ 10 req/s ceiling        lib/quotes/openalgo.ts:61           lib/domain/openalgo-disclosure.ts:126     req/second  "the 10 req/s ceiling is stated and enforced"
 * │ request body keys       lib/quotes/openalgo.ts:319/351-355  lib/domain/openalgo-disclosure.ts:136     JSON keys   "the body carries apikey + symbols[{symbol,exchange}] and nothing else"
 * │ /funds probe            lib/quotes/openalgo.ts:444          lib/domain/openalgo-disclosure.ts:146     path        "health() posts to /funds exactly once"
 * │ maxSubscriptions 500    lib/quotes/openalgo.ts:82           lib/domain/openalgo-disclosure.ts:136     count       "the 500 cap the disclosure quotes is the cap the request obeys"
 * │ default host            lib/domain/openalgo-disclosure.ts:42 lib/quotes/openalgo.ts (normalizeHost)   URL         "the address the disclosure names is the address the request goes to"
 * │ start/stop with desk    lib/quotes/openalgo.ts:413-421      lib/domain/openalgo-disclosure.ts:126     -           "the poll starts when the desk opens and stops when it closes"
 * │ OPENALGO_DISCLOSURE_VERSION lib/domain/openalgo-disclosure.ts:35 app/api/live/feed/route.ts:150       string      "the disclosure version is the version the route enforces"
 * │ egressDescription hosts lib/quotes/*.ts (capabilities)      docs/client/PRIVACY.md:47,72              hostname    "no shipped capability names a non-loopback host but nsearchives"
 * │ OPENALGO_DEFAULT_HOST   lib/domain/openalgo-disclosure.ts:42 docs/client/PRIVACY.md:72 + help-content unit-string "PRIVACY item 3 and the /live help name the constant's address"
 * │ instruments.results_date app/api/instruments/route.ts:86    components/live/load-desk.ts:298          ISO date    "a results date written on /instruments reaches the desk row, free AND Pro"
 * │ resultsDate -> chip     components/live/load-desk.ts:298    lib/live/results-date.ts + desk-copy.ts   days        "the chip counts from the desk's own IST today, across the 18:30 UTC boundary"
 * │ lockedInProfitP         lib/live/heat.ts:127                components/live/desk-copy.ts:163          paise       "locked-in profit is stated, not netted, and is Pro-gated at the wire"
 * │ compareAll rows         lib/risk/sizing.ts:896              components/sizing/lab-config.ts:212       qty         "the volatility pair re-reads compareAll and never re-computes it differently"
 * │ bundled map bytes       lib/data/*.json                     lib/queries/atlas.ts:136                  sha256      "the digests describe the exact JSON objects the sector chain grouped by"
 * │ OPENALGO_FEED_ENABLED   lib/quotes/types.ts:61              live-feed-card.tsx:108 + feed route GET   boolean     "one flag, three files, one answer"
 * └────────────────────────────────────────────────────────────────────────────
 *
 * ONE temp database for the whole file — `lib/db` caches its connection on
 * globalThis, so every DB-reaching module is imported DYNAMICALLY after
 * `openTempDb()` has set `VYUHA_DB_PATH`. Pure modules (the disclosure, heat,
 * desk-copy/format, results-date, lab-config, sizing, quotes/types) are static
 * imports: none of them touches a database.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

// ── Pure halves, imported for real (never mocked) ────────────────────────────
import {
  OPENALGO_DEFAULT_HOST,
  OPENALGO_DISCLOSURE_VERSION,
  OPENALGO_FEED_ITEMS,
  isLocalOpenAlgoHost,
} from "@/lib/domain/openalgo-disclosure";
import {
  OPENALGO_CAPABILITIES,
  RATE_LIMIT_PER_SECOND,
  REFRESH_SECONDS_MAX,
  REFRESH_SECONDS_MIN,
  clampRefreshSeconds,
  createOpenAlgoProvider,
  createRateGuard,
  type FeedGateReader,
} from "@/lib/quotes/openalgo";
import { OPENALGO_FEED_ENABLED, type QuoteKey } from "@/lib/quotes/types";
import { portfolioHeat, type HeatRow } from "@/lib/live/heat";
import { lockedInAtStop, resultsChip } from "@/components/live/desk-copy";
import { money } from "@/components/live/desk-format";
import { daysToResults } from "@/lib/live/results-date";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import {
  VOLATILITY_VARIANTS,
  buildSetup,
  sampleInputs,
  volatilityVariants,
} from "@/components/sizing/lab-config";
import { compareAll, sizePctVolatility, sizeVolatilityUnit } from "@/lib/risk/sizing";
// Data, not code: importing the JSON binds no database connection.
import nseIndexMapJson from "@/lib/data/nse-index-map.json";
import sectorMapJson from "@/lib/data/sector-map.json";

const ROOT = path.resolve(__dirname, "..");
const PRIVACY = fs.readFileSync(path.join(ROOT, "docs/client/PRIVACY.md"), "utf8");

let t: TempDb;
let feedRoute: typeof import("@/app/api/live/feed/route");
let instrumentsRoute: typeof import("@/app/api/instruments/route");
let registry: typeof import("@/lib/quotes/registry");
let atlas: typeof import("@/lib/queries/atlas");
let instrumentQueries: typeof import("@/lib/queries/instruments");
let live: typeof import("@/components/live/load-desk");
let card: typeof import("@/components/settings/live-feed-card");

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const PRIMARY = 1;
let TCS_INSTRUMENT = 0;

beforeAll(async () => {
  t = await openTempDb("seams-v41", { seed: true });
  feedRoute = await import("@/app/api/live/feed/route");
  instrumentsRoute = await import("@/app/api/instruments/route");
  registry = await import("@/lib/quotes/registry");
  atlas = await import("@/lib/queries/atlas");
  instrumentQueries = await import("@/lib/queries/instruments");
  live = await import("@/components/live/load-desk");
  card = await import("@/components/settings/live-feed-card");

  // The desk's book. The trade row spells the ticker in LOWER case and the
  // instruments row in UPPER case — the join in load-desk.ts is on the
  // upper-cased symbol, and that asymmetry IS seam 4.
  t.db.update(t.schema.settings).set({ selectedAccountId: 0, equityCapital: 1_000_000 }).run();
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        id: 501,
        accountId: PRIMARY,
        symbol: "tcs",
        tradingsymbol: "tcs",
        isOpen: true,
        buyQty: 10,
        avgBuyPrice: 3000,
        buyDate: "2026-08-01",
        slPlanned: 2800,
        trailingSl: 3200, // trailed BEYOND entry — the locked-in-profit row
        riskAmount: 2000,
      }),
      tradeRow({
        id: 502,
        accountId: PRIMARY,
        symbol: "infy",
        tradingsymbol: "infy",
        isOpen: true,
        buyQty: 20,
        avgBuyPrice: 1500,
        buyDate: "2026-08-04",
        slPlanned: 1400, // stop still below entry — real risk
      }),
    ])
    .run();
  t.sqlite.prepare("INSERT INTO instruments (symbol, sector) VALUES ('TCS','IT')").run();
  TCS_INSTRUMENT = (t.sqlite.prepare("SELECT id FROM instruments WHERE symbol='TCS'").get() as { id: number }).id;
});

afterAll(() => {
  vi.useRealTimers();
  t?.cleanup();
});

/** Back to the shipped default, so one seam's write cannot colour the next. */
function resetFeed() {
  t.db
    .update(t.schema.settings)
    .set({ liveFeedProvider: "eod", openalgoEnabled: false, openalgoAckVersion: null })
    .run();
}

function feedPost(body: unknown): Promise<Response> {
  return feedRoute.POST(
    new Request("http://127.0.0.1:3011/api/live/feed", {
      method: "POST",
      headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function instrumentsPost(body: unknown): Promise<Response> {
  return instrumentsRoute.POST(
    new Request("http://local/api/instruments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   SEAM 1 — B's disclosure sentences vs A's adapter, run together
   ══════════════════════════════════════════════════════════════════════════
   Every factual claim in OPENALGO_FEED_ITEMS is a claim about lib/quotes/
   openalgo.ts. The numbers are EXTRACTED from the prose with regexes and
   compared to the constants, so an edit to either half reddens this. */

const FEED_TEXT = OPENALGO_FEED_ITEMS.map((i) => `${i.title}\n${i.body}`).join("\n\n");

function claim(re: RegExp): RegExpMatchArray {
  const m = FEED_TEXT.match(re);
  if (!m) throw new Error(`OPENALGO_FEED_ITEMS no longer states ${re} — the disclosure dropped a claim the adapter still makes`);
  return m;
}

const READY_GATE: FeedGateReader = async () => ({
  state: "ready",
  creds: { apiKey: "seam-key-123", host: OPENALGO_DEFAULT_HOST },
});

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

/** A real fetch stand-in for the WIRE, not for either side of the seam. */
function recorder(payload: unknown = { status: "success", data: [] }) {
  const sent: Sent[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, impl };
}

const KEY = (symbol: string): QuoteKey => ({ symbol, exchange: "NSE", tradingsymbol: symbol });

describe("seam 1 — every factual claim in the OpenAlgo disclosure, against the adapter that performs it", () => {
  it("the 1-5 s cadence the disclosure states is the cadence the adapter clamps to", () => {
    const title = claim(/every (\d+) to (\d+) seconds/);
    const body = claim(/outside (\d+) to (\d+) seconds is clamped/);
    expect(Number(title[1]), "the disclosure's floor is not REFRESH_SECONDS_MIN").toBe(REFRESH_SECONDS_MIN);
    expect(Number(title[2]), "the disclosure's ceiling is not REFRESH_SECONDS_MAX").toBe(REFRESH_SECONDS_MAX);
    expect([Number(body[1]), Number(body[2])]).toEqual([REFRESH_SECONDS_MIN, REFRESH_SECONDS_MAX]);
    // ...and the clamp really clamps to those, on both sides and off the end.
    expect(clampRefreshSeconds(0)).toBe(REFRESH_SECONDS_MIN);
    expect(clampRefreshSeconds(-9)).toBe(REFRESH_SECONDS_MIN);
    expect(clampRefreshSeconds(99)).toBe(REFRESH_SECONDS_MAX);
    expect(clampRefreshSeconds("not a number")).toBe(3);
    expect(OPENALGO_CAPABILITIES.minSnapshotIntervalMs).toBe(REFRESH_SECONDS_MIN * 1000);
  });

  it("the 10 req/s ceiling the disclosure quotes is the ceiling the guard enforces, by refusing", () => {
    const n = Number(claim(/more than (\d+) requests a second/)[1]);
    expect(n, "the sentence and RATE_LIMIT_PER_SECOND disagree").toBe(RATE_LIMIT_PER_SECOND);
    const guard = createRateGuard();
    for (let i = 0; i < n; i++) expect(guard.take(0), `request ${i + 1} inside the window`).toBe(true);
    expect(guard.take(0), "the guard queued the 11th instead of refusing it").toBe(false);
    expect(guard.take(1000), "the window never rolled").toBe(true);
  });

  it("the body carries apikey + symbols[{symbol,exchange}] and nothing about the book", async () => {
    claim(/holds your OpenAlgo API key and a list of the trading symbols and exchanges/);
    const { sent, impl } = recorder({ status: "success", data: [{ symbol: "TCS", exchange: "NSE", ltp: 3100.5 }] });
    const provider = createOpenAlgoProvider({ readGate: READY_GATE, fetchImpl: impl });
    const out = await provider.snapshot([KEY("TCS")]);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${OPENALGO_DEFAULT_HOST}/api/v1/multiquotes`);
    expect(Object.keys(sent[0].body).sort(), "a key beyond apikey/symbols reached the bridge").toEqual([
      "apikey",
      "symbols",
    ]);
    const symbols = sent[0].body.symbols as Record<string, unknown>[];
    expect(Object.keys(symbols[0]).sort()).toEqual(["exchange", "symbol"]);
    expect(symbols[0]).toEqual({ symbol: "TCS", exchange: "NSE" });
    // The disclosure's list of what is NOT in the body, held to the bytes.
    const wire = JSON.stringify(sent[0].body);
    for (const banned of ["qty", "quantity", "avgEntry", "riskAmount", "accountId", "pnl", "stop"]) {
      expect(wire.toLowerCase().includes(banned.toLowerCase()), `the body leaked ${banned}`).toBe(false);
    }
    // And the price survived the crossing as PAISE, once (invariant 1).
    expect([...out.values()][0].ltp).toBe(310_050);
  });

  it("health() posts to /funds exactly once — the whole of the probe the disclosure describes", async () => {
    claim(/calls OpenAlgo's \/funds endpoint once/);
    const { sent, impl } = recorder({ status: "success", data: { availablecash: "99999" } });
    const provider = createOpenAlgoProvider({ readGate: READY_GATE, fetchImpl: impl, now: () => 0 });
    const h = await provider.health();
    expect(sent.map((s) => s.url)).toEqual([`${OPENALGO_DEFAULT_HOST}/api/v1/funds`]);
    expect(Object.keys(sent[0].body)).toEqual(["apikey"]);
    expect(h.ok).toBe(true);
    // "Vyuha keeps nothing from the answer — no balance is stored or shown."
    expect(JSON.stringify(h).includes("99999"), "the funds balance rode back out of health()").toBe(false);
  });

  it("the 500 cap the disclosure quotes is the cap the request obeys", async () => {
    const stated = Number(claim(/at most (\d+) of them/)[1]);
    expect(stated, "the disclosure and OPENALGO_CAPABILITIES.maxSubscriptions disagree").toBe(
      OPENALGO_CAPABILITIES.maxSubscriptions,
    );
    const { sent, impl } = recorder();
    const provider = createOpenAlgoProvider({ readGate: READY_GATE, fetchImpl: impl });
    const keys = Array.from({ length: stated + 1 }, (_, i) => KEY(`SYM${i}`));
    await provider.snapshot(keys);
    expect((sent[0].body.symbols as unknown[]).length).toBe(stated);
  });

  it("the address the disclosure names is the address the request goes to", async () => {
    expect(FEED_TEXT.includes(OPENALGO_DEFAULT_HOST), "the disclosure stopped quoting OPENALGO_DEFAULT_HOST").toBe(true);
    expect(isLocalOpenAlgoHost(OPENALGO_DEFAULT_HOST)).toBe(true);
    const { sent, impl } = recorder();
    const provider = createOpenAlgoProvider({ readGate: READY_GATE, fetchImpl: impl });
    await provider.snapshot([KEY("TCS")]);
    expect(new URL(sent[0].url).origin).toBe(OPENALGO_DEFAULT_HOST);
  });

  it("the poll starts when the desk opens and stops when it closes — both ways it can close", async () => {
    claim(/start when the Live Desk opens and stop when it closes/);
    vi.useFakeTimers();
    try {
      // (a) the explicit unsubscribe the SSE route calls.
      const a = recorder({ status: "success", data: [{ symbol: "TCS", exchange: "NSE", ltp: 3100 }] });
      const p1 = createOpenAlgoProvider({ readGate: READY_GATE, fetchImpl: a.impl, refreshSeconds: 1 });
      const stop = p1.subscribe([KEY("TCS")], () => {});
      expect(a.sent.length, "subscribe() polled before the first interval").toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(a.sent.length, "nothing polled while the desk was open").toBe(1);
      stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(a.sent.length, "the interval survived unsubscribe — the desk closed and the bridge kept being asked").toBe(1);

      // (b) the abort signal the stream route aborts on disconnect.
      const b = recorder({ status: "success", data: [{ symbol: "TCS", exchange: "NSE", ltp: 3100 }] });
      const ctrl = new AbortController();
      const p2 = createOpenAlgoProvider({ readGate: READY_GATE, fetchImpl: b.impl, refreshSeconds: 1 });
      p2.subscribe([KEY("TCS")], () => {}, ctrl.signal);
      await vi.advanceTimersByTimeAsync(1000);
      expect(b.sent.length).toBe(1);
      ctrl.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(b.sent.length, "aborting the stream did not clear the interval").toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   SEAM 2 — B's OPENALGO_DISCLOSURE_VERSION crossing into A's route
   ══════════════════════════════════════════════════════════════════════════ */

describe("seam 2 — the disclosure VERSION constant is the version the feed route enforces", () => {
  /** The version before the current one, derived — never a hard-coded "1". */
  const PREVIOUS = String(Number(OPENALGO_DISCLOSURE_VERSION) - 1);

  it("an acknowledgement of the PREVIOUS version is a 403 that stores nothing, and resolves to eod", async () => {
    resetFeed();
    t.db.update(t.schema.settings).set({ openalgoEnabled: true, openalgoAckVersion: PREVIOUS }).run();

    const res = await feedPost({ action: "provider", provider: "openalgo" });
    expect(res.status, `ack "${PREVIOUS}" was accepted against version "${OPENALGO_DISCLOSURE_VERSION}"`).toBe(403);
    expect(t.db.select().from(t.schema.settings).all()[0].liveFeedProvider).toBe("eod");
    expect((await registry.resolveLiveFeed()).effective).toBe("eod");

    // The restored-backup shape: the picker VALUE travels, the consent does not.
    t.db.update(t.schema.settings).set({ liveFeedProvider: "openalgo" }).run();
    const feed = await registry.resolveLiveFeed();
    expect(feed.stored).toBe("openalgo");
    expect(feed.effective, "a stale acknowledgement opened a live feed").toBe("eod");
    expect(feed.blockedReason ?? "").toMatch(/disclosure has changed/i);
  });

  it('the v4.0 acknowledgement literally stored on every shipped install — "1" — is refused today', async () => {
    // THE ONE PLACE A LITERAL IS RIGHT. "1" is not a value in this repo, it is
    // the value sitting in `settings.openalgo_ack_version` on every copy of
    // v4.0 that is already installed. The whole point of the v4.1 bump is that
    // those installs re-read the disclosure before a repeating request starts,
    // so this assertion must NOT follow the constant: it reddens the moment
    // `OPENALGO_DISCLOSURE_VERSION` goes back to "1", which is exactly the
    // regression it exists to catch.
    resetFeed();
    t.db.update(t.schema.settings).set({ openalgoEnabled: true, openalgoAckVersion: "1" }).run();
    const res = await feedPost({ action: "provider", provider: "openalgo" });
    expect(res.status, "a v4.0 install kept its old consent into the live-price feed").toBe(403);
    expect(await res.json()).toMatchObject({ ok: false });
    t.db.update(t.schema.settings).set({ liveFeedProvider: "openalgo" }).run();
    expect((await registry.resolveLiveFeed()).effective).toBe("eod");
    resetFeed();
  });

  it("an acknowledgement of the CURRENT version is a 200, and resolves to openalgo", async () => {
    resetFeed();
    t.db
      .update(t.schema.settings)
      .set({ openalgoEnabled: true, openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION })
      .run();

    const res = await feedPost({ action: "provider", provider: "openalgo" });
    expect(res.status).toBe(200);
    expect(t.db.select().from(t.schema.settings).all()[0].liveFeedProvider).toBe("openalgo");
    const feed = await registry.resolveLiveFeed();
    expect(feed.effective).toBe("openalgo");
    expect(feed.blockedReason).toBeUndefined();
    resetFeed();
  });

  it("the switch OFF alone closes the gate, whatever the acknowledgement says", async () => {
    resetFeed();
    t.db
      .update(t.schema.settings)
      .set({ openalgoEnabled: false, openalgoAckVersion: OPENALGO_DISCLOSURE_VERSION, liveFeedProvider: "openalgo" })
      .run();
    expect((await registry.resolveLiveFeed()).effective).toBe("eod");
    expect((await feedPost({ action: "provider", provider: "openalgo" })).status).toBe(403);
    resetFeed();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   SEAM 3 — A's capability registry vs B's PRIVACY.md and help copy
   ══════════════════════════════════════════════════════════════════════════ */

const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:com|in|co|org|net|io|dev)\b/gi;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/** PRIVACY.md item 3, from its own numeral to the next one. */
function privacyItem3(): string {
  const start = PRIVACY.indexOf("\n3. **");
  const end = PRIVACY.indexOf("\n4. **", start);
  expect(start, "PRIVACY.md item 3 could not be located").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return PRIVACY.slice(start, end);
}

describe("seam 3 — what the registry claims it talks to, and what the privacy surfaces say it talks to", () => {
  it("no shipped provider capability names a non-loopback host but nsearchives.nseindia.com", () => {
    const caps = registry.allProviderCapabilities();
    const domains = new Set<string>();
    const ips = new Set<string>();
    for (const c of caps) {
      for (const d of c.egressDescription.match(DOMAIN_RE) ?? []) domains.add(d.toLowerCase());
      for (const ip of c.egressDescription.match(IPV4_RE) ?? []) ips.add(ip);
    }
    expect([...domains], "a capability block grew a host the privacy sheet does not carry").toEqual([
      "nsearchives.nseindia.com",
    ]);
    for (const ip of ips) expect(isLocalOpenAlgoHost(ip), `${ip} is not loopback`).toBe(true);
    expect(PRIVACY.includes("nsearchives.nseindia.com"), "the eod host is not in PRIVACY.md").toBe(true);
  });

  it("the OpenAlgo capability's egress names the loopback address the constant defines", () => {
    const openalgo = registry.allProviderCapabilities().find((c) => c.id === "openalgo")!;
    const host = new URL(OPENALGO_DEFAULT_HOST).hostname;
    expect(host).toBe("127.0.0.1");
    expect(openalgo.egressDescription.includes(host), "the capability stopped naming 127.0.0.1").toBe(true);
    expect(openalgo.egressDescription.match(DOMAIN_RE) ?? [], "the OpenAlgo capability named a remote host").toEqual([]);
    expect(openalgo.maxSubscriptions).toBe(500);
    expect(openalgo.requiresDailyAuth).toBe(true);
    expect(openalgo.staleness, "a 1-5 s poll of an LTP was labelled a tick stream").toBe("delayed");
  });

  it("PRIVACY item 3 quotes OPENALGO_DEFAULT_HOST verbatim, with the cadence and the /funds probe", () => {
    const item = privacyItem3();
    expect(item.includes(`\`${OPENALGO_DEFAULT_HOST}\``), "PRIVACY #3 no longer names the default host").toBe(true);
    const cadence = item.match(/once every (\d+)[–-](\d+) seconds/);
    expect(cadence, "PRIVACY #3 stopped stating the poll cadence").not.toBeNull();
    expect([Number(cadence![1]), Number(cadence![2])]).toEqual([REFRESH_SECONDS_MIN, REFRESH_SECONDS_MAX]);
    expect(item.includes("`/funds`"), "PRIVACY #3 dropped the /funds probe").toBe(true);
    // Every IPv4 the item names must be loopback — the whole promise of item 3.
    for (const ip of item.match(IPV4_RE) ?? []) expect(isLocalOpenAlgoHost(ip), ip).toBe(true);
  });

  it("the /live help entry names the same address and the same 1-5 s range", () => {
    const entry = HELP_ENTRIES.find((e) => e.href === "/live");
    expect(entry, "the /live help entry vanished").toBeTruthy();
    const text = entry!.body.join("\n");
    expect(text.includes(new URL(OPENALGO_DEFAULT_HOST).hostname), "/live help stopped naming 127.0.0.1").toBe(true);
    const m = text.match(/every (\d+) to (\d+) seconds/);
    expect(m, "/live help stopped stating the cadence").not.toBeNull();
    expect([Number(m![1]), Number(m![2])]).toEqual([REFRESH_SECONDS_MIN, REFRESH_SECONDS_MAX]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   SEAM 4 — C's /instruments write reaching C's /live read
   ══════════════════════════════════════════════════════════════════════════ */

async function deskRow(pro: boolean, symbol = "tcs") {
  const data = await live.loadLiveDesk({ pro });
  const row = data.rows.find((r) => r.symbol.toUpperCase() === symbol.toUpperCase());
  expect(row, `${symbol} is not on the desk`).toBeTruthy();
  return { data, row: row! };
}

describe("seam 4 — a results date written on /instruments reaches the Live Desk row", () => {
  it("crosses the lower-case trade / upper-case instrument join, for BOTH entitlements", async () => {
    resetFeed();
    const res = await instrumentsPost({ action: "results-date", id: TCS_INSTRUMENT, resultsDate: "2026-12-11" });
    expect(res.status).toBe(200);
    expect(instrumentQueries.getResultsDateMap().get("TCS")).toBe("2026-12-11");

    const pro = await deskRow(true);
    expect(pro.row.resultsDate, "the date did not survive the instruments -> desk join").toBe("2026-12-11");
    const free = await deskRow(false);
    expect(free.row.resultsDate, "a results date was gated — it is a fact about the company, not a Pro number").toBe(
      "2026-12-11",
    );
    // The gate is still doing its job on the same row, so this is not "nothing is gated".
    expect(free.row.riskAtStopP).toBeNull();
    expect(pro.row.riskAtStopP).not.toBeNull();
    // A symbol with no instruments row carries null, never an empty string.
    const infy = (await live.loadLiveDesk({ pro: true })).rows.find((r) => r.symbol === "infy")!;
    expect(infy.resultsDate).toBeNull();
  });

  it("the chip counts from the desk's OWN IST today, across the 18:30 UTC day boundary", async () => {
    resetFeed();
    await instrumentsPost({ action: "results-date", id: TCS_INSTRUMENT, resultsDate: "2026-09-07" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 23:59 IST on the 6th — one minute before the boundary.
      vi.setSystemTime(new Date("2026-09-06T18:29:00.000Z"));
      let d = await deskRow(true);
      expect(d.data.today).toBe("2026-09-06");
      expect(daysToResults(d.row.resultsDate, d.data.today)).toBe(1);
      expect(resultsChip(daysToResults(d.row.resultsDate, d.data.today)!)).toBe("Results tomorrow");

      // 00:00 IST on the 7th — one minute later, one day on.
      vi.setSystemTime(new Date("2026-09-06T18:30:00.000Z"));
      d = await deskRow(true);
      expect(d.data.today, "the desk's IST day did not roll at 18:30 UTC").toBe("2026-09-07");
      expect(daysToResults(d.row.resultsDate, d.data.today)).toBe(0);
      expect(resultsChip(daysToResults(d.row.resultsDate, d.data.today)!)).toBe("Results today");

      // 23:59 IST on the 7th — the date is now PAST, and the chip stops counting.
      vi.setSystemTime(new Date("2026-09-07T18:29:00.000Z"));
      d = await deskRow(true);
      expect(d.data.today).toBe("2026-09-07");
      vi.setSystemTime(new Date("2026-09-07T18:30:00.000Z"));
      d = await deskRow(true);
      expect(d.data.today).toBe("2026-09-08");
      expect(d.row.resultsDate, "the past date left the record — the user typed it and it is theirs").toBe("2026-09-07");
      expect(daysToResults(d.row.resultsDate, d.data.today), "a past date counted backwards").toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearing on /instruments removes it from the desk row", async () => {
    resetFeed();
    await instrumentsPost({ action: "results-date", id: TCS_INSTRUMENT, resultsDate: "2026-12-11" });
    expect((await deskRow(true)).row.resultsDate).toBe("2026-12-11");
    const res = await instrumentsPost({ action: "results-date", id: TCS_INSTRUMENT, resultsDate: null });
    expect(res.status).toBe(200);
    expect((await deskRow(true)).row.resultsDate, "a cleared date still renders a chip on the desk").toBeNull();
    expect(instrumentQueries.getResultsDateMap().has("TCS")).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   SEAM 5 — heat's lockedInProfitP reaching the tracker's copy helper
   ══════════════════════════════════════════════════════════════════════════ */

describe("seam 5 — locked-in profit is stated, not netted, and it stops at the Pro boundary", () => {
  it("the paise heat computes are the rupees the tracker line prints", () => {
    const rows: HeatRow[] = [
      // Stop trailed BEYOND entry: riskAtStopP is negative — locked-in profit.
      { id: 1, riskAtStopP: -123_456, investedP: 30_00_000, sector: "IT", sectorTier: "user" },
      // Stop still short of entry: real risk.
      { id: 2, riskAtStopP: 50_000, investedP: 30_00_000, sector: "Auto", sectorTier: "user" },
      // No stop at all — counted, and excluded from both sums.
      { id: 3, riskAtStopP: null, investedP: 10_00_000, sector: null, sectorTier: null },
    ];
    const heat = portfolioHeat(rows, 1_00_00_000, null);

    expect(heat.lockedInProfitP, "the negative row was netted off instead of published").toBe(123_456);
    expect(heat.openRiskP, "a winner cancelled another row's real risk").toBe(50_000);
    expect(heat.rowsWithoutStop).toBe(1);

    // The exact string the tracker renders — `lockedInAtStop(fmt.money(...))`.
    expect(money(heat.lockedInProfitP)).toBe("₹1,235");
    expect(lockedInAtStop(money(heat.lockedInProfitP))).toBe(
      "Locked in at stop ₹1,235 — computed from the rows whose stop already sits beyond entry, if every stop is hit.",
    );
    // The claim is "if every stop is hit", never that the money is already had.
    for (const banned of ["protected", "banked", "guaranteed", "secured"]) {
      expect(lockedInAtStop(money(heat.lockedInProfitP)).toLowerCase().includes(banned), banned).toBe(false);
    }
  });

  it("the empty book prints a dash-free zero and never a fabricated denominator", () => {
    const empty = portfolioHeat([], null, null);
    expect(empty.lockedInProfitP).toBe(0);
    expect(empty.openRiskP).toBe(0);
    expect(empty.heatPpm, "heat invented a denominator with no capital").toBeNull();
    expect(lockedInAtStop(money(empty.lockedInProfitP))).toContain("₹0");
  });

  it("a free licence never receives the figure at all — the whole heat tile is null on the wire", async () => {
    resetFeed();
    const proData = await live.loadLiveDesk({ pro: true });
    expect(proData.heat, "the Pro desk lost its heat tile").not.toBeNull();
    expect(typeof proData.heat!.lockedInProfitP).toBe("number");
    const freeData = await live.loadLiveDesk({ pro: false });
    expect(freeData.heat, "lockedInProfitP rode out to a free reader inside the RSC payload").toBeNull();
    expect(JSON.stringify(freeData).includes("lockedInProfitP")).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   SEAM 6 — D's lab config vs lib/risk, and D's digests vs the sector chain
   ══════════════════════════════════════════════════════════════════════════ */

describe("seam 6 — the volatility pair re-reads compareAll rather than re-computing it", () => {
  /**
   * The deploy cap is OFF for the equality run, deliberately. `compareAll`
   * clips every row through `applyDeployCap` when `setup.deployCapPpm` is set
   * (lib/risk/sizing.ts:955-961), so at the lab's shipped 25% cap the Turtle
   * row is 87, not the rulebook's own 117 — comparing a capped row to an
   * uncapped call would assert that the cap does not exist. The cap is asserted
   * as its own crossing in the test below it.
   */
  const setup = buildSetup(sampleInputs({ deployCapOn: false }));
  const common = {
    entryP: setup.entryP,
    stopP: setup.stopP,
    lotSize: setup.lotSize ?? 1,
    atrP3: setup.atrP3!,
    nStopMult: setup.nStopMult ?? 2000,
  };

  it("each sibling's qty is its own rulebook's qty, at the identical inputs", () => {
    const rows = compareAll(setup);
    const pct = sizePctVolatility({ ...common, capitalP: setup.capitalP, riskPpm: setup.riskPpm });
    const turtle = sizeVolatilityUnit({ ...common, capitalP: setup.capitalP, unitRiskPpm: setup.unitRiskPpm ?? 10_000 });

    for (const primary of VOLATILITY_VARIANTS.map((v) => v.id)) {
      const pair = volatilityVariants(rows, primary);
      expect(pair.map((p) => p.id)[0], "the switch did not put the primary variant first").toBe(primary);
      expect(pair).toHaveLength(2);
      const byId = new Map(pair.map((p) => [p.id, p.result]));
      expect(byId.get("pct-volatility")!.qty, "the Varsity panel printed a quantity sizePctVolatility never returned").toBe(
        pct.qty,
      );
      expect(byId.get("volatility-unit")!.qty, "the Turtle panel printed a quantity sizeVolatilityUnit never returned").toBe(
        turtle.qty,
      );
      expect(byId.get("pct-volatility")!.method).toBe("pct-volatility");
      expect(byId.get("volatility-unit")!.method).toBe("volatility-unit");
    }
    // The labelling exists because the two answers differ. If they ever matched,
    // the switch would be decoration. At the header's own numbers (2% budget,
    // 1% unit) the documented factor is ~2x, and that is asserted, not assumed.
    expect(pct.qty).not.toBe(turtle.qty);
    const atHeaderNumbers = buildSetup(sampleInputs({ deployCapOn: false, riskPctPpm: 20_000, unitRiskPpm: 10_000 }));
    const hp = volatilityVariants(compareAll(atHeaderNumbers), "pct-volatility");
    const varsity = hp.find((p) => p.id === "pct-volatility")!.result.qty;
    const unit = hp.find((p) => p.id === "volatility-unit")!.result.qty;
    expect(varsity / unit, "the two variants stopped differing by the documented factor").toBeCloseTo(2, 1);
  });

  it("the deploy cap clips BOTH panels through the same one cap, and says so", () => {
    const cappedSetup = buildSetup(sampleInputs({ deployCapOn: true }));
    const pair = volatilityVariants(compareAll(cappedSetup), "volatility-unit");
    // Paise throughout (invariant 1): capital 10,00,000 -> 1e8 p, entry 2850 -> 2,85,000 p.
    const maxDeployP = Math.floor((cappedSetup.capitalP * cappedSetup.deployCapPpm!) / 1_000_000);
    const qtyCap = Math.floor(maxDeployP / cappedSetup.entryP);
    expect(qtyCap).toBe(87);
    for (const p of pair) {
      expect(p.result.qty, `${p.id} was not held to the deploy cap`).toBeLessThanOrEqual(qtyCap);
      if (p.result.clippedBy === "deployCap") {
        expect(p.result.qty).toBe(qtyCap);
        expect(p.result.flags).toContain("deploy-capped");
      }
    }
    expect(pair.some((p) => p.result.clippedBy === "deployCap"), "the 25% cap clipped neither panel").toBe(true);
  });

  it("with no ATR both variants come back as typed failures, and the pair still has two rows", () => {
    const noAtr = buildSetup(sampleInputs({ atrRupees: 0 }));
    const pair = volatilityVariants(compareAll(noAtr), "volatility-unit");
    expect(pair).toHaveLength(2);
    for (const p of pair) {
      expect(p.result.qty, "a missing ATR produced a size instead of a stated reason").toBe(0);
      expect(p.result.ok).toBe(false);
      expect(p.result.error, `${p.id} vanished instead of stating why`).toBe("non-positive-atr");
    }
  });
});

describe("seam 6b — the map digests describe the exact JSON the sector chain grouped by", () => {
  const digestOf = (json: unknown) => createHash("sha256").update(JSON.stringify(json), "utf8").digest("hex");

  it("both digested files are the two the resolution reads, byte for byte", () => {
    const digests = atlas.getMapDigests();
    expect(digests.map((d) => d.file)).toEqual(["lib/data/sector-map.json", "lib/data/nse-index-map.json"]);
    expect(digests.find((d) => d.file === "lib/data/sector-map.json")!.sha256).toBe(digestOf(sectorMapJson));
    expect(digests.find((d) => d.file === "lib/data/nse-index-map.json")!.sha256).toBe(digestOf(nseIndexMapJson));
    for (const d of digests) expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("every index-sourced sector on the desk's own resolution came out of that same nse-index-map object", () => {
    const resolution = instrumentQueries.getSectorResolution();
    const indexSourced = [...resolution].filter(([, v]) => v.source === "index");
    const taxonomySourced = [...resolution].filter(([, v]) => v.source === "taxonomy");
    expect(indexSourced.length, "the index map classified nothing").toBeGreaterThan(0);
    expect(taxonomySourced.length, "the ISIN taxonomy classified nothing").toBeGreaterThan(0);

    const symbols = (nseIndexMapJson as { symbols: Record<string, { industry?: string }> }).symbols;
    for (const [sym, res] of indexSourced.slice(0, 50)) {
      expect(String(symbols[sym]?.industry), `${sym} was classified from something other than the digested map`).toBe(
        res.raw,
      );
    }
    // And the taxonomy half really is sector-map.json's own bytes.
    const bytes = JSON.stringify(sectorMapJson);
    expect(bytes.includes(taxonomySourced[0][1].raw), "a taxonomy label is not in the digested file").toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   SEAM 7 — one flag, three files
   ══════════════════════════════════════════════════════════════════════════ */

describe("seam 7 — OPENALGO_FEED_ENABLED is the one answer the card, the registry and the route give", () => {
  it("the card's derived offer, the flag and the route's provider list agree", async () => {
    resetFeed();
    expect(OPENALGO_FEED_ENABLED).toBe(true);
    expect(card.BROKER_FEED_OFFERED, "the Settings card and the flag disagree about the feed").toBe(
      OPENALGO_FEED_ENABLED,
    );
    expect(registry.SHIPPED_PROVIDER_IDS.includes("openalgo")).toBe(OPENALGO_FEED_ENABLED);

    const res = await feedRoute.GET(
      new Request("http://127.0.0.1:3011/api/live/feed", { headers: { host: "127.0.0.1:3011" } }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      providers: { id: string; label: string }[];
      openalgo: { disclosureVersion: string };
    };
    expect(json.providers.map((p) => p.id).includes("openalgo"), "the flag is on and the picker does not offer it").toBe(
      OPENALGO_FEED_ENABLED,
    );
    expect(json.providers.find((p) => p.id === "openalgo")!.label).toBe(OPENALGO_CAPABILITIES.label);
    expect(json.openalgo.disclosureVersion).toBe(OPENALGO_DISCLOSURE_VERSION);
  });
});
