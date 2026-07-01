import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExportButtons } from "@/components/ui/export-button";
import { getTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";
import { taxByFy } from "@/lib/analytics/tax";
import { inr } from "@/lib/format";
import { Info } from "lucide-react";

export const dynamic = "force-dynamic";

const COLS = [
  { key: "fy", label: "FY" }, { key: "trades", label: "Trades" },
  { key: "stcg", label: "STCG" }, { key: "ltcg", label: "LTCG" },
  { key: "intradaySpeculative", label: "Intraday speculative" },
  { key: "fnoBusiness", label: "F&O business" }, { key: "fnoTurnover", label: "F&O turnover" },
  { key: "charges", label: "Charges" }, { key: "totalRealised", label: "Net realised" },
];

export default function TaxReportPage() {
  const trades = getTrades();
  const settings = getSettings();
  const rows = taxByFy(trades, settings?.fyStartMonth ?? 4);
  const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

  return (
    <>
      <PageHeader title="Tax Summary (informational)" description="Per financial year — scaffold only." />
      <div className="space-y-5 p-6">
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning/90">
          <Info className="size-4 shrink-0" />
          <div>
            <span className="font-medium">Informational only — not filing advice.</span> Figures use net (post-charge)
            realised P&amp;L and a simplified holding-period rule. F&amp;O turnover uses absolute settlement P&amp;L plus
            option sell premium. Verify with a qualified tax professional before filing.
          </div>
        </div>

        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Per financial year</CardTitle>
            <ExportButtons filename="vyuha-tax-summary" columns={COLS} rows={rows} />
          </CardHeader>
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No closed trades yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-y border-border text-left text-muted-foreground">
                      <th className="px-2.5 py-2 font-medium">FY</th>
                      <th className="px-2.5 py-2 text-right font-medium">STCG (equity)</th>
                      <th className="px-2.5 py-2 text-right font-medium">LTCG (equity)</th>
                      <th className="px-2.5 py-2 text-right font-medium">Intraday speculative</th>
                      <th className="px-2.5 py-2 text-right font-medium">F&O business</th>
                      <th className="px-2.5 py-2 text-right font-medium">F&O turnover</th>
                      <th className="px-2.5 py-2 text-right font-medium">Charges</th>
                      <th className="px-2.5 py-2 text-right font-medium">Net realised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.fy} className="border-b border-border/40">
                        <td className="px-2.5 py-1.5 font-medium">{r.fy}</td>
                        <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnl(r.stcg)}`}>{inr(r.stcg, { decimals: 0 })}</td>
                        <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnl(r.ltcg)}`}>{inr(r.ltcg, { decimals: 0 })}</td>
                        <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnl(r.intradaySpeculative)}`}>{inr(r.intradaySpeculative, { decimals: 0 })}</td>
                        <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnl(r.fnoBusiness)}`}>{inr(r.fnoBusiness, { decimals: 0 })}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">{inr(r.fnoTurnover, { decimals: 0 })}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-warning">{inr(r.charges, { decimals: 0 })}</td>
                        <td className={`px-2.5 py-1.5 text-right tabular-nums font-medium ${pnl(r.totalRealised)}`}>{inr(r.totalRealised, { decimals: 0 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
