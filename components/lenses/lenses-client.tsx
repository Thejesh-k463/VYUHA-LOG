"use client";

/**
 * THE LENSES SCREEN — one book, six cuts, one page.
 *
 * A tab strip picks the cut; the panel below lists that cut's groups with the
 * performance of each; clicking a group drills into the trades behind it. The
 * point is isolation: when an import goes wrong, "what did THAT file produce?"
 * is one click, not a hand-built filter over the whole journal.
 *
 * ── No state is synced by an effect ─────────────────────────────────────────
 *
 * Switching tabs must not leave a stale group open, and the obvious fix — reset
 * `openGroup` in a `useEffect` keyed on the tab — is exactly the shape that
 * broke the Trades filter under the React Compiler (see AGENTS.md). It is not
 * needed: group keys are namespaced per lens (`month:…`, `batch:…`,
 * `setup:…`), so a key from the previous tab simply does not match any group in
 * the new one and the list renders. The open group is DERIVED by lookup, never
 * stored twice.
 *
 * ── The tab is the only thing that persists ─────────────────────────────────
 *
 * Which cut you were reading is per-device chrome, so it lives in
 * localStorage through `use-stored-value` under a versioned envelope. The open
 * GROUP deliberately does not persist: coming back to the app inside one
 * import file, with no memory of having drilled in, reads as a broken journal.
 *
 * ── The book is not here any more ───────────────────────────────────────────
 *
 * This component used to receive every trade and re-run `lensGroups` itself.
 * On a 25,001-trade book that was ~9.3 MB of RSC flight on every visit, to
 * render a list of 45 rows. The server already grouped the book to compute the
 * KPIs, so it now ships that OUTPUT (`lenses`) and the drill-down asks
 * `/api/lenses/members` for one group's trades when it is opened — the same
 * projection, the same order, the same pure functions. Nothing on screen is
 * computed from a different set than before: the group rows are the ones the
 * server built, and every drill-down figure still reads the group's FULL
 * member array (the `DRILL_LIMIT` slice is a rendering budget, not a data
 * boundary).
 *
 * The fetch is started from click handlers, never from an effect keyed on
 * state — the shape AGENTS.md bans.
 *
 * ── Last click wins ─────────────────────────────────────────────────────────
 *
 * Only the clicked row used to be disabled, so a second group could be opened
 * while the first was still fetching, and both responses painted in RESPONSE
 * order: click a large (slow) group then a small one and the small one appeared
 * first, then the large one overwrote it and you landed in the group you had
 * left behind. `busy` was cleared by whichever finished first, re-enabling a
 * row that was still loading, and a response outstanding across a tab switch
 * re-opened a drill-down the user had already closed.
 *
 * Every navigation now takes a ticket from `nav`: opening a group, arming a
 * delete, switching tabs, going back, finishing a delete. A handler that comes
 * back holding a stale ticket paints NOTHING — not the detail, not the open
 * key, not even `busy`, which belongs to whoever is still in flight. The data
 * was already coherent (`openDetail` is key-matched), so this is about which
 * screen you end up on.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { KpiCard, type KpiDetailRow } from "@/components/kpi-card";
import { InsightList } from "@/components/intelligence/insight-list";
import type { Insight } from "@/lib/intelligence/insight";
import { DataTable } from "@/components/ui/data-table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { ShowMore, useRowWindow } from "@/components/ui/show-more";
import { toast } from "@/components/ui/toaster";
import { DeleteTradesDialog } from "@/components/trades/delete-trades-dialog";
import { resolveDeleteScope, type DeletePreview } from "@/lib/domain/delete-scope";
import { LENSES, lensDef, isLensKind, type LensKind, type LensTrade } from "@/lib/domain/lenses";
// DELIBERATELY no computeKpis import: the KPI split is computed on the SERVER
// (app/lenses/page.tsx via lib/domain/lens-edge.ts) so the Pro figures never
// reach an unlicensed browser. Re-importing it here would turn the gate back
// into decoration — tests/render-windowing.test.ts greps this file for it.
import type { LensGroupRow, LensGroupDetail, LensTotals, LensChargeHeads } from "@/lib/domain/lens-edge";
import { ProLock } from "@/components/system/pro-lock";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { inr, num, pct, fmtDate, signedClass } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ArrowLeft, ChevronRight, Trash2 } from "lucide-react";

/** Per-device chrome. Versioned so a future shape is discarded, not mis-read. */
const TAB_KEY = "vyuha-lenses-tab";

/** Trades listed in a drill-down before the list is cut. The table is
 *  virtualized, so this is a generosity limit rather than a DOM one — and when
 *  it bites, the UI says so rather than quietly showing a subset. */
const DRILL_LIMIT = 2000;

type Row = LensGroupRow;

/** One group's drill-down payload, plus the key it belongs to — a detail left
 *  over from another group must never render against this group's row. */
type OpenGroup = LensGroupDetail & { key: string };

/** Ask the server for one group's members. Returns null on any failure; the
 *  caller reports it rather than opening an empty drill-down, which would read
 *  as "this group has no trades". */
async function fetchGroup(lens: LensKind, key: string): Promise<LensGroupDetail | null> {
  try {
    const res = await fetch(`/api/lenses/members?lens=${encodeURIComponent(lens)}&key=${encodeURIComponent(key)}`);
    const body = (await res.json()) as { ok?: boolean } & LensGroupDetail;
    if (!res.ok || !body?.ok) return null;
    return { members: body.members ?? [], chargeHeads: body.chargeHeads ?? null, insights: body.insights };
  } catch {
    return null;
  }
}

export function LensesClient({
  lenses,
  pro,
}: {
  /** Per-lens group rows — the descriptor the server's own grouping produced,
   *  plus its KPI split, computed over each group's full membership. */
  lenses: Record<LensKind, LensGroupRow[]>;
  pro: boolean;
}) {
  const router = useRouter();
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<OpenGroup | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<{ row: Row; preview: DeletePreview } | null>(null);

  // The ticket every navigation takes. A ref, not state: it must be readable
  // and bumpable inside an async handler without re-rendering anything.
  const nav = React.useRef(0);
  /** Invalidate whatever is in flight and return this navigation's ticket. */
  const claim = () => ++nav.current;

  // The active tab is read straight from storage — no second copy in React
  // state to keep honest. The server snapshot is null, so the default renders
  // and the stored value lands after hydration.
  const storedTab = useStoredValue(TAB_KEY);
  const kind: LensKind = React.useMemo(() => {
    try {
      const p = JSON.parse(storedTab ?? "null");
      if (p && p.v === 1 && isLensKind(p.kind)) return p.kind;
    } catch {
      /* corrupt or from an older shape — fall through to the default */
    }
    return "month";
  }, [storedTab]);

  // No grouping here any more — these are the server's own groups for this
  // lens, so switching tabs is a lookup, not a re-pass over the book.
  const rows: Row[] = lenses[kind] ?? [];

  // Derived, never stored: a key left over from another tab matches nothing.
  const open = openKey ? rows.find((r) => r.group.key === openKey) ?? null : null;
  const openDetail = open && detail?.key === open.group.key ? detail : null;

  const selectTab = (next: string) => {
    if (!isLensKind(next)) return;
    claim(); // a group still loading under the old tab must not open under this one
    writeStored(TAB_KEY, JSON.stringify({ v: 1, kind: next }));
    setOpenKey(null);
    setDetail(null);
    setBusy(null);
  };

  /** Close the drill-down. Also a navigation: a fetch still running loses. */
  const closeGroup = () => {
    claim();
    setOpenKey(null);
    setDetail(null);
    setBusy(null);
  };

  /** Open a group: its trades are fetched, not shipped. Last click wins. */
  const openGroup = async (key: string) => {
    const ticket = claim();
    setBusy(key);
    const got = await fetchGroup(kind, key);
    // Somebody clicked again, switched tabs or went back while this was in the
    // air. It is no longer the screen anyone asked for, so it paints nothing —
    // `busy` included, because it now belongs to the request still running.
    if (ticket !== nav.current) return;
    setBusy(null);
    if (!got) {
      toast.error("Could not load this group's trades.");
      return;
    }
    setDetail({ key, ...got });
    setOpenKey(key);
  };

  /**
   * Arm a delete. The preview is resolved against the group's OWN members
   * rather than the whole book, and that is the same set by construction: a
   * lens group holds exactly the trades its scope matches, in book order, so
   * `resolveDeleteScope` sees the same rows in the same sequence — same ids,
   * same net P&L, same dates. `tests/lenses.test.ts` pins that equivalence.
   */
  const askDelete = async (row: Row) => {
    const key = row.group.key;
    const ticket = claim();
    // Already drilled in? Reuse the array on screen — the preview describes
    // the rows the user is looking at, not a second read of the book.
    let members = detail?.key === key ? detail.members : undefined;
    if (!members) {
      setBusy(key);
      const got = await fetchGroup(kind, key);
      // A superseded fetch may not arm a delete dialog: the one thing worse
      // than the wrong screen is the wrong group in a delete confirmation.
      if (ticket !== nav.current) return;
      setBusy(null);
      members = got?.members;
    }
    if (!members) {
      toast.error("Could not load this group's trades.");
      return;
    }
    setDeleting({ row, preview: resolveDeleteScope(members, row.group.scope) });
  };

  const def = lensDef(kind);

  return (
    <>
      <Tabs value={kind} onValueChange={selectTab}>
        <TabsList aria-label="Group trades by">
          {LENSES.map((l) => (
            <TabsTrigger key={l.kind} value={l.kind}>
              {l.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {LENSES.map((l) => (
          <TabsContent key={l.kind} value={l.kind} className="pt-4">
            {l.kind === kind && (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">{def.hint}</p>

                {open && openDetail ? (
                  <GroupDetail
                    row={open}
                    trades={openDetail.members}
                    chargeHeads={openDetail.chargeHeads}
                    insights={openDetail.insights}
                    onBack={closeGroup}
                    onDelete={() => askDelete(open)}
                  />
                ) : (
                  <GroupList rows={rows} pro={pro} busy={busy} onOpen={openGroup} onDelete={askDelete} />
                )}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      <DeleteTradesDialog
        preview={deleting?.preview ?? null}
        reason={`deleted from Lenses — ${def.label}: ${deleting?.row.group.label ?? ""}`}
        open={deleting != null}
        onOpenChange={(v) => !v && setDeleting(null)}
        onDone={() => {
          setDeleting(null);
          closeGroup();
          router.refresh();
        }}
      />
    </>
  );
}

// ── The group list ──────────────────────────────────────────────────────────

function GroupList({
  rows,
  pro,
  busy,
  onOpen,
  onDelete,
}: {
  rows: Row[];
  pro: boolean;
  /** The group key whose trades are being fetched, if any. */
  busy: string | null;
  onOpen: (key: string) => void;
  onDelete: (row: Row) => void;
}) {
  // A lens can produce as many groups as the book has import files or months.
  // Every one of them used to go into the DOM; this renders a window and SAYS
  // what it held back. The COUNTS are untouched — each row still reports its
  // group's full membership, and the window never changes a figure, only how
  // many rows are mounted at once.
  const win = useRowWindow(rows);

  if (rows.length === 0) {
    return <EmptyState variant="journal" title="Nothing to group yet" hint="Import a tradebook or add a trade by hand, and it will appear here." />;
  }

  return (
    <>
    {!pro && (
      // One banner, not a call-to-action per locked cell — the same visual
      // vocabulary as ProGate's trial strip.
      <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
        Win rate, profit factor, expectancy and average R are{" "}
        <span className="font-medium text-accent">Pro</span>. Grouping, counts, P&amp;L and deleting a group stay
        free.{" "}
        <Link href="/pricing" className="text-accent underline-offset-2 hover:underline">See pricing</Link>
        {" "}·{" "}
        <Link href="/settings#license" className="text-accent underline-offset-2 hover:underline">Activate a key</Link>
      </div>
    )}
    {busy && <p className="px-2.5 py-2 text-xs text-muted-foreground">Loading this group&apos;s trades…</p>}
    <ReportTable>
      <ReportThead>
        <ReportTh>Group</ReportTh>
        <ReportTh align="right">Trades</ReportTh>
        <ReportTh align="right">Open</ReportTh>
        <ReportTh align="right">Net P&amp;L</ReportTh>
        <ReportTh align="right">Charges</ReportTh>
        <ReportTh align="right">Win rate</ReportTh>
        <ReportTh align="right">Profit factor</ReportTh>
        <ReportTh align="right">Expectancy</ReportTh>
        <ReportTh align="right">Avg R</ReportTh>
        <ReportTh aria-label="Actions" />
      </ReportThead>
      <tbody>
        {win.visible.map((row) => {
          const { group } = row;
          const { totals, edge } = row.row;
          return (
          <ReportTr key={group.key}>
            <ReportTd>
              <button
                type="button"
                disabled={busy === group.key}
                className="text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpen(group.key)}
              >
                <span className="font-medium">{group.label}</span>
                {group.sub && <span className="block text-[11px] text-muted-foreground">{group.sub}</span>}
              </button>
            </ReportTd>
            <ReportTd align="right">{group.count}</ReportTd>
            <ReportTd align="right" muted={totals.openCount === 0}>{totals.openCount}</ReportTd>
            <ReportTd align="right" className={signedClass(totals.netPnl)}>{inr(totals.netPnl, { decimals: 0 })}</ReportTd>
            <ReportTd align="right" className="text-grad-gold">{inr(totals.charges, { decimals: 0 })}</ReportTd>
            {/* Three visually distinct states per edge cell: a number; "—"
                meaning CANNOT be computed from your data (invariant 6); and
                the lock chip meaning computed, but not yours yet. A locked
                value must never look like a zero or like missing data. */}
            <EdgeCell edge={edge} measurable={totals.closedCount > 0}
              render={(e) => `${(e.winRate * 100).toFixed(0)}%`} />
            <EdgeCell edge={edge} measurable={totals.closedCount > 0}
              render={(e) => (e.profitFactor == null ? "—" : num(e.profitFactor))} />
            <EdgeCell edge={edge} measurable={totals.closedCount > 0}
              className={edge ? signedClass(edge.expectancy) : undefined}
              render={(e) => inr(e.expectancy, { decimals: 0 })} />
            <EdgeCell edge={edge} measurable
              render={(e) => (e.avgR == null ? "—" : num(e.avgR))} />
            <ReportTd className="text-right">
              <div className="flex items-center justify-end gap-1">
                <Button size="sm" variant="ghost" disabled={busy === group.key} title={`Delete the ${group.count} trades in ${group.label}`} onClick={() => onDelete(row)}>
                  <Trash2 className="size-3.5 text-loss" />
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === group.key} title={`Open ${group.label}`} onClick={() => onOpen(group.key)}>
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            </ReportTd>
          </ReportTr>
          );
        })}
      </tbody>
    </ReportTable>
    {/* Outside the table: a <div> is not valid inside <tbody>. */}
    <ShowMore hidden={win.hidden} total={win.total} onClick={win.showMore} noun="groups" />
    </>
  );
}

/**
 * One edge cell, three states.
 *
 * `measurable === false` → "—": a group of open positions has no closed
 * trades, so its win rate is 0/0, and printing "0%" would read as "you lost
 * every one" (invariant 6 — never fabricate a denominator). `edge === null`
 * → the Pro lock chip: the figure exists, this copy is not entitled to it.
 */
function EdgeCell({
  edge,
  measurable,
  className,
  render,
}: {
  edge: import("@/lib/domain/lens-edge").LensEdge | null;
  measurable: boolean;
  className?: string;
  render: (e: import("@/lib/domain/lens-edge").LensEdge) => string;
}) {
  if (edge === null) {
    return (
      <ReportTd align="right"><ProLock /></ReportTd>
    );
  }
  return (
    <ReportTd align="right" className={className}>{measurable ? render(edge) : "—"}</ReportTd>
  );
}

// ── One group, drilled into ─────────────────────────────────────────────────

function GroupDetail({
  row,
  trades,
  chargeHeads,
  insights,
  onBack,
  onDelete,
}: {
  row: Row;
  /** The group's full member list, from `/api/lenses/members`. */
  trades: LensTrade[];
  /** Drill-down-only, so it arrives with the members rather than with the
   *  list — same aggregation over the same closed rows in the same order. */
  chargeHeads: LensChargeHeads | null;
  insights?: Insight[];
  onBack: () => void;
  onDelete: () => void;
}) {
  const { group } = row;
  const { totals, edge } = row.row;
  const shown = trades.slice(0, DRILL_LIMIT);

  // Free-wire facts for the Trades popup, over the FULL member array (the
  // DRILL_LIMIT slice is a rendering budget, not a data boundary).
  const facts = React.useMemo(() => {
    const symbols = new Set(trades.map((t) => t.tradingsymbol || t.symbol));
    let firstEntry: string | null = null;
    let lastExit: string | null = null;
    for (const t of trades) {
      if (t.buyDate && (!firstEntry || t.buyDate < firstEntry)) firstEntry = t.buyDate;
      if (!t.isOpen && t.sellDate && (!lastExit || t.sellDate > lastExit)) lastExit = t.sellDate;
    }
    return { symbols: symbols.size, firstEntry, lastExit };
  }, [trades]);

  const columns = React.useMemo<ColumnDef<LensTrade, unknown>[]>(
    () => [
      {
        id: "symbol",
        header: "Instrument",
        accessorKey: "tradingsymbol",
        cell: ({ row: r }) => (
          <span className="font-medium">{r.original.tradingsymbol}</span>
        ),
        meta: { flex: true, minWidth: 180 },
      },
      {
        id: "type",
        header: "Type",
        accessorKey: "segment",
        cell: ({ row: r }) => SEGMENT_LABELS[r.original.segment as Segment] ?? r.original.segment,
      },
      { id: "buyDate", header: "Entry", accessorKey: "buyDate", cell: ({ row: r }) => fmtDate(r.original.buyDate) },
      { id: "sellDate", header: "Exit", accessorKey: "sellDate", cell: ({ row: r }) => (r.original.isOpen ? <Badge variant="outline">open</Badge> : fmtDate(r.original.sellDate)) },
      {
        id: "netPnl",
        header: "Net P&L",
        accessorKey: "netPnl",
        cell: ({ row: r }) => <span className={signedClass(r.original.netPnl)}>{inr(r.original.netPnl, { decimals: 0 })}</span>,
        meta: { align: "right" },
      },
      {
        id: "rMultiple",
        header: "R",
        accessorKey: "rMultiple",
        cell: ({ row: r }) => (r.original.rMultiple == null ? "—" : num(r.original.rMultiple)),
        meta: { align: "right" },
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeft className="size-3.5" /> All groups
          </Button>
          <div>
            <div className="text-sm font-semibold">{group.label}</div>
            {group.sub && <div className="text-[11px] text-muted-foreground">{group.sub}</div>}
          </div>
        </div>
        <Button size="sm" variant="destructive" onClick={onDelete}>
          <Trash2 className="size-3.5" /> Delete these {group.count} trade{group.count === 1 ? "" : "s"}
        </Button>
      </div>

      <section className="grid grid-cols-2 gap-4 xl:grid-cols-5">
        <KpiCard
          label="Trades"
          valueNum={group.count}
          format="int"
          sub={`${totals.openCount} open`}
          detail={{
            title: `${group.label} — what the count holds`,
            rows: [
              { label: "Closed", value: String(totals.closedCount) },
              { label: "Still open", value: String(totals.openCount) },
              { label: "Distinct instruments", value: String(facts.symbols) },
              { label: "First entry", value: facts.firstEntry ? fmtDate(facts.firstEntry) : "—" },
              {
                label: "Latest exit", value: facts.lastExit ? fmtDate(facts.lastExit) : "—",
                hint: totals.openCount > 0 ? "closed trades only" : undefined,
              },
            ],
          }}
        />
        <NetPnlCard groupLabel={group.label} totals={totals} trades={trades} insights={insights} />
        <KpiCard
          label="Charges"
          valueNum={totals.charges}
          format="inr0"
          valueClassName="text-grad-gold"
          detail={
            chargeHeads
              ? {
                  title: `Charges — ${group.label}, head by head`,
                  summary: "Computed per broker × segment × exchange from your editable rate table.",
                  rows: chargeHeadRows(chargeHeads),
                  note:
                    totals.openCount > 0
                      ? `Closed trades only, matching the card — charges booked on the ${totals.openCount} still-open position${totals.openCount === 1 ? "" : "s"} are not in this split.`
                      : undefined,
                }
              : undefined
          }
        />
        {/* Same three states as the list cells: number / "—" (no denominator) /
            "Pro" (computed, not yours yet). A locked card gets no popup — the
            breakdown is the Pro figure. */}
        {edge === null ? (
          <KpiCard label="Win rate" value="Pro" sub="locked — see pricing" />
        ) : totals.closedCount > 0 ? (
          <KpiCard
            label="Win rate"
            valueNum={edge.winRate * 100}
            format="pct0"
            sub={`${edge.wins}W / ${edge.losses}L`}
            detail={{
              title: "Win rate — wins, losses and streaks",
              summary: "A low win rate with big winners beats a high win rate with big losers.",
              rows: [
                { label: "Wins", value: String(edge.wins), tone: "profit" },
                { label: "Losses", value: String(edge.losses), tone: "loss" },
                { label: "Win rate", value: pct(edge.winRate * 100, 0) },
                { label: "Best win streak", value: `${edge.maxWinStreak} in a row`, tone: "profit" },
                { label: "Worst loss streak", value: `${edge.maxLossStreak} in a row`, tone: "loss" },
                { label: "Streak at last exit", value: streakText(edge.currentStreak) },
              ],
              note:
                totals.unpricedCount > 0
                  ? `${totals.unpricedCount} closed trade${totals.unpricedCount === 1 ? "" : "s"} without a cost basis sit${totals.unpricedCount === 1 ? "s" : ""} outside these ratios.`
                  : undefined,
            }}
          />
        ) : (
          <KpiCard label="Win rate" value="—" sub="nothing closed yet" />
        )}
        {edge === null ? (
          <KpiCard label="Expectancy" value="Pro" sub="locked — see pricing" />
        ) : totals.closedCount > 0 ? (
          <KpiCard
            label="Expectancy"
            valueNum={edge.expectancy}
            format="inr0"
            valueClassName={signedClass(edge.expectancy)}
            sub="per closed trade"
            detail={{
              title: "Expectancy — what one trade is worth",
              summary: "Average net P&L per priced closed trade — the number that actually compounds.",
              rows: [
                { label: "Expectancy / trade", value: inr(edge.expectancy, { decimals: 0 }), tone: edge.expectancy >= 0 ? "profit" : "loss" },
                { label: "Average win", value: edge.wins > 0 ? inr(edge.avgWin, { decimals: 0 }) : "—", tone: "profit" },
                { label: "Average loss", value: edge.losses > 0 ? inr(edge.avgLoss, { decimals: 0 }) : "—", tone: "loss" },
                {
                  label: "Win / loss size ratio",
                  value: edge.avgLoss !== 0 ? `${Math.abs(edge.avgWin / edge.avgLoss).toFixed(2)}×` : "—",
                  hint: "how many losses one win pays for",
                },
              ],
            }}
          />
        ) : (
          <KpiCard label="Expectancy" value="—" sub="nothing closed yet" />
        )}
      </section>

      {/* Server-attached, Pro-only (the wire carries no `insights` key when
          unlicensed — same proof as `edge`). Descriptive by contract. */}
      {insights && insights.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.13em] text-muted-foreground">
            What this group&apos;s record shows
          </div>
          <InsightList insights={insights} />
        </div>
      )}

      {/* Data-quality is a statement about the user's OWN record — free on
          every tier, which is why it reads totals, never edge. */}
      {totals.unpricedCount > 0 && (
        <Card className="border-warning/40 p-3 text-xs">
          {totals.unpricedCount} closed trade{totals.unpricedCount === 1 ? "" : "s"} in this group{" "}
          {totals.unpricedCount === 1 ? "has" : "have"} no cost basis on record. {inr(totals.unpricedNetPnl, { decimals: 0 })} of the
          Net P&amp;L above comes from {totals.unpricedCount === 1 ? "it" : "them"}, but {totals.unpricedCount === 1 ? "it is" : "they are"}{" "}
          excluded from win rate, profit factor and expectancy.
        </Card>
      )}

      {trades.length > shown.length && (
        <p className="text-xs text-warning">
          Showing the first {shown.length} of {trades.length} trades. Deleting this group still removes all {group.count}.
        </p>
      )}

      <DataTable columns={columns} data={shown} virtual maxHeight="60vh" emptyMessage="No trades in this group." />
    </div>
  );
}

// ── The popup pieces ────────────────────────────────────────────────────────

/** "+4 wins" / "−2 losses" / "—" at the group's latest exit. */
function streakText(cur: number): string {
  if (cur > 0) return `${cur} win${cur === 1 ? "" : "s"}`;
  if (cur < 0) return `${-cur} loss${cur === -1 ? "" : "es"}`;
  return "—";
}

/** The Charges popup rows — zero heads are dropped, the total and the
 *  breakeven line always stay. Server-aggregated numbers, formatted here. */
function chargeHeadRows(h: LensChargeHeads): KpiDetailRow[] {
  const heads: [string, number][] = [
    ["Brokerage", h.brokerage],
    ["STT / CTT", h.sttCtt],
    ["Exchange txn", h.exchangeTxn],
    ["SEBI + stamp + IPFT", h.statutory],
    ["GST", h.gst],
    ["DP charges", h.dpCharges],
    ["MTF interest", h.mtfInterest],
    ["Pledge charges", h.pledgeCharges],
  ];
  const rows: KpiDetailRow[] = heads
    .filter(([, v]) => v !== 0)
    .map(([label, v]) => ({ label, value: inr(v, { decimals: 0 }) }));
  rows.push({ label: "Total charges", value: inr(h.total, { decimals: 0 }), tone: "loss" });
  if (h.turnover > 0) {
    rows.push({
      label: "Breakeven move",
      value: pct(h.breakevenPct, 2),
      hint: "charges as % of turnover — the average move a trade needed just to cover its costs",
    });
  }
  return rows;
}

/**
 * The Net P&L card opens a LOCAL dialog rather than KpiCard's string-row
 * popup: the winners/losers ledger and the group's insight cards need more
 * than KpiDetail's strings. Every figure here is client-computable from FREE
 * wire data (per-trade netPnl/grossPnl already feed the drill table) or
 * arrives server-attached — the no-computeKpis rule above stays true.
 * Open-state is local and derived from nothing.
 */
function NetPnlCard({
  groupLabel,
  totals,
  trades,
  insights,
}: {
  groupLabel: string;
  totals: LensTotals;
  trades: LensTrade[];
  insights?: Insight[];
}) {
  const [open, setOpen] = React.useState(false);

  // Over the FULL member array, never the DRILL_LIMIT slice — a top-5 read
  // off the visible subset would silently miss the real worst trade.
  const bridge = React.useMemo(() => {
    const closed = trades.filter((t) => !t.isOpen);
    const gross = closed.reduce((s, t) => s + t.grossPnl, 0);
    const winners = closed.filter((t) => t.netPnl > 0).sort((a, b) => b.netPnl - a.netPnl).slice(0, 5);
    const losers = closed.filter((t) => t.netPnl < 0).sort((a, b) => a.netPnl - b.netPnl).slice(0, 5);
    return { gross, winners, losers };
  }, [trades]);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        title="Net P&L — click for the breakdown"
        className="cursor-pointer transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <KpiCard
          label="Net P&L"
          valueNum={totals.netPnl}
          format="inr0"
          valueClassName={signedClass(totals.netPnl)}
          sub="click for breakdown →"
        />
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Net P&L — {groupLabel}</DialogTitle>
            <DialogDescription>Gross result minus every charge, over the group&apos;s closed trades.</DialogDescription>
          </DialogHeader>
          <div className="divide-y divide-border/50">
            <DetailLine label="Gross P&L" value={inr(bridge.gross, { decimals: 0 })} tone={bridge.gross >= 0 ? "profit" : "loss"} />
            <DetailLine label="Total charges" value={`−${inr(totals.charges, { decimals: 0 })}`} tone="loss" />
            <DetailLine label="Net P&L" value={inr(totals.netPnl, { decimals: 0 })} tone={totals.netPnl >= 0 ? "profit" : "loss"} />
          </div>
          {(bridge.winners.length > 0 || bridge.losers.length > 0) && (
            <div className="grid grid-cols-2 gap-4">
              <LedgerColumn title="Top winners" rows={bridge.winners} tone="profit" />
              <LedgerColumn title="Top losers" rows={bridge.losers} tone="loss" />
            </div>
          )}
          {insights && insights.length > 0 && <InsightList insights={insights} />}
          {totals.openCount > 0 && (
            <p className="text-[0.6875rem] text-muted-foreground">
              {totals.openCount} still-open position{totals.openCount === 1 ? "" : "s"} contribute nothing here — this is
              realised money only.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One label/value line, styled like KpiDetail's rows. */
function DetailLine({ label, value, tone }: { label: string; value: string; tone?: "profit" | "loss" }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <div className="text-xs">{label}</div>
      <div className={cn("shrink-0 font-mono text-sm tabular-nums", tone === "profit" && "text-profit", tone === "loss" && "text-loss")}>
        {value}
      </div>
    </div>
  );
}

function LedgerColumn({ title, rows, tone }: { title: string; rows: LensTrade[]; tone: "profit" | "loss" }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.13em] text-muted-foreground">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">none</div>
      ) : (
        <div className="space-y-1">
          {rows.map((t) => (
            <div key={t.id} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate">{t.tradingsymbol || t.symbol}</span>
              <span className={cn("shrink-0 font-mono tabular-nums", tone === "profit" ? "text-profit" : "text-loss")}>
                {inr(t.netPnl, { decimals: 0 })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
