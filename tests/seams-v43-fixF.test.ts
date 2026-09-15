import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import { todayIstIso } from "@/lib/domain/trading-day";

/**
 * v4.3.0 FIX WAVES 2I + 2J — THE SEAMS OF AN ELEVEN-BUILDER PAIR OF WAVES.
 *
 * Wave 2I (I1 MTF readers + the close preview; I2 trash restore / merge / the
 * unstated-price guard / the DQ reader; I3 the M1 copy; I4 the IPO lifecycle;
 * I5 the merge carry; I6 the ISIN compare) and wave 2J (J1 the named Clear; J2
 * the account-delete ipoRefs; J3 the IPO re-home data fix; J4 the sync's
 * charges; J5 a pin) owned DISJOINT files. This file runs the two real halves
 * of every value that crosses from one builder's files into another's.
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The stubs are framework and
 * transport only: `next/cache`, `next/navigation` and `globalThis.fetch` for
 * api.dhan.co. A client form's request is built from its OWN server render.
 *
 * ── THE SEAM TABLE ───────────────────────────────────────────────────────────
 *
 *  #  | crossing value                          | producer (file:line, builder)                       | consumer (file:line, builder)                            | unit / shape                     | test
 * ----|-----------------------------------------|-----------------------------------------------------|----------------------------------------------------------|----------------------------------|-----
 *  F1 | a STORED mtf funded amount of 0         | lib/import/commit.ts:1710 updateManualTrade (2H) ←  | lib/analytics/positions.ts:128 deriveOpenPositions (I1)   | ₹ (rupees at runtime); 0 ≠ null  | F1 a/b
 *     |   (100% own capital)                    |   app/trades/actions.ts:49 ownCapital (FormData "0")  |   → app/equity/page.tsx:41 → TrackerClient props;         |                                  |
 *     |                                         |                                                      |   app/reports/broker-compare/page.tsx:59 (I1) MTF int.;   |                                  |
 *     |                                         |                                                      |   lib/analytics/data-quality.ts:892 mtf_funding (I2)      |                                  |
 *  F2 | the close dialog's preview body with    | components/trades/close-trade-dialog.tsx:33          | app/api/charges/preview/route.ts:24 ≡ lib/import/commit   | ₹ JSON numbers; daysHeld an      | F2
 *     |   the exit-date field CLEARED           |   resolveExitIso + :80 daysHeld (I1)                 |   .ts:1927 closePosition (closeTradeAction)               |   integer, never NaN → null      |
 *  F3 | a Trash envelope holding a joined lot   | lib/queries/delete.ts:152 deleteTradesByIds (I4) ←  | lib/trash.ts:518/:530 restore (I2) ← app/api/trash/route  | {ok, restored, skipped}; the DQ  | F3
 *     |   AND the sale its alias names          |   app/trades/actions.ts deleteTradesAction          |   .ts:36 JSON → lib/queries/data-quality.ts:45 section    |   section, deep-equal            |
 *  F4 | a source row whose hash a TARGET lot    | lib/import/commit.ts:2218 withStaleCloseNote ←      | lib/queries/account-delete.ts:295 identityCollisions (I2) | 64-hex hash, case-folded; the    | F4
 *     |   holds (`dedup-alias:`)                |   the close-stale route (the Data Quality join)      |   ≡ lib/trash.ts restore skip (I2) ≡ commit.ts:1313 dedup |   ONE predicate, three readers   |
 *  F5 | a sale that states NO price (0)         | lib/analytics/data-quality.ts:536 statedPrice (I2)   | app/api/data-quality/close-stale/route.ts:22 → commit.ts  | REAL price; 0 = unstated; 409    | F5
 *     |                                         |   → staleOpenPairs `ambiguous`                       |   :2129 closeStaleLot AMBIGUOUS                           |                                  |
 *  F6 | the M1 ask's sentence, counted on the   | lib/import/commit.ts:512 snapshotIds → lib/import/   | app/api/import/broker/route.ts:1105 409 JSON `message`    | text; plural on the STORED rows, | F6
 *     |   STORED rows                           |   cross-source.ts:352 (I3)                           |   (J1) → components/import/broker-connect.tsx:233 (J1)    |   not the incoming ones          |
 *  F7 | a merge-carried record's identity       | lib/import/dhan-unfetched.ts:88 recordKeyOf (I5)     | app/api/import/broker/route.ts:623 named clear (J1) ←    | (null connection, span, fact);   | F7
 *     |   (no connection, span, sentences)      |   → GET `unfetched` + `unfetchedConnection`          |   broker-connect.tsx:149 clearUnfetchedBody (J1)          |   200 / 404                      |
 *  F8 | the account an IPO record is filed in   | app/trades/actions.ts:585 pushTradeToIpoAction (I4)  | lib/queries/ipos.ts:113 getIposComputed join (I4);        | account id; never the schema     | F8
 *     |                                         |                                                      |   app/api/ipos/route.ts:96 inAccount (I4/J4)             |   default 1, never 0             |
 *  F9 | `ipoRefs` in the Trash envelope         | lib/queries/delete.ts:154 (I4) and lib/queries/     | lib/trash.ts:691 the re-link loop → lib/queries/capital   | {ipoId, tradeId}[]; undefined    | F9 a/b
 *     |                                         |   account-delete.ts:562 (J2)                        |   .ts:48, tax-itr.ts:64, app/api/ais/route.ts:64         |   when empty                     |
 * F10 | a legacy IPO row's account              | lib/db/data-fixes.ts:150 applyIpoAccountRehome (J3) | lib/queries/ipos.ts:113 getIposComputed (I4) + the        | account id; the fix is a LEDGER  | F10
 *     |                                         |   ← lib/db/index.ts:58 startup / restore            |   route's scoped write                                    |   row, re-run after a restore    |
 * F11 | whose close a linked holding carries    | lib/analytics/ipo-link.ts:294 syncOwnsClose (J4)     | app/api/ipos/route.ts:236 syncWroteCharges → :277         | boolean; ₹ heads, mtfInterest /  | F11
 *     |                                         |                                                      |   syncLinkedTrade (J4) ← charge_config via computeIpo     |   pledgeCharges never written    |
 * F12 | a stored ISIN, canonicalised            | lib/queries/trades.ts:326 upper(trim(isin)) (I6)     | app/strategies/page.tsx:106 admittingOf (I6) →           | 12-char ISIN, upper + trimmed    | F12
 *     |                                         |                                                      |   StrategiesClient groups → StrategyCard                  |   on BOTH sides                  |
 * F13 | an IPO linked to a trade a merge DROPS  | lib/queries/account-delete.ts:783 merge (K1)        | lib/queries/ipos.ts:161 getIpoRealisedNet → capital.ts    | trade id; re-pointed, never      | F13
 *     |   as a duplicate                        |                                                      |   :48, tax-itr.ts:64, /api/ais                            |   nulled                         |
 *
 * RED ON REVERT (2026-09-15) — 16 probes. Each side's HEAD (4fd527d, the
 * wave-2H tree) copy was aliased over the working module with `vi.mock` inside
 * a deleted tests/zzprobe-fixF-* copy of THIS file, the copy itself a deleted
 * tests/zzseam-head-*.ts (`git show HEAD:<path>`, relative imports rewritten to
 * the @/ alias). No product file was touched. Every probe reddened its own
 * seam's `it` and nothing else:
 *
 *   lib/analytics/positions.ts   → F1 (b) "the /equity tracker reads the stated 0:
 *     expected [ true, 8000, 2000, 10000 ] to deeply equal [ true, +0, 10000, 10000 ]"
 *   lib/analytics/data-quality.ts → F1 (a) "a stated 0 is not a missing figure:
 *     expected [ 1, [ 1 ] ] to deeply equal [ +0, [] ]"; and F5 "a price of 0 never
 *     proves the sale differs: expected [ false, true ] to deeply equal [ true, false ]"
 *   app/reports/broker-compare/page.tsx → F1 (a) "the re-pricing bills no interest on
 *     a stated 0: expected Set{ '₹54', '₹85', '₹99', '₹102', …(3) } to deeply equal Set{ '₹0' }"
 *   components/trades/close-trade-dialog.tsx → F2 "the cleared-date preview is the save:
 *     expected [ 1000, 121.72, 878.28 ] to deeply equal [ 1000, 220.92, 779.08 ]"
 *   lib/trash.ts                 → F3 "Restored 1 trade. 1 could not be restored —
 *     SEAMF3: an identical trade is already in the journal (recorded in the position it
 *     closed). …: expected [ true, 1, [ { id: 5, …(2) } ] ] to deeply equal [ true, 2, [] ]"
 *   lib/queries/account-delete.ts → F4 "Merged “fixF 1706” into “fixF 1705” — 1 trade
 *     moved, 1 duplicate skipped …: expected [ true, 1 ] to deeply equal [ true, 2 ]";
 *     and F13 "the IPO follows its trade to the row that survived: expected [ 1719, null ]
 *     to deeply equal [ 1719, 26 ]"
 *   lib/import/cross-source.ts   → F6 "the remedy counts the STORED rows, not the
 *     incoming ones: expected '1 row in this pull (SEAMF6) restates …' to contain
 *     'the 2 earlier rows can be deleted fro…'"
 *   lib/import/dhan-unfetched.ts → F7 "each book's own outstanding notice is carried:
 *     expected +0 to be 1" (the second carry was never written)
 *   components/import/broker-connect.tsx → F7 "expected [ null, undefined, undefined ]
 *     to deeply equal [ null, …(2) ]" (the Clear body named no sentence)
 *   app/api/import/broker/route.ts → F7 "expected [ [ null, '10:30' ] ] to deeply equal
 *     [ [ null, '14:30' ] ]" — the line the user clicked stayed listed and the OTHER
 *     book's gap was dismissed in its place
 *   app/trades/actions.ts        → F8 "AuditShapeError: recordAudit(trade/update):
 *     before/after key sets differ — only in before: [] only in after: [ipoId]" (the
 *     throw came AFTER the insert and the trade UPDATE, which is why nothing covered it)
 *   lib/queries/delete.ts        → F9 (a) "the restored link: expected null to be 18"
 *   lib/db/data-fixes.ts         → F10 "expected [ 'paytm-dedup-isin-v1' ] to include
 *     'ipo-account-rehome-v1'"
 *   lib/analytics/ipo-link.ts    → F8, F9 (a/b), F11: the route imports `syncOwnsClose`,
 *     so a whole-module revert is a wiring error ("No \"syncOwnsClose\" export is defined
 *     on the … mock") rather than a number. The clean one is the CONSUMER half:
 *   app/api/ipos/route.ts, hand-reverted on a copy to the pre-J4 rule
 *     (`writesCharges = patch.chargesTotal != null && (!heldOwnSale || statesNoCharges)`)
 *     → F11 "the old exit's bill is not left behind: expected 17.06 not to be 17.06"
 *   lib/queries/trades.ts        → F12 "the holding is found where it is held: expected
 *     [ { strikes: '300', …(3) } ] to deeply equal [ { strikes: '300', …(3) } ]" (its own
 *     account read short-call/Unlimited where the card is a covered call)
 *
 * NOT proven red by a revert: F9 (b), the account PURGE. J2's own report says so
 * — the purge's `ipos` rows ride back inside `accountRows.ipos` with `trade_id`
 * intact, so its `ipoRefs` are inert; the case is a standing guard on that
 * branch (and on the merge re-point K1 landed in the same file), not a
 * regression pin. Its consumer half (trash.ts' re-link loop) is proven by F9 (a).
 *
 * SEAM DEFECTS found by a pass are reported to the orchestrator, not fixed here.
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
let trash: typeof import("@/lib/trash");
let deleteQ: typeof import("@/lib/queries/delete");
let dqQueries: typeof import("@/lib/queries/data-quality");
let closeStaleRoute: typeof import("@/app/api/data-quality/close-stale/route");
let trashRoute: typeof import("@/app/api/trash/route");
let chargesPreview: typeof import("@/app/api/charges/preview/route");
let accountDelete: typeof import("@/lib/queries/account-delete");
let ipoQueries: typeof import("@/lib/queries/ipos");
let ipoRoute: typeof import("@/app/api/ipos/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");
let unfetched: typeof import("@/lib/import/dhan-unfetched");
let dhanApi: typeof import("@/lib/import/api/dhan");
let dataFixes: typeof import("@/lib/db/data-fixes");
let crossSource: typeof import("@/lib/import/cross-source");
/** Records, so a builder's export that a revert removes fails ITS assertion, not the file. */
let bc: Record<string, unknown> & typeof import("@/components/import/broker-connect");
let ipoUi: Record<string, unknown> & typeof import("@/components/ipo/ipo-client");
let closeDialog: Record<string, unknown> & typeof import("@/components/trades/close-trade-dialog");
let Dialog: typeof import("@/components/ui/dialog").Dialog;
let EditTradeDialog: typeof import("@/components/trades/edit-trade-dialog").EditTradeDialog;
let CloseTradeDialog: typeof import("@/components/trades/close-trade-dialog").CloseTradeDialog;
let TrackerClient: typeof import("@/components/trackers/tracker-client").TrackerClient;
let StrategiesClient: typeof import("@/components/strategies/strategies-client").StrategiesClient;
let StrategyCard: typeof import("@/components/strategies/strategy-card").StrategyCard;
let ReportTr: typeof import("@/components/ui/report-table").ReportTr;
let ReportTd: typeof import("@/components/ui/report-table").ReportTd;
let equityPage: () => unknown;
let brokerComparePage: () => unknown;
let strategiesPage: () => unknown;

const F1_ZERO = 1701; //  F1: an MTF row whose own capital paid for all of it
const F1_UNSET = 1702; // F1: an MTF row that states nothing
const F2_ACC = 1703; //   F2: the close dialog with its exit date cleared
const F3_ACC = 1704; //   F3: a joined lot and its sale, deleted together
const F4_TGT = 1705; //   F4: the merge target, holding the joined lot
const F4_SRC = 1706; //   F4: the merge source, holding the sale
const F5_ACC = 1707; //   F5: a sale that states no price beside a joined lot
const F6_ACC = 1708; //   F6: two stored rows on two keys, one incoming row
const F7_SA = 1709; //    F7: merge source A (its own last-pull time of day)
const F7_SB = 1710; //    F7: merge source B
const F7_TGT = 1711; //   F7: the merge target, listing both carries
const F8_ACC = 1712; //   F8: the holding whose IPO must not land in account 1
const F9_ACC = 1713; //   F9 (a): a linked holding deleted from /trades
const F9_PURGE = 1714; // F9 (b): a linked holding inside an account purge
const F10_ACC = 1715; //  F10: the holding whose legacy IPO sits in account 1
const F11_ACC = 1716; //  F11: the sync's own close, re-priced
const F12_A = 1717; //    F12: a call with no units of its own
const F12_B = 1718; //    F12: the units, under a lower-case padded ISIN
const F13_TGT = 1719; //  F13: the merge target, holding the surviving copy
const F13_SRC = 1720; //  F13: the merge source, its IPO linked to the duplicate
const ACCOUNTS = [F1_ZERO, F1_UNSET, F2_ACC, F3_ACC, F4_TGT, F4_SRC, F5_ACC, F6_ACC, F7_SA, F7_SB, F7_TGT, F8_ACC, F9_ACC, F9_PURGE, F10_ACC, F11_ACC, F12_A, F12_B, F13_TGT, F13_SRC];

// ONE temp database for this file. Measured locally 2026-09-15 (three runs,
// vitest's own per-test times): every `it` 12-107 ms, the whole file 4.3-5.4 s
// of which ~3.6 s is hooks — this one (migrate + seed + the core modules)
// 1.1-1.3 s, F7's (the broker route's first GET, a vault sweep) ~1.6 s, the
// rest 0.2-0.6 s. All inside the local budget of <= 300 ms per `it` and <= 3 s
// per hook; the raised timeouts are for the Windows runner, measured > 15x
// slower on SQLite-file work (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("seams-v43-fixF", { seed: true });
  importer = await import("@/lib/import/commit");
  actions = await import("@/app/trades/actions");
  tradeQueries = await import("@/lib/queries/trades");
  slim = await import("@/lib/domain/slim-trade");
  t.db
    .insert(t.schema.accounts)
    .values(ACCOUNTS.map((id) => ({ id, name: `fixF ${id}`, isDefault: false })))
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

// ── shared harness ───────────────────────────────────────────────────────────

const freezeAt = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};
const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get();
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const json = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** A module's export, or undefined — never a throw on a build that lacks it. */
const exported = (m: Record<string, unknown>, k: string): unknown => (Object.keys(m).includes(k) ? m[k] : undefined);
const NO_STATE = { ok: false, message: "" };

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "dhan",
    isin: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    grossPnl: 0,
    unrealisedPnl: 0,
    buyDate: null,
    sellDate: null,
    productHint: "delivery",
    exchangeHint: "NSE",
    sourceFile: null,
    ...over,
  } as NormalizedTrade;
}
const parsed = (trades: NormalizedTrade[]): ParsedFile => ({ sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings: [] });
/** The importer's own commit of one Dhan delivery fill aggregate. */
function commitFill(accountId: number, sym: string, side: "BUY" | "SELL", qty: number, price: number, day: string) {
  const tr =
    side === "BUY"
      ? trade({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: price, buyValue: qty * price, buyDate: day })
      : trade({ tradingsymbol: sym, sellQty: qty, avgSellPrice: price, sellValue: qty * price, sellDate: day });
  const res = importer.commitParsedFile(parsed([tr]), `fixF-${accountId}-${sym}-${side}-${day}-${qty}-${price}`, null, accountId);
  expect(res.added, `${sym} ${side} ${qty} @${price} ${day}`).toBe(1);
  return rowsOf(accountId).at(-1)!;
}

/** Every `<input name=… value=…>` a server render prints, as the browser would post it. */
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
  const html = renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(EditTradeDialog, { trade: wireTrade(accountId, id), onDone: () => {} })));
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

// ============================================================================
// F1 — a STORED MTF funded 0 (commit.ts, wave 2H) ↔ its three READERS
//      (positions.ts + broker-compare, I1; data-quality.ts, I2)
// ============================================================================

describe("F1 · an MTF position paid for in full out of own capital (the editor's save) read by /equity, the broker comparison and Data Quality", () => {
  const mtfRow = (accountId: number, sym: string) =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: sym, tradingsymbol: sym,
          buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

  /** The MTF-interest cell of every priced broker row, as the report prints it. */
  function mtfInterestCells(accountId: number): string[] {
    selectAccount(accountId);
    const tree = brokerComparePage();
    const cells: string[] = [];
    walk(tree, (e) => {
      if (e.type !== ReportTr) return;
      const tds: string[] = [];
      walk(e.props.children, (c) => {
        if (c.type === ReportTd) tds.push(textLeaves(c.props.children).join(""));
      });
      // A broker with no rate card prints ONE cell across the row ("no rates
      // configured"); it prices nothing, so it states no interest either.
      if (tds.length >= 6) cells.push(tds[5]!);
    });
    return cells;
  }

  beforeAll(async () => {
    trash = await import("@/lib/trash");
    dqQueries = await import("@/lib/queries/data-quality");
    Dialog = (await import("@/components/ui/dialog")).Dialog;
    EditTradeDialog = (await import("@/components/trades/edit-trade-dialog")).EditTradeDialog;
    TrackerClient = (await import("@/components/trackers/tracker-client")).TrackerClient;
    ({ ReportTr, ReportTd } = await import("@/components/ui/report-table"));
    brokerComparePage = (await import("@/app/reports/broker-compare/page")).default as () => unknown;
    equityPage = (await import("@/app/equity/page")).default as () => unknown;
  }, 60_000);

  let zeroId = 0;
  let unsetId = 0;

  it("(a) the editor's own-capital save, then Data Quality and the broker comparison: a stated 0 is a figure, and a row that states NOTHING is the one that is listed", async () => {
    freezeAt("2026-08-31T19:00:00.000Z"); // 2026-09-01 00:30 IST — the IST day boundary
    zeroId = mtfRow(F1_ZERO, "SEAMF1Z");
    unsetId = mtfRow(F1_UNSET, "SEAMF1N");
    // The PRODUCER: own capital typed as the whole buy value, through the real
    // editor render and the real server action → a stored funded amount of 0.
    const saved = await actions.updateTradeAction(NO_STATE, editorForm(F1_ZERO, zeroId, { ownCapitalUsed: "10000" }));
    expect([saved.ok, saved.message]).toEqual([true, "Trade updated."]);
    expect(row(zeroId)!.mtfFundedAmount, "the writers' null-vs-0 rule (V3/X2)").toBe(0);
    expect(row(unsetId)!.mtfFundedAmount, "and the other row states nothing").toBeNull();

    // CONSUMER 1 — Data Quality (I2). THE assertion: on revert of
    // data-quality.ts, [1, [zeroId]] — a warning telling the user to set what
    // they just set.
    selectAccount(F1_ZERO);
    const zeroIssue = dqQueries.getDataQualityReport().issues.find((i) => i.code === "mtf_funding");
    expect([zeroIssue?.count ?? 0, zeroIssue?.ids ?? []], "a stated 0 is not a missing figure").toEqual([0, []]);
    selectAccount(F1_UNSET);
    const unsetIssue = dqQueries.getDataQualityReport().issues.find((i) => i.code === "mtf_funding");
    expect([unsetIssue?.count, unsetIssue?.ids], "a row that states nothing still is").toEqual([1, [unsetId]]);

    // CONSUMER 2 — the broker comparison (I1). Every broker re-prices the SAME
    // position: a stated 0 finances nothing, so no broker bills interest on it.
    const zeroCells = mtfInterestCells(F1_ZERO);
    expect(zeroCells.length, "the report prices at least one broker").toBeGreaterThan(0);
    expect(new Set(zeroCells), "the re-pricing bills no interest on a stated 0").toEqual(new Set(["₹0"]));
    // The same row with the amount unstated IS estimated — so the column is
    // live, and the 0 above is an answer rather than an empty implementation.
    const unsetCells = mtfInterestCells(F1_UNSET);
    expect(unsetCells.some((c) => c !== "₹0"), "an unstated funded amount is still estimated").toBe(true);
  });

  it("(b) /equity's own render: the tracker's position carries own capital 10,000 against a funded 0 — never a denominator the journal never recorded", () => {
    freezeAt("2026-08-31T19:00:00.000Z");
    selectAccount(F1_ZERO);
    const el = findElem(equityPage(), (e) => e.type === TrackerClient);
    if (!el) throw new Error("the equity page no longer renders <TrackerClient>");
    const positions = el.props.positions as { id: number; isMtf: boolean; fundedAmount: number; ownCapital: number; invested: number; roiOnCapitalPct: number | null }[];
    const p = positions.find((x) => x.id === zeroId)!;
    // THE assertion (on revert of lib/analytics/positions.ts: fundedAmount 8000
    // — Zerodha's bundled own margin — and ownCapital 2000, a fabricated
    // denominator behind the "Own capital in MTF" KPI and "ROI on capital").
    expect([p.isMtf, p.fundedAmount, p.ownCapital, p.invested], "the /equity tracker reads the stated 0").toEqual([true, 0, 10000, 10000]);
  });
});

// ============================================================================
// F2 — the close dialog's preview body with the exit date CLEARED (I1)
//      ↔ the real preview route ≡ closePosition's stored charges
// ============================================================================

describe("F2 · a 30-day MTF holding closed from the Trades dialog with the exit-date field cleared (close-trade-dialog.tsx → /api/charges/preview ≡ closeTradeAction → commit.ts closePosition)", () => {
  beforeAll(async () => {
    closeDialog = (await import("@/components/trades/close-trade-dialog")) as typeof closeDialog;
    CloseTradeDialog = closeDialog.CloseTradeDialog;
    chargesPreview = await import("@/app/api/charges/preview/route");
  }, 60_000);

  /**
   * The dialog's live preview: the body its effect sends (close-trade-dialog.tsx
   * :108-131 — the dates are decided from the RESOLVED exit date), handed to the
   * real route over JSON, and the [gross, charges, net] the dialog prints. A
   * build without I1's `resolveExitIso` / `closePreviewBody` sends the body its
   * own effect built (3feb22f, verbatim) — the preview THAT build shows.
   */
  async function dialogPreview(trade: WireTrade, exitPrice: number, exitDate: string): Promise<number[]> {
    const isShort = trade.sellQty > trade.buyQty;
    // Read through the export LIST: a module without the export must not throw
    // here (vitest's mock proxy throws on an unknown key, which would redden the
    // `it` before the pre-wave body below could answer for that build).
    const resolveFn = exported(closeDialog, "resolveExitIso") as ((d: string) => string) | undefined;
    const previewFn = exported(closeDialog, "closePreviewBody") as typeof closeDialog.closePreviewBody | undefined;
    const exitIso = typeof resolveFn === "function" ? resolveFn(exitDate) : exitDate || todayIstIso();
    const dates = { buyDate: isShort ? exitIso : trade.buyDate, sellDate: isShort ? trade.sellDate : exitIso };
    let body: unknown;
    if (typeof previewFn === "function") {
      body = previewFn(trade, exitPrice, exitDate, dates);
    } else {
      const qty = Math.abs(trade.buyQty - trade.sellQty) || Math.max(trade.buyQty, trade.sellQty);
      const buyQty = isShort ? qty : trade.buyQty;
      const avgBuyPrice = isShort ? exitPrice : trade.avgBuyPrice;
      const sellQty = isShort ? trade.sellQty : qty;
      const avgSellPrice = isShort ? trade.avgSellPrice : exitPrice;
      body = {
        broker: trade.broker, tradingsymbol: trade.tradingsymbol, segment: trade.segment, exchange: trade.exchange,
        buyValue: buyQty * avgBuyPrice, sellValue: sellQty * avgSellPrice, buyQty, sellQty, grossPnl: (avgSellPrice - avgBuyPrice) * qty,
        ownCapitalUsed: trade.mtfFundedAmount != null ? Math.max(0, buyQty * avgBuyPrice - trade.mtfFundedAmount) : null,
        daysHeld: trade.buyDate ? Math.max(0, Math.floor((new Date(exitDate).getTime() - new Date(trade.buyDate).getTime()) / 86400000)) : 0,
        isOpen: false, ...dates,
      };
    }
    const res = await chargesPreview.POST(json("/api/charges/preview", JSON.parse(JSON.stringify(body))));
    const p = (await res.json()) as { grossPnl: number; netPnl: number; breakdown: { total: number } };
    expect(res.status, JSON.stringify(p)).toBe(200);
    return [p.grossPnl, p.breakdown.total, p.netPnl];
  }

  it("the user clears the date and confirms: the preview bills the real holding period, and it is the bill the save stores", async () => {
    // 18:30-24:00 UTC: the IST day is already tomorrow, which is the date the
    // cleared field resolves to on BOTH sides.
    freezeAt("2026-08-31T19:00:00.000Z");
    expect(todayIstIso()).toBe("2026-09-01");
    const id = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F2_ACC, broker: "zerodha", bucket: "equity", segment: "eq_mtf", symbol: "SEAMF2", tradingsymbol: "SEAMF2",
          buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1, mtfFundedAmount: 8000, isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

    const html = renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(CloseTradeDialog, { trade: wireTrade(F2_ACC, id), onDone: () => {} })));
    const fd = formOf(html);
    fd.set("exitPrice", "110");
    fd.set("exitDate", ""); // the user clears the pre-filled date
    const shown = await dialogPreview(wireTrade(F2_ACC, id), 110, "");
    const closed = await actions.closeTradeAction(NO_STATE, fd);
    expect(closed.ok, closed.message).toBe(true);

    const r = row(id)!;
    // The save's own rule: a blank date is the IST day, and the funded principal
    // accrues for the whole holding period.
    expect([r.isOpen, r.sellDate, r.mtfFundedAmount], "closePosition's stored close").toEqual([false, "2026-09-01", 8000]);
    expect(r.mtfInterest, "31 days of interest on ₹8,000").toBeGreaterThan(0);
    // THE assertion (on revert of close-trade-dialog.tsx: daysHeld is NaN from
    // `new Date("")`, JSON sends null and the route bills 0 days — a preview of
    // ₹86.32 charges beside a stored ₹152.85).
    expect(shown, "the cleared-date preview is the save").toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);
  });
});

// ============================================================================
// F3 — deleteTradesByIds' envelope (I4) ↔ trash.ts' restore (I2) ↔ the Data
//      Quality section (I2)
// ============================================================================

describe("F3 · a Data Quality-joined lot and the sale its alias names, deleted together from /trades and restored from Deleted items", () => {
  const SYM = "SEAMF3";
  beforeAll(async () => {
    closeStaleRoute = await import("@/app/api/data-quality/close-stale/route");
    trashRoute = await import("@/app/api/trash/route");
    deleteQ = await import("@/lib/queries/delete");
  }, 60_000);

  const join = (lotId: number, saleId: number) =>
    closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId, saleId, exitDate: "2026-08-25" }));
  const restore = async (id: string) =>
    (await (await trashRoute.POST(json("/api/trash", { action: "restore", id }))).json()) as {
      ok: boolean; restored: number; skipped: { id: number; reason: string }[]; message: string;
    };

  it("both rows come back and Data Quality reads exactly what it read before; a lot restored beside the STORED sale is still refused", async () => {
    selectAccount(F3_ACC);
    const lot = commitFill(F3_ACC, SYM, "BUY", 100, 200, "2026-08-20");
    const sale = commitFill(F3_ACC, SYM, "SELL", 100, 250, "2026-08-25");
    expect((await join(lot.id, sale.id)).status).toBe(200);
    // How the book holds the pair side by side with no user mistake: the join's
    // own snapshot restores the sale once the lot has been re-opened (V1: an
    // alias is held only while the closing leg holds quantity), then the lot is
    // closed again in the editor.
    const joinSnapshot = trash.listTrashSnapshots().find((s) => s.reason.startsWith(`joined to trade #${lot.id} (`))!.id;
    expect(importer.updateManualTrade(lot.id, { sellQty: 0, avgSellPrice: 0, sellDate: null }).ok).toBe(true);
    expect((await restore(joinSnapshot)).restored, "the sale returns").toBe(1);
    expect(importer.updateManualTrade(lot.id, { sellQty: 100, avgSellPrice: 250, sellDate: "2026-08-25" }).ok).toBe(true);
    expect(row(lot.id)!.importNotes ?? "").toContain(`dedup-alias:${sale.dedupHash}`);

    const before = rowsOf(F3_ACC);
    const listingBefore = dqQueries.getStaleOpenSection();
    // The PRODUCER: the /trades delete of both rows, through the real action.
    const fd = new FormData();
    fd.set("ids", [lot.id, sale.id].join(","));
    const deleted = await actions.deleteTradesAction(NO_STATE, fd);
    expect(deleted.ok, deleted.message).toBe(true);
    expect(rowsOf(F3_ACC)).toEqual([]);
    const snapshotId = trash.listTrashSnapshots()[0]!.id;

    const res = await restore(snapshotId);
    // THE assertion (on revert of lib/trash.ts: {ok:false, restored:0} and
    // "…was closed with a sale this snapshot also holds…" — the whole snapshot
    // refused, and for an account-deletion envelope the whole book with it).
    expect([res.ok, res.restored, res.skipped], res.message).toEqual([true, 2, []]);
    expect(rowsOf(F3_ACC), "the book is the one the snapshot was taken from").toEqual(before);
    expect(dqQueries.getStaleOpenSection(), "and Data Quality says what it said before the delete").toEqual(listingBefore);

    // Unchanged against a row ALREADY STORED: the lot alone, restored beside the
    // sale that is back in the journal, is still refused and names the remedy.
    const lotAlone = deleteQ.deleteTradesByIds([lot.id], "F3: the lot alone", "test").snapshotId!;
    const refused = await restore(lotAlone);
    expect([refused.ok, refused.restored], refused.message).toEqual([false, 0]);
    expect(refused.message).toContain("is back in the journal");
    expect(rowsOf(F3_ACC).map((r) => r.id)).toEqual([sale.id]);
    expect((await restore(lotAlone)).restored, "the refusal stands while that sale is stored").toBe(0);
  });
});

// ============================================================================
// F4 — ONE identity predicate: the merge (I2/J2) ≡ the restore skip (I2)
//      ≡ the import dedup (commit.ts)
// ============================================================================

describe("F4 · a source sale the target's joined lot already records (account-delete.ts merge ↔ close-open-lots heldIdentityHashes ↔ trash.ts ↔ commit.ts dedup)", () => {
  const SYM = "SEAMF4";
  beforeAll(async () => {
    accountDelete = await import("@/lib/queries/account-delete");
  }, 60_000);

  it("the merge skips it like a hash duplicate, the import skips it, and a snapshot of it into the target is skipped — one predicate, three readers", async () => {
    for (const acc of [F4_TGT, F4_SRC]) {
      commitFill(acc, SYM, "BUY", 100, 200, "2026-08-20");
      commitFill(acc, SYM, "SELL", 100, 250, "2026-08-25");
    }
    const [lotT, saleT] = rowsOf(F4_TGT);
    const [, saleS] = rowsOf(F4_SRC);
    selectAccount(F4_TGT);
    expect((await closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId: lotT.id, saleId: saleT.id, exitDate: "2026-08-25" }))).status).toBe(200);
    expect(rowsOf(F4_TGT).map((r) => [r.id, r.isOpen])).toEqual([[lotT.id, false]]);
    expect(saleS.dedupHash, "the same fill from the same file kind is the same identity in both books").toBe(saleT.dedupHash);

    // READER 1 — the import dedup (commit.ts, unchanged): re-pulling that fill
    // into the target is a duplicate, because the lot records it.
    const again = importer.commitParsedFile(
      parsed([trade({ tradingsymbol: SYM, sellQty: 100, avgSellPrice: 250, sellValue: 25000, sellDate: "2026-08-25" })]),
      `fixF-${F4_TGT}-${SYM}-SELL-2026-08-25-100-250`,
      null,
      F4_TGT,
    );
    expect([again.added, again.skipped], "the import reads the alias").toEqual([0, 1]);

    // READER 2 — a Deleted-items snapshot of that same sale INTO the target book.
    const snapshotId = trash.writeTrashSnapshot({
      trades: [{ ...(saleS as unknown as Record<string, unknown>), id: 940_001, accountId: F4_TGT }],
      legs: [], attachments: [], reason: "F4: the sale into the book that records it", accountId: F4_TGT,
    });
    const restored = trash.restoreTrashSnapshot(snapshotId);
    expect([restored.restored, restored.skipped.map((s) => s.id)], "the restore reads the same alias").toEqual([0, [940_001]]);
    expect(restored.skipped[0]!.reason).toMatch(/recorded in the position it closed/);

    // READER 3 — the MERGE. THE assertion (on revert of account-delete.ts, whose
    // `dedupCollisionIds` compared dedup_hash only: the sale is MOVED and the
    // merged book holds it twice — realised in the closed round trip and back as
    // an open phantom short).
    const res = accountDelete.deleteAccount({ accountId: F4_SRC, mode: "merge", targetId: F4_TGT, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 2]);
    expect(rowsOf(F4_TGT).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty]), "no phantom short beside the lot that realised that sale").toEqual([
      [lotT.id, false, 100, 100],
    ]);
  });
});

// ============================================================================
// F5 — a sale that states no price (data-quality.ts, I2) ↔ the close-stale
//      route ↔ closeStaleLot's AMBIGUOUS refusal
// ============================================================================

describe("F5 · a sale stating no price beside a joined lot (staleJoinExempts → getStaleOpenSection → /api/data-quality/close-stale)", () => {
  const SYM = "SEAMF5";
  it("the pair is ambiguous on screen and the one-click refuses 409 AMBIGUOUS, changing nothing", async () => {
    selectAccount(F5_ACC);
    const l1 = commitFill(F5_ACC, SYM, "BUY", 100, 200, "2026-08-20");
    const s1 = commitFill(F5_ACC, SYM, "SELL", 100, 250, "2026-08-25");
    expect((await closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId: l1.id, saleId: s1.id, exitDate: "2026-08-25" }))).status).toBe(200);
    const l2 = commitFill(F5_ACC, SYM, "BUY", 100, 210, "2026-08-21");
    // A sale the broker stated with no price at all (the column is NOT NULL
    // DEFAULT 0, so "unstated" arrives as 0).
    const s0 = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F5_ACC, broker: "dhan", segment: "eq_delivery", symbol: SYM, tradingsymbol: SYM,
          sellQty: 100, avgSellPrice: 0, sellValue: 0, sellDate: "2026-08-28", isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

    const section = dqQueries.getStaleOpenSection();
    const pair = section.pairs.find((p) => p.lotId === l2.id && p.saleId === s0)!;
    // THE assertions (on revert of lib/analytics/data-quality.ts: the 0 reads as
    // "a different price", the joined lot is exempted, and the pair is offered a
    // CRITICAL one-click onto a sale L1 may already count).
    expect([pair.ambiguous, pair.oneClick], "a price of 0 never proves the sale differs").toEqual([true, false]);
    const before = rowsOf(F5_ACC);
    const res = await closeStaleRoute.POST(json("/api/data-quality/close-stale", { lotId: l2.id, saleId: s0, exitDate: "2026-08-28" }));
    const body = (await res.json()) as { ok: boolean; code?: string; message: string };
    expect([res.status, body.code], body.message).toEqual([409, "AMBIGUOUS"]);
    expect(rowsOf(F5_ACC), "nothing was changed").toEqual(before);
  });
});

// ============================================================================
// F6 — the M1 ask counted on the STORED rows (cross-source.ts, I3) ↔ the pull
//      route's 409 (J1) ↔ the dialog's copy (J1)
// ============================================================================

describe("F6 · one incoming row against TWO stored rows of today's earlier pull, on two different keys (commit.ts planSnapshot → cross-source → route 409 → collisionDialogCopy)", () => {
  const clientOf = (accountId: number) => `40000${accountId}`;
  const alive = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  beforeAll(async () => {
    brokerRoute = await import("@/app/api/import/broker/route");
    bc = (await import("@/components/import/broker-connect")) as typeof bc;
    crossSource = await import("@/lib/import/cross-source");
  }, 60_000);

  const addDhan = (accountId: number) =>
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, NULL)")
      .run(accountId, clientOf(accountId), alive());
  const position = (accountId: number, symbol: string, productType: string, exchangeSegment: string, buyQty: number, buyAvg: number) => ({
    dhanClientId: clientOf(accountId),
    tradingSymbol: symbol,
    positionType: "LONG",
    exchangeSegment,
    productType,
    buyAvg,
    buyQty,
    sellAvg: 0,
    sellQty: 0,
    netQty: buyQty,
  });
  const stub = (positions: unknown[]) =>
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      const body = u.host === "auth.dhan.co" ? { accessToken: alive() } : u.pathname === "/v2/positions" ? positions : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  const pull = async (accountId: number) => {
    const res = await brokerRoute.POST(json("/api/import/broker", { action: "pull", broker: "dhan", accountId, mode: "commit" }));
    return { status: res.status, body: (await res.json()) as { needsForce?: boolean; message: string; collisions?: { symbol: string; kind: string; sameSnapshot?: boolean }[] } };
  };

  it("the 409's sentence counts the two EARLIER rows, warns they may carry the user's record and names Deleted items — and the dialog shows it whole", async () => {
    freezeAt("2026-09-08T06:30:00.000Z"); // 12:00 IST
    addDhan(F6_ACC);
    // Today's earlier pull: one instrument, two keys (intraday NSE, delivery BSE).
    stub([position(F6_ACC, "SEAMF6", "INTRADAY", "NSE_EQ", 10, 100), position(F6_ACC, "SEAMF6", "CNC", "BSE_EQ", 5, 101)]);
    expect((await pull(F6_ACC)).status).toBe(200);
    const stored = rowsOf(F6_ACC);
    expect(stored.map((r) => [r.segment, r.exchange, r.buyQty]).sort(), "two stored rows on two keys").toEqual(
      [["eq_delivery", "BSE", 5], ["eq_intraday", "NSE", 10]].sort(),
    );

    freezeAt("2026-09-08T10:30:00.000Z"); // 16:00 IST, the same IST day
    stub([position(F6_ACC, "SEAMF6", "MTF", "NSE_EQ", 15, 100.5)]);
    const blocked = await pull(F6_ACC);
    expect([blocked.status, blocked.body.needsForce]).toEqual([409, true]);
    const shown = bc.collisionDialogCopy({ collisions: blocked.body.collisions ?? [], message: blocked.body.message });
    const msg = shown.serverMessage ?? "";

    // THE assertions (on revert of lib/import/cross-source.ts: "…is not written
    // over that row. … the earlier row can be deleted …; committing anyway keeps
    // both rows." — singular, reporting one of the two rows the ask stands
    // against, so following it once left the same pull refused; and no warning
    // that the row may carry what the user wrote).
    expect(msg, "the remedy counts the STORED rows, not the incoming ones").toContain("the 2 earlier rows can be deleted from Trades and the pull run again");
    expect(msg).toContain("is not written over those rows.");
    expect(msg).toContain("committing anyway adds this pull's row beside the earlier ones.");
    expect(msg).toContain("Those rows may carry a cost basis or journal entry you recorded; a deleted row can be put back from Backup & Restore → Deleted items.");
    expect([shown.description, shown.otherSourceFooter]).toEqual(["Nothing has been committed.", false]);

    // The producer is the real pure module: the same plan, built by hand, states
    // the same sentence — so the count on the wire is planSnapshot's own.
    const direct = crossSource.detectCrossSourceDuplicates(
      [{
        broker: "dhan", symbol: "SEAMF6", tradingsymbol: "SEAMF6", buyQty: 15, sellQty: 0, buyValue: 1507.5, sellValue: 0,
        buyDate: "2026-09-08", sellDate: null, dedupHash: "f6-incoming",
        snapshotIds: stored.map((r) => r.id), snapshotOffKey: true,
      }],
      stored.map((r) => ({
        id: r.id, broker: "dhan", symbol: "SEAMF6", tradingsymbol: "SEAMF6", buyQty: r.buyQty, sellQty: r.sellQty,
        buyValue: r.buyValue, sellValue: r.sellValue, buyDate: r.buyDate, sellDate: r.sellDate, sourceFile: "f6", dedupHash: r.dedupHash,
      })),
      "f6",
    );
    expect(msg, "the route's sentence is the module's own").toBe(direct.message);

    // Every OTHER ask is byte-identical to the one HEAD (wave 2H) states: I3
    // rewrote the M1 sentence alone.
    const onKey = crossSource.detectCrossSourceDuplicates(
      [{
        broker: "dhan", symbol: "SEAMF6K", tradingsymbol: "SEAMF6K", buyQty: 20, sellQty: 0, buyValue: 2000, sellValue: 0,
        buyDate: "2026-09-08", sellDate: null, dedupHash: "f6-onkey-in", snapshotIds: [77], snapshotOffKey: false,
      }],
      [{ id: 77, broker: "dhan", symbol: "SEAMF6K", tradingsymbol: "SEAMF6K", buyQty: 10, sellQty: 0, buyValue: 1000, sellValue: 0, buyDate: "2026-09-08", sellDate: null, sourceFile: "f6k", dedupHash: "f6-onkey-stored" }],
      "f6k",
    );
    expect(onKey.message).toBe(
      "1 row in this pull (SEAMF6K) restates a position today's earlier pull already recorded, and is not written over it: " +
        "the recorded row carries detail a replacement would lose (a ladder of fills, a Data Quality join, a segment or exchange you set, or a cost basis or journal entry you recorded), or more than one position shares its instrument. " +
        "Nothing is merged or overwritten automatically; committing anyway adds this pull's row beside the earlier one.",
    );
  });
});

// ============================================================================
// F7 — a merge-carried record's identity (dhan-unfetched.ts, I5) ↔ the card's
//      named Clear body and the route's forwarding (broker-connect + route, J1)
// ============================================================================

describe("F7 · two books merged into one target with an outstanding notice on the IDENTICAL span (keepUnfetched → carryUnfetchedOnMerge → GET → card lines → Clear body → POST)", () => {
  beforeAll(async () => {
    unfetched = await import("@/lib/import/dhan-unfetched");
    dhanApi = await import("@/lib/import/api/dhan");
    // The route's first GET does the vault sweep and compiles its queries
    // (1.6 s locally, measured 2026-09-15). That belongs in the HOOK: the
    // Windows budget is <= 300 ms per `it` and <= 3 s per hook (AGENTS.md).
    await brokerRoute.GET();
  }, 60_000);

  const alive = () => ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");
  const addDhan = (accountId: number) =>
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, NULL)")
      .run(accountId, "1000000077", alive());
  const rangeCapAt = (stamp: string) =>
    dhanApi.toParsedFile([], dhanApi.catchUpRange(stamp, "2026-09-11"), { pages: 1, truncated: false, oldest: null, newest: null }, stamp).unfetched;
  const hhmm = (s: { fact: string }) => /after (\d\d:\d\d) IST/.exec(s.fact)?.[1] ?? s.fact;
  type CardRow = { broker: string; accountId: number; unfetched?: import("@/components/import/broker-connect").UnfetchedSpan[]; unfetchedConnection?: (number | null)[] };
  async function cardRow(accountId: number): Promise<CardRow> {
    const body = (await (await brokerRoute.GET()).json()) as { connections?: CardRow[] };
    const r = (body.connections ?? []).find((c) => c.broker === "dhan" && c.accountId === accountId);
    if (!r) throw new Error(`GET lists no Dhan connection for account ${accountId}`);
    return r;
  }

  it("GET lists both lines, the Clear body of the one clicked carries ITS sentence, and the route clears exactly that record", async () => {
    selectAccount(0); // All accounts, so GET lists the target's row (invariant 8)
    unfetched.keepUnfetched(rangeCapAt("2026-05-13T09:00:00.000Z"), { connId: 91, accountId: F7_SA, source: "import" }); // 14:30 IST
    unfetched.keepUnfetched(rangeCapAt("2026-05-13T05:00:00.000Z"), { connId: 92, accountId: F7_SB, source: "import" }); // 10:30 IST
    for (const [from, name] of [[F7_SA, "book A"], [F7_SB, "book B"]] as const) {
      expect(
        t.db.transaction((tx) => unfetched.carryUnfetchedOnMerge(tx, { fromAccountId: from, toAccountId: F7_TGT, fromName: name, toName: "fixF target", source: "ui" })),
        "each book's own outstanding notice is carried",
      ).toBe(1);
    }
    addDhan(F7_TGT);

    const card = await cardRow(F7_TGT);
    const lines = bc.unfetchedLines(card);
    // THE assertion (on revert of lib/import/dhan-unfetched.ts, where every carry
    // keyed on (null, span): the second carry returned 0 and that book's sentence
    // was never stored — one line, and the other book's gap invisible).
    expect(lines.map((s) => [s.connection, hhmm(s)]), "the second book's carry is its own record").toEqual([
      [null, "14:30"],
      [null, "10:30"],
    ]);

    // The card's Clear body for a carried line names the sentence it SHOWS.
    const body = JSON.parse(JSON.stringify(bc.clearUnfetchedBody(card, lines[1]!))) as Record<string, unknown>;
    expect([body.connection, body.fact, body.remedy]).toEqual([null, lines[1]!.fact, lines[1]!.remedy]);
    const res = await brokerRoute.POST(json("/api/import/broker", body));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    // THE assertion (on revert of the card's body or the route's forwarding:
    // [[null, "10:30"]] — the line the user clicked stays listed and the OTHER
    // book's gap is dismissed in its place).
    expect(unfetched.outstandingUnfetchedRecords(F7_TGT).map((r) => [r.connection, hhmm(r)])).toEqual([[null, "14:30"]]);
    expect(bc.unfetchedLines(await cardRow(F7_TGT)).map((s) => hhmm(s))).toEqual(["14:30"]);
  });
});

// ============================================================================
// F8 — the account an IPO record is filed in (actions.ts, I4) ↔ the scoped
//      listing and the scoped write (queries/ipos.ts, route)
// ============================================================================

type Ipo = import("@/lib/analytics/ipo").IpoComputed;

describe("F8 · \"This holding came from an IPO\" pressed on a holding outside account 1 (pushTradeToIpoAction → getIposComputed → POST /api/ipos)", () => {
  beforeAll(async () => {
    ipoQueries = await import("@/lib/queries/ipos");
    ipoRoute = await import("@/app/api/ipos/route");
    ipoUi = (await import("@/components/ipo/ipo-client")) as typeof ipoUi;
  }, 60_000);

  it("the record is filed in the holding's own account: account 1 never lists it, the exit closes only that holding, and a cross-account link is refused", async () => {
    const holding = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F8_ACC, broker: "zerodha", symbol: "F8-IPO", tradingsymbol: "F8-IPO", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const inAccountOne = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: 1, broker: "zerodha", symbol: "F8-OTHER", tradingsymbol: "F8-OTHER", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;

    selectAccount(F8_ACC);
    const fd = new FormData();
    fd.set("tradeId", String(holding));
    const pushed = await actions.pushTradeToIpoAction(NO_STATE, fd);
    expect(pushed.ok, pushed.message).toBe(true);
    const stored = t.db.select().from(t.schema.ipos).all().find((r) => r.name === "F8-IPO")!;
    // THE assertion (on revert of app/trades/actions.ts: the insert named no
    // accountId, so the column took its schema default of 1 — and the action
    // threw AuditShapeError after the write, so `pushed.ok` was false too).
    expect([stored.accountId, stored.tradeId], "the record is filed in the holding's account").toEqual([F8_ACC, holding]);

    // The listing, both ways (on revert of lib/queries/ipos.ts' scoped join:
    // account 1 shows it, linked to the other book's holding).
    selectAccount(1);
    expect(ipoQueries.getIposComputed().rows.map((r) => r.name)).not.toContain("F8-IPO");
    selectAccount(F8_ACC);
    const mine = ipoQueries.getIposComputed().rows.find((r) => r.name === "F8-IPO")!;
    expect([mine.linked, mine.id]).toEqual([true, stored.id]);

    // The exit saved from this account closes THIS holding and nothing else.
    const otherBefore = row(inAccountOne);
    const sold = await ipoRoute.POST(json("/api/ipos", saveBody(mine, formHtml(mine), { exitPrice: "150", exitDate: "2026-03-02" })));
    expect(sold.status, JSON.stringify(await sold.clone().json())).toBe(200);
    const h = row(holding)!;
    expect([h.isOpen, h.sellQty, h.avgSellPrice, h.sellDate]).toEqual([false, 10, 150, "2026-03-02"]);
    expect(row(inAccountOne)).toEqual(otherBefore);

    // A link this request MAKES across the boundary is refused, naming both books.
    const refused = await ipoRoute.POST(json("/api/ipos", { ...saveBody(mine, formHtml(mine)), id: undefined, name: "F8-XACCT", tradeId: inAccountOne }));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toContain("belong to one account's book");
    expect(t.db.select().from(t.schema.ipos).all().filter((r) => r.name === "F8-XACCT")).toHaveLength(0);
  });
});

/** /ipos' row for `name` in the account given — the RSC payload, as JSON. */
function ipoPage(name: string, accountId: number): Ipo {
  selectAccount(accountId);
  const r = ipoQueries.getIposComputed().rows.find((x) => x.name === name);
  if (!r) throw new Error(`/ipos lists no ${name} in account ${accountId}`);
  return JSON.parse(JSON.stringify(r)) as Ipo;
}
const formHtml = (existing: Ipo) => renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(ipoUi.IpoForm, { existing, onDone: () => {} })));
const renderedExitDate = (html: string) => /Exit date<\/label><input type="date"[^>]*value="([^"]*)"/.exec(html)?.[1];
/** IpoForm.save()'s body: the form's state as it opened, the user's typing on top. */
function saveBody(e: Ipo, html: string, typed: { notes?: string; exitPrice?: string; exitDate?: string } = {}) {
  // Every helper is read through the export LIST, so a build without one answers
  // as that build's own form would rather than throwing.
  const unreadableFn = exported(ipoUi, "unreadableStoredExitDate") as ((d: string | null) => boolean) | undefined;
  const keepsFn = (exported(ipoUi, "keepsStoredExitDate") ?? exported(ipoUi, "storedAsSold")) as ((e: Ipo) => boolean) | undefined;
  const toSendFn = exported(ipoUi, "exitDateToSend") as ((stored: string | null, field: string, allotted: boolean, sold: boolean, edited: boolean) => string) | undefined;
  const storedExit = e.exitDate ?? null;
  const unreadable = typeof unreadableFn === "function" && unreadableFn(storedExit);
  const field = typed.exitDate ?? renderedExitDate(html) ?? (unreadable ? "" : (storedExit ?? ""));
  const sold = typeof keepsFn === "function" ? keepsFn(e) : false;
  const toSend = typeof toSendFn === "function" ? toSendFn(storedExit, field, e.allotted, sold, typed.exitDate !== undefined) : field;
  const linked = (e as Ipo & { tradeId?: number | null }).tradeId ?? null;
  return {
    id: e.id, name: e.name, broker: e.broker ?? "", exchange: e.exchange ?? "NSE", board: e.board ?? "mainboard", category: e.category ?? "",
    discountPerShare: e.discountPerShare > 0 ? String(e.discountPerShare) : "", appliedPrice: String(e.appliedPrice), lotSize: String(e.lotSize),
    lotsApplied: String(e.lotsApplied), allotted: e.allotted, allottedQty: e.allotted ? Math.round(e.allottedQty / e.lotSize) * e.lotSize : 0,
    listingPrice: e.listingPrice == null ? "" : String(e.listingPrice), exitPrice: typed.exitPrice ?? (e.exitPrice == null ? "" : String(e.exitPrice)),
    appliedDate: e.appliedDate ?? "", allotmentDate: e.allotmentDate ?? "", listingDate: e.listingDate ?? "",
    exitDate: toSend, notes: typed.notes ?? e.notes ?? "",
    ...(linked != null ? { tradeId: linked } : {}),
  } as Record<string, unknown>;
}

// ============================================================================
// F9 — `ipoRefs` in the Trash envelope (delete.ts, I4; account-delete.ts, J2)
//      ↔ trash.ts' re-link loop (I2) ↔ capital / the tax base / AIS
// ============================================================================

describe("F9 · a linked, exited IPO whose holding is deleted and restored (deleteTradesAction / deleteAccount → the envelope → restoreTrashSnapshot → the counted-once consumers)", () => {
  let capital: typeof import("@/lib/queries/capital");
  let taxItr: typeof import("@/lib/queries/tax-itr");
  let aisRoute: typeof import("@/app/api/ais/route");
  beforeAll(async () => {
    capital = await import("@/lib/queries/capital");
    taxItr = await import("@/lib/queries/tax-itr");
    aisRoute = await import("@/app/api/ais/route");
  }, 60_000);

  /** The three consumers that must count a linked, exited IPO's sale ONCE. */
  async function countedOnce(accountId: number) {
    selectAccount(accountId);
    const cap = capital.getCapitalSummary();
    const base = taxItr.getTaxBase();
    const res = await aisRoute.POST(json("/api/ais", { text: "nothing to parse" }));
    const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
    return {
      capital: [cap.equityRealised, cap.ipoRealised, cap.totalRealised],
      tax: [base.exitedIpos.length, base.ipoTaxRows.length, base.cgTrades.map((c) => c.netPnl)],
      ais: recon.fyTotals.map((f) => [f.fy, f.kind, f.journal]),
    };
  }

  const linkedAndSold = async (accountId: number, name: string) => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId, broker: "zerodha", symbol: name, tradingsymbol: name, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId, name, appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, allotmentDate: "2019-01-10", tradeId })
      .run();
    const e = ipoPage(name, accountId);
    const sold = await ipoRoute.POST(json("/api/ipos", saveBody(e, formHtml(e), { exitPrice: "150", exitDate: "2026-03-02" })));
    expect(sold.status, JSON.stringify(await sold.clone().json())).toBe(200);
    expect(row(tradeId)!.isOpen).toBe(false);
    return tradeId;
  };
  const ipoRowOf = (name: string) => t.db.select().from(t.schema.ipos).all().find((r) => r.name === name)!;

  it("(a) a /trades delete and a Deleted-items restore: the link comes back, and capital, the tax base and AIS still count that sale once", async () => {
    const tradeId = await linkedAndSold(F9_ACC, "F9-IPO");
    const before = await countedOnce(F9_ACC);
    expect(before.capital[1], "the IPO's own net is not counted beside the trade's").toBe(0);

    selectAccount(F9_ACC);
    const fd = new FormData();
    fd.set("ids", String(tradeId));
    const deleted = await actions.deleteTradesAction(NO_STATE, fd);
    expect(deleted.ok, deleted.message).toBe(true);
    expect(ipoRowOf("F9-IPO").tradeId, "the delete unlinks, never deletes").toBeNull();

    const snapshotId = trash.listTrashSnapshots()[0]!.id;
    const res = await (await trashRoute.POST(json("/api/trash", { action: "restore", id: snapshotId }))).json();
    expect((res as { ok: boolean; restored: number }).restored).toBe(1);
    // THE assertion (on revert of lib/queries/delete.ts, which wrote no
    // `ipoRefs`: the trade comes back with `ipos.trade_id` still null, and the
    // same sale is counted twice — in capital, the tax pack, the ITR export and
    // both AIS sides, with nothing on screen saying the link had gone).
    expect(ipoRowOf("F9-IPO").tradeId, "the restored link").toBe(tradeId);
    expect(await countedOnce(F9_ACC), "the restored link is counted once").toEqual(before);
  });

  it("(b) an account PURGE and its restore: the account, the holding, the IPO and the link all come back, still counted once", async () => {
    const tradeId = await linkedAndSold(F9_PURGE, "F9-PURGE");
    const before = await countedOnce(F9_PURGE);
    expect(before.capital[1], "the baseline is counted-once, not merely stable").toBe(0);

    const del = accountDelete.deleteAccount({ accountId: F9_PURGE, mode: "purge", connections: "delete" });
    expect([del.ok, del.snapshotId != null], del.message).toEqual([true, true]);
    expect(rowsOf(F9_PURGE)).toEqual([]);

    const restored = trash.restoreTrashSnapshot(del.snapshotId!);
    expect(restored.ok, restored.message).toBe(true);
    // The envelope states the whole picture (J2): the purge's own IPO rides back
    // inside `accountRows.ipos` with `trade_id` intact, and `ipoRefs` names it
    // too — inert here, load-bearing for a row in another book.
    expect(ipoRowOf("F9-PURGE").tradeId).toBe(tradeId);
    expect(await countedOnce(F9_PURGE)).toEqual(before);
  });
});

// ============================================================================
// F10 — the startup data fix (data-fixes.ts, J3) ↔ the scoped listing
//       (queries/ipos.ts, I4)
// ============================================================================

describe("F10 · a legacy IPO row filed in account 1 whose holding is in another book (runDataFixes → getIposComputed)", () => {
  beforeAll(async () => {
    dataFixes = await import("@/lib/db/data-fixes");
  }, 60_000);

  it("the fix re-homes it to its holding's account and the listing follows; a null link, a same-account link and a deleted trade are left alone", () => {
    const holding = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F10_ACC, broker: "zerodha", symbol: "F10-IPO", tradingsymbol: "F10-IPO", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    // Written as the pre-2I button wrote it: no accountId, so the column took
    // its schema default of 1 whatever book the holding was in.
    t.db
      .insert(t.schema.ipos)
      .values({ name: "F10-IPO", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, allotmentDate: "2026-02-20", tradeId: holding })
      .run();
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: 1, name: "F10-UNLINKED", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, allotmentDate: "2026-02-20" })
      .run();
    const stored = (name: string) => t.db.select().from(t.schema.ipos).all().find((r) => r.name === name)!;
    expect([stored("F10-IPO").accountId, stored("F10-IPO").tradeId]).toEqual([1, holding]);
    // Its own account cannot see it, and account 1 shows it unlinked (the join
    // is account-scoped): the state the fix exists for.
    expect(ipoQueries.getIposComputed().rows.map((r) => r.name)).not.toContain("F10-IPO");
    selectAccount(1);
    expect(ipoQueries.getIposComputed().rows.find((r) => r.name === "F10-IPO")!.linked).toBe(false);

    // The real entry point a restored backup takes (lib/db/index.ts runs the
    // same list at startup; a restore forgets the markers).
    const results = dataFixes.rerunDataFixesAfterRestore(t.sqlite);
    expect(results.map((r) => r.name)).toContain("ipo-account-rehome-v1");

    // THE assertions (on revert of lib/db/data-fixes.ts: the row stays in
    // account 1, invisible to its holding's /ipos, unreachable for a sync and
    // read as unlinked by the counted-once consumers).
    expect([stored("F10-IPO").accountId, stored("F10-IPO").tradeId], "the holding is the fact the user cannot have got wrong").toEqual([F10_ACC, holding]);
    expect(stored("F10-UNLINKED").accountId, "an ordinary application is left where it is").toBe(1);
    expect(row(holding)!.accountId, "trades is never written").toBe(F10_ACC);
    // The listing follows: its holding's own /ipos now shows it, LINKED (the
    // join is account-scoped, so the re-home is what makes the link readable).
    const listed = ipoPage("F10-IPO", F10_ACC);
    expect([listed.linked, listed.linkedSellDate ?? null], "the holding's own /ipos reads the link").toEqual([true, null]);
    selectAccount(1);
    expect(ipoQueries.getIposComputed().rows.map((r) => r.name)).not.toContain("F10-IPO");
  });
});

// ============================================================================
// F11 — whose close the holding carries (ipo-link.ts syncOwnsClose, J4)
//       ↔ the route's charge write (J4) ↔ computeIpo's rates (I4)
// ============================================================================

describe("F11 · the exit of a linked IPO re-priced on /ipos (syncOwnsClose → syncWroteCharges → syncLinkedTrade, against charge_config)", () => {
  it("a close the sync itself wrote is re-priced whole; a sale recorded in Trades keeps its own charges; mtfInterest and pledgeCharges are never written", async () => {
    const tradeId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: F11_ACC, broker: "zerodha", symbol: "F11-IPO", tradingsymbol: "F11-IPO", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1, isOpen: true }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F11_ACC, name: "F11-IPO", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, allotmentDate: "2019-01-10", tradeId })
      .run();

    // The sync writes the close itself.
    const first = ipoPage("F11-IPO", F11_ACC);
    expect((await ipoRoute.POST(json("/api/ipos", saveBody(first, formHtml(first), { exitPrice: "150", exitDate: "2026-03-02" })))).status).toBe(200);
    const afterFirst = row(tradeId)!;
    const shown = ipoPage("F11-IPO", F11_ACC);
    expect([afterFirst.grossPnl, afterFirst.chargesTotal, afterFirst.netPnl]).toEqual([shown.grossPnl, shown.charges, shown.netPnl]);
    // Money it really carries, which the IPO model prices NEITHER of.
    t.db.update(t.schema.trades).set({ mtfInterest: 12, pledgeCharges: 3, chargesTotal: Math.round((afterFirst.chargesTotal + 15) * 100) / 100, netPnl: Math.round((afterFirst.grossPnl - afterFirst.chargesTotal - 15) * 100) / 100 }).where(eq(t.schema.trades.id, tradeId)).run();
    const kept = row(tradeId)!;

    // The exit is re-priced: the sync owns this close, so the eight heads it
    // prices move with it — and the row is self-consistent again.
    const second = ipoPage("F11-IPO", F11_ACC);
    expect((await ipoRoute.POST(json("/api/ipos", saveBody(second, formHtml(second), { exitPrice: "200", exitDate: "2026-03-02" })))).status).toBe(200);
    const reprice = row(tradeId)!;
    const shown2 = ipoPage("F11-IPO", F11_ACC);
    // THE assertions (on revert of lib/analytics/ipo-link.ts' syncOwnsClose: the
    // holding's price and gross move onto the new exit while its charges stay
    // computed for the OLD one — /ipos reads one net, the Trades row another).
    expect([reprice.sellQty, reprice.avgSellPrice, reprice.grossPnl], "the new exit").toEqual([10, 200, 1000]);
    expect([reprice.mtfInterest, reprice.pledgeCharges], "the two heads the IPO never prices are kept verbatim").toEqual([12, 3]);
    expect(reprice.chargesTotal, "the heads still sum to the total the row states").toBe(
      Math.round(([reprice.brokerage, reprice.sttCtt, reprice.exchangeTxn, reprice.sebi, reprice.stampDuty, reprice.ipft, reprice.gst, reprice.dpCharges, reprice.mtfInterest, reprice.pledgeCharges].reduce((s, x) => s + x, 0)) * 100) / 100,
    );
    expect(reprice.netPnl).toBe(Math.round((reprice.grossPnl - reprice.chargesTotal) * 100) / 100);
    expect(reprice.chargesTotal, "the old exit's bill is not left behind").not.toBe(kept.chargesTotal);
    // /ipos states the IPO's own net; the row states that net less the ₹15 of
    // interest and pledge fee it carries and the IPO never prices.
    expect([shown2.grossPnl, Math.round((shown2.netPnl - 15) * 100) / 100], "/ipos and the Trades row state one figure").toEqual([reprice.grossPnl, reprice.netPnl]);

    // A sale the USER recorded in Trades keeps every head (owner ruling F1).
    const userTrade = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: F11_ACC, broker: "zerodha", symbol: "F11-USER", tradingsymbol: "F11-USER", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10",
          sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500, brokerage: 20, chargesTotal: 20, netPnl: 480, isOpen: false,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F11_ACC, name: "F11-USER", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2019-01-10", tradeId: userTrade })
      .run();
    const userBefore = row(userTrade)!;
    const u = ipoPage("F11-USER", F11_ACC);
    const res = await ipoRoute.POST(json("/api/ipos", saveBody(u, formHtml(u), { notes: "the contract note's own charges" })));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect([row(userTrade)!.brokerage, row(userTrade)!.chargesTotal, row(userTrade)!.netPnl], "stored charges are never rewritten").toEqual([
      userBefore.brokerage, userBefore.chargesTotal, userBefore.netPnl,
    ]);
  });
});

// ============================================================================
// F12 — a stored ISIN canonicalised on BOTH sides (queries/trades.ts ↔ the
//       strategies page, I6) ↔ the card the client renders
// ============================================================================

describe("F12 · a holding whose stored ISIN is lower-case and padded (getOpenUnderlyingPositions → page groups → StrategiesClient → StrategyCard)", () => {
  beforeAll(async () => {
    StrategiesClient = (await import("@/components/strategies/strategies-client")).StrategiesClient;
    StrategyCard = (await import("@/components/strategies/strategy-card")).StrategyCard;
    strategiesPage = (await import("@/app/strategies/page")).default as () => unknown;
  }, 60_000);

  type Group = { key: string; symbol: string; nearestExpiry: string | null } & Record<string, unknown>;
  function cardsOf(accountId: number) {
    selectAccount(accountId);
    const el = findElem(strategiesPage(), (e) => e.type === StrategiesClient);
    if (!el) throw new Error("the strategies page no longer renders <StrategiesClient>");
    return (el.props.groups as Group[])
      .filter((g) => g.symbol === "NIFTYBEES")
      .map((g) => {
        const html = renderToStaticMarkup(React.createElement(StrategyCard, { group: g as never, chart: null }));
        const text = unescape(html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|"));
        const strikes = (g.legs as { kind: string; strike: number }[]).filter((l) => l.kind !== "UL").map((l) => l.strike).sort((a, b) => a - b).join("/");
        return { strikes, strategy: String(g.strategyId ?? ""), maxLoss: String((g.capLabel as { maxLoss?: string } | undefined)?.maxLoss ?? ""), unlimited: text.includes("Unlimited") };
      })
      // Both cards carry the same expiry and symbol, so the page's own order
      // between two accounts is the account order; the STRIKE names the card.
      .sort((a, b) => a.strikes.localeCompare(b.strikes));
  }

  it("its OWN account's view bounds the call it covers, and All accounts is the union of the single-account cards", () => {
    freezeAt("2026-09-08T09:30:00.000Z");
    const isin = bundledIsinBySymbol("NIFTYBEES")!;
    const padded = ` ${isin.toLowerCase()} `;
    expect(padded, "the fixture stores the canonical form and tests nothing").not.toBe(isin);
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({
          accountId: F12_B, broker: "angelone", bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NFO",
          symbol: "NIFTYBEES", tradingsymbol: "NIFTYBEES300CESEP26", optionType: "CE", strike: 300, expiry: "2026-09-24", isOpen: true, sellQty: 100, avgSellPrice: 5,
        }),
        tradeRow({
          accountId: F12_B, broker: "angelone", symbol: "Nippon India ETF Nifty BeES", tradingsymbol: "Nippon India ETF Nifty BeES",
          isin: padded, isOpen: true, buyQty: 100, avgBuyPrice: 280, buyDate: "2026-09-01",
        }),
        tradeRow({
          accountId: F12_A, broker: "angelone", bucket: "active", segment: "stock_option", instrumentType: "option", exchange: "NFO",
          symbol: "NIFTYBEES", tradingsymbol: "NIFTYBEES320CESEP26", optionType: "CE", strike: 320, expiry: "2026-09-24", isOpen: true, sellQty: 100, avgSellPrice: 4,
        }),
      ])
      .run();

    // THE assertion (on revert of lib/queries/trades.ts, whose ISIN branch
    // compared the column RAW: [{strategy:"short-call", unlimited:true}] — the
    // units the same account holds never reached the card, while on 0 another
    // account's ticker could still carry them in).
    const own = cardsOf(F12_B);
    expect(own, "the holding is found where it is held").toEqual([{ strikes: "300", strategy: "covered-call", maxLoss: "Computed at underlying = 0", unlimited: false }]);
    const other = cardsOf(F12_A);
    expect(other, "a call with no units of its own stays unbounded").toEqual([{ strikes: "320", strategy: "short-call", maxLoss: "Unlimited", unlimited: true }]);
    expect(cardsOf(0), "All accounts is each account's own card").toEqual([...own, ...other]);
  });
});

// ============================================================================
// F13 — an IPO linked to the source trade a merge DROPS as a duplicate
//       (K1, IN FLIGHT — the contract, not the build)
// ============================================================================

describe("F13 · a merge that drops a source trade as a duplicate, its IPO linked to it (account-delete.ts merge ↔ ipos.trade_id ↔ capital / tax / AIS)", () => {
  /**
   * WRITTEN AGAINST THE CONTRACT K1 WAS BUILDING WHILE THIS PASS RAN, so it was
   * expected RED. K1 landed its half of lib/queries/account-delete.ts during the
   * pass (the re-point at :783) and the case is GREEN as written — re-proved red
   * against that file at HEAD, which still nulls the link: "the IPO follows its
   * trade to the row that survived: expected [ 1719, null ] to deeply equal
   * [ 1719, 26 ]".
   *
   * J2's blocked[0] (a finding it did not fix, ruled into the K wave): a MERGE
   * double-counts a sale at merge time, before any restore. A source IPO linked
   * to a source trade the target already records has its holding deleted as a
   * duplicate; the IPO row then MOVES to the target unlinked while the target's
   * own copy of that trade stays, so the merged book counts one sale twice —
   * once as the trade's realised net, once as the IPO's own.
   *
   * The contract: a doomed DUPLICATE's `ipos.trade_id` is re-pointed at the
   * surviving TARGET row with the same (broker, dedup identity) — they are the
   * same trade, which is why the merge drops one — never nulled. Measured on
   * this fixture before K1: {eq: 497.94, ipo: 482.6, total: 980.54}.
   */
  it("the IPO follows its trade to the target's surviving copy, and the merged book counts that sale once", async () => {
    const capital = await import("@/lib/queries/capital");
    const sold = (accountId: number, name: string) =>
      t.db
        .insert(t.schema.trades)
        .values(
          tradeRow({
            accountId, broker: "zerodha", symbol: name, tradingsymbol: name, dedupHash: "f13-shared-identity",
            buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", buyOrderCount: 1,
            sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", sellOrderCount: 1,
            grossPnl: 500, chargesTotal: 2.06, netPnl: 497.94, isOpen: false,
          }),
        )
        .returning({ id: t.schema.trades.id })
        .get()!.id;
    const targetTrade = sold(F13_TGT, "F13-IPO");
    const sourceTrade = sold(F13_SRC, "F13-IPO");
    t.db
      .insert(t.schema.ipos)
      .values({ accountId: F13_SRC, name: "F13-IPO", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, exitDate: "2026-03-02", allotmentDate: "2019-01-10", tradeId: sourceTrade })
      .run();

    const res = accountDelete.deleteAccount({ accountId: F13_SRC, mode: "merge", targetId: F13_TGT, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    const ipo = t.db.select().from(t.schema.ipos).all().find((r) => r.name === "F13-IPO")!;
    expect([ipo.accountId, ipo.tradeId], "the IPO follows its trade to the row that survived").toEqual([F13_TGT, targetTrade]);
    selectAccount(F13_TGT);
    const cap = capital.getCapitalSummary();
    expect([cap.equityRealised, cap.ipoRealised, cap.totalRealised], "the merged book counts that sale once").toEqual([497.94, 0, 497.94]);
  });
});
