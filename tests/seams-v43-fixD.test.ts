import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { STRATEGY_COPY } from "@/components/strategies/strategy-copy";
import { normalizeAngelTrades, toParsedFile as angelToParsedFile, type AngelTradeRow } from "@/lib/import/api/angelone";
import { bundledIsinBySymbol, bundledSymbolByIsin } from "@/lib/import/isin-symbol";
import { todayIstIso } from "@/lib/domain/trading-day";

/**
 * v4.3.0 FIX WAVE 2G — THE SEAMS OF A SIX-BUILDER WAVE.
 *
 * G1 (lib/import/commit.ts planSnapshot, cross-source.ts), G2 (lib/analytics/
 * data-quality.ts), G3 (components/import/broker-connect.tsx, lib/import/
 * dhan-unfetched.ts, the dhan.ts range-cap sentence), G4 (IPO route + client),
 * G5 (strategy copy, help, license comment; L5 by G5b), G6 (lib/risk/spot-ref.ts)
 * owned disjoint files. This file runs the two real halves of every value that
 * crosses from one builder's files into another's, or from a 2G change into the
 * unchanged code it feeds (the pull route, the account merge, the Data Quality
 * card and route, the /risk page and the "Keep my mark" route, /strategies).
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The stubs are framework and
 * transport only: `next/cache`, `next/navigation` (no request, no mounted
 * router) and `globalThis.fetch` for api.dhan.co (and, in D4, the browser's
 * fetch routed to the real dismiss route's POST). One fault is INJECTED, not
 * mocked: an SQLite trigger that makes the import batch insert fail, which is
 * how a pull whose commit threw keeps its spans with the stamp unmoved (D5).
 *
 * ── THE SEAM TABLE ───────────────────────────────────────────────────────────
 *
 *  # | crossing value                         | producer (file:line, builder)                     | consumer (file:line)                                           | unit / shape                          | test
 * ---|----------------------------------------|---------------------------------------------------|----------------------------------------------------------------|---------------------------------------|-----
 *  1 | M1 same-symbol ask → snapshotIds →     | lib/import/commit.ts:508 planSnapshot (G1) →      | app/api/import/broker/route.ts:1053 409 JSON `collisions` →    | {symbol, incoming, existing, kind,    | D1
 *    |   CrossSourceCollision{sameSnapshot}   |   cross-source.ts:259/:266 (unchanged path)       |   components/import/broker-connect.tsx:201 collisionDialogCopy,|   detail, sameSnapshot:true} over JSON|
 *    |                                        |                                                   |   :189 dialogCollisions → :153 collisionBadge (G3, JSX :1497)  |   → dialog words + badge              |
 *  2 | 'same-quantity' + sameSnapshot (M3)    | commit.ts:508 (G1, a same-quantity conversion) and| broker-connect.tsx:179 metEarlierPull (G3)                     | OverlapKind + boolean                 | D1, D2
 *    |                                        |   commit.ts N1 carriesUserRecord (unchanged)      |                                                                |                                       |
 *  3 | StaleOpenPair.ambiguous / oneClick     | lib/analytics/data-quality.ts:516 closedByStaleJoin| lib/queries/data-quality.ts:45 view → components/quality/      | boolean → button / 200 vs 409         | D3
 *    |   after the card's own join (M2)       |   :565 (G2) ← import_notes written by commit.ts   |   stale-lot-fix.tsx:193 → close-stale route → commit.ts:2058   |   AMBIGUOUS                           |
 *    |                                        |   :2179 withStaleCloseNote (unchanged)            |   staleOpenPairs(book) :2082 pair.ambiguous                    |                                       |
 *  4 | shownPaise: compared = displayed =     | lib/risk/spot-ref.ts:142 closeDiffers, :164       | app/risk/page.tsx:308/:335 → components/risk/                  | REAL ₹/unit → whole paise (compare    | D4
 *    |   fingerprinted (L8)                   |   shownPaise, :177 fingerprint, :202 text (G6)    |   expiry-obligations.tsx:226 spotCloseNotice → spot-mark-      |   key only, never stored as money)    |
 *    |                                        |                                                   |   editor.tsx:149 submitKeepMark → app/api/risk/spot/dismiss    |                                       |
 *    |                                        |                                                   |   route.ts:58 (unchanged) → panel_dismissals → page            |                                       |
 *  5 | admitting symbol per ACCOUNT (L5)      | lib/queries/trades.ts:204 STRATEGY_LEG_FIELDS     | app/strategies/page.tsx:89-98 optionSymbolByIsin → legSymbol   | option symbol ↔ ISIN, per account     | D6
 *    |                                        |   (+ accountId — G5b)                             |   → buildStrategies grouping under selectedAccountId = 0       |                                       | (it.fails)
 *  6 | merge-carried span, connId null (L1)   | lib/queries/account-delete.ts:775 carry           | lib/import/dhan-unfetched.ts:74 recordKeyOf, :105 clear scope, | entity_id NULL vs the target's conn;  | D5
 *    |                                        |   (unchanged) + route :1074 keepUnfetched         |   :130 GET one line, :174 pull clear scoped (G3) → route GET   |   ISO from/to/reason                  |
 *    |                                        |                                                   |   :343 → broker-connect.tsx:410 unfetchedNotice; route :593    |                                       |
 *    |                                        |                                                   |   user Clear (unchanged, no scope)                             |                                       |
 *
 * Not seams (no crossing consumer outside one builder's files): G4 L3/L4 (the
 * IPO route and its own form preview; tests/ipo-charger-dates.test.ts runs both
 * with the real route), G5 L6/L7 copy (tests/strategies-copy.test.ts derives the
 * list from the engine; help reads the card's source), G3 L2 (one sentence,
 * re-pinned through the route in tests/seams-v43-release.test.ts), G6 L9 (a doc).
 *
 * RED ON REVERT (2026-09-15): each changed side copied back to HEAD cba3e6c in
 * turn, this file run, the working copy restored byte-identical (cmp):
 * commit.ts → D1 ×2; broker-connect.tsx → D1, D2; data-quality.ts → D3;
 * spot-ref.ts → D4 ×2; dhan-unfetched.ts → D5 (own read). Two mutants for the
 * halves HEAD cannot redden: every clear connection-scoped (dhan-unfetched.ts)
 * → D5 (user Clear); closeStaleLot's book read without import_notes (commit.ts,
 * the consumer of G2's marker) → D3 (409 AMBIGUOUS under a one-click listing).
 * cross-source.ts changed comments only.
 *
 * SEAM DEFECT found here: D6 (L5). It was pinned as `it.fails` until G5b built
 * the per-account admitting map; it is now a plain `it`.
 * RECORDED, NOT PINNED: a conversion that changes ONLY the product (INTRADAY
 * 10 @ 200 → CNC 10 @ 200) is an exact dedup-hash duplicate (lib/import/dedup.ts
 * hashes no product), so M1's ask never sees it and the book keeps eq_intraday —
 * the product-keyed identity commit.ts:345 defers to 4.3.1. D1 therefore
 * converts at a changed price.
 *
 * ONE temp database for this file (AGENTS.md Testing). Each seam owns its accounts.
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
let dismissRoute: typeof import("@/app/api/risk/spot/dismiss/route");
let importer: typeof import("@/lib/import/commit");
let accountDelete: typeof import("@/lib/queries/account-delete");
let dqQueries: typeof import("@/lib/queries/data-quality");
let spotRef: typeof import("@/lib/risk/spot-ref");
let editor: typeof import("@/components/risk/spot-mark-editor");
/** A record, so a builder's export that a revert removes fails ITS assertion, not the file. */
let bc: Record<string, unknown> & typeof import("@/components/import/broker-connect");
let StaleLotFix: typeof import("@/components/quality/stale-lot-fix").StaleLotFix;
let ExpiryObligations: typeof import("@/components/risk/expiry-obligations").ExpiryObligations;
let riskPage: () => unknown;
let strategiesPage: () => unknown;

const CONV = 1301; //    D1
const NOTED = 1302; //   D2
const STACK = 1311; //   D3
const PENNY = 1321; //   D4
const L1_S = 1331; //    D5 scenario 1, merge source
const L1_T = 1332; //    D5 scenario 1, merge target
const L1_S2 = 1333; //   D5 scenario 2, merge source
const L1_T2 = 1334; //   D5 scenario 2, merge target
const ST_A = 1341; //    D6
const ST_B = 1342; //    D6

// ONE temp database for this file. Measured locally 2026-09-15: this hook
// (migrate + seed + the route imports) ~1.2-1.3 s; each hook below 0.4-1.5 s,
// every one inside the 3 s budget. The raised timeouts are for the Windows
// runner, measured > 15x slower (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("seams-v43-fixD", { seed: true });
  brokerRoute = await import("@/app/api/import/broker/route");
  closeStaleRoute = await import("@/app/api/data-quality/close-stale/route");
  dismissRoute = await import("@/app/api/risk/spot/dismiss/route");
  importer = await import("@/lib/import/commit");
  accountDelete = await import("@/lib/queries/account-delete");
  dqQueries = await import("@/lib/queries/data-quality");
  spotRef = await import("@/lib/risk/spot-ref");
  t.db
    .insert(t.schema.accounts)
    .values([CONV, NOTED, STACK, PENNY, L1_S, L1_T, L1_S2, L1_T2, ST_A, ST_B].map((id) => ({ id, name: `fixD ${id}`, isDefault: false })))
    .run();
}, 120_000);

// The client components and pages, in hooks of their own: a first import and
// render is a one-off cost that belongs in a hook, not in an `it`. Split so no
// single hook passes 3 s locally (the strategies page import + first render
// together measured 2.7 s once).
beforeAll(async () => {
  bc = (await import("@/components/import/broker-connect")) as typeof bc;
  editor = await import("@/components/risk/spot-mark-editor");
  ({ StaleLotFix } = await import("@/components/quality/stale-lot-fix"));
}, 120_000);
beforeAll(async () => {
  ({ ExpiryObligations } = await import("@/components/risk/expiry-obligations"));
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  selectAccount(PENNY);
  riskPage();
  selectAccount(0);
}, 120_000);
beforeAll(async () => {
  strategiesPage = (await import("@/app/strategies/page")).default as () => unknown;
}, 120_000);
beforeAll(() => {
  selectAccount(PENNY);
  renderToStaticMarkup(strategiesPage() as React.ReactElement);
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

const dhanPosition = (accountId: number, symbol: string, productType: "INTRADAY" | "CNC", buyQty: number, buyAvg: number, sellQty = 0, sellAvg = 0) => ({
  dhanClientId: clientOf(accountId),
  tradingSymbol: symbol,
  positionType: buyQty === sellQty ? "CLOSED" : buyQty > sellQty ? "LONG" : "SHORT",
  exchangeSegment: "NSE_EQ",
  productType,
  buyAvg,
  buyQty,
  sellAvg,
  sellQty,
  netQty: buyQty - sellQty,
});

/** api.dhan.co: "empty" ends the history walk at page 0; "endless" answers a
 *  fill on every page, so the walk stops at the 50-page cap (truncated). */
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

type UnfetchedSpan = import("@/components/import/broker-connect").UnfetchedSpan;

/** GET's `unfetched` for this account's Dhan row — what the card reads. */
async function unfetchedOf(accountId: number): Promise<UnfetchedSpan[]> {
  selectAccount(0);
  const json = (await (await brokerRoute.GET()).json()) as { connections?: { broker: string; accountId: number; unfetched?: unknown[] }[] };
  const rows = json.connections ?? (json as unknown as { broker: string; accountId: number; unfetched?: unknown[] }[]);
  const row = (Array.isArray(rows) ? rows : []).find((r) => r.broker === "dhan" && r.accountId === accountId);
  if (!row) throw new Error(`GET lists no Dhan connection for account ${accountId}`);
  return (row.unfetched ?? []) as UnfetchedSpan[];
}
const spansOf = async (accountId: number) => (await unfetchedOf(accountId)).map((s) => [s.reason, s.from, s.to]);

const storedRows = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);

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

type Collision = { symbol: string; kind: string; sameSnapshot?: boolean; detail: string; incoming: { buyQty: number; sellQty: number; buyValue: number; sellValue: number }; existing: { id: number; buyQty: number; sellQty: number; sourceFile: string | null } };
type ForceBody = { ok: boolean; needsForce?: boolean; message: string; collisions?: Collision[] };

/**
 * What the blocked-commit dialog shows for a needsForce 409 body, exactly as
 * broker-connect.tsx derives it: the description + footer (collisionDialogCopy)
 * and one badge per listed row (the JSX lists `dialogCollisions(collisions)`
 * and badges each with `collisionBadge(c.kind)`). Before M3 the JSX listed the
 * raw collisions, so a build without `dialogCollisions` lists them raw — the
 * dialog that build shows, not a tolerance.
 */
function dialogOf(body: ForceBody) {
  const collisions = body.collisions ?? [];
  const listed = typeof bc.dialogCollisions === "function" ? bc.dialogCollisions(collisions) : collisions;
  return {
    copy: bc.collisionDialogCopy({ collisions, message: body.message }),
    rows: listed.map((c) => [c.symbol, bc.collisionBadge(c.kind), c.incoming.buyQty, c.existing.buyQty]),
  };
}

// ============================================================================
// D1 / D2 — G1's same-symbol ask ↔ the pull route's 409 ↔ G3's dialog words
// ============================================================================

describe("D1 · a Dhan position the BROKER converted INTRADAY → CNC between two same-day pulls (G1 planSnapshot → route 409 JSON → G3 dialog)", () => {
  const NOON = "2026-09-08T06:30:00.000Z"; // 12:00 IST
  const EVENING = "2026-09-08T10:30:00.000Z"; // 16:00 IST, the same IST day
  let noon: ReturnType<typeof storedRows>;
  let body: ForceBody;

  it("commit: 409 needsForce with one sameSnapshot collision per converted symbol ('partial-quantity' 10 → 20, 'same-quantity' 10 @ 200 → 10 @ 201), nothing written", async () => {
    freezeAt(NOON);
    addDhan(CONV, null);
    stubDhan(CONV, "empty", [dhanPosition(CONV, "CONVA", "INTRADAY", 10, 100), dhanPosition(CONV, "CONVB", "INTRADAY", 10, 200)]);
    expect((await pull(CONV, "commit")).status).toBe(200);
    noon = storedRows(CONV);
    expect(noon.map((r) => [r.tradingsymbol, r.segment, r.buyQty])).toEqual([
      ["CONVA", "eq_intraday", 10],
      ["CONVB", "eq_intraday", 10],
    ]);

    freezeAt(EVENING);
    stubDhan(CONV, "empty", [dhanPosition(CONV, "CONVA", "CNC", 20, 100.5), dhanPosition(CONV, "CONVB", "CNC", 10, 201)]);
    const res = await pull(CONV, "commit");
    body = (await res.json()) as ForceBody;
    // THE assertions (on revert of commit.ts: 200, and the book holds 30 CONVA
    // and 20 CONVB against the broker's 20 and 10 — a silent second position).
    expect([res.status, body.needsForce]).toEqual([409, true]);
    expect(body.collisions?.map((c) => [c.symbol, c.kind, c.sameSnapshot, c.incoming.buyQty, c.existing.id, c.existing.buyQty])).toEqual([
      ["CONVA", "partial-quantity", true, 20, noon[0].id, 10],
      ["CONVB", "same-quantity", true, 10, noon[1].id, 10],
    ]);
    expect(storedRows(CONV)).toEqual(noon);
  });

  it("the dialog receiving that JSON body names today's earlier pull on BOTH rows, and drops the other-source lead and footer", () => {
    const shown = dialogOf(body);
    // THE assertions (on revert of broker-connect.tsx: the "Different sources
    // state the same trade slightly differently" lead, the other-source footer,
    // and the badges 'partial overlap' / 'same quantity').
    expect(shown.copy.description).toBe("Nothing has been committed.");
    expect(shown.copy.otherSourceFooter).toBe(false);
    expect(shown.rows).toEqual([
      ["CONVA", "today's earlier pull", 20, 10],
      ["CONVB", "today's earlier pull", 10, 10],
    ]);
    expect(shown.copy.serverMessage).toContain("restate");
    expect(shown.copy.serverMessage).not.toContain(bc.PULL_FORCE_ROUTE_TAIL.trim());
  });

  it("'Commit anyway' (force): the converted positions land beside the noon rows, which are never rewritten", async () => {
    freezeAt(EVENING);
    stubDhan(CONV, "empty", [dhanPosition(CONV, "CONVA", "CNC", 20, 100.5), dhanPosition(CONV, "CONVB", "CNC", 10, 201)]);
    expect((await pull(CONV, "commit", true)).status).toBe(200);
    const after = storedRows(CONV);
    expect(after.slice(0, 2)).toEqual(noon);
    expect(after.slice(2).map((r) => [r.tradingsymbol, r.segment, r.buyQty])).toEqual([
      ["CONVA", "eq_delivery", 20],
      ["CONVB", "eq_delivery", 10],
    ]);
  });
});

describe("D2 · M3: a same-day Dhan re-pull over a position the user wrote a note on arrives 'same-quantity' + sameSnapshot (N1 ask, unchanged → route → G3 dialog)", () => {
  it("the 409 body's same-quantity collision is shown as today's earlier pull, not as another source", async () => {
    freezeAt("2026-09-09T04:30:00.000Z");
    addDhan(NOTED, null);
    stubDhan(NOTED, "empty", [dhanPosition(NOTED, "NOTEDX", "CNC", 10, 100)]);
    expect((await pull(NOTED, "commit")).status).toBe(200);
    const [row] = storedRows(NOTED);
    t.db.update(t.schema.trades).set({ notes: "bought the retest" }).where(eq(t.schema.trades.id, row.id)).run();

    freezeAt("2026-09-09T10:30:00.000Z");
    stubDhan(NOTED, "empty", [dhanPosition(NOTED, "NOTEDX", "CNC", 10, 100, 10, 120)]);
    const res = await pull(NOTED, "commit");
    const body = (await res.json()) as ForceBody;
    expect([res.status, body.collisions?.map((c) => [c.kind, c.sameSnapshot, c.existing.id])]).toEqual([409, [["same-quantity", true, row.id]]]);
    const shown = dialogOf(body);
    // THE assertions (on revert of broker-connect.tsx: 'same quantity' and the other-source lead + footer).
    expect(shown.rows).toEqual([["NOTEDX", "today's earlier pull", 10, 10]]);
    expect([shown.copy.description, shown.copy.otherSourceFooter]).toEqual(["Nothing has been committed.", false]);
  });
});

// ============================================================================
// D3 — G2's ambiguity exemption ↔ the card ↔ the route ↔ closeStaleLot
// ============================================================================

describe("D3 · M2: stacked lots L1 100 + L2 50 and their recorded sales S1 100 + S2 50, joined from the Data Quality card (G2 ↔ queries view, card, route, commit.ts closeStaleLot)", () => {
  const SYM = "STACKD";
  let L1: ReturnType<typeof storedRows>[number];
  let L2: ReturnType<typeof storedRows>[number];
  let S1: ReturnType<typeof storedRows>[number];
  let S2: ReturnType<typeof storedRows>[number];
  const section = () => {
    selectAccount(STACK);
    return dqQueries.getStaleOpenSection();
  };
  const buttons = (s: ReturnType<typeof section>) =>
    textOf(renderToStaticMarkup(React.createElement(StaleLotFix, s))).split("Close with the recorded sale").length - 1;

  it("before any join: the card offers both pairs one-click", () => {
    commitAngel(STACK, "2026-09-01", [angelFill(SYM, "BUY", 100, 1000, "10:00:00")]);
    commitAngel(STACK, "2026-09-02", [angelFill(SYM, "BUY", 50, 1010, "10:00:00")]);
    commitAngel(STACK, "2026-09-04", [angelFill(SYM, "SELL", 100, 1100, "11:00:00")]);
    commitAngel(STACK, "2026-09-07", [angelFill(SYM, "SELL", 50, 1110, "11:00:00")]);
    [L1, L2, S1, S2] = storedRows(STACK);
    expect([L1.buyQty, L2.buyQty, S1.sellQty, S2.sellQty]).toEqual([100, 50, 100, 50]);
    const s = section();
    expect(s.pairs.map((p) => [p.lotId, p.saleId, p.oneClick, p.ambiguous])).toEqual([
      [L1.id, S1.id, true, false],
      [L2.id, S2.id, true, false],
    ]);
    expect(buttons(s)).toBeGreaterThanOrEqual(2);
  });

  it("after the card's join of [L1, S1], the listing still offers [L2, S2] one-click AND the route accepts it — the listing and the refusal agree", async () => {
    const first = await closeStale({ lotId: L1.id, saleId: S1.id, exitDate: "2026-09-04" });
    expect([first.status, first.json.ok], first.json.message).toEqual([200, true]);

    const s = section();
    // THE assertions (on revert of data-quality.ts: [[L2, S2, false, true, [L1]]]
    // — review only, no button — and the route below answers 409 AMBIGUOUS).
    expect(s.pairs.map((p) => [p.lotId, p.saleId, p.oneClick, p.ambiguous, p.closedLotIds])).toEqual([[L2.id, S2.id, true, false, []]]);
    const html = renderToStaticMarkup(React.createElement(StaleLotFix, s));
    expect(textOf(html)).toContain("Close with the recorded sale");
    expect(dqQueries.getDataQualityReport().issues.find((i) => i.code === "stale_review")).toBeUndefined();

    // The route's answer for the very pair the card lists.
    const second = await closeStale({ lotId: L2.id, saleId: S2.id, exitDate: "2026-09-07" });
    expect([second.status, second.json.ok, second.json.code ?? null], second.json.message).toEqual([s.pairs[0].oneClick ? 200 : 409, true, null]);
    expect(storedRows(STACK).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty])).toEqual([
      [L1.id, false, 100, 100],
      [L2.id, false, 50, 50],
    ]);
    expect(section()).toMatchObject({ pairs: [], sales: [] });
  });
});

// ============================================================================
// D4 — G6's shownPaise ↔ the /risk page ↔ the row notice ↔ "Keep my mark" route
// ============================================================================

describe("D4 · L8: a stored mark ₹1.005 and later official closes, through /risk and 'Keep my mark' (G6 spot-ref ↔ risk page, ExpiryObligations, dismiss route)", () => {
  const SYM = "PENNYX";
  const dayOffset = (n: number) => new Date(Date.parse(`${todayIstIso()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const panel = () => {
    selectAccount(PENNY);
    const el = findElem(riskPage(), (e) => e.type === ExpiryObligations);
    if (!el) throw new Error("the risk page no longer renders <ExpiryObligations>");
    const props = el.props as unknown as React.ComponentProps<typeof ExpiryObligations>;
    return { props, spot: props.spotRefs?.[SYM], html: renderToStaticMarkup(React.createElement(ExpiryObligations, props)) };
  };

  it("mark 1.005 (reads ₹1.01) against a newer close 1.01 (reads ₹1.01): the row prints no notice", () => {
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: PENNY,
          bucket: "active",
          segment: "stock_option",
          instrumentType: "option",
          exchange: "NFO",
          symbol: SYM,
          tradingsymbol: `OPT ${SYM} 29 SEP 2026 1 CE`,
          optionType: "CE",
          strike: 1,
          expiry: dayOffset(5),
          sellQty: 1000,
          avgSellPrice: 0.2,
          isOpen: true,
        }),
      )
      .run();
    t.db.insert(t.schema.mtmPrices).values({ symbol: SYM, tradingsymbol: SYM, price: 1.005, asOfDate: dayOffset(-3) }).run();
    t.db.insert(t.schema.priceHistory).values({ symbol: SYM, date: dayOffset(-1), close: 1.01, source: "bhavcopy" }).run();
    const p = panel();
    expect(p.spot).toEqual({ value: 1.005, source: "mark", asOf: dayOffset(-3), close: { price: 1.01, asOf: dayOffset(-1) } });
    // THE assertion (on revert of spot-ref.ts: "Official close …: ₹1.01 — differs from your mark ₹1.01").
    expect(textOf(p.html)).not.toContain("Official close");
  });

  it("a close of 1.015 (reads ₹1.02) raises it; 'Keep my mark' through the real route hides it, and a same-day correction to 1.02 (also ₹1.02) stays hidden", async () => {
    t.db.insert(t.schema.priceHistory).values({ symbol: SYM, date: dayOffset(0), close: 1.015, source: "bhavcopy" }).run();
    const raised = panel();
    expect(textOf(raised.html)).toContain(`Official close ${dayOffset(0)}: ₹1.02 — differs from your mark ₹1.01`);

    // The component's own call, then the editor's own POST, answered by the real route.
    const notice = spotRef.spotCloseNotice(SYM, raised.spot!, raised.props.spotCloseDismissed ?? []);
    expect(notice?.close).toEqual({ price: 1.015, asOf: dayOffset(0) });
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => dismissRoute.POST(new Request(`http://localhost${url}`, init)));
    let refreshed = 0;
    const kept = await editor.submitKeepMark(SYM, notice!.close, () => refreshed++);
    expect([kept.ok, refreshed], kept.message).toEqual([true, 1]);
    expect(textOf(panel().html), "the kept mark hides the notice").not.toContain("Official close");

    t.sqlite.prepare("UPDATE price_history SET close = 1.02 WHERE symbol = ? AND date = ?").run(SYM, dayOffset(0));
    const corrected = panel();
    expect(corrected.spot?.close).toEqual({ price: 1.02, asOf: dayOffset(0) });
    // THE assertion (on revert of spot-ref.ts the kept fingerprint was 101 paise
    // and the corrected close's is 102: "Official close …: ₹1.02 — differs from
    // your mark ₹1.01" returns over a close that reads exactly what the user kept).
    expect(textOf(corrected.html), "a correction that reads the same ₹1.02 stays kept").not.toContain("Official close");
  });
});

// ============================================================================
// D5 — the merge carry (connId null) ↔ G3's per-connection record ↔ GET ↔ card ↔ user Clear
// ============================================================================

describe("D5 · L1: a truncated Dhan notice carried by a merge beside the target client's identical one (account-delete carry → dhan-unfetched → route GET / clear → card)", () => {
  const SPAN = ["page-cap", "2026-09-05", "2026-09-09"];

  /** The target's own truncated pull whose commit threw (its span kept, stamp
   *  unmoved), then the source's committed truncated pull, then the merge. */
  async function stage(source: number, target: number) {
    freezeAt("2026-09-10T09:30:00.000Z"); // 15:00 IST
    addDhan(target, "2026-09-05T05:00:00.000Z");
    stubDhan(target, "endless", [dhanPosition(target, "WIPRO", "CNC", 3, 250)]);
    t.sqlite.exec("CREATE TRIGGER zzfixd_fail_batch BEFORE INSERT ON import_batches BEGIN SELECT RAISE(ABORT, 'fixD: injected write failure'); END;");
    let first: Response;
    try {
      first = await pull(target, "commit");
    } finally {
      t.sqlite.exec("DROP TRIGGER IF EXISTS zzfixd_fail_batch");
    }
    expect(first.status, "the target's commit threw, so its stamp did not move").toBe(422);
    expect(await spansOf(target)).toEqual([SPAN]);

    addDhan(source, "2026-09-05T05:00:00.000Z");
    stubDhan(source, "endless", [dhanPosition(source, "ITC", "CNC", 5, 400)]);
    expect((await pull(source, "commit")).status).toBe(200);
    expect(await spansOf(source)).toEqual([SPAN]);

    const merged = accountDelete.deleteAccount({ accountId: source, mode: "merge", targetId: target, connections: "delete" });
    expect(merged.ok, merged.message).toBe(true);
    // One line on the card however many records hold the span.
    expect(await spansOf(target)).toEqual([SPAN]);
  }

  it("the target's own untruncated read the next day clears ITS record; the carried one stays on the card with the source's sentence", async () => {
    await stage(L1_S, L1_T);
    freezeAt("2026-09-11T09:30:00.000Z");
    stubDhan(L1_T, "empty", [dhanPosition(L1_T, "WIPRO", "CNC", 3, 250)]);
    expect((await pull(L1_T, "commit")).status).toBe(200);
    const spans = await unfetchedOf(L1_T);
    // THE assertion (on revert of dhan-unfetched.ts: [] — the merge's carry was
    // skipped as a repeat of the target's identical span, and the target's own
    // read then cleared the only record: the source's unread days vanish).
    expect(spans.map((s) => [s.reason, s.from, s.to])).toEqual([SPAN]);
    expect(bc.unfetchedNotice(spans[0])).toContain("the pull on 2026-09-10 stopped at the 50-page limit");
  });

  it("the user's Clear on the card's one line removes it in one click, with both records open", async () => {
    await stage(L1_S2, L1_T2);
    const [line] = await unfetchedOf(L1_T2);
    const res = await postBroker({ action: "clear-unfetched", broker: "dhan", accountId: L1_T2, from: line.from, to: line.to, reason: line.reason });
    expect(res.status).toBe(200);
    // THE assertion (on a connection-scoped user Clear the carried record
    // stays: the line the user just cleared is still listed).
    expect(await spansOf(L1_T2)).toEqual([]);
  });
});

// ============================================================================
// D6 — /strategies on All accounts: the admitting symbol per account (L5, built by G5b)
// ============================================================================

describe("D6 · L5: two tickers of one ISIN in two accounts, a company-name holding in one (queries/trades.ts option legs → strategies page, All accounts)", () => {
  const optionRow = (accountId: number, symbol: string, strike: number, premium: number) =>
    tradeRow({
      accountId,
      broker: "angelone",
      bucket: "active",
      segment: "stock_option",
      instrumentType: "option",
      exchange: "NFO",
      symbol,
      tradingsymbol: `${symbol}${strike}CESEP26`,
      optionType: "CE",
      strike,
      expiry: "2026-09-24",
      isOpen: true,
      sellQty: 100,
      avgSellPrice: premium,
    });
  const cardsOf = (accountId: number, symbol: string) => {
    selectAccount(accountId);
    const text = textOf(renderToStaticMarkup(strategiesPage() as React.ReactElement));
    return text.split(STRATEGY_COPY.footer).filter((ch) => ch.includes(`|${symbol}|`));
  };
  /** Bounded (a covered call) or not (a naked short call), per card — license-independent. */
  const bounded = (accountId: number, symbol: string) => cardsOf(accountId, symbol).map((c) => !c.includes("Unlimited"));

  it("each account alone: A's IBULHSGFIN call is covered by A's holding, B's SAMMAANCAP call is naked", () => {
    const isin = bundledIsinBySymbol("IBULHSGFIN");
    expect([isin === bundledIsinBySymbol("SAMMAANCAP"), bundledSymbolByIsin(isin as string)]).toEqual([true, "SAMMAANCAP"]);
    t.db
      .insert(t.schema.trades)
      .values([
        optionRow(ST_A, "IBULHSGFIN", 150, 5),
        tradeRow({
          accountId: ST_A,
          broker: "angelone",
          symbol: "Indiabulls Housing Finance Ltd",
          tradingsymbol: "Indiabulls Housing Finance Ltd",
          isin,
          isOpen: true,
          buyQty: 100,
          avgBuyPrice: 140,
          buyDate: "2026-09-01",
        }),
        optionRow(ST_B, "SAMMAANCAP", 150, 5),
      ])
      .run();
    freezeAt("2026-09-08T09:30:00.000Z");
    expect([bounded(ST_A, "IBULHSGFIN"), bounded(ST_B, "SAMMAANCAP")]).toEqual([[true], [false]]);
  });

  // SEAM DEFECT (L5) found by this pass: before G5b, All accounts resolved A's
  // company-name holding to the LISTING ticker SAMMAANCAP, so B's call read
  // covered and A's read naked.
  // L5 BUILT (wave 2G, G5b): STRATEGY_LEG_FIELDS carries accountId and the page's admitting map is per account — flipped to `it`.
  it("All accounts shows each account's own cards: IBULHSGFIN covered, SAMMAANCAP naked", () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    expect([bounded(0, "IBULHSGFIN"), bounded(0, "SAMMAANCAP")]).toEqual([[true], [false]]);
  });
});
