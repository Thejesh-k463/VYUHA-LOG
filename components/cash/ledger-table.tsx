"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { formatPaise } from "@/lib/money";
import { LEDGER_PAGE_SIZE, TYPE_LABEL, type RunningRow } from "@/lib/analytics/ledger";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

export function LedgerTable({ rows, total }: { rows: RunningRow[]; total: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [extra, setExtra] = useState<RunningRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Server-sent page first, then whatever load-more fetched. After any refresh
  // the server page may shift, so drop fetched rows it now already contains.
  const seen = new Set(rows.map((r) => r.id));
  const shown = [...rows, ...extra.filter((r) => !seen.has(r.id))];
  const remaining = Math.max(0, total - shown.length);

  async function loadMore() {
    setLoading(true);
    try {
      const res = await fetch(`/api/ledger?offset=${shown.length}&limit=${LEDGER_PAGE_SIZE}`);
      const json = await res.json().catch(() => null);
      if (json?.ok && Array.isArray(json.rows)) setExtra((prev) => [...prev, ...json.rows]);
    } finally {
      setLoading(false);
    }
  }

  async function del(id: number) {
    setBusy(id);
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    setBusy(null);
    if ((await res.json().catch(() => ({ ok: false }))).ok) {
      // Balances below the deleted row all change — restart from page one.
      setExtra([]);
      router.refresh();
    }
  }

  if (shown.length === 0) {
    return (
      <EmptyState
        variant="journal"
        title="No ledger entries yet"
        hint="Add a deposit to seed your cash balance."
      />
    );
  }

  return (
    <>
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
          {shown.map((r) => (
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
      {remaining > 0 && (
        <div className="flex items-center justify-center border-t p-3">
          <Button size="sm" variant="outline" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : `Load ${Math.min(LEDGER_PAGE_SIZE, remaining).toLocaleString("en-IN")} more (${remaining.toLocaleString("en-IN")} remaining)`}
          </Button>
        </div>
      )}
    </>
  );
}
