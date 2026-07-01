import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExportButtons } from "@/components/ui/export-button";
import { getTrades } from "@/lib/queries/trades";
import { bySegment, bySetup, type GroupStat } from "@/lib/analytics/metrics";
import { num } from "@/lib/format";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

const COLS = [
  { key: "key", label: "Group" }, { key: "count", label: "Trades" },
  { key: "net", label: "Net" }, { key: "gross", label: "Gross" },
  { key: "charges", label: "Charges" }, { key: "wins", label: "Wins" },
  { key: "winRate", label: "Win rate" }, { key: "avgR", label: "Avg R" },
];

export default function EdgeReportPage() {
  const trades = getTrades();
  return (
    <>
      <PageHeader title="Edge / Setup Analytics" description="Which edges pay — expectancy, win rate and avg R per setup and segment." />
      <div className="space-y-5 p-6">
        <EdgeTable title="By setup tag" rows={bySetup(trades)} labelFor={(k) => k} exportName="vyuha-edge-by-setup" />
        <EdgeTable title="By segment" rows={bySegment(trades)} labelFor={(k) => SEGMENT_LABELS[k as Segment] ?? k} exportName="vyuha-edge-by-segment" />
      </div>
    </>
  );
}

function EdgeTable({ title, rows, labelFor, exportName }: { title: string; rows: GroupStat[]; labelFor: (k: string) => string; exportName: string }) {
  const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");
  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <ExportButtons filename={exportName} columns={COLS} rows={rows} />
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No closed trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-y border-border text-left text-muted-foreground">
                  <th className="px-2.5 py-2 font-medium">{title.includes("setup") ? "Setup" : "Segment"}</th>
                  <th className="px-2.5 py-2 text-right font-medium">Trades</th>
                  <th className="px-2.5 py-2 text-right font-medium">Net P&L</th>
                  <th className="px-2.5 py-2 text-right font-medium">Expectancy</th>
                  <th className="px-2.5 py-2 text-right font-medium">Win rate</th>
                  <th className="px-2.5 py-2 text-right font-medium">Avg R</th>
                  <th className="px-2.5 py-2 text-right font-medium">Charges</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const expectancy = r.count ? r.net / r.count : 0;
                  return (
                    <tr key={r.key} className="border-b border-border/40">
                      <td className="px-2.5 py-1.5 font-medium">{labelFor(r.key)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{r.count}</td>
                      <td className={`px-2.5 py-1.5 text-right tabular-nums font-medium ${pnl(r.net)}`}>{num(r.net, 0)}</td>
                      <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnl(expectancy)}`}>{num(expectancy, 0)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{(r.winRate * 100).toFixed(1)}%</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">
                        {r.avgR == null ? "—" : <span className={pnl(r.avgR)}>{r.avgR.toFixed(2)}R</span>}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">{num(r.charges, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
