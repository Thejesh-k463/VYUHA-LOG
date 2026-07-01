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
import { computeIpo, type IpoComputed, type IpoStatus } from "@/lib/analytics/ipo";
import { inr, inrCompact, num } from "@/lib/format";
import { BROKERS, BROKER_LABELS, type Broker } from "@/lib/domain/constants";
import { Plus, Pencil, Trash2 } from "lucide-react";

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
              <DialogDescription>P&L is computed from applied → listing → exit, with sell charges.</DialogDescription>
            </DialogHeader>
            <IpoForm onDone={() => { setAddOpen(false); router.refresh(); }} />
          </DialogContent>
        </Dialog>
      </div>

      <Card className="p-0">
        <CardHeader><CardTitle>IPO applications</CardTitle></CardHeader>
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
                          <div className="font-medium">{r.name}</div>
                          <div className="text-[10px] text-muted-foreground">{r.broker ? BROKER_LABELS[r.broker as Broker] ?? r.broker : "—"} · {r.exchange}</div>
                        </td>
                        <td className="px-2.5 py-2"><Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge></td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{num(r.appliedPrice, 2)}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{r.lotsApplied}/{r.allotted ? Math.round(r.allottedQty / r.lotSize) : 0}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{r.listingPrice == null ? "—" : num(r.listingPrice, 2)}</td>
                        <td className="px-2.5 py-2 text-right tabular-nums">{r.exitPrice == null ? "—" : num(r.exitPrice, 2)}</td>
                        <td className={`px-2.5 py-2 text-right tabular-nums ${r.listingGain == null ? "" : pnl(r.listingGain)}`}>{r.listingGain == null ? "—" : num(r.listingGain, 0)}</td>
                        <td className={`px-2.5 py-2 text-right tabular-nums font-medium ${pnl(pl)}`}>
                          {r.status === "not_allotted" ? "—" : num(pl, 0)}
                          {!r.realised && r.status === "listed" && <span className="ml-1 text-[9px] text-muted-foreground">unrl</span>}
                        </td>
                        <td className={`px-2.5 py-2 text-right tabular-nums ${r.returnPct == null ? "" : pnl(r.returnPct)}`}>{r.returnPct == null ? "—" : `${r.returnPct.toFixed(1)}%`}</td>
                        <td className="px-2.5 py-2">
                          <div className="flex items-center justify-end gap-1">
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

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit IPO</DialogTitle>
            <DialogDescription>{editing?.name}</DialogDescription>
          </DialogHeader>
          {editing && <IpoForm existing={editing} onDone={() => { setEditing(null); router.refresh(); }} />}
        </DialogContent>
      </Dialog>
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
      <KpiCard label="Realised net" value={inr(summary.realisedNet, { decimals: 0 })} valueClassName={pnl(summary.realisedNet)} sub={`${summary.exitedCount} exited`} />
      <KpiCard label="Unrealised" value={inr(summary.unrealised, { decimals: 0 })} valueClassName={pnl(summary.unrealised)} sub={`${summary.listedCount} holding`} />
    </section>
  );
}

function IpoForm({ existing, onDone }: { existing?: IpoComputed; onDone: () => void }) {
  const [name, setName] = React.useState(existing?.name ?? "");
  const [broker, setBroker] = React.useState(existing?.broker ?? "");
  const [exchange, setExchange] = React.useState(existing?.exchange ?? "NSE");
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
  const [listingDate, setListingDate] = React.useState(existing?.listingDate ?? "");
  const [exitDate, setExitDate] = React.useState(existing?.exitDate ?? "");
  const [notes, setNotes] = React.useState(existing?.notes ?? "");
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const ls = Number(lotSize) || 0;
  const allottedQty = allotted ? (Number(allottedLots) || 0) * ls : 0;
  const preview = computeIpo({
    id: existing?.id ?? 0, name: name || "—", broker: broker || null, exchange,
    appliedPrice: Number(appliedPrice) || 0, lotSize: ls || 1, lotsApplied: Number(lotsApplied) || 1,
    allotted, allottedQty, listingPrice: listingPrice === "" ? null : Number(listingPrice),
    exitPrice: exitPrice === "" ? null : Number(exitPrice),
  });

  async function save() {
    setPending(true); setMsg(null);
    try {
      const res = await fetch("/api/ipos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: existing?.id, name, broker, exchange, appliedPrice, lotSize, lotsApplied,
          allotted, allottedQty, listingPrice, exitPrice, appliedDate, listingDate, exitDate, notes,
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
        <F label="Applied price (cut-off)"><Input type="number" step="any" value={appliedPrice} onChange={(e) => setAppliedPrice(e.target.value)} /></F>
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
          <F label="Listing date"><Input type="date" value={listingDate} onChange={(e) => setListingDate(e.target.value)} /></F>
          <F label="Exit date"><Input type="date" value={exitDate} onChange={(e) => setExitDate(e.target.value)} /></F>
        </div>
      )}
      <F label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" /></F>

      {/* live preview */}
      <div className="rounded-md border border-border bg-card-hover/30 p-3 text-xs">
        <div className="mb-2 flex items-center gap-2">
          <Badge variant={STATUS[preview.status].variant}>{STATUS[preview.status].label}</Badge>
          <span className="text-muted-foreground">Application {inr(preview.applicationAmount)} · Allotted qty {num(preview.allottedQty, 0)}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          <Cell k="Invested" v={inr(preview.investedAllotted)} />
          <Cell k="Listing gain" v={preview.listingGain == null ? "—" : inr(preview.listingGain)} cls={preview.listingGain == null ? "" : pnl(preview.listingGain)} />
          {preview.realised ? (
            <>
              <Cell k="Gross P&L" v={inr(preview.grossPnl)} cls={pnl(preview.grossPnl)} />
              <Cell k="Charges" v={inr(preview.charges)} />
              <Cell k="Net P&L" v={inr(preview.netPnl)} cls={pnl(preview.netPnl)} strong />
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
