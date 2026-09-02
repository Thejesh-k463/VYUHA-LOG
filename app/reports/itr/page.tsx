import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { ExportButtons } from "@/components/ui/export-button";
import { getTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";
import { ProGate } from "@/components/system/pro-gate";
import { BROKER_TURNOVER_BASIS, TURNOVER_BASIS, itrPackByFy } from "@/lib/analytics/itr";
import { section } from "@/lib/analytics/statute";
import { itrScheduleByFy, scheduleExportRows, taxesPaidByFy, taxesPaidExportRows } from "@/lib/analytics/itr-schedule";
import { getChallans } from "@/lib/queries/challans";
import { aggregateTradesByFy, computeTaxTimeline, type CarryForwardLot } from "@/lib/analytics/capital-gains";
import { currentFy as deriveCurrentFy } from "@/lib/analytics/tax";
import { getBfLossRows, toSeedLots } from "@/lib/queries/bf-losses";
import { inr } from "@/lib/format";
import { AlertTriangle, Info, FileSpreadsheet, Receipt } from "lucide-react";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export const dynamic = "force-dynamic";

const EXPORT_COLS = [
  { key: "fy", label: "FY" }, { key: "head", label: "Head" },
  { key: "trades", label: "Trades" }, { key: "net", label: "Net P&L" },
  { key: "turnover", label: "Turnover (ICAI 11th ed.)" },
  { key: "turnoverBroker", label: "Turnover (broker basis)" },
  { key: "charges", label: "Charges/Expenses" },
];

const SCHEDULE_COLS = [
  { key: "fy", label: "FY" }, { key: "form", label: "Form" },
  { key: "schedule", label: "Schedule" }, { key: "code", label: "Item" },
  { key: "label", label: "Description" }, { key: "amount", label: "Amount" },
  { key: "note", label: "Note" },
];

// Schedule IT's own four columns, in the return's own order. A row with no
// challan behind it exports BLANK cells, never 0 (invariant 6) — see
// taxesPaidExportRows.
const CHALLAN_COLS = [
  { key: "fy", label: "FY" }, { key: "bsrCode", label: "BSR code" },
  { key: "paidOn", label: "Date of deposit" }, { key: "challanSerial", label: "Challan serial no." },
  { key: "amount", label: "Amount" }, { key: "note", label: "Note" },
];

export default function ItrPackPage() {
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;
  const trades = getTrades();
  const packs = itrPackByFy(
    trades.map((t) => ({
      segment: t.segment, buyDate: t.buyDate, sellDate: t.sellDate,
      grossPnl: t.grossPnl, netPnl: t.netPnl, sellValue: t.sellValue,
      chargesTotal: t.chargesTotal, isOpen: t.isOpen,
    })),
    fyStartMonth,
  );

  // Carry-forward comes from the SAME set-off engine the Tax Summary uses, so
  // Schedule CFL cannot drift from the figures on that page.
  const currentFy = packs[packs.length - 1]?.fy ?? "2026-27";
  const byFy = aggregateTradesByFy(
    trades.filter((t) => !t.isOpen).map((t) => ({
      segment: t.segment, buyDate: t.buyDate, sellDate: t.sellDate,
      buyValue: t.buyValue, sellValue: t.sellValue, netPnl: t.netPnl,
      fmv31Jan2018: t.fmv31Jan2018,
    })),
    fyStartMonth,
    currentFy,
  );
  // Pre-journal b/f losses seed here too — same seed AND same SeedGuard as
  // the Tax Summary (a lot whose FY the journal covers is excluded on both
  // surfaces by construction), so Schedule CFL cannot drift from it.
  const timeline = computeTaxTimeline(
    byFy,
    toSeedLots(getBfLossRows(), { journalledFys: new Set(byFy.map((f) => f.fy)), currentFy: deriveCurrentFy(fyStartMonth) }),
  );
  const carryForwardByFy = new Map<string, CarryForwardLot[]>(
    timeline.map((r) => [r.fy, r.newCarryForward]),
  );

  const schedules = itrScheduleByFy(
    trades.map((t) => ({
      segment: t.segment, buyDate: t.buyDate, sellDate: t.sellDate,
      buyValue: t.buyValue, sellValue: t.sellValue,
      grossPnl: t.grossPnl, netPnl: t.netPnl,
      chargesTotal: t.chargesTotal, sttCtt: t.sttCtt,
      fmv31Jan2018: t.fmv31Jan2018, isOpen: t.isOpen,
    })),
    fyStartMonth,
    currentFy,
    carryForwardByFy,
  );

  // ── Taxes paid (advance tax) — Schedule IT, from the challan ledger ───────
  // Account-scoped by getChallans (aggregate reads every account). Every FY the
  // pack covers gets a block even with no challan, because an FY silently
  // omitted here reads as an FY with no tax due — and a blank is not a nil
  // payment (invariant 6, enforced in taxesPaidByFy).
  const taxesPaid = taxesPaidByFy(
    getChallans().map((c) => ({
      fy: c.fy, paidOn: c.paidOn, amount: c.amount,
      bsrCode: c.bsrCode, challanSerial: c.challanSerial, note: c.note,
    })),
    packs.map((p) => p.fy),
  );
  const challanExportRows = taxesPaidExportRows(taxesPaid);

  const exportRows = packs.flatMap((p) => [
    { fy: p.fy, head: "Speculative business (intraday equity)", trades: p.speculative.trades, net: p.speculative.net, turnover: p.speculative.turnover, turnoverBroker: p.speculative.turnoverBroker, charges: p.speculative.charges },
    { fy: p.fy, head: "Non-speculative business (F&O)", trades: p.nonSpeculative.trades, net: p.nonSpeculative.net, turnover: p.nonSpeculative.turnover, turnoverBroker: p.nonSpeculative.turnoverBroker, charges: p.nonSpeculative.charges },
    { fy: p.fy, head: "Capital gains — STCG", trades: p.capitalGains.trades, net: p.capitalGains.stcg, turnover: 0, turnoverBroker: 0, charges: p.capitalGains.charges },
    { fy: p.fy, head: "Capital gains — LTCG", trades: 0, net: p.capitalGains.ltcg, turnover: 0, turnoverBroker: 0, charges: 0 },
  ]);

  const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

  return (
    <>
      <PageHeader
        title="ITR Pack (India)"
        description="Head-wise segregation + turnover on BOTH bases + the audit read — a preparation pack for you and your CA."
        actions={<Badge variant="secondary">informational</Badge>}
      />
      <div className="space-y-5 p-6">
        <ProGate>
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-xs">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="space-y-1.5">
            <p>
              <span className="font-semibold">This is preparation, not filing advice.</span> Heads follow the
              standard treatment (intraday = speculative business, F&amp;O = non-speculative business,
              delivery/MTF = capital gains). Turnover is shown on BOTH bases in use, because your
              broker&apos;s tax report and this pack will otherwise disagree by design — on a real F&amp;O
              book the two differed by 6.5–8.7×. Thresholds also depend on your OVERALL income. Take
              this pack to a professional — don&apos;t file off it directly.
            </p>
            {/* Both basis sentences come from lib/analytics/turnover.ts — the one
                module allowed to describe what the numbers are. */}
            <p className="text-muted-foreground">{TURNOVER_BASIS}</p>
            <p className="text-muted-foreground">{BROKER_TURNOVER_BASIS}</p>
          </div>
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
                  {/* Section label resolves per FY (1961 Act vs 2025 Act) — a
                      hard-coded "44AB" mislabels every year from 2026-27 on. */}
                  {p.audit.level === "audit-required"
                    ? `⚠ ${section(p.fy, "audit")} audit required`
                    : p.audit.level === "audit-unlikely"
                      ? `${section(p.fy, "audit")} audit unlikely`
                      : "no business income"}
                </span>
              </CardHeader>
              <CardContent className="space-y-4">
                <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <KpiCard label="Speculative (intraday)" valueNum={p.speculative.net} format="inr0" valueClassName={pnl(p.speculative.net)} sub={`turnover ${inr(p.speculative.turnover, { decimals: 0 })} · ${p.speculative.trades} trades`} />
                  <KpiCard label="Non-speculative (F&O)" valueNum={p.nonSpeculative.net} format="inr0" valueClassName={pnl(p.nonSpeculative.net)} sub={`turnover ${inr(p.nonSpeculative.turnover, { decimals: 0 })} · ${p.nonSpeculative.trades} trades`} />
                  <KpiCard label="STCG (delivery/MTF)" valueNum={p.capitalGains.stcg} format="inr0" valueClassName={pnl(p.capitalGains.stcg)} sub={`${p.capitalGains.trades} CG trades`} />
                  <KpiCard label="LTCG (≥ 12m)" valueNum={p.capitalGains.ltcg} format="inr0" valueClassName={pnl(p.capitalGains.ltcg)} sub="grandfathering on Tax Summary" />
                </section>

                {/* Turnover, both ways — the same book produces BOTH numbers,
                    and they can land on opposite sides of an audit threshold.
                    Showing one would make either the broker's report or this
                    pack look broken; showing both, labelled, is the product's
                    stance (owner decision, 2026-09-01). */}
                {(p.speculative.turnover > 0 || p.nonSpeculative.turnover > 0) && (
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-card-hover/40 text-left text-muted-foreground">
                        <tr>
                          <th className="p-2 font-medium">Turnover basis</th>
                          <th className="p-2 text-right font-medium">Intraday</th>
                          <th className="p-2 text-right font-medium">F&amp;O</th>
                          <th className="p-2 text-right font-medium">Combined</th>
                          <th className="p-2 font-medium">Audit read</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono tabular-nums">
                        <tr className="border-t border-border">
                          <td className="p-2 font-sans">ICAI 11th ed. (differences + option premium)</td>
                          <td className="p-2 text-right">{inr(p.speculative.turnover, { decimals: 0 })}</td>
                          <td className="p-2 text-right">{inr(p.nonSpeculative.turnover, { decimals: 0 })}</td>
                          <td className="p-2 text-right font-semibold">{inr(p.audit.combinedBusinessTurnover, { decimals: 0 })}</td>
                          <td className={`p-2 font-sans ${p.audit.level === "audit-required" ? "text-loss" : "text-muted-foreground"}`}>
                            {p.audit.level === "audit-required" ? "audit required" : p.audit.level === "audit-unlikely" ? "audit unlikely" : "—"}
                          </td>
                        </tr>
                        <tr className="border-t border-border">
                          <td className="p-2 font-sans">Broker reports (differences only)</td>
                          <td className="p-2 text-right">{inr(p.speculative.turnoverBroker, { decimals: 0 })}</td>
                          <td className="p-2 text-right">{inr(p.nonSpeculative.turnoverBroker, { decimals: 0 })}</td>
                          <td className="p-2 text-right font-semibold">{inr(p.auditBroker.combinedBusinessTurnover, { decimals: 0 })}</td>
                          <td className={`p-2 font-sans ${p.auditBroker.level === "audit-required" ? "text-loss" : "text-muted-foreground"}`}>
                            {p.auditBroker.level === "audit-required" ? "audit required" : p.auditBroker.level === "audit-unlikely" ? "audit unlikely" : "—"}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    {p.audit.level !== p.auditBroker.level && (
                      <p className="border-t border-warning/40 bg-warning/10 p-2 text-[0.6875rem]">
                        The two bases land on DIFFERENT sides of the threshold this year — which method
                        applies is exactly the question to put to your CA, with this table in hand.
                      </p>
                    )}
                  </div>
                )}

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
                  Schedule CG (A3 · short-term, B4 · long-term), Schedule BP and Schedule CFL, in the
                  return&apos;s own item codes. Statutory citations follow the Act in force for each year.
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

        {/* ── Taxes paid (advance tax) ────────────────────────────────────────
            Schedule IT of the return: BSR code, date of deposit, serial number,
            amount — one row per challan, straight from the dated ledger on the
            Advance tax planner. An FY with nothing recorded shows blanks and
            says why; it never shows ₹0, because "paid nothing" and "recorded
            nothing" are different answers and only one of them is observed. */}
        {taxesPaid.length > 0 && (
          <Card className="p-0">
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Receipt className="size-4" /> Taxes paid (advance tax)
                </CardTitle>
                <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                  Your recorded challans per year, in Schedule IT&apos;s own columns. Record them on the{" "}
                  <Link href="/reports/advance-tax" className="underline underline-offset-2">Advance tax planner</Link>,
                  where the dates also drive the instalment maths.
                </p>
              </div>
              <ExportButtons filename="vyuha-itr-taxes-paid" columns={CHALLAN_COLS} rows={challanExportRows} />
            </CardHeader>
            <CardContent className="space-y-6">
              {taxesPaid.map((b) => (
                <section key={b.fy} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">FY {b.fy}</h3>
                    {b.count > 0 ? (
                      <Badge variant="secondary">
                        {b.count} challan{b.count === 1 ? "" : "s"} · {inr(b.total ?? 0, { decimals: 0 })}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">nothing recorded</Badge>
                    )}
                  </div>

                  <ReportTable>
                    <ReportThead>
                      <ReportTh>BSR code</ReportTh>
                      <ReportTh>Date of deposit</ReportTh>
                      <ReportTh>Challan serial no.</ReportTh>
                      <ReportTh align="right">Amount</ReportTh>
                      <ReportTh>Note</ReportTh>
                    </ReportThead>
                    <tbody>
                      {b.lines.map((l, i) => (
                        <ReportTr key={`${b.fy}-${i}`} className={l.amount === null ? "bg-card-hover/30" : undefined}>
                          <ReportTd className="font-mono" muted={l.bsrCode === null}>{l.bsrCode ?? "—"}</ReportTd>
                          <ReportTd muted={l.paidOn === null}>{l.paidOn ?? "—"}</ReportTd>
                          <ReportTd className="font-mono" muted={l.challanSerial === null}>{l.challanSerial ?? "—"}</ReportTd>
                          <ReportTd align="right">
                            {/* null ⇒ "—", never 0: the same rule Schedule CFL
                                follows, and the reason this column exists. */}
                            {l.amount === null ? <span className="text-muted-foreground">—</span> : inr(l.amount, { decimals: 0 })}
                          </ReportTd>
                          <ReportTd className="max-w-72 whitespace-normal text-muted-foreground">{l.note || "—"}</ReportTd>
                        </ReportTr>
                      ))}
                    </tbody>
                  </ReportTable>

                  <ul className="space-y-1 text-[0.6875rem] text-muted-foreground">
                    {b.cautions.map((c, i) => (
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
