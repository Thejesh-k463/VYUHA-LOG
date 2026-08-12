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
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { DataTable } from "@/components/ui/data-table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { DeleteTradesDialog } from "@/components/trades/delete-trades-dialog";
import { resolveDeleteScope, type BatchGroup, type ImportFileMeta } from "@/lib/domain/delete-scope";
import { LENSES, lensDef, lensGroups, groupIds, isLensKind, type LensKind, type LensTrade } from "@/lib/domain/lenses";
// DELIBERATELY no computeKpis import: the KPI split is computed on the SERVER
// (app/lenses/page.tsx via lib/domain/lens-edge.ts) so the Pro figures never
// reach an unlicensed browser. Re-importing it here would turn the gate back
// into decoration — tests/pro-gating.test.ts greps this file for it.
import type { LensRow } from "@/lib/domain/lens-edge";
import { ProLock } from "@/components/system/pro-lock";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { inr, num, fmtDate, signedClass } from "@/lib/format";
import { ArrowLeft, ChevronRight, Trash2 } from "lucide-react";

/** Per-device chrome. Versioned so a future shape is discarded, not mis-read. */
const TAB_KEY = "vyuha-lenses-tab";

/** Trades listed in a drill-down before the list is cut. The table is
 *  virtualized, so this is a generosity limit rather than a DOM one — and when
 *  it bites, the UI says so rather than quietly showing a subset. */
const DRILL_LIMIT = 2000;

interface Row {
  group: BatchGroup;
  ids: number[];
  row: LensRow;
}

/** An impossible key miss degrades to "—" (inr renders NaN as —), never to a
 *  confident zero; `edge: null` shows the lock, the honest default. */
const MISSING_ROW: LensRow = {
  totals: { count: 0, openCount: 0, closedCount: 0, netPnl: NaN, charges: NaN, unpricedCount: 0, unpricedNetPnl: 0 },
  edge: null,
};

export function LensesClient({
  trades,
  batches,
  playbooks,
  rows: serverRows,
  pro,
}: {
  trades: LensTrade[];
  batches: ImportFileMeta[];
  playbooks: { id: number; name: string }[];
  /** Per-lens, per-group KPI split, computed server-side with entitlement. */
  rows: Record<LensKind, Record<string, LensRow>>;
  pro: boolean;
}) {
  const router = useRouter();
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<Row | null>(null);

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

  const byId = React.useMemo(() => new Map(trades.map((t) => [t.id, t])), [trades]);

  const rows: Row[] = React.useMemo(() => {
    // Client and server run the same pure lensGroups over the same props in
    // the same request, so the group keys line up by construction; the KPI
    // halves come pre-split from the server.
    const groups = lensGroups(kind, trades, { batches, playbooks });
    return groups.map((group) => ({
      group,
      ids: groupIds(group, trades),
      row: serverRows[kind]?.[group.key] ?? MISSING_ROW,
    }));
  }, [kind, trades, batches, playbooks, serverRows]);

  // Derived, never stored: a key left over from another tab matches nothing.
  const open = openKey ? rows.find((r) => r.group.key === openKey) ?? null : null;

  const selectTab = (next: string) => {
    if (!isLensKind(next)) return;
    writeStored(TAB_KEY, JSON.stringify({ v: 1, kind: next }));
    setOpenKey(null);
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

                {open ? (
                  <GroupDetail
                    row={open}
                    trades={open.ids.map((id) => byId.get(id)).filter((t): t is LensTrade => t != null)}
                    onBack={() => setOpenKey(null)}
                    onDelete={() => setDeleting(open)}
                  />
                ) : (
                  <GroupList rows={rows} pro={pro} onOpen={setOpenKey} onDelete={setDeleting} />
                )}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      <DeleteTradesDialog
        preview={deleting ? resolveDeleteScope(trades, deleting.group.scope) : null}
        reason={`deleted from Lenses — ${def.label}: ${deleting?.group.label ?? ""}`}
        open={deleting != null}
        onOpenChange={(v) => !v && setDeleting(null)}
        onDone={() => {
          setDeleting(null);
          setOpenKey(null);
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
  onOpen,
  onDelete,
}: {
  rows: Row[];
  pro: boolean;
  onOpen: (key: string) => void;
  onDelete: (row: Row) => void;
}) {
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
        {rows.map((row) => {
          const { group } = row;
          const { totals, edge } = row.row;
          return (
          <ReportTr key={group.key}>
            <ReportTd>
              <button
                type="button"
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
                <Button size="sm" variant="ghost" title={`Delete the ${group.count} trades in ${group.label}`} onClick={() => onDelete(row)}>
                  <Trash2 className="size-3.5 text-loss" />
                </Button>
                <Button size="sm" variant="ghost" title={`Open ${group.label}`} onClick={() => onOpen(group.key)}>
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            </ReportTd>
          </ReportTr>
          );
        })}
      </tbody>
    </ReportTable>
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
  onBack,
  onDelete,
}: {
  row: Row;
  trades: LensTrade[];
  onBack: () => void;
  onDelete: () => void;
}) {
  const { group } = row;
  const { totals, edge } = row.row;
  const shown = trades.slice(0, DRILL_LIMIT);

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
        <KpiCard label="Trades" valueNum={group.count} format="int" sub={`${totals.openCount} open`} />
        <KpiCard label="Net P&L" valueNum={totals.netPnl} format="inr0" valueClassName={signedClass(totals.netPnl)} />
        <KpiCard label="Charges" valueNum={totals.charges} format="inr0" valueClassName="text-grad-gold" />
        {/* Same three states as the list cells: number / "—" (no denominator) /
            "Pro" (computed, not yours yet). */}
        {edge === null ? (
          <KpiCard label="Win rate" value="Pro" sub="locked — see pricing" />
        ) : totals.closedCount > 0 ? (
          <KpiCard label="Win rate" valueNum={edge.winRate * 100} format="pct0" sub={`${edge.wins}W / ${edge.losses}L`} />
        ) : (
          <KpiCard label="Win rate" value="—" sub="nothing closed yet" />
        )}
        {edge === null ? (
          <KpiCard label="Expectancy" value="Pro" sub="locked — see pricing" />
        ) : totals.closedCount > 0 ? (
          <KpiCard label="Expectancy" valueNum={edge.expectancy} format="inr0" valueClassName={signedClass(edge.expectancy)} sub="per closed trade" />
        ) : (
          <KpiCard label="Expectancy" value="—" sub="nothing closed yet" />
        )}
      </section>

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
