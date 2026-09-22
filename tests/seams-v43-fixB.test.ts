import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { computeSettlement, DEFAULT_SETTLEMENT_RATES, type SettlementInput } from "@/lib/analytics/settlement";
import { OPTIONS_HELP } from "@/lib/domain/options-help";
import { STRATEGY_COPY } from "@/components/strategies/strategy-copy";
import { buildManualPreviewBody } from "@/components/trades/manual-preview-body";
import { parseZerodha } from "@/lib/import/parsers/zerodha";
import { normalizeUpstoxTrades, toParsedFile as upstoxToParsedFile, type UpstoxTradeRow } from "@/lib/import/api/upstox";
import { spotChipLabel, spotCloseNotice } from "@/lib/risk/spot-ref";
import { todayIstIso } from "@/lib/domain/trading-day";

/**
 * v4.3.0 FIX WAVE 2 — THE SEAMS OF A THIRTEEN-BUILDER WAVE (plan-wave2.json).
 *
 * Phase 2a (W2-DHAN, W2-IDENTITY, W2-DQ, W2-HELP, W2-SPOT, W2-IPO, W2-UI,
 * W2-DOCS), phase 2b (W2-PULLNOTICE, W2-VENUE, W2-STRAT, W2-IPO2, W2-FIX2B)
 * and phase 2c (W2-EQ2012) owned disjoint file sets. This file runs the two
 * halves of every value that crosses from one builder's files into another's.
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The stubs are framework and
 * transport only: `next/cache`, `next/navigation` (no request, no mounted app
 * router) and `globalThis.fetch` — api.dhan.co and apiconnect.angelone.in
 * answer canned payloads, and the /risk chip's client `fetch` is handed to the
 * REAL route handler it names. Every figure is read where the consumer puts it:
 * a stored row, a rendered card, a route's JSON, a Data Quality pair.
 *
 * ── THE SEAM TABLE ───────────────────────────────────────────────────────────
 *
 *  # | crossing value                         | producer (file:line, builder)                 | consumer (file:line, builder)                            | unit / shape                            | test
 * ---|----------------------------------------|-----------------------------------------------|----------------------------------------------------------|-----------------------------------------|------
 *  1 | Dhan reportedCharges (ten heads)       | lib/import/api/dhan.ts:773 (DHAN)             | lib/import/commit.ts:131 buildRow {...computed,          | ₹ rupees; ipft/dp/pledge 0 stated,      | B1
 *    |                                        |                                               |   ...reported} + :1256 MTF note (IDENTITY)               |   mtfInterest unstated on MTF           |
 *  2 | R82 refused count on DhanHistoryRead   | dhan.ts:1249 onHistory → :1371 toParsedFile   | app/api/import/broker/route.ts warnings →                | integer → one sentence                  | B1
 *    |                                        |   (DHAN)                                      |   components/import/broker-connect.tsx:124 (PULLNOTICE)  |                                         |
 *  3 | exchangeHint per P9 leg (K2-M5, FIXB)  | dhan.ts legKey + settleVenues, pos.exchange   | commit.ts:108 findRates → trades.exchange; commit.ts:1245| "NSE" | "BSE"; sha1 dedup               | B2, D1
 *    |                                        |                                               |   seenInThisFile (IDENTITY); data-quality.ts:440 booksOf | → a Data Quality book                   | D2
 *  4 | {sellDate: IST today, basisUnknown}    | lib/import/api/angelone.ts:326, upstox.ts:217 | lib/analytics/data-quality.ts:354/:440 staleOpenPairs    | ISO day; acquisition 'unknown'          | B3a, B3b
 *    |   (QS-AO)                              |   (IDENTITY)                                  |   (DQ); app/strategies/page.tsx:96 P5 netting (STRAT)    | shares, floored at 0                    | B3c, D3
 *  5 | the R11 withheld-shape sentence        | components/strategies/strategy-copy.ts:106    | withholdForFree via app/strategies/page.tsx:140 →        | copy ↔ "Custom (n legs)"                | B3c
 *    |                                        |   (HELP)                                      |   strategy-card.tsx:84 (STRAT)                           |                                         |
 *  6 | QS-SPLIT whole-book group              | lib/analytics/strategies.ts:536 (STRAT)       | page.tsx → strategy-card.tsx:116 Figure (STRAT)          | one card, bounded                       | B3c
 *  7 | STALE_CLOSE alias on a joined lot      | close-stale route → close-open-lots.ts:151    | commit.ts:414 planSnapshot → supersede | ask (IDENTITY)  | sha1 alias → 409 needsForce             | B4a
 *    |                                        |   isLotIdentityFrozen (DQ)                    |                                                          |                                         |
 *  8 | accounts[].removable (P4 twin clause)  | data-quality.ts:166 isPlainDuplicateCopy +    | components/quality/duplicate-fix.tsx (DQ) →              | boolean → a button → ids                | B4b
 *    |                                        |  broker-identity.ts:334 isAutoCloseMerged (DQ)|   app/data-quality/actions.ts:34 removeDuplicateCopy     |                                         |
 *  9 | Leg.venues → row exchange (P9)         | lib/import/parsers/zerodha.ts:229 (VENUE)     | pair-legs.ts rowVenue (unchanged) → commit.ts:108 rates  | "NSE" | "BSE" → ₹ exchange txn          | B5
 * 10 | eq_delivery STT epoch 2012-07-01       | lib/db/seed-data.ts:156 (EQ2012)              | lib/queries/ipos.ts:40 → lib/analytics/ipo.ts:120 +      | fraction; ₹ on the SALE only            | B6
 *    |                                        |                                               |   lib/engine/rates.ts:297 statutoryRatesFor (IPO, IPO2)  |                                         |
 * 11 | eq_delivery STT epoch × P6 body        | seed-data.ts:156 (EQ2012) + components/trades/| app/api/charges/preview/route.ts + app/trades/actions.ts | integer ₹, both sides                   | B7
 *    |                                        |   manual-preview-body.ts:62 (UI)              |   createManualTrade → the stored row                     |                                         |
 * 12 | SpotRef {value, source, asOf, close}   | lib/risk/spot-ref.ts + lib/queries/mtm.ts +   | expiry-obligations.tsx:226 notice → spot-mark-editor.tsx | REAL ₹/unit, ISO day; paise fingerprint | B8
 *    |   + spot-close-diff fingerprint        |   price-history.ts (SPOT)                     |   :123/:149 → app/api/risk/spot/route.ts:79 + .../dismiss|                                         |
 *    |                                        |                                               |   → lib/queries/dismissals.ts → app/risk/page.tsx:308/335|                                         |
 *    |                                        |                                               |   → settlement physicalStt (unchanged)                   |                                         |
 * 13 | P7 "equity-delivery rate … both sides" | lib/domain/options-help.ts long-put (HELP)    | lib/analytics/settlement.ts physicalStt (unchanged)      | integer ₹                               | B9
 * 14 | API broker count (R22)                 | app/api/import/broker/route.ts:58 API_BROKERS | docs/sales/landing-page.html:289/:520/:533 (DOCS)        | count, OpenAlgo excluded                | B10
 *
 * RED ON REVERT (each side copied back to 654d534, run, restored byte-identical):
 * dhan.ts → B1 ×2, B2 (and D1 then passes: the defect is K2-M5's); commit.ts →
 * B4a; angelone.ts / upstox.ts → B3a / B3b; strategies page.tsx + queries/trades.ts
 * → B3c INFY; strategies.ts:536 hand-revert → B3c QS-SPLIT; strategy-copy.ts →
 * B3c R11; cross-source.ts → B3a, B3c, B4a; broker-identity.ts / analytics
 * data-quality.ts → B4b; zerodha.ts → B5; seed-data.ts → B6, B7; ipos.ts + ipo.ts
 * → B6; api/risk/spot/route.ts → B8c; risk/page.tsx → B8a-c; options-help.ts →
 * B9; landing-page.html → B10. Sides the wave did not change (commit.ts buildRow,
 * pair-legs.ts, settlement.ts, the route's API_BROKERS, pullResultMessage,
 * app/trades/actions.ts) cannot be reverted; a planted mutant of
 * close-open-lots.ts:151 (a joined lot read as not frozen) reddens B4a and B4b.
 *
 * THREE SEAM DEFECTS, pinned as `it.fails` holding the RIGHT value (they pass
 * while the defect stands; flip to `it` once fixed): D1 and D2 in B2, D3 in B3.
 * W2-FIXB: D1 FIXED (dhan.ts legs keyed `date|side` with `Leg.venues`) and D3
 * FIXED (page.tsx reads `hasRecordedBasis`; + a 'bonus' pin), both flipped to
 * `it`. W2-FIXD2: D2 FIXED (data-quality.ts lists a staged lot, never
 * one-click; closeStaleLot refuses it) and flipped to `it` — see its comment.
 *
 * NOT RE-TESTED HERE — both real halves already run together in a test the
 * owning builder wrote (read, not re-run by this pass):
 *  - R43 route/auto-pull supersede and R42b side-aware "+1 trade" —
 *    tests/fix-wave-c-import.test.ts:747-930 (IDENTITY ↔ PULLNOTICE, real route + real sweep);
 *  - P11 page-cap clear, P15/P16 verbatim card sentence — fix-wave-c-import.test.ts:949,
 *    seams-v43-fixA.test.ts S5;
 *  - R96 diagonal closed form ↔ computeStrategy — tests/strategy-catalogue.test.ts:409;
 *  - P14 undated future → page → card note — tests/strategies-ul-join.test.ts;
 *  - EQ2012 seed count ↔ refreshRateCards — seams-v43-release.test.ts S3;
 *  - P10 onlyOlderThan ↔ the Kite exchange 409 — tests/broker-auth-gate.test.ts.
 * UNTESTED SEAM (a finding, not a defect): R52's `STRATEGY_COPY.beginner` chip in
 * components/strategies/browse-drawer.tsx renders only inside the drawer's
 * `useState(false)` body, which a static render cannot open; the constant is
 * pinned, the drawer's output is not.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
  redirect: () => {},
}));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let brokerRoute: typeof import("@/app/api/import/broker/route");
let closeStaleRoute: typeof import("@/app/api/data-quality/close-stale/route");
let previewRoute: typeof import("@/app/api/charges/preview/route");
let spotRoute: typeof import("@/app/api/risk/spot/route");
let dismissRoute: typeof import("@/app/api/risk/spot/dismiss/route");
let bc: typeof import("@/components/import/broker-connect");
let editor: typeof import("@/components/risk/spot-mark-editor");
let importer: typeof import("@/lib/import/commit");
let identity: typeof import("@/lib/import/broker-identity");
let dqQueries: typeof import("@/lib/queries/data-quality");
let dqActions: typeof import("@/app/data-quality/actions");
let tradeActions: typeof import("@/app/trades/actions");
let ipoQueries: typeof import("@/lib/queries/ipos");
let engine: { computeCharges: typeof import("@/lib/engine/charges").computeCharges; findRates: typeof import("@/lib/engine/rates").findRates; loadRatesMap: typeof import("@/lib/engine/rates-db").loadRatesMap };
let DuplicateFix: typeof import("@/components/quality/duplicate-fix").DuplicateFix;
let ExpiryObligations: typeof import("@/components/risk/expiry-obligations").ExpiryObligations;
let riskPage: () => unknown;
let strategiesPage: () => unknown;

const CHARGES = 81; // B1
const VENUE = 82; //   B2
const ANGEL = 83; //   B3a + B3c
const UPSTOX = 84; //  B3b
const TWIN_A = 85; //  B4
const TWIN_B = 86; //  B4
const ZVENUE = 87; //  B5
const IPO = 88; //     B6
const MANUAL = 89; //  B7
const RISK = 90; //    B8
const CLIENT = "1000000019";

// ONE temp database for this file (AGENTS.md Testing). Migrating it and importing
// the routes measured 1.6-1.8 s locally (2026-09-14, inside the 3 s hook budget);
// the raised timeouts are for the Windows runner, measured > 15x slower.
beforeAll(async () => {
  t = await openTempDb("seams-v43-fixB", { seed: true });
  brokerRoute = await import("@/app/api/import/broker/route");
  closeStaleRoute = await import("@/app/api/data-quality/close-stale/route");
  previewRoute = await import("@/app/api/charges/preview/route");
  spotRoute = await import("@/app/api/risk/spot/route");
  dismissRoute = await import("@/app/api/risk/spot/dismiss/route");
  bc = await import("@/components/import/broker-connect");
  editor = await import("@/components/risk/spot-mark-editor");
  importer = await import("@/lib/import/commit");
  identity = await import("@/lib/import/broker-identity");
  dqQueries = await import("@/lib/queries/data-quality");
  dqActions = await import("@/app/data-quality/actions");
  tradeActions = await import("@/app/trades/actions");
  ipoQueries = await import("@/lib/queries/ipos");
  engine = {
    computeCharges: (await import("@/lib/engine/charges")).computeCharges,
    findRates: (await import("@/lib/engine/rates")).findRates,
    loadRatesMap: (await import("@/lib/engine/rates-db")).loadRatesMap,
  };
  t.db
    .insert(t.schema.accounts)
    .values([
      { id: CHARGES, name: "Charges", isDefault: false },
      { id: VENUE, name: "Venue", isDefault: false },
      { id: ANGEL, name: "Angel", isDefault: false },
      { id: UPSTOX, name: "Upstox", isDefault: false },
      { id: TWIN_A, name: "Twin A", isDefault: false },
      { id: TWIN_B, name: "Twin B", isDefault: false },
      { id: ZVENUE, name: "Zerodha venue", isDefault: false },
      { id: IPO, name: "IPO", isDefault: false },
      { id: MANUAL, name: "Manual", isDefault: false },
      { id: RISK, name: "Risk", isDefault: false },
    ])
    .run();
  // A FREE build: the trial started long ago (settings, not a mock), so a Pro
  // shape reads "Custom (n legs)" on /strategies (B3c, R11).
  t.sqlite.prepare("UPDATE settings SET trial_started_at = '2020-01-01T00:00:00.000Z'").run();
}, 120_000);

// The two server pages and the client components they render, in a hook of
// their own, warmed once on an empty book: their first render measured ~350 ms,
// a one-off cost that belongs in a hook, not in an `it`. The whole hook measured
// 1.9-2.3 s locally (2026-09-14).
beforeAll(async () => {
  ({ DuplicateFix } = await import("@/components/quality/duplicate-fix"));
  ({ ExpiryObligations } = await import("@/components/risk/expiry-obligations"));
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  strategiesPage = (await import("@/app/strategies/page")).default as () => unknown;
  selectAccount(RISK);
  renderToStaticMarkup(strategiesPage() as React.ReactElement);
  riskPage();
  selectAccount(0);
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  t?.cleanup();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── shared harness ───────────────────────────────────────────────────────────

const freezeAt = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

const alive = () =>
  ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

function addDhan(accountId: number, lastPullAt: string | null) {
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, ?)")
    .run(accountId, CLIENT, alive(), lastPullAt);
}

interface DhanFill {
  id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number | null;
  at: string;
  symbol?: string;
  segment?: string;
  product?: string;
  /** Dhan's own per-fill charge fields, as the history payload states them. */
  charges?: { brokerageCharges: number; serviceTax: number; stt: number; sebiTax: number; exchangeTransactionCharges: number; stampDuty: number };
}

const fillRow = (f: DhanFill) => ({
  dhanClientId: CLIENT,
  exchangeTradeId: f.id,
  orderId: `O-${f.id}`,
  transactionType: f.side,
  exchangeSegment: f.segment ?? "NSE_EQ",
  productType: f.product ?? "CNC",
  tradingSymbol: f.symbol ?? "TCS",
  tradedQuantity: f.qty,
  tradedPrice: f.price,
  exchangeTime: f.at,
  ...(f.charges ?? {}),
});

/** api.dhan.co — page 0 of the history walk answers `history`, /v2/positions answers `positions`. */
function stubDhan(history: DhanFill[], positions: unknown[] = []) {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    const body =
      u.host === "auth.dhan.co"
        ? { accessToken: alive() }
        : u.pathname === "/v2/positions"
          ? positions
          : /^\/v2\/trades\/[\d-]+\/[\d-]+\/0$/.test(u.pathname)
            ? history.map(fillRow)
            : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

const postBroker = (body: Record<string, unknown>) =>
  brokerRoute.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );

/**
 * A manual pull through the real route.
 *
 * RE-PINNED, v4.5.0 W2b: the route now flips auto-close ON unless the request
 * carries `keepSellsSeparate: true` (owner ruling A1), so a case that needs a
 * sale to land BESIDE the lot it could have closed — a STALE PAIR, which is the
 * whole subject of B3 and B4 (the R26 one-click join) — must say so. `extra` is
 * how those seeding pulls state it.
 */
const pull = (broker: string, accountId: number, extra: Record<string, unknown> = {}) =>
  postBroker({ action: "pull", broker, accountId, mode: "commit", ...extra });

const storedRows = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);

const TEN_HEADS = ["brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty", "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges"] as const;
const paise = (n: number) => Math.round(n * 100);
const sumHeadsPaise = (r: Record<string, unknown>) => TEN_HEADS.reduce((s, k) => s + paise(Number(r[k] ?? 0)), 0);

const closeStale = (body: { lotId: number; saleId: number; exitDate: string }) =>
  closeStaleRoute.POST(
    new Request("http://localhost/api/data-quality/close-stale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|");

// ============================================================================
// B1 — W2-DHAN's stated heads ↔ W2-IDENTITY's commit (K1-M2), and R82's count ↔ the card
// ============================================================================

describe("B1 · Dhan's stated charges land as ten heads that add up to the total Dhan levied (DHAN → commit), and a refused fill reaches the card (DHAN → route → PULLNOTICE)", () => {
  const c = (brokerageCharges: number, serviceTax: number, stt: number, sebiTax: number, exchangeTransactionCharges: number, stampDuty: number) => ({
    brokerageCharges,
    serviceTax,
    stt,
    sebiTax,
    exchangeTransactionCharges,
    stampDuty,
  });
  const HISTORY: DhanFill[] = [
    // A CNC round trip: the engine would add DP on the sale.
    { id: "K1-B", side: "BUY", qty: 10, price: 1000, at: "2026-09-04 11:00:00", charges: c(0, 0.07, 10, 0.01, 0.31, 1.5) },
    { id: "K1-S", side: "SELL", qty: 10, price: 1100, at: "2026-09-07 11:00:00", charges: c(0, 0.07, 11, 0.01, 0.34, 0) },
    // An MTF round trip: Dhan's history states no MTF interest.
    { id: "M-B", side: "BUY", qty: 20, price: 500, at: "2026-09-04 11:05:00", symbol: "INFY", product: "MTF", charges: c(20, 3.66, 10, 0.01, 0.31, 1.5) },
    { id: "M-S", side: "SELL", qty: 20, price: 520, at: "2026-09-07 11:05:00", symbol: "INFY", product: "MTF", charges: c(20, 3.67, 10.4, 0.01, 0.32, 0) },
    // R82: a fill with no readable price — refused, never coerced.
    { id: "BAD", side: "BUY", qty: 5, price: null, at: "2026-09-07 12:00:00", symbol: "WIPRO" },
  ];
  let json: { result: { added: number; warnings?: string[] }; warnings: string[] } | null = null;

  it("the real pull stores both rows with Σ ten heads === chargesTotal === what Dhan stated, to the paisa", async () => {
    freezeAt("2026-09-08T09:30:00.000Z"); // 15:00 IST, Tue 8 Sep
    addDhan(CHARGES, "2026-09-04T05:00:00.000Z");
    stubDhan(HISTORY);
    const res = await pull("dhan", CHARGES);
    expect(res.status).toBe(200);
    json = await res.json();
    const rows = storedRows(CHARGES);
    expect(rows.map((r) => [r.symbol, r.segment, r.buyQty, r.sellQty])).toEqual([
      ["TCS", "eq_delivery", 10, 10],
      ["INFY", "eq_mtf", 20, 20],
    ]);
    const statedPaise = [
      [0, 0.07, 10, 0.01, 0.31, 1.5, 0, 0.07, 11, 0.01, 0.34, 0],
      [20, 3.66, 10, 0.01, 0.31, 1.5, 20, 3.67, 10.4, 0.01, 0.32, 0],
    ].map((xs) => xs.reduce((s, x) => s + paise(x), 0));
    expect(rows.map((r) => paise(r.chargesTotal)), "chargesTotal is Dhan's own sum").toEqual(statedPaise);
    // THE assertion: a head the engine computed beside Dhan's total (DP on the
    // sale, IPFT) breaks the sum; W2-DHAN states those heads as 0.
    expect(rows.map((r) => sumHeadsPaise(r as never)), "Σ of the ten stored heads must equal chargesTotal").toEqual(statedPaise);
    expect(rows.map((r) => [r.dpCharges, r.ipft, r.pledgeCharges, r.mtfInterest])).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
  });

  it("the MTF row keeps commit's 'MTF interest not stated' note — Dhan left mtfInterest unstated, and the import computed none", () => {
    const [cnc, mtf] = storedRows(CHARGES);
    expect(mtf.importNotes ?? "").toContain("MTF interest not stated by the file");
    expect(cnc.importNotes ?? "").not.toContain("MTF interest not stated by the file");
  });

  it("R82: the refused fill's sentence rides the route's JSON into the card's commit line", () => {
    expect(json).not.toBeNull();
    const line = bc.pullResultMessage("commit", json!);
    // N21 (fix wave 2R) re-pin: "… and were refused rather than guessed." → "… and was refused …" — the verb follows the count of 1.
    expect(line).toContain("1 fill from Dhan's trade history had no readable side, quantity, price or date and was refused rather than guessed.");
  });
});

// ============================================================================
// B2 — W2-DHAN's per-venue legs ↔ commit's rate lookup (K2-M5)
// ============================================================================

describe("B2 · fills of one scrip-day-side on BSE and NSE: the row venue, the dedup identity and the Data Quality book (DHAN → commit → DQ)", () => {
  const V = (id: string, symbol: string, side: "BUY" | "SELL", qty: number, price: number, at: string, venue: "NSE" | "BSE"): DhanFill => ({
    id,
    symbol,
    side,
    qty,
    price,
    at,
    segment: `${venue}_EQ`,
  });
  const bySymbol = (symbol: string) => storedRows(VENUE).filter((r) => r.symbol === symbol);

  it("HDFCBANK bought BSE 10 (first) + NSE 90 @ ₹100, sold 100 on NSE @ ₹99: one closed row on NSE, priced at NSE's exchange charge", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    addDhan(VENUE, "2026-09-04T05:00:00.000Z");
    stubDhan(
      [
        V("H-1", "HDFCBANK", "BUY", 10, 100, "2026-09-04 11:00:00", "BSE"),
        V("H-2", "HDFCBANK", "BUY", 90, 100, "2026-09-04 11:05:00", "NSE"),
        V("H-3", "HDFCBANK", "SELL", 100, 99, "2026-09-07 10:00:00", "NSE"),
        // D1: a sale of 100 filled 50 on BSE and 50 on NSE at ONE price.
        V("W-1", "WIPRO", "BUY", 10, 100, "2026-09-04 11:00:00", "BSE"),
        V("W-2", "WIPRO", "BUY", 90, 100, "2026-09-04 11:05:00", "NSE"),
        V("W-3", "WIPRO", "SELL", 50, 110, "2026-09-07 10:00:00", "BSE"),
        V("W-4", "WIPRO", "SELL", 50, 110, "2026-09-07 10:05:00", "NSE"),
        // D2: a holding bought on both venues on 7 Sep …
        V("T-1", "TCS", "BUY", 10, 100, "2026-09-07 10:00:00", "BSE"),
        V("T-2", "TCS", "BUY", 90, 100, "2026-09-07 10:05:00", "NSE"),
      ],
      // … and sold whole today, as /v2/positions states it.
      [{ dhanClientId: CLIENT, tradingSymbol: "TCS", positionType: "CLOSED", exchangeSegment: "NSE_EQ", productType: "CNC", buyAvg: 0, buyQty: 0, sellAvg: 120, sellQty: 100, netQty: 0 }],
    );
    expect((await pull("dhan", VENUE)).status).toBe(200);
    const rows = bySymbol("HDFCBANK");
    expect(rows.map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([[100, 100, false]]);
    const map = engine.loadRatesMap();
    const at = (exchange: "NSE" | "BSE") =>
      engine.computeCharges(
        { segment: "eq_delivery", buyValue: 10_000, sellValue: 9_900, buyQty: 100, sellQty: 100, buyOrderCount: 1, sellOrderCount: 1 },
        engine.findRates(map, "dhan", "eq_delivery", exchange, "2026-09-07"),
      ).exchangeTxn;
    expect(at("NSE"), "floor: the two venues' exchange charges differ on this row").not.toBe(at("BSE"));
    // THE assertions (BSE / BSE's charge on revert: the day's first fill labelled
    // the whole buy leg, and ₹10,000 on "BSE" outweighed ₹9,900 on NSE).
    expect(rows[0].exchange).toBe("NSE");
    expect(rows[0].exchangeTxn).toBe(at("NSE"));
  });

  // SEAM DEFECT D1 — FIXED (v4.3.0 fix wave 2, W2-FIXB); this was an `it.fails`.
  // K2-M5 keyed Dhan legs per venue (`${date}|${side}|${exchange}`), so a sale of
  // 100 filled 50 on BSE and 50 on NSE at ₹110 became TWO closed rows of 50 / 50
  // on the same dates at the same prices. lib/import/dedup.ts:49 hashes neither
  // the venue nor the fills, so the two rows shared one dedupHash and commit.ts
  // skipped the second — silently. Measured: WIPRO 50 / 50, gross ₹500. Now the
  // legs are keyed `${date}|${side}` and carry `Leg.venues` (the P9 rule of
  // zerodha.ts settleVenues): one row of 100 / 100, gross ₹1,000. The dedup hash
  // is unchanged by decision (a venue in it is the 4.3.1 identity rebuild).
  it("D1 — a sale split 50 / 50 across venues at one price is stored whole: Σ sell 100, gross ₹1,000", () => {
    const rows = bySymbol("WIPRO");
    expect(rows.reduce((s, r) => s + r.sellQty, 0)).toBe(100);
    expect(rows.reduce((s, r) => s + paise(r.grossPnl), 0)).toBe(100_000);
  });

  // SEAM DEFECT D2 — FIXED (v4.3.0 fix wave 2, W2-FIXD2); this was an `it.fails`.
  // The per-venue legs stored a holding bought BSE 10 + NSE 90 on one day as TWO
  // open rows, and Data Quality (booksOf keys on exchange) paired today's NSE
  // sale of 100 with the NSE 90 only: matchedQty 90. D1's fix stores ONE open
  // row of 100 on NSE — but that row has two buy executions, so commit.ts
  // stagedFromExecutions marks it `staged`, and data-quality.ts isStaleLot
  // admitted no staged lot: measured pairs [] (Σ matchedQty 0). Stored,
  // measured: TCS [100, 0, open, NSE, 2026-09-07, staged] + [0, 100, open, NSE,
  // sold 2026-09-08, 'unknown']. Now every open lot with a later sale row in
  // its book is LISTED, staged or not; a staged one gets no one-click (the join
  // writes no exit leg, so the ladder would disagree with the parent row —
  // invariant 5) and closeStaleLot refuses it with STAGED.
  it("D2 — a holding bought on both venues and sold whole is listed against all 100 shares", () => {
    selectAccount(0);
    const pairs = dqQueries.getStaleOpenPairs().filter((p) => p.accountId === VENUE && p.tradingsymbol === "TCS");
    expect(pairs.reduce((s, p) => s + p.matchedQty, 0)).toBe(100);
    expect(pairs.map((p) => [p.staged, p.oneClick]), "listed, and sent to the ladder's own exit").toEqual([[true, false]]);
  });
});

// ============================================================================
// B3 — W2-IDENTITY's QS-AO sale ↔ W2-DQ's stale pairs ↔ W2-STRAT's P5 netting (+ R11, QS-SPLIT)
// ============================================================================

describe("B3 · an Angel One / Upstox sale out of a held lot is a dated stale pair on Data Quality, and nets the holding on /strategies (IDENTITY → DQ, STRAT)", () => {
  const angelFill = (side: "BUY" | "SELL", qty: number, price: number, time: string) => ({
    tradingsymbol: "INFY-EQ",
    exchange: "NSE",
    producttype: "DELIVERY",
    transactiontype: side,
    fillsize: qty,
    fillprice: price,
    filltime: time,
  });
  const stubAngel = (fills: Record<string, unknown>[]) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const data = String(url).includes("loginByPassword") ? { jwtToken: "jwt" } : fills;
      return new Response(JSON.stringify({ status: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

  it("B3a · Angel One, through the real route: the 8 Sep sale of the 4 Sep lot commits, and Data Quality lists ONE stated, one-click pair", async () => {
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?, 'angelone', 'key', '', ?)")
      .run(ANGEL, JSON.stringify({ clientCode: "C9", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" }));
    freezeAt("2026-09-04T09:30:00.000Z");
    stubAngel([angelFill("BUY", 100, 1500, "10:00:00")]);
    expect((await pull("angelone", ANGEL)).status).toBe(200);
    freezeAt("2026-09-08T09:30:00.000Z");
    stubAngel([angelFill("SELL", 100, 1550, "11:00:00")]);
    // W2b: the STALE PAIR this case is about is now a choice — auto-close would
    // otherwise close the 4 Sep lot with the 8 Sep sale and leave Data Quality
    // nothing to join. Every assertion below is v4.3.0's, unchanged.
    expect((await pull("angelone", ANGEL, { keepSellsSeparate: true })).status).toBe(200);
    expect.soft(storedRows(ANGEL).map((r) => [r.buyQty, r.sellQty, r.sellDate, r.acquisition])).toEqual([
      [100, 0, null, null],
      [0, 100, "2026-09-08", "unknown"],
    ]);
    selectAccount(0);
    const pairs = dqQueries.getStaleOpenPairs().filter((p) => p.accountId === ANGEL);
    // THE assertion (saleDateStated false on revert: the undated sale is dated by its pull day and must be confirmed).
    expect(pairs.map((p) => [p.saleDate, p.saleDateStated, p.oneClick, p.matchedQty])).toEqual([["2026-09-08", true, true, 100]]);
  });

  it("B3b · Upstox, through the normalizer the route calls and the same snapshot option: the same stated pair", () => {
    const fill = (over: Partial<UpstoxTradeRow>): UpstoxTradeRow => ({
      exchange: "NSE",
      product: "D",
      tradingsymbol: "HDFCBANK-EQ",
      trading_symbol: "HDFCBANK-EQ",
      instrument_token: "NSE_EQ|INE040A01034",
      transaction_type: "BUY",
      quantity: 50,
      average_price: 1600,
      order_timestamp: "2026-09-04 11:00:00",
      exchange_timestamp: "2026-09-04 11:00:00",
      ...over,
    });
    for (const [day, row] of [
      ["2026-09-04", fill({})],
      ["2026-09-08", fill({ transaction_type: "SELL", average_price: 1650, order_timestamp: "2026-09-08 11:00:00", exchange_timestamp: "2026-09-08 11:00:00" })],
    ] as const) {
      freezeAt(`${day}T09:30:00.000Z`);
      const fileName = `upstox-api-${day}`;
      importer.commitParsedFile(upstoxToParsedFile(normalizeUpstoxTrades([row], day)), fileName, null, UPSTOX, { supersedeSnapshot: { fileName } });
    }
    selectAccount(0);
    const pairs = dqQueries.getStaleOpenPairs().filter((p) => p.accountId === UPSTOX);
    expect(pairs.map((p) => [p.saleDate, p.saleDateStated, p.oneClick])).toEqual([["2026-09-08", true, true]]);
  });

  /** One card's text, from the whole page render. */
  const cardOf = (text: string, symbol: string) => {
    const chunks = text.split(STRATEGY_COPY.footer);
    return chunks.filter((ch) => ch.includes(`|${symbol}|`));
  };
  const optionRow = (symbol: string, strike: number, side: "short" | "long", expiry: string, premium: number, optionType: "CE" | "PE" = "CE") =>
    tradeRow({
      accountId: ANGEL,
      broker: "angelone",
      bucket: "fno",
      segment: "stock_option",
      instrumentType: "option",
      exchange: "NFO",
      symbol,
      tradingsymbol: `${symbol}${strike}${optionType}${expiry}`,
      optionType,
      strike,
      expiry,
      isOpen: true,
      ...(side === "short" ? { sellQty: 100, avgSellPrice: premium } : { buyQty: 100, avgBuyPrice: premium }),
    });
  let text = "";

  it("B3c · /strategies (free build): INFY's sold holding no longer covers its call — a naked Short Call with an Unlimited loss", () => {
    t.db
      .insert(t.schema.trades)
      .values([
        optionRow("INFY", 1600, "short", "2026-09-24", 20),
        // R11: a 4.2-named short call joined by a holding reads as a Pro covered call.
        optionRow("RELIANCE", 3000, "short", "2026-09-24", 40),
        tradeRow({ accountId: ANGEL, broker: "angelone", symbol: "RELIANCE", tradingsymbol: "RELIANCE", isOpen: true, buyQty: 100, avgBuyPrice: 2900, buyDate: "2026-09-01" }),
        // QS-SPLIT: an option-only book, Custom as a whole — a Sep short call covered by an Oct long call (+ an Oct long put).
        optionRow("WIPRO", 500, "short", "2026-09-24", 10),
        optionRow("WIPRO", 500, "long", "2026-10-29", 20),
        optionRow("WIPRO", 500, "long", "2026-10-29", 15, "PE"),
        // D3: a sale stored before QS-AO (Angel One v4.2.0: undated, acquisition NULL) out of a held lot.
        optionRow("ITC", 450, "short", "2026-09-24", 5),
        tradeRow({ accountId: ANGEL, broker: "angelone", symbol: "ITC", tradingsymbol: "ITC", isOpen: true, buyQty: 100, avgBuyPrice: 400, buyDate: "2026-09-01" }),
        tradeRow({ accountId: ANGEL, broker: "angelone", symbol: "ITC", tradingsymbol: "ITC", isOpen: true, sellQty: 100, avgSellPrice: 420, acquisition: null }),
        // D3 (bonus): a covered call, and a sale of BONUS shares the user recorded — a complete trade of shares acquired outside the book.
        optionRow("BEL", 400, "short", "2026-09-24", 6),
        tradeRow({ accountId: ANGEL, broker: "angelone", symbol: "BEL", tradingsymbol: "BEL", isOpen: true, buyQty: 100, avgBuyPrice: 380, buyDate: "2026-09-01" }),
        tradeRow({ accountId: ANGEL, broker: "angelone", symbol: "BEL", tradingsymbol: "BEL", isOpen: true, sellQty: 100, avgSellPrice: 390, acquisition: "bonus" }),
      ])
      .run();
    selectAccount(ANGEL);
    freezeAt("2026-09-08T09:30:00.000Z");
    text = textOf(renderToStaticMarkup(strategiesPage() as React.ReactElement));
    const infy = cardOf(text, "INFY");
    expect(infy).toHaveLength(1);
    // THE assertions (Custom (2 legs), bounded, on revert of the netting: the sold 100 shares covered the call).
    expect(infy[0]).toContain("|Short Call|");
    expect(infy[0]).toMatch(/Max loss\|Unlimited\|/);
  });

  it("B3c · R11: the free card that names no shape for RELIANCE carries the sentence saying a holding can do exactly that", () => {
    const rel = cardOf(text, "RELIANCE");
    expect(rel).toHaveLength(1);
    expect(rel[0]).toContain("|Custom (2 legs)|");
    expect(rel[0]).toContain(STRATEGY_COPY.proWithheldNote);
    expect(STRATEGY_COPY.proWithheldNote, "the note must name the holding that turned a free shape into a Pro one").toContain("a holding of the underlying");
  });

  it("B3c · QS-SPLIT: WIPRO's Sep short call covered by Oct long options is ONE card, and no card for it prints Unlimited or Short Call", () => {
    const wipro = cardOf(text, "WIPRO");
    expect(wipro, "the split into two per-expiry cards is refused").toHaveLength(1);
    // THE assertions (two cards on revert, the Sep half a naked "Short Call" reading Unlimited).
    expect(wipro[0]).not.toContain("Unlimited");
    expect(wipro[0]).not.toContain("|Short Call|");
  });

  // SEAM DEFECT D3 — FIXED (v4.3.0 fix wave 2, W2-FIXB); this was an `it.fails`.
  // plan-wave2.json seam 5: "One predicate meaning is shared: acquisition NULL
  // or 'unknown' = basis not recorded." Data Quality reads it that way
  // (data-quality.ts hasRecordedBasis) and lists ITC's NULL-acquisition sale as
  // the sale of the held lot; /strategies netted only `acquisition ===
  // "unknown"`, so the same row was a SHORT 100 × underlying leg. Measured
  // before: 3 legs, max profit ₹2,500. Now the page reads the SAME predicate
  // (`hasRecordedBasis`) for a delivery sell-only row: 1 leg, max profit ₹500.
  it("D3 — a NULL-acquisition sale Data Quality pairs with the lot also nets that lot on /strategies", () => {
    selectAccount(0);
    const itcPairs = dqQueries.getStaleOpenPairs().filter((p) => p.accountId === ANGEL && p.tradingsymbol === "ITC");
    expect(itcPairs.map((p) => p.oneClick), "Data Quality: the NULL-acquisition row IS the lot's sale").toEqual([true]);
    const itc = cardOf(text, "ITC");
    expect(itc).toHaveLength(1);
    expect(itc[0]).toContain("|1 leg|");
    expect(itc[0]).toMatch(/Max profit\|₹500\|/);
  });

  // D3's twin (orchestrator decision, W2-FIXB): a delivery sell-only row WITH a
  // recorded basis ('bonus') is a complete trade of shares acquired outside the
  // book. Data Quality never pairs it (P3); on /strategies it was a SHORT 100 ×
  // underlying that cancelled the held 100 — measured before: 3 legs, Max loss
  // Unlimited. It is now excluded from the join: never a short, and it never
  // reduces the held lot, so the call stays covered.
  it("D3 (bonus) — a sale of recorded bonus shares is no short leg and does not uncover the call: 2 legs, bounded", () => {
    selectAccount(0);
    expect(dqQueries.getStaleOpenPairs().filter((p) => p.accountId === ANGEL && p.tradingsymbol === "BEL"), "Data Quality: a recorded basis is never a pair").toEqual([]);
    const bel = cardOf(text, "BEL");
    expect(bel).toHaveLength(1);
    expect(bel[0]).toContain("|2 legs|");
    expect(bel[0]).not.toContain("Unlimited");
  });
});

// ============================================================================
// B4 — W2-DQ's join ↔ W2-IDENTITY's same-day supersede, and ↔ DuplicateFix / removeDuplicateCopy (P4)
// ============================================================================

describe("B4 · a lot joined from Data Quality meets the next same-day pull and the duplicate scan (DQ ↔ IDENTITY, DQ ↔ UI/actions)", () => {
  const PULL_1 = "2026-09-08T09:30:00.000Z"; // 15:00 IST
  const PULL_2 = "2026-09-08T12:30:00.000Z"; // 18:00 IST, the same IST day
  const BUY: DhanFill = { id: "TW-BUY", side: "BUY", qty: 10, price: 100, at: "2026-09-07 10:00:00", symbol: "SBIN" };
  const position = (buyQty: number, buyAvg: number, sellQty: number, sellAvg: number) => ({
    dhanClientId: CLIENT,
    tradingSymbol: "SBIN",
    positionType: buyQty === sellQty ? "CLOSED" : buyQty > sellQty ? "LONG" : "SHORT",
    exchangeSegment: "NSE_EQ",
    productType: "CNC",
    buyAvg,
    buyQty,
    sellAvg,
    sellQty,
    netQty: buyQty - sellQty,
  });

  it("both books pull the lot and today's sale, and both are joined through the close-stale route", async () => {
    for (const book of [TWIN_A, TWIN_B]) {
      freezeAt(PULL_1);
      addDhan(book, "2026-09-04T05:00:00.000Z");
      stubDhan([BUY], [position(0, 0, 10, 120)]);
      // W2b: same re-pin as B3a — the 7 Sep lot and today's sell-only position
      // must land as the stale PAIR the join is then asked to close, so the
      // seeding pull asks for separate rows. Nothing else in B4 changes.
      expect((await pull("dhan", book, { keepSellsSeparate: true })).status).toBe(200);
    }
    freezeAt(PULL_2);
    selectAccount(0);
    for (const book of [TWIN_A, TWIN_B]) {
      const pair = dqQueries.getStaleOpenPairs().find((p) => p.accountId === book)!;
      expect((await closeStale({ lotId: pair.lotId, saleId: pair.saleId, exitDate: pair.saleDate })).status).toBe(200);
      expect(storedRows(book).map((r) => [r.buyQty, r.sellQty, r.isOpen, r.sourceFile])).toEqual([[10, 10, false, "dhan-api-2026-09-08"]]);
    }
  });

  it("B4a · 18:00 IST the same day /positions restates the book with a new buy: the JOINED lot is never rewritten — the pull asks (409)", async () => {
    freezeAt(PULL_2);
    const before = storedRows(TWIN_A);
    stubDhan([], [position(10, 130, 10, 120)]);
    const res = await pull("dhan", TWIN_A);
    const json = (await res.json()) as { needsForce?: boolean };
    // THE assertions (on revert of the supersede plan the evening row lands beside the lot, 200).
    expect(res.status, "a same-day snapshot row that meets a joined lot must be asked about").toBe(409);
    expect(json.needsForce).toBe(true);
    expect(storedRows(TWIN_A), "the joined lot keeps its 7 Sep buy at ₹100").toEqual(before);
  });

  it("B4b · both books joined the same two records: DuplicateFix offers each copy, and the server action removes the one it was asked to", async () => {
    freezeAt(PULL_2);
    selectAccount(0);
    const groups = identity.listDuplicateTradeGroups().filter((g) => g.symbol === "SBIN" && g.broker === "dhan");
    expect(groups.length, "the BUY record and the SALE record, each held in both books").toBe(2);
    const html = renderToStaticMarkup(React.createElement(DuplicateFix, { groups, connections: identity.listDuplicateConnections() }));
    // THE assertions (0 and 0 on revert: a joined lot was read as an auto-close merge).
    expect(count(html, "Remove the copy in Twin A")).toBe(2);
    expect(count(html, "Remove the copy in Twin B")).toBe(2);
    const res = await dqActions.removeDuplicateCopy({ broker: "dhan", dedupHash: groups[0].dedupHash, accountId: TWIN_B });
    expect(res.ok, res.message).toBe(true);
    expect(res.removed).toBe(1);
    expect(storedRows(TWIN_B)).toEqual([]);
    expect(storedRows(TWIN_A).map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([[10, 10, false]]);
  });
});

// ============================================================================
// B5 — W2-VENUE's settled leg venue ↔ W2-DQ's book key (P9)
// ============================================================================

describe("B5 · a Zerodha tradebook day-side filled on both venues is stored at its majority venue and priced there (VENUE → commit)", () => {
  const HEAD = "Symbol,ISIN,Trade Date,Exchange,Trade Type,Quantity,Price,Order Execution Time";
  it("bought BSE 10 (first) + NSE 90 @ ₹100 on 3 Aug, sold 100 on NSE @ ₹99 on 10 Aug: one NSE row with NSE's exchange charge", () => {
    const csv = [
      "Tradebook",
      HEAD,
      "VENUEZ,INE000Z01009,2026-08-03,BSE,buy,10,100,2026-08-03 09:15:00",
      "VENUEZ,INE000Z01009,2026-08-03,NSE,buy,90,100,2026-08-03 09:20:00",
      "VENUEZ,INE000Z01009,2026-08-10,NSE,sell,100,99,2026-08-10 10:00:00",
      "",
    ].join("\n");
    const file = "zerodha-tradebook-aug.csv";
    importer.commitParsedFile(parseZerodha({ filename: file, text: csv, buffer: undefined } as never), file, null, ZVENUE);
    const rows = storedRows(ZVENUE);
    expect(rows.map((r) => [r.buyQty, r.sellQty, r.isOpen, r.segment])).toEqual([[100, 100, false, "eq_delivery"]]);
    const at = (exchange: "NSE" | "BSE") =>
      engine.computeCharges(
        { segment: "eq_delivery", buyValue: 10_000, sellValue: 9_900, buyQty: 100, sellQty: 100, buyOrderCount: 1, sellOrderCount: 1 },
        engine.findRates(engine.loadRatesMap(), "zerodha", "eq_delivery", exchange, "2026-08-10"),
      ).exchangeTxn;
    expect(at("NSE"), "floor: the venues' exchange charges differ on this row").not.toBe(at("BSE"));
    // THE assertions (BSE on revert: the buy leg wore its first fill's venue, and
    // ₹10,000 "on BSE" outweighed ₹9,900 on NSE in rowVenue).
    expect(rows[0].exchange).toBe("NSE");
    expect(rows[0].exchangeTxn).toBe(at("NSE"));
  });
});

// ============================================================================
// B6 — W2-EQ2012's 2012 STT epoch ↔ W2-IPO / W2-IPO2's exit pricing
// ============================================================================

describe("B6 · an IPO sold before 1 Jul 2012 pays 0.125% STT on the sale alone — both with no broker and with one (EQ2012 → IPO)", () => {
  it("₹1,00,000 sold on 15 Mar 2011 costs exactly ₹25 more than the same exit on 2 Jul 2012, whatever the broker", () => {
    const ipo = (name: string, broker: string | null, exitDate: string) => ({
      accountId: IPO,
      name,
      broker,
      exchange: "NSE",
      allotted: true,
      allottedQty: 1000,
      appliedPrice: 80,
      lotSize: 1000,
      exitPrice: 100,
      allotmentDate: exitDate.slice(0, 4) === "2011" ? "2011-02-01" : "2012-06-01",
      exitDate,
    });
    t.db
      .insert(t.schema.ipos)
      .values([ipo("NB-2011", null, "2011-03-15"), ipo("NB-2012", null, "2012-07-02"), ipo("ZD-2011", "zerodha", "2011-03-15"), ipo("ZD-2012", "zerodha", "2012-07-02")])
      .run();
    selectAccount(IPO);
    const byName = new Map(ipoQueries.getIposComputed().rows.map((r) => [r.name, r.charges]));
    const extra = (a: string, b: string) => paise(byName.get(a)!) - paise(byName.get(b)!);
    // 0.125% − 0.1% of the ₹1,00,000 sale = ₹25. On revert of the 2012 epoch: ₹0.
    // On revert of the IPO pricing: ₹0 with no broker (a frozen 0.1%), ₹45 with
    // one (purchase STT on the ₹80,000 allotment as well).
    expect.soft(extra("NB-2011", "NB-2012"), "no broker: the statutory row of 15 Mar 2011").toBe(2500);
    expect(extra("ZD-2011", "ZD-2012"), "zerodha: the broker's row of 15 Mar 2011, sale side only").toBe(2500);
  });
});

// ============================================================================
// B7 — W2-EQ2012's epoch ↔ W2-UI's P6 preview body ↔ createManualTrade
// ============================================================================

describe("B7 · the Add-trade preview of a 2011 delivery round trip is the figure the save stores, at 0.125% STT on both sides (EQ2012 → UI → actions)", () => {
  it("INFY 100 @ ₹1,000 on 1 Mar 2011 → @ ₹1,100 on 15 Mar 2011", async () => {
    selectAccount(MANUAL);
    const form = {
      broker: "zerodha",
      tradingsymbol: "INFY",
      productHint: "delivery",
      segment: null,
      exchange: "NSE",
      direction: "buy" as const,
      open: false,
      entryQty: 100,
      entryPrice: 1000,
      entryDate: "2011-03-01",
      exitQty: 100,
      exitPrice: 1100,
      exitDate: "2011-03-15",
      ownCapitalUsed: null,
      daysHeld: 14,
    };
    const res = await previewRoute.POST(
      new Request("http://localhost/api/charges/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildManualPreviewBody(form)),
      }),
    );
    expect(res.status).toBe(200);
    const preview = ((await res.json()) as { breakdown: { sttCtt: number; total: number } }).breakdown;

    const fd = new FormData();
    for (const [k, v] of Object.entries({
      broker: "zerodha",
      tradingsymbol: "INFY",
      productHint: "delivery",
      exchange: "NSE",
      direction: "buy",
      buyQty: "100",
      avgBuyPrice: "1000",
      buyDate: "2011-03-01",
      sellQty: "100",
      avgSellPrice: "1100",
      sellDate: "2011-03-15",
      accountId: String(MANUAL),
    })) fd.set(k, v);
    const saved = await tradeActions.createManualTrade({ ok: false, message: "" } as never, fd);
    expect(saved.ok, saved.message).toBe(true);
    const [row] = storedRows(MANUAL);
    expect([row.sttCtt, row.chargesTotal], "the save stores what the preview showed").toEqual([preview.sttCtt, preview.total]);
    // THE assertion (210 on revert of the epoch: 0.1% of ₹2,10,000).
    expect(row.sttCtt).toBe(263);
  });
});

// ============================================================================
// B8 — W2-SPOT's dated mark and close ↔ the notice ↔ the two routes ↔ the dismissal read ↔ settlement
// ============================================================================

type Elem = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const isElem = (n: unknown): n is Elem => !!n && typeof n === "object" && "type" in n && "props" in n;
function findElem(node: unknown, pick: (e: Elem) => boolean): Elem | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findElem(n, pick);
      if (hit) return hit;
    }
    return null;
  }
  if (!isElem(node)) return null;
  if (pick(node)) return node;
  return findElem(node.props.children, pick);
}

describe("B8 · a stored mark older than the official close: the row says so, 'Keep my mark' hides it for that close, 'Use official close' re-prices the settlement (SPOT, end to end)", () => {
  const SHORT_ID = 99_001;
  const dayOffset = (n: number) => new Date(Date.parse(`${todayIstIso()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const panel = () => {
    const el = findElem(riskPage(), (e) => e.type === ExpiryObligations);
    if (!el) throw new Error("the risk page no longer renders <ExpiryObligations>");
    const props = el.props as unknown as React.ComponentProps<typeof ExpiryObligations>;
    return {
      props,
      o: props.summary.obligations.find((x) => x.id === SHORT_ID),
      spot: props.spotRefs?.SBIN,
      html: renderToStaticMarkup(React.createElement(ExpiryObligations, props)),
    };
  };
  /** The chip's client `fetch`, handed to the route handler it names. */
  const wireRoutes = () =>
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const req = new Request(`http://localhost${url}`, init);
      if (url === editor.SPOT_KEEP_MARK_ENDPOINT) return dismissRoute.POST(req);
      if (url === editor.SPOT_MARK_ENDPOINT) return spotRoute.POST(req);
      throw new Error(`unexpected fetch ${url}`);
    });

  it("B8a · mark ₹1,390 (3 days ago) vs close ₹1,500 (yesterday): OTM on the mark, and the row states the newer close", () => {
    selectAccount(RISK);
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          id: SHORT_ID,
          accountId: RISK,
          bucket: "active",
          segment: "stock_option",
          instrumentType: "option",
          exchange: "NFO",
          symbol: "SBIN",
          tradingsymbol: "OPT SBIN 29 SEP 2026 1400 CE",
          optionType: "CE",
          strike: 1400,
          expiry: dayOffset(5),
          sellQty: 500,
          avgSellPrice: 20,
          isOpen: true,
        }),
      )
      .run();
    t.db.insert(t.schema.mtmPrices).values({ symbol: "SBIN", tradingsymbol: "SBIN", price: 1390, asOfDate: dayOffset(-3) }).run();
    t.db.insert(t.schema.priceHistory).values({ symbol: "SBIN", date: dayOffset(-1), close: 1500, source: "bhavcopy" }).run();

    const p = panel();
    expect(p.spot).toEqual({ value: 1390, source: "mark", asOf: dayOffset(-3), close: { price: 1500, asOf: dayOffset(-1) } });
    expect(p.o?.moneyness, "the mark wins even when older (ruling 225)").toBe("OTM");
    expect(p.html).toContain(`Official close ${dayOffset(-1)}: ₹1,500.00 — differs from your mark ₹1,390.00`);
  });

  it("B8b · 'Keep my mark' posts the close the row showed; the page reads that dismissal back for this account and prints no notice", async () => {
    selectAccount(RISK);
    wireRoutes();
    const before = panel();
    const notice = spotCloseNotice("SBIN", before.spot!, before.props.spotCloseDismissed);
    expect(notice).not.toBeNull();
    let refreshed = 0;
    const kept = await editor.submitKeepMark("SBIN", notice!.close, () => refreshed++);
    expect(kept.ok, kept.message).toBe(true);
    expect(refreshed).toBe(1);
    const after = panel();
    // THE assertion (the notice survives on revert: the page never reads the kept fingerprint).
    expect(after.html).not.toContain("Official close");
    expect(after.o?.moneyness).toBe("OTM");
  });

  it("B8c · 'Use official close' stores the close's own day: the chip reads 'mark · yesterday', ITM, ₹700 of delivery STT", async () => {
    selectAccount(RISK);
    wireRoutes();
    const before = panel();
    let refreshed = 0;
    const res = await editor.submitSpotMark("SBIN", before.spot!.close!.price, () => refreshed++, before.spot!.close!.asOf);
    expect(res.ok, res.message).toBe(true);
    const after = panel();
    // THE assertions (on revert of the route's asOfDate: the mark is dated TODAY).
    expect(after.spot?.asOf).toBe(dayOffset(-1));
    expect(after.html).toContain(spotChipLabel({ value: 1500, source: "mark", asOf: dayOffset(-1) }));
    expect(after.o?.moneyness).toBe("ITM");
    expect(after.o?.physicalStt, "0.1% × 1400 × 500 on the writer").toBe(700);
    expect(after.html).not.toContain("Official close");
  });
});

// ============================================================================
// B9 — W2-HELP's P7 doctrine ↔ settlement's physicalStt
// ============================================================================

describe("B9 · the help's STT doctrine for a LONG PUT, applied to a position, is the ₹ settlement computes (HELP → SETTLE)", () => {
  it("RELIANCE 3000 PE × 250, spot 2900: delivery ₹750 + exercise on intrinsic ₹31", () => {
    const risk = OPTIONS_HELP.find((e) => e.id === "long-put")!.risk;
    const [o] = computeSettlement(
      [
        {
          id: 1,
          symbol: "RELIANCE",
          tradingsymbol: "OPT RELIANCE 25 Jun 2026 3000 PE",
          segment: "stock_option",
          optionType: "PE",
          strike: 3000,
          side: "long",
          expiry: "2026-06-26",
          netQty: 250,
          refPrice: 2900,
        } as SettlementInput,
      ],
      DEFAULT_SETTLEMENT_RATES,
      "2026-06-24",
    ).obligations;
    const byHelp =
      (risk.includes("equity-delivery rate on the shares' strike value, on both sides") ? Math.round(DEFAULT_SETTLEMENT_RATES.deliverySttPct * 3000 * 250) : 0) +
      (/STT on intrinsic value/.test(risk) ? Math.round(DEFAULT_SETTLEMENT_RATES.exerciseSttPct * (3000 - 2900) * 250) : 0);
    // THE assertion (₹31 by the help on revert: it named only the exercise STT).
    expect(o.physicalStt, "the panel's ₹ must be the help's doctrine applied to this long put").toBe(byHelp);
  });
});

// ============================================================================
// B10 — the route's API brokers ↔ the landing page's count (R22)
// ============================================================================

describe("B10 · the landing page states the number of broker-API pulls the route actually offers (route → DOCS)", () => {
  it("every '<n> … API' count on the page equals the route's own list, OpenAlgo excluded", async () => {
    const res = await postBroker({ action: "save", broker: "no-such-broker" });
    expect(res.status).toBe(400);
    const message = ((await res.json()) as { message: string }).message;
    const labels = message.replace(/^Unsupported broker\. Available: /, "").replace(/\.$/, "").split(", ");
    const pulls = labels.filter((l) => !/^OpenAlgo/.test(l)).length;
    expect(labels.length - pulls, "OpenAlgo is still offered, so excluding it means something").toBe(1);
    const html = fs.readFileSync(path.resolve(__dirname, "../docs/sales/landing-page.html"), "utf8");
    const stated = [...html.matchAll(/(\d+) (?:broker APIs|broker-API pulls|API pulls)/g)].map((m) => Number(m[1]));
    expect(stated.length).toBe(3);
    // THE assertion (3 on the comparison row on revert).
    expect(stated).toEqual([pulls, pulls, pulls]);
  });
});
