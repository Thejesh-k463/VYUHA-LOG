"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { applyColumnOrder, movableKeys, parseStoredOrder } from "@/lib/domain/column-order";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { moveIndex } from "@/components/layout/nav-config";
import { GripVertical } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { ManualTradeForm } from "./manual-trade-form";
import type { WriteAccountOption } from "@/components/system/write-account-picker";
import { CloseTradeDialog } from "./close-trade-dialog";
import { DeleteTradesDialog } from "./delete-trades-dialog";
import { DeleteScopeDialog } from "./delete-scope-dialog";
import { resolveDeleteScope, type DeletableTrade, type DeletePreview } from "@/lib/domain/delete-scope";
import { EditTradeDialog } from "./edit-trade-dialog";
import { StagedPanel } from "./staged-panel";
import { overrideTrade, deleteTrade } from "@/app/trades/actions";
import { num } from "@/lib/format";
import {
  BROKERS, BROKER_LABELS, SEGMENTS, SEGMENT_LABELS, EXCHANGES, BUCKETS, BUCKET_LABELS,
  type Segment,
} from "@/lib/domain/constants";
import { parseTradesQuery, serializeTradesQuery, type TradesQuery } from "@/lib/domain/trades-query";
import { todayIstIso } from "@/lib/domain/trading-day";
// SlimTrade, aliased: every `Trade` annotation below narrows to the wire
// projection (lib/domain/slim-trade.ts) without touching a single identifier.
// A column/filter/dialog reading a dropped field is now a COMPILE error.
import type { SlimTrade as Trade } from "@/lib/domain/slim-trade";
import { JournalDialog, type PlaybookOption } from "@/components/behavior/journal-dialog";
import { plannedRewardRisk } from "@/lib/risk/calculators";
import { entryExitPrices, investedSummary, tradeQty } from "@/lib/domain/trade-columns";
import {
  TRADE_VIEWS, countForView, type TradeView, type ViewCounts,
} from "@/lib/analytics/trade-status";
import { matchesTradeFilters, type TradeFilters } from "@/lib/domain/trades-filter";
// Rows per server page — the same constant lib/queries/trades-page.ts pages by,
// so the "Load N more" label can never advertise a page size the server does
// not use.
import { TRADES_PAGE_SIZE } from "@/lib/domain/trades-filter";
import {
  LOADED_COUNT_PREFIX, RELOADED_TO_FIRST_PAGE, SEARCH_DEBOUNCE_MS, WHOLE_BOOK_CAPTION,
  acceptsPage, appendPage, loadedScopeCaption, rowCountLabel,
} from "@/lib/domain/trades-paging";
import { Plus, Pencil, Printer, SquarePen, LogOut, Trash2, NotebookPen, Layers, Paperclip, Lock } from "lucide-react";

const pnlClass = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

/** Selection ids ride the report URL; ~500 seven-digit ids is the ceiling a
 *  URL carries reliably across servers and browsers. Beyond it the link
 *  truncates SILENTLY and the "report" drops rows without saying so. */
const PDF_EXPORT_ID_CAP = 500;

function daysBetween(a: string, b: string): number | null {
  const d1 = new Date(a + "T00:00:00").getTime();
  const d2 = new Date(b + "T00:00:00").getTime();
  if (Number.isNaN(d1) || Number.isNaN(d2)) return null;
  return Math.round((d2 - d1) / 86400000);
}

/** Per-device column order. Versioned so a future shape can be discarded
 *  rather than mis-read. */
const COL_ORDER_KEY = "vyuha-trades-column-order";
/** Row-select and Instrument are frozen while scrolling sideways: `select`
 *  declares the width the sticky maths reads, and the flexible-width allowance
 *  belongs to Instrument. Neither can be dragged. */
const PINNED_COLUMNS = 2;
/** Stable default so the derived Set below is not rebuilt every render. */
const NO_IDS: readonly number[] = [];

export function TradesClient({
  initialRows,
  initialCursor,
  initialTotal,
  initialViewCounts,
  initialFilters,
  bookTotal,
  unknownBasisIds = NO_IDS,
  playbooks = [],
  mtfMarginByBroker = {},
  writeAccounts = [],
  attachmentCounts = {},
  pro = true,
}: {
  /** THE FIRST SERVER PAGE — 500 rows, not the book (v3.9). The whole book
   *  used to cross the RSC stream here; /trades was the one route over the
   *  1,500 ms budget because of it. Later pages arrive from
   *  /api/trades/page, filtered by the SAME predicates in SQL. */
  initialRows: Trade[];
  /** Keyset cursor for the page after `initialRows`, or null if that was all. */
  initialCursor: string | null;
  /** Rows matching the initial filters ACROSS THE WHOLE BOOK — never a page count. */
  initialTotal: number;
  /** View counts over the whole filtered set, computed in SQL. */
  initialViewCounts: ViewCounts;
  /** The filters the server already applied — seeded from the deep-link query
   *  and the workspace default, so the first paint is already the right rows
   *  and the client does not have to re-fetch on mount. */
  initialFilters: TradeFilters;
  /** Rows in the account-scoped book, filters ignored — the "of N in the book"
   *  half of the row counter. */
  bookTotal: number;
  /** Ids of sales with no cost basis on record — the AcquisitionPanel's
   *  population, decided server-side by `hasKnownBasis`. `?basis=unknown`
   *  (Data Quality Center, import summary) filters the table to exactly these. */
  unknownBasisIds?: readonly number[];
  playbooks?: PlaybookOption[];
  /** eq_mtf own-margin % per broker (real leverage varies — Dhan/Groww ~25%,
   * Zerodha ~20%) — components look up the currently-selected/trade's broker. */
  mtfMarginByBroker?: Record<string, number>;
  /** Non-empty only in the aggregate view with 2+ accounts — see A6. */
  writeAccounts?: WriteAccountOption[];
  /** tradeId → screenshot count, for the row indicator. Server-computed in one
   *  grouped query so the badge never costs a query per row. */
  attachmentCounts?: Record<number, number>;
  /** Entitlement — gates the Pro-only "Open trade" entry point. */
  pro?: boolean;
}) {
  // IST, not UTC: this is the user's day (it seeds date defaults and the
  // "today" comparisons in the table), and after 05:30 IST a UTC date is
  // yesterday for every Indian trader. See lib/domain/trading-day.ts.
  const today = React.useMemo(() => todayIstIso(), []);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addOpenTrade, setAddOpenTrade] = React.useState(false);
  const [editing, setEditing] = React.useState<Trade | null>(null);
  const [journaling, setJournaling] = React.useState<Trade | null>(null);
  const [closingTrade, setClosingTrade] = React.useState<Trade | null>(null);
  const [fullEditing, setFullEditing] = React.useState<Trade | null>(null);
  const [staging, setStaging] = React.useState<Trade | null>(null);
  // Row selection for bulk delete. A Set of trade ids — cleared after a delete
  // and whenever the filters change (a hidden selected row is a trap).
  const [selected, setSelected] = React.useState<ReadonlySet<number>>(new Set());
  const [deleting, setDeleting] = React.useState(false);

  // Seeded from `initialFilters`, which the SERVER built from the same
  // deep-link query and the same workspace default — so the markup React
  // hydrates already carries these values and the first page it was sent is
  // already the right one. (Before v3.9 the filters were restored in a mount
  // microtask, which was fine when the client held the whole book and is not
  // fine when the server has to be told what to fetch.)
  /** The BOX's value — echoed instantly, so typing never stutters. */
  const [searchInput, setSearchInput] = React.useState(initialFilters.q);
  /** The value the FILTERS use, `SEARCH_DEBOUNCE_MS` behind the box: every
   *  keystroke used to be a `/api/trades/page` request over the whole book. */
  const [search, setSearch] = React.useState(initialFilters.q);
  React.useEffect(() => {
    if (searchInput === search) return;
    // setState inside a TIMER, not in the effect body — the house rule is
    // about a synchronous state-sync (AGENTS.md); a debounce has nowhere else
    // to live, and the box itself stays controlled by `searchInput`.
    const t = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, search]);
  const [broker, setBroker] = React.useState(initialFilters.broker);
  const [segment, setSegment] = React.useState(initialFilters.segment);
  const [bucket, setBucket] = React.useState<string>(initialFilters.bucket);
  /** Status + outcome in one control: open/closed/staged, and in-gain /
   *  in-loss / profit / loss. See lib/analytics/trade-status.ts for why an
   *  UNMARKED open position deliberately belongs to neither gain nor loss. */
  const [view, setView] = React.useState<TradeView>(initialFilters.view);
  // Date window, set by deep links from the KPI drill-downs (e.g. "worst day").
  const [from, setFrom] = React.useState(initialFilters.from);
  const [to, setTo] = React.useState(initialFilters.to);
  /** Set by a realised-P&L drill-down: restrict to closed trades so the rows
   *  reconcile exactly with the figure that was clicked. */
  const [realised, setRealised] = React.useState(initialFilters.realised);
  /** Set by the Data Quality Center's "Unknown acquisition cost" link:
   *  restrict to the sales the AcquisitionPanel above is asking about. */
  const [basisUnknown, setBasisUnknown] = React.useState(initialFilters.basisUnknown);
  const unknownBasisSet = React.useMemo(() => new Set(unknownBasisIds), [unknownBasisIds]);

  // Deep links — the contract lives in lib/domain/trades-query.ts. Two kinds:
  //   ?add=manual|open                          — opens a dialog (one-shot)
  //   ?symbol=&from=&to=&realised=&segment=&basis=&view=  — pre-filters the table
  //
  // The query is KEPT, not wiped. The old mount effect replaced the URL with
  // the bare pathname whenever any key was present, which made a filtered
  // view impossible to reload or re-enter and sent Back from /trades to the
  // page BEFORE the one the user came from. Now the URL mirrors the filters:
  // `syncUrl` rewrites it on every filter change (replaceState — no history
  // entry, so Back still returns to the previous page), and only the one-shot
  // `add` is stripped after its dialog opens.
  //
  // State is seeded in a microtask rather than synchronously — the repo's
  // sanctioned one-shot restore (AGENTS.md) — so the
  // react-hooks/set-state-in-effect rule is not silenced. Reading the URL on
  // render is not an option: the server has no `window`, and the input value
  // would mismatch on hydration.
  React.useEffect(() => {
    const q = parseTradesQuery(window.location.search);
    void Promise.resolve().then(() => {
      if (q.add === "manual") setAddOpen(true);
      else if (q.add === "open") setAddOpenTrade(true);
    });
    // Strip ONLY `add`: a reload must not re-open the dialog, but must keep
    // whatever filters rode along with it.
    if (q.add) window.history.replaceState(null, "", window.location.pathname + serializeTradesQuery({ ...q, add: null }));
  }, []);

  /** The current filters as the URL contract sees them. */
  const currentQuery = React.useCallback((): TradesQuery => ({
    add: null, symbol: search, from, to, realised, segment, basis: basisUnknown ? "unknown" : null, view,
  }), [search, from, to, realised, segment, basisUnknown, view]);

  /** Mirror a filter change into the URL. replaceState, never push: a filter
   *  tweak is not a place the user navigated to, so Back must not revisit it. */
  const syncUrl = React.useCallback((patch: Partial<TradesQuery>) => {
    window.history.replaceState(null, "", window.location.pathname + serializeTradesQuery({ ...currentQuery(), ...patch }));
  }, [currentQuery]);

  /** The filters, in the ONE shape both halves of the contract speak
   *  (lib/domain/trades-filter.ts). The server transcribes this to SQL. */
  const filters = React.useMemo<TradeFilters>(
    () => ({ q: search, broker, segment, bucket, view, realised, basisUnknown, from, to }),
    [search, broker, segment, bucket, view, realised, basisUnknown, from, to],
  );
  const filterKey = JSON.stringify(filters);

  // The server pages the table (v3.9).
  //
  // `page` holds what has been fetched SO FAR for the current filters, plus
  // the whole-set numbers around it. `total` and `viewCounts` are aggregates
  // over the entire filtered book — never over `rows` — because a count that
  // silently means "of the rows we happened to fetch" is a fabricated
  // denominator (invariant 6). The date window, the realised drill-down, the
  // view and the free text are all applied in SQL; the JS pass below is the
  // second opinion, not the filter.
  const [page, setPage] = React.useState<{ rows: Trade[]; cursor: string | null; total: number; viewCounts: ViewCounts }>(
    () => ({ rows: initialRows, cursor: initialCursor, total: initialTotal, viewCounts: initialViewCounts }),
  );
  /** "A page for these filters has not arrived yet" is DERIVED, never stored:
   *  it is exactly `servedKey !== filterKey`. Storing it would mean a
   *  setState inside the effect below, which is the one thing this repo does
   *  not do (AGENTS.md — a silenced react-hooks/set-state-in-effect broke this
   *  very component under the React Compiler). Only "load more" needs a flag,
   *  and that one is set in a click handler. */
  const [moreLoading, setMoreLoading] = React.useState(false);
  /** A refresh re-adopted page 1 while pages 2..n were on screen.
   *  It CANNOT be derived — "we used to have more rows than we have now" is a
   *  fact about the previous render, and nothing else on this screen records
   *  it. Set in the render-phase prop adjustment below, cleared by the next
   *  page or the next question. */
  const [reloadedToPage1, setReloadedToPage1] = React.useState(false);

  /** The QUERY half only. Every call site below spells the path out as a
   *  literal `/api/trades/page?…` prefix, which is what keeps this file out of
   *  tests/egress-guard.test.ts's DYNAMIC_URL_CALL_SITES: the host is readable
   *  off the call, and there isn't one. */
  const pageQuery = React.useCallback((f: TradeFilters, cursor: string | null, mode?: string) => {
    const p = new URLSearchParams();
    if (f.q.trim()) p.set("q", f.q.trim());
    if (f.broker) p.set("broker", f.broker);
    if (f.segment) p.set("segment", f.segment);
    if (f.bucket) p.set("bucket", f.bucket);
    if (f.view !== "all") p.set("view", f.view);
    if (f.realised) p.set("realised", "1");
    if (f.basisUnknown) p.set("basis", "unknown");
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
    if (cursor) p.set("cursor", cursor);
    if (mode) p.set("mode", mode);
    return p.toString();
  }, []);

  // The server already rendered page 1 for `initialFilters`, so the first run
  // of the effect below must NOT refetch it — `servedKey` starts on that key.
  const initialKey = JSON.stringify(initialFilters);
  const [servedKey, setServedKey] = React.useState(initialKey);

  /**
   * A SERVER REFRESH REPLACES THE PAGE — the account switcher, and every
   * server action on this screen.
   *
   * `initialRows` is a `useState` initialiser, and an initialiser does not run
   * again when the prop changes. So after `router.refresh()` (switching
   * accounts, saving an edit, deleting a trade) the table would have gone on
   * rendering the PREVIOUS server render's rows for ever — the account
   * switcher would change the KPI strip and leave the journal below it showing
   * another book. Found by e2e (`v297-surfaces`: expected 0 rows in the empty
   * second account, got the first account's 125).
   *
   * Adjusted DURING RENDER, the React-sanctioned way to react to a changed
   * prop — not in an effect, which is the rule this repo learned the hard way
   * (AGENTS.md: never silence react-hooks/set-state-in-effect).
   */
  const [servedRows, setServedRows] = React.useState(initialRows);
  if (servedRows !== initialRows) {
    setServedRows(initialRows);
    if (filterKey === initialKey) {
      // The filters on screen are the ones the server just answered: adopt it.
      setPage({ rows: initialRows, cursor: initialCursor, total: initialTotal, viewCounts: initialViewCounts });
      setServedKey(initialKey);
      // Losing pages 2..n to a refresh is invisible otherwise: the table just
      // gets shorter while the counter still says the same total.
      setReloadedToPage1(page.rows.length > initialRows.length);
    } else {
      // The user has since changed a filter, so the fresh server page is for
      // the wrong question — ask again for the right one.
      setServedKey("");
    }
  }

  React.useEffect(() => {
    if (servedKey === filterKey) return;
    const f = JSON.parse(filterKey) as TradeFilters;
    let cancelled = false;
    // NOTHING is set before the await: the table keeps showing the rows it has
    // until the new page actually arrives, which is the StagedPanel lesson
    // (AGENTS.md) applied to a much bigger fetch.
    void fetch(`/api/trades/page?${pageQuery(f, null)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j?.ok) return;
        setPage({ rows: j.rows as Trade[], cursor: j.nextCursor, total: j.total, viewCounts: j.viewCounts });
        setServedKey(filterKey);
        setReloadedToPage1(false);
      });
    return () => { cancelled = true; };
  }, [servedKey, filterKey, pageQuery]);

  /** True while the rows on screen answer a question the user has moved on
   *  from — derived from the two keys, not tracked. */
  const loading = servedKey !== filterKey || moreLoading;

  /** The two keys as they stand WHEN A RESPONSE LANDS. A `.then` closure holds
   *  the values from the moment it was created, which is exactly the stale
   *  reading the guard exists to reject. Written in an effect (a ref write, no
   *  state), which has long flushed by the time a network reply arrives. */
  const keysRef = React.useRef({ servedKey, filterKey });
  React.useEffect(() => { keysRef.current = { servedKey, filterKey }; }, [servedKey, filterKey]);

  /** Set when a `router.refresh()` (account switch, save, delete) or a filter
   *  change lands while a "load more" is in flight — the response is then for
   *  a scope nobody is looking at any more and must not append. Same shape as
   *  the filter effect's `cancelled`, which had this guard from the start. */
  const moreCancelled = React.useRef(false);
  React.useEffect(() => {
    // A new question, or a new server render: whatever is in flight is stale.
    moreCancelled.current = true;
  }, [filterKey, servedRows]);

  const loadMore = React.useCallback(() => {
    if (!page.cursor || servedKey !== filterKey || moreLoading) return;
    setMoreLoading(true);
    // The key this page is being fetched FOR. `acceptsPage` compares it with
    // the keys that hold when the response lands.
    const requestedKey = filterKey;
    moreCancelled.current = false;
    const f = JSON.parse(filterKey) as TradeFilters;
    void fetch(`/api/trades/page?${pageQuery(f, page.cursor)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        // Without this the PREVIOUS scope's rows 501-1000 appended onto the
        // new scope's page 1 and its total/viewCounts overwrote the new ones —
        // two books in one table, nothing on screen looking broken
        // (lib/domain/trades-paging.ts, invariant 8).
        if (!acceptsPage({ requestedKey, servedKey: keysRef.current.servedKey, filterKey: keysRef.current.filterKey, cancelled: moreCancelled.current }, j)) return;
        // Append, never replace: the keyset order is TOTAL as of v3.9, so a
        // page boundary can neither repeat a row nor skip one.
        setPage((prev) => appendPage(prev, j));
        setReloadedToPage1(false);
      })
      .finally(() => setMoreLoading(false));
  }, [page.cursor, servedKey, filterKey, moreLoading, pageQuery]);

  /**
   * The rows the table renders.
   *
   * The server has already applied every one of these predicates in SQL, so
   * this pass is a no-op — and `tests/trades-page-parity.test.ts` is what says
   * so, id for id, on every view and every filter. It stays because the two
   * halves must agree: if a future edit ever makes the SQL WIDER than the
   * filter, the table narrows rather than showing a row the user excluded.
   */
  const data = React.useMemo(
    () => page.rows.filter((t) => matchesTradeFilters(t, filters, (id) => unknownBasisSet.has(id))),
    [page.rows, filters, unknownBasisSet],
  );

  // A selection that outlives its filter would let "delete selected" remove
  // rows the user can no longer see. Visible-set changes reset it.
  // Selection is PRUNED against the visible rows at render time, never synced
  // by an effect. The first version reset it with setState inside a
  // useEffect keyed on the filters — and silencing the
  // react-hooks/set-state-in-effect rule to do so broke this page under the
  // React Compiler: the view select simply stopped receiving changes. The rule
  // was right. Deriving gives the same safety with no state to keep honest:
  // a selected row that a filter hides stops counting and cannot be deleted,
  // because every consumer below reads the intersection, not the raw set.
  const dataIds = React.useMemo(() => new Set(data.map((t) => t.id)), [data]);
  const visibleSelected = React.useMemo(
    () => new Set([...selected].filter((id) => dataIds.has(id))),
    [selected, dataIds],
  );


  const toDeletable = React.useCallback((t: Trade): DeletableTrade => ({
    id: t.id, accountId: t.accountId, broker: t.broker, segment: t.segment,
    symbol: t.symbol, tradingsymbol: t.tradingsymbol, buyDate: t.buyDate,
    sellDate: t.sellDate, isOpen: t.isOpen, netPnl: t.netPnl,
    importBatchId: t.importBatchId, createdAt: t.createdAt, staged: t.staged,
  }), []);

  const deletePreview = React.useMemo(() => {
    if (visibleSelected.size === 0) return null;
    return resolveDeleteScope(data.map(toDeletable), { kind: "ids", ids: [...visibleSelected] });
  }, [visibleSelected, data, toDeletable]);

  // "Delete by…" — the scopes the engine has always understood but nothing
  // could reach. Its candidates are the WHOLE account-scoped book, not `data`:
  // a date-range delete must be able to name a trade the current filter is
  // hiding, or the count it shows is not the truth about that range.
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const [scoped, setScoped] = React.useState<{ preview: DeletePreview; reason: string } | null>(null);
  /**
   * The chooser's two whole-book lists, fetched WHEN THE DIALOG OPENS.
   *
   * Neither can come from the rendered page and stay honest: a date-range
   * delete must be able to name a trade the current filter is hiding, and
   * "delete this view" must mean every row the view matches, not the 500 that
   * happen to be on screen. Before v3.9 both were free because the client held
   * the whole book; now they are one request, paid only by the user who opens
   * the dialog.
   */
  const [scopeData, setScopeData] = React.useState<{ candidates: DeletableTrade[]; viewIds: number[] } | null>(null);
  React.useEffect(() => {
    if (!scopeOpen) return;
    let cancelled = false;
    const f = JSON.parse(filterKey) as TradeFilters;
    void fetch(`/api/trades/page?${pageQuery(f, null, "scope")}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j?.ok) return;
        setScopeData({ candidates: j.candidates as DeletableTrade[], viewIds: j.viewIds as number[] });
      });
    return () => { cancelled = true; };
  }, [scopeOpen, filterKey, pageQuery]);
  const allDeletable = React.useMemo(() => scopeData?.candidates ?? [], [scopeData]);
  const viewIds = React.useMemo(() => scopeData?.viewIds ?? [], [scopeData]);
  const viewLabel = React.useMemo(() => {
    const bits = [
      TRADE_VIEWS.find((v) => v.value === view)?.label ?? "All trades",
      broker && (BROKER_LABELS[broker as keyof typeof BROKER_LABELS] ?? broker),
      segment && (SEGMENT_LABELS[segment as Segment] ?? segment),
      search.trim() && `“${search.trim()}”`,
      from && to ? `${from} → ${to}` : from ? `from ${from}` : to ? `to ${to}` : "",
      realised && "realised only",
      basisUnknown && "unknown basis",
    ].filter(Boolean);
    return bits.join(" · ");
  }, [view, broker, segment, search, from, to, realised, basisUnknown]);

  /**
   * Counts for the dropdown, computed AFTER the other filters but BEFORE the
   * view itself — so each option shows how many rows choosing it would give,
   * rather than how many exist in the whole book.
   */
  /**
   * Counts for the dropdown, computed AFTER the other filters but BEFORE the
   * view itself — so each option shows how many rows choosing it would give,
   * rather than how many exist in the whole book.
   *
   * Computed in SQL as of v3.9 (`getViewCounts`, one aggregate query over the
   * whole filtered book) rather than by counting an array the client no longer
   * holds. Counting the fetched PAGE here would have been the silent bug this
   * whole change had to avoid: every option would have read "≤ 500".
   */
  const viewCounts = page.viewCounts;

  // ── User-ordered columns ────────────────────────────────────────────────
  //
  // Per-device chrome, like the sidebar order: it lives in localStorage and so
  // does NOT travel in a backup. The first two columns (row select, Instrument)
  // are frozen — `applyColumnOrder` slices them off before reordering, so no
  // stored value can move them.
  // Derived, not effect-hydrated: a mount effect never lands on a full page
  // load, which is every desktop launch. See use-stored-value.ts.
  const rawOrder = useStoredValue(COL_ORDER_KEY);
  const colOrder = React.useMemo(() => parseStoredOrder(rawOrder), [rawOrder]);

  const columns = React.useMemo<ColumnDef<Trade, unknown>[]>(() => [
    {
      id: "select",
      enableSorting: false,
      // Fixed width so the pinned Instrument column knows its left offset.
      meta: { width: 36 },
      header: () => (
        <input
          type="checkbox"
          aria-label="Select all visible trades"
          className="size-3.5 accent-[var(--color-loss)]"
          checked={data.length > 0 && visibleSelected.size === data.length}
          ref={(el) => { if (el) el.indeterminate = visibleSelected.size > 0 && visibleSelected.size < data.length; }}
          onChange={(e) => setSelected(e.target.checked ? new Set(data.map((t) => t.id)) : new Set())}
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={`Select ${row.original.symbol}`}
          className="size-3.5 accent-[var(--color-loss)]"
          checked={visibleSelected.has(row.original.id)}
          onChange={(e) => {
            setSelected((prev) => {
              const next = new Set(prev);
              if (e.target.checked) next.add(row.original.id); else next.delete(row.original.id);
              return next;
            });
          }}
        />
      ),
    },
    {
      accessorKey: "symbol",
      header: "Instrument",
      cell: ({ row }) => {
        const t = row.original;
        const isDerivative = t.instrumentType === "option" || t.instrumentType === "future";
        // Same buyQty/sellQty convention as /strategies and /risk: whichever leg
        // carries the open quantity decides direction (short = sell-to-open).
        const isShort = isDerivative && t.isOpen && t.sellQty > t.buyQty;
        const qty = Math.abs(t.buyQty - t.sellQty) || Math.max(t.buyQty, t.sellQty);
        const lots = t.lotSize && t.lotSize > 0 ? Math.round(qty / t.lotSize) : null;
        const dte = t.isOpen && t.expiry ? daysBetween(today, t.expiry) : null;
        return (
          // Capped as well as floored: one long option tradingsymbol used to
          // set the column width for every row and shove the P&L columns off
          // screen. The full name still surfaces via the title tooltip.
          <div className="min-w-[170px] max-w-[230px]" title={t.tradingsymbol}>
            <div className="flex items-center gap-1.5">
              {/* min-w-0: a flex item refuses to shrink below its content,
                  so truncate never fires without it. */}
              <span className="min-w-0 truncate font-medium">{t.symbol}</span>
              {isDerivative && t.isOpen && (
                <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${isShort ? "bg-loss/15 text-loss" : "bg-profit/15 text-profit"}`}>
                  {isShort ? "Short" : "Long"}
                </span>
              )}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {t.optionType
                ? [
                    `${t.strike} ${t.optionType}`,
                    t.expiry ? `exp ${t.expiry}` : null,
                    dte != null ? (dte < 0 ? "expired" : `${dte}d`) : null,
                    lots ? `${lots} lot${lots === 1 ? "" : "s"}` : null,
                  ].filter(Boolean).join(" · ")
                : t.tradingsymbol.slice(0, 28)}
            </div>
          </div>
        );
      },
    },
    { accessorKey: "broker", header: "Broker", cell: ({ getValue }) => <Badge variant="secondary">{BROKER_LABELS[getValue() as never] ?? String(getValue())}</Badge> },
    { accessorKey: "segment", header: "Segment", cell: ({ getValue }) => <span className="text-muted-foreground">{SEGMENT_LABELS[getValue() as Segment]}</span> },
    { accessorKey: "exchange", header: "Exch" },
    // Qty / Invested / Entry / Exit replaced the raw Buy / Sell value totals:
    // a trader reads a row as "how many, at what, for how much" — the maths
    // lives in lib/domain/trade-columns.ts. Missing sides come back as
    // `undefined` (not 0, not null) so `sortUndefined: "last"` keeps open rows
    // at the bottom of an Exit sort and the cell renders "—".
    { id: "qty", header: "Qty", meta: { align: "right" }, accessorFn: (t) => tradeQty(t), cell: ({ getValue }) => num(getValue() as number, 0) },
    {
      id: "invested", header: "Invested", meta: { align: "right" },
      accessorFn: (t) => investedSummary(t).amount,
      cell: ({ row }) => {
        const s = investedSummary(row.original);
        return (
          <div title={s.hint ?? undefined}>
            <div>{num(s.amount, 0)}</div>
            {s.mtf && s.hint && (
              <div className="text-[10px] text-muted-foreground">
                {s.ownPct == null ? "MTF · unresolved" : `MTF · ${s.ownPct}% own`}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "entryPrice", header: "Entry", meta: { align: "right" }, sortUndefined: "last",
      accessorFn: (t) => entryExitPrices(t).entry ?? undefined,
      cell: ({ getValue }) => { const v = getValue() as number | undefined; return v == null ? <span className="text-muted-foreground/50">—</span> : num(v, 2); },
    },
    {
      id: "exitPrice", header: "Exit", meta: { align: "right" }, sortUndefined: "last",
      accessorFn: (t) => entryExitPrices(t).exit ?? undefined,
      cell: ({ getValue }) => { const v = getValue() as number | undefined; return v == null ? <span className="text-muted-foreground/50">—</span> : num(v, 2); },
    },
    { accessorKey: "grossPnl", header: "Gross", meta: { align: "right" }, cell: ({ getValue }) => <span className={pnlClass(getValue() as number)}>{num(getValue() as number, 0)}</span> },
    { accessorKey: "chargesTotal", header: "Charges", meta: { align: "right" }, cell: ({ getValue }) => <span className="text-muted-foreground">{num(getValue() as number, 0)}</span> },
    { accessorKey: "mtfInterest", header: "MTF int.", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number; return v > 0 ? <span className="text-warning">{num(v, 0)}</span> : <span className="text-muted-foreground/50">—</span>; } },
    { accessorKey: "netPnl", header: "Net", meta: { align: "right" }, cell: ({ getValue }) => <span className={`font-medium ${pnlClass(getValue() as number)}`}>{num(getValue() as number, 0)}</span> },
    { accessorKey: "rMultiple", header: "R", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : <span className={pnlClass(v)}>{v.toFixed(2)}R</span>; } },
    {
      id: "targetRR", header: "Target R:R", meta: { align: "right" },
      cell: ({ row }) => {
        const t = row.original;
        const isShort = t.sellQty > t.buyQty;
        const entry = isShort ? t.avgSellPrice : t.avgBuyPrice;
        const v = plannedRewardRisk(entry, t.slPlanned, t.targetPlanned);
        return v == null ? "—" : `1:${v.toFixed(2)}`;
      },
    },
    {
      id: "status", header: "Status",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.isOpen ? <Badge variant="warning">open</Badge> : <Badge variant="secondary">closed</Badge>}
          {row.original.setupTag && <Badge variant="accent">{row.original.setupTag}</Badge>}
        </div>
      ),
    },
    {
      id: "actions", header: "",
      cell: ({ row }) => {
        const journalLabel = attachmentCounts[row.original.id]
          ? `Journal — ${attachmentCounts[row.original.id]} chart screenshot${attachmentCounts[row.original.id] === 1 ? "" : "s"}, playbook, emotion, mistakes`
          : "Journal — playbook, emotion, mistakes (attach chart screenshots here)";
        const stagedLabel = row.original.staged ? "Staged position — entry ladder, partial exits" : "Build in tranches / book a partial exit";
        return (
        <div className="flex items-center gap-1">
          {/* Screenshots live inside the journal dialog, so the journal button
              carries their indicator: a count badge means "there are charts in
              here". Without it a trade with screenshots looked identical to
              one without, and the feature was invisible from the table. */}
          <Tip label={journalLabel}>
            <Button
              size="icon"
              variant="ghost"
              className={`relative size-7 ${(row.original.mistakeTags?.length || row.original.playbookId != null || row.original.emotionTag) ? "text-accent" : ""}`}
              onClick={() => setJournaling(row.original)}
              aria-label={journalLabel}
            >
              <NotebookPen className="size-3.5" />
              {attachmentCounts[row.original.id] > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex items-center gap-px rounded-full bg-primary px-1 text-[8px] font-semibold leading-[13px] text-primary-foreground">
                  <Paperclip className="size-2" />
                  {attachmentCounts[row.original.id]}
                </span>
              )}
            </Button>
          </Tip>
          <Tip label={stagedLabel}>
            <Button
              size="icon"
              variant="ghost"
              className={`size-7 ${row.original.staged ? "text-primary" : ""}`}
              onClick={() => setStaging(row.original)}
              aria-label={stagedLabel}
            >
              <Layers className="size-3.5" />
            </Button>
          </Tip>
          {row.original.isOpen && (
            <Tip label="Close position">
              <Button size="icon" variant="ghost" className="size-7 text-warning" onClick={() => setClosingTrade(row.original)} aria-label="Close position">
                <LogOut className="size-3.5" />
              </Button>
            </Tip>
          )}
          <Tip label="Edit trade — qty/prices/dates/SL/target/risk">
            <Button size="icon" variant="ghost" className="size-7" onClick={() => setFullEditing(row.original)} aria-label="Edit trade — qty/prices/dates/SL/target/risk">
              <SquarePen className="size-3.5" />
            </Button>
          </Tip>
          <Tip label="Re-tag / override">
            <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(row.original)} aria-label="Re-tag / override">
              <Pencil className="size-3.5" />
            </Button>
          </Tip>
          <form action={deleteTrade}>
            <input type="hidden" name="tradeId" value={row.original.id} />
            <Tip label="Delete">
              <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-loss" aria-label="Delete"
                onClick={(e) => { if (!confirm("Delete this trade?")) e.preventDefault(); }}>
                <Trash2 className="size-3.5" />
              </Button>
            </Tip>
          </form>
        </div>
        );
      },
    },
  ], [today, data, visibleSelected, attachmentCounts]);

  // Reorder the ARRAY, never TanStack's `columnOrder`: DataTable reads the raw
  // prop positionally for its width budget and sticky offsets, and those would
  // silently describe the old layout.
  const orderedColumns = React.useMemo(
    () => applyColumnOrder(columns, colOrder, PINNED_COLUMNS),
    [columns, colOrder],
  );

  // The write IS the state change — `writeStored` re-renders every reader of
  // the key, so there is no second copy of this in React state to fall out of
  // step with storage.
  const reorderColumns = React.useCallback((from: number, to: number) => {
    // Read the CURRENT rendering order, not the stored one: an array saved
    // before a release added a column no longer matches the indices the drag
    // just produced.
    const current = movableKeys(applyColumnOrder(columns, colOrder, PINNED_COLUMNS), PINNED_COLUMNS);
    const next = moveIndex(current, from, to);
    writeStored(COL_ORDER_KEY, JSON.stringify({ v: 1, order: next }));
  }, [columns, colOrder]);

  const resetColumns = React.useCallback(() => writeStored(COL_ORDER_KEY, null), []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search symbol / setup…" value={searchInput} onChange={(e) => { setSearchInput(e.target.value); syncUrl({ symbol: e.target.value }); }} className="h-8 w-56" />
        <Select value={broker} onChange={(e) => setBroker(e.target.value)} className="h-8 w-32">
          <option value="">All brokers</option>
          {BROKERS.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
        </Select>
        <Select value={segment} onChange={(e) => { setSegment(e.target.value); syncUrl({ segment: e.target.value }); }} className="h-8 w-44">
          <option value="">All segments</option>
          {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
        </Select>
        <Select value={bucket} onChange={(e) => setBucket(e.target.value)} className="h-8 w-36">
          <option value="">All buckets</option>
          {BUCKETS.map((b) => <option key={b} value={b}>{BUCKET_LABELS[b]}</option>)}
        </Select>
        {/* Status AND outcome in one control. Each option carries the count it
            would return, so an empty result is visible before it is chosen. */}
        <Select
          value={view}
          onChange={(e) => { const v = e.target.value as TradeView; setView(v); syncUrl({ view: v }); }}
          className="h-8 w-56"
          title="Filter by status (open / closed / staged) or by result"
        >
          <option value="all">All trades ({viewCounts.all})</option>
          <optgroup label="Status">
            {TRADE_VIEWS.filter((v) => v.group === "Status").map((v) => (
              <option key={v.value} value={v.value}>
                {v.label} ({countForView(viewCounts, v.value)})
              </option>
            ))}
          </optgroup>
          <optgroup label="Outcome">
            {TRADE_VIEWS.filter((v) => v.group === "Outcome").map((v) => (
              <option key={v.value} value={v.value}>
                {v.label} ({countForView(viewCounts, v.value)})
              </option>
            ))}
          </optgroup>
        </Select>
        {/* Filters that arrive ONLY by deep link have no control of their own,
            and since the URL now keeps them across a reload, each needs a
            visible way out — an invisible filter reads as missing trades. */}
        {(from || to) && (
          <button
            type="button"
            title="Clear the date window"
            onClick={() => { setFrom(""); setTo(""); syncUrl({ from: "", to: "" }); }}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card-hover px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {from && to && from === to ? from : `${from || "…"} → ${to || "…"}`} ×
          </button>
        )}
        {realised && (
          <button
            type="button"
            title="Realised P&L drill-down — closed trades only. Click to clear."
            onClick={() => { setRealised(false); syncUrl({ realised: false }); }}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card-hover px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Realised only ×
          </button>
        )}
        {basisUnknown && (
          <button
            type="button"
            title="Sales with no cost basis on record — the ones the panel above asks about. Click to clear."
            onClick={() => { setBasisUnknown(false); syncUrl({ basis: null }); }}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-warning/50 bg-warning/10 px-2 text-xs text-warning"
          >
            Unknown basis only ×
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* NUMBER FIRST, deliberately. Four e2e specs read this counter with
              /^(\d+)/ and /of\s+(\d+)/ — it is the pin that the figure on
              screen is the whole FILTERED population and not the fetched page,
              which is exactly the thing server pagination could break in
              silence. `page.total` is a SQL count over the filtered book. */}
          <span className="text-xs text-muted-foreground">
            {/* "Loaded" sits OUTSIDE the counter node. The bare "N of M" is its
                own text node: z-remove-broker.spec.ts matches it ANCHORED
                (/^\d+ of \d+$/) and trade-views.spec.ts reads its SECOND
                number, so anything appended inside the same node breaks both
                pins — while the word itself is what makes the figure honest,
                because the first number is the LOADED page, not the result. */}
            {LOADED_COUNT_PREFIX}{" "}
            <span>{rowCountLabel(data.length, page.total)}</span>
            {page.total !== bookTotal && <> · {bookTotal} in the book</>}
          </span>
          {/* The KPI strip above /trades is whole-book by design (app/trades/page.tsx);
              the table under it is filtered. Two true numbers that disagree read
              as one wrong number unless the screen says which is which. */}
          <span className="text-xs text-muted-foreground" data-testid="trades-kpi-scope">{WHOLE_BOOK_CAPTION}</span>
          {page.cursor && (
            <Button size="sm" variant="ghost" className="text-xs" onClick={loadMore} disabled={loading}>
              {loading ? "Loading…" : `Load ${Math.min(TRADES_PAGE_SIZE, page.total - data.length)} more`}
            </Button>
          )}
          {/* An invisible affordance is not a feature: the grip only appears on
              hover, so the table has to say it is there. */}
          <span className="hidden items-center gap-1 text-xs text-muted-foreground xl:inline-flex">
            <GripVertical className="size-3 opacity-50" /> drag a column header to reorder
          </span>
          {colOrder && (
            <Tip label="Restore the default column order on this device">
              <Button size="sm" variant="ghost" className="text-xs" onClick={resetColumns}>
                Reset columns
              </Button>
            </Tip>
          )}
          <Tip label="Delete by date range, this view, broker, trade type or a day's hand-entered trades">
            <Button size="sm" variant="ghost" className="text-xs" onClick={() => setScopeOpen(true)}>
              <Trash2 className="size-3.5 text-loss" /> Delete by…
            </Button>
          </Tip>
          {/* Pro: tracking a LIVE position (SL/TSL/target, risk, Portfolio Risk
              feed) is the forward-looking half of the journal. Recording a
              completed trade stays free — the user's own record of what they
              did is never held hostage (invariant 7). Locked, not hidden: the
              button says what it unlocks rather than disappearing. */}
          {!pro ? (
            <Tip label="Pro — tracking live positions with SL/target and risk. Recording closed trades stays free.">
              {/* Client-side Link, not window.location: a full-document
                  navigation inside the Tauri shell reboots the whole app and
                  discards column order, filters and selection. */}
              <Button size="sm" variant="secondary" asChild>
                <Link href="/settings#license">
                  <Lock className="size-3.5" /> Open trade
                </Link>
              </Button>
            </Tip>
          ) : (
          <Dialog open={addOpenTrade} onOpenChange={setAddOpenTrade}>
            <DialogTrigger asChild>
              <Button size="sm" variant="secondary"><Plus className="size-4" /> Open trade</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add open trade</DialogTitle>
                <DialogDescription>A running position (no exit yet) with SL / TSL / target — appears in Portfolio Risk.</DialogDescription>
              </DialogHeader>
              <ManualTradeForm mode="open" onDone={() => setAddOpenTrade(false)} mtfMarginByBroker={mtfMarginByBroker} writeAccounts={writeAccounts} />
            </DialogContent>
          </Dialog>
          )}
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="size-4" /> Add trade</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add trade</DialogTitle>
                <DialogDescription>Auto-classified with a live charge preview as you type.</DialogDescription>
              </DialogHeader>
              <ManualTradeForm onDone={() => setAddOpen(false)} mtfMarginByBroker={mtfMarginByBroker} writeAccounts={writeAccounts} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Why a gain/loss view can return fewer rows than "Open".

          An open position with no mark price has NO unrealised result — Vyuha
          stores 0 for it, and reading that 0 as breakeven would file the
          holding under a result it never had. So unmarked positions appear
          under the STATUS views and in neither outcome view, and the count is
          stated here rather than left as a silent gap. */}
      {(view === "open-gain" || view === "open-loss") && viewCounts.openUnmarked > 0 && (
        <p className="-mt-1 text-xs text-muted-foreground">
          <b className="text-warning">{viewCounts.openUnmarked}</b> open position
          {viewCounts.openUnmarked === 1 ? " has" : "s have"} no mark price, so {viewCounts.openUnmarked === 1 ? "it is" : "they are"}{" "}
          in neither gain nor loss — an unmarked position has no unrealised result to judge. Set a
          mark on <a className="underline" href="/risk">Portfolio Risk</a>, or choose{" "}
          <b className="text-foreground">Open</b> above to see every open position.
        </p>
      )}

      <Card className="p-0">
        {visibleSelected.size > 0 && deletePreview && (
          <div className="flex items-center justify-between rounded-lg border border-loss/40 bg-loss/5 px-3 py-2 text-xs">
            <span>
              <b>{visibleSelected.size}</b> selected · net {num(deletePreview.netPnl)} · {deletePreview.open} open
            </span>
            <span className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
              {/* Print-ready report of exactly these rows; the route re-checks
                  every id against the account-scoped journal. Locked, not
                  hidden, when unlicensed — opening a new tab whose entire
                  content is a paywall rendered inside the PRINT layout was the
                  old behaviour, and it read as a bug, not an offer. The page's
                  own <ProGate> stays as the enforcement for a typed URL. */}
              {pro ? (
                visibleSelected.size > PDF_EXPORT_ID_CAP ? (
                  // The ids travel in the URL; past ~500 seven-digit ids the
                  // link exceeds what servers/browsers reliably accept and
                  // FAILS SILENTLY — rows quietly vanish from the "report".
                  // A refused button with a reason beats a truncated PDF that
                  // looks complete (invariant 6 in UI form).
                  <Tip label={`PDF export carries the selection in the link, which holds up to ${PDF_EXPORT_ID_CAP} trades reliably. For more, use the Monthly report or the free CSV export.`}>
                    <Button size="sm" variant="outline" disabled>
                      <Printer className="mr-1 size-3.5" /> Export PDF (max {PDF_EXPORT_ID_CAP})
                    </Button>
                  </Tip>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.open(`/trades/report?ids=${[...visibleSelected].join(",")}`, "_blank")}
                  >
                    <Printer className="mr-1 size-3.5" /> Export PDF ({visibleSelected.size})
                  </Button>
                )
              ) : (
                <Tip label="Pro — print-ready PDF of any selection. CSV/JSON export stays free.">
                  <Button size="sm" variant="outline" asChild>
                    <Link href="/settings#license">
                      <Lock className="mr-1 size-3.5" /> Export PDF
                    </Link>
                  </Button>
                </Tip>
              )}
              <Button size="sm" variant="destructive" onClick={() => setDeleting(true)}>
                <Trash2 className="mr-1 size-3.5" /> Delete selected…
              </Button>
            </span>
          </div>
        )}
        <DataTable
          columns={orderedColumns}
          data={data}
          stickyColumns={PINNED_COLUMNS}
          onReorder={reorderColumns}
          virtual
          emptyMessage="No trades yet — import a broker file or add one manually."
        />
        {/* Sorting and selection run over `data` — the rows FETCHED so far —
            because TanStack's getSortedRowModel (components/ui/data-table.tsx)
            sees exactly that array, while the counter and the view dropdown
            are SQL aggregates over the whole filtered book. Both halves are
            right; a screen showing them together without saying so is not. */}
        <p className="px-3 pb-2 text-xs text-muted-foreground" data-testid="trades-scope-caption">
          {loadedScopeCaption(page.total)}
          {reloadedToPage1 && <> · {RELOADED_TO_FIRST_PAGE}</>}
        </p>
        <DeleteTradesDialog
          preview={deletePreview}
          reason="selected in the trades table"
          open={deleting}
          onOpenChange={setDeleting}
          onDone={() => setSelected(new Set())}
        />
      </Card>

      {/* Chooser, then the same confirmation every other delete passes
          through. The chooser closes as the confirmation opens, so there is
          never a scope control sitting behind a confirm dialog for the user to
          change under it. */}
      <DeleteScopeDialog
        candidates={allDeletable}
        viewIds={viewIds}
        viewLabel={viewLabel}
        open={scopeOpen}
        onOpenChange={setScopeOpen}
        onCommit={(preview, reason) => {
          setScopeOpen(false);
          setScoped({ preview, reason });
        }}
      />
      <DeleteTradesDialog
        preview={scoped?.preview ?? null}
        reason={scoped?.reason ?? ""}
        open={scoped != null}
        onOpenChange={(v) => !v && setScoped(null)}
        onDone={() => {
          setScoped(null);
          setSelected(new Set());
        }}
      />

      {/* Override dialog */}
      <Dialog open={!!journaling} onOpenChange={(o) => !o && setJournaling(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Trade journal — {journaling?.symbol}</DialogTitle>
            <DialogDescription>Playbook, emotion and mistakes feed the Discipline page rollups.</DialogDescription>
          </DialogHeader>
          {journaling && <JournalDialog trade={journaling} playbooks={playbooks} onDone={() => setJournaling(null)} />}
        </DialogContent>
      </Dialog>

      <Dialog open={!!staging} onOpenChange={(o) => !o && setStaging(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Staged position — {staging?.symbol}</DialogTitle>
            <DialogDescription>
              Build the position in tranches with a stop on each, and scale out in parts. Exits price
              against the blended average; R stays anchored to your first entry.
            </DialogDescription>
          </DialogHeader>
          {staging && <StagedPanel trade={staging} />}
        </DialogContent>
      </Dialog>

      <Dialog open={!!closingTrade} onOpenChange={(o) => !o && setClosingTrade(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close position — {closingTrade?.symbol}</DialogTitle>
            <DialogDescription>Exit price + date; charges and MTF interest recompute for the exact holding period.</DialogDescription>
          </DialogHeader>
          {closingTrade && <CloseTradeDialog trade={closingTrade} onDone={() => setClosingTrade(null)} />}
        </DialogContent>
      </Dialog>

      <Dialog open={!!fullEditing} onOpenChange={(o) => !o && setFullEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit trade — {fullEditing?.symbol}</DialogTitle>
            <DialogDescription>Quantities, prices, dates, SL/TSL/target, risk, MTF own-capital, tags and notes — any time.</DialogDescription>
          </DialogHeader>
          {fullEditing && <EditTradeDialog trade={fullEditing} onDone={() => setFullEditing(null)} mtfMarginByBroker={mtfMarginByBroker} />}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Re-tag trade</DialogTitle>
            <DialogDescription>{editing?.symbol} — overrides persist and re-apply on re-import.</DialogDescription>
          </DialogHeader>
          {editing && (
            <form action={overrideTrade} className="space-y-3">
              <input type="hidden" name="tradeId" value={editing.id} />
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Segment</Label>
                  <Select name="segment" defaultValue={editing.segment}>
                    {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Exchange</Label>
                  <Select name="exchange" defaultValue={editing.exchange}>
                    {EXCHANGES.map((x) => <option key={x} value={x}>{x}</option>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>MTF</Label>
                  <Select name="isMtf" defaultValue={editing.segment === "eq_mtf" ? "true" : "false"}>
                    <option value="false">No</option>
                    <option value="true">Yes (eq_mtf)</option>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Setup tag</Label>
                  <Input name="setupTag" defaultValue={editing.setupTag ?? ""} />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
                <DialogClose asChild><Button type="submit">Save & recompute</Button></DialogClose>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
