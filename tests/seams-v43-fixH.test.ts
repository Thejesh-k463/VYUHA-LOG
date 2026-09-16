import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";

/**
 * v4.3.0 FIX WAVE 2O — THE SEAMS OF FOUR SEQUENTIAL BUILDERS' DISJOINT FILE SETS.
 *
 * B2O-METRICS-PALETTE (D1 the five null ratios, D2 one win-rate rule, D3 one
 * palette chord) · B2O-IDENTITY (D4 the restore's link gate, D5 the grouped
 * badge) · B2O-MTF (D6/D7 the ladder's principal, D8 the funded face, D9 one
 * dash reason, D10 the closed-MTF question, D11 broker-compare, D12 comments) ·
 * B2O-DATES (D13 one calendar on both sides of the sale, D14/D15 the IPO
 * preview ≡ save, D16 a blank exit date, D17 the third stored-date refusal,
 * D18/D19 the blocked-import dialog, D20 the staged parent's one writer).
 *
 * Each builder ran its own files' tests. NOTHING ran the two halves of a value
 * that crosses from one set into another, which is this file.
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The stubs are framework and
 * transport only: `next/cache`, `next/navigation` and `globalThis.fetch` for
 * api.dhan.co. A server page's props are read off its OWN element tree; a
 * client component's output is its OWN render.
 *
 * ── THE SEAM TABLE ───────────────────────────────────────────────────────────
 *
 *  #  | crossing value                          | producer (file:line, builder)                        | consumer (file:line, builder)                              | unit / shape                      | test
 * ----|-----------------------------------------|------------------------------------------------------|------------------------------------------------------------|-----------------------------------|-----
 *  H1 | GroupStat.pricedCount / pricedNet /     | lib/analytics/metrics.ts:250 groupBy (D2)            | app/reports/edge/page.tsx:311 bookCount / :315            | counts and a 0..1 rate, null      | H1
 *     |   a null winRate, over ONE book          |   beside computeKpis :157 (D1) — one builder, two     |   proportionPValue / :352-356 wilsonInterval + the         |   when pricedCount is 0; Σ         |
 *     |                                         |   wires                                              |   verdict title / :364 the local expectancy                |   pricedCount = closed - unpriced  |
 *  H2 | Kpis.winRate / expectancy / avgWin /    | lib/analytics/metrics.ts:157,159,161,162 (D1)        | lib/domain/lens-edge.ts:157-162 toLensRow -> the /lenses    | number | null; "—", never 0%,     | H2
 *     |   avgLoss = null                        |                                                      |   row render (components/lenses/lenses-client.tsx:366)     |   in BOTH licence wires           |
 *  H3 | ShareStats.winRatePct / expectancy      | app/reports/performance/page.tsx:116,120 (D1)        | lib/analytics/share-card.ts:95 buildShareCard -> the        | null; "—" drawn, no `.toFixed`    | H3
 *     |                                         |                                                      |   client card's own render (components/reports/share-card) |   on null (it THREW)              |
 *  H4 | the Ctrl/Cmd+K predicate                | components/system/search-panel-keys.ts:53            | components/system/command-palette.tsx:156 (the handler)     | boolean; mutually exclusive with  | H4
 *     |                                         |   isPaletteChord (D3)                                |   ≡ search-panel.tsx:156 isPanelToggleChord                 |   the panel's chord, by table     |
 *  H5 | a replayed `ipos` / `ledger_entries`    | lib/queries/account-delete.ts:859 accountRows (K1/  | lib/trash.ts:737-760 the replay gate (D4) -> ipos.ts:205    | trade id or NULL; the ENVELOPE    | H5
 *     |   row's trade reference                  |   D5) — the envelope states it VERBATIM               |   getIpoTradeLinks, capital, tax base, ITR, both AIS sides  |   decides, never `landed` alone   |
 *  H6 | QualityIssue.affectedCount and the two  | lib/analytics/data-quality.ts:1398 (D5) and :1345 /  | app/data-quality/page.tsx:25-26 the page's OWN score over   | a count, not the score; two       | H6
 *     |   mtf codes                              |   :1367 (D10) — two builders, one file                |   report ∪ crossAccount; :46 the badge; the two hrefs       |   codes, two screens              |
 *  H7 | ctx.mtfFundedAmount (₹ or null)         | lib/queries/staged.ts:213-235 priceLegs (D6/D7)     | lib/jobs/mtf-accrual.ts:36 the job (D6) and commit.ts       | ₹ apportioned by tranche value;   | H7
 *     |                                         |                                                      |   :2513 updateManualTrade (D20) — one staged writer         |   parent = Σ legs at every step   |
 *  H8 | fundedAmount: number | null and the     | lib/analytics/positions.ts:305 mtfFundedStated /     | components/trackers/tracker-client.tsx:307 the KPI face +   | ₹ (rupees) / PAISE on the desk;   | H8
 *     |   dash reason                            |   :424 mtfDashReason (D8/D9)                         |   :319-329 the dialog rows; app/targets/equity/page.tsx:99; |   ONE figure, ONE reason per row  |
 *     |                                         |                                                      |   components/live/load-desk.ts -> tracker-client.tsx:1351  |                                   |
 *  H9 | CompareTrade.fundedAmount                | app/reports/broker-compare/page.tsx:76 (D11)        | lib/analytics/broker-compare.ts:163-216 every broker total, | ₹; a null prices NO financing,    | H9
 *     |                                         |                                                      |   `cheapest`, `maxSaving` -> the page's own strings         |   and margin_config cannot move it|
 * H10 | the DAY a stored sell date states       | lib/analytics/ipo-link.ts:226 dayOf (D13)           | app/api/ipos/route.ts:205 syncWritesSellDate + :531 the     | ISO day on BOTH sides; 200 and a  | H10
 *     |                                         |                                                      |   409 gate -> the holding's own row                        |   sync, never a 409 or a 400      |
 * H11 | IpoEditPricing {charges, repriced}      | lib/analytics/ipo.ts:376 ipoEditCharges (D14/D15)   | app/api/charges/preview/route.ts:168 (the dialog's own      | the ten heads to the paisa, and   | H11
 *     |                                         |                                                      |   body) ≡ lib/import/commit.ts:2530 updateManualTrade       |   importNotes byte-identical      |
 * H12 | storedDateProblem(string)                | lib/domain/trading-day.ts:223 (D17 reader 3)        | lib/import/commit.ts:2435 updateManualTrade -> app/trades/  | one sentence; {ok:false}, never   | H12
 *     |                                         |                                                      |   actions.ts updateTradeAction -> the dialog's own guard    |   a throw and never a write       |
 * H13 | CrossSourceCollision.row (the incoming  | lib/import/cross-source.ts:300 (D18)                | app/api/import/broker/route.ts's 409 -> broker-connect.tsx  | an index; TWO cards for two rows, | H13
 *     |   row index)                             |                                                      |   :258 collisionRowKey -> collisionRows / dialogCollisions  |   and "these rows"                |
 * H14 | collisionsToList's row budget            | lib/import/cross-source.ts:437 (D19)                | components/import/import-client.tsx:287 + the two tails     | 12 rows, `truncated`, `more`      | H14
 *
 * RED ON HEAD / RED ON REVERT (2026-09-16). The pre-wave text of every file is
 * `git show HEAD:<path>` (HEAD = 5e537b3, code = f9a1a6b — the tree all four
 * builders started from). Each probe aliased ONE side onto that copy inside a
 * deleted tests/zzprobe-fixH-*.test.ts / tests/zzseam-head-*.ts pair (vi.mock),
 * or re-ran this file's own assertion against the HEAD text where the pin is a
 * source read. No product file was touched. Verbatim, per seam:
 *
 *   H1  lib/analytics/metrics.ts (HEAD) -> "the ONE book's own rate: expected 0.25 to be 0.5"
 *         — HEAD's groupBy has no pricedCount at all, so the page's bookCount sums
 *         `undefined` and the book rate it corrects against is NaN
 *       app/reports/edge/page.tsx (HEAD) -> "the edge report's book rate is the
 *         dashboard's: expected 0.25 to be 0.5" and "a slice with no priced trade
 *         states no interval: expected '…0%–100%…' not to contain '0%–100%'"
 *   H2  lib/analytics/metrics.ts (HEAD) -> "an all-unpriced closed book states no
 *         rate: expected +0 to be null"
 *       lib/domain/lens-edge.ts (HEAD) + components/lenses/lenses-client.tsx (HEAD)
 *         -> "the /lenses row draws a dash, never 0%: expected '…<td…>0%</td>…' not
 *         to contain '>0%<'"
 *   H3  lib/analytics/share-card.ts (HEAD) -> "TypeError: Cannot read properties of
 *         null (reading 'toFixed')" — the throw inside the client card's useMemo
 *       app/reports/performance/page.tsx (HEAD) -> "the card is handed a blank,
 *         not a 0: expected NaN to be null"
 *   H4  components/system/command-palette.tsx (HEAD) -> "the palette reads the ONE
 *         predicate: expected '…(e.ctrlKey || e.metaKey) && e.key.toLowerCase() ===
 *         \"k\"…' to contain 'isPaletteChord(e)'"
 *       components/system/search-panel-keys.ts (HEAD) -> "isPaletteChord is not a function"
 *   H5  lib/trash.ts (HEAD) -> "the holding it named is not in the journal, so it
 *         names nothing: expected 1810 to be null", then "All accounts states the
 *         sale once: expected [ 'H5OTHER', 'H5TAKEN' ] to deeply equal
 *         [ 'H5-STRAY (IPO)', …(2) ]"
 *   H6  lib/analytics/data-quality.ts (HEAD) -> "a closed row is not the open
 *         question: expected 'mtf_funding' to be 'mtf_funding_closed'" and "the
 *         badge names the holdings the detail names: expected undefined to be 3"
 *   H7  lib/queries/staged.ts (HEAD) -> "a principal the journal never recorded is
 *         not billed: expected 71.38 to be +0"
 *       lib/jobs/mtf-accrual.ts (HEAD) -> "parent = Σ legs, at every step:
 *         expected 0 to be 218.58"
 *       lib/import/commit.ts (HEAD) -> "the ladder is the only writer of a staged
 *         parent: expected true to be false"
 *   H8  lib/analytics/positions.ts (HEAD) -> "the face states what the book records:
 *         expected +0 to be 32000" and "one reason, every screen: expected
 *         'partlySold' to be 'unpriced'"
 *   H9  app/reports/broker-compare/page.tsx (HEAD) -> "a figure on the report moved
 *         when the margin table moved: expected '₹1,26,838' to be '₹1,25,588'"
 *   H10 app/api/ipos/route.ts (HEAD) + lib/analytics/ipo-link.ts (HEAD) -> "the
 *         correction saves and syncs: expected [ 409, false ] to deeply equal
 *         [ 200, true ]"
 *   H11 app/api/charges/preview/route.ts (HEAD) -> "the dialog shows the bill the
 *         save will store: expected 3 to be 2"
 *   H12 lib/import/commit.ts (HEAD) -> "SqliteError: NOT NULL constraint failed:
 *         trades.charges_total_paise" — the throw, not an {ok:false}
 *   H13 lib/import/cross-source.ts (HEAD) -> "two incoming rows are two cards:
 *         expected 1 to be 2"
 *   H14 lib/import/cross-source.ts (HEAD) -> "the list is bounded in LINES:
 *         expected [ 30, +0, undefined ] to deeply equal [ 12, +0, 18 ]"
 *
 * SEAM DEFECTS found by a pass are REPORTED to the orchestrator, never fixed here.
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
let importer: typeof import("@/lib/import/commit");
let actions: typeof import("@/app/trades/actions");
let tradeQueries: typeof import("@/lib/queries/trades");
let slim: typeof import("@/lib/domain/slim-trade");
let metrics: typeof import("@/lib/analytics/metrics");
let lensEdge: typeof import("@/lib/domain/lens-edge");
let shareCardLib: typeof import("@/lib/analytics/share-card");
let keys: Record<string, unknown> & typeof import("@/components/system/search-panel-keys");
let positionsLib: typeof import("@/lib/analytics/positions");
let dq: typeof import("@/lib/analytics/data-quality");
let dqQueries: typeof import("@/lib/queries/data-quality");
let staged: typeof import("@/lib/queries/staged");
let accrual: typeof import("@/lib/jobs/mtf-accrual");
let trash: typeof import("@/lib/trash");
let accountDelete: typeof import("@/lib/queries/account-delete");
let ipoQueries: typeof import("@/lib/queries/ipos");
let ipoRoute: typeof import("@/app/api/ipos/route");
let ipoLink: typeof import("@/lib/analytics/ipo-link");
let chargesPreview: typeof import("@/app/api/charges/preview/route");
let marginRoute: typeof import("@/app/api/margin/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");
let fileRoute: typeof import("@/app/api/import/route");
let crossSource: typeof import("@/lib/import/cross-source");
let bc: Record<string, unknown> & typeof import("@/components/import/broker-connect");
let editDialog: Record<string, unknown> & typeof import("@/components/trades/edit-trade-dialog");
let Dialog: typeof import("@/components/ui/dialog").Dialog;
let EditTradeDialog: typeof import("@/components/trades/edit-trade-dialog").EditTradeDialog;
let LensesClient: typeof import("@/components/lenses/lenses-client").LensesClient;
let ShareCard: typeof import("@/components/reports/share-card").ShareCard;
let TrackerClient: typeof import("@/components/trackers/tracker-client").TrackerClient;
let edgePage: () => unknown;
let lensesPage: () => unknown;
let performancePage: () => unknown;
let equityPage: () => unknown;
let targetsPage: () => unknown;
let dataQualityPage: () => unknown;
let brokerComparePage: () => unknown;

const H1_ACC = 1801; //  H1: one book the edge report and the dashboard both read
const H2_ACC = 1802; //  H2: a closed book whose every trade is unpriced
const H3_ACC = 1803; //  H3: the same, read by the share card
const H5_LEG = 1805; //  H5: the book the stray IPO record is filed in
const H5_TGT = 1806; //  H5: the merge target, its survivor carrying its own record
const H5_SRC = 1807; //  H5: the merge source, its duplicate named by the stray
const H5_PA = 1808; //   H5: the purged book, its record naming another book's holding
const H5_PB = 1809; //   H5: the book that holds it (never deleted)
const H6_ACC = 1810; //  H6: 3 open + 3 closed unpriced MTF rows and a grouped IPO issue
const H7_ACC = 1811; //  H7: a staged MTF ladder with no stated funding
const H7_STATED = 1812; // H7: the same ladder, stating 3,000 over two tranches
const H8_ACC = 1813; //  H8: two partly sold MTF rows beside an unpriced one
const H9_ACC = 1814; //  H9: a null-funded MTF row across a margin_config edit
const H10_ACC = 1815; // H10: a 4.2.x day-first exit in BOTH columns
const H11_ACC = 1816; // H11: an allotment-derived row, priced and un-exited
const H12_ACC = 1817; // H12: a stored date that states no day
const H13_ACC = 1818; // H13: one scrip, two incoming rows, the same five figures
const H14_ACC = 1819; // H14: thirty colliding rows of ONE symbol
const H7_NOTE = 1820; // H7: the same ladder, saved with nothing but a note
const ACCOUNTS = [H1_ACC, H2_ACC, H3_ACC, H5_LEG, H5_TGT, H5_SRC, H5_PA, H5_PB, H6_ACC, H7_ACC, H7_STATED, H8_ACC, H9_ACC, H10_ACC, H11_ACC, H12_ACC, H13_ACC, H14_ACC, H7_NOTE];

// ONE temp database for this file. Measured locally 2026-09-16 (vitest's own
// per-test times, 18 `it`s): the slowest three are H2 304 ms (six lenses grouped
// and LensesClient rendered twice, once per licence), H8 296 ms (/equity's page,
// the tracker's own render, /targets and the Live Desk payload over one book) and
// H5 226 ms (a merge, an un-merge, a purge and a restore, with six readers in
// three views); every other `it` is under 80 ms and the file's wall clock is
// 5.8 s, the rest of it hooks. H2 and H8 sit a few ms over the 300 ms guidance
// because each is FOUR consumers of one seam in one case — splitting them would
// re-seed the book per consumer, which costs more than it saves. The raised hook
// timeouts are for the Windows runner, measured > 15x slower on SQLite-file work
// (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("seams-v43-fixH", { seed: true });
  importer = await import("@/lib/import/commit");
  actions = await import("@/app/trades/actions");
  tradeQueries = await import("@/lib/queries/trades");
  slim = await import("@/lib/domain/slim-trade");
  t.db
    .insert(t.schema.accounts)
    .values(ACCOUNTS.map((id) => ({ id, name: `fixH ${id}`, isDefault: false })))
    .run();
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

// ── shared harness (the fixF/fixE shape: every describe loads the modules it
//    reads itself, so a `-t` run of one case shows that seam's own red) ───────

async function fixHModules() {
  importer = await import("@/lib/import/commit");
  actions = await import("@/app/trades/actions");
  tradeQueries = await import("@/lib/queries/trades");
  slim = await import("@/lib/domain/slim-trade");
  metrics = await import("@/lib/analytics/metrics");
  lensEdge = await import("@/lib/domain/lens-edge");
  positionsLib = await import("@/lib/analytics/positions");
  dq = await import("@/lib/analytics/data-quality");
  dqQueries = await import("@/lib/queries/data-quality");
}

const freezeAt = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};
const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get();
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const json = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const exported = (m: Record<string, unknown>, k: string): unknown => (Object.keys(m).includes(k) ? m[k] : undefined);
const NO_STATE = { ok: false, message: "" };
const insertTrade = (over: Record<string, unknown>) =>
  t.db.insert(t.schema.trades).values(tradeRow(over)).returning({ id: t.schema.trades.id }).get()!.id;

/** A file's own text, with comments stripped: a source pin reads CODE, so a
 *  comment can neither satisfy it nor redden it (the fixF/live-keys rule). */
const readSource = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "dhan", isin: null, buyQty: 0, avgBuyPrice: 0, buyValue: 0, sellQty: 0, avgSellPrice: 0, sellValue: 0,
    closingPrice: null, grossPnl: 0, unrealisedPnl: 0, buyDate: null, sellDate: null,
    productHint: "delivery", exchangeHint: "NSE", sourceFile: null, ...over,
  } as NormalizedTrade;
}
const parsed = (trades: NormalizedTrade[], over: Partial<ParsedFile> = {}): ParsedFile =>
  ({ sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings: [], ...over }) as ParsedFile;

/** Every `<input name=… value=…>` a server render prints, as the browser posts it. */
function formOf(html: string): FormData {
  const fd = new FormData();
  for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    if (!name) continue;
    fd.append(name, unescape(/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? ""));
  }
  return fd;
}
/** The trade as /trades ships it to the client (the RSC payload is JSON). */
function wireTrade(accountId: number, id: number) {
  selectAccount(accountId);
  const r = tradeQueries.getJournalTrades().find((x) => x.id === id);
  if (!r) throw new Error(`/trades does not list trade ${id} in account ${accountId}`);
  return JSON.parse(JSON.stringify(slim.toSlimTrade(r))) as ReturnType<typeof slim.toSlimTrade>;
}
type WireTrade = ReturnType<typeof wireTrade>;
/** The trade editor's form as it opens on this trade, with the user's changes typed in. */
function editorForm(accountId: number, id: number, typed: Record<string, string>) {
  const html = renderToStaticMarkup(
    React.createElement(Dialog, null, React.createElement(EditTradeDialog, { trade: wireTrade(accountId, id), onDone: () => {} })),
  );
  const fd = formOf(html);
  for (const [k, v] of Object.entries(typed)) fd.set(k, v);
  return fd;
}

// The React element tree a server page returns, walked for the props it hands a
// client component (the RSC payload's own shape) — never the rendered string.
type Elem = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const isElem = (n: unknown): n is Elem => !!n && typeof n === "object" && "type" in n && "props" in n;
function walk(node: unknown, visit: (e: Elem) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!isElem(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
function findElem(node: unknown, pick: (e: Elem) => boolean): Elem | null {
  let hit: Elem | null = null;
  walk(node, (e) => {
    if (!hit && pick(e)) hit = e;
  });
  return hit;
}
/** Every string a subtree prints, in order — a rendered cell without a DOM. */
function textLeaves(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textLeaves(n, out);
    return out;
  }
  if (isElem(node)) textLeaves(node.props.children, out);
  return out;
}
/** A server page's element, rendered on its own — the output its parent shows. */
const renderElem = (e: Elem) => renderToStaticMarkup(React.createElement(e.type as React.FunctionComponent, e.props as never));

// ============================================================================
// H1 — D2's GroupStat (metrics.ts) ↔ D1's Kpis (metrics.ts) over ONE book,
//      read by /reports/edge's five statistical sites
// ============================================================================

describe("H1 · one win-rate rule over one book (groupBy's pricedCount → /reports/edge's book rate, its p-values, its interval and its expectancy ≡ computeKpis)", () => {
  beforeAll(async () => {
    await fixHModules();
    edgePage = (await import("@/app/reports/edge/page")).default as () => unknown;
  }, 60_000);

  /** A closed round trip with a known basis — a priced trade. */
  const priced = (sym: string, segment: string, sell: number, net: number) =>
    insertTrade({
      accountId: H1_ACC, broker: "zerodha", bucket: "equity", segment, symbol: sym, tradingsymbol: sym,
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-08-03", buyOrderCount: 1,
      sellQty: 10, avgSellPrice: sell, sellValue: sell * 10, sellDate: "2026-08-10", sellOrderCount: 1,
      grossPnl: sell * 10 - 1000, chargesTotal: Math.round((sell * 10 - 1000 - net) * 100) / 100, netPnl: net, isOpen: false,
    });
  /** A sale whose purchase is not in the data: real cash, no measurable edge. */
  const unpriced = (sym: string, segment: string) =>
    insertTrade({
      accountId: H1_ACC, broker: "zerodha", bucket: "equity", segment, symbol: sym, tradingsymbol: sym,
      buyQty: 0, avgBuyPrice: 0, buyValue: 0, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-08-12", sellOrderCount: 1,
      grossPnl: 1500, chargesTotal: 4, netPnl: 1496, isOpen: false,
      acquisition: "ipo", acquisitionPrice: null, acquisitionDate: null,
    });

  it("Σ pricedCount is the book's own priced count, the report's book rate IS computeKpis' win rate, and a slice with no priced trade states no rate, no interval and no expectancy", async () => {
    freezeAt("2026-08-31T19:00:00.000Z"); // 2026-09-01 00:30 IST — the IST day boundary
    priced("H1WIN", "eq_delivery", 150, 495);
    priced("H1LOSS", "eq_delivery", 90, -105);
    unpriced("H1UNP", "eq_delivery");
    unpriced("H1UNP2", "eq_intraday"); // a slice with nothing priced at all
    selectAccount(H1_ACC);

    // PRODUCER — both wires, from the ONE module, over the ONE row set.
    const trades = tradeQueries.getTrades();
    const k = metrics.computeKpis(trades);
    const groups = metrics.bySegment(trades);
    const delivery = groups.find((g) => g.key === "eq_delivery")!;
    const intraday = groups.find((g) => g.key === "eq_intraday")!;

    // THE seam identity (on revert of lib/analytics/metrics.ts to HEAD:
    // `pricedCount` does not exist, so this sum is NaN and the page's book rate
    // is NaN — the mirror-image distortion metrics.ts:125-131 warns of).
    expect([k.closedCount, k.unpricedCount], "four closed, two of them unpriced").toEqual([4, 2]);
    expect(
      groups.reduce((s, g) => s + g.pricedCount, 0),
      "Σ GroupStat.pricedCount === Kpis.closedCount − Kpis.unpricedCount",
    ).toBe(k.closedCount - k.unpricedCount);
    expect([delivery.count, delivery.pricedCount, delivery.wins, delivery.winRate], "a genuine 0.5 over the priced two").toEqual([3, 2, 1, 0.5]);
    expect([intraday.count, intraday.pricedCount, intraday.wins, intraday.winRate], "a rate over nothing is not a rate").toEqual([1, 0, 0, null]);
    for (const g of groups) expect(g.count, `${g.key}: count = priced + unpriced`).toBe(g.pricedCount + trades.filter((x) => !x.isOpen && x.segment === g.key && !metrics.edgeMeasurable(x)).length);

    // CONSUMER — the edge report's own derivation (app/reports/edge/page.tsx's
    // `bookWins` / `bookCount`, the five sites D2 had to move together).
    const bookWins = groups.reduce((s, r) => s + r.wins, 0);
    const bookCount = groups.reduce((s, r) => s + r.pricedCount, 0);
    const bookRate = bookCount > 0 ? bookWins / bookCount : null;
    // THE assertion (on revert of app/reports/edge/page.tsx to HEAD, whose
    // bookCount sums `r.count`: 1/4 = 0.25 against the dashboard's 0.5 — two
    // win rates for one book, which is the finding).
    expect(bookRate, "the edge report's book rate is the dashboard's").toBe(k.winRate);
    expect([bookRate, k.winRate], "and it is a real figure, not two nulls agreeing").toEqual([0.5, 0.5]);

    // …and the page really reads it that way: the segment table, rendered.
    const table = findElem(edgePage(), (e) => (e.props as { exportName?: string }).exportName === "vyuha-edge-by-segment");
    if (!table) throw new Error("the edge report no longer renders its by-segment table");
    const html = renderElem(table);
    expect(html, "the priced slice states its rate").toContain("50.0%");
    // THE assertion (on revert of edge/page.tsx: `fmtIntervalPct(wilsonInterval(
    // r.wins, 0))` prints a FULL 0%–100% interval and `rateVerdict` titles it
    // "no closed trades yet" — an interval on no evidence beside a false
    // sentence, invariant 6).
    expect(html, "a slice with no priced trade states no interval").not.toContain("0%–100%");
    expect(html, "…and is not told it has nothing closed").not.toContain("no closed trades yet");
    expect(html, "it is told what it really is").toContain("no priced trades in this slice");
    // The unpriced-only row's three statistical cells are dashes, while its cash
    // is a real figure (the row is not hidden — invariant 7).
    const cells = (label: string) => {
      const start = html.indexOf(`>${label}<`);
      expect(start, `${label} is on the table`).toBeGreaterThan(-1);
      return html.slice(start, start + 900);
    };
    // …and the page's OWN output carries that book rate: the priced slice's
    // verdict title is the one the real inference helpers give for (wins,
    // pricedCount) against it. On revert of edge/page.tsx it is computed over
    // (1, 3) against a book rate of 0.25 — a different sentence, from two rules.
    const { rateVerdict, wilsonInterval } = await import("@/lib/analytics/inference");
    const verdict = rateVerdict(wilsonInterval(delivery.wins, delivery.pricedCount), k.winRate);
    expect(html, "the report's verdict is measured over the priced trades, against the book's own rate").toContain(verdict);

    const intradayRow = cells("Equity Intraday");
    expect(intradayRow.match(/—/g)?.length ?? 0, "rate, interval and expectancy: three dashes").toBeGreaterThanOrEqual(3);
    expect(intradayRow, "the money it really made is still stated").toContain("1,496");

    // The five sites' own source: the page reads pricedCount, never count, for
    // every statistic (the class TypeScript cannot see — a `count` here type-checks).
    const src = stripComments(readSource("app/reports/edge/page.tsx"));
    const edgeTable = src.slice(src.indexOf("function EdgeTable"));
    expect(edgeTable, "the book reference rate sums pricedCount").toContain("rows.reduce((s, r) => s + r.pricedCount, 0)");
    expect(edgeTable, "the p-value's denominator").toContain("proportionPValue(r.wins, r.pricedCount, bookRate)");
    expect(edgeTable, "the interval's denominator").toContain("wilsonInterval(r.wins, r.pricedCount)");
    expect(edgeTable, "the local expectancy is the Kpis rule, not a third denominator").toContain("r.pricedNet / r.pricedCount");
    expect(edgeTable, "and no statistic is measured over the closed count").not.toMatch(/wilsonInterval\(r\.wins, r\.count\)|proportionPValue\(r\.wins, r\.count/);
    // The export carries the denominator, so a sheet holding the rate can be checked.
    expect(src, "COLS states the priced count").toContain('{ key: "pricedCount", label: "Priced trades" }');
  });
});

// ============================================================================
// H2 — D1's five nulls ↔ toLensRow's wire ↔ the /lenses row render, both licences
// ============================================================================

describe("H2 · an all-unpriced closed book: the null crosses computeKpis → toLensRow → the /lenses row, in the Pro wire and the free one", () => {
  beforeAll(async () => {
    await fixHModules();
    LensesClient = (await import("@/components/lenses/lenses-client")).LensesClient;
    lensesPage = (await import("@/app/lenses/page")).default as () => unknown;
  }, 60_000);

  /** Two unpriced sales: real cash, no cost basis anywhere in the data. */
  const seed = () => {
    for (const sym of ["H2ALPHA", "H2BETA"]) {
      insertTrade({
        accountId: H2_ACC, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: sym, tradingsymbol: sym,
        buyQty: 0, avgBuyPrice: 0, buyValue: 0, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-09-02", sellOrderCount: 1,
        grossPnl: 1500, chargesTotal: 4, netPnl: 1496, isOpen: false, acquisition: "ipo", acquisitionPrice: null, acquisitionDate: null,
      });
    }
    selectAccount(H2_ACC);
  };

  it("the wire carries null and the row draws a dash — never 0%, never NaN, and the free wire still withholds", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    if (rowsOf(H2_ACC).length === 0) seed();

    // PRODUCER — the KPI engine over the book's own rows.
    const lensTrades = tradeQueries.getTrades();
    const k = metrics.computeKpis(lensTrades);
    // THE assertion (on revert of lib/analytics/metrics.ts: five 0s, so the
    // dashboard and /lenses read "Win rate 0.0%" and "Expectancy ₹0" for a book
    // that closed two profitable sales — invariant 6).
    expect([k.winRate, k.expectancy, k.avgWin, k.avgLoss, k.chargePctOfGross], "an all-unpriced closed book states no rate").toEqual([
      null, null, null, null, 0.27,
    ]);
    expect([k.closedCount, k.unpricedCount, k.netPnl, k.profitFactor], "…while the cash is real and profitFactor is out of the ruling").toEqual([2, 2, 2992, 0]);

    // THE WIRE — the two licences, from the one producer.
    const pro = lensEdge.toLensRow(k, true);
    const free = lensEdge.toLensRow(k, false);
    expect([pro.edge!.winRate, pro.edge!.expectancy, pro.edge!.avgWin, pro.edge!.avgLoss], "the Pro wire carries the null as null").toEqual([
      null, null, null, null,
    ]);
    expect(free.edge, "the free wire carries no edge at all, as before").toBeNull();
    expect(JSON.stringify(free), "and a null cannot leak a figure into it").not.toContain("winRate");

    // CONSUMER — the /lenses row, rendered. The page builds one row per group of
    // six lenses; the fixture's whole book is unpriced, so EVERY win-rate cell
    // must be a dash and no cell may print a percentage of zero.
    const { LENSES, lensGroups, groupIds } = await import("@/lib/domain/lenses");
    const byId = new Map(lensTrades.map((x) => [x.id, x]));
    const build = (isPro: boolean) => {
      const lenses = {} as Record<string, unknown>;
      for (const lens of LENSES) {
        lenses[lens.kind] = lensGroups(lens.kind, lensTrades, { batches: [], playbooks: [] }).map((group) => {
          const members = groupIds(group, lensTrades).map((id) => byId.get(id)).filter((x) => x != null);
          return { group, row: lensEdge.toLensRow(metrics.computeKpis(members), isPro) };
        });
      }
      return lenses;
    };
    const proHtml = renderToStaticMarkup(
      React.createElement(LensesClient, { lenses: build(true) as never, pro: true }),
    );
    // THE assertion (on revert of lenses-client.tsx' `(e.winRate * 100).toFixed(0)`
    // with HEAD's lens-edge: "0%" in every win-rate cell of a book that has not
    // lost a single trade).
    expect(proHtml, "the /lenses row draws a dash, never 0%").not.toContain(">0%<");
    expect(proHtml, "and the dash is really drawn").toContain("—");
    expect(proHtml, "no arithmetic on a null reaches the screen").not.toContain("NaN");
    expect(proHtml, "the cash cell is a figure").toContain("2,992");
    const freeHtml = renderToStaticMarkup(
      React.createElement(LensesClient, { lenses: build(false) as never, pro: false }),
    );
    expect(freeHtml, "the free wire still shows the lock, not a dash and not a zero").toContain("Pro");
    expect(freeHtml, "…and no fabricated rate arrives with it").not.toContain(">0%<");

    // …and the real page hands the client exactly this shape for its own licence.
    const el = findElem(lensesPage(), (e) => e.type === LensesClient);
    if (!el) throw new Error("/lenses no longer renders <LensesClient>");
    const props = el.props as { pro: boolean; lenses: Record<string, { row: { edge: unknown } }[]> };
    const rows = Object.values(props.lenses).flat();
    expect(rows.length, "the page groups this book").toBeGreaterThan(0);
    expect(
      rows.every((r) => (props.pro ? r.row.edge !== null : r.row.edge === null)),
      "the page's wire is the licence's wire, for every group",
    ).toBe(true);
  });

  /**
   * SEAM DEFECT 1 (found by the wave 2O seam pass, PRE-EXISTING, not introduced by
   * 2O) — FIXED by B2O-SEAMFIX and this pin FLIPPED to a plain `it` in the same
   * change (`wave2h-reports/wave2o-seams.md` §5 defect 1, AGENTS.md's rule for a
   * recorded defect that a fix turns green). `DASH_FIELDS` and `LENS_FIELDS`
   * (lib/queries/trades.ts) now name `acquisition`, `acquisitionPrice` and
   * `buyValue`, and the three are REQUIRED on `AnalyticsTrade`
   * (lib/analytics/metrics.ts) so the next narrow projection that feeds
   * `computeKpis` is a type error rather than a silent 100 %. What was wrong:
   *
   * `edgeMeasurable` (lib/analytics/metrics.ts:38) reads `acquisition`,
   * `acquisitionPrice` and `buyValue`, and all three are OPTIONAL on
   * `AnalyticsTrade` (`:20-24`). The two projections the two D1 surfaces feed it
   * OMIT all three — `DASH_FIELDS` (lib/queries/trades.ts:118-122 → app/page.tsx:29
   * → dashboard-client.tsx:64) and `LENS_FIELDS` (`:57-63` → app/lenses/page.tsx:48
   * and app/api/lenses/members/route.ts:48). With the fields absent
   * `!t.acquisition` is TRUE, so every unpriced sale is counted as a PRICED trade:
   * `unpricedCount` is permanently 0 on both screens and a basis-less IPO flip is a
   * WIN.
   *
   * So D1's own reproduce is unreachable exactly where it was measured: this book
   * shows "Win rate 100.0%" and an expectancy of ₹1,496 on the dashboard and on
   * /lenses — not the "0.0%" the finding describes, and never the blank D1 builds.
   * `/reports/performance` is unaffected (`PERFORMANCE_FIELDS:147` carries all
   * three), which is why H3 passes; /reports/edge reads `getTrades()`, which is why
   * H1 passes. THE COPY THIS WAVE WIDENED IS FALSE ON BOTH SCREENS:
   * lib/domain/help-content.ts:217 now promises a blank "for a group whose closed
   * trades all lack a cost basis".
   *
   * WRONG: `computeKpis(getDashboardTrades()).winRate === 1` / `.unpricedCount === 0`.
   * RIGHT: `null` / `2`, as `computeKpis(getTrades())` answers above — what this
   * case now asserts on all three reads.
   */
  it("FIXED · the dashboard's and /lenses' own projections carry the three fields edgeMeasurable reads, so an unpriced sale is counted as unpriced on every screen", () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    if (rowsOf(H2_ACC).length === 0) seed();
    const full = metrics.computeKpis(tradeQueries.getTrades());
    const dash = metrics.computeKpis(tradeQueries.getDashboardTrades());
    const lens = metrics.computeKpis(tradeQueries.getLensTrades());
    expect([full.unpricedCount, full.winRate, full.expectancy], "the control: over the whole row, the rule holds").toEqual([2, null, null]);
    // Observed today: dash [0, 1, 1496], lens [0, 1, 1496].
    expect([dash.unpricedCount, dash.winRate, dash.expectancy], "the dashboard reads the same book the same way").toEqual([2, null, null]);
    expect([lens.unpricedCount, lens.winRate, lens.expectancy], "and so does /lenses").toEqual([2, null, null]);
  });
});

// ============================================================================
// H3 — D1's nulls ↔ /reports/performance's ShareStats ↔ the card's own render
// ============================================================================

describe("H3 · the share card is handed a blank (computeKpis → ShareStats → buildShareCard → the client card's own render)", () => {
  beforeAll(async () => {
    await fixHModules();
    shareCardLib = await import("@/lib/analytics/share-card");
    ShareCard = (await import("@/components/reports/share-card")).ShareCard;
    performancePage = (await import("@/app/reports/performance/page")).default as () => unknown;
  }, 60_000);

  it("a null winRate and a null expectancy cross the RSC payload and draw “—” in both privacy modes, and the client subtree builds", () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    insertTrade({
      accountId: H3_ACC, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: "H3IPO", tradingsymbol: "H3IPO",
      buyQty: 0, avgBuyPrice: 0, buyValue: 0, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-09-02", sellOrderCount: 1,
      grossPnl: 1500, chargesTotal: 4, netPnl: 1496, isOpen: false, acquisition: "ipo", acquisitionPrice: null, acquisitionDate: null,
    });
    selectAccount(H3_ACC);

    // PRODUCER → the wire the page actually hands the client component.
    const el = findElem(performancePage(), (e) => !!(e.props as { stats?: unknown }).stats);
    if (!el) throw new Error("/reports/performance no longer renders <ShareCard stats>");
    const stats = (el.props as { stats: import("@/lib/analytics/share-card").ShareStats }).stats;
    const capital = (el.props as { capital?: number }).capital ?? 0;
    // THE assertion (on revert of app/reports/performance/page.tsx: `k.winRate *
    // 100` is `null * 100` = 0 — a 0% win rate on a book with no priced trade;
    // with HEAD's metrics.ts it is a real 0, which is the same lie).
    expect([stats.winRatePct, stats.expectancy], "the card is handed a blank, not a 0").toEqual([null, null]);
    expect(stats.netPnl, "…beside the cash, which is real").toBe(1496);

    // CONSUMER — the pure builder, in both modes that touch these two metrics.
    const amounts = shareCardLib.buildShareCard(stats, { metrics: ["winRate", "expectancy", "netPnl"], privacy: "amounts" });
    expect(amounts.map((v) => [v.id, v.display]), "a blank is drawn as a dash, never as ₹0 or 0.0%").toEqual([
      ["winRate", "—"], ["expectancy", "—"], ["netPnl", "₹1.5K"],
    ]);
    expect(amounts.find((v) => v.id === "expectancy")!.tone, "and a dash is toneless, never green").toBe("neutral");
    const percent = shareCardLib.buildShareCard(stats, { metrics: ["expectancy"], privacy: "percent", capital: 100000 });
    expect(percent[0]!.display, "percent mode too — not 0.00% of capital").toBe("—");

    // CONSUMER 2 — the client card's OWN render. On revert of share-card.ts this
    // is `TypeError: Cannot read properties of null (reading 'toFixed')` thrown
    // inside the `useMemo`, taking the whole /reports/performance client subtree
    // and the PNG draw down with it.
    const html = renderToStaticMarkup(React.createElement(ShareCard, { stats, capital }));
    expect(html, "the card renders the dash").toContain("—");
    expect(html, "and never a zero rate").not.toContain("0.0%");
  });
});

// ============================================================================
// H4 — D3's ONE chord predicate ↔ the two real handlers that consume it
// ============================================================================

describe("H4 · one Ctrl+K predicate (search-panel-keys.ts) read by the palette's handler and the panel's, mutually exclusive by construction", () => {
  beforeAll(async () => {
    keys = (await import("@/components/system/search-panel-keys")) as typeof keys;
  }, 60_000);

  const chord = (over: Partial<import("@/components/system/search-panel-keys").Chord>) => ({
    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: "k", ...over,
  });

  it("the palette's chord answers Ctrl+K and Cmd+K only, refuses Shift and AltGr, and no chord opens both surfaces", () => {
    const isPalette = exported(keys, "isPaletteChord") as ((e: unknown) => boolean) | undefined;
    if (typeof isPalette !== "function") throw new Error("search-panel-keys.ts exports no isPaletteChord — the palette has its own copy again");
    const isPanel = keys.isPanelToggleChord;

    // THE assertion (on revert of components/system/search-panel-keys.ts:
    // `isPaletteChord is not a function`; with HEAD's UNGUARDED body inlined,
    // Ctrl+Shift+K and Ctrl+Alt+K both answer true — the palette opening over
    // the search panel, and AltGr+K (₹ on the Indian layout) opening it mid-word).
    expect(isPalette(chord({ ctrlKey: true })), "Ctrl+K").toBe(true);
    expect(isPalette(chord({ metaKey: true })), "Cmd+K").toBe(true);
    expect(isPalette(chord({ ctrlKey: true, key: "K" })), "the keycap's case is not the chord").toBe(true);
    expect(isPalette(chord({ ctrlKey: true, shiftKey: true })), "Ctrl+Shift+K belongs to the panel").toBe(false);
    expect(isPalette(chord({ ctrlKey: true, altKey: true })), "Ctrl+Alt+K is AltGr, a character key").toBe(false);
    expect(isPalette(chord({})), "K alone is a keystroke").toBe(false);
    expect(isPalette(chord({ ctrlKey: true, key: "j" })), "and only K").toBe(false);

    // EXCLUSIVITY over the whole modifier table: at most ONE surface per chord.
    const rows: { label: string; e: ReturnType<typeof chord> }[] = [];
    for (const base of [{ ctrlKey: true }, { metaKey: true }] as const) {
      for (const mods of [{}, { shiftKey: true }, { altKey: true }, { shiftKey: true, altKey: true }] as const) {
        for (const key of ["k", "K", "j"]) rows.push({ label: JSON.stringify({ ...base, ...mods, key }), e: chord({ ...base, ...mods, key }) });
      }
    }
    for (const r of rows) {
      const both = [isPalette(r.e), isPanel(r.e)].filter(Boolean).length;
      expect(both, `${r.label}: at most one surface answers`).toBeLessThanOrEqual(1);
    }
    expect(rows.filter((r) => isPalette(r.e)).length, "the palette owns four of them (Ctrl/Cmd × k/K)").toBe(4);
    expect(rows.filter((r) => isPanel(r.e)).length, "the panel owns four others").toBe(4);

    // CONSUMERS — the two real handlers read THIS module, not a copy of the
    // chord. On revert of components/system/command-palette.tsx the palette
    // carries `(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k"` again and
    // the predicate above is true of a chord the palette still answers.
    const palette = stripComments(readSource("components/system/command-palette.tsx"));
    expect(palette, "the palette reads the ONE predicate").toContain("isPaletteChord(e)");
    expect(palette, "…imported from the keys module").toMatch(/import \{ isPaletteChord \} from "\.\/search-panel-keys"/);
    expect(palette, "and holds no second copy of the chord").not.toMatch(/e\.ctrlKey \|\| e\.metaKey\) && e\.key/);
    const panel = stripComments(readSource("components/system/search-panel.tsx"));
    expect(panel, "the panel reads its own predicate from the same module").toContain("isPanelToggleChord(e)");
    expect(panel, "…and holds no copy either").not.toMatch(/e\.ctrlKey \|\| e\.metaKey\) && e\.key/);
    const keysSrc = stripComments(readSource("components/system/search-panel-keys.ts"));
    expect(keysSrc.match(/export function is(PaletteChord|PanelToggleChord)/g)?.sort(), "both predicates live in ONE module").toEqual([
      "export function isPaletteChord", "export function isPanelToggleChord",
    ]);
  });
});

// ============================================================================
// H5 — the merge/purge ENVELOPE (account-delete.ts, K1/D5) ↔ the restore's
//      link gate (trash.ts, D4) ↔ every reader of a realised IPO sale
// ============================================================================

describe("H5 · a replayed IPO record's trade reference (the envelope states it verbatim → lib/trash.ts decides) read by capital, the tax base, the ITR export, both AIS sides, the /trades badge and Data Quality", () => {
  let capital: typeof import("@/lib/queries/capital");
  let taxItr: typeof import("@/lib/queries/tax-itr");
  let aisRoute: typeof import("@/app/api/ais/route");
  beforeAll(async () => {
    await fixHModules();
    trash = await import("@/lib/trash");
    accountDelete = await import("@/lib/queries/account-delete");
    ipoQueries = await import("@/lib/queries/ipos");
    capital = await import("@/lib/queries/capital");
    taxItr = await import("@/lib/queries/tax-itr");
    aisRoute = await import("@/app/api/ais/route");
  }, 60_000);

  const NET = 482.6;
  const FY = "2025-26";
  const MINE = ["H5TAKEN", "H5OTHER", "H5HOLD", "H5-STRAY (IPO)", "H5-TGT (IPO)", "H5XOWN", "H5XHOLD", "H5XHOLD (IPO)"];
  const closedTrip = (accountId: number, sym: string, over: Record<string, unknown> = {}) =>
    insertTrade({
      accountId, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: sym, tradingsymbol: sym,
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", acquisitionDate: "2026-02-20", buyOrderCount: 1,
      sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", sellOrderCount: 1,
      grossPnl: 500, chargesTotal: 500 - NET, netPnl: NET, isOpen: false, ...over,
    });
  const exitedRecord = (accountId: number, name: string, tradeId: number | null) =>
    t.db
      .insert(t.schema.ipos)
      .values({ accountId, name, appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20", tradeId })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;
  const ipoRowOf = (id: number) => t.db.select().from(t.schema.ipos).all().find((r) => r.id === id);
  const envelopeOf = async (snapshotId: string) => {
    const { trashDir } = await import("@/lib/db");
    return JSON.parse(fs.readFileSync(path.join(trashDir, snapshotId, "snapshot.json"), "utf8")) as {
      accountRows?: { ipos?: { id: number; accountId: number; tradeId: number | null }[] };
    };
  };

  /** Every consumer that must state one realised sale exactly ONCE, in one view. */
  async function counted(view: number) {
    selectAccount(view);
    const cap = capital.getCapitalSummary();
    const base = taxItr.getTaxBase();
    const res = await aisRoute.POST(json("/api/ais", { text: "nothing to parse" }));
    const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
    const side = (kind: string) => recon.fyTotals.find((f) => f.fy === FY && f.kind === kind)?.journal ?? null;
    return {
      capital: [cap.equityRealised, cap.ipoRealised, cap.totalRealised],
      ipoNames: base.exitedIpos.map((r) => r.name).filter((n) => n.startsWith("H5")).sort(),
      itr: taxItr.getItrExportRows().map((r) => r.scrip).filter((s) => MINE.includes(s)).sort(),
      aisSale: side("sale"),
      aisPurchase: side("purchase"),
    };
  }

  it("a duplicate that CANNOT come back leaves its record unlinked (and says so), while a cross-account link the delete never touched is replayed verbatim — one sale, once, in every reader and in both views", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    // ── PART A: merge → un-merge where the duplicate cannot land ─────────────
    const HASH = "h5-merge-dup";
    const targetTrade = closedTrip(H5_TGT, "H5TAKEN", { dedupHash: HASH });
    const sourceTrade = closedTrip(H5_SRC, "H5TAKEN", { dedupHash: HASH });
    const targetIpo = exitedRecord(H5_TGT, "H5-TGT", targetTrade);
    const strayIpo = exitedRecord(H5_LEG, "H5-STRAY", sourceTrade);
    // An unlinked, still-held allotment in the stray's own book, so the question
    // Data Quality raises about the restored record has a holding to name.
    const heldElsewhere = insertTrade({
      accountId: H5_LEG, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: "H5HOLD", tradingsymbol: "H5HOLD",
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", buyOrderCount: 1, isOpen: true,
      acquisition: "ipo", acquisitionPrice: 100, acquisitionDate: "2026-02-20",
    });
    expect([targetIpo, strayIpo, heldElsewhere].every((x) => x > 0)).toBe(true);

    selectAccount(1);
    const merged = accountDelete.deleteAccount({ accountId: H5_SRC, mode: "merge", targetId: H5_TGT, connections: "delete" });
    expect([merged.ok, merged.skippedTrades], merged.message).toEqual([true, 1]);
    expect(ipoRowOf(strayIpo), "the stray record left with the duplicate it names (D5, wave 2N)").toBeUndefined();

    // THE PRODUCER's own statement: the envelope carries that foreign row with
    // its `trade_id` INTACT — the gate is the restore's, not the delete's.
    const env = await envelopeOf(merged.snapshotId!);
    const snapshotted = (env.accountRows?.ipos ?? []).find((r) => r.id === strayIpo);
    expect([snapshotted?.accountId, snapshotted?.tradeId], "the envelope states the row exactly as it stood").toEqual([H5_LEG, sourceTrade]);

    // The freed id, taken by another closed trade — the field shape a snapshot
    // restored against a database whose rowids came from elsewhere meets.
    insertTrade({
      id: sourceTrade, accountId: H5_TGT, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: "H5OTHER", tradingsymbol: "H5OTHER",
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", buyOrderCount: 1,
      sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", sellOrderCount: 1,
      grossPnl: 500, chargesTotal: 500 - NET, netPnl: NET, isOpen: false,
    });
    expect(row(sourceTrade)!.tradingsymbol).toBe("H5OTHER");

    const back = trash.restoreTrashSnapshot(merged.snapshotId!, "H5 seam");
    expect([back.restored, back.skipped.length], back.message).toEqual([0, 1]);
    // THE assertion (on revert of lib/trash.ts to HEAD, which replays the row
    // verbatim: the record comes back naming H5OTHER — a different scrip, in a
    // different book, whose sale then REPLACES the record's own everywhere).
    expect(ipoRowOf(strayIpo)!.tradeId, "the holding it named is not in the journal, so it names nothing").toBeNull();
    expect(back.message, "and the restore says what it could not do").toContain("1 IPO record came back unlinked");
    expect(ipoRowOf(targetIpo)!.tradeId, "the survivor's own record is untouched").toBe(targetTrade);

    selectAccount(0);
    expect(ipoQueries.getIpoTradeLinks().get(sourceTrade), "nothing badges the trade this record never named").toBeUndefined();
    const all = await counted(0);
    // On HEAD: ["H5OTHER", "H5TAKEN"] — the record's own sale left the ITR
    // export, the capital summary and both AIS sides with the stolen link.
    expect(all.itr, "All accounts: the record's own sale is stated, once, beside the two trades").toEqual([
      "H5-STRAY (IPO)", "H5OTHER", "H5TAKEN",
    ]);
    expect(all.ipoNames, "the tax base names it").toEqual(["H5-STRAY"]);
    const own = await counted(H5_LEG);
    // 497.94 is the RECORD's own arithmetic (the IPO model prices its exit),
    // which is the point: with no holding to name, the record is the only
    // statement of that sale — and it is made exactly once.
    expect(own.capital, "its own book: the record's exit, counted once and only there").toEqual([0, 497.94, 497.94]);
    expect(own.itr).toEqual(["H5-STRAY (IPO)"]);
    // Purchase 2,000 = the record's own allotment (1,000) + the still-held
    // H5HOLD buy (1,000); the sale 1,500 is the record's exit, stated once.
    expect([own.aisPurchase, own.aisSale], "both AIS sides state it once").toEqual([2000, 1500]);
    // …and Data Quality asks which holding is the record's (the honest pre-2N
    // state, without leaving the record behind).
    selectAccount(H5_LEG);
    const issue = dqQueries.getDataQualityReport().issues.find((x) => x.code.startsWith("ipo_record_link"));
    expect(issue?.title, "the record is a candidate again").toBe("IPO records not linked to their holdings");
    expect(issue!.ids, "…naming the holding it could be").toContain(heldElsewhere);

    // ── PART B: a purge whose record names ANOTHER book's holding ────────────
    const foreign = closedTrip(H5_PB, "H5XHOLD", { acquisition: "ipo", acquisitionPrice: 100 });
    const ownTrade = closedTrip(H5_PA, "H5XOWN");
    const crossRecord = exitedRecord(H5_PA, "H5XHOLD", foreign);
    const views = [H5_PA, H5_PB, 0];
    const before = [];
    for (const v of views) before.push(await counted(v));

    selectAccount(1);
    const purge = accountDelete.deleteAccount({ accountId: H5_PA, mode: "purge", connections: "delete" });
    expect(purge.ok, purge.message).toBe(true);
    expect(row(foreign), "the purge left the other book alone").toBeTruthy();
    const backTwo = trash.restoreTrashSnapshot(purge.snapshotId!, "H5 seam");
    expect([backTwo.ok, backTwo.restored], backTwo.message).toEqual([true, 1]);
    // The purged book's OWN closed trade is that one restored row — recoverable
    // once, in the account it was purged from. Without it the before/after
    // comparison below would be a statement about two empty books rather than
    // about one sale counted once ("in every reader and in both views").
    expect([row(ownTrade)?.tradingsymbol, row(ownTrade)?.accountId], "the purged book's own sale came back where it was").toEqual(["H5XOWN", H5_PA]);
    // THE assertion (with the gate written as `!landed.has(ref)` — the rejected
    // reading — this live link is CUT and the record's ₹482.60 is counted a
    // second time in the All-accounts view).
    expect(ipoRowOf(crossRecord)!.tradeId, "a reference this delete never touched is replayed verbatim").toBe(foreign);
    expect(backTwo.message, "so nothing is claimed to have been cleared").not.toContain("unlinked");
    const after = [];
    for (const v of views) after.push(await counted(v));
    expect(after, "every view reads exactly what it read before the purge").toEqual(before);
  });
});

// ============================================================================
// H6 — D5's affectedCount ↔ D10's two MTF codes ↔ the page's own score/badges
//      (ONE file, TWO builders — identity first, MTF rebased on it)
// ============================================================================

describe("H6 · one Data Quality report over a 3-open / 3-closed unpriced MTF book with a grouped IPO question (data-quality.ts → app/data-quality/page.tsx's own score and badges)", () => {
  beforeAll(async () => {
    await fixHModules();
    dataQualityPage = (await import("@/app/data-quality/page")).default as () => unknown;
  }, 60_000);

  it("the closed rows raise their OWN question with a link that can list them, the grouped issue badges the holdings it names, and neither re-floors the page's score", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    // Real NSE symbols and a planned stop on every open row, so the fixture
    // raises the three issues under test and not the instrument-master and
    // missing-stop ones beside them: the page's score has to stay OFF its floor
    // for the score assertion below to mean anything (the 2L lesson).
    const OPEN = ["TCS", "INFY", "WIPRO"];
    const SHUT = ["SBIN", "ITC", "LT"];
    const IPOS = ["HDFCBANK", "AXISBANK", "SUNPHARMA"];
    for (let i = 0; i < 3; i++) {
      insertTrade({
        accountId: H6_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: OPEN[i], tradingsymbol: OPEN[i],
        buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1, isOpen: true,
        slPlanned: 90, closingPrice: 105, markedAt: "2026-09-08",
      });
      insertTrade({
        accountId: H6_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: SHUT[i], tradingsymbol: SHUT[i],
        buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1, slPlanned: 90,
        sellQty: 100, avgSellPrice: 110, sellValue: 11000, sellDate: "2026-08-15", sellOrderCount: 1,
        grossPnl: 1000, chargesTotal: 20, netPnl: 980, isOpen: false,
      });
      // An unlinked, allotted IPO holding — the grouped question's own set.
      insertTrade({
        accountId: H6_ACC, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: IPOS[i], tradingsymbol: IPOS[i],
        buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", buyOrderCount: 1, isOpen: true,
        slPlanned: 90, closingPrice: 105, markedAt: "2026-09-08",
        acquisition: "ipo", acquisitionPrice: 100, acquisitionDate: "2026-02-20",
      });
    }
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: H6_ACC, name: "H6 Unmatched Issue", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2026-02-20", tradeId: null })
      .run();
    selectAccount(H6_ACC);

    const issues = dqQueries.getDataQualityReport().issues;
    const open = issues.find((x) => x.code === "mtf_funding");
    const shut = issues.find((x) => x.code === "mtf_funding_closed");
    // THE assertion (on revert of lib/analytics/data-quality.ts to HEAD: ONE
    // issue of 6 rows, `severity: warning`, under a detail naming three OPEN
    // position surfaces and an href of /equity?funding=mtf — a tracker that
    // lists open positions only, so three of the six rows are not there).
    expect([open?.count, open?.href], "the open rows keep their question and their screen").toEqual([3, "/equity?funding=mtf"]);
    expect([shut?.count, shut?.severity], "the closed rows raise their own, as information").toEqual([3, "info"]);
    expect(shut?.href, "…with a link that can actually list them").toBe("/trades?segment=eq_mtf&view=closed");
    expect(shut?.detail, "and copy that names what it costs").toContain("net P&L is stated higher than it was");
    expect(shut!.ids!.length, "every closed row is named").toBe(3);

    // D5 — the grouped question costs ONE warning and badges the holdings it names.
    const grouped = issues.find((x) => x.code.startsWith("ipo_record_link"));
    expect([grouped?.count, grouped?.affectedCount, grouped?.ids?.length], "one question, three holdings").toEqual([1, 3, 3]);

    // THE PAGE's own score, over ITS superset (report ∪ cross-account), not over
    // `report.issues` alone. The new code is `info` (weight 2) exactly so a
    // second capped WARNING cannot re-floor the score the way six did in 2L.
    const { crossAccountIssues, scoreIssues } = dq;
    const brokerIdentity = await import("@/lib/import/broker-identity");
    const superset = [
      ...issues,
      ...crossAccountIssues({ duplicateConnections: brokerIdentity.listDuplicateConnections(), duplicateTradeGroups: brokerIdentity.listDuplicateTradeGroups() }),
    ];
    const score = scoreIssues(superset);
    // What the severity DECISION costs, through the real scorer: 3 rows of info
    // are 6 points; as a second capped WARNING they would be 18 and the ceiling
    // for the pair would double from 30 to 60 — which is how six warnings
    // floored the completeness score in 2L (the counted-once#3 lesson).
    expect(scoreIssues([shut!]), "3 closed rows × the info weight").toBe(94);
    expect(scoreIssues([{ ...shut!, severity: "warning" }]), "…and what a warning would have cost instead").toBe(82);
    expect(score, "the page's score is off its floor, so the number below is a figure").toBeGreaterThan(0);

    // …and the page draws that very score and both questions.
    const html = renderToStaticMarkup(dataQualityPage() as React.ReactElement);
    expect(html, "the header states the page's own score").toContain(`${score}/100`);
    expect(html, "the open question").toContain("MTF positions without funded principal");
    expect(html, "the closed one").toContain("Closed MTF trades without funded principal");
    expect(html, "and its link").toContain("/trades?segment=eq_mtf&amp;view=closed");
    // THE badge (on revert of app/data-quality/page.tsx: "1" beside a sentence
    // naming three holdings).
    const groupedAt = html.indexOf("IPO records not linked to their holdings");
    expect(groupedAt, "the grouped question is on the page").toBeGreaterThan(-1);
    expect(html.slice(groupedAt, groupedAt + 260), "the badge says what the detail says").toContain(">3<");
  });
});

// ============================================================================
// H7 — the ladder's principal (staged.ts, D6/D7) ↔ the accrual job (D6) ↔
//      the trade editor's own save (commit.ts, D20): ONE writer, parent = Σ legs
// ============================================================================

describe("H7 · a staged MTF ladder through every door that touches its interest (convertToStaged → accrueMtfInterest → addLeg → accrue → a notes-only editor save → accrue)", () => {
  beforeAll(async () => {
    await fixHModules();
    staged = await import("@/lib/queries/staged");
    accrual = await import("@/lib/jobs/mtf-accrual");
    Dialog = (await import("@/components/ui/dialog")).Dialog;
    EditTradeDialog = (await import("@/components/trades/edit-trade-dialog")).EditTradeDialog;
  }, 60_000);

  const r2 = (n: number) => Math.round(n * 100) / 100;
  /** Invariant 5, measured: the parent row IS the roll-up of its legs. */
  const parentVsLegs = (id: number) => {
    const legs = staged.loadLegs(id);
    return [row(id)!.chargesTotal, r2(legs.reduce((s, l) => s + l.chargesTotal, 0)), legs.length];
  };
  const billed = (id: number) => {
    const r = row(id)!;
    return [r.mtfFundedAmount, r.mtfInterest];
  };

  it("with nothing recorded it bills nothing at every step, and the parent never disagrees with its legs", async () => {
    freezeAt("2026-08-20T09:30:00.000Z");
    selectAccount(H7_ACC);
    const id = insertTrade({
      accountId: H7_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "H7LADDER", tradingsymbol: "H7LADDER",
      buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1, isOpen: true,
    });
    expect(row(id)!.mtfFundedAmount, "the journal never recorded a funded amount").toBeNull();

    // STEP 1 — the ladder. THE assertion (on revert of lib/queries/staged.ts:
    // `defaultMtfFundedAmount(leg value, margin_config)` per tranche stores
    // ₹71.38 of interest against a principal nobody recorded — a figure that
    // then moves whenever margin_config moves, with no prompt and no audit row).
    const conv = staged.convertToStaged(id);
    expect(conv.ok, JSON.stringify(conv.problems)).toBe(true);
    expect(billed(id), "a principal the journal never recorded is not billed").toEqual([null, 0]);
    const [p1, l1] = parentVsLegs(id);
    expect(p1, "parent = Σ legs, after the convert").toBe(l1);

    // STEP 2 — the daily accrual job /equity runs on open. THE assertion (on
    // revert of lib/jobs/mtf-accrual.ts: it patches the PARENT of a staged row,
    // so the release took 147.20 out of the parent and left the legs stating
    // 218.58 — invariant 5 broken by the fix for mtf#0).
    accrual.accrueMtfInterest("2026-08-20");
    expect(billed(id), "and the job accrues nothing on it either").toEqual([null, 0]);
    const [p2, l2] = parentVsLegs(id);
    expect([p2, p2 === l2], "parent = Σ legs, after the job").toEqual([l2, true]);

    // STEP 3 — a second tranche, then the job again: no oscillation.
    const add = staged.addLeg({ tradeId: id, kind: "entry", tradeDate: "2026-08-10", qty: 50, price: 110 });
    expect(add.ok, JSON.stringify(add.problems)).toBe(true);
    expect(billed(id), "a leg edit does not put an estimate back").toEqual([null, 0]);
    accrual.accrueMtfInterest("2026-08-21");
    expect(billed(id), "…and neither does the next render").toEqual([null, 0]);
    const [p3, l3] = parentVsLegs(id);
    expect([p3, p3 === l3, l3 > 0], "parent = Σ legs, with two tranches priced").toEqual([l3, true, true]);

    // STEP 4 — a fourth accrual after a leg edit through the ladder's own door:
    // still nothing billed, and still one writer.
    const upd = staged.updateLeg(staged.loadLegs(id)[1]!.id, { qty: 50, price: 112, tradeDate: "2026-08-10" });
    expect(upd.ok, JSON.stringify(upd.problems)).toBe(true);
    accrual.accrueMtfInterest("2026-08-22");
    expect(billed(id), "still nothing billed, four doors later").toEqual([null, 0]);
    const [p4, l4] = parentVsLegs(id);
    expect([p4, p4 === l4], "parent = Σ legs, after the leg edit and the accrual").toEqual([l4, true]);
  });

  /**
   * SEAM DEFECT 2 (found by the wave 2O seam pass, INTRODUCED BY D20 in this wave)
   * — FIXED by B2O-SEAMFIX and this pin FLIPPED to a plain `it` in the same change
   * (`wave2h-reports/wave2o-seams.md` §5 defect 2). A STAGED parent's "did a charge
   * input move?" is now asked of the PATCH — `patchMovesChargeInput`
   * (lib/domain/trade-edit.ts), the same paisa comparison `chargeInputsChanged`
   * uses, applied only to the fields the patch CARRIES — so a note saves and the
   * ladder re-prices, while a patch that really moves a fill is still refused (the
   * case below this one). What was wrong:
   *
   * D20 refuses a staged-row save whose CHARGE INPUTS moved, and derives "moved"
   * from values it RECOMPUTES: each date and quantity falls back to the stored
   * column when the patch omits it, and `buyValue = r2(buyQty × avgBuyPrice)`. A
   * staged parent's `buyValue` is Σ of its leg values while its `avgBuyPrice` is
   * the ROUNDED weighted average, so for any ladder built at two different prices
   * the two disagree by the rounding:
   *
   *   stored parent    buyQty 150, avgBuyPrice 103.33, buyValue 15500 (Σ leg values)
   *   recomputed here  150 × 103.33 = 15499.5
   *
   * `chargeInputsChanged` is therefore TRUE for a patch that sends nothing but a
   * NOTE, and the save answers "This is a staged position built from more than one
   * fill…" with nothing written. So a user cannot edit the notes, setup tag, stop,
   * target, risk amount or mark price of ANY staged position whose weighted average
   * does not round exactly — which is every ladder built at two prices, through the
   * trade editor AND through any other caller. D20's own design says the opposite:
   * "a patch that moves NO charge input saves the journal fields and hands the
   * pricing back to the ladder", and the builder's own pin passed only because its
   * fixture's average rounds exactly.
   *
   * WRONG: `lib/import/commit.ts:2513` — `isStaged && inputsMoved` is true for
   * `updateManualTrade(id, { notes })` (the refusal, nothing saved).
   * RIGHT: the note saves, `rebuildStagedTrade` re-prices, parent = Σ legs — what
   * this case now asserts through both doors.
   */
  it("FIXED · a notes-only save lands on a staged parent whose weighted-average price does not round exactly (the refusal is decided by the patch, not by a recomputed buyValue)", async () => {
    freezeAt("2026-08-20T09:30:00.000Z");
    selectAccount(H7_NOTE);
    const id = insertTrade({
      accountId: H7_NOTE, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "H7NOTE", tradingsymbol: "H7NOTE",
      buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1, isOpen: true, mtfFundedAmount: 7500,
    });
    expect(staged.convertToStaged(id).ok).toBe(true);
    expect(staged.addLeg({ tradeId: id, kind: "entry", tradeDate: "2026-08-10", qty: 50, price: 110 }).ok).toBe(true);
    const ladder = row(id)!;
    expect([ladder.buyQty, ladder.buyValue, r2(ladder.buyQty * ladder.avgBuyPrice)], "the parent's roll-up is not its own average × quantity").toEqual([
      150, 15500, 15499.5,
    ]);
    // Observed today, for BOTH doors: [false, "This is a staged position built
    // from more than one fill, … Nothing was changed."], `notes` unchanged.
    const direct = importer.updateManualTrade(id, { notes: "a note, nothing else" });
    expect([direct.ok, direct.message], "a patch that sends nothing but a note").toEqual([true, "Trade updated."]);
    const saved = await actions.updateTradeAction(NO_STATE, editorForm(H7_NOTE, id, { notes: "typed in the dialog" }));
    expect([saved.ok, saved.message], "…and the dialog's own save of the same note").toEqual([true, "Trade updated."]);
    expect(row(id)!.notes, "the note is what the user typed").toBe("typed in the dialog");
  });

  it("a STATED 3,000 is apportioned across the tranches, so the ladder bills exactly what the job bills on the whole leg — and a charge-input patch is refused", async () => {
    freezeAt("2026-08-20T09:30:00.000Z");
    selectAccount(H7_STATED);
    // Two entry tranches on the SAME day, 2,000 + 1,000 of value, against a
    // stated principal of 3,000: Σ of the tranche shares must be the principal,
    // so the ladder's total interest is exactly the FLAT job's on one 3,000 row
    // over the same span. Billing the whole stated amount on each tranche (the
    // rejected alternative) doubles it.
    const ladder = insertTrade({
      accountId: H7_STATED, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "H7STATED", tradingsymbol: "H7STATED",
      buyQty: 30, avgBuyPrice: 100, buyValue: 3000, buyDate: "2026-08-01", buyOrderCount: 1, isOpen: true, mtfFundedAmount: 3000,
    });
    const conv = staged.convertToStaged(ladder);
    expect(conv.ok, JSON.stringify(conv.problems)).toBe(true);
    // The first tranche carries the whole 30; split it by adding a second entry
    // on the same day and shrinking the first through the ladder's own door.
    const legs = staged.loadLegs(ladder);
    const upd = staged.updateLeg(legs[0]!.id, { qty: 20, price: 100, tradeDate: "2026-08-01" });
    expect(upd.ok, JSON.stringify(upd.problems)).toBe(true);
    const add = staged.addLeg({ tradeId: ladder, kind: "entry", tradeDate: "2026-08-01", qty: 10, price: 100 });
    expect(add.ok, JSON.stringify(add.problems)).toBe(true);
    const rebuilt = staged.rebuildStagedTrade(ladder, undefined, "2026-08-20");
    expect(rebuilt.ok, JSON.stringify(rebuilt.problems)).toBe(true);
    const ladderInterest = row(ladder)!.mtfInterest;

    // The FLAT control: one row, the same principal, the same span, priced by
    // the job — the other door of the same rule.
    const flat = insertTrade({
      accountId: H7_STATED, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "H7FLAT", tradingsymbol: "H7FLAT",
      buyQty: 30, avgBuyPrice: 100, buyValue: 3000, buyDate: "2026-08-01", buyOrderCount: 1, isOpen: true, mtfFundedAmount: 3000,
    });
    accrual.accrueMtfInterest("2026-08-20");
    const jobInterest = row(flat)!.mtfInterest;
    // THE assertion (on revert of lib/queries/staged.ts: the ladder bills the
    // margin-config estimate — 75% of each tranche's value — and the two doors
    // state two different answers for one rule).
    expect([ladderInterest > 0, ladderInterest], "the ladder's Σ shares IS the stated principal").toEqual([true, jobInterest]);
    expect(parentVsLegs(ladder)[0], "parent = Σ legs").toBe(parentVsLegs(ladder)[1]);
    // The job is idempotent over the staged row and never patches it alone.
    const second = accrual.accrueMtfInterest("2026-08-20");
    expect(row(ladder)!.mtfInterest, "a second run of the same day moves nothing").toBe(ladderInterest);
    expect(second.updated, "…and reports nothing updated").toBe(0);

    // D20's other half: a patch that MOVES a charge input on a staged row is
    // refused — its quantities, prices and dates ARE its fills.
    const before = row(ladder)!;
    const patched = importer.updateManualTrade(ladder, { avgBuyPrice: 105 });
    expect(patched.ok, "the flat engine never prices a staged parent").toBe(false);
    expect(patched.message, "…and says where the fill is edited").toContain("staged position built from more than one fill");
    expect(row(ladder), "nothing was written").toEqual(before);
  });
});

// ============================================================================
// H8 — mtfFundedStated / mtfDashReason (positions.ts, D8/D9) ↔ /equity's KPI
//      face and dialog ↔ /targets' MtfSummary ↔ the Live Desk's paise
// ============================================================================

describe("H8 · one figure and one reason per row (deriveOpenPositions → /equity's face and dialog, /targets' MtfSummary, load-desk's payload)", () => {
  beforeAll(async () => {
    await fixHModules();
    TrackerClient = (await import("@/components/trackers/tracker-client")).TrackerClient;
    equityPage = (await import("@/app/equity/page")).default as () => unknown;
    targetsPage = (await import("@/app/targets/equity/page")).default as () => unknown;
  }, 60_000);

  it("two partly sold rows that RECORD their funding are the face's figure, the unpriced one beside them is counted and named — the same reason on /equity, /targets and the desk", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    // Each row: bought 100 @200 (20,000), 40 sold — partly sold, so its OWN
    // capital is unstatable while its FUNDED amount is stated (Q-B keeps
    // accruing on the whole leg).
    for (const sym of ["H8PART1", "H8PART2"]) {
      insertTrade({
        accountId: H8_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: sym, tradingsymbol: sym,
        buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-01", buyOrderCount: 1,
        sellQty: 40, avgSellPrice: 210, sellValue: 8400, sellDate: "2026-09-01", sellOrderCount: 1,
        mtfFundedAmount: 16000, mtfInterest: 138, isOpen: true, closingPrice: 205, markedAt: "2026-09-08",
      });
    }
    const unpriced = insertTrade({
      accountId: H8_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "H8UNP", tradingsymbol: "H8UNP",
      buyQty: 50, avgBuyPrice: 100, buyValue: 5000, buyDate: "2026-08-01", buyOrderCount: 1,
      sellQty: 20, avgSellPrice: 105, sellValue: 2100, sellDate: "2026-09-01", sellOrderCount: 1,
      isOpen: true, closingPrice: 102, markedAt: "2026-09-08",
    });
    selectAccount(H8_ACC);

    // CONSUMER 1 — /equity's own props, and the helpers the tracker reads.
    const el = findElem(equityPage(), (e) => e.type === TrackerClient);
    if (!el) throw new Error("the equity page no longer renders <TrackerClient>");
    const positions = (el.props.positions as import("@/lib/analytics/positions").OpenPosition[]).filter((p) => p.isMtf);
    expect(positions.length, "three MTF rows").toBe(3);
    const stated = positionsLib.mtfFundedStated(positions);
    const ownCap = positionsLib.ownCapitalTotal(positions);
    // THE assertion (on revert of lib/analytics/positions.ts + the tracker: the
    // face read `ownCapitalTotal.funded`, which skips every row whose OWN
    // capital is unstatable — so this book's headline KPI read "MTF funded ₹0"
    // while the cells below it printed 16,000 and /targets stated 32,000).
    expect([stated.funded, stated.stated, stated.unstated], "the face: what the book records, and how many rows state none").toEqual([32000, 2, 1]);
    expect(ownCap.funded, "…while the own-capital subset deliberately states nothing here").toBe(0);
    // D9 — one reason per row, the one the user can act on.
    const dashOf = (id: number) => positionsLib.mtfDashReason(positions.find((p) => p.id === id)!);
    expect(dashOf(unpriced), "an unrecorded funded amount is the reason, ahead of the shape").toBe("unpriced");
    expect(positions.filter((p) => p.id !== unpriced).map((p) => positionsLib.mtfDashReason(p)), "a row that STATES its funding reports its shape").toEqual([
      "partlySold", "partlySold",
    ]);
    expect(ownCap.unstatedWhy, "and the tally counts the recordable reason").toEqual({ partlySold: 2, overSold: 0, sellToOpen: 0, unpriced: 1 });
    expect(positionsLib.interestOnWholeLeg(positions.find((p) => p.id === unpriced)!), "an unpriced row accrues nothing, so it carries no Q-B caveat").toBe(false);

    // CONSUMER 2 — the KPI face and its dialog, RENDERED by the real component.
    const html = renderToStaticMarkup(React.createElement(TrackerClient, el.props as never));
    const faceAt = html.indexOf("MTF funded");
    expect(faceAt, "the face is on the screen").toBeGreaterThan(-1);
    const face = html.slice(faceAt, faceAt + 1400);
    // The card prints the ₹ in its own span, so the figure is matched on its own.
    expect(face, "the face states the ₹32.0K the book records").toContain("32.0K");
    expect(face, "…as rupees").toContain("₹");
    expect(face, "…and says how many rows state none, beside it").toContain("1 row states no funding");
    // The KPI dialog's three money rows are inside a Radix layer that a static
    // render does not open (and this suite has no jsdom), so the dialog is pinned
    // where it is WIRED: the face and the Broker-funded row read the same helper,
    // and each row states the set it is over — the recorded D8 deviation.
    const trackerSrc = stripComments(readSource("components/trackers/tracker-client.tsx"));
    expect(trackerSrc, "the face reads the funding the book records").toContain("valueNum={mtfFunded.funded}");
    expect(trackerSrc, "…which is the ONE helper /targets reads").toContain("mtfFundedStated(positions)");
    expect(trackerSrc, "and never the own-capital subset again").not.toMatch(/const mtfFunded = ownCap\.funded/);
    expect(trackerSrc, "the Broker-funded row is the same figure, and says its set").toContain('{ label: "Broker-funded", value: inr(mtfFunded.funded, { decimals: 0 })');
    expect(trackerSrc, "…as n of m").toContain("every MTF row that states funding — ${mtfFunded.stated} of ${mtfFunded.stated + mtfFunded.unstated}");
    expect(trackerSrc, "and the leverage row states its own, different inputs").toContain("over the ${ownCap.stating} ${ownCap.stating === 1 ? \"row\" : \"rows\"} that state own capital");

    // CONSUMER 3 — /targets' MTF card: the same helper, so one figure.
    const card = findElem(targetsPage(), (e) => !!(e.props as { mtf?: { unstated?: number } }).mtf);
    const mtf = (card?.props as { mtf: { count: number; funded: number; unstated: number } }).mtf;
    expect([mtf.count, mtf.funded, mtf.unstated], "/targets and /equity state ONE figure for one book").toEqual([3, stated.funded, 1]);

    // CONSUMER 4 — the Live Desk, where the value crosses into PAISE and the
    // reason becomes a sentence.
    const desk = await (await import("@/components/live/load-desk")).loadLiveDesk({ pro: true });
    const deskRow = (sym: string) => desk.rows.find((r) => r.symbol === sym)!;
    expect([deskRow("H8PART1").mtf?.fundedP, deskRow("H8PART1").mtf?.ownCapitalP], "a stated amount is exact paise, own capital unstatable").toEqual([1600000, null]);
    expect([deskRow("H8UNP").mtf?.fundedP, deskRow("H8UNP").mtf?.unstated], "the unpriced row carries nothing, with its shape verbatim").toEqual([null, "partlySold"]);
    // THE assertion (on revert of components/live/tracker-client.tsx: the desk
    // reads the SHAPE alone and tells a row with no recorded funding that "the
    // stored funding covers the whole original leg" — about funding it has not
    // got, beside a dash).
    const deskSrc = stripComments(readSource("components/live/tracker-client.tsx"));
    expect(deskSrc, "the desk's two note sites read the one predicate").toContain("mtfNoteFor(row.mtf)");
    expect(deskSrc, "…which is mtfDashReason").toContain("mtfDashReason({ isMtf: true, fundedAmount: mtf.fundedP");
    expect(deskSrc, "and the Q-B label is the same predicate /equity reads").toContain("mtfWholeLegNote(row.mtf)");
    expect(deskSrc, "no site reads the shape alone any more").not.toMatch(/MTF_UNSTATED_NOTE\[row\.mtf\.unstated/);
  });
});

// ============================================================================
// H9 — CompareTrade.fundedAmount (broker-compare/page.tsx, D11) ↔ every broker
//      total, the cheapest pick and the savings headline (broker-compare.ts)
// ============================================================================

describe("H9 · a margin_config edit moves nothing on /reports/broker-compare for a row that states no funded amount (the page → compareBrokers → every column, cheapest and maxSaving)", () => {
  beforeAll(async () => {
    await fixHModules();
    marginRoute = await import("@/app/api/margin/route");
    brokerComparePage = (await import("@/app/reports/broker-compare/page")).default as () => unknown;
  }, 60_000);

  it("every printed string on the report is byte-identical at 20% and at 50% own margin, and the omission is stated once", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    // A CLOSED MTF round trip the journal never priced, beside a delivery trade
    // so the report has something it CAN price either way.
    insertTrade({
      accountId: H9_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "H9MTF", tradingsymbol: "H9MTF",
      buyQty: 100, avgBuyPrice: 200, buyValue: 20000, buyDate: "2026-08-01", buyOrderCount: 1,
      sellQty: 100, avgSellPrice: 210, sellValue: 21000, sellDate: "2026-09-01", sellOrderCount: 1,
      grossPnl: 1000, chargesTotal: 30, netPnl: 970, isOpen: false,
    });
    insertTrade({
      accountId: H9_ACC, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: "H9EQ", tradingsymbol: "H9EQ",
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-08-01", buyOrderCount: 1,
      sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-09-01", sellOrderCount: 1,
      grossPnl: 500, chargesTotal: 20, netPnl: 480, isOpen: false,
    });
    selectAccount(H9_ACC);
    const marginRow = () => t.db.select().from(t.schema.marginConfig).all().find((r) => r.broker === "zerodha" && r.segment === "eq_mtf");
    const seeded = marginRow();
    expect(seeded, "the seed carries an eq_mtf own-margin for zerodha").toBeTruthy();

    /** Every string the report prints, in order — the page's own output. */
    const printed = () => textLeaves(brokerComparePage());
    const before = printed();
    const sentence = before.filter((s) => s.includes("state no funded amount") || s.includes("states no funded amount"));
    // D11's disclosure half (invariant 6): said ONCE, and it names the row count.
    expect(sentence, "the omission is stated once, and counts the rows").toEqual([
      "1 MTF trade states no funded amount — no financing cost is included for it in any column.",
    ]);
    expect(before.some((s) => /estimat/i.test(s)), "and nothing on the page claims an estimate").toBe(false);

    try {
      const res = await marginRoute.POST(json("/api/margin", { broker: "zerodha", segment: "eq_mtf", marginPct: 50 }));
      expect([res.status, ((await res.json()) as { ok: boolean }).ok], "the real settings door moved the rate").toEqual([200, true]);
      expect(marginRow()!.marginPct, "margin_config really says 50 now").toBe(50);
      // THE assertion (on revert of app/reports/broker-compare/page.tsx to HEAD:
      // `?? defaultMtfFundedAmount(buyValue, margin_config)` estimates 16,000 at
      // 20% and 10,000 at 50%, and `compareBrokers` folds that interest into
      // every broker's total — so "vs recorded", the cheapest pick and the
      // "Headroom to save" headline all move when the margin table moves).
      expect(printed(), "a rate the journal never applied cannot move a figure on this report").toEqual(before);
    } finally {
      // The rate row is shared by every case in this FILE (one temp database):
      // restored here, not at the end of the `it`, so a failure above cannot
      // turn one real red into a cascade of money reds (seams#2, wave 2N).
      await marginRoute.POST(json("/api/margin", { broker: "zerodha", segment: "eq_mtf", marginPct: seeded!.marginPct }));
    }
    expect(marginRow()!.marginPct, "and the file's own rate is back").toBe(seeded!.marginPct);
  });
});

// ============================================================================
// H10 — the DAY a stored sale states (ipo-link.ts dayOf, D13) ↔ the real /ipos
//       route's refusal gates and its sync
// ============================================================================

describe("H10 · a 4.2.x legacy pair (the SAME day-first string in ipos.exit_date and trades.sell_date) through POST /api/ipos", () => {
  beforeAll(async () => {
    await fixHModules();
    ipoLink = await import("@/lib/analytics/ipo-link");
    ipoRoute = await import("@/app/api/ipos/route");
    ipoQueries = await import("@/lib/queries/ipos");
  }, 60_000);

  it("an exit-PRICE correction saves and syncs (200), writes the day the record states, and keeps the holding's own stated charges", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    selectAccount(H10_ACC);
    const held = insertTrade({
      accountId: H10_ACC, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: "H10LEG", tradingsymbol: "H10LEG",
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1,
      // v4.2.0 wrote the record's own day-first string onto the holding verbatim.
      sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "20-02-2026", sellOrderCount: 1,
      grossPnl: 500, chargesTotal: 2.06, sttCtt: 2, netPnl: 497.94, isOpen: false,
      acquisition: "ipo", acquisitionPrice: 100, acquisitionDate: "2019-01-10",
    });
    const record = t.db
      .insert(t.schema.ipos)
      .values({ accountId: H10_ACC, name: "H10LEG", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "20-02-2026", allotmentDate: "2019-01-10", tradeId: held })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;

    // THE PRODUCER, on its own: the record's folded day against the holding's raw
    // one. On revert of lib/analytics/ipo-link.ts the compare is a raw string
    // compare, the pairing answers "refuse", and the route below is a 409.
    const linkInput = { appliedPrice: 100, allottedQty: 10, allotted: true, listingPrice: 130, exitPrice: 150, exitDate: "2026-02-20", allotmentDate: "2019-01-10" };
    const stored = { ...linkInput, exitDate: "20-02-2026" };
    const tradeLeg = { sellQty: 10, avgSellPrice: 150, sellDate: "20-02-2026" };
    expect(ipoLink.sellLegIsIpoExit(linkInput, tradeLeg), "one calendar on BOTH sides of the sale").toBe(true);
    expect(ipoLink.linkedSyncFor({ stored, next: { ...linkInput, exitPrice: 160 }, trade: tradeLeg }), "so the save is the sync's to make").toBe("sync");

    // THE CONSUMER: the real route, with the form's own payload (the stored day
    // sent back unseen, as IpoForm.save() sends it).
    const body = {
      id: record, name: "H10LEG", broker: "zerodha", exchange: "NSE", board: "mainboard", category: "", discountPerShare: "",
      appliedPrice: "100", lotSize: "10", lotsApplied: "1", allotted: true, allottedQty: 10, listingPrice: "130",
      exitPrice: "160", appliedDate: "", allotmentDate: "2019-01-10", listingDate: "", exitDate: "20-02-2026", notes: "",
    };
    const res = await ipoRoute.POST(json("/api/ipos", body));
    const answer = (await res.json()) as { ok: boolean; message?: string };
    // THE assertion (HEAD: 409 "The linked holding has a sale recorded in
    // Trades…"; with the pairing folded but not `syncWritesSellDate`: 400 "The
    // exit date must be a real calendar day…", over a day the holding carries).
    expect([res.status, answer.ok], answer.message ?? "").toEqual([200, true]);
    const after = row(held)!;
    expect([after.avgSellPrice, after.sellValue, after.grossPnl], "the correction reached the holding").toEqual([160, 1600, 600]);
    // `syncWritesSellDate` compares the two DAYS, so the sync writes the day the
    // record states rather than refusing over a byte difference.
    expect(after.sellDate, "and the holding now states the day, not the keystrokes").toBe("2026-02-20");
    // The record's exit date states no priceable day, so the IPO model prices
    // nothing and every head the holding stated stands (invariant 6).
    expect([after.chargesTotal, after.sttCtt, after.netPnl], "the holding keeps the bill it stated").toEqual([2.06, 2, 597.94]);
    // One sale, one figure, on both surfaces.
    const shown = ipoQueries.getIposComputed().rows.find((r) => r.id === record)!;
    expect(shown.exitPrice, "/ipos states the same exit").toBe(160);
    expect(t.db.select().from(t.schema.ipos).all().find((r) => r.id === record)!.tradeId, "…still linked to the same holding").toBe(held);
    expect(ipoQueries.getIpoTradeLinks().get(held), "and the holding still carries its badge").toBe(record);
  });
});

// ============================================================================
// H11 — ipoEditCharges (ipo.ts, D14/D15) ↔ the PREVIEW route's own door
//       (a Request) ≡ updateManualTrade's save
// ============================================================================

describe("H11 · an allotment-derived row priced through the preview route's own door ≡ the save (ipo.ts#ipoEditCharges read by both)", () => {
  beforeAll(async () => {
    await fixHModules();
    chargesPreview = await import("@/app/api/charges/preview/route");
    editDialog = (await import("@/components/trades/edit-trade-dialog")) as typeof editDialog;
    Dialog = (await import("@/components/ui/dialog")).Dialog;
    EditTradeDialog = editDialog.EditTradeDialog;
  }, 60_000);

  /** The dialog's OWN body over the real route: the ten heads, the total, the net. */
  async function preview(w: WireTrade, f: Record<string, unknown>) {
    const build = exported(editDialog, "editPreviewBody") as ((t: WireTrade, f: unknown) => unknown) | undefined;
    if (typeof build !== "function") throw new Error("the editor builds no preview body");
    const body = build(w, f);
    if (body == null) throw new Error("the editor sends nothing for this row");
    const res = await chargesPreview.POST(json("/api/charges/preview", JSON.parse(JSON.stringify(body))));
    const p = (await res.json()) as { breakdown: Record<string, number>; netPnl: number; keptCharges?: boolean };
    expect(res.status, JSON.stringify(p)).toBe(200);
    return { heads: p.breakdown, netPnl: p.netPnl, kept: p.keptCharges ?? false };
  }
  const HEADS = ["brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty", "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges", "total"] as const;
  const storedHeads = (id: number) => {
    const r = row(id)! as unknown as Record<string, number>;
    return Object.fromEntries(HEADS.map((h) => [h, h === "total" ? r.chargesTotal : r[h]]));
  };

  it("an exit-price correction: the dialog's breakdown is what the save stores, to the paisa, with NO purchase STT", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    selectAccount(H11_ACC);
    const sold = insertTrade({
      accountId: H11_ACC, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: "H11SOLD", tradingsymbol: "H11SOLD",
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", acquisitionDate: "2026-02-20", buyOrderCount: 1,
      sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", sellOrderCount: 1,
      grossPnl: 500, chargesTotal: 2.06, sttCtt: 2, gst: 0.01, exchangeTxn: 0.05, netPnl: 497.94, isOpen: false,
      acquisition: "ipo", acquisitionPrice: 100,
    });
    const w = wireTrade(H11_ACC, sold);
    const moved = { buyQty: 10, avgBuyPrice: 100, sellQty: 10, avgSellPrice: 160, buyDate: "2026-02-20", sellDate: "2026-03-02", ownCapitalUsed: null };
    const shown = await preview(w, moved);
    const saved = importer.updateManualTrade(sold, { avgSellPrice: 160 });
    expect(saved.ok, saved.message).toBe(true);
    // THE assertion (on revert of app/api/charges/preview/route.ts: the
    // fall-through prices `computeCharges`, a delivery ROUND TRIP — sttCtt 3
    // against the row's 2, charges 18.43 against 17.40 — so the user approves a
    // figure the save does not store, over ruling row (1)'s purchase STT).
    expect(shown.heads, "the dialog shows the bill the save will store").toEqual(storedHeads(sold));
    expect([shown.heads.sttCtt, shown.kept], "the sale's STT alone, priced fresh").toEqual([2, false]);
    expect(shown.netPnl, "…and the same net").toBe(row(sold)!.netPnl);
  });

  it("an OPEN allotment: a notes-only save prices nothing at all — ten heads, the total, the net and importNotes byte-identical, on both doors", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    selectAccount(H11_ACC);
    const open = insertTrade({
      accountId: H11_ACC, broker: "zerodha", bucket: "equity", segment: "eq_delivery", symbol: "H11OPEN", tradingsymbol: "H11OPEN",
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", acquisitionDate: "2026-02-20", buyOrderCount: 1, isOpen: true,
      acquisition: "ipo", acquisitionPrice: 100, importNotes: "Exit charges computed from the linked IPO record.",
    });
    const before = { ...(row(open)! as unknown as Record<string, unknown>) };
    const w = wireTrade(H11_ACC, open);
    const shown = await preview(w, { buyQty: 10, avgBuyPrice: 100, sellQty: 0, avgSellPrice: 0, buyDate: "2026-02-20", sellDate: "", ownCapitalUsed: null });
    // THE assertion (on revert of lib/analytics/ipo.ts / commit.ts: the engine
    // prices the allotment as an exchange PURCHASE — sttCtt 1, chargesTotal 1.04,
    // netPnl −1.04 written the first time the user saves a NOTE on it, money the
    // journal fabricates).
    expect([shown.heads.sttCtt, shown.heads.total, shown.kept], "an un-exited allotment is priced at nothing, and the preview says whose figure it is").toEqual([0, 0, true]);
    const saved = importer.updateManualTrade(open, { notes: "just a note" });
    expect(saved.ok, saved.message).toBe(true);
    const after = row(open)! as unknown as Record<string, unknown>;
    for (const h of HEADS) expect(after[h === "total" ? "chargesTotal" : h], `${h} is byte-identical`).toEqual(before[h === "total" ? "chargesTotal" : h]);
    expect([after.netPnl, after.importNotes], "the net and the sync's own marker stand").toEqual([before.netPnl, before.importNotes]);
    expect(after.notes, "…and the note really was saved").toBe("just a note");
    expect(shown.heads.total, "preview ≡ save for the no-sale branch too").toBe(row(open)!.chargesTotal);
  });
});

// ============================================================================
// H12 — storedDateProblem (trading-day.ts) ↔ updateManualTrade's refusal (D17)
//       ↔ updateTradeAction ↔ the editor dialog's own sentence off the wire row
// ============================================================================

describe("H12 · the third writer of one rule (updateManualTrade → app/trades/actions.ts updateTradeAction → the editor's own guard on the same wire row)", () => {
  beforeAll(async () => {
    await fixHModules();
    editDialog = (await import("@/components/trades/edit-trade-dialog")) as typeof editDialog;
    Dialog = (await import("@/components/ui/dialog")).Dialog;
    EditTradeDialog = editDialog.EditTradeDialog;
  }, 60_000);

  it("a price patch on a row whose STORED buy date states no day is refused with the one sentence, nothing is written, and the dialog says the same thing before it is pressed", async () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    const { storedDateProblem } = await import("@/lib/domain/trading-day");
    selectAccount(H12_ACC);
    const bad = insertTrade({
      accountId: H12_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "H12BAD", tradingsymbol: "H12BAD",
      buyQty: 100, avgBuyPrice: 160, buyValue: 16000, buyDate: "9999-99-99", buyOrderCount: 1, mtfFundedAmount: 12000,
      sellQty: 100, avgSellPrice: 170, sellValue: 17000, sellDate: "2026-09-01", sellOrderCount: 1,
      grossPnl: 1000, chargesTotal: 40, netPnl: 960, isOpen: false,
    });
    const before = row(bad)!;
    const sentence = storedDateProblem(before)!;
    expect(sentence, "the rule names the column and where to fix it").toContain("stored buy date “9999-99-99” is not a real calendar day");

    // WRITER 3 — the editor's save. THE assertion (on revert of
    // lib/import/commit.ts: `daysHeld` counts from an Invalid Date, NaN reaches
    // computeCharges and the write dies with `NOT NULL constraint failed:
    // trades.charges_total_paise` — a 500 where the other two writers answer).
    const refused = importer.updateManualTrade(bad, { avgSellPrice: 175 });
    expect([refused.ok, refused.message], "refused before anything is priced").toEqual([false, sentence]);
    expect(row(bad), "nothing was written").toEqual(before);

    // …and through the real server action, which is what the dialog calls. Its
    // form re-posts the stored value, so the SENT-value guard answers first —
    // the two sentences are deliberately different (there IS a field in front of
    // this user), and both refuse before anything is priced.
    const viaAction = await actions.updateTradeAction(NO_STATE, editorForm(H12_ACC, bad, { avgSellPrice: "175" }));
    const { unreadableDateMessage } = await import("@/lib/domain/trading-day");
    expect([viaAction.ok, viaAction.message], "the action refuses too, in the words of the door the user is at").toEqual([
      false, unreadableDateMessage("buy date", "9999-99-99"),
    ]);
    expect(row(bad), "still nothing").toEqual(before);

    // READER — the dialog, off the WIRE row (/trades' RSC payload is JSON): the
    // same rule, before the button is pressed.
    const w = wireTrade(H12_ACC, bad);
    expect([w.buyDate, w.sellDate], "the wire carries the stored value as stored").toEqual(["9999-99-99", "2026-09-01"]);
    expect(storedDateProblem(w), "the dialog states what the save would refuse").toBe(sentence);
    const problem = exported(editDialog, "editDateProblem") as ((b: string | null, s: string | null) => string | null) | undefined;
    expect(typeof problem, "and the dialog's own date guard is exported for it").toBe("function");
    expect(problem!(w.buyDate, w.sellDate), "…and it refuses the same pair, so no preview is built").toBeTruthy();

    // Once the stored date states a day, the same patch prices normally.
    t.db.update(t.schema.trades).set({ buyDate: "2026-08-01" }).where(eq(t.schema.trades.id, bad)).run();
    const ok = importer.updateManualTrade(bad, { avgSellPrice: 175 });
    expect([ok.ok, row(bad)!.avgSellPrice], ok.message).toEqual([true, 175]);
    expect(row(bad)!.mtfInterest > 0, "and a real day bills the real days").toBe(true);
  });
});

// ============================================================================
// H13 — CrossSourceCollision.row (cross-source.ts, D18) ↔ the pull route's 409
//       ↔ broker-connect.tsx's card list and its copy
// ============================================================================

describe("H13 · two DIFFERENT incoming rows of one scrip that agree on every incoming figure (the 409's collisions → collisionRows / dialogCollisions / collisionDialogCopy)", () => {
  beforeAll(async () => {
    await fixHModules();
    brokerRoute = await import("@/app/api/import/broker/route");
    crossSource = await import("@/lib/import/cross-source");
    bc = (await import("@/components/import/broker-connect")) as typeof bc;
  }, 60_000);

  const clientOf = (accountId: number) => `13000${accountId}`;
  const alive = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  const position = (accountId: number, symbol: string, productType: string, buyQty: number, buyAvg: number) => ({
    dhanClientId: clientOf(accountId), tradingSymbol: symbol, positionType: "LONG", exchangeSegment: "NSE_EQ", productType, buyAvg, buyQty, sellAvg: 0, sellQty: 0, netQty: buyQty,
  });
  const stub = (positions: unknown[]) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      const body = u.host === "auth.dhan.co" ? { accessToken: alive() } : u.pathname === "/v2/positions" ? positions : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });

  it("two rows are two cards, each with its own blocker, and the copy counts the rows the server counted", async () => {
    freezeAt("2026-09-08T06:30:00.000Z"); // 12:00 IST
    selectAccount(H13_ACC);
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, NULL)")
      .run(H13_ACC, clientOf(H13_ACC), alive());
    // The stored row an EARLIER file recorded: 15 shares of one scrip.
    const earlier = importer.commitParsedFile(
      parsed([trade({ tradingsymbol: "H13TWO", buyQty: 15, avgBuyPrice: 100, buyValue: 1500, buyDate: "2026-09-01" })]),
      "H13-earlier-file.csv",
      null,
      H13_ACC,
    );
    expect(earlier.added, "the earlier file's row is in the book").toBe(1);
    const stored = rowsOf(H13_ACC).at(-1)!;

    // ONE pull, TWO incoming rows of that scrip: the same quantity and the same
    // value under two PRODUCTS — every one of the five values the dialog used to
    // key a card on is identical, and they are still two different rows.
    stub([position(H13_ACC, "H13TWO", "CNC", 15, 100), position(H13_ACC, "H13TWO", "MTF", 15, 100)]);
    const res = await brokerRoute.POST(json("/api/import/broker", { action: "pull", broker: "dhan", accountId: H13_ACC, mode: "commit" }));
    const body = (await res.json()) as { needsForce?: boolean; message: string; collisions?: ({ symbol: string; row?: number; kind: string } & Record<string, unknown>)[] };
    expect([res.status, body.needsForce], body.message).toEqual([409, true]);
    const collisions = body.collisions ?? [];
    // THE assertion (on revert of lib/import/cross-source.ts: `row` is absent, so
    // `collisionRowKey` falls back to symbol + the four figures — identical for
    // both — and TWO refused rows collapse into ONE card reading "…cannot vouch
    // for this row." beside a server sentence that counts two).
    expect(collisions.map((c) => [c.symbol, c.row]), "the server states WHICH incoming row each blocker is about").toEqual([
      ["H13TWO", 0], ["H13TWO", 1],
    ]);
    expect(row(stored.id), "and nothing was written").toEqual(stored);

    // CONSUMER 1 — the dialog's own list.
    const listed = bc.dialogCollisions(collisions);
    expect(listed.length, "two incoming rows are two cards").toBe(2);
    expect(listed.every((c) => (c.also ?? []).length === 0), "each card carries its own single blocker").toBe(true);
    expect(bc.collisionRows(collisions).length, "…and the row grouping agrees").toBe(2);

    // CONSUMER 2 — the copy, which counts ROWS and now says what the server says.
    const copy = bc.collisionDialogCopy({ collisions, message: body.message });
    expect(copy.description.endsWith("cannot vouch for these rows."), copy.description).toBe(true);
    // The sentence the dialog prints directly above those cards: it counted two
    // rows while the card list counted one, which is the finding.
    expect(body.message, "the server's own sentence counts two rows").toContain("2 rows in this file (H13TWO)");

    // F45's shape is unchanged by the index: ONE row with TWO blockers is still
    // ONE card with the second beside it (a `row` both blockers share).
    const oneRowTwoBlockers = [
      { ...collisions[0]!, row: 7, kind: "earlier-snapshot", sameSnapshot: true },
      { ...collisions[0]!, row: 7, kind: "same-quantity" },
    ];
    const grouped = bc.dialogCollisions(oneRowTwoBlockers);
    expect([grouped.length, (grouped[0]!.also ?? []).length], "one row, two blockers, one card").toEqual([1, 1]);
    expect(bc.collisionDialogCopy({ collisions: oneRowTwoBlockers, message: "" }).description.endsWith("cannot vouch for this row."), "and the singular copy").toBe(true);
  });
});

// ============================================================================
// H14 — collisionsToList's ROW budget (cross-source.ts, D19) ↔ the import
//       preview's own list, through the real file-preview door
// ============================================================================

describe("H14 · thirty colliding rows of ONE symbol through the real file preview (previewParsedFile → collisionsToList → the two tails the card renders)", () => {
  beforeAll(async () => {
    await fixHModules();
    crossSource = await import("@/lib/import/cross-source");
    fileRoute = await import("@/app/api/import/route");
  }, 60_000);

  it("the list is bounded in LINES again: 12 rows of the one symbol, the elided rows counted separately from the unlisted symbols", async () => {
    freezeAt("2026-09-08T06:30:00.000Z");
    selectAccount(H14_ACC);
    // The stored row an earlier file recorded, and THIRTY incoming rows of the
    // same scrip on thirty different days — the shape a tradebook of one scrip
    // stated day by day really has. Each collides with the stored row (the same
    // quantity), and a file import can never produce two blockers for one row
    // (`app/api/import/route.ts` previews with no supersede snapshot).
    const earlier = importer.commitParsedFile(
      parsed([trade({ tradingsymbol: "H14ONE", buyQty: 5, avgBuyPrice: 100, buyValue: 500, buyDate: "2026-07-01" })]),
      "H14-earlier-file.csv",
      null,
      H14_ACC,
    );
    expect(earlier.added).toBe(1);
    const incoming = Array.from({ length: 30 }, (_, i) =>
      trade({ tradingsymbol: "H14ONE", buyQty: 5, avgBuyPrice: 100, buyValue: 500, buyDate: `2026-08-${String(i + 1).padStart(2, "0")}` }),
    );
    const pre = importer.previewParsedFile(parsed(incoming), null, H14_ACC, "H14-new-file.csv");
    const collisions = pre.crossSource?.collisions ?? [];
    expect([collisions.length, new Set(collisions.map((c) => c.symbol)).size], "thirty blocked rows, one symbol").toEqual([30, 1]);

    // THE assertion (on revert of lib/import/cross-source.ts: every entry of a
    // listed symbol was kept, so the card rendered THIRTY `<li>`s with `more 0`
    // — unbounded, where the pre-W2N `slice(0, 6)` showed six and a tail).
    const list = crossSource.collisionsToList(collisions);
    expect([list.rows.length, list.more, list.truncated], "12 lines, no symbol left out, 18 rows elided").toEqual([12, 0, 18]);
    expect(new Set(list.rows.map((c) => c.symbol)).size, "…all of them the one symbol").toBe(1);
    // …and the other shape, unchanged: symbols capped at six, `more` counting
    // SYMBOLS (F45's own numbers, re-asserted under the row budget).
    const eight = [
      ...[0, 1].map((i) => ({ ...collisions[i]!, symbol: "H14A" })),
      ...["B", "C", "D", "E", "F", "G"].map((s) => ({ ...collisions[0]!, symbol: `H14${s}` })),
    ];
    const capped = crossSource.collisionsToList(eight);
    expect([new Set(capped.rows.map((c) => c.symbol)).size, capped.rows.length, capped.more, capped.truncated], "F45's [6, 7, 1] still holds").toEqual([6, 7, 1, 0]);

    // The REAL file-preview door carries the same collisions into the client's
    // own props (the route returns them verbatim).
    const fd = new FormData();
    fd.append("mode", "preview");
    fd.append("accountId", String(H14_ACC));
    fd.append("file", new File([fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "dhan-gtr.csv"))], "Dhan_GlobalTransction_Report.csv", { type: "text/csv" }));
    const res = await fileRoute.POST(new Request("http://localhost/api/import", { method: "POST", body: fd }));
    const json = (await res.json()) as { mode?: string; preview?: { crossSource?: { collisions?: unknown[] } } };
    expect([res.status, json.mode], "the preview door answers").toEqual([200, "preview"]);
    expect(Array.isArray(json.preview?.crossSource?.collisions ?? []), "and ships the collisions as plain JSON for the client's own list").toBe(true);

    // The card renders BOTH tails — the symbols not listed, and the rows of a
    // listed symbol elided. (The panel's list is built from the client's own
    // fetch state, so this is its source: no jsdom in this suite.)
    const src = stripComments(readSource("components/import/import-client.tsx"));
    expect(src, "the elided rows are counted for the user").toContain("crossList.truncated > 0");
    expect(src, "…beside the unlisted symbols").toContain("crossList.more > 0");
  });
});
