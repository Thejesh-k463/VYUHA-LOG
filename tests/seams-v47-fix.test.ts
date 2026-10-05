import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { istWallClockIso, todayIstIso } from "@/lib/domain/trading-day";
import { isoMinusDays } from "@/lib/live/positions-view";
import { OPENALGO_DISCLOSURE_VERSION, OPENALGO_DEFAULT_HOST } from "@/lib/domain/openalgo-disclosure";
import { OPENALGO_WS_PORT } from "@/lib/import/api/openalgo";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import { TELEGRAM_ALERT_STATUS_KEY, parseTelegramAlertStatus } from "@/lib/domain/telegram-failure";
import { telegramAlertsCardView } from "@/lib/telegram/card-state";
import { accountOfStreamKey, createStreamLink, streamKeyOf, type StreamSource } from "@/lib/live/stream-link";
import { quoteKeyId, type QuoteKey, type QuoteProvider } from "@/lib/quotes/types";
import { createMockProvider } from "@/lib/quotes/mock";
import { journalCeilingLine, kellyExceedsCeiling } from "@/components/sizing/lab-config";
import type { DeskRow, LiveDeskData } from "@/components/live/desk-types";
import type { JournalKellyOk, JournalKellyResponse } from "@/lib/analytics/journal-kelly";

/**
 * SEAM PASS — v4.7.0 RELEASE-AUDIT FIX WAVE (builders FA, FB, FC1, FC2; FD's seams and the
 * restore live in tests/seams-v47-fix-b.test.ts — a second database needs a second file).
 * Both REAL halves of every value that crosses a builder boundary, run together over ONE migrated
 * temp database. Transport and framework only are stood in: `next/cache`, the router hook,
 * `useStoredValue`'s SERVER snapshot (the hook always reads null on the server, so a stored
 * Positions-tab lens is supplied the way a browser would hold it), `fetch` → the REAL route
 * handlers, `globalThis.WebSocket` (the OpenAlgo socket, scripted only to record its URL),
 * `localStorage` / `window` (the per-device envelope and the toaster's bus), and React's
 * `useState` while ONE component (BrokerConnect) is called — its setters are RECORDED and
 * re-applied as React would apply them, so the real onChange handlers run (no DOM in vitest).
 *
 * | # | crossing value                         | producer file:line                                   | consumer file:line                                         | unit / type             | case |
 * |---|----------------------------------------|------------------------------------------------------|------------------------------------------------------------|-------------------------|------|
 * | 1 | contract bars (six readers)            | FA components/live/load-desk.ts:338-339              | lib/live/positions-view.ts:461 sinceClose → positions-tab.tsx:824,903-908; tracker-client.tsx ledger | paise / ppm, JSON (RSC) | S1a |
 * | 1 | feed.blockedReason                     | FA load-desk.ts:535-558 ← lib/quotes/registry.ts:324-361 | tracker-client.tsx blockedReasonOf → FeedBlockedNotice (:1037) | string|null, JSON  | S1b |
 * | 2 | snapshot accountId vs opened-for       | app/api/live/stream/route.ts:110,220-228 (unchanged)  | FA lib/live/stream-link.ts:463-474 ← tracker-client.tsx:615 accountOfStreamKey(streamKey) | int, SSE JSON | S2 |
 * | 3 | wsUrl in the save body                 | FB components/import/broker-connect.tsx:1741,1785 (onChange) → :477 openAlgoSaveFields | app/api/import/broker/route.ts save → vault → lib/quotes/openalgo.ts readGateFromDb → openalgo-stream.ts:377 | string|""|absent | S3 |
 * | 3 | loopback alias                         | FB lib/import/api/openalgo.ts:577-627 (route-side check) | same rule at the socket (openAlgoStreamUrl :642)        | URL host                | S3 |
 * | 4 | stored symbol = currency pair          | importer (stored `symbol`) / lib/domain/currency-pairs.ts | FC1 lib/telegram/alert-gate.ts:197-200 → lib/jobs/telegram-alerts.ts key list | upper-case text | S4a |
 * | 4 | TELEGRAM_ALERT_STATUS_KEY envelope     | components/system/telegram-alert-runner.tsx:109-115 (from the door's JSON) | FC1 telegram-card.tsx:157 (clear) → :180 card-state | localStorage JSON | S4b |
 * | 6 | halfKellyLowerBound / lossHi (per 1R)  | FC2 lib/analytics/edge-clinic.ts:861-890 kellyCeiling via journal-kelly.ts:218 (route JSON) | FC2 components/sizing/lab-config.ts:226,240 (flag, line) | fraction per 1R | S6 |
 * | 6 | the same ceiling on the Clinic card    | FC2 edge-clinic.ts:906-940 sizingCeiling (computeClinic → cache) | the Clinic sizing headline                    | fraction per 1R         | S6 |
 *
 * BOUNDARIES WITH NO FULL CASE HERE (named, with why):
 *   - tracker-client.tsx's `refreshForAccount` (React.useEffectEvent → router.refresh): an effect
 *     callback; vitest has no DOM to mount the effect. S2 runs the REAL link with the REAL
 *     `accountOfStreamKey(streamKeyOf(...))` value the effect passes, and records the callback.
 *   - the card's status line as RENDERED: `useStoredValue` reads null on the server by design, so
 *     S4b reads the card's chain (parse → telegramAlertsCardView → alertStatusLine) over the stored
 *     value the REAL runner wrote and the REAL card handler cleared.
 *   - IST day boundary (18:30–24:00 UTC): no value in this wave's seams carries a date across a
 *     builder boundary except weekDelta (FC1, a single-file pure change — its own test) and the
 *     journal Kelly 12m window (S6 reads the all-time window; CG-3 is a one-builder change).
 *
 * RECORDED SEAM DEFECTS: see the `D-FIX-n` comments on any `it.fails` below (none at the time of
 * writing unless listed in the report).
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";

const cache = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => void cache.paths.push(p),
  revalidateTag: () => {},
  unstable_cache: (fn: unknown) => fn,
}));

const router = vi.hoisted(() => ({ refreshes: 0, onRefresh: null as null | (() => void) }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({
    refresh: () => {
      router.refreshes += 1;
      router.onRefresh?.();
    },
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/live",
}));

// The server snapshot of `useStoredValue` is always null; the map is what a browser would hold
// for the Positions tab's lens. `writeStored` is the REAL one (S4b's clear goes through it).
const stored = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock("@/components/layout/use-stored-value", async (orig) => ({
  ...(await orig<typeof import("@/components/layout/use-stored-value")>()),
  useStoredValue: (k: string) => stored.map.get(k) ?? null,
}));

// next/font/google is a build-time loader; under vitest it is the one thing that keeps
// app/layout.tsx from importing. A font is a class name here — nothing S4c reads.
vi.mock("next/font/google", () => {
  const font = () => ({ className: "", variable: "", style: {} });
  return { Inter: font, JetBrains_Mono: font, Space_Grotesk: font };
});

// React's useState, RECORDED while `cap.on` (only around one BrokerConnect call): the value a
// hook returns can be overridden by ordinal (the state React would hold after earlier events),
// and every setter call is logged so the test can apply it the way React would. Pass-through
// otherwise — every other component renders through the real hook.
const cap = vi.hoisted(() => ({
  on: false,
  n: 0,
  over: new Map<number, unknown>(),
  inits: [] as unknown[],
  log: [] as { i: number; v: unknown }[],
}));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  function useState<S>(init: S | (() => S)) {
    const pair = actual.useState(init);
    if (!cap.on) return pair;
    const i = cap.n++;
    cap.inits[i] = pair[0];
    const v = cap.over.has(i) ? (cap.over.get(i) as S) : pair[0];
    const set = (x: S | ((prev: S) => S)) => {
      cap.log.push({ i, v: typeof x === "function" ? (x as (p: S) => S)(v) : x });
    };
    return [v, set] as [S, typeof set];
  }
  return { ...actual, default: { ...actual, useState }, useState };
});

/* ─────────────────────────────── harness ─────────────────────────────── */

let t: TempDb;
let live: typeof import("@/components/live/load-desk");
let view: typeof import("@/lib/live/positions-view");
let client: typeof import("@/components/live/tracker-client");
let tabMod: typeof import("@/components/live/positions-tab");
let deskCopy: typeof import("@/components/live/desk-copy");
let fmt: typeof import("@/components/live/desk-format");
let registry: typeof import("@/lib/quotes/registry");
let server: typeof import("react-dom/server");
let streamRoute: typeof import("@/app/api/live/stream/route");
let accountsRoute: typeof import("@/app/api/accounts/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");
let brokerUi: typeof import("@/components/import/broker-connect");
let alertsRoute: typeof import("@/app/api/telegram/alerts/route");
let tgRoute: typeof import("@/app/api/telegram/route");
let tgCard: typeof import("@/components/settings/telegram-card");
let runner: typeof import("@/components/system/telegram-alert-runner");
let job: typeof import("@/lib/jobs/telegram-alerts");
let vault: typeof import("@/lib/vault");
let kellyRoute: typeof import("@/app/api/sizing/journal-kelly/route");
let clinicQ: typeof import("@/lib/queries/edge-clinic");
let licenseQ: typeof import("@/lib/queries/license");

const h = React.createElement;
const LIVE_DAY = "2026-10-07"; // an ordinary verified Wednesday (the C5/C7 seams' day)
const NOW = new Date(istWallClockIso(LIVE_DAY, "10:42"));
const sameOrigin = { "sec-fetch-site": "same-origin" };
type Msg = Record<string, unknown>;

function clock(d: Date, fake: ("Date" | "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval")[]) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: fake, now: d });
}
/** Microtasks + real macrotask turns (setImmediate is never faked); no fake time passes. */
async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await new Promise((r) => setImmediate(r));
  }
}

function txt(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

type El = { type: unknown; props: Record<string, unknown> };
function findEl(node: unknown, match: (e: El) => boolean, depth = 0): El | undefined {
  if (depth > 200 || node == null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n, match, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!("props" in node)) return undefined;
  const el = node as El;
  if (match(el)) return el;
  return findEl(el.props?.children, match, depth + 1);
}

async function selectAccount(id: number) {
  const res = await accountsRoute.POST(
    new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "select", id }),
    }),
  );
  expect(res.status).toBe(200);
}

/** The RSC payload is JSON: what the client component receives is the loader's value round-tripped. */
const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// Measured locally 2026-10-05: migrate + seed + the dynamic imports (the live desk's and the
// settings card's client graphs are the bulk) ≈ 4–6 s — above the 3 s hook budget only because
// eight route/component graphs are imported once here instead of once per case. 120 s is for the
// Windows CI runner (> 15× slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("seams-v47-fix", { seed: true });
  live = await import("@/components/live/load-desk");
  view = await import("@/lib/live/positions-view");
  client = await import("@/components/live/tracker-client");
  tabMod = await import("@/components/live/positions-tab");
  deskCopy = await import("@/components/live/desk-copy");
  fmt = await import("@/components/live/desk-format");
  registry = await import("@/lib/quotes/registry");
  server = await import("react-dom/server");
  streamRoute = await import("@/app/api/live/stream/route");
  accountsRoute = await import("@/app/api/accounts/route");
  brokerRoute = await import("@/app/api/import/broker/route");
  brokerUi = await import("@/components/import/broker-connect");
  alertsRoute = await import("@/app/api/telegram/alerts/route");
  tgRoute = await import("@/app/api/telegram/route");
  tgCard = await import("@/components/settings/telegram-card");
  runner = await import("@/components/system/telegram-alert-runner");
  job = await import("@/lib/jobs/telegram-alerts");
  vault = await import("@/lib/vault");
  kellyRoute = await import("@/app/api/sizing/journal-kelly/route");
  clinicQ = await import("@/lib/queries/edge-clinic");
  licenseQ = await import("@/lib/queries/license");
  t.db.insert(t.schema.accounts).values([
    { id: 2, name: "Swing", isDefault: false },
    { id: 3, name: "Kelly book", isDefault: false },
  ]).run();
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.VYUHA_QUOTE_PROVIDER;
  t?.cleanup();
});

function wipeBook() {
  for (const tbl of ["trades", "price_history", "broker_connections", "telegram_alerts_sent", "clinic_cache", "clinic_experiments"]) {
    t.sqlite.prepare(`DELETE FROM ${tbl}`).run();
  }
}

/* ═══════════ S1 — FA's loader → the RSC wire → the client's readers ═══════════ */

describe("S1 — a contract's bars and the feed's blocked reason, from loadLiveDesk through the wire to what /live renders", () => {
  const TODAY = todayIstIso();
  const CASH = 401;
  const OPT = 402;
  const FUT = 403;
  let data: LiveDeskData;

  beforeAll(async () => {
    wipeBook();
    delete process.env.VYUHA_QUOTE_PROVIDER;
    t.db.update(t.schema.settings).set({ equityCapital: 1_000_000, activeCapital: 500_000, selectedAccountId: 1 }).run();
    t.db.update(t.schema.riskConfig).set({ riskPctPpm: 10_000, stopAtrMultPermille: 2000 }).run();
    // CONSENT STALE (UJ-3): OpenAlgo picked and switched on, but the acknowledgement is an old
    // version — the registry falls back to end-of-day and states why.
    t.sqlite
      .prepare("UPDATE settings SET live_feed_provider = 'openalgo', openalgo_enabled = 1, openalgo_ack_version = '0', live_feed_ack_json = NULL")
      .run();
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({
          id: CASH, accountId: 1, symbol: "RELIANCE", tradingsymbol: "RELIANCE", isOpen: true,
          buyQty: 10, avgBuyPrice: 2800, buyValue: 28_000, buyDate: isoMinusDays(TODAY, 40), slPlanned: 2700,
        }),
        tradeRow({
          id: OPT, accountId: 1, symbol: "RELIANCE", tradingsymbol: "RELIANCE26DEC3000CE", isOpen: true,
          segment: "stock_option", instrumentType: "option", exchange: "NFO", bucket: "active",
          optionType: "CE", strike: 3000, expiry: "2026-12-29", lotSize: 500,
          buyQty: 500, avgBuyPrice: 100, buyValue: 50_000, buyDate: isoMinusDays(TODAY, 10), slPlanned: 80, closingPrice: 90,
        }),
        // A SHORT stock future: its stop sits ABOVE entry — the give-back side must stay short.
        tradeRow({
          id: FUT, accountId: 1, symbol: "RELIANCE", tradingsymbol: "RELIANCE26DECFUT", isOpen: true,
          segment: "future", instrumentType: "future", exchange: "NFO", bucket: "active", side: "short",
          expiry: "2026-12-29", lotSize: 250,
          sellQty: 250, avgSellPrice: 2950, sellValue: 737_500, sellDate: isoMinusDays(TODAY, 10), slPlanned: 3050, closingPrice: 2920,
        }),
      ])
      .run();
    const bars = [];
    for (let i = 29; i >= 0; i--) {
      const close = 2900 + (29 - i);
      bars.push({ symbol: "RELIANCE", date: isoMinusDays(TODAY, i), open: close - 5, high: close + 30, low: close - 30, close, volume: 1000 + (29 - i) * 10 });
    }
    t.db.insert(t.schema.priceHistory).values(bars).run();
    registry.resetLiveFeedProviderCache();
    data = wire(await live.loadLiveDesk({ pro: true }));
  }, 30_000);

  const rowOf = (id: number): DeskRow => {
    const r = data.rows.find((x) => x.id === id);
    if (!r) throw new Error(`row ${id} missing from the wire`);
    return r;
  };

  it("on the wire: both contracts carry no underlying fact (six readers), the cash row carries all of them", () => {
    const cash = rowOf(CASH);
    expect(cash.prevCloseP).toBe(292_800);
    expect([cash.dayChangePpm, cash.atrP3, cash.rvol.ppm, cash.highDistance.ppm].every((x) => x !== null)).toBe(true);
    expect(cash.spark.length).toBeGreaterThan(0);
    for (const id of [OPT, FUT]) {
      const r = rowOf(id);
      expect(
        { prev: r.prevCloseP, day: r.dayChangePpm, atr: r.atrP3, dist: r.distanceToStopAtrX100, rvol: r.rvol.ppm, high: r.highDistance.ppm, spark: r.spark },
        `contract ${id} read RELIANCE's bars`,
      ).toEqual({ prev: null, day: null, atr: null, dist: null, rvol: null, high: null, spark: [] });
      expect(r.markP, `contract ${id} is still marked from its own close`).not.toBeNull();
    }
    // The chart payload still ships RELIANCE's candles (for the cash row) — and the client's pane
    // gives a contract none of them.
    expect(data.barsBySymbol.RELIANCE?.length ?? 0).toBeGreaterThan(0);
    expect(client.chartBarsFor(rowOf(OPT), data.barsBySymbol)).toEqual([]);
    expect(client.chartBarsFor(rowOf(CASH), data.barsBySymbol)).toEqual(data.barsBySymbol.RELIANCE);
  });

  it("the Positions tab's since-close paragraph prints the CASH row's figures alone (contracts are not compared, both give-backs exclude them)", () => {
    const cashOnly = view.sinceClose([rowOf(CASH)], data.heat);
    const all = view.sinceClose(data.rows, data.heat);
    expect(all.compared, "a contract was compared against its underlying's close").toBe(1);
    expect(all.nearStop).not.toContain(OPT);
    expect(all.nearStop).not.toContain(FUT);
    stored.map.clear();
    stored.map.set(tabMod.LENS_KEY, JSON.stringify({ v: 1, open: true }));
    const html = txt(
      server.renderToStaticMarkup(
        h(tabMod.PositionsTab, { rows: data.rows, accountFilter: null, query: "", data, pro: true, linkLabel: null, now: null, onOpenChart: () => {}, onLab: () => {} }),
      ),
    );
    stored.map.clear();
    const P = deskCopy.POSITIONS_COPY;
    expect(html).toContain(P.sinceCloseUnrealised(fmt.signedMoney(cashOnly.unrealisedAtCloseP), fmt.signedMoney(all.unrealisedNowP)));
    expect(html).toContain(P.sinceCloseGivesBack(fmt.money(cashOnly.givesBackAtCloseP), fmt.money(all.givesBackNowP)));
  });

  it("the /live ledger (TrackerClient over the wire): the contracts' Day and Trend cells are empty; the cash row's are not", () => {
    const html = server.renderToStaticMarkup(h(client.TrackerClient, { data, pro: true }));
    const head = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => txt(m[1]));
    const dayCol = head.findIndex((x) => x === "Day");
    const trendCol = head.findIndex((x) => x === "Trend");
    expect(dayCol).toBeGreaterThan(0);
    const rows = html.split('<tr class="border-t').slice(1).map((tr) => tr.slice(0, tr.indexOf("</tr>")).split("<td").slice(1));
    const byQty = (product: string, qty: string) => {
      const r = rows.find((cells) => txt(`<td${cells[1]}`) === product && txt(`<td${cells[2]}`) === qty);
      if (!r) throw new Error(`no ${product} ${qty} row on /live`);
      return { day: txt(`<td${r[dayCol]}`), trendHtml: r[trendCol] };
    };
    const cash = byQty("CNC", "10");
    expect(cash.day).toMatch(/%/);
    expect(cash.trendHtml).toContain("<svg");
    for (const [qty, label] of [["500", "option"], ["250", "future"]] as const) {
      const r = byQty("NRML", qty);
      expect(r.day, `${label}: the underlying's day change printed as the contract's`).not.toMatch(/%/);
      expect(r.trendHtml, `${label}: the underlying's spark drawn as the contract's`).not.toContain("<svg");
    }
  });

  it("consent stale: resolveLiveFeed's reason → load-desk's feed (JSON) → blockedReasonOf → the notice /live renders, with the Settings link", async () => {
    const resolved = await registry.resolveLiveFeed();
    expect([resolved.stored, resolved.effective]).toEqual(["openalgo", "eod"]);
    expect(resolved.blockedReason).toMatch(/disclosure has changed/);
    expect(client.blockedReasonOf(data.feed)).toBe(resolved.blockedReason);
    const html = server.renderToStaticMarkup(h(client.TrackerClient, { data, pro: false }));
    const notice = /data-testid="live-feed-blocked"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    expect(txt(`<x ${notice}`)).toBe(
      `${deskCopy.FEED_BLOCKED_COPY.lead} ${resolved.blockedReason} ${deskCopy.FEED_BLOCKED_COPY.cta}`.replace(/\s+/g, " "),
    );
    expect(notice).toContain(`href="${deskCopy.FEED_BLOCKED_COPY.href}"`);
  });

  it("stored = effective: no reason crosses, and /live renders no notice", async () => {
    t.sqlite.prepare("UPDATE settings SET live_feed_provider = 'eod'").run();
    try {
      const d = wire(await live.loadLiveDesk({ pro: true }));
      expect(client.blockedReasonOf(d.feed)).toBeNull();
      expect(server.renderToStaticMarkup(h(client.TrackerClient, { data: d, pro: true }))).not.toContain("live-feed-blocked");
    } finally {
      t.sqlite.prepare("UPDATE settings SET live_feed_provider = 'openalgo'").run();
    }
  });
});

/* ═══════════ S6 — FC2's one Kelly: journal route → Lab, and the Clinic's card ═══════════ */

describe("S6 — the per-1R ceiling is ONE number: GET /api/sizing/journal-kelly → the Lab's flag and line, and the Clinic's sizing card", () => {
  const dayPlus = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
  // 60 closed eq_intraday trades, setup "S": 36 winners of +0.8..+1.6 R and 24 losers of −0.5..−0.9 R,
  // so the AVERAGE LOSS is ≈ 0.7 R — not 1 R (owner Q3's case: per 1R ≠ the classic fraction).
  const R = Array.from({ length: 60 }, (_, i) => (i % 5 < 3 ? 0.8 + (i % 5) * 0.4 : i % 5 === 3 ? -0.6 : -0.8));

  beforeAll(async () => {
    wipeBook();
    t.db
      .insert(t.schema.trades)
      .values(
        R.map((r, i) =>
          tradeRow({
            accountId: 3, bucket: "active", segment: "eq_intraday", symbol: "KELLY", tradingsymbol: "KELLY",
            buyQty: 10, sellQty: 10, avgBuyPrice: 100, avgSellPrice: 100 + r * 10, side: "long",
            buyDate: dayPlus(i), sellDate: dayPlus(i), isOpen: false,
            grossPnl: r * 100 + 20, chargesTotal: 20, netPnl: r * 100, riskAmount: 100, rMultiple: r, riskSource: "set", setupTag: "S",
          }),
        ),
      )
      .run();
    t.db.update(t.schema.settings).set({ selectedAccountId: 3, licenseKey: null, trialStartedAt: new Date().toISOString() }).run();
    expect(licenseQ.getEntitlement().pro).toBe(true);
    await clinicQ.computeClinic();
  }, 30_000);

  async function journal(qs = ""): Promise<JournalKellyOk> {
    const res = await kellyRoute.GET(new Request(`http://x/api/sizing/journal-kelly${qs}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as JournalKellyResponse;
    if (!body.result.ok) throw new Error(`refused: ${body.result.reason}`);
    return body.result;
  }
  function clinicCard(key: string) {
    const report = clinicQ.getClinicState().report;
    const cell = report?.cells.find((c) => c.key === key);
    if (!cell?.sizing) throw new Error(`the Clinic has no sizing card for ${key}`);
    return cell.sizing;
  }
  const pctIn = (s: string, re: RegExp) => Number(re.exec(s)?.[1]);

  it.each([
    ["the book", "", "all|all"],
    ["the segment", "?segment=eq_intraday", "eq_intraday|all"],
    ["the setup", "?segment=eq_intraday&setup=S", "eq_intraday|setup:S"],
  ])("%s: the route's ceiling IS the Clinic card's, and both print it as the same per-1R percent", async (_n, qs, key) => {
    const r = await journal(qs);
    const card = clinicCard(key);
    expect(r.lossHi, "the average loss at its upper bound is not 1 R in this book").not.toBeNull();
    expect(r.lossHi!).toBeLessThan(1);
    expect(r.halfKellyLowerBound).not.toBeNull();
    expect(card.halfKellyLowerBound).toBe(r.halfKellyLowerBound);
    expect(card.lossHi).toBe(r.lossHi);
    // Lab line (2 dp) and the Clinic headline (1 dp) state the same number.
    const lab = journalCeilingLine(r);
    expect(lab).toContain("per 1R");
    const labPct = pctIn(lab, /= ([\d.]+) % of capital/);
    const clinicPct = pctIn(card.copy.headline, /(?:ceiling|at or under) ([\d.]+) %/);
    expect(labPct.toFixed(1)).toBe(clinicPct.toFixed(1));
    expect(labPct).toBeCloseTo(r.halfKellyLowerBound! * 100, 2);
  });

  it("per 1R, the ceiling is above the classic ½ Kelly at the lower bounds (L̄hi < 1) — and the Lab's flag reads THAT number", async () => {
    const r = await journal();
    const classicHalf = r.kellyAtLowerBounds! / 2;
    expect(r.halfKellyLowerBound!, "the ceiling is still the classic fraction — not per 1R").toBeGreaterThan(classicHalf);
    // A Lab budget between the two: over the classic half, under the per-1R ceiling → NOT flagged.
    const between = Math.round(((classicHalf + r.halfKellyLowerBound!) / 2) * 1_000_000);
    expect(kellyExceedsCeiling(between, r.halfKellyLowerBound)).toBe(false);
    expect(kellyExceedsCeiling(Math.round(r.halfKellyLowerBound! * 1_000_000) + 1_000, r.halfKellyLowerBound)).toBe(true);
    // And the Clinic agrees on which side of its card that budget sits.
    expect(between / 1_000_000 <= clinicCard("all|all").halfKellyLowerBound!).toBe(true);
  });
});

/* ═══════════ S2 — the stream route's snapshot account → FA's link ═══════════ */

class FakeSource implements StreamSource {
  readyState = 1;
  private ls = new Map<string, ((ev: Event) => void)[]>();
  addEventListener(type: string, l: (ev: Event) => void) {
    this.ls.set(type, [...(this.ls.get(type) ?? []), l]);
  }
  close() {
    this.readyState = 2;
  }
  dispatch(type: string, data: string) {
    if (this.readyState === 2) return;
    for (const l of this.ls.get(type) ?? []) l({ data } as unknown as Event);
  }
}

/** One REAL `GET /api/live/stream`, its SSE bytes framed into events and fed to `src`. */
async function pipeRoute(src: FakeSource, events: { event: string; data: Msg }[]): Promise<AbortController> {
  const ac = new AbortController();
  const res = await streamRoute.GET(new Request("http://localhost:3000/api/live/stream", { headers: sameOrigin, signal: ac.signal }));
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        const lines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) lines.push(line.slice(6));
        }
        if (lines.length === 0) continue;
        events.push({ event, data: JSON.parse(lines.join("\n")) as Msg });
        src.dispatch(event, lines.join("\n"));
      }
    }
  })().catch(() => {});
  await settle();
  return ac;
}

describe("S2 — the snapshot's accountId against the account the desk's link was OPENED for (UJ-4)", () => {
  interface Desk {
    opened: number | null;
    fired: number[];
    sources: FakeSource[];
    events: { event: string; data: Msg }[];
    link: ReturnType<typeof createStreamLink>;
    connect: () => Promise<void>;
    destroy: () => void;
  }
  const aborts: AbortController[] = [];

  /** The desk as /live builds it: the REAL loader, then the effect's REAL key → opened-for account. */
  async function openDesk(): Promise<Desk> {
    const data = wire(await live.loadLiveDesk({ pro: true }));
    const streamKey = streamKeyOf(data.selectedAccountId, data.rows);
    const opened = accountOfStreamKey(streamKey);
    const fired: number[] = [];
    const sources: FakeSource[] = [];
    const events: { event: string; data: Msg }[] = [];
    let paint = 0;
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
      schedulePaint: (fn) => {
        queueMicrotask(fn);
        return ++paint;
      },
      cancelPaint: () => {},
      random: () => 0,
      onState: () => {},
      onQuotes: () => {},
      openedForAccountId: opened ?? undefined,
      onAccountMismatch: (id) => fired.push(id),
    });
    const connect = async () => {
      link.open();
      aborts.push(await pipeRoute(sources[sources.length - 1]!, events));
    };
    return { opened, fired, sources, events, link, connect, destroy: () => link.destroy() };
  }

  beforeAll(() => {
    wipeBook();
    t.sqlite.prepare("UPDATE settings SET live_feed_provider = 'eod', openalgo_enabled = 0, openalgo_ack_version = NULL").run();
    t.db.insert(t.schema.trades).values([
      tradeRow({ accountId: 1, symbol: "INFY", tradingsymbol: "INFY", buyQty: 10, avgBuyPrice: 1500, isOpen: true }),
      tradeRow({ accountId: 2, symbol: "TCS", tradingsymbol: "TCS", buyQty: 5, avgBuyPrice: 3400, isOpen: true }),
    ]).run();
  });
  beforeEach(async () => {
    clock(NOW, ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]);
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    registry.resetLiveFeedProviderCache();
    await selectAccount(1);
  });
  afterEach(async () => {
    for (const a of aborts.splice(0)) a.abort();
    await settle(3);
    delete process.env.VYUHA_QUOTE_PROVIDER;
    vi.useRealTimers();
  });

  it("matching account: the snapshot names the desk's own account, ticks flow, and the callback never fires", async () => {
    const d = await openDesk();
    expect(d.opened).toBe(1);
    await d.connect();
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(d.events[0]).toMatchObject({ event: "snapshot", data: { accountId: 1 } });
    expect(d.events.filter((e) => e.event === "tick").length, "the mock stream ticked").toBeGreaterThan(0);
    expect(d.fired).toEqual([]);
    d.destroy();
  });

  it("switched in ANOTHER tab (real accounts route): the reconnect's snapshot names account 2 → the callback fires ONCE with 2; later frames and a second reconnect never re-fire", async () => {
    const d = await openDesk();
    await d.connect();
    await selectAccount(2); // another tab — this desk still shows account 1's book
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(d.fired, "a tick on the old stream is not a snapshot").toEqual([]);
    await d.connect(); // the stream reconnects (retry / visibility / 15:31) — a fresh request
    expect(d.events.filter((e) => e.event === "snapshot").map((e) => e.data.accountId)).toEqual([1, 2]);
    expect(d.fired).toEqual([2]);
    await vi.advanceTimersByTimeAsync(2_000);
    await d.connect();
    expect(d.fired, "at most ONE refresh per link").toEqual([2]);
    d.destroy();
    // The refresh re-renders the desk for account 2: its NEW link is opened for 2 and stays quiet.
    const after = await openDesk();
    expect(after.opened).toBe(2);
    await after.connect();
    expect(after.events[0]).toMatchObject({ event: "snapshot", data: { accountId: 2 } });
    expect(after.fired).toEqual([]);
    after.destroy();
  });

  it("the aggregate view (0, invariant 9) is an account the desk can be opened for: no false mismatch", async () => {
    t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
    const d = await openDesk();
    expect(d.opened).toBe(0);
    await d.connect();
    expect(d.events[0]).toMatchObject({ event: "snapshot", data: { accountId: 0 } });
    expect(d.fired).toEqual([]);
    d.destroy();
  });

  it("only the SNAPSHOT is read: a tick or heartbeat naming another account (no route sends one) never fires", async () => {
    const d = await openDesk();
    d.link.open();
    const src = d.sources[0]!;
    src.dispatch("tick", JSON.stringify({ accountId: 2, provider: "mock", quotes: [] }));
    src.dispatch("heartbeat", JSON.stringify({ accountId: 2, at: new Date().toISOString() }));
    expect(d.fired).toEqual([]);
    src.dispatch("snapshot", JSON.stringify({ accountId: 2, quotes: [] }));
    expect(d.fired).toEqual([2]);
    d.destroy();
  });
});

/* ═══════════ S3 — the Import form's streaming address → route → vault → gate → socket ═══════════ */

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  addEventListener() {}
  send() {}
  close() {
    this.readyState = 3;
  }
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The browser's fetch on the Import card: relative app URLs → the REAL route; the bridge's REST → a stand-in. */
function brokerDispatcher(log: Msg[], answers: { status: number; json: Msg }[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/import/broker") {
      if ((init?.method ?? "GET") === "GET") return brokerRoute.GET();
      log.push(JSON.parse(String(init?.body)) as Msg);
      const res = await brokerRoute.POST(new Request("http://localhost/api/import/broker", { ...init, headers: { "content-type": "application/json" } }));
      answers.push({ status: res.status, json: (await res.clone().json()) as Msg });
      return res;
    }
    if (url.endsWith("/api/v1/funds")) return reply({ status: "success", data: { availablecash: "0.00" } });
    if (url.endsWith("/auth/app-info")) return reply({ status: "success", version: "2.0.3.0" });
    if (url.endsWith("/api/v1/multiquotes")) return reply({ status: "success", results: [] });
    throw new Error(`TEST GUARD: S3 reached an unexpected host ${url}`);
  };
}

describe("S3 — the streaming address: BrokerConnect's REAL handlers → save body → broker route → vault → gate → the socket URL", () => {
  const SRC = fs.readFileSync(path.join(process.cwd(), "components", "import", "broker-connect.tsx"), "utf8");
  // The hook ORDINALS of BrokerConnect's useState calls, in source order — located, not asserted:
  // each is verified against the initial value React hands back before any override is trusted.
  const body = SRC.slice(SRC.indexOf("export function BrokerConnect("));
  const names = [...body.slice(0, body.indexOf("\nexport ") > 0 ? body.indexOf("\nexport ") : undefined).matchAll(/const \[(\w+), set\w+\] = useState\b/g)].map((m) => m[1]);
  const ord = (name: string) => {
    const i = names.indexOf(name);
    if (i < 0) throw new Error(`BrokerConnect has no useState named ${name}`);
    return i;
  };
  const nameOf = (i: number) => names[i];
  type FormState = Record<string, unknown>;
  const posted: Msg[] = [];
  const answers: { status: number; json: Msg }[] = [];

  /** Call BrokerConnect inside a render with `state` as the hooks' current values; return its element tree. */
  function form(state: FormState, opts: { html?: (s: string) => void } = {}): unknown {
    let tree: unknown;
    cap.over = new Map(Object.entries(state).map(([k, v]) => [ord(k), v]));
    function Harness() {
      cap.on = true;
      cap.n = 0;
      cap.log = [];
      try {
        tree = brokerUi.BrokerConnect({ writeAccounts: [] });
      } finally {
        cap.on = false;
      }
      return opts.html ? (tree as React.ReactElement) : null;
    }
    const html = server.renderToStaticMarkup(h(Harness));
    opts.html?.(html);
    expect(cap.inits[ord("host")], "hook ordinals drifted").toBe(OPENALGO_DEFAULT_HOST);
    expect(cap.inits[ord("wsUrl")]).toBeNull();
    return tree;
  }
  /** Fire a REAL handler and return the state React would hold after its setters. */
  function fire(state: FormState, handler: () => void): FormState {
    cap.log = [];
    handler();
    const next = { ...state };
    for (const { i, v } of cap.log) next[nameOf(i)] = v;
    return next;
  }
  // Located by what the user SEES (the host box's placeholder, the broker picker's empty option),
  // not by the U-A1 ids — so a revert of this file to its pre-wave version still finds them.
  const CONTROLS = {
    host: (e: El) => e.props.placeholder === OPENALGO_DEFAULT_HOST,
    broker: (e: El) => findEl(e.props.children, (c) => c.props.children === "Which broker is it connected to?") !== undefined,
  };
  const onChangeOf = (tree: unknown, which: keyof typeof CONTROLS) => {
    const el = findEl(tree, (e) => typeof e.props.onChange === "function" && CONTROLS[which](e));
    if (!el) throw new Error(`no ${which} control on the OpenAlgo form`);
    return (value: string) => (el.props.onChange as (e: unknown) => void)({ target: { value } });
  };
  async function save(state: FormState): Promise<Msg> {
    const tree = form(state);
    const btn = findEl(tree, (e) => typeof e.props.onClick === "function" && (e.props.onClick as { name?: string }).name === "save");
    if (!btn) throw new Error("no Save button");
    const before = posted.length;
    cap.on = false;
    await (btn.props.onClick as () => Promise<void>)();
    expect(posted.length, "the save never reached the route").toBe(before + 1);
    return posted[posted.length - 1]!;
  }
  /** The socket the REAL provider opens for the selected account's gate, inside the live window. */
  async function socketUrl(): Promise<string | null> {
    registry.resetLiveFeedProviderCache();
    FakeWS.all = [];
    const p = await registry.getLiveFeedProvider();
    expect(p.id).toBe("openalgo");
    const ac = new AbortController();
    const key: QuoteKey = { symbol: "INFY", exchange: "NSE", tradingsymbol: "INFY" };
    const unsub = p.subscribe([key], () => {}, ac.signal, () => {});
    await settle();
    const url = FakeWS.all[FakeWS.all.length - 1]?.url ?? null;
    unsub();
    ac.abort();
    registry.resetLiveFeedProviderCache();
    await settle(3);
    return url;
  }
  const oaRows = async () =>
    ((await (await brokerRoute.GET()).json()) as { connections: Msg[] }).connections.filter((c) => String(c.broker).startsWith("openalgo"));
  const K1 = "oa-key-upstox-instance-1111";
  const K2 = "oa-key-dhan-instance-2222";
  const BASE: FormState = { broker: "openalgo", openalgoAvailable: true };

  beforeAll(() => {
    wipeBook();
  });
  beforeEach(async () => {
    clock(NOW, ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]);
    t.sqlite.prepare("DELETE FROM broker_connections").run();
    t.sqlite
      .prepare(
        "UPDATE settings SET live_feed_provider = 'openalgo', openalgo_enabled = 1, openalgo_ack_version = ?, selected_account_id = 1, live_feed_ack_json = NULL",
      )
      .run(OPENALGO_DISCLOSURE_VERSION);
    posted.length = 0;
    answers.length = 0;
    vi.stubGlobal("fetch", brokerDispatcher(posted, answers));
    vi.stubGlobal("WebSocket", FakeWS);
    vi.stubGlobal("window", new EventTarget());
    registry.resetLiveFeedProviderCache();
  });
  afterEach(() => {
    cap.on = false;
    cap.over = new Map();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("UJ-6: a bridge typed as localhost with OpenAlgo's own ws://127.0.0.1 address saves, and the socket opens THERE", async () => {
    const sent = await save({ ...BASE, host: "http://localhost:5000", underlyingBroker: "upstox", apiKey: K1, wsUrl: "ws://127.0.0.1:8766" });
    expect(sent).toMatchObject({ action: "save", broker: "openalgo", host: "http://localhost:5000", wsUrl: "ws://127.0.0.1:8766" });
    expect((await oaRows()).map((c) => c.openalgoWsUrl)).toEqual(["ws://127.0.0.1:8766"]);
    expect(await socketUrl()).toBe("ws://127.0.0.1:8766");
  });

  it("UJ-6: a LAN bridge with a loopback stream address is refused at the route; nothing is stored", async () => {
    const sent = await save({ ...BASE, host: "http://192.168.1.9:5000", underlyingBroker: "upstox", apiKey: K1, wsUrl: "ws://127.0.0.1:8766" });
    expect(sent.wsUrl).toBe("ws://127.0.0.1:8766");
    expect(answers[answers.length - 1]).toEqual({
      status: 400,
      json: expect.objectContaining({ message: "The streaming address must be on the same machine as the bridge address (192.168.1.9), not 127.0.0.1." }),
    });
    expect(await oaRows()).toEqual([]);
  });

  it("UJ-7 host change: the REAL host onChange clears the adopted address to \"\" → the save clears the stored one → the socket opens on the NEW host's default port", async () => {
    await save({ ...BASE, host: "http://localhost:5000", underlyingBroker: "upstox", apiKey: K1, wsUrl: "ws://127.0.0.1:8766" });
    // The card re-adopts the one saved instance (host, broker, address) — then the user edits the host.
    let s: FormState = { ...BASE, host: "http://localhost:5000", underlyingBroker: "upstox", apiKey: "", wsUrl: "ws://127.0.0.1:8766" };
    s = fire(s, () => onChangeOf(form(s), "host")("http://127.0.0.1:5000"));
    expect([s.host, s.wsUrl]).toEqual(["http://127.0.0.1:5000", ""]);
    const sent = await save(s);
    expect(sent.wsUrl).toBe("");
    const [row] = await oaRows();
    expect([row?.openalgoHost, row?.openalgoWsUrl]).toEqual(["http://127.0.0.1:5000", null]);
    expect(await socketUrl()).toBe(`ws://127.0.0.1:${OPENALGO_WS_PORT}`);
  });

  it("UJ-7 second instance: host edit (→ \"\") then the REAL broker onChange (→ null) → the save OMITS wsUrl → the new instance has none, the adopted one keeps its own", async () => {
    await save({ ...BASE, host: "http://localhost:5000", underlyingBroker: "upstox", apiKey: K1, wsUrl: "ws://127.0.0.1:8766" });
    let s: FormState = { ...BASE, host: "http://localhost:5000", underlyingBroker: "upstox", apiKey: "", wsUrl: "ws://127.0.0.1:8766" };
    s = fire(s, () => onChangeOf(form(s), "host")("http://127.0.0.1:5051"));
    s = fire(s, () => onChangeOf(form(s), "broker")("dhan"));
    expect([s.host, s.underlyingBroker, s.wsUrl]).toEqual(["http://127.0.0.1:5051", "dhan", null]);
    s = { ...s, apiKey: K2 };
    vi.setSystemTime(Date.now() + 1_000); // the dhan instance is the most recently updated row
    const sent = await save(s);
    expect(sent).not.toHaveProperty("wsUrl");
    expect(answers[answers.length - 1]?.status).toBe(200);
    const byBroker = Object.fromEntries((await oaRows()).map((c) => [c.broker, c.openalgoWsUrl]));
    expect(byBroker).toEqual({ "openalgo:upstox": "ws://127.0.0.1:8766", "openalgo:dhan": null });
    // The gate reads the most recently updated instance: dhan's — its own host's default, never upstox's 8766.
    expect(await socketUrl()).toBe(`ws://127.0.0.1:${OPENALGO_WS_PORT}`);
  });

  it("UJ-2: the integration is switched off after an instance was saved → the save's 403 makes the card re-read the REAL GET → its notice states the gate's own reason and still lists the instance", async () => {
    await save({ ...BASE, host: "http://127.0.0.1:5000", underlyingBroker: "upstox", apiKey: K1, wsUrl: null });
    t.sqlite.prepare("UPDATE settings SET openalgo_enabled = 0").run();
    const gateReason = ((await (await brokerRoute.GET()).json()) as { openalgo: { available: boolean; reason?: string } }).openalgo;
    expect(gateReason.available).toBe(false);
    // The tab is still open in this page (loaded before the switch-off); the user presses Save.
    const s0: FormState = { ...BASE, host: "http://127.0.0.1:5000", underlyingBroker: "upstox", apiKey: "", wsUrl: null };
    await save(s0);
    expect(answers[answers.length - 1]?.status).toBe(403);
    // The card's own setters from that 403 → refresh() → GET, applied as React would.
    const s1 = { ...s0 };
    for (const { i, v } of cap.log) s1[nameOf(i)] = v;
    expect(s1.openalgoAvailable).toBe(false);
    let html = "";
    form(s1, { html: (x) => (html = x) });
    const notice = /data-testid="openalgo-blocked"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
    expect(txt(`<x ${notice}`)).toContain(gateReason.reason!);
    expect(notice).toContain('href="/settings#settings-integrations"');
    expect(txt(`<x ${notice}`)).toContain("http://127.0.0.1:5000");
  });
});

/* ═══════════ S4 — FC1: currency never reaches the alert feed; the card clears the runner's answer ═══════════ */

class MemoryStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe("S4 — a stored USDINR future beside RELIANCE: the real job asks the feed for RELIANCE only; the card's write clears the runner's stored answer", () => {
  const TOKEN = "123456:seam-token";
  const CHAT = "424242";
  const sent: string[] = [];
  let store: MemoryStorage;

  function tgDispatcher() {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/telegram") {
        return tgRoute.POST(new Request("http://localhost:3000/api/telegram", { method: "POST", headers: { "content-type": "application/json", ...sameOrigin }, body: init?.body as string }));
      }
      if (url.startsWith("https://api.telegram.org/")) {
        sent.push(String((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? ""));
        return reply({ ok: true, result: {} });
      }
      throw new Error(`TEST GUARD: S4 reached an unexpected host ${url}`);
    };
  }
  async function door(): Promise<Msg> {
    const res = await alertsRoute.POST(
      new Request("http://localhost:3000/api/telegram/alerts", { method: "POST", headers: { "content-type": "application/json", ...sameOrigin }, body: "{}" }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as Msg;
  }
  /** TelegramCard's props exactly as app/settings/page.tsx:128-140 builds them, from the DB. */
  function cardProps() {
    const s = t.db.select().from(t.schema.settings).get()!;
    return {
      enabled: s.telegramEnabled,
      ackVersion: s.telegramAckVersion,
      sendTime: s.telegramSendTime,
      lastSentDate: s.lastTelegramSentDate,
      connected: Boolean(s.telegramTokenEnc && s.telegramChatId),
      chatId: s.telegramChatId,
      alerts: { pro: licenseQ.getEntitlement().pro, alertsEnabled: s.telegramAlertsEnabled, alertFrom: s.telegramAlertFrom, alertTo: s.telegramAlertTo },
    };
  }
  /** The card's status chain (telegram-card.tsx:180-205) over what this device has stored. */
  function cardStatus() {
    const p = cardProps();
    const last = parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY));
    const v = telegramAlertsCardView({
      enabled: p.enabled, ackVersion: p.ackVersion, connected: p.connected, pro: p.alerts.pro,
      alertsEnabled: p.alerts.alertsEnabled, windowFrom: p.alerts.alertFrom, windowTo: p.alerts.alertTo,
      lastRefusal: last ? last.refused : undefined,
    });
    return { status: v.status, line: tgCard.alertStatusLine(v.status, last && last.refused === v.status ? last.detail : undefined) };
  }
  const receipts = () => (t.sqlite.prepare("SELECT symbol FROM telegram_alerts_sent ORDER BY symbol").all() as { symbol: string }[]).map((r) => r.symbol);

  beforeEach(() => {
    wipeBook();
    clock(NOW, ["Date"]);
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    registry.resetLiveFeedProviderCache();
    store = new MemoryStorage();
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("fetch", tgDispatcher());
    sent.length = 0;
    router.refreshes = 0;
    t.sqlite
      .prepare(
        `UPDATE settings SET telegram_enabled = 1, telegram_ack_version = ?, telegram_token_enc = ?, telegram_chat_id = ?,
         telegram_alerts_enabled = 0, telegram_alert_from = NULL, telegram_alert_to = NULL, last_telegram_alert_summary_date = NULL,
         selected_account_id = 1, live_feed_provider = 'eod', live_feed_ack_json = NULL, openalgo_enabled = 0, openalgo_ack_version = NULL`,
      )
      .run(TELEGRAM_DISCLOSURE.version, vault.encryptSecret(TOKEN), CHAT);
    t.db
      .update(t.schema.settings)
      .set({ licenseKey: null, clockHighWaterMark: null, trialStartedAt: new Date(NOW.getTime() - 86_400_000).toISOString() })
      .run();
    // As an import before v4.7.0 stored them: NSE derivatives whose `symbol` IS the pair. Both
    // stops sit far above any price, so a CHECKED row always breaches.
    t.db.insert(t.schema.trades).values([
      tradeRow({ accountId: 1, symbol: "USDINR", tradingsymbol: "USDINR26OCTFUT", exchange: "NSE", segment: "future", instrumentType: "future", bucket: "active", buyQty: 1, avgBuyPrice: 84, isOpen: true, slPlanned: 9_999 }),
      tradeRow({ accountId: 1, symbol: "RELIANCE", tradingsymbol: "RELIANCE", exchange: "NSE", buyQty: 10, avgBuyPrice: 3000, isOpen: true, slPlanned: 99_999 }),
    ]).run();
  });
  afterEach(() => {
    delete process.env.VYUHA_QUOTE_PROVIDER;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("S4a: the real job (alerts on) asks the feed for NSE:RELIANCE only, and only RELIANCE is alerted", async () => {
    t.db.update(t.schema.settings).set({ telegramAlertsEnabled: true }).run();
    const asked: QuoteKey[][] = [];
    const real = createMockProvider();
    const spy: QuoteProvider = { ...real, snapshot: (keys, signal) => (asked.push([...keys]), real.snapshot(keys, signal)) };
    const out = await job.runTelegramAlerts(NOW, { getProvider: async () => spy });
    expect(out.refused).toBeNull();
    expect(asked.map((ks) => ks.map(quoteKeyId))).toEqual([["NSE:RELIANCE"]]);
    expect(receipts()).toEqual(["RELIANCE"]);
    expect(sent.some((m) => m.includes("USDINR"))).toBe(false);
  });

  it("S4b: runner stores 'alerts-off' → the card's REAL switch handler → /api/telegram → status cleared BEFORE refresh → the next door arms on RELIANCE alone", async () => {
    runner.applyAlertAnswer(await door(), NOW);
    const oldEnvelope = store.getItem(TELEGRAM_ALERT_STATUS_KEY);
    expect(parseTelegramAlertStatus(oldEnvelope)?.refused).toBe("alerts-off");
    // With alerts off the card shows no status line at all (card-state.ts:69); the hazard is AFTER
    // the switch: the card reads the stored refusal as the status the moment alerts are on.

    // The card, as the settings page builds it; its alerts switch's own handler.
    let tree: unknown;
    function Harness() {
      tree = tgCard.TelegramCard(cardProps());
      return null;
    }
    server.renderToStaticMarkup(h(Harness));
    const sw = findEl(tree, (e) => e.props["data-testid"] === "telegram-alerts-switch");
    expect(sw?.props.disabled, "the switch is live for a Pro user with a connected bot").toBe(false);
    const atRefresh: (string | null)[] = [];
    router.onRefresh = () => atRefresh.push(store.getItem(TELEGRAM_ALERT_STATUS_KEY));
    try {
      (sw!.props.onCheckedChange as (v: boolean) => void)(true);
      await vi.waitFor(() => expect(router.refreshes).toBe(1));
    } finally {
      router.onRefresh = null;
    }
    expect(atRefresh, "the old answer was still stored when the route re-rendered").toEqual([null]);
    expect(t.db.select().from(t.schema.settings).get()!.telegramAlertsEnabled).toBe(true);
    expect(cardStatus().line, "the card still shows the runner's old refusal beside an ON switch").toBeNull();
    // Not vacuous: the same chain over the envelope the runner wrote reads "alerts are off" now.
    const kept = new MemoryStorage();
    kept.setItem(TELEGRAM_ALERT_STATUS_KEY, oldEnvelope!);
    const mine = store;
    store = kept;
    try {
      expect(cardStatus().line).toBe(tgCard.ALERT_STATUS_COPY["alerts-off"]);
    } finally {
      store = mine;
    }

    // The layout re-keys the runner on the new settings; it asks the door at mount.
    const next = await door();
    runner.applyAlertAnswer(next, NOW);
    expect(next.refused ?? null).toBeNull();
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))?.refused ?? null).toBeNull();
    expect(receipts(), "a currency pair was checked").toEqual(["RELIANCE"]);
  });

  /** The alert runner's React key exactly as the REAL root layout builds it (app/layout.tsx:96-105, :211). */
  let Layout: (p: { children: React.ReactNode }) => unknown;
  // The root layout's client graph (sidebar, palette, search) — measured ≈ 0.7 s locally on first
  // import, so it is paid here once rather than inside an `it`.
  beforeAll(async () => {
    Layout = (await import("@/app/layout")).default as typeof Layout;
  }, 30_000);
  async function runnerKey(): Promise<string | null> {
    const el = findEl(Layout({ children: null }), (e) => e.type === runner.TelegramAlertRunner) as (El & { key?: string | null }) | undefined;
    return el ? (el.key ?? null) : null;
  }

  it("S4c: every write that CLEARS the stored answer also re-keys the runner, so the cleared answer is re-asked at once (alerts-window)", async () => {
    t.db.update(t.schema.settings).set({ telegramAlertsEnabled: true, telegramAlertFrom: "14:00", telegramAlertTo: "15:00" }).run();
    runner.applyAlertAnswer(await door(), NOW);
    expect(parseTelegramAlertStatus(store.getItem(TELEGRAM_ALERT_STATUS_KEY))?.refused).toBe("market-closed");
    const before = await runnerKey();
    expect(before).not.toBeNull();
    const r = await tgCard.postTelegramAction({ action: "alerts-window", from: "10:00", to: "15:00" }, () => {});
    expect(r.ok).toBe(true);
    expect(store.getItem(TELEGRAM_ALERT_STATUS_KEY)).toBeNull();
    expect(await runnerKey(), "the runner was not re-keyed, so nothing re-asks the door").not.toBe(before);
  });

  // D-FIX-1 (LOW, FC1 telegram-card.tsx:137 × app/layout.tsx:96-105): `save` is in
  // ALERT_STATUS_STALE_ACTIONS, so re-saving the bot credentials CLEARS the runner's stored answer —
  // but the layout's `alertsKey` carries only whether credentials are PRESENT (1 before, 1 after), so
  // the runner is not re-keyed and nothing re-asks the door until its own timer (the refusal's
  // nextInMs, clamped 15 s – 15 min). Meanwhile the card prints NO status line while the door still
  // refuses (here: `end-of-day-feed`). Right: either drop `save` from the list, or put the credentials'
  // identity (e.g. their updated stamp) into `alertsKey` so a re-save re-asks.
  it("S4c D-FIX-1 (FIXED — `save` left ALERT_STATUS_STALE_ACTIONS, flipped): re-saving the bot credentials clears the stored refusal without re-keying the runner — the card goes blank while the door still refuses", async () => {
    delete process.env.VYUHA_QUOTE_PROVIDER; // the end-of-day feed: the door refuses `end-of-day-feed`
    registry.resetLiveFeedProviderCache();
    t.db.update(t.schema.settings).set({ telegramAlertsEnabled: true }).run();
    runner.applyAlertAnswer(await door(), NOW);
    expect(cardStatus().status).toBe("end-of-day-feed");
    const before = await runnerKey();
    const r = await tgCard.postTelegramAction({ action: "save", token: TOKEN, chatId: CHAT }, () => {});
    expect(r.ok, r.message).toBe(true);
    expect(((await door()) as Msg).refused, "the door still refuses after the re-save").toBe("end-of-day-feed");
    // Either the answer is still shown, or the runner re-asks now (a new key remounts it).
    expect(cardStatus().line !== null || (await runnerKey()) !== before, "blank card, runner not re-keyed").toBe(true);
  });
});
