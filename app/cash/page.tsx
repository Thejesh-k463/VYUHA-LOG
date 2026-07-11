import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { ExportButtons } from "@/components/ui/export-button";
import { LedgerForm } from "@/components/cash/ledger-form";
import { LedgerTable } from "@/components/cash/ledger-table";
import { getSettings } from "@/lib/queries/settings";
import { getLedgerEntries } from "@/lib/queries/ledger";
import { summariseLedger, type BucketLedger } from "@/lib/analytics/ledger";
import { toPaise, toRupees, formatPaise } from "@/lib/money";

export const dynamic = "force-dynamic";

const COLS = [
  { key: "date", label: "Date" },
  { key: "bucket", label: "Bucket" },
  { key: "type", label: "Type" },
  { key: "amount", label: "Amount" },
  { key: "balance", label: "Balance" },
  { key: "note", label: "Note" },
] as const;

const BUCKET_LABEL: Record<string, string> = { equity: "Equity (₹13L)", active: "Trade F&O (₹4L)", "": "Unassigned" };

function BucketCard({ b }: { b: BucketLedger }) {
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
        <div className="mt-1 text-[11px] text-muted-foreground">available · opening {formatPaise(b.openingPaise, { decimals: 0 })}</div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
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
  const settings = getSettings();
  const opening = {
    equity: toPaise(settings?.equityCapital ?? 1300000),
    active: toPaise(settings?.activeCapital ?? 400000),
  };
  const entries = getLedgerEntries();
  const s = summariseLedger(entries, opening);
  const display = [...s.running].reverse(); // latest first
  const exportData = display.map((r) => ({
    date: r.date,
    bucket: r.bucket || "—",
    type: r.type,
    amount: toRupees(r.amountPaise),
    balance: toRupees(r.balancePaise),
    note: r.note ?? "",
  }));

  return (
    <>
      <PageHeader
        title="Cash & ledger"
        description="Fund flows in integer paise — available capital is derived from opening balance + ledger."
        actions={<Badge variant="secondary">{entries.length} entries</Badge>}
      />
      <div className="space-y-5 p-6">
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label="Total available" value={formatPaise(s.totalAvailablePaise, { decimals: 0 })} valueClassName={s.totalFlowsPaise >= 0 ? "text-profit" : "text-loss"} sub="opening + ledger" />
          <KpiCard label="Opening capital" value={formatPaise(s.totalOpeningPaise, { decimals: 0 })} sub="from settings" />
          <KpiCard label="Net fund flows" value={formatPaise(s.totalFlowsPaise, { decimals: 0 })} valueClassName={s.totalFlowsPaise >= 0 ? "text-profit" : "text-loss"} sub="Σ all entries" />
          <KpiCard label="Deposits − withdrawals" value={formatPaise(s.byType.deposit + s.byType.withdrawal, { decimals: 0 })} sub="external cash" />
        </section>

        <div className="grid gap-3 md:grid-cols-2">
          {s.buckets.filter((b) => b.bucket === "equity" || b.bucket === "active").map((b) => (
            <BucketCard key={b.bucket} b={b} />
          ))}
        </div>

        <Card>
          <CardHeader><CardTitle>Add ledger entry</CardTitle></CardHeader>
          <CardContent><LedgerForm /></CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Ledger</CardTitle>
            <ExportButtons filename="vyuha-ledger" columns={COLS as unknown as { key: string; label: string }[]} rows={exportData} />
          </CardHeader>
          <CardContent className="p-0">
            <LedgerTable rows={display} />
          </CardContent>
        </Card>

        <p className="text-[11px] text-muted-foreground">
          P0.1/P0.2: money here is stored and summed as integer paise (no float drift), and capital is derived rather than
          hand-edited. This ledger is the basis for a true money-weighted return (XIRR) once trade cashflows are posted to
          it. Existing trade/charge columns migrate onto the paise core in a later staged pass.
        </p>
      </div>
    </>
  );
}
