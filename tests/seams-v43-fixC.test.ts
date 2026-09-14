import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { STRATEGY_COPY } from "@/components/strategies/strategy-copy";
import { buildManualPreviewBody, type ManualPreviewInput } from "@/components/trades/manual-preview-body";
import { normalizeAngelTrades, toParsedFile as angelToParsedFile, type AngelTradeRow } from "@/lib/import/api/angelone";
import { staleAmbiguousNote, staleFillsNote } from "@/lib/analytics/data-quality";
import { computeExposure } from "@/lib/analytics/exposure";
import { todayIstIso } from "@/lib/domain/trading-day";
import { inr } from "@/lib/format";
import { Dialog } from "@/components/ui/dialog";

/**
 * v4.3.0 FIX WAVE 2R — THE SEAMS OF AN EIGHT-BUILDER WAVE.
 *
 * Phase A (R2-IDENTITY, R2-PULLNOTICE, R2-RATES, R2-STRAT, R2-COPY, R2-SPOT,
 * R2-UI) and phase B (R2-DQ) owned disjoint file sets — except lib/import/commit.ts,
 * split by function between IDENTITY (planSnapshot) and DQ (closePosition,
 * closeStaleLot). This file runs the two real halves of every value that crosses
 * from one builder's files into another's, or from a 2R change into the
 * unchanged code it feeds (the pull route, the auto-pull sweep, the account
 * merge, the /risk and /strategies pages, the preview route, the save action).
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The stubs are framework and
 * transport only: `next/cache`, `next/navigation` (no request, no mounted
 * router) and `globalThis.fetch` for api.dhan.co / apiconnect.angelone.in. One
 * fault is INJECTED, not mocked: an SQLite trigger that makes the import batch
 * insert fail, which is how a pull whose commit throws is reached (C4).
 *
 * ── THE SEAM TABLE ───────────────────────────────────────────────────────────
 *
 *  # | crossing value                          | producer (file:line, builder)                      | consumer (file:line)                                         | unit / shape                        | test
 * ---|-----------------------------------------|----------------------------------------------------|--------------------------------------------------------------|-------------------------------------|-----
 *  1 | planSnapshot ask → snapshotIds          | lib/import/commit.ts:450 planSnapshot +            | lib/import/cross-source.ts:112 snapshotOf, :279 message      | row ids of today's snapshot on the  | C1a
 *    |   (N1 carriesUserRecord)                |   :394 carriesUserRecord (IDENTITY)                |   (IDENTITY) → app/api/import/broker/route.ts:1013/:1053     |   supersede key → 409 needsForce    | C1b
 *    |                                         |                                                    |   → components/import/broker-connect.tsx:124 pullResultMessage| + a sentence                        |
 *  2 | ask with no relation ('earlier-snapshot')| commit.ts:476 (laddered) (IDENTITY)               | cross-source.ts:248 → lib/jobs/auto-pull.ts:93/:282 sweep    | OverlapKind → "collision" skip      | C2
 *    |                                         |                                                    |   (unchanged); broker-connect.tsx:1421 badge (PULLNOTICE)    |                                     | D1 (report)
 *  3 | page-cap fact naming the pull's IST day | lib/import/api/dhan.ts:1369 (PULLNOTICE)           | dhan-unfetched.ts keepUnfetched → route GET :343 →           | ISO day inside a kept sentence      | C3
 *    |   (N6)                                  |                                                    |   broker-connect.tsx:331 unfetchedNotice                     |                                     |
 *  4 | clamped retry: range-cap names the gap  | dhan.ts:377 catchUpRange + route :841 readWindow   | lib/import/dhan-unfetched.ts:226 clearCoveredPageCaps        | [from,to] ISO spans, connId         | C4
 *    |   (N5)                                  |   (unchanged)                                      |   (PULLNOTICE) → GET unfetched                               |                                     |
 *  5 | merge-carried span, connId null (N4)    | lib/queries/account-delete.ts:775 carry (unchanged)| dhan-unfetched.ts:123 sameConnection (PULLNOTICE) ← the      | entity_id NULL                      | C5
 *    |                                         |                                                    |   target's own pull (route :1083)                            |                                     |
 *  6 | StaleOpenPair.ambiguous + closedLotIds  | lib/analytics/data-quality.ts:556 (DQ), the closed | lib/queries/data-quality.ts:65 view → components/quality/    | boolean + trade ids → no button,    | C6
 *    |   (N7/N8)                               |   lot written by app/trades/actions.ts:363         |   stale-lot-fix.tsx:164 → route → commit.ts:2022 AMBIGUOUS   |   409 AMBIGUOUS                     |
 *    |                                         |   addExitLegAction (ladder exit, unchanged)        |   + assessDataQuality stale_review                           |                                     |
 *  7 | saleStaged / trade_legs on the SALE     | commit.ts:1471 writeLadder on import (IDENTITY's   | data-quality.ts saleStaged → queries view blocked            | boolean → staleFillsNote, 409 FILLS | C7
 *    |   (N10)                                 |   file, unchanged path)                            |   (staleFillsNote) → stale-lot-fix.tsx:171 → commit.ts:2029  |                                     |
 *  8 | staged position → close entry points    | commit.ts:1471 writeLadder; app/risk/page.tsx:172  | risk-cockpit-client.tsx:579 PositionCloseControl,            | tranches != null / staged → a link, | C8
 *    |   (N11)                                 |   tranches (unchanged)                             |   trades-client.tsx:78 CloseEntryButton, /api/positions/close|   409 STAGED, nothing written       |
 *    |                                         |                                                    |   :20, actions.ts:242 closeTradeAction → commit.ts:1762      |                                     |
 *  9 | UnderlyingLegRow.accountId (N16)        | lib/queries/trades.ts:285 (STRAT)                  | app/strategies/page.tsx:120 netting key (STRAT) under        | account id → per-account floor      | C9
 *    |                                         |                                                    |   getSelectedAccountId() = 0 → strategy card                 |                                     |
 * 10 | proWithheldNote shape list (N19)        | components/strategies/strategy-copy.ts:113 (COPY)  | page.tsx withholdForFree → strategy-card (STRAT)             | sentence beside "Custom (2 legs)"   | C9
 * 11 | closeDiffers at the paisa (N23)         | lib/risk/spot-ref.ts:141 (SPOT)                    | spotCloseNotice → app/risk/page.tsx:335 → components/risk/   | REAL ₹/unit, ISO day → a notice     | C10
 *    |                                         |                                                    |   expiry-obligations.tsx:226 (unchanged)                     |                                     |
 * 12 | IpoComputed.unpriced / chargeBreakdown  | lib/queries/ipos.ts:78 sellChargerFor +            | components/ipo/ipo-client.tsx:154/:261 (RATES),              | null → "—"; ₹ heads → a label       | C11
 *    |   (N13, N15)                            |   lib/analytics/ipo.ts:316 computeIpo (RATES)      |   getIpoRealisedNet (capital)                                |                                     |
 * 13 | allotment stamp base (N14)              | ipo.ts ipoAllotmentStampBase (RATES)               | ipos.ts chargeBreakdownFor → getIposComputed                 | ₹ (0 from 1 Jul 2020)               | C12
 * 14 | IpoForm preview vs saved figure (N15)   | ipo.ts seedFallbackCharger (RATES)                 | ipo-client.tsx:481 label vs ipos.ts server figure            | ₹ before broker charges             | C12
 * 15 | ManualPreviewBody for kind "fno" (N24)  | components/trades/manual-preview-body.ts:88 (UI)   | app/api/charges/preview/route.ts ↔ app/trades/actions.ts     | integer ₹ both sides                | C13
 *    |                                         |                                                    |   createManualTrade (unchanged)                              |                                     |
 * 16 | CHARGE_ROWS_RULE vs restoreBaseline     | components/settings/default-settings-card.tsx:30   | lib/queries/settings-baseline.ts:80 restoreBaseline + its    | a sentence ↔ user_edited per row    | C14
 *    |   (N25)                                 |   (UI)                                             |   toast :112 (unchanged) via app/api/settings-baseline       |                                     | D2
 *
 * Not re-run here because an existing seam file already runs both halves:
 * R82 / N21 "was refused" through the pull route into the card
 * (tests/seams-v43-fixB.test.ts B1, re-pinned by PULLNOTICE); N17's ISIN
 * fallback (tests/strategies-ul-join.test.ts through the real query + page);
 * N12's same-day direction is inside one builder's module (no crossing).
 *
 * RED ON REVERT (2026-09-15): each changed side copied back to HEAD a7e9288 in
 * turn, run, restored byte-identical. commit.ts → C1a, C1b, C2 ×2, C6, C7, C8;
 * cross-source.ts → C1a, C1b, C2 ×2; dhan-unfetched.ts → C4, C5; dhan.ts → C3;
 * analytics/data-quality.ts → C6, C7; queries/data-quality.ts → C7;
 * stale-lot-fix.tsx → C6, C7; close-stale route → C6, C7; positions/close route
 * → C8; actions.ts → C8; trades-client.tsx → C8; risk-cockpit-client.tsx → C8;
 * strategies page.tsx → C9; queries/trades.ts → C9; strategy-copy.ts → C9 ×2;
 * spot-ref.ts → C10; ipo.ts / ipos.ts → C11 ×2, C12 ×2; ipo-client.tsx → C11 ×2,
 * C12; manual-preview-body.ts → C13; default-settings-card.tsx → C14. Not run
 * here: manual-trade-form.tsx (its `kind` reaches the builder only inside a
 * client effect — no DOM renderer) and help-content.ts (no crossing consumer).
 *
 * SEAM DEFECTS: D2 is pinned as `it.fails` holding the RIGHT value (it passes
 * while the defect stands; flip it to `it` once fixed). D1 is a client dialog
 * gated on state set by a click after a fetch — with no DOM renderer in the
 * repo it cannot be rendered, so it is reported with file:line, not pinned.
 *
 * ONE temp database for this file (AGENTS.md Testing). Each seam owns its account.
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
let journalRoute: typeof import("@/app/api/trades/journal/route");
let closeStaleRoute: typeof import("@/app/api/data-quality/close-stale/route");
let positionsCloseRoute: typeof import("@/app/api/positions/close/route");
let previewRoute: typeof import("@/app/api/charges/preview/route");
let settingsRoute: typeof import("@/app/api/settings/route");
let baselineRoute: typeof import("@/app/api/settings-baseline/route");
let bc: typeof import("@/components/import/broker-connect");
let importer: typeof import("@/lib/import/commit");
let job: typeof import("@/lib/jobs/auto-pull");
let accountDelete: typeof import("@/lib/queries/account-delete");
let dqQueries: typeof import("@/lib/queries/data-quality");
let tradeQueries: typeof import("@/lib/queries/trades");
let tradeActions: typeof import("@/app/trades/actions");
let ipoQueries: typeof import("@/lib/queries/ipos");
let rates: { loadRatesMap: typeof import("@/lib/engine/rates-db").loadRatesMap; statutoryRatesFor: typeof import("@/lib/engine/rates").statutoryRatesFor };
let StaleLotFix: typeof import("@/components/quality/stale-lot-fix").StaleLotFix;
let ExpiryObligations: typeof import("@/components/risk/expiry-obligations").ExpiryObligations;
let riskClient: Record<string, unknown>;
let tradesClient: Record<string, unknown>;
let ipoClient: Record<string, unknown>;
let DefaultSettingsCard: typeof import("@/components/settings/default-settings-card").DefaultSettingsCard;
let riskPage: () => unknown;
let strategiesPage: () => unknown;

const A_NOTE = 1201; //   C1
const A_SWEEP = 1202; //  C2
const N_S = 1211; //      C3 + C5 (merge source)
const N_T = 1212; //      C5 (merge target)
const N_RETRY = 1213; //  C4
const DQ_AMB = 1221; //   C6
const DQ_FILLS = 1222; // C7
const DQ_STAGED = 1223; //C8
const ST_A = 1231; //     C9
const ST_B = 1232; //     C9
const SPOT = 1241; //     C10
const IPO = 1251; //      C11, C12
const MANUAL = 1261; //   C13

// ONE temp database for this file. Migrating + seeding it and importing the
// routes measured ~1.7 s locally (2026-09-15, inside the 3 s hook budget); the
// raised timeout is for the Windows runner, measured > 15x slower.
beforeAll(async () => {
  t = await openTempDb("seams-v43-fixC", { seed: true });
  brokerRoute = await import("@/app/api/import/broker/route");
  journalRoute = await import("@/app/api/trades/journal/route");
  closeStaleRoute = await import("@/app/api/data-quality/close-stale/route");
  positionsCloseRoute = await import("@/app/api/positions/close/route");
  previewRoute = await import("@/app/api/charges/preview/route");
  settingsRoute = await import("@/app/api/settings/route");
  baselineRoute = await import("@/app/api/settings-baseline/route");
  bc = await import("@/components/import/broker-connect");
  importer = await import("@/lib/import/commit");
  job = await import("@/lib/jobs/auto-pull");
  accountDelete = await import("@/lib/queries/account-delete");
  dqQueries = await import("@/lib/queries/data-quality");
  tradeQueries = await import("@/lib/queries/trades");
  tradeActions = await import("@/app/trades/actions");
  ipoQueries = await import("@/lib/queries/ipos");
  rates = {
    loadRatesMap: (await import("@/lib/engine/rates-db")).loadRatesMap,
    statutoryRatesFor: (await import("@/lib/engine/rates")).statutoryRatesFor,
  };
  t.db
    .insert(t.schema.accounts)
    .values(
      [A_NOTE, A_SWEEP, N_S, N_T, N_RETRY, DQ_AMB, DQ_FILLS, DQ_STAGED, ST_A, ST_B, SPOT, IPO, MANUAL].map((id) => ({
        id,
        name: `fixC ${id}`,
        isDefault: false,
      })),
    )
    .run();
  // A FREE build: the trial started long ago (settings, not a mock), so a Pro
  // shape reads "Custom (n legs)" on /strategies (C9).
  t.sqlite.prepare("UPDATE settings SET trial_started_at = '2020-01-01T00:00:00.000Z'").run();
}, 120_000);

// The pages and client components, in a hook of their own: their first import
// and render is a one-off cost (~0.4-1 s locally, 2026-09-15) that belongs in a
// hook, not in an `it`. Client modules are held as records so a builder's export
// that a revert removes fails ITS test, not the whole file.
beforeAll(async () => {
  ({ StaleLotFix } = await import("@/components/quality/stale-lot-fix"));
  ({ ExpiryObligations } = await import("@/components/risk/expiry-obligations"));
  ({ DefaultSettingsCard } = await import("@/components/settings/default-settings-card"));
  riskClient = (await import("@/components/risk/risk-cockpit-client")) as unknown as Record<string, unknown>;
  tradesClient = (await import("@/components/trades/trades-client")) as unknown as Record<string, unknown>;
  ipoClient = (await import("@/components/ipo/ipo-client")) as unknown as Record<string, unknown>;
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  strategiesPage = (await import("@/app/strategies/page")).default as () => unknown;
  selectAccount(SPOT);
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

const clientOf = (accountId: number) => `10000${accountId}`;

function addDhan(accountId: number, lastPullAt: string | null) {
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, ?)")
    .run(accountId, clientOf(accountId), alive(), lastPullAt);
}

const dhanPosition = (accountId: number, symbol: string, buyQty: number, buyAvg: number, sellQty: number, sellAvg: number) => ({
  dhanClientId: clientOf(accountId),
  tradingSymbol: symbol,
  positionType: buyQty === sellQty ? "CLOSED" : buyQty > sellQty ? "LONG" : "SHORT",
  exchangeSegment: "NSE_EQ",
  productType: "CNC",
  buyAvg,
  buyQty,
  sellAvg,
  sellQty,
  netQty: buyQty - sellQty,
});

/**
 * api.dhan.co. `history` answers every history page asked for: "empty" ends the
 * walk at page 0; "endless" answers a fill on every page, so the walk stops at
 * the 50-page cap WITHOUT an empty page — a truncated walk. /v2/positions
 * answers `positions`.
 */
function stubDhan(accountId: number, history: "empty" | "endless", positions: unknown[]) {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    const body =
      u.host === "auth.dhan.co"
        ? { accessToken: alive() }
        : u.pathname === "/v2/positions"
          ? positions
          : /^\/v2\/trades\//.test(u.pathname) && history === "endless"
            ? [
                {
                  dhanClientId: clientOf(accountId),
                  exchangeTradeId: "PAGE-FILL",
                  orderId: "O-PAGE",
                  transactionType: "BUY",
                  exchangeSegment: "NSE_EQ",
                  productType: "CNC",
                  tradingSymbol: "TCS",
                  tradedQuantity: 1,
                  tradedPrice: 100,
                  exchangeTime: "2026-06-20 10:00:00",
                },
              ]
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

const pull = (accountId: number, mode: "preview" | "commit", force = false) =>
  postBroker({ action: "pull", broker: "dhan", accountId, mode, ...(force ? { force: true } : {}) });

/** GET's `unfetched` for this account's Dhan row — what the card reads. */
async function unfetchedOf(accountId: number): Promise<import("@/components/import/broker-connect").UnfetchedSpan[]> {
  selectAccount(0);
  const json = (await (await brokerRoute.GET()).json()) as { connections?: { broker: string; accountId: number; unfetched?: unknown[] }[] };
  const rows = json.connections ?? (json as unknown as { broker: string; accountId: number; unfetched?: unknown[] }[]);
  const row = (Array.isArray(rows) ? rows : []).find((r) => r.broker === "dhan" && r.accountId === accountId);
  if (!row) throw new Error(`GET lists no Dhan connection for account ${accountId}`);
  return (row.unfetched ?? []) as import("@/components/import/broker-connect").UnfetchedSpan[];
}

const storedRows = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);

const legsOf = (tradeId: number) => t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, tradeId)).all();

const angelFill = (symbol: string, side: "BUY" | "SELL", qty: number, price: number, time: string): AngelTradeRow => ({
  tradingsymbol: `${symbol}-EQ`,
  exchange: "NSE",
  producttype: "DELIVERY",
  transactiontype: side,
  fillsize: String(qty),
  fillprice: String(price),
  filltime: time,
});

/** The Angel One pull's own parse, committed the way the route commits it. */
function commitAngel(accountId: number, day: string, fills: AngelTradeRow[]) {
  const fileName = `angelone-api-${day}`;
  return importer.commitParsedFile(angelToParsedFile(normalizeAngelTrades(fills, day).trades), fileName, null, accountId, {
    supersedeSnapshot: { fileName },
  });
}

const closeStale = async (body: { lotId: number; saleId: number; exitDate: string }) => {
  const res = await closeStaleRoute.POST(
    new Request("http://localhost/api/data-quality/close-stale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as { ok: boolean; code?: string; message: string } };
};

const formOf = (fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};

const paise = (n: number) => Math.round(n * 100);
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

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

// ============================================================================
// C1 — IDENTITY's user-record guard + ask ↔ the pull route ↔ the card's line
// ============================================================================

describe("C1 · a same-day Dhan re-pull meets a position the user wrote a note on (IDENTITY → route → PULLNOTICE card)", () => {
  const MORNING = "2026-09-08T04:30:00.000Z"; // 10:00 IST
  const EVENING = "2026-09-08T10:30:00.000Z"; // 16:00 IST, the same IST day
  let noted: ReturnType<typeof storedRows>;

  it("C1a · preview: the card's line asks about today's earlier pull, and never advises deleting the earlier import", async () => {
    freezeAt(MORNING);
    addDhan(A_NOTE, null);
    stubDhan(A_NOTE, "empty", [dhanPosition(A_NOTE, "SBIN", 10, 100, 0, 0)]);
    expect((await pull(A_NOTE, "commit")).status).toBe(200);
    const [row] = storedRows(A_NOTE);
    const saved = await journalRoute.POST(
      new Request("http://localhost/api/trades/journal", {
        method: "POST",
        body: JSON.stringify({ id: row.id, notes: "bought the retest" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(saved.status).toBe(200);
    noted = storedRows(A_NOTE);
    expect(noted.map((r) => [r.buyQty, r.sellQty, r.isOpen, r.notes])).toEqual([[10, 0, true, "bought the retest"]]);

    freezeAt(EVENING);
    stubDhan(A_NOTE, "empty", [dhanPosition(A_NOTE, "SBIN", 10, 100, 10, 120)]);
    const res = await pull(A_NOTE, "preview");
    expect(res.status).toBe(200);
    const line = bc.pullResultMessage("preview", await res.json());
    // THE assertions (on revert of commit.ts the row is superseded and no
    // question is asked; on revert of cross-source.ts the same-file row stays
    // hidden, so neither sentence reaches the card).
    expect(line).toContain("1 row in this pull (SBIN) restates a position today's earlier pull already recorded, and is not written over it");
    expect(line).not.toContain("Delete the earlier import first");
  });

  it("C1b · commit: 409 needsForce naming the noted row, nothing written; forced, the evening row lands BESIDE the noted one", async () => {
    freezeAt(EVENING);
    stubDhan(A_NOTE, "empty", [dhanPosition(A_NOTE, "SBIN", 10, 100, 10, 120)]);
    const res = await pull(A_NOTE, "commit");
    const json = (await res.json()) as { needsForce?: boolean; collisions?: { existing: { id: number }; sameSnapshot: boolean }[] };
    // THE assertions (200 on revert of either side: the note's row rewritten in place, or a second row added unasked).
    expect(res.status).toBe(409);
    expect(json.needsForce).toBe(true);
    expect(json.collisions?.map((c) => [c.existing.id, c.sameSnapshot])).toEqual([[noted[0].id, true]]);
    expect(storedRows(A_NOTE)).toEqual(noted);

    const forced = await pull(A_NOTE, "commit", true);
    expect(forced.status).toBe(200);
    const after = storedRows(A_NOTE);
    expect(after[0], "the noted morning row is never rewritten").toEqual(noted[0]);
    expect(after.slice(1).map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([[10, 10, false]]);
  });
});

// ============================================================================
// C2 — IDENTITY's N2 ask (no relation) ↔ the unattended sweep
// ============================================================================

describe("C2 · the evening auto-pull meets a laddered morning row that grew 20 → 25 (IDENTITY → auto-pull)", () => {
  const stubAngel = (fills: AngelTradeRow[]) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const data = String(url).includes("loginByPassword") ? { jwtToken: "jwt" } : fills;
      return new Response(JSON.stringify({ status: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  const sweep = async (iso: string) => {
    freezeAt(iso);
    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    return job.runAutoPull(new Date(iso));
  };

  it("the sweep skips it as a collision and the book still holds the 20 the broker's morning stated", async () => {
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json) VALUES (?, 'angelone', 'key', '', ?)")
      .run(A_SWEEP, JSON.stringify({ clientCode: "C7", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" }));
    const morningFills = [angelFill("LADDER", "BUY", 10, 100, "10:00:00"), angelFill("LADDER", "BUY", 10, 101, "10:05:00")];
    stubAngel(morningFills);
    const morning = await sweep("2026-09-09T04:45:00.000Z");
    expect(morning.summary.filter((e) => e.accountId === A_SWEEP).map((e) => e.status)).toEqual(["imported"]);
    const [ladder] = storedRows(A_SWEEP);
    expect([ladder.buyQty, ladder.staged, legsOf(ladder.id).length], "the morning row is a ladder of two fills").toEqual([20, true, 2]);

    stubAngel([...morningFills, angelFill("LADDER", "BUY", 5, 102, "14:00:00")]);
    const evening = await sweep("2026-09-09T10:30:00.000Z");
    // THE assertions (on revert of commit.ts or cross-source.ts the sweep
    // commits: "+1 trade", and the book holds 45 against the broker's 25).
    expect(evening.summary.filter((e) => e.accountId === A_SWEEP).map((e) => e.status)).toEqual(["collision"]);
    expect(evening.line).toContain("Angel One skipped (collision — review in Import)");
    expect(storedRows(A_SWEEP).reduce((s, r) => s + r.buyQty, 0)).toBe(20);
  });

  it("'review in Import': the manual pull of the same book answers 409 with the earlier-snapshot question the card's dialog receives", async () => {
    freezeAt("2026-09-09T11:00:00.000Z");
    stubAngel([
      angelFill("LADDER", "BUY", 10, 100, "10:00:00"),
      angelFill("LADDER", "BUY", 10, 101, "10:05:00"),
      angelFill("LADDER", "BUY", 5, 102, "14:00:00"),
    ]);
    const res = await postBroker({ action: "pull", broker: "angelone", accountId: A_SWEEP, mode: "commit" });
    const json = (await res.json()) as { needsForce?: boolean; message: string; collisions?: { kind: string; sameSnapshot: boolean; incoming: { buyQty: number }; existing: { buyQty: number } }[] };
    // THE assertions (200 on revert of commit.ts or cross-source.ts; kind is the
    // IDENTITY-only 'earlier-snapshot', which the dialog badge at
    // broker-connect.tsx:1421 prints as "partial overlap" — seam defect D1).
    expect([res.status, json.needsForce]).toEqual([409, true]);
    expect(json.collisions?.map((c) => [c.kind, c.sameSnapshot, c.incoming.buyQty, c.existing.buyQty])).toEqual([["earlier-snapshot", true, 25, 20]]);
    expect(json.message).toContain("restates a position today's earlier pull already recorded");
    expect(storedRows(A_SWEEP).reduce((s, r) => s + r.buyQty, 0)).toBe(20);
  });
});

// ============================================================================
// C3 + C5 — PULLNOTICE's kept fact ↔ GET ↔ the card; the merge carry ↔ the target's pull
// ============================================================================

describe("C3 / C5 · a truncated Dhan walk's kept notice, read days later and after an account merge (PULLNOTICE ↔ route, merge)", () => {
  it("C3 · N6: on 12 Sep the card prints the 10 Sep pull's notice naming 10 Sep — never 'this pull' or 'today'", async () => {
    freezeAt("2026-09-10T09:30:00.000Z"); // 15:00 IST, Thu 10 Sep
    addDhan(N_S, "2026-09-05T05:00:00.000Z");
    stubDhan(N_S, "endless", [dhanPosition(N_S, "ITC", 5, 400, 0, 0)]);
    expect((await pull(N_S, "commit")).status).toBe(200);

    freezeAt("2026-09-12T05:00:00.000Z"); // two days later, no pull since
    const spans = await unfetchedOf(N_S);
    expect(spans.map((s) => [s.reason, s.from, s.to])).toEqual([["page-cap", "2026-09-05", "2026-09-09"]]);
    const card = bc.unfetchedNotice(spans[0]);
    // THE assertions (on revert of dhan.ts the card reads, on 12 Sep, "this pull
    // stopped at …" and "Today's book came from /v2/positions").
    expect(card).toContain("Truncated: the pull on 2026-09-10 stopped at the 50-page limit of Dhan's trade history");
    expect(card).toContain("The book for 2026-09-10 came from /v2/positions.");
    expect(card).not.toMatch(/this pull|Today's book/);
  });

  it("C5 · N4: merged into another account, the notice survives the target's OWN untruncated pull over those days", async () => {
    freezeAt("2026-09-12T09:30:00.000Z");
    addDhan(N_T, "2026-09-04T05:00:00.000Z");
    const merged = accountDelete.deleteAccount({ accountId: N_S, mode: "merge", targetId: N_T, connections: "delete" });
    expect(merged.ok, merged.message).toBe(true);
    expect((await unfetchedOf(N_T)).map((s) => [s.reason, s.from, s.to]), "the merge carried the span").toEqual([["page-cap", "2026-09-05", "2026-09-09"]]);

    // The target's own client reads 4-12 Sep in full: it says nothing about the source client's fills.
    stubDhan(N_T, "empty", [dhanPosition(N_T, "WIPRO", 3, 250, 0, 0)]);
    expect((await pull(N_T, "commit")).status).toBe(200);
    // THE assertion ([] on revert of dhan-unfetched.ts: a connection-less carried
    // row matched every connection, and the target's read cleared it).
    expect((await unfetchedOf(N_T)).map((s) => [s.reason, s.from, s.to])).toEqual([["page-cap", "2026-09-05", "2026-09-09"]]);
  });
});

// ============================================================================
// C4 — dhan.ts's clamp + the route's read window ↔ PULLNOTICE's page-cap clear
// ============================================================================

describe("C4 · N5: a clamped, truncated pull whose commit threw is retried the next day (dhan.ts + route → dhan-unfetched → GET)", () => {
  it("the retry's range-cap notice names the day before its read, so the stale 'Truncated' notice is cleared and one notice is left", async () => {
    freezeAt("2026-09-10T09:30:00.000Z");
    addDhan(N_RETRY, "2026-05-01T05:00:00.000Z"); // 132 days back: clamped to 90
    stubDhan(N_RETRY, "endless", [dhanPosition(N_RETRY, "HDFCBANK", 4, 1600, 0, 0)]);
    // A fault, not a mock: the commit's first write fails, after R19 kept the spans.
    t.sqlite.exec("CREATE TRIGGER zzfixc_fail_batch BEFORE INSERT ON import_batches BEGIN SELECT RAISE(ABORT, 'fixC: injected write failure'); END;");
    let first: Response;
    try {
      first = await pull(N_RETRY, "commit");
    } finally {
      t.sqlite.exec("DROP TRIGGER IF EXISTS zzfixc_fail_batch");
    }
    expect(first.status, "the commit threw, so the stamp did not move").toBe(422);
    expect((await unfetchedOf(N_RETRY)).map((s) => [s.reason, s.from, s.to])).toEqual([
      ["range-cap", "2026-05-01", "2026-06-11"],
      ["page-cap", "2026-06-12", "2026-09-09"],
    ]);

    freezeAt("2026-09-11T09:30:00.000Z");
    stubDhan(N_RETRY, "empty", [dhanPosition(N_RETRY, "HDFCBANK", 4, 1600, 0, 0)]);
    expect((await pull(N_RETRY, "commit")).status).toBe(200);
    const spans = await unfetchedOf(N_RETRY);
    // THE assertion (on revert of dhan-unfetched.ts the page-cap span from 12 Jun
    // stays listed: the read began 13 Jun, one day after it).
    expect(spans.map((s) => [s.reason, s.from, s.to])).toEqual([["range-cap", "2026-05-01", "2026-06-12"]]);
    expect(spans.map((s) => bc.unfetchedNotice(s)).join(" ")).not.toContain("Truncated");
  });
});

// ============================================================================
// C6 — DQ's ambiguity ↔ the ladder exit ↔ the view ↔ the card ↔ the route
// ============================================================================

describe("C6 · N7/N8: the first lot's exit is booked on its ladder, and the recorded sale then pairs with the next lot (DQ ↔ ladder, card, route)", () => {
  it("listed for review with the closed lot named, no join button, a stale_review warning — and the route refuses AMBIGUOUS", async () => {
    commitAngel(DQ_AMB, "2026-09-01", [angelFill("AMBI", "BUY", 100, 1500, "10:00:00")]);
    commitAngel(DQ_AMB, "2026-09-03", [angelFill("AMBI", "BUY", 100, 1520, "10:00:00")]);
    commitAngel(DQ_AMB, "2026-09-05", [angelFill("AMBI", "SELL", 100, 1600, "11:00:00")]);
    const [lot1, lot2, sale] = storedRows(DQ_AMB);
    expect([lot1.buyQty, lot2.buyQty, sale.sellQty, sale.acquisition]).toEqual([100, 100, 100, "unknown"]);

    // The user books lot 1's exit on its ladder — the same sale, recorded a second way.
    const exit = await tradeActions.addExitLegAction(
      { ok: false, message: "" },
      formOf({ tradeId: lot1.id, qty: 100, price: 1600, tradeDate: "2026-09-05" }),
    );
    expect(exit.ok, exit.message).toBe(true);

    selectAccount(DQ_AMB);
    const { pairs, sales } = dqQueries.getStaleOpenSection();
    expect(pairs.map((p) => [p.lotId, p.saleId, p.ambiguous, p.closedLotIds, p.oneClick])).toEqual([[lot2.id, sale.id, true, [lot1.id], false]]);
    const issues = dqQueries.getDataQualityReport().issues;
    expect(issues.find((i) => i.code === "stale_open")?.ids ?? []).not.toContain(lot2.id);
    expect(issues.find((i) => i.code === "stale_review")?.ids).toEqual([sale.id]);

    const html = renderToStaticMarkup(React.createElement(StaleLotFix, { pairs, sales }));
    const text = textOf(html);
    // THE assertions (on revert of the analytics, the card offers "Close with the
    // recorded sale"; on revert of the card, it sends the user to the manual close).
    expect(text).toContain(staleAmbiguousNote(pairs[0]));
    expect(text).toContain(`(trade #${lot1.id})`);
    expect(text).not.toContain("Close with the recorded sale");
    expect(text).not.toContain("Open the manual close");

    const before = storedRows(DQ_AMB);
    const res = await closeStale({ lotId: lot2.id, saleId: sale.id, exitDate: "2026-09-05" });
    // THE assertion (200 and the sale counted twice on revert of the analytics; PARTIAL on revert of commit.ts).
    expect([res.status, res.json.code]).toEqual([409, "AMBIGUOUS"]);
    expect(res.json.message).toContain(`trade #${lot1.id}`);
    expect(storedRows(DQ_AMB)).toEqual(before);
  });
});

// ============================================================================
// C7 — the import's staged SALE ↔ DQ's fills rule ↔ the card ↔ the route
// ============================================================================

describe("C7 · N10: a sale the pull recorded in two fills beside a held lot (commit writeLadder → DQ view → card → route)", () => {
  it("the card states the fills with a link to Trades, and the route refuses FILLS — the sale and its fills are kept", async () => {
    commitAngel(DQ_FILLS, "2026-09-01", [angelFill("FILLED", "BUY", 100, 900, "10:00:00")]);
    commitAngel(DQ_FILLS, "2026-09-05", [angelFill("FILLED", "SELL", 60, 950, "11:00:00"), angelFill("FILLED", "SELL", 40, 951, "11:05:00")]);
    const [lot, sale] = storedRows(DQ_FILLS);
    expect([sale.sellQty, sale.staged, legsOf(sale.id).length], "the import stored the sale as a ladder of its two fills").toEqual([100, true, 2]);

    selectAccount(DQ_FILLS);
    const { pairs } = dqQueries.getStaleOpenSection();
    expect(pairs.map((p) => [p.lotId, p.saleId, p.saleStaged, p.oneClick])).toEqual([[lot.id, sale.id, true, false]]);
    // THE assertion (on revert of the queries view the sale's fills read as the
    // user's journal: "…carries the user's legs…", a promise to move them).
    expect(pairs[0].blocked).toBe(staleFillsNote("long"));

    const html = renderToStaticMarkup(React.createElement(StaleLotFix, { pairs, sales: [] }));
    const block = html.split("data-stale-blocked")[1] ?? "";
    // THE assertion (on revert of the card the blocked sentence has no way to the row).
    expect(block).toContain('href="/trades?symbol=FILLED&amp;view=open"');
    expect(textOf(block)).toContain(staleFillsNote("long"));

    const res = await closeStale({ lotId: lot.id, saleId: sale.id, exitDate: "2026-09-05" });
    // THE assertion (JOURNAL on revert of commit.ts).
    expect([res.status, res.json.code]).toEqual([409, "FILLS"]);
    expect(storedRows(DQ_FILLS).map((r) => [r.id, r.isOpen])).toEqual([
      [lot.id, true],
      [sale.id, true],
    ]);
    expect(legsOf(sale.id)).toHaveLength(2);
  });
});

// ============================================================================
// C8 — a staged position ↔ every close entry point ↔ closePosition ↔ the ladder exit
// ============================================================================

describe("C8 · N11: a position the pull built from two fills is closed on its ladder from /risk and /trades, never by the manual close (DQ ↔ risk page, trades table, routes)", () => {
  let staged: ReturnType<typeof storedRows>[number];
  let plain: ReturnType<typeof storedRows>[number];

  it("/risk: the page's tranches reach the control, which links the staged row to its ladder and keeps 'Close position' for the plain one", () => {
    commitAngel(DQ_STAGED, "2026-09-01", [angelFill("STAGEDX", "BUY", 60, 500, "10:00:00"), angelFill("STAGEDX", "BUY", 40, 510, "10:30:00")]);
    commitAngel(DQ_STAGED, "2026-09-02", [angelFill("PLAINX", "BUY", 50, 300, "10:00:00")]);
    [staged, plain] = storedRows(DQ_STAGED);
    expect([staged.staged, legsOf(staged.id).length, plain.staged]).toEqual([true, 2, false]);

    selectAccount(DQ_STAGED);
    const cockpit = findElem(riskPage(), (e) => e.type === riskClient.RiskCockpitClient);
    if (!cockpit) throw new Error("the risk page no longer renders <RiskCockpitClient>");
    const { inputs, capitals } = cockpit.props as unknown as { inputs: Parameters<typeof computeExposure>[0]; capitals: { all: number } };
    const positions = computeExposure(inputs, capitals.all).positions;
    const Control = riskClient.PositionCloseControl as (p: { p: unknown; onClose: () => void }) => React.ReactElement;
    // THE assertion (undefined on revert of risk-cockpit-client.tsx: the manual close was the only control).
    expect(typeof Control).toBe("function");
    const render = (id: number) => textOf(renderToStaticMarkup(React.createElement(Control, { p: positions.find((x) => x.id === id), onClose: () => {} })));
    expect(render(staged.id)).toContain("Book the exit on its ladder in Trades");
    expect(render(staged.id)).not.toContain("Close position");
    expect(render(plain.id)).toContain("Close position");
  });

  it("the routes: POST /api/positions/close → 409 STAGED, and closeTradeAction says the same sentence — nothing written, legs intact", async () => {
    const before = storedRows(DQ_STAGED);
    const res = await positionsCloseRoute.POST(
      new Request("http://localhost/api/positions/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tradeId: staged.id, exitPrice: 520, exitDate: "2026-09-08" }),
      }),
    );
    const json = (await res.json()) as { ok: boolean; code?: string; message: string };
    // THE assertions (200 and a closed parent with no exit leg on revert of commit.ts).
    expect([res.status, json.ok, json.code]).toEqual([409, false, "STAGED"]);
    const action = await tradeActions.closeTradeAction({ ok: false, message: "" }, formOf({ tradeId: staged.id, exitPrice: 520, exitDate: "2026-09-08" }));
    expect(action).toEqual({ ok: false, message: json.message });
    expect(storedRows(DQ_STAGED)).toEqual(before);
    expect(legsOf(staged.id)).toHaveLength(2);
  });

  it("/trades: the row's close icon hands a staged row to the ladder; the ladder's exit closes it with its exit fill recorded", async () => {
    selectAccount(DQ_STAGED);
    const row = tradeQueries.getTrades().find((r) => r.id === staged.id)!;
    const Entry = tradesClient.CloseEntryButton as (p: { trade: unknown; onManualClose: (t: unknown) => void; onLadder: (t: unknown) => void }) => React.ReactElement | null;
    // THE assertion (undefined on revert of trades-client.tsx).
    expect(typeof Entry).toBe("function");
    const routed: string[] = [];
    const click = (trade: unknown) => {
      const tree = Entry({ trade, onManualClose: () => routed.push("manual"), onLadder: () => routed.push("ladder") });
      const button = findElem(tree, (e) => typeof e.props.onClick === "function");
      (button!.props.onClick as () => void)();
    };
    click(row);
    click(tradeQueries.getTrades().find((r) => r.id === plain.id)!);
    expect(routed).toEqual(["ladder", "manual"]);

    const exit = await tradeActions.addExitLegAction({ ok: false, message: "" }, formOf({ tradeId: staged.id, qty: 100, price: 520, tradeDate: "2026-09-08" }));
    expect(exit.ok, exit.message).toBe(true);
    const [after] = storedRows(DQ_STAGED);
    expect([after.isOpen, after.sellQty, legsOf(staged.id).filter((l) => l.kind === "exit").map((l) => l.qty)]).toEqual([false, 100, [100]]);
  });
});

// ============================================================================
// C9 — STRAT's per-account netting ↔ the All-accounts view ↔ COPY's note
// ============================================================================

describe("C9 · N16 + N19: /strategies on All accounts (STRAT query → page → card ← COPY note)", () => {
  const optionRow = (accountId: number, symbol: string, strike: number, optionType: "CE" | "PE", premium: number) =>
    tradeRow({
      accountId,
      broker: "angelone",
      bucket: "active",
      segment: "stock_option",
      instrumentType: "option",
      exchange: "NFO",
      symbol,
      tradingsymbol: `${symbol}${strike}${optionType}SEP26`,
      optionType,
      strike,
      expiry: "2026-09-24",
      isOpen: true,
      sellQty: 100,
      avgSellPrice: premium,
    });
  const cardOf = (text: string, symbol: string) => text.split(STRATEGY_COPY.footer).filter((ch) => ch.includes(`|${symbol}|`));
  let text = "";

  it("account B's basis-unknown sale of 100 RELIANCE does not uncover account A's covered call: Custom (2 legs), bounded, and the note names a covered call", () => {
    t.db
      .insert(t.schema.trades)
      .values([
        optionRow(ST_A, "RELIANCE", 3000, "CE", 40),
        tradeRow({ accountId: ST_A, broker: "angelone", symbol: "RELIANCE", tradingsymbol: "RELIANCE", isOpen: true, buyQty: 100, avgBuyPrice: 2900, buyDate: "2026-09-01" }),
        // Another demat's sale, as the pull stores it (QS-AO): dated, basis not recorded.
        tradeRow({ accountId: ST_B, broker: "angelone", symbol: "RELIANCE", tradingsymbol: "RELIANCE", isOpen: true, sellQty: 100, avgSellPrice: 3010, sellDate: "2026-09-07", acquisition: "unknown" }),
        // N19: a SHORT future under a short put — a covered put.
        optionRow(ST_A, "HINDALCO", 640, "PE", 12),
        tradeRow({
          accountId: ST_A,
          broker: "angelone",
          bucket: "active",
          segment: "future",
          instrumentType: "future",
          exchange: "NFO",
          symbol: "HINDALCO",
          tradingsymbol: "HINDALCO26SEPFUT",
          expiry: "2026-09-24",
          isOpen: true,
          sellQty: 100,
          avgSellPrice: 650,
        }),
      ])
      .run();
    freezeAt("2026-09-08T09:30:00.000Z");
    selectAccount(0);
    text = textOf(renderToStaticMarkup(strategiesPage() as React.ReactElement));
    const rel = cardOf(text, "RELIANCE");
    expect(rel).toHaveLength(1);
    // THE assertions (on revert of page.tsx or queries/trades.ts the other
    // account's sale nets the holding to 0: a naked "Short Call", Max loss Unlimited).
    expect(rel[0]).toContain("|Custom (2 legs)|");
    expect(rel[0]).not.toContain("Unlimited");
    expect(rel[0]).toContain(STRATEGY_COPY.proWithheldNote);
    expect(rel[0]).toContain("a covered call");

    selectAccount(ST_A);
    const own = cardOf(textOf(renderToStaticMarkup(strategiesPage() as React.ReactElement)), "RELIANCE");
    expect(own.map((c) => c.includes("|Custom (2 legs)|") && !c.includes("Unlimited")), "the account's own view agrees with the aggregate").toEqual([true]);
  });

  it("the withheld covered put's card carries a note that names a short underlying and a covered put", () => {
    const hin = cardOf(text, "HINDALCO");
    expect(hin).toHaveLength(1);
    expect(hin[0]).toContain("|Custom (2 legs)|");
    // THE assertions (on revert of strategy-copy.ts the note beside this card
    // named only "a holding of the underlying" and no covered put).
    expect(hin[0]).toContain("A position in the underlying, long or short");
    expect(hin[0]).toContain("a covered put");
  });
});

// ============================================================================
// C10 — SPOT's closeDiffers ↔ the risk page's SpotRef ↔ ExpiryObligations
// ============================================================================

describe("C10 · N23: a stored mark ₹800 and a later official close (SPOT → risk page → ExpiryObligations)", () => {
  const dayOffset = (n: number) => new Date(Date.parse(`${todayIstIso()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const panelHtml = () => {
    selectAccount(SPOT);
    const el = findElem(riskPage(), (e) => e.type === ExpiryObligations);
    if (!el) throw new Error("the risk page no longer renders <ExpiryObligations>");
    const props = el.props as unknown as React.ComponentProps<typeof ExpiryObligations>;
    return { spot: props.spotRefs?.TATASTEEL, html: renderToStaticMarkup(React.createElement(ExpiryObligations, props)) };
  };

  it("a later close at the SAME price prints no notice; a later close at ₹820 does, on the row", () => {
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: SPOT,
          bucket: "active",
          segment: "stock_option",
          instrumentType: "option",
          exchange: "NFO",
          symbol: "TATASTEEL",
          tradingsymbol: "OPT TATASTEEL 29 SEP 2026 780 CE",
          optionType: "CE",
          strike: 780,
          expiry: dayOffset(5),
          sellQty: 550,
          avgSellPrice: 12,
          isOpen: true,
        }),
      )
      .run();
    t.db.insert(t.schema.mtmPrices).values({ symbol: "TATASTEEL", tradingsymbol: "TATASTEEL", price: 800, asOfDate: dayOffset(-3) }).run();
    t.db.insert(t.schema.priceHistory).values({ symbol: "TATASTEEL", date: dayOffset(-1), close: 800, source: "bhavcopy" }).run();

    const same = panelHtml();
    expect(same.spot).toEqual({ value: 800, source: "mark", asOf: dayOffset(-3), close: { price: 800, asOf: dayOffset(-1) } });
    // THE assertion (on revert of spot-ref.ts: "Official close …: ₹800.00 — differs from your mark ₹800.00").
    expect(same.html).not.toContain("Official close");

    t.db.insert(t.schema.priceHistory).values({ symbol: "TATASTEEL", date: dayOffset(0), close: 820, source: "bhavcopy" }).run();
    expect(panelHtml().html).toContain(`Official close ${dayOffset(0)}: ₹820.00 — differs from your mark ₹800.00`);
  });
});

// ============================================================================
// C11 / C12 — RATES' lazy charger ↔ getIposComputed ↔ the IPO client ↔ capital
// ============================================================================

describe("C11 / C12 · IPO exits priced on the server and shown by the client (RATES: ipos.ts ↔ ipo.ts ↔ ipo-client.tsx)", () => {
  const ipo = (name: string, over: Record<string, unknown>) => ({
    accountId: IPO,
    name,
    broker: null as string | null,
    exchange: "NSE",
    allotted: true,
    allottedQty: 1000,
    appliedPrice: 80,
    lotSize: 1000,
    exitPrice: 100,
    allotmentDate: "2021-06-03",
    exitDate: "2021-07-01",
    ...over,
  });
  let rows: import("@/lib/analytics/ipo").IpoComputed[] = [];
  const byName = (n: string) => rows.find((r) => r.name === n)!;

  it("C11 · N13: a half-typed exit year '0202-06-15' no longer takes the page down: the row, the statement and capital read it as not yet priced", () => {
    t.db
      .insert(t.schema.ipos)
      .values([
        ipo("TYPO", { exitDate: "0202-06-15" }),
        ipo("S2019", { allotmentDate: "2019-06-03" }),
        ipo("S2021", {}),
        ipo("Z2021", { broker: "zerodha" }),
      ])
      .run();
    selectAccount(IPO);
    // THE assertion (throws on revert of ipos.ts or ipo.ts: no charge_config row covers 0202-06-15).
    ({ rows } = ipoQueries.getIposComputed());
    const typo = byName("TYPO");
    expect([typo.unpriced, typo.realised, typo.chargeBreakdown]).toEqual([true, false, null]);
    const priced = rows.filter((r) => r.realised);
    expect(priced.map((r) => r.name).sort()).toEqual(["S2019", "S2021", "Z2021"]);
    expect(paise(ipoQueries.getIpoRealisedNet())).toBe(priced.reduce((s, r) => s + paise(r.netPnl), 0));

    const IpoStatement = ipoClient.IpoStatement as (p: { r: unknown }) => React.ReactElement;
    const statement = textOf(renderToStaticMarkup(React.createElement(IpoStatement, { r: typo })));
    // THE assertions (on revert of ipo-client.tsx the statement prints "− ₹0.00" of charges and a ₹20,000 net).
    expect(statement).toContain("|Net P&L|—|");
    expect(statement).toContain("|Exit date is not a valid date|charges not computed|");
  });

  it("C11 · N15: the statement names only the heads each exit's server breakdown carries — DP only where a broker's row states it", () => {
    const IpoStatement = ipoClient.IpoStatement as (p: { r: unknown }) => React.ReactElement;
    const label = (n: string) => /\|(Sell charges[^|]*)\|/.exec(textOf(renderToStaticMarkup(React.createElement(IpoStatement, { r: byName(n) }))))?.[1];
    const z = byName("Z2021").chargeBreakdown!;
    const s = byName("S2021").chargeBreakdown!;
    expect([z.dpCharges > 0, s.dpCharges, s.stampDuty, z.stampDuty]).toEqual([true, 0, 0, 0]);
    // THE assertions (on revert of ipo-client.tsx both read "Sell charges (STT, exch, stamp, DP, GST)").
    expect(label("S2021")).toBe("Sell charges (STT, exch, GST)");
    expect(label("Z2021")).toBe(`Sell charges (${z.brokerage > 0 ? "brokerage, " : ""}STT, exch, DP, GST)`);
  });

  it("C12 · N14: an allotment from 1 Jul 2020 carries no stamp for the allottee — ₹12 less than the same IPO allotted in 2019, on the server", () => {
    const stampPct = rates.statutoryRatesFor(rates.loadRatesMap(), "eq_delivery", "NSE", "2021-07-01").stampPct;
    expect(Math.round(stampPct * 80_000), "floor: the seed's delivery stamp on the ₹80,000 allotment is ₹12").toBe(12);
    // THE assertion (0 on revert of ipo.ts: the 2021 allottee paid the issuer's stamp too).
    expect(paise(byName("S2019").charges) - paise(byName("S2021").charges)).toBe(1200);
  });

  it("C12 · N15: the form's preview of a broker IPO says it is before broker charges — the saved figure adds the broker's DP", () => {
    const IpoForm = ipoClient.IpoForm as (p: { existing: unknown; onDone: () => void }) => React.ReactElement;
    const saved = byName("Z2021");
    // The client mounts the form inside its edit <Dialog> (ipo-client.tsx:192); the
    // Root is the context the form's DialogClose needs, and it renders no portal.
    const text = textOf(
      renderToStaticMarkup(React.createElement(Dialog, { open: true }, React.createElement(IpoForm, { existing: saved, onDone: () => {} }))),
    );
    const cell = /\|Charges before broker charges\|([^|]+)\|/.exec(text);
    // THE assertion (null on revert of ipo-client.tsx: the cell read "Charges", and its figure was not the saved one).
    expect(cell?.[1]).toBeTypeOf("string");
    expect(cell![1]).not.toBe(inr(saved.charges));
    expect(cell![1]).toBe(inr(byName("S2021").charges));
  });
});

// ============================================================================
// C13 — UI's F&O preview body ↔ the preview route ↔ createManualTrade
// ============================================================================

describe("C13 · N24: Equity overrides picked, then F&O: the preview prices what the save stores (UI → preview route ↔ createManualTrade)", () => {
  it("a long NIFTY put bought 75 @ ₹120 and sold @ ₹150 previews the stored charges and net", async () => {
    selectAccount(MANUAL);
    const SYM = "OPT NIFTY 31 Oct 2024 24500 PE";
    const input: ManualPreviewInput = {
      broker: "zerodha",
      tradingsymbol: SYM,
      kind: "fno",
      // The state the Equity form left behind: switching to F&O resets none of it.
      productHint: "intraday",
      segment: "eq_intraday",
      exchange: "BSE",
      direction: "buy",
      open: false,
      entryQty: 75,
      entryPrice: 120,
      entryDate: "2024-10-01",
      exitQty: 75,
      exitPrice: 150,
      exitDate: "2024-10-03",
      ownCapitalUsed: null,
      daysHeld: 2,
    };
    const preview = async (body: unknown) => {
      const res = await previewRoute.POST(
        new Request("http://localhost/api/charges/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { breakdown: { total: number }; netPnl: number };
    };
    const body = buildManualPreviewBody(input);
    const got = await preview(body);

    // The FormData the F&O form submits: it renders no product / segment / exchange input.
    const saved = await tradeActions.createManualTrade(
      { ok: false, message: "" } as never,
      formOf({ broker: "zerodha", tradingsymbol: SYM, direction: "buy", lotSize: 75, buyQty: 75, avgBuyPrice: 120, buyDate: "2024-10-01", sellQty: 75, avgSellPrice: 150, sellDate: "2024-10-03" }),
    );
    expect(saved.ok, saved.message).toBe(true);
    const stored = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, (saved as { tradeId: number }).tradeId)).get()!;
    expect(stored.segment).toBe("index_option");
    // Floor: the leaked overrides price differently, so the equalities can tell a stale body from a clean one.
    expect((await preview({ ...body, productHint: "intraday", segment: "eq_intraday", exchange: "BSE" })).breakdown.total).not.toBe(stored.chargesTotal);
    // THE assertions (on revert of manual-preview-body.ts the preview priced an equity intraday trade on BSE).
    expect(got.breakdown.total).toBe(stored.chargesTotal);
    expect(got.netPnl).toBe(stored.netPnl);
  });
});

// ============================================================================
// C14 — UI's restore copy ↔ restoreBaseline (via the route) ↔ the toast
// ============================================================================

describe("C14 · N25: what 'Restore my defaults' does to charge rows, and what the card says before and after the click (UI ↔ settings-baseline)", () => {
  // restoreBaseline re-inserts the snapshot WITHOUT row ids (stripRowIdentity), so
  // a row is found by its key: zerodha, eq_delivery, the exchange, the latest epoch.
  const LATEST = "broker = 'zerodha' AND segment = 'eq_delivery' AND exchange = ? ORDER BY effective_from DESC LIMIT 1";
  const rowOf = (exchange: string) =>
    t.sqlite.prepare(`SELECT dp_charge AS dp, user_edited AS edited FROM charge_config WHERE ${LATEST}`).get(exchange) as { dp: number; edited: number };
  const idOf = (exchange: string) => (t.sqlite.prepare(`SELECT id FROM charge_config WHERE ${LATEST}`).get(exchange) as { id: number }).id;
  const post = async (route: { POST: (r: Request) => Promise<Response> }, url: string, body: unknown) =>
    (await (await route.POST(new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))).json()) as {
      ok: boolean;
      message: string;
    };
  let restoreMessage = "";
  let card = 0;

  // The restore replaces the whole charge_config table and refreshes it onto the
  // rate card: this `it` measured 286-297 ms locally (2026-09-15), inside the
  // 300 ms budget with no raised timeout. Keep new work out of it.
  it("a row edited when the defaults were saved returns to that value; a row edited SINCE follows this version's card — as the card says before the click", async () => {
    card = rowOf("NSE").dp;
    // An older build's card on the NSE row when the defaults were saved (not user-edited).
    t.sqlite.prepare("UPDATE charge_config SET dp_charge = 99, user_edited = 0 WHERE id = ?").run(idOf("NSE"));
    expect((await post(settingsRoute, "/api/settings", { type: "charge", id: idOf("BSE"), dpCharge: 40, sttPct: 0.001, gstPct: 0.18 })).ok).toBe(true);
    expect((await post(baselineRoute, "/api/settings-baseline", { action: "save" })).ok).toBe(true);
    expect((await post(settingsRoute, "/api/settings", { type: "charge", id: idOf("NSE"), dpCharge: 50, sttPct: 0.001, gstPct: 0.18 })).ok).toBe(true);
    expect(rowOf("NSE")).toEqual({ dp: 50, edited: 1 });

    const restored = await post(baselineRoute, "/api/settings-baseline", { action: "restore" });
    expect(restored.ok, restored.message).toBe(true);
    restoreMessage = restored.message;
    expect(rowOf("BSE"), "edited when saved → back to that value").toEqual({ dp: 40, edited: 1 });
    expect(rowOf("NSE"), "edited only since → this version's card, not the snapshot's 99 nor the edit's 50").toEqual({ dp: card, edited: 0 });

    const header = textOf(renderToStaticMarkup(React.createElement(DefaultSettingsCard)));
    // THE assertion (on revert of the card: "…and the charge rows you edited to that baseline." — the NSE row was edited and did not return).
    expect(header).toContain("Charge rows you had edited when these defaults were saved return to those values; rows unedited then follow this version's rate card.");
  });

  // SEAM DEFECT D2 — FIXED in wave 2F (R2F-MISC). The toast after the click
  // (restoreBaseline's message, printed verbatim by default-settings-card.tsx)
  // said "Rate rows you never edited follow this version's rate card." The NSE
  // row above WAS edited — after the save — and followed the card, so the
  // sentence the user read right after the click contradicted the one the card
  // showed before it. The toast now states the same rule as CHARGE_ROWS_RULE.
  it("D2 — the restore toast states the rule the card stated before the click, not 'never edited'", () => {
    expect(rowOf("NSE"), "the restore above ran").toEqual({ dp: card, edited: 0 });
    expect(restoreMessage).not.toContain("you never edited");
    expect(restoreMessage).not.toContain("all three rate tables");
    expect(restoreMessage).toContain("Charge rows you had edited when these defaults were saved return to those values; rows unedited then follow this version's rate card.");
  });
});
