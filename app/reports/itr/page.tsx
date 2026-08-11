import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { ExportButtons } from "@/components/ui/export-button";
import { getTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";
import { ProGate } from "@/components/system/pro-gate";
import { itrPackByFy } from "@/lib/analytics/itr";
import { itrScheduleByFy, scheduleExportRows } from "@/lib/analytics/itr-schedule";
import { aggregateTradesByFy, computeTaxTimeline, type CarryForwardLot } from "@/lib/analytics/capital-gains";
import { inr } from "@/lib/format";
import { AlertTriangle, Info, FileSpreadsheet } from "lucide-react";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export const dynamic = "force-dynamic";

const EXPORT_COLS = [
  { key: "fy", label: "FY" }, { key: "head", label: "Head" },
  { key: "trades", label: "Trades" }, { key: "net", label: "Net P&L" },
  { key: "turnover", label: "Turnover" }, { key: "charges", label: "Charges/Expenses" },
];

const SCHEDULE_COLS = [
  { key: "fy", label: "FY" }, { key: "form", label: "Form" },
  { key: "schedule", label: "Schedule" }, { key: "code", label: "Item" },
  { key: "label", label: "Description" }, { key: "amount", label: "Amount" },
  { key: "note", label: "Note" },
];

export default function ItrPackPage() {
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;
  const trades = getTrades();
  const packs = itrPackByFy(
    trades.map((t) => ({
      segment: t.segment, buyDate: t.buyDate, sellDate: t.sellDate,
      grossPnl: t.grossPnl, netPnl: t.netPnl, chargesTotal: t.chargesTotal, isOpen: t.isOpen,
    })),
    fyStartMonth,
  );

  // Carry-forward comes from the SAME set-off engine the Tax Summary uses, so
  // Schedule CFL cannot drift from the figures on that page.
  const currentFy = packs[packs.length - 1]?.fy ?? "2026-27";
  const timeline = computeTaxTimeline(
    aggregateTradesByFy(
      trades.filter((t) => !t.isOpen).map((t) => ({
        segment: t.segment, buyDate: t.buyDate, sellDate: t.sellDate,
        buyValue: t.buyValue, sellValue: t.sellValue, netPnl: t.netPnl,
        fmv31Jan2018: t.fmv31Jan2018,
      })),
      fyStartMonth,
      currentFy,
    ),
  );
  const carryForwardByFy = new Map<string, CarryForwardLot[]>(
    timeline.map((r) => [r.fy, r.newCarryForward]),
  );

  const schedules = itrScheduleByFy(
    trades.map((t) => ({
      segment: t.segment, buyDate: t.buyDate, sellDate: t.sellDate,
      buyValue: t.buyValue, sellValue: t.sellValue, netPnl: t.netPnl,
      chargesTotal: t.chargesTotal, sttCtt: t.sttCtt,
      fmv31Jan2018: t.fmv31Jan2018, isOpen: t.isOpen,
    })),
    fyStartMonth,
    currentFy,
    carryForwardByFy,
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
          <EmptyState
            variant="journal"
            title="No closed trades yet"
            hint="The pack builds itself as you trade."
            action={<Button asChild size="sm"><Link href="/import">Import a broker file</Link></Button>}
          />
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
                  <KpiCard label="Speculative (intraday)" valueNum={p.speculative.net} format="inr0" valueClassName={pnl(p.speculative.net)} sub={`turnover ${inr(p.speculative.turnover, { decimals: 0 })} · ${p.speculative.trades} trades`} />
                  <KpiCard label="Non-speculative (F&O)" valueNum={p.nonSpeculative.net} format="inr0" valueClassName={pnl(p.nonSpeculative.net)} sub={`turnover ${inr(p.nonSpeculative.turnover, { decimals: 0 })} · ${p.nonSpeculative.trades} trades`} />
                  <KpiCard label="STCG (delivery/MTF)" valueNum={p.capitalGains.stcg} format="inr0" valueClassName={pnl(p.capitalGains.stcg)} sub={`${p.capitalGains.trades} CG trades`} />
                  <KpiCard label="LTCG (≥ 12m)" valueNum={p.capitalGains.ltcg} format="inr0" valueClassName={pnl(p.capitalGains.ltcg)} sub="grandfathering on Tax Summary" />
                </section>

                <div className="rounded-md border border-border bg-card-hover/30 p-3 text-xs">
                  <p className="font-medium">{p.audit.headline}</p>
                  <ul className="mt-1.5 space-y-1 text-muted-foreground">
                    {p.audit.notes.map((n, i) => (
                      <li key={i} className="flex gap-1.5"><Info className="mt-0.5 size-3 shrink-0" />{n}</li>
                    ))}
                  </ul>
                </div>

                <p className="text-[0.6875rem] text-muted-foreground">
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

        {/* ── Schedule-format view ────────────────────────────────────────────
            The pack above answers "how does my book split across heads?". This
            answers "what goes in which BOX?" — the ITR's own item codes, so a
            CA can read straight across into the utility. */}
        {schedules.length > 0 && (
          <Card className="p-0">
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FileSpreadsheet className="size-4" /> Schedule-format line items
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Schedule CG (A3 · 111A, B4 · 112A), Schedule BP and Schedule CFL, in the return&apos;s own
                  item codes.
                </p>
              </div>
              <ExportButtons filename="vyuha-itr-schedules" columns={SCHEDULE_COLS} rows={scheduleExportRows(schedules)} />
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-start gap-2 rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
                <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <p>
                  <span className="font-medium">STT is treated differently by head, on purpose.</span> It is
                  excluded from capital-gains deductions (proviso to S.48) but allowed in full as a business
                  expense against intraday and F&amp;O. The same rupees, two treatments — which is why the
                  Schedule CG balance below is deliberately <em>higher</em> than the net P&amp;L shown elsewhere
                  in Vyuha.
                </p>
              </div>

              {schedules.map((s) => (
                <section key={s.fy} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">FY {s.fy}</h3>
                    <Badge variant="accent">{s.itrForm} indicated</Badge>
                    <span className="text-[0.6875rem] text-muted-foreground">{s.formReason}</span>
                  </div>

                  <ReportTable>
                    <ReportThead>
                      <ReportTh>Schedule</ReportTh>
                      <ReportTh>Item</ReportTh>
                      <ReportTh>Description</ReportTh>
                      <ReportTh align="right">Amount</ReportTh>
                    </ReportThead>
                    <tbody>
                      {s.lines.map((l, i) => (
                        <ReportTr key={`${l.code}-${i}`} className={l.amount === null ? "bg-card-hover/30" : undefined}>
                          <ReportTd muted>{l.schedule}</ReportTd>
                          <ReportTd className="font-mono">{l.code}</ReportTd>
                          <ReportTd className="whitespace-normal">
                            {l.amount === null ? <span className="font-medium">{l.label}</span> : l.label}
                            {l.note && <p className="text-[10px] text-muted-foreground">{l.note}</p>}
                          </ReportTd>
                          <ReportTd align="right">
                            {l.amount === null ? <span className="text-muted-foreground">—</span> : inr(l.amount, { decimals: 0 })}
                          </ReportTd>
                        </ReportTr>
                      ))}
                    </tbody>
                  </ReportTable>

                  <ul className="space-y-1 text-[0.6875rem] text-muted-foreground">
                    {s.cautions.map((c, i) => (
                      <li key={i} className="flex gap-1.5"><Info className="mt-0.5 size-3 shrink-0" />{c}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </CardContent>
          </Card>
        )}
        </ProGate>
      </div>
    </>
  );
}
