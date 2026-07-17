import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { ExportButtons } from "@/components/ui/export-button";
import { getTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";
import { ProGate } from "@/components/system/pro-gate";
import { itrPackByFy } from "@/lib/analytics/itr";
import { inr } from "@/lib/format";
import { AlertTriangle, Info } from "lucide-react";

export const dynamic = "force-dynamic";

const EXPORT_COLS = [
  { key: "fy", label: "FY" }, { key: "head", label: "Head" },
  { key: "trades", label: "Trades" }, { key: "net", label: "Net P&L" },
  { key: "turnover", label: "Turnover" }, { key: "charges", label: "Charges/Expenses" },
];

export default function ItrPackPage() {
  const settings = getSettings();
  const packs = itrPackByFy(
    getTrades().map((t) => ({
      segment: t.segment, buyDate: t.buyDate, sellDate: t.sellDate,
      grossPnl: t.grossPnl, netPnl: t.netPnl, chargesTotal: t.chargesTotal, isOpen: t.isOpen,
    })),
    settings?.fyStartMonth ?? 4,
  );

  const exportRows = packs.flatMap((p) => [
    { fy: p.fy, head: "Speculative business (intraday equity)", trades: p.speculative.trades, net: p.speculative.net, turnover: p.speculative.turnover, charges: p.speculative.charges },
    { fy: p.fy, head: "Non-speculative business (F&O)", trades: p.nonSpeculative.trades, net: p.nonSpeculative.net, turnover: p.nonSpeculative.turnover, charges: p.nonSpeculative.charges },
    { fy: p.fy, head: "Capital gains — STCG", trades: p.capitalGains.trades, net: p.capitalGains.stcg, turnover: 0, charges: p.capitalGains.charges },
    { fy: p.fy, head: "Capital gains — LTCG", trades: 0, net: p.capitalGains.ltcg, turnover: 0, charges: 0 },
  ]);

  const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

  return (
    <>
      <PageHeader
        title="ITR Pack (India)"
        description="Head-wise segregation + Guidance-Note turnover + 44AB read — a preparation pack for you and your CA."
        actions={<Badge variant="secondary">informational</Badge>}
      />
      <div className="space-y-5 p-6">
        <ProGate>
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-xs">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            <span className="font-semibold">This is preparation, not filing advice.</span> Heads follow the
            standard treatment (intraday = speculative business, F&amp;O = non-speculative business,
            delivery/MTF = capital gains) and turnover follows the ICAI Guidance Note (8th ed., 2022 —
            absolute sum of per-trade P&amp;L, option premium NOT double-added). Your CA may use the older
            premium-inclusive method for consistency with past filings; thresholds also depend on your
            OVERALL income. Take this pack to a professional — don&apos;t file off it directly.
          </p>
        </div>

        {packs.length === 0 ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No closed trades yet — the pack builds itself as you trade.</CardContent></Card>
        ) : (
          packs.map((p) => (
            <Card key={p.fy} className="p-0">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>FY {p.fy}</CardTitle>
                <span className={`text-xs font-medium ${p.audit.level === "audit-required" ? "text-loss" : "text-muted-foreground"}`}>
                  {p.audit.level === "audit-required" ? "⚠ 44AB audit required" : p.audit.level === "audit-unlikely" ? "44AB audit unlikely" : "no business income"}
                </span>
              </CardHeader>
              <CardContent className="space-y-4">
                <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <KpiCard label="Speculative (intraday)" value={inr(p.speculative.net, { decimals: 0 })} valueClassName={pnl(p.speculative.net)} sub={`turnover ${inr(p.speculative.turnover, { decimals: 0 })} · ${p.speculative.trades} trades`} />
                  <KpiCard label="Non-speculative (F&O)" value={inr(p.nonSpeculative.net, { decimals: 0 })} valueClassName={pnl(p.nonSpeculative.net)} sub={`turnover ${inr(p.nonSpeculative.turnover, { decimals: 0 })} · ${p.nonSpeculative.trades} trades`} />
                  <KpiCard label="STCG (delivery/MTF)" value={inr(p.capitalGains.stcg, { decimals: 0 })} valueClassName={pnl(p.capitalGains.stcg)} sub={`${p.capitalGains.trades} CG trades`} />
                  <KpiCard label="LTCG (≥ 12m)" value={inr(p.capitalGains.ltcg, { decimals: 0 })} valueClassName={pnl(p.capitalGains.ltcg)} sub="grandfathering on Tax Summary" />
                </section>

                <div className="rounded-md border border-border bg-card-hover/30 p-3 text-xs">
                  <p className="font-medium">{p.audit.headline}</p>
                  <ul className="mt-1.5 space-y-1 text-muted-foreground">
                    {p.audit.notes.map((n, i) => (
                      <li key={i} className="flex gap-1.5"><Info className="mt-0.5 size-3 shrink-0" />{n}</li>
                    ))}
                  </ul>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  Charges ({inr(p.speculative.charges + p.nonSpeculative.charges, { decimals: 0 })} on business
                  heads) are generally deductible business expenses; capital-gains charges
                  ({inr(p.capitalGains.charges, { decimals: 0 })}) adjust cost/consideration instead. Broker
                  statements, not this journal, are the source of record for filing.
                </p>
              </CardContent>
            </Card>
          ))
        )}

        {packs.length > 0 && (
          <div className="flex items-center justify-end">
            <ExportButtons filename="vyuha-itr-pack" columns={EXPORT_COLS} rows={exportRows} />
          </div>
        )}
        </ProGate>
      </div>
    </>
  );
}
