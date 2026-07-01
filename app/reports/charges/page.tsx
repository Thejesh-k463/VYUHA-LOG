import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { ExportButtons } from "@/components/ui/export-button";
import { getTrades } from "@/lib/queries/trades";
import { chargesBySegment, chargesByMonth, chargesTotals, type ChargeRow } from "@/lib/analytics/charges-report";
import { inr, num } from "@/lib/format";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

const COLS = [
  { key: "key", label: "Group" },
  { key: "count", label: "Trades" },
  { key: "turnover", label: "Turnover" },
  { key: "brokerage", label: "Brokerage" },
  { key: "sttCtt", label: "STT/CTT" },
  { key: "exchangeTxn", label: "Exchange" },
  { key: "statutory", label: "SEBI+Stamp+IPFT" },
  { key: "gst", label: "GST" },
  { key: "dpCharges", label: "DP" },
  { key: "mtfInterest", label: "MTF interest" },
  { key: "total", label: "Total charges" },
  { key: "breakevenPct", label: "Break-even %" },
];

export default function ChargesReportPage() {
  const trades = getTrades();
  const bySeg = chargesBySegment(trades);
  const byMonth = chargesByMonth(trades);
  const totals = chargesTotals(trades);

  return (
    <>
      <PageHeader title="Charges & MTF-Leak Report" description="Where the edge leaks — by segment and by month, with break-even move %." />
      <div className="space-y-5 p-6">
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label="Total charges" value={inr(totals.total, { decimals: 0 })} valueClassName="text-warning" />
          <KpiCard label="Brokerage" value={inr(totals.brokerage, { decimals: 0 })} />
          <KpiCard label="STT / CTT" value={inr(totals.sttCtt, { decimals: 0 })} />
          <KpiCard label="Avg break-even move" value={`${totals.breakevenPct}%`} sub="charges ÷ turnover" />
        </section>

        <ChargeTable title="By segment" rows={bySeg} totals={totals} labelFor={(k) => SEGMENT_LABELS[k as Segment] ?? k} exportName="vyuha-charges-by-segment" />
        <ChargeTable title="By month" rows={byMonth} totals={totals} labelFor={(k) => k} exportName="vyuha-charges-by-month" />
      </div>
    </>
  );
}

function ChargeTable({ title, rows, totals, labelFor, exportName }: { title: string; rows: ChargeRow[]; totals: ChargeRow; labelFor: (k: string) => string; exportName: string }) {
  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <ExportButtons filename={exportName} columns={COLS} rows={rows} />
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-y border-border text-left text-muted-foreground">
                <th className="px-2.5 py-2 font-medium">{title.includes("segment") ? "Segment" : "Month"}</th>
                <th className="px-2.5 py-2 text-right font-medium">Trades</th>
                <th className="px-2.5 py-2 text-right font-medium">Turnover</th>
                <th className="px-2.5 py-2 text-right font-medium">Brokerage</th>
                <th className="px-2.5 py-2 text-right font-medium">STT/CTT</th>
                <th className="px-2.5 py-2 text-right font-medium">Exchange</th>
                <th className="px-2.5 py-2 text-right font-medium">MTF int.</th>
                <th className="px-2.5 py-2 text-right font-medium">Total</th>
                <th className="px-2.5 py-2 text-right font-medium">B/E %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border/40">
                  <td className="px-2.5 py-1.5 font-medium">{labelFor(r.key)}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{r.count}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{num(r.turnover, 0)}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{num(r.brokerage, 0)}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{num(r.sttCtt, 0)}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{num(r.exchangeTxn, 0)}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{r.mtfInterest > 0 ? num(r.mtfInterest, 0) : "—"}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums font-medium text-warning">{num(r.total, 0)}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{r.breakevenPct}%</td>
                </tr>
              ))}
              <tr className="border-t border-border bg-card-hover/30 font-medium">
                <td className="px-2.5 py-2">Total</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{totals.count}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{num(totals.turnover, 0)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{num(totals.brokerage, 0)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{num(totals.sttCtt, 0)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{num(totals.exchangeTxn, 0)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{num(totals.mtfInterest, 0)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums text-warning">{num(totals.total, 0)}</td>
                <td className="px-2.5 py-2 text-right tabular-nums">{totals.breakevenPct}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
