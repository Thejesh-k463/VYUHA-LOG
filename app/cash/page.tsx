import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { LedgerExportButtons } from "@/components/cash/ledger-export";
import { LedgerForm } from "@/components/cash/ledger-form";
import { LedgerImport } from "@/components/cash/ledger-import";
import { LedgerTable } from "@/components/cash/ledger-table";
import { getCapitalConfigured, getLedgerGroups, getLedgerRunningRows, getOpeningByBucketPaise } from "@/lib/queries/ledger";
import { LEDGER_PAGE_SIZE, summariseLedgerGroups, type BucketLedger } from "@/lib/analytics/ledger";
import { formatPaise } from "@/lib/money";
import Link from "next/link";

export const dynamic = "force-dynamic";

const BUCKET_LABEL: Record<string, string> = { equity: "Equity", active: "Trade F&O", "": "Unassigned" };

function BucketCard({ b, configured }: { b: BucketLedger; configured: boolean }) {
  const grew = b.availablePaise >= b.openingPaise;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{BUCKET_LABEL[b.bucket] ?? b.bucket}</CardTitle>
        <Badge variant={grew ? "profit" : "loss"}>{grew ? "↑" : "↓"} {formatPaise(b.flowsPaise, { decimals: 0 })}</Badge>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold tabular-nums ${grew ? "text-profit" : "text-loss"}`}>
          {formatPaise(b.availablePaise, { decimals: 0 })}
        </div>
        <div className="mt-1 text-[0.6875rem] text-muted-foreground">
          {/* "—" over an invented ₹0 opening (invariant 6): unset capital means
              the big number above is net flows, and the label says which. */}
          {configured ? <>available · opening {formatPaise(b.openingPaise, { decimals: 0 })}</> : <>net flows · opening —</>}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[0.6875rem]">
          <Line label="Deposits" v={b.depositsPaise} />
          <Line label="Withdrawals" v={b.withdrawalsPaise} />
          <Line label="Charges / MTF" v={b.chargesPaise} />
          <Line label="Realised P&L" v={b.realisedPnlPaise} />
        </div>
      </CardContent>
    </Card>
  );
}

function Line({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground"}`}>
        {v === 0 ? "—" : formatPaise(v, { decimals: 0 })}
      </span>
    </div>
  );
}

export default function CashPage() {
  // Sums and running balances are computed in SQL; the render ships only one
  // page of rows. At 60k entries the old entry-level path materialised the
  // whole ledger into the RSC payload twice (table + export) — a 27 s render.
  const opening = getOpeningByBucketPaise();
  const configured = getCapitalConfigured();
  const s = summariseLedgerGroups(getLedgerGroups(), opening);
  const display = getLedgerRunningRows({ limit: LEDGER_PAGE_SIZE }); // latest first

  return (
    <>
      <PageHeader
        title="Cash & ledger"
        description="Fund flows in integer paise — available capital is derived from opening balance + ledger."
        actions={<Badge variant="secondary">{s.totalCount} entries</Badge>}
      />
      <div className="space-y-5 p-6">
        {/* Same rule as the trackers: no configured capital means no invented
            opening balance. Balances below are then honest net-flow figures,
            and this one line says so — "—" plus a nudge beats a confident
            ledger reconciled against a fabricated opening (invariant 6). */}
        {!configured.any && (
          <Card className="border-warning/40">
            <CardContent className="p-4 text-sm">
              <div className="font-medium text-warning">No opening capital is configured.</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Running balances and &quot;available&quot; figures show net ledger flows only — no opening
                balance is added, because none is set. Set your bucket capital under{" "}
                <Link href="/settings" className="underline">Settings → Capital &amp; Go-Live</Link> to
                reconcile the ledger against a real opening.
              </p>
            </CardContent>
          </Card>
        )}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label="Total available" value={formatPaise(s.totalAvailablePaise, { decimals: 0 })} valueClassName={s.totalFlowsPaise >= 0 ? "text-profit" : "text-loss"} sub={configured.any ? "opening + ledger" : "ledger flows only — no opening set"} />
          <KpiCard label="Opening capital" value={configured.any ? formatPaise(s.totalOpeningPaise, { decimals: 0 }) : "—"} sub={configured.any ? "from settings" : "set capital in Settings"} />
          <KpiCard label="Net fund flows" value={formatPaise(s.totalFlowsPaise, { decimals: 0 })} valueClassName={s.totalFlowsPaise >= 0 ? "text-profit" : "text-loss"} sub="Σ all entries" />
          <KpiCard label="Deposits − withdrawals" value={formatPaise(s.byType.deposit + s.byType.withdrawal, { decimals: 0 })} sub="external cash" />
        </section>

        <div className="grid gap-3 md:grid-cols-2">
          {s.buckets.filter((b) => b.bucket === "equity" || b.bucket === "active").map((b) => (
            <BucketCard key={b.bucket} b={b} configured={b.bucket === "equity" ? configured.equity : configured.active} />
          ))}
        </div>

        <LedgerImport />

        <Card>
          <CardHeader><CardTitle>Add ledger entry</CardTitle></CardHeader>
          <CardContent><LedgerForm /></CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Ledger</CardTitle>
            <LedgerExportButtons filename="vyuha-ledger" total={s.totalCount} />
          </CardHeader>
          <CardContent className="p-0">
            <LedgerTable rows={display} total={s.totalCount} />
          </CardContent>
        </Card>

        <p className="text-[0.6875rem] text-muted-foreground">
          P0.1/P0.2: money here is stored and summed as integer paise (no float drift), and capital is derived rather than
          hand-edited. This ledger is the basis for a true money-weighted return (XIRR) once trade cashflows are posted to
          it. Existing trade/charge columns migrate onto the paise core in a later staged pass.
        </p>
      </div>
    </>
  );
}
