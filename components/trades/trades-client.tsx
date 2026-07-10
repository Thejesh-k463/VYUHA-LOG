"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { ManualTradeForm } from "./manual-trade-form";
import { overrideTrade, deleteTrade } from "@/app/trades/actions";
import { inr, num } from "@/lib/format";
import {
  BROKERS, BROKER_LABELS, SEGMENTS, SEGMENT_LABELS, EXCHANGES, BUCKETS, BUCKET_LABELS,
  type Segment,
} from "@/lib/domain/constants";
import type { Trade } from "@/lib/db/schema";
import { JournalDialog, type PlaybookOption } from "@/components/behavior/journal-dialog";
import { Plus, Pencil, Trash2, NotebookPen } from "lucide-react";

const pnlClass = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

function daysBetween(a: string, b: string): number | null {
  const d1 = new Date(a + "T00:00:00").getTime();
  const d2 = new Date(b + "T00:00:00").getTime();
  if (Number.isNaN(d1) || Number.isNaN(d2)) return null;
  return Math.round((d2 - d1) / 86400000);
}

export function TradesClient({ trades, playbooks = [] }: { trades: Trade[]; playbooks?: PlaybookOption[] }) {
  const today = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addOpenTrade, setAddOpenTrade] = React.useState(false);
  const [editing, setEditing] = React.useState<Trade | null>(null);
  const [journaling, setJournaling] = React.useState<Trade | null>(null);

  // Command-palette deep link: /trades?add=manual | open — open the dialog once, then clean the URL.
  React.useEffect(() => {
    const add = new URLSearchParams(window.location.search).get("add");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (add === "manual") setAddOpen(true);
    else if (add === "open") setAddOpenTrade(true);
    if (add) window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const [search, setSearch] = React.useState("");
  const [broker, setBroker] = React.useState("");
  const [segment, setSegment] = React.useState("");
  const [bucket, setBucket] = React.useState("");

  const data = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return trades.filter((t) => {
      if (broker && t.broker !== broker) return false;
      if (segment && t.segment !== segment) return false;
      if (bucket && t.bucket !== bucket) return false;
      if (q && !(`${t.symbol} ${t.tradingsymbol} ${t.setupTag ?? ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [trades, search, broker, segment, bucket]);

  const columns = React.useMemo<ColumnDef<Trade, unknown>[]>(() => [
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
          <div className="min-w-[170px]">
            <div className="flex items-center gap-1.5">
              <span className="font-medium">{t.symbol}</span>
              {isDerivative && t.isOpen && (
                <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${isShort ? "bg-loss/15 text-loss" : "bg-profit/15 text-profit"}`}>
                  {isShort ? "Short" : "Long"}
                </span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground">
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
    { accessorKey: "buyValue", header: "Buy", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 0) },
    { accessorKey: "sellValue", header: "Sell", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 0) },
    { accessorKey: "grossPnl", header: "Gross", meta: { align: "right" }, cell: ({ getValue }) => <span className={pnlClass(getValue() as number)}>{num(getValue() as number, 0)}</span> },
    { accessorKey: "chargesTotal", header: "Charges", meta: { align: "right" }, cell: ({ getValue }) => <span className="text-muted-foreground">{num(getValue() as number, 0)}</span> },
    { accessorKey: "mtfInterest", header: "MTF int.", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number; return v > 0 ? <span className="text-warning">{num(v, 0)}</span> : <span className="text-muted-foreground/50">—</span>; } },
    { accessorKey: "netPnl", header: "Net", meta: { align: "right" }, cell: ({ getValue }) => <span className={`font-medium ${pnlClass(getValue() as number)}`}>{num(getValue() as number, 0)}</span> },
    { accessorKey: "rMultiple", header: "R", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : <span className={pnlClass(v)}>{v.toFixed(2)}R</span>; } },
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
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className={`size-7 ${(row.original.mistakeTags?.length || row.original.playbookId != null || row.original.emotionTag) ? "text-accent" : ""}`}
            onClick={() => setJournaling(row.original)}
            title="Journal — playbook, emotion, mistakes"
          >
            <NotebookPen className="size-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(row.original)} title="Re-tag / override">
            <Pencil className="size-3.5" />
          </Button>
          <form action={deleteTrade}>
            <input type="hidden" name="tradeId" value={row.original.id} />
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-loss" title="Delete"
              onClick={(e) => { if (!confirm("Delete this trade?")) e.preventDefault(); }}>
              <Trash2 className="size-3.5" />
            </Button>
          </form>
        </div>
      ),
    },
  ], [today]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search symbol / setup…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 w-56" />
        <Select value={broker} onChange={(e) => setBroker(e.target.value)} className="h-8 w-32">
          <option value="">All brokers</option>
          {BROKERS.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
        </Select>
        <Select value={segment} onChange={(e) => setSegment(e.target.value)} className="h-8 w-44">
          <option value="">All segments</option>
          {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
        </Select>
        <Select value={bucket} onChange={(e) => setBucket(e.target.value)} className="h-8 w-36">
          <option value="">All buckets</option>
          {BUCKETS.map((b) => <option key={b} value={b}>{BUCKET_LABELS[b]}</option>)}
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{data.length} of {trades.length}</span>
          <Dialog open={addOpenTrade} onOpenChange={setAddOpenTrade}>
            <DialogTrigger asChild>
              <Button size="sm" variant="secondary"><Plus className="size-4" /> Open trade</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add open trade</DialogTitle>
                <DialogDescription>A running position (no exit yet) with SL / TSL / target — appears in Portfolio Risk.</DialogDescription>
              </DialogHeader>
              <ManualTradeForm mode="open" onDone={() => setAddOpenTrade(false)} />
            </DialogContent>
          </Dialog>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="size-4" /> Add trade</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add trade</DialogTitle>
                <DialogDescription>Auto-classified with a live charge preview as you type.</DialogDescription>
              </DialogHeader>
              <ManualTradeForm onDone={() => setAddOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card className="p-0">
        <DataTable columns={columns} data={data} emptyMessage="No trades yet — import a broker file or add one manually." />
      </Card>

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
