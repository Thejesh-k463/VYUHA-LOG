"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";
import { formatPaise } from "@/lib/money";
import { TYPE_LABEL, type RunningRow } from "@/lib/analytics/ledger";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

export function LedgerTable({ rows }: { rows: RunningRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);

  async function del(id: number) {
    setBusy(id);
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    setBusy(null);
    if ((await res.json().catch(() => ({ ok: false }))).ok) router.refresh();
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        variant="journal"
        title="No ledger entries yet"
        hint="Add a deposit to seed your cash balance."
      />
    );
  }

  return (
    <ReportTable>
      <ReportThead>
        <ReportTh>Date</ReportTh>
        <ReportTh>Bucket</ReportTh>
        <ReportTh>Type</ReportTh>
        <ReportTh align="right">Amount</ReportTh>
        <ReportTh align="right">Balance</ReportTh>
        <ReportTh>Note</ReportTh>
        <ReportTh></ReportTh>
      </ReportThead>
      <tbody>
        {rows.map((r) => (
          <ReportTr key={r.id}>
            <ReportTd className="tabular-nums">{r.date}</ReportTd>
            <ReportTd>
              <Badge variant="secondary">{r.bucket || "—"}</Badge>
            </ReportTd>
            <ReportTd>{TYPE_LABEL[r.type]}</ReportTd>
            <ReportTd align="right" className={r.amountPaise >= 0 ? "text-profit" : "text-loss"}>
              {r.amountPaise >= 0 ? "+" : ""}
              {formatPaise(r.amountPaise, { decimals: 0 })}
            </ReportTd>
            <ReportTd align="right" className="font-medium">{formatPaise(r.balancePaise, { decimals: 0 })}</ReportTd>
            <ReportTd muted>{r.note ?? "—"}</ReportTd>
            <ReportTd className="text-right">
              <button
                onClick={() => del(r.id)}
                disabled={busy === r.id}
                className="text-muted-foreground hover:text-loss disabled:opacity-50"
                aria-label="Delete entry"
              >
                <Trash2 className="size-3.5" />
              </button>
            </ReportTd>
          </ReportTr>
        ))}
      </tbody>
    </ReportTable>
  );
}
