import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import type { CommitAutoClose } from "@/components/import/import-client";
// Pure (no DB in their graphs) — safe as static imports before openTempDb().
import { autoCloseSentences, emptyAutoCloseCounters, executionHashOfPiece, type AutoCloseCounters } from "@/lib/import/close-open-lots";
import { dedupLabelFromNotes } from "@/lib/import/trade-identity";
import { MONTH_ONLY_PAIR_NOTE } from "@/lib/analytics/data-quality";
import { bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import { OPENALGO_DISCLOSURE_VERSION } from "@/lib/domain/openalgo-disclosure";

/**
 * v4.8.0 SEAM PASS — X1 (1f4c48e) + the data refresh (3502995, f5a3235), at HEAD f5a3235.
 *
 * Every case runs BOTH real halves of a value that crosses a file boundary and
 * asserts the CONSUMER's output. Nothing on either side is mocked: `fetch` is
 * stubbed only for the OpenAlgo instance (the network, not a seam side);
 * `next/navigation`, `next/cache` and the licence read are framework / gate
 * stubs so the server pages render.
 *
 * SEAM TABLE
 * | crossing value | producer | consumer(s) | unit | case |
 * |---|---|---|---|---|
 * | `exec-origin:` note (name;isin;file;batch, %-encoded) | close-open-lots.ts withExecOriginNote ← commit.ts:2274/:2369/:2468 (applier) | commit.ts:3608 unCloseExecution | text in import_notes | S1a S1b S1c S1d |
 * |  ″ | ″ | trash.ts restoreTrashSnapshot (verbatim) | ″ | S1a |
 * |  ″ | ″ | account-delete.ts merge + trash.ts envelope restore (verbatim) | ″ | S1b |
 * |  ″ | ″ | close-open-lots.ts:446 withoutAutoCloseNotes (strip on un-close) | ″ | S1a |
 * |  ″ | ″ | trade-identity.ts:168 dedupLabelFromNotes (must NOT read it) | ″ | S1a S1b |
 * |  ″ | ″ | commit.ts:1070 planSnapshot (inPullFile) | ″ | S4b |
 * |  ″ | ″ | cross-source.ts:181/:370 same-file exclusion (closedFromFile) | ″ | S4b |
 * |  ″ (isin half) | ″ → unCloseExecution isin | backup.ts restoreDatabase → data-fixes.ts:112 Paytm re-key | ISIN | S1d |
 * | StaleOpenPair.saleTradingsymbol / monthOnly | analytics/data-quality.ts:809 booksOf, :940 | queries/data-quality.ts:117 → app/data-quality/page.tsx:54 → stale-lot-fix.tsx:178/:194 (markup, also via JSON = the RSC wire) | string / boolean | S2a |
 * | monthOnlyAcknowledged (POST body) | stale-lot-fix.tsx run() — NOT REACHABLE without a DOM (no jsdom in the repo) | close-stale/route.ts:57 → commit.ts:3736 closeStaleLot | boolean | S2b (route side only) |
 * | AutoCloseCounters.refusedMonthOnly (+ its sentence) | commit.ts:2243 | broker route JSON `result` → import-client.tsx CommitAutoClose / importedHeadline / commitResultNotes | integer count | S3a (+ type equality, red by typecheck) |
 * | OverlapKind `held-identity` (+ refusedHeldIdentity) | commit.ts plan → cross-source.ts:418 | broker route 409 body → broker-connect.tsx dialogCollisions / collisionBadge / collisionDialogCopy; auto-pull.ts:116 classifyPreview | enum string | S3b |
 * | snapshot-set membership (`openalgo-<b>-<IST day>`) | app/api/import/broker/route.ts:1653 | commit.ts planSnapshot | file name, IST day | S4a S4b (run at 19:00 UTC = the IST day boundary) |
 * | formerSymbols (ticker → ISIN) | scripts/build-nse-index-map.mjs:273 → lib/data/nse-index-map.json | isin-symbol.ts bundledIsinBySymbol → queries/trades.ts:577 → app/strategies/page.tsx:129; quotes/upstox.ts:229 | ISIN | S5 |
 *
 * BOUNDARIES WITH NO CASE: the stale-lot-fix dialog's tick → fetch body (no DOM
 * library in the repo to open the dialog; the route half is S2b, the body
 * shape the component builds is unexercised); atlas.ts:529 and
 * instruments.ts:121 (formerSymbols readers beyond the two pinned in S5).
 *
 * ONE temp database for the FILE (AGENTS.md Testing): every case owns its account.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
}));
// Pro, so a Covered Call keeps its name on the /strategies card.
vi.mock("@/lib/queries/license", () => ({
  getEntitlement: () => ({ state: "trial", pro: true, payload: null, trialDaysLeft: 7 }),
}));
process.env.VYUHA_VAULT_PROVIDER = "machine";

// ── The counter shape the server sends and the client reads: one shape. A field
// added on one side and not the other fails `npm run typecheck` here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const COUNTERS_ARE_ONE_SHAPE: Same<CommitAutoClose, AutoCloseCounters> = true;

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let dq: typeof import("@/lib/queries/data-quality");
let del: typeof import("@/lib/queries/delete");
let trash: typeof import("@/lib/trash");
let accountDelete: typeof import("@/lib/queries/account-delete");
let backup: typeof import("@/lib/backup");
let staleRoute: typeof import("@/app/api/data-quality/close-stale/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");
let openalgo: typeof import("@/lib/import/api/openalgo");
let importClient: typeof import("@/components/import/import-client");
let brokerConnect: typeof import("@/components/import/broker-connect");
let StaleLotFix: typeof import("@/components/quality/stale-lot-fix").StaleLotFix;
let dqPage: typeof import("@/app/data-quality/page");
let strategiesPage: typeof import("@/app/strategies/page");
let upstoxInstrumentKey: typeof import("@/lib/quotes/upstox").upstoxInstrumentKey;
let classifyPreview: typeof import("@/lib/jobs/auto-pull").classifyPreview;

const OA_W = "OPT NIFTY 22 Sep 2026 25000 CE";
const NAT_W = "NIFTY2692225000CE";
const OA_M = "OPT NIFTY 29 Sep 2026 25000 CE";
const NAT_M = "NIFTY26SEP25000CE";
const DAY = "2026-09-15";
const PREV = "2026-09-14";
const QTY = 75;
const FILES = { oaPrev: `openalgo-fyers-${PREV}`, fyers: `fyers-api-${DAY}` } as const;

const r2 = (n: number) => Math.round(n * 100) / 100;

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "fyers",
    isin: null,
    buyQty: 0, avgBuyPrice: 0, buyValue: 0,
    sellQty: 0, avgSellPrice: 0, sellValue: 0,
    closingPrice: null, grossPnl: 0, unrealisedPnl: 0,
    buyDate: null, sellDate: null,
    productHint: null, exchangeHint: "NSE", sourceFile: null,
    ...over,
  } as NormalizedTrade;
}
const buy = (sym: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date, ...over });
const sell = (sym: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: sym, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date, ...over });
const parsed = (trades: NormalizedTrade[], broker: ParsedFile["broker"] = "fyers", sourceId = "fyers-api"): ParsedFile => ({ sourceId, broker, format: "api", trades, warnings: [] });

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const newAccount = (id: number, name: string) => {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
  select(id);
};
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const shape = (accountId: number) => rowsOf(accountId).map((r) => [r.tradingsymbol, r.buyQty, r.sellQty, r.isOpen]);
const sold = (accountId: number) => rowsOf(accountId).reduce((s, r) => s + r.sellQty, 0);
const bought = (accountId: number) => rowsOf(accountId).reduce((s, r) => s + r.buyQty, 0);

/** The broker route's own pull decision, for a pull this file does not drive through HTTP. */
function pull(accountId: number, file: ParsedFile, fileName: string) {
  const opts = { supersedeSnapshot: { fileName }, autoClose: true };
  const preview = commit.previewParsedFile(file, null, accountId, fileName, opts);
  if (preview.crossSource?.risky) return { status: 409 as const, preview, result: null };
  return { status: 200 as const, preview, result: commit.commitParsedFile(file, fileName, null, accountId, opts) };
}
const importFile = (accountId: number, file: ParsedFile, fileName: string, autoClose = true) =>
  commit.commitParsedFile(file, fileName, null, accountId, { autoClose });

/** An OpenAlgo lot from yesterday's pull, closed WHOLE by today's native sale under another name. */
function closedCrossName(accountId: number) {
  pull(accountId, parsed([buy(OA_W, QTY, 120, PREV)], "fyers", "openalgo-api"), FILES.oaPrev);
  const out = pull(accountId, parsed([sell(NAT_W, QTY, 140, DAY)]), FILES.fyers);
  expect(out.result?.autoClose).toMatchObject({ closedWhole: 1 });
  const rows = rowsOf(accountId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const json = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const textOf = (html: string) => decode(html).replace(/<[^>]*>/g, "|").replace(/\|+/g, "|");

beforeAll(async () => {
  t = await openTempDb("seams-v48-x1", { seed: true });
  commit = await import("@/lib/import/commit");
  dq = await import("@/lib/queries/data-quality");
  del = await import("@/lib/queries/delete");
  trash = await import("@/lib/trash");
  accountDelete = await import("@/lib/queries/account-delete");
  backup = await import("@/lib/backup");
  staleRoute = await import("@/app/api/data-quality/close-stale/route");
  brokerRoute = await import("@/app/api/import/broker/route");
  openalgo = await import("@/lib/import/api/openalgo");
  importClient = await import("@/components/import/import-client");
  brokerConnect = await import("@/components/import/broker-connect");
  ({ StaleLotFix } = await import("@/components/quality/stale-lot-fix"));
  dqPage = await import("@/app/data-quality/page");
  strategiesPage = await import("@/app/strategies/page");
  ({ upstoxInstrumentKey } = await import("@/lib/quotes/upstox"));
  ({ classifyPreview } = await import("@/lib/jobs/auto-pull"));
}, 30_000);

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  t?.cleanup();
});

// ═════════════════════════════════════════════════════════════════════════════
// S1 — the `exec-origin:` note, written by the applier, read across files
// ═════════════════════════════════════════════════════════════════════════════

describe("S1 · exec-origin: applier → Trash / merge → un-close, strip and the label reader", () => {
  it("S1a Trash → restore keeps the note verbatim; un-close then reinstates the sale as ITS file stated it and strips the lot", () => {
    expect(COUNTERS_ARE_ONE_SHAPE).toBe(true);
    const A = 201;
    newAccount(A, "seam trash");
    const lot = closedCrossName(A);
    const notes = lot.importNotes;
    // The label reader is keyed on its own prefix: an exec-origin segment is no label.
    expect(dedupLabelFromNotes(notes)).toBeNull();

    const gone = del.deleteTradesByIds([lot.id], "seam S1a");
    expect([gone.ok, gone.deleted]).toEqual([true, 1]);
    expect(rowsOf(A)).toEqual([]);
    const back = trash.restoreTrashSnapshot(gone.snapshotId!, "seam");
    expect([back.ok, back.restored, back.skipped]).toEqual([true, 1, []]);
    const restored = rowsOf(A)[0]!;
    expect(restored.importNotes, "Trash carries the note byte for byte").toBe(notes);

    const un = commit.unCloseExecution(A, "fyers", executionHashOfPiece(restored));
    expect(un.ok, un.message).toBe(true);
    const after = rowsOf(A);
    const sale = after.find((r) => r.sellQty > 0)!;
    const reopened = after.find((r) => r.buyQty > 0)!;
    expect([sale.tradingsymbol, sale.sourceFile, sale.sellQty], "the execution's OWN name and file").toEqual([NAT_W, FILES.fyers, QTY]);
    expect([reopened.tradingsymbol, reopened.isOpen, reopened.importNotes], "the lot reads open, every machine segment stripped").toEqual([OA_W, true, null]);
    expect(sold(A)).toBe(QTY);
  });

  it("S1b merge B into A carries the note verbatim (and the envelope restore leaves it); un-close in A still reads the execution's origin", () => {
    const A = 202;
    const B = 203;
    newAccount(A, "seam merge target");
    newAccount(B, "seam merge source");
    const lot = closedCrossName(B);
    const notes = lot.importNotes;
    select(A);
    const merged = accountDelete.deleteAccount({ accountId: B, mode: "merge", targetId: A, connections: "delete", source: "seam" });
    expect(merged.ok, merged.message).toBe(true);
    const moved = rowsOf(A);
    expect(moved.map((r) => [r.dedupHash, r.importNotes])).toEqual([[lot.dedupHash, notes]]);
    expect(dedupLabelFromNotes(moved[0]!.importNotes)).toBeNull();

    // Restoring the merge envelope brings the source ACCOUNT back; the moved
    // rows stay in the target (lib/trash.ts — a merge is not reversed row by row).
    const unmerged = trash.restoreTrashSnapshot(merged.snapshotId!, "seam");
    expect(unmerged.ok, unmerged.message).toBe(true);
    expect(rowsOf(B)).toEqual([]);
    expect(rowsOf(A).map((r) => r.importNotes)).toEqual([notes]);

    select(A);
    const un = commit.unCloseExecution(A, "fyers", executionHashOfPiece(rowsOf(A)[0]!));
    expect(un.ok, un.message).toBe(true);
    expect(rowsOf(A).filter((r) => r.sellQty > 0).map((r) => [r.tradingsymbol, r.sourceFile, r.accountId])).toEqual([[NAT_W, FILES.fyers, A]]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S2 — StaleOpenPair.monthOnly + saleTradingsymbol: analytics → query → page →
// component markup, and the acknowledgement back through the route
// ═════════════════════════════════════════════════════════════════════════════

describe("S2 · a month-level pair: listed with BOTH names and the note; joined only with the acknowledgement", () => {
  const D = 204;
  beforeAll(() => {
    newAccount(D, "seam month-only");
    pull(D, parsed([buy(OA_M, QTY, 120, PREV)], "fyers", "openalgo-api"), FILES.oaPrev);
    const out = pull(D, parsed([sell(NAT_M, QTY, 140, DAY)]), FILES.fyers);
    expect(out.result?.autoClose).toMatchObject({ closedWhole: 0, refusedMonthOnly: 1 });
  });

  it("S2a the REAL /data-quality page renders the lot's name, the sale's own name and the month-only note — and so does the card fed the pairs over JSON (the RSC wire)", () => {
    select(D);
    const page = decode(renderToStaticMarkup(dqPage.default() as React.ReactElement));
    const wire = JSON.parse(JSON.stringify(dq.getStaleOpenSection())) as ReturnType<typeof dq.getStaleOpenSection>;
    const card = decode(renderToStaticMarkup(React.createElement(StaleLotFix, { pairs: wire.pairs, sales: wire.sales })));
    for (const html of [page, card]) {
      expect(html).toContain(OA_M);
      expect(html).toContain(`data-stale-sale-name="">${NAT_M}</span>`);
      expect(html).toContain(`data-stale-month-only="">${MONTH_ONLY_PAIR_NOTE}</p>`);
      expect(textOf(html)).toContain("Close with the recorded sale");
    }
    expect(wire.pairs.map((p) => [p.tradingsymbol, p.saleTradingsymbol, p.monthOnly, p.ambiguous, p.oneClick])).toEqual([[OA_M, NAT_M, true, false, true]]);
  });

  it("S2b POST /api/data-quality/close-stale: 409 MONTH_ONLY without the tick (nothing moves), 200 and one closed row with it", async () => {
    select(D);
    const [p] = dq.getStaleOpenSection().pairs;
    const body = { lotId: p!.lotId, saleId: p!.saleId, exitDate: p!.saleDate };
    const refused = await staleRoute.POST(json("/api/data-quality/close-stale", body));
    expect([refused.status, ((await refused.json()) as { code?: string }).code]).toEqual([409, "MONTH_ONLY"]);
    expect(shape(D)).toHaveLength(2);
    const joined = await staleRoute.POST(json("/api/data-quality/close-stale", { ...body, monthOnlyAcknowledged: true }));
    expect(joined.status, JSON.stringify(await joined.clone().json())).toBe(200);
    expect(shape(D)).toEqual([[OA_M, QTY, QTY, false]]);
    expect(sold(D)).toBe(QTY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S3 + S4 — through the REAL broker route, OpenAlgo instance stubbed at fetch,
// at 19:00 UTC on 15 Sep = 00:30 IST on 16 Sep (the IST day boundary)
// ═════════════════════════════════════════════════════════════════════════════

describe("S3 + S4 · the OpenAlgo pull through app/api/import/broker/route.ts, at the IST day boundary", () => {
  const IST_DAY = "2026-09-16";
  const OA_FILE = `openalgo-fyers-${IST_DAY}`;
  let book: Record<string, unknown>[] = [];
  const fill = (symbol: string, action: "BUY" | "SELL", quantity: number, average_price: number) => ({
    action, symbol, exchange: "NFO", product: "NRML", quantity, average_price, trade_value: quantity * average_price, timestamp: "10:00:00",
  });
  const OA_IN_W = "NIFTY22SEP2625000CE"; // → OPT NIFTY 22 Sep 2026 25000 CE
  const OA_IN_M = "NIFTY29SEP2625000CE"; // → OPT NIFTY 29 Sep 2026 25000 CE

  const post = (body: unknown) => brokerRoute.POST(json("/api/import/broker", body));
  async function connect(accountId: number) {
    newAccount(accountId, `seam oa ${accountId}`);
    const res = await post({ action: "save", broker: "openalgo", accountId, apiKey: `oa-seam-key-${accountId}`, host: "127.0.0.1:5000", underlyingBroker: "fyers" });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  }
  async function oaPull(accountId: number, rows: Record<string, unknown>[], mode: "commit" | "preview" = "commit") {
    book = rows;
    const res = await post({ action: "pull", broker: "openalgo:fyers", accountId, mode });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { result?: Record<string, unknown>; collisions?: { kind: string; sameSnapshot?: boolean; monthOnly?: boolean; symbol?: string; existing: { sourceFile: string | null } }[]; message?: string } };
  }

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T19:00:00.000Z"));
    t.sqlite.prepare("UPDATE settings SET openalgo_enabled = 1, openalgo_ack_version = ?").run(OPENALGO_DISCLOSURE_VERSION);
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/auth/app-info")) return new Response(JSON.stringify({ status: "success", version: "2.0.2.6", name: "OpenAlgo" }), { status: 200 });
      if (String(url).endsWith("/api/v1/tradebook")) {
        return new Response(JSON.stringify({ status: "success", data: book }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`TEST GUARD: unexpected network call ${url}`);
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // S4a is the route's FIRST call in the file (save + two pulls): measured 387 ms locally, most of it module warm-up.
  it("S4a two OpenAlgo pulls one IST day: the second (the day aggregate) RESTATES the first in place — bought 75, sold 75", async () => {
    const A = 210;
    await connect(A);
    const first = await oaPull(A, [fill(OA_IN_W, "BUY", QTY, 120)]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(rowsOf(A).map((r) => [r.tradingsymbol, r.sourceFile, r.buyDate])).toEqual([[OA_W, OA_FILE, IST_DAY]]);
    const second = await oaPull(A, [fill(OA_IN_W, "BUY", QTY, 120), fill(OA_IN_W, "SELL", QTY, 140)]);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.result).toMatchObject({ added: 0 });
    expect(shape(A)).toEqual([[OA_W, QTY, QTY, false]]);
    expect([bought(A), sold(A)], "the broker bought 75 and sold 75").toEqual([QTY, QTY]);
  });

  it("S4b OpenAlgo opens the lot, a native sale under another name closes it, OpenAlgo pulls the day again → 409 needsForce naming the earlier pull; nothing written", async () => {
    const A = 211;
    await connect(A);
    expect((await oaPull(A, [fill(OA_IN_W, "BUY", QTY, 120)])).status).toBe(200);
    const nat = `fyers-api-${IST_DAY}`;
    expect(pull(A, parsed([sell(NAT_W, QTY, 140, IST_DAY)]), nat).result?.autoClose).toMatchObject({ closedWhole: 1 });
    const again = await oaPull(A, [fill(OA_IN_W, "BUY", QTY, 120), fill(OA_IN_W, "SELL", QTY, 140)]);
    expect([again.status, again.body.needsForce]).toEqual([409, true]);
    expect(again.body.collisions!.map((c) => [c.kind, c.sameSnapshot === true, c.existing.sourceFile])).toEqual([["same-quantity", true, OA_FILE]]);
    expect(brokerConnect.collisionDialogCopy({ collisions: again.body.collisions!, message: again.body.message }).otherSourceFooter, "said as today's earlier pull").toBe(false);
    expect(shape(A)).toEqual([[OA_W, QTY, QTY, false]]);

    // The same book WITHOUT the snapshot identity: the lot sits in this very
    // file, but another file's execution closed it — the same-file exclusion
    // (cross-source.ts closedFromFile) must not hide it.
    const parsedOa = openalgo.toParsedFile("fyers", openalgo.normalizeOpenAlgoTrades([fill(OA_IN_W, "BUY", QTY, 120), fill(OA_IN_W, "SELL", QTY, 140)] as never, "fyers", IST_DAY));
    const plain = commit.previewParsedFile(parsedOa, null, A, OA_FILE, { autoClose: true });
    expect(plain.crossSource?.risky).toBe(true);
    expect(plain.crossSource?.collisions.map((c) => [c.kind, c.existing.sourceFile])).toEqual([["same-quantity", OA_FILE]]);
  });

  it("S4c PROBE-1 through the route: an older FILE's lot closed whole by the morning OpenAlgo pull; the evening pull states 150 → 409 on today's earlier pull, sold stays 75", async () => {
    const A = 214;
    await connect(A);
    importFile(A, parsed([buy(OA_W, QTY, 120, PREV)]), "fyers-lot.csv");
    const morning = await oaPull(A, [fill(OA_IN_W, "SELL", QTY, 140)]);
    expect(morning.status, JSON.stringify(morning.body)).toBe(200);
    expect(morning.body.result).toMatchObject({ added: 0, autoClose: { closedWhole: 1 } });
    // The pull's sale lives ONLY inside the older file's lot (its exec-origin) — no row of the pull's own file.
    expect(rowsOf(A).map((r) => [r.sourceFile, r.buyQty, r.sellQty])).toEqual([["fyers-lot.csv", QTY, QTY]]);
    const evening = await oaPull(A, [fill(OA_IN_W, "SELL", 150, 140)]);
    expect([evening.status, evening.body.needsForce]).toEqual([409, true]);
    expect(evening.body.collisions!.map((c) => [c.kind, c.sameSnapshot === true, c.existing.sourceFile])).toEqual([["partial-quantity", true, "fyers-lot.csv"]]);
    expect(sold(A), "the broker sold 150 in all; the book holds the 75 it was told and asks about the rest").toBe(QTY);
  });

  it("S3a a month-level refusal through the route: `result.autoClose.refusedMonthOnly` 1 and its sentence reach the client's headline and notes", async () => {
    const A = 212;
    await connect(A);
    importFile(A, parsed([buy(NAT_M, QTY, 120, PREV)]), "fyers-lot.csv");
    const res = await oaPull(A, [fill(OA_IN_M, "SELL", QTY, 140)]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = res.body.result as { added: number; skipped: number; autoClose?: CommitAutoClose; warnings?: string[] };
    expect(result.autoClose).toMatchObject({ closedWhole: 0, refusedMonthOnly: 1, refusedHeldIdentity: 0 });
    expect(importClient.importedHeadline(result)).toBe("Imported 1 trade · 0 duplicates skipped.");
    const said = autoCloseSentences({ ...emptyAutoCloseCounters(), refusedMonthOnly: 1 });
    expect(said).toHaveLength(1);
    expect(importClient.commitResultNotes(result)).toContain(said[0]);
    expect(shape(A)).toEqual([[NAT_M, QTY, 0, true], [OA_M, 0, QTY, true]]);
  });

  it("S3b held identity through the route: 409 whose collision the dialog badges 'already recorded'; auto-pull classifies the same preview as a skip", async () => {
    const A = 213;
    await connect(A);
    importFile(A, parsed([buy(OA_W, QTY, 120, PREV)]), "lot.csv");
    importFile(A, parsed([sell(OA_W, QTY, 140, IST_DAY)]), "sale-75.csv", false);
    const before = shape(A);
    const rows = [fill(OA_IN_W, "SELL", 150, 140)];
    const res = await oaPull(A, rows);
    expect([res.status, res.body.needsForce]).toEqual([409, true]);
    const badges = brokerConnect
      .dialogCollisions(res.body.collisions!)
      .flatMap((c) => [c, ...(c.also ?? [])].map((e) => brokerConnect.collisionBadge(e.kind, e.monthOnly)));
    expect(badges).toEqual(["already recorded"]);
    expect(res.body.message).toMatch(/already recorded as a row of its own/);
    expect(shape(A)).toEqual(before);

    // auto-pull's own options (lib/jobs/auto-pull.ts:329) over the same rows.
    const p = openalgo.toParsedFile("fyers", openalgo.normalizeOpenAlgoTrades(rows as never, "fyers", IST_DAY));
    const pre = commit.previewParsedFile(p, null, A, OA_FILE, { supersedeSnapshot: { fileName: OA_FILE }, autoClose: true });
    expect(pre.autoClose).toMatchObject({ refusedHeldIdentity: 1 });
    expect(classifyPreview(pre)).toBe("collision");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S5 — formerSymbols: the index-map build → bundledIsinBySymbol → its readers
// ═════════════════════════════════════════════════════════════════════════════

describe("S5 · a renamed ticker (TATAMOTORS → the ISIN listed as TMPV) still joins its option legs", () => {
  it("the /strategies page names 'Tata Motors Ltd' (stored under the company name, TATAMOTORS' ISIN) the Covered Call of its TATAMOTORS call; the Upstox cash key resolves the same ISIN", () => {
    const A = 220;
    newAccount(A, "seam former symbol");
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({ accountId: A, symbol: "TATAMOTORS", tradingsymbol: "TATAMOTORS1000CE", instrumentType: "option", optionType: "CE", strike: 1000, expiry: "2026-10-27", isOpen: true, sellQty: 550, avgSellPrice: 15 }),
        tradeRow({ accountId: A, symbol: "Tata Motors Ltd", tradingsymbol: "Tata Motors Ltd", isin: "INE155A01022", isOpen: true, buyQty: 550, avgBuyPrice: 950 }),
      ] as never)
      .run();
    select(A);
    const text = textOf(renderToStaticMarkup(strategiesPage.default() as React.ReactElement));
    expect(text).toContain("|TATAMOTORS|Covered Call|");
    expect(upstoxInstrumentKey({ symbol: "TATAMOTORS", exchange: "NSE" })).toBe("NSE_EQ|INE155A01022");
    expect(bundledIsinBySymbol("TATAMOTORS")).toBe("INE155A01022");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S1d — LAST: a whole-database backup round trip (it re-runs every data fix)
// ═════════════════════════════════════════════════════════════════════════════

describe("S1d · exec-origin's ISIN → un-close → backup restore → the Paytm re-key → re-import", () => {
  it("a Paytm lot (no ISIN) closed by a sale stating its ISIN, un-closed, then dumped and restored: the reinstated sale keeps its hash and its file re-imports as a duplicate", () => {
    const P = 230;
    newAccount(P, "seam paytm");
    const pay = (rows: NormalizedTrade[]) => parsed(rows.map((r) => ({ ...r, broker: "paytm" }) as NormalizedTrade), "paytm", "paytm-pnl");
    importFile(P, pay([buy("SBIN", 10, 800, "2026-09-10")]), "paytm-lot.csv");
    const saleFile = pay([sell("SBIN", 10, 850, DAY, { isin: "INE062A01020" })]);
    expect(importFile(P, saleFile, "paytm-sale.csv").autoClose).toMatchObject({ closedWhole: 1 });
    const lot = rowsOf(P)[0]!;
    const hash = executionHashOfPiece(lot);
    select(P);
    expect(commit.unCloseExecution(P, "paytm", hash).ok).toBe(true);
    const reinstated = rowsOf(P).find((r) => r.sellQty > 0)!;
    expect([reinstated.isin, reinstated.dedupHash, reinstated.sourceFile]).toEqual(["INE062A01020", hash, "paytm-sale.csv"]);

    const res = backup.restoreDatabase(backup.dumpDatabase(false));
    expect(res.ok, res.message).toBe(true);
    select(P);
    expect(rowsOf(P).find((r) => r.sellQty > 0)!.dedupHash, "the re-key recomputes the SAME hash from the row's own ISIN").toBe(hash);
    const again = commit.previewParsedFile(saleFile, null, P, "paytm-sale.csv", { autoClose: true });
    expect([again.summary.total, again.summary.newCount], "the sale file is a duplicate, not a second sale").toEqual([1, 0]);
    expect(sold(P)).toBe(10);
    // Raised timeout: a WHOLE-database dump + restore (every data fix re-runs) — measured 782 ms locally.
  }, 15_000);
});
