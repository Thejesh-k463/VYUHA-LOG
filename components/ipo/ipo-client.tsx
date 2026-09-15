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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toaster";
import { computeIpo, ipoChargeHeads, isPriceableExitDate, IPO_CATEGORY_LABELS, type IpoComputed, type IpoStatus, type IpoCategory } from "@/lib/analytics/ipo";
import { sellLegIsIpoExit } from "@/lib/analytics/ipo-link";
import { inr, num } from "@/lib/format";
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

  // Command-palette deep link: /ipos?add=1 — open the dialog once, then clean the URL.
  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get("add")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAddOpen(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function del(id: number) {
    if (!confirm("Delete this IPO entry?")) return;
    // The response is READ, not assumed: a 404/500 used to look exactly like
    // success — the row just reappeared on refresh with no explanation
    // (defect D16, 2026-08-12). Same pattern as the import client.
    try {
      const res = await fetch(`/api/ipos?id=${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        toast.error(data?.message ?? "The IPO could not be deleted.");
        return;
      }
      toast.success(data.message ?? "IPO deleted.");
    } catch (e) {
      toast.error(`Could not reach the app — ${e instanceof Error ? e.message : "unknown error"}.`);
      return;
    }
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
          <DialogContent className="max-w-2xl">
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
                      <tr key={r.id} className="border-b border-rule">
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
                        <td className={`px-2.5 py-2 text-right tabular-nums font-medium ${r.unpriced ? "" : pnl(pl)}`}>
                          {r.status === "not_allotted" || r.unpriced ? "—" : num(pl, 0)}
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

      <p className="text-[0.6875rem] text-muted-foreground">
        Tax estimate is informational — STCG/LTCG by holding period from allotment date, at the exit-date rate
        (rates changed 23-Jul-2024). The LTCG annual exemption applies at FY level across all your equity, not
        per IPO, so it isn&apos;t netted here. SME shares trade in lot multiples even after listing. Verify with a
        qualified professional before filing.
      </p>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit IPO</DialogTitle>
            <DialogDescription>{editing?.name}</DialogDescription>
          </DialogHeader>
          {editing && <IpoForm existing={editing} onDone={() => { setEditing(null); router.refresh(); }} />}
        </DialogContent>
      </Dialog>

      <Dialog open={!!statement} onOpenChange={(o) => !o && setStatement(null)}>
        <DialogContent className="max-w-2xl">
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
export function IpoStatement({ r }: { r: IpoComputed }) {
  const lotsAllotted = r.lotSize > 0 ? Math.round(r.allottedQty / r.lotSize) : 0;
  // N15: name only the heads this IPO's charges carry (no DP without a broker's row).
  const heads = ipoChargeHeads(r.chargeBreakdown);
  const chargesLabel = heads.length > 0 ? `Sell charges (${heads.join(", ")})` : "Sell charges";

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
          <Row k={chargesLabel} v={r.unpriced ? "—" : `− ${inr(r.charges)}`} indent />
          <Row k="Net P&L" v={r.unpriced ? "—" : inr(r.netPnl)} cls={r.unpriced ? "" : pnl(r.netPnl)} strong />
          {r.unpriced && <Row k="Exit date is not a valid date" v="charges not computed" cls="text-muted-foreground" indent />}
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

/**
 * IPO-KPI (v4.3.0 wave 2F): the 'Realised net' popup's sentence. realisedNet
 * and estTax add PRICED exits only, so the count it names is pricedExitCount,
 * not the status count exitedCount. An exit with no readable exit date (N13) is
 * named by count and kept out of the figure — never folded in (invariant 6).
 */
export function realisedNetScope(summary: import("@/lib/analytics/ipo").IpoSummary): string {
  const priced = summary.pricedExitCount;
  const unpriced = summary.unpricedExitCount;
  const lead = `Across ${priced} priced exit${priced === 1 ? "" : "s"}.`;
  if (unpriced <= 0) return lead;
  return `${lead} ${unpriced} exit${unpriced === 1 ? " has" : "s have"} no readable exit date and ${unpriced === 1 ? "is" : "are"} not in this figure.`;
}

function KpiRow({ summary }: { summary: import("@/lib/analytics/ipo").IpoSummary }) {
  // v3.5.0 popup rollout — drill-downs only where the summary already holds a
  // real breakdown. Gated on count/exitedCount so an empty book never opens a
  // popup of zeros; the ₹0 tone helper stays out of the tax row (an estimate,
  // not a P&L). Refunded is Σ(application − invested), which is exact because
  // each IPO's refundAmount is that same difference.
  const tone = (v: number) => (v > 0 ? ("profit" as const) : v < 0 ? ("loss" as const) : undefined);
  const i0 = (v: number) => inr(v, { decimals: 0 });
  const statusDetail =
    summary.count > 0
      ? {
          title: "IPO applications — where they stand",
          rows: [
            { label: "Applied", value: String(summary.count) },
            { label: "Allotted", value: String(summary.allottedCount), hint: "includes listed & exited" },
            { label: "Not allotted", value: String(summary.notAllottedCount) },
            { label: "Listed (holding)", value: String(summary.listedCount) },
            { label: "Exited", value: String(summary.exitedCount) },
          ],
        }
      : undefined;
  const appliedDetail =
    summary.count > 0
      ? {
          title: "Applied amount — where the money went",
          summary: "Blocked at application; released as refunds where lots weren't allotted.",
          rows: [
            { label: "Applied (blocked)", value: i0(summary.applicationAmount) },
            { label: "Invested in allotments", value: i0(summary.investedAllotted) },
            { label: "Refunded", value: i0(summary.applicationAmount - summary.investedAllotted) },
          ],
        }
      : undefined;
  const realisedDetail =
    summary.exitedCount > 0
      ? {
          title: "Realised net — after charges and tax",
          summary: realisedNetScope(summary),
          rows: [
            { label: "Realised net P&L", value: i0(summary.realisedNet), tone: tone(summary.realisedNet), hint: "after sell charges" },
            { label: "Est. tax (STCG/LTCG)", value: summary.estTax > 0 ? `− ${i0(summary.estTax)}` : "—", hint: summary.estTax > 0 ? "informational estimate" : "no taxable gain estimated" },
            { label: "Post-tax net", value: i0(summary.postTaxNet), tone: tone(summary.postTaxNet) },
          ],
          note: "Tax is an FY-blind per-IPO estimate — the LTCG exemption and loss set-offs apply at filing, not here.",
        }
      : undefined;
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      <KpiCard label="IPOs" valueNum={summary.count} format="int" sub={`${summary.allottedCount} allotted · ${summary.notAllottedCount} not`} detail={statusDetail} />
      <KpiCard label="Applied amount" valueNum={summary.applicationAmount} format="inrCompact" sub="blocked at apply" detail={appliedDetail} />
      <KpiCard label="Invested (allotted)" valueNum={summary.investedAllotted} format="inrCompact" />
      <KpiCard label="Listing gains" valueNum={summary.listingGains} format="inrCompact" valueClassName={pnl(summary.listingGains)} />
      <KpiCard
        label="Realised net"
        valueNum={summary.realisedNet}
        format="inr0"
        valueClassName={pnl(summary.realisedNet)}
        sub={summary.estTax > 0 ? `est. tax ${inr(summary.estTax, { decimals: 0 })} → post-tax ${inr(summary.postTaxNet, { decimals: 0 })}` : `${summary.exitedCount} exited`}
        detail={realisedDetail}
      />
      <KpiCard label="Unrealised" valueNum={summary.unrealised} format="inr0" valueClassName={pnl(summary.unrealised)} sub={`${summary.listedCount} holding`} />
    </section>
  );
}

/**
 * L4 (v4.3.0 wave 2G): the form preview prices the sale from the bundled
 * statutory rates only, so with a broker chosen every cell computed from those
 * charges (Charges, Net P&L, the STCG/LTCG estimate, Post-tax net, Return) differs
 * from the saved row by the broker's brokerage and DP, and says so. With no broker
 * there is nothing omitted and the label stays plain.
 */
export function previewCellLabel(label: string, broker: string | null | undefined): string {
  return broker ? `${label} before broker charges` : label;
}

/**
 * H5 (v4.3.0 wave 2H). A date input cannot hold a value that is not a real day, so
 * a stored '2026-02-30' or '15-03-2011' rendered as a blank input while the form's
 * state still held the string and the save sent it back unseen. The field now
 * starts from what the input can show, a line beside it says why it is blank, and
 * the save sends what the input holds.
 */
export function unreadableStoredExitDate(stored: string | null | undefined): boolean {
  const s = (stored ?? "").trim();
  return s !== "" && !isPriceableExitDate(s);
}

/** The IPO as stored is sold: allotted, with an exit price. */
export function storedAsSold(existing: Pick<IpoComputed, "allotted" | "exitPrice"> | null | undefined): boolean {
  return !!existing && existing.allotted && existing.exitPrice != null;
}

/**
 * The exit date the save sends. An unallotted IPO renders no exit-date input, so
 * an untouched field sends the stored value back; the route passes it through
 * because that save does not use it (L3). T3 (wave 2H seam fix): an IPO stored as
 * SOLD on an unreadable date does the same while its date field is untouched. Its
 * linked holding was closed on that date, so a blank would ask the route to close
 * it undated and a notes-only save was refused (S4). Anything else, and anything
 * typed, is what the input holds.
 */
export function exitDateToSend(
  stored: string | null | undefined,
  field: string,
  allotted: boolean,
  sold = false,
  edited = false,
): string {
  if (field === "" && unreadableStoredExitDate(stored) && (!allotted || (sold && !edited))) return stored ?? "";
  return field;
}

/** What the form reads of an IPO row and the holding it links (U3, Z2). */
type LinkedRow = Pick<
  IpoComputed,
  | "allotted" | "allottedQty" | "appliedPrice" | "discountPerShare" | "listingPrice" | "exitPrice"
  | "allotmentDate" | "listingDate" | "exitDate" | "linked" | "linkedSellDate" | "linkedSellQty" | "linkedSellPrice"
>;

/**
 * Z2 (v4.3.0 wave 2H): the linked holding's sale IS this IPO's stored exit apart from
 * the date — the same quantity and price, by the sync's own test (`sellLegIsIpoExit`)
 * with the date set aside.
 */
export function linkedSaleIsStoredExit(existing: LinkedRow | null | undefined): boolean {
  if (!storedAsSold(existing) || !existing!.linked) return false;
  const on = existing!.linkedSellDate ?? null;
  return sellLegIsIpoExit(
    { ...existing!, exitDate: on },
    { sellQty: Number(existing!.linkedSellQty) || 0, avgSellPrice: Number(existing!.linkedSellPrice) || 0, sellDate: on },
  );
}

/** Z2: the linked holding carries a sale, and it is not this IPO's stored exit (another quantity or price). */
export function linkedSaleDiffers(existing: LinkedRow | null | undefined): boolean {
  return storedAsSold(existing) && !!existing!.linked && (Number(existing!.linkedSellQty) || 0) > 0 && !linkedSaleIsStoredExit(existing);
}

/**
 * U3 (v4.3.0 wave 2H seam fix 3): the linked holding's sell date, when the IPO's
 * stored exit date cannot be read and the holding's can. That is the date the
 * route's sync compares a save against, so it is the one the form fills in.
 * V2 (seam fix 4): only for an IPO stored as SOLD. An unsold IPO carries no sale for
 * that date to belong to; its input keeps H5's blank and notice, and the sync leaves
 * the holding's own sell leg as it is.
 * Z2: only when that sale IS the IPO's exit apart from the date. A sale corrected in
 * Trades to another price or quantity is the trade's own; its date is not this IPO's.
 */
export function linkedHoldingExitDate(existing: LinkedRow | null | undefined): string | null {
  if (!storedAsSold(existing) || !existing!.linked || !unreadableStoredExitDate(existing!.exitDate)) return null;
  if (!linkedSaleIsStoredExit(existing)) return null;
  const d = (existing!.linkedSellDate ?? "").trim();
  return isPriceableExitDate(d) ? d : null;
}

/**
 * U3: what the exit-date input holds, derived at render. Rendered (allotted) and
 * untouched, it is the linked holding's readable sell date when there is one;
 * otherwise the field's own state.
 */
export function exitDateInputValue(
  existing: LinkedRow | null | undefined,
  field: string,
  allotted: boolean,
  edited: boolean,
): string {
  const holding = allotted && !edited ? linkedHoldingExitDate(existing) : null;
  return holding ?? field;
}

/**
 * T3 + U3: an IPO stored as sold sends its unreadable stored date back untouched
 * only when the route passes it through — unlinked, or linked to a holding closed
 * on that same value. Linked to a holding carrying any other sell date (a readable
 * one is filled in instead; none, or another unreadable one, is refused), the
 * stored date would be written over it, so it is not sent.
 * Z2: linked to a holding whose sale is NOT the IPO's exit (another price or quantity),
 * the route leaves that holding alone (Y2), so the stored value goes back as T3 sends it.
 */
export function keepsStoredExitDate(existing: LinkedRow | null | undefined): boolean {
  if (!storedAsSold(existing)) return false;
  return !existing!.linked || existing!.linkedSellDate === (existing!.exitDate ?? "").trim() || linkedSaleDiffers(existing);
}

/**
 * The line beside the exit-date input of an IPO whose stored exit date cannot be
 * read (H5, T3, U3), or null when there is nothing to explain. `field` is what the
 * input holds (`exitDateInputValue`). Each sentence names only an outcome the route
 * gives the save the form then sends: the holding's date filled in (U3), the stored
 * value kept (T3), a date needed for a sold linked IPO (U3), or blank clearing (H5).
 */
export function unreadableExitDateNotice(
  existing: LinkedRow | null | undefined,
  field: string,
  allotted: boolean,
  edited: boolean,
): string | null {
  if (!existing || !unreadableStoredExitDate(existing.exitDate)) return null;
  const stored = `The stored exit date (${existing.exitDate}) could not be read`;
  const holding = allotted && !edited ? linkedHoldingExitDate(existing) : null;
  if (holding != null) return `${stored}. The linked holding's sell date, ${holding}, is filled in and will be saved as the exit date; to use another day, enter it.`;
  if (field !== "") return null;
  if (linkedSaleDiffers(existing)) {
    // Z2: describes the sale and what this save sends (the stored value, or the blank typed).
    const differs = `${stored}. The linked holding's sale (${Number(existing.linkedSellQty)} at ${Number(existing.linkedSellPrice)}) differs from this IPO's exit (${existing.allottedQty} at ${existing.exitPrice}) and is recorded in Trades.`;
    return edited ? `${differs} Saved blank, the exit date is cleared.` : `${differs} The stored date is kept; to change it, enter the date the shares were sold.`;
  }
  if (keepsStoredExitDate(existing)) return `${stored}. It is kept as stored; to change it, enter the date the shares were sold.`;
  if (storedAsSold(existing) && existing.linked) {
    const none = linkedHoldingExitDate(existing) == null ? ", and the linked holding has no readable sell date" : "";
    return `${stored}${none}. Enter the date the shares were sold.`;
  }
  return `${stored} — enter the date. Saved blank, the exit date is cleared.`;
}

export function IpoForm({ existing, onDone }: { existing?: IpoComputed; onDone: () => void }) {
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
  const storedExitDateUnreadable = unreadableStoredExitDate(existing?.exitDate);
  const [exitDate, setExitDate] = React.useState(storedExitDateUnreadable ? "" : existing?.exitDate ?? "");
  const [exitDateEdited, setExitDateEdited] = React.useState(false);
  const exitDateField = exitDateInputValue(existing, exitDate, allotted, exitDateEdited);
  const exitDateSent = exitDateToSend(existing?.exitDate, exitDateField, allotted, keepsStoredExitDate(existing), exitDateEdited);
  const exitDateNotice = unreadableExitDateNotice(existing, exitDateField, allotted, exitDateEdited);
  const [notes, setNotes] = React.useState(existing?.notes ?? "");
  const [pending, setPending] = React.useState(false);

  const ls = Number(lotSize) || 0;
  const allottedQty = allotted ? (Number(allottedLots) || 0) * ls : 0;
  const preview = computeIpo({
    id: existing?.id ?? 0, name: name || "—", broker: broker || null, exchange,
    board, category: category || null, discountPerShare: Number(discountPerShare) || 0,
    appliedPrice: Number(appliedPrice) || 0, lotSize: ls || 1, lotsApplied: Number(lotsApplied) || 1,
    allotted, allottedQty, listingPrice: listingPrice === "" ? null : Number(listingPrice),
    exitPrice: exitPrice === "" ? null : Number(exitPrice),
    allotmentDate: allotmentDate || null, exitDate: exitDateSent || null,
    appliedDate: appliedDate || null, listingDate: listingDate || null,
  });

  async function save() {
    setPending(true);
    try {
      const res = await fetch("/api/ipos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: existing?.id, name, broker, exchange, board, category, discountPerShare,
          appliedPrice, lotSize, lotsApplied,
          allotted, allottedQty, listingPrice, exitPrice, appliedDate, allotmentDate, listingDate,
          exitDate: exitDateSent, notes,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        toast.success("IPO saved.");
        onDone();
      } else toast.error(json.message ?? "Failed");
    } catch (e) {
      toast.error((e as Error).message);
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
          <F label="Exit date">
            <Input type="date" value={exitDateField} onChange={(e) => { setExitDate(e.target.value); setExitDateEdited(true); }} />
            {exitDateNotice != null && (
              <p className="text-[0.6875rem] text-warning/90" data-testid="ipo-exit-date-unreadable">
                {exitDateNotice}
              </p>
            )}
          </F>
        </div>
      )}
      <F label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" /></F>

      {board === "sme" && (
        <p className="text-[0.6875rem] text-warning/90">SME IPO — shares trade in lot multiples of {ls || "?"} even after listing; plan exits accordingly.</p>
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
          {preview.realised || preview.unpriced ? (
            <>
              <Cell k="Gross P&L" v={inr(preview.grossPnl)} cls={pnl(preview.grossPnl)} />
              {/* N15: the preview prices from the bundled statutory rates only; the saved
                  figure adds the broker's brokerage and DP from charge_config. L4: so does
                  every cell derived from those charges (net, tax, post-tax, return). */}
              <Cell k={previewCellLabel("Charges", broker)} v={preview.unpriced ? "—" : inr(preview.charges)} />
              <Cell k={previewCellLabel("Net P&L", broker)} v={preview.unpriced ? "—" : inr(preview.netPnl)} cls={preview.unpriced ? "" : pnl(preview.netPnl)} strong />
              {preview.tax && !preview.tax.isLoss && (
                <>
                  <Cell k={previewCellLabel(`${preview.tax.term === "ST" ? "STCG" : "LTCG"} @${preview.tax.ratePct}%`, broker)} v={inr(preview.tax.estTax)} cls="text-warning" />
                  <Cell k={previewCellLabel("Post-tax net", broker)} v={inr(preview.tax.postTaxNet)} cls={pnl(preview.tax.postTaxNet)} strong />
                </>
              )}
              {preview.tax?.isLoss && <Cell k="Tax" v="loss — set-off" cls="text-muted-foreground" />}
            </>
          ) : (
            <Cell k="Unrealised" v={inr(preview.unrealised)} cls={pnl(preview.unrealised)} strong />
          )}
          {/* A held IPO's return is marked at listing with no charges, so only a sold one's is qualified. */}
          {preview.returnPct != null && <Cell k={preview.realised ? previewCellLabel("Return", broker) : "Return"} v={`${preview.returnPct.toFixed(2)}%`} cls={pnl(preview.returnPct)} />}
        </div>
      </div>

      <DialogFooter>
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button type="button" onClick={save} disabled={pending || !name}>{pending ? "Saving…" : existing ? "Save" : "Add IPO"}</Button>
      </DialogFooter>
    </div>
  );
}

function F({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`space-y-1 ${className ?? ""}`}><Label>{label}</Label>{children}</div>;
}
function Cell({ k, v, cls, strong }: { k: string; v: string; cls?: string; strong?: boolean }) {
  return <div className="flex justify-between gap-2"><span className="text-muted-foreground">{k}</span><span className={`tabular-nums ${cls ?? ""} ${strong ? "font-semibold" : ""}`}>{v}</span></div>;
}
