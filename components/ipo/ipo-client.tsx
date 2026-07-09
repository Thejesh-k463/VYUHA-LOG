"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { computeIpo, IPO_CATEGORY_LABELS, type IpoComputed, type IpoStatus, type IpoCategory } from "@/lib/analytics/ipo";
import { inr, inrCompact, num } from "@/lib/format";
import { BROKERS, BROKER_LABELS, type Broker } from "@/lib/domain/constants";
import { ExportButtons } from "@/components/ui/export-button";
import { Plus, Pencil, Trash2, FileText } from "lucide-react";

const EXPORT_COLS = [
  { key: "name", label: "IPO" }, { key: "status", label: "Status" }, { key: "board", label: "Board" },
  { key: "category", label: "Category" }, { key: "appliedPrice", label: "Issue price" },
  { key: "discountPerShare", label: "Discount/sh" }, { key: "effectiveCost", label: "Effective cost" },
  { key: "lotSize", label: "Lot size" }, { key: "lotsApplied", label: "Lots applied" },
  { key: "allottedQty", label: "Allotted qty" }, { key: "listingPrice", label: "Listing" },
  { key: "exitPrice", label: "Exit" }, { key: "listingGain", label: "Listing gain" },
  { key: "netPnl", label: "Net P&L" }, { key: "estTax", label: "Tax est." },
  { key: "postTaxNet", label: "Post-tax net" }, { key: "returnPct", label: "Return %" },
];

const STATUS: Record<IpoStatus, { label: string; variant: "secondary" | "accent" | "warning" | "profit" | "loss" }> = {
  not_allotted: { label: "Not allotted", variant: "secondary" },
  allotted: { label: "Allotted", variant: "accent" },
  listed: { label: "Listed", variant: "warning" },
  exited: { label: "Exited", variant: "profit" },
};

const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

export function IpoClient({ rows, summary }: { rows: IpoComputed[]; summary: Parameters<typeof KpiRow>[0]["summary"] }) {
  const router = useRouter();
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<IpoComputed | null>(null);
  const [statement, setStatement] = React.useState<IpoComputed | null>(null);

  async function del(id: number) {
    if (!confirm("Delete this IPO entry?")) return;
    await fetch(`/api/ipos?id=${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <KpiRow summary={summary} />

      <div className="flex justify-end">
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="size-4" /> Add IPO</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add IPO</DialogTitle>
              <DialogDescription>P&L is computed from applied → listing → exit, with sell charges & tax estimate.</DialogDescription>
            </DialogHeader>
            <IpoForm onDone={() => { setAddOpen(false); router.refresh(); }} />
          </DialogContent>
        </Dialog>
      </div>

      <Card className="p-0">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>IPO applications</CardTitle>
          <ExportButtons
            filename="vyuha-ipos"
            columns={EXPORT_COLS}
            rows={rows.map((r) => ({
              name: r.name, status: r.status, board: r.board, category: r.category ?? "",
              appliedPrice: r.appliedPrice, discountPerShare: r.discountPerShare, effectiveCost: r.effectiveCost,
              lotSize: r.lotSize, lotsApplied: r.lotsApplied, allottedQty: r.allottedQty,
              listingPrice: r.listingPrice ?? "", exitPrice: r.exitPrice ?? "", listingGain: r.listingGain ?? "",
              netPnl: r.realised ? r.netPnl : "", estTax: r.tax?.estTax ?? "", postTaxNet: r.tax?.postTaxNet ?? "",
              returnPct: r.returnPct ?? "",
            }))}
          />
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No IPOs yet — click “Add IPO” to record one.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-y border-border text-left text-muted-foreground">
                    <th className="px-2.5 py-2 font-medium">IPO</th>
                    <th className="px-2.5 py-2 font-medium">Status</th>
                    <th className="px-2.5 py-2 text-right font-medium">Applied ₹</th>
                    <th className="px-2.5 py-2 text-right font-medium">Lots (app/allot)</th>
                    <th className="px-2.5 py-2 text-right font-medium">Listing</th>
                    <th className="px-2.5 py-2 text-right font-medium">Exit</th>
                    <th className="px-2.5 py-2 text-right font-medium">Listing gain</th>
                    <th className="px-2.5 py-2 text-right font-medium">P&L (net)</th>
                    <th className="px-2.5 py-2 text-right font-medium">Tax est.</th>
                    <th className="px-2.5 py-2 text-right font-medium">Return</th>
                    <th className="px-2.5 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pl = r.realised ? r.netPnl : r.unrealised;
                    return (
                      <tr key={r.id} className="border-b border-border/40">
                        <td className="px-2.5 py-2">
                          <div className="flex items-center gap-1.5 font-medium">
                            {r.name}
                            {r.board === "sme" && <Badge variant="warning" className="px-1 py-0 text-[9px]">SME</Badge>}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {r.broker ? BROKER_LABELS[r.broker as Broker] ?? r.broker : "—"} · {r.exchange}
                            {r.category ? ` · ${IPO_CATEGORY_LABELS[r.category as IpoCategory] ?? r.category}` : ""}
                            {r.discountPerShare > 0 ? ` · −₹${num(r.discountPerShare, 0)}/sh` : ""}
                          </div>
                        </td>
                        <td className="px-2.5 py-2"><Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge></td>
                        <td className="px-2.5 py-2 text-right tabular-nums">
                          {num(r.effectiveCost, 2)}
                          {r.discountPerShare > 0 && <span className="ml-1 text-[9px] text-muted-foreground line-through">{num(r.appliedPrice, 0)}</span>}
                        </td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{r.lotsApplied}/{r.allotted ? Math.round(r.allottedQty / r.lotSize) : 0}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{r.listingPrice == null ? "—" : num(r.listingPrice, 2)}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{r.exitPrice == null ? "—" : num(r.exitPrice, 2)}</td>
                        <td className={`px-2.5 py-2 text-right tabular-nums ${r.listingGain == null ? "" : pnl(r.listingGain)}`}>{r.listingGain == null ? "—" : num(r.listingGain, 0)}</td>
                        <td className={`px-2.5 py-2 text-right tabular-nums font-medium ${pnl(pl)}`}>
                          {r.status === "not_allotted" ? "—" : num(pl, 0)}
                          {!r.realised && r.status === "listed" && <span className="ml-1 text-[9px] text-muted-foreground">unrl</span>}
                        </td>
                        <td className="px-2.5 py-2 text-right tabular-nums text-warning">
                          {r.tax && !r.tax.isLoss ? num(r.tax.estTax, 0) : r.tax?.isLoss ? "loss" : "—"}
                          {r.tax && !r.tax.isLoss && <span className="ml-1 text-[9px] text-muted-foreground">{r.tax.term === "ST" ? "STCG" : "LTCG"}</span>}
                        </td>
                        <td className={`px-2.5 py-2 text-right tabular-nums ${r.returnPct == null ? "" : pnl(r.returnPct)}`}>{r.returnPct == null ? "—" : `${r.returnPct.toFixed(1)}%`}</td>
                        <td className="px-2.5 py-2">
                          <div className="flex items-center justify-end gap-1">
                            {r.status !== "not_allotted" && (
                              <Button size="icon" variant="ghost" className="size-7" title="P&L statement" onClick={() => setStatement(r)}><FileText className="size-3.5" /></Button>
                            )}
                            <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(r)}><Pencil className="size-3.5" /></Button>
                            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-loss" onClick={() => del(r.id)}><Trash2 className="size-3.5" /></Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Tax estimate is informational — STCG/LTCG by holding period from allotment date, at the exit-date rate
        (rates changed 23-Jul-2024). The LTCG annual exemption applies at FY level across all your equity, not
        per IPO, so it isn&apos;t netted here. SME shares trade in lot multiples even after listing. Verify with a
        qualified professional before filing.
      </p>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit IPO</DialogTitle>
            <DialogDescription>{editing?.name}</DialogDescription>
          </DialogHeader>
          {editing && <IpoForm existing={editing} onDone={() => { setEditing(null); router.refresh(); }} />}
        </DialogContent>
      </Dialog>

      <Dialog open={!!statement} onOpenChange={(o) => !o && setStatement(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>P&L statement — {statement?.name}</DialogTitle>
            <DialogDescription>Application → allotment → listing → exit, with charges & tax.</DialogDescription>
          </DialogHeader>
          {statement && <IpoStatement r={statement} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ k, v, cls, strong, indent }: { k: string; v: string; cls?: string; strong?: boolean; indent?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 py-1 ${indent ? "pl-4" : ""}`}>
      <span className={`${strong ? "font-medium" : "text-muted-foreground"}`}>{k}</span>
      <span className={`tabular-nums ${cls ?? ""} ${strong ? "font-semibold" : ""}`}>{v}</span>
    </div>
  );
}
function Sep() {
  return <div className="my-1 border-t border-border/60" />;
}

/** Full lifecycle P&L statement for one IPO. */
function IpoStatement({ r }: { r: IpoComputed }) {
  const lotsAllotted = r.lotSize > 0 ? Math.round(r.allottedQty / r.lotSize) : 0;

  return (
    <div className="space-y-1 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
        {r.board === "sme" && <Badge variant="warning">SME — exits in lot multiples of {r.lotSize}</Badge>}
        {r.category && <Badge variant="secondary">{IPO_CATEGORY_LABELS[r.category as IpoCategory] ?? r.category}</Badge>}
      </div>

      <Row k={`Issue price${r.discountPerShare > 0 ? ` (before discount)` : ""}`} v={inr(r.appliedPrice)} />
      {r.discountPerShare > 0 && <Row k="Category discount" v={`− ${inr(r.discountPerShare)} /share`} cls="text-profit" indent />}
      {r.discountPerShare > 0 && <Row k="Effective cost / share" v={inr(r.effectiveCost)} strong indent />}
      <Row k={`Application (${r.lotsApplied} lot${r.lotsApplied === 1 ? "" : "s"} × ${r.lotSize})`} v={inr(r.applicationAmount)} />
      <Sep />
      <Row k={`Allotted (${lotsAllotted} lot${lotsAllotted === 1 ? "" : "s"} · ${num(r.allottedQty, 0)} sh)`} v={inr(r.investedAllotted)} strong />
      <Row k="Refund" v={inr(r.refundAmount)} indent />
      {r.allotmentDate && <Row k="Allotment date" v={r.allotmentDate} indent />}
      {r.listingPrice != null && (
        <>
          <Sep />
          <Row k={`Listing @ ${num(r.listingPrice, 2)}${r.listingDate ? ` (${r.listingDate})` : ""}`} v={r.listingGain == null ? "—" : inr(r.listingGain)} cls={r.listingGain == null ? "" : pnl(r.listingGain)} />
        </>
      )}
      {r.status === "exited" && r.exitPrice != null && (
        <>
          <Sep />
          <Row k={`Exit @ ${num(r.exitPrice, 2)}${r.exitDate ? ` (${r.exitDate})` : ""}`} v={inr(r.exitPrice * r.allottedQty)} />
          <Row k="Gross P&L" v={inr(r.grossPnl)} cls={pnl(r.grossPnl)} strong />
          <Row k="Sell charges (STT, exch, stamp, DP, GST)" v={`− ${inr(r.charges)}`} indent />
          <Row k="Net P&L" v={inr(r.netPnl)} cls={pnl(r.netPnl)} strong />
          {r.tax && (
            <>
              <Sep />
              {r.tax.isLoss ? (
                <Row k="Tax" v="capital loss — set-off / carry-forward applies" cls="text-muted-foreground" />
              ) : (
                <>
                  <Row
                    k={`${r.tax.term === "ST" ? "STCG" : "LTCG"} @ ${r.tax.ratePct}% (held from ${r.tax.acquisitionDate ?? "—"})`}
                    v={`− ${inr(r.tax.estTax)}`}
                    cls="text-warning"
                  />
                  <Row k="Post-tax net" v={inr(r.tax.postTaxNet)} cls={pnl(r.tax.postTaxNet)} strong />
                </>
              )}
            </>
          )}
          {r.returnPct != null && <Row k="Return on invested" v={`${r.returnPct.toFixed(2)}%`} cls={pnl(r.returnPct)} />}
        </>
      )}
      {r.status === "listed" && (
        <>
          <Sep />
          <Row k="Unrealised (mark-to-listing)" v={inr(r.unrealised)} cls={pnl(r.unrealised)} strong />
        </>
      )}
    </div>
  );
}

function KpiRow({ summary }: { summary: import("@/lib/analytics/ipo").IpoSummary }) {
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      <KpiCard label="IPOs" value={summary.count} sub={`${summary.allottedCount} allotted · ${summary.notAllottedCount} not`} />
      <KpiCard label="Applied amount" value={inrCompact(summary.applicationAmount)} sub="blocked at apply" />
      <KpiCard label="Invested (allotted)" value={inrCompact(summary.investedAllotted)} />
      <KpiCard label="Listing gains" value={inrCompact(summary.listingGains)} valueClassName={pnl(summary.listingGains)} />
      <KpiCard
        label="Realised net"
        value={inr(summary.realisedNet, { decimals: 0 })}
        valueClassName={pnl(summary.realisedNet)}
        sub={summary.estTax > 0 ? `est. tax ${inr(summary.estTax, { decimals: 0 })} → post-tax ${inr(summary.postTaxNet, { decimals: 0 })}` : `${summary.exitedCount} exited`}
      />
      <KpiCard label="Unrealised" value={inr(summary.unrealised, { decimals: 0 })} valueClassName={pnl(summary.unrealised)} sub={`${summary.listedCount} holding`} />
    </section>
  );
}

function IpoForm({ existing, onDone }: { existing?: IpoComputed; onDone: () => void }) {
  const [name, setName] = React.useState(existing?.name ?? "");
  const [broker, setBroker] = React.useState(existing?.broker ?? "");
  const [exchange, setExchange] = React.useState(existing?.exchange ?? "NSE");
  const [board, setBoard] = React.useState<string>(existing?.board ?? "mainboard");
  const [category, setCategory] = React.useState<string>(existing?.category ?? "");
  const [discountPerShare, setDiscountPerShare] = React.useState(
    existing && existing.discountPerShare > 0 ? String(existing.discountPerShare) : "",
  );
  const [appliedPrice, setAppliedPrice] = React.useState(String(existing?.appliedPrice ?? ""));
  const [lotSize, setLotSize] = React.useState(String(existing?.lotSize ?? ""));
  const [lotsApplied, setLotsApplied] = React.useState(String(existing?.lotsApplied ?? "1"));
  const [allotted, setAllotted] = React.useState(existing?.allotted ?? false);
  const [allottedLots, setAllottedLots] = React.useState(
    existing && existing.allotted && existing.lotSize ? String(Math.round(existing.allottedQty / existing.lotSize)) : "",
  );
  const [listingPrice, setListingPrice] = React.useState(existing?.listingPrice == null ? "" : String(existing.listingPrice));
  const [exitPrice, setExitPrice] = React.useState(existing?.exitPrice == null ? "" : String(existing.exitPrice));
  const [appliedDate, setAppliedDate] = React.useState(existing?.appliedDate ?? "");
  const [allotmentDate, setAllotmentDate] = React.useState(existing?.allotmentDate ?? "");
  const [listingDate, setListingDate] = React.useState(existing?.listingDate ?? "");
  const [exitDate, setExitDate] = React.useState(existing?.exitDate ?? "");
  const [notes, setNotes] = React.useState(existing?.notes ?? "");
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const ls = Number(lotSize) || 0;
  const allottedQty = allotted ? (Number(allottedLots) || 0) * ls : 0;
  const preview = computeIpo({
    id: existing?.id ?? 0, name: name || "—", broker: broker || null, exchange,
    board, category: category || null, discountPerShare: Number(discountPerShare) || 0,
    appliedPrice: Number(appliedPrice) || 0, lotSize: ls || 1, lotsApplied: Number(lotsApplied) || 1,
    allotted, allottedQty, listingPrice: listingPrice === "" ? null : Number(listingPrice),
    exitPrice: exitPrice === "" ? null : Number(exitPrice),
    allotmentDate: allotmentDate || null, exitDate: exitDate || null,
    appliedDate: appliedDate || null, listingDate: listingDate || null,
  });

  async function save() {
    setPending(true); setMsg(null);
    try {
      const res = await fetch("/api/ipos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: existing?.id, name, broker, exchange, board, category, discountPerShare,
          appliedPrice, lotSize, lotsApplied,
          allotted, allottedQty, listingPrice, exitPrice, appliedDate, allotmentDate, listingDate, exitDate, notes,
        }),
      });
      const json = await res.json();
      if (json.ok) onDone();
      else setMsg(json.message ?? "Failed");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <F label="IPO name" className="col-span-2 sm:col-span-1"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tata Tech" /></F>
        <F label="Broker"><Select value={broker} onChange={(e) => setBroker(e.target.value)}><option value="">—</option>{BROKERS.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}</Select></F>
        <F label="Exchange"><Select value={exchange} onChange={(e) => setExchange(e.target.value)}><option value="NSE">NSE</option><option value="BSE">BSE</option></Select></F>
        <F label="Board"><Select value={board} onChange={(e) => setBoard(e.target.value)}><option value="mainboard">Mainboard</option><option value="sme">SME (Emerge / BSE SME)</option></Select></F>
        <F label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">—</option>
          <option value="retail">Retail</option>
          <option value="shni">S-HNI (₹2–10L)</option>
          <option value="bhni">B-HNI (&gt;₹10L)</option>
          <option value="employee">Employee</option>
          <option value="shareholder">Shareholder</option>
        </Select></F>
        <F label="Discount ₹/share"><Input type="number" step="any" value={discountPerShare} onChange={(e) => setDiscountPerShare(e.target.value)} placeholder="0" /></F>
        <F label="Issue price (cut-off)"><Input type="number" step="any" value={appliedPrice} onChange={(e) => setAppliedPrice(e.target.value)} /></F>
        <F label="Lot size"><Input type="number" step="1" value={lotSize} onChange={(e) => setLotSize(e.target.value)} /></F>
        <F label="Lots applied"><Input type="number" step="1" value={lotsApplied} onChange={(e) => setLotsApplied(e.target.value)} /></F>
      </div>

      <div className="flex items-center justify-between rounded-md border border-border bg-card-hover/40 px-3 py-2">
        <div className="text-sm font-medium">Allotted?</div>
        <Switch checked={allotted} onCheckedChange={(v) => setAllotted(Boolean(v))} />
      </div>

      {allotted && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <F label="Allotted lots"><Input type="number" step="1" value={allottedLots} onChange={(e) => setAllottedLots(e.target.value)} placeholder={lotsApplied} /></F>
          <F label="Listing price"><Input type="number" step="any" value={listingPrice} onChange={(e) => setListingPrice(e.target.value)} /></F>
          <F label="Exit price (if sold)"><Input type="number" step="any" value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} /></F>
          <F label="Applied date"><Input type="date" value={appliedDate} onChange={(e) => setAppliedDate(e.target.value)} /></F>
          <F label="Allotment date"><Input type="date" value={allotmentDate} onChange={(e) => setAllotmentDate(e.target.value)} /></F>
          <F label="Listing date"><Input type="date" value={listingDate} onChange={(e) => setListingDate(e.target.value)} /></F>
          <F label="Exit date"><Input type="date" value={exitDate} onChange={(e) => setExitDate(e.target.value)} /></F>
        </div>
      )}
      <F label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" /></F>

      {board === "sme" && (
        <p className="text-[11px] text-warning/90">SME IPO — shares trade in lot multiples of {ls || "?"} even after listing; plan exits accordingly.</p>
      )}

      {/* live preview */}
      <div className="rounded-md border border-border bg-card-hover/30 p-3 text-xs">
        <div className="mb-2 flex items-center gap-2">
          <Badge variant={STATUS[preview.status].variant}>{STATUS[preview.status].label}</Badge>
          <span className="text-muted-foreground">
            Application {inr(preview.applicationAmount)} · Allotted qty {num(preview.allottedQty, 0)}
            {preview.discountPerShare > 0 ? ` · cost ${inr(preview.effectiveCost)}/sh after discount` : ""}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          <Cell k="Invested" v={inr(preview.investedAllotted)} />
          <Cell k="Refund" v={inr(preview.refundAmount)} />
          <Cell k="Listing gain" v={preview.listingGain == null ? "—" : inr(preview.listingGain)} cls={preview.listingGain == null ? "" : pnl(preview.listingGain)} />
          {preview.realised ? (
            <>
              <Cell k="Gross P&L" v={inr(preview.grossPnl)} cls={pnl(preview.grossPnl)} />
              <Cell k="Charges" v={inr(preview.charges)} />
              <Cell k="Net P&L" v={inr(preview.netPnl)} cls={pnl(preview.netPnl)} strong />
              {preview.tax && !preview.tax.isLoss && (
                <>
                  <Cell k={`${preview.tax.term === "ST" ? "STCG" : "LTCG"} @${preview.tax.ratePct}%`} v={inr(preview.tax.estTax)} cls="text-warning" />
                  <Cell k="Post-tax net" v={inr(preview.tax.postTaxNet)} cls={pnl(preview.tax.postTaxNet)} strong />
                </>
              )}
              {preview.tax?.isLoss && <Cell k="Tax" v="loss — set-off" cls="text-muted-foreground" />}
            </>
          ) : (
            <Cell k="Unrealised" v={inr(preview.unrealised)} cls={pnl(preview.unrealised)} strong />
          )}
          {preview.returnPct != null && <Cell k="Return" v={`${preview.returnPct.toFixed(2)}%`} cls={pnl(preview.returnPct)} />}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {msg && <span className="mr-auto text-xs text-loss">{msg}</span>}
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button type="button" onClick={save} disabled={pending || !name}>{pending ? "Saving…" : existing ? "Save" : "Add IPO"}</Button>
      </div>
    </div>
  );
}

function F({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`space-y-1 ${className ?? ""}`}><Label>{label}</Label>{children}</div>;
}
function Cell({ k, v, cls, strong }: { k: string; v: string; cls?: string; strong?: boolean }) {
  return <div className="flex justify-between gap-2"><span className="text-muted-foreground">{k}</span><span className={`tabular-nums ${cls ?? ""} ${strong ? "font-semibold" : ""}`}>{v}</span></div>;
}
