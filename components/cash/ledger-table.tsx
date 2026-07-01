"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";
import { formatPaise } from "@/lib/money";
import { TYPE_LABEL, type RunningRow } from "@/lib/analytics/ledger";

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
    return <p className="p-5 text-sm text-muted-foreground">No ledger entries yet. Add a deposit to seed your cash balance.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-y border-border text-left text-muted-foreground">
            <th className="px-2.5 py-2 font-medium">Date</th>
            <th className="px-2 py-2 font-medium">Bucket</th>
            <th className="px-2 py-2 font-medium">Type</th>
            <th className="px-2.5 py-2 text-right font-medium">Amount</th>
            <th className="px-2.5 py-2 text-right font-medium">Balance</th>
            <th className="px-2.5 py-2 font-medium">Note</th>
            <th className="px-2 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-border/40">
              <td className="px-2.5 py-1.5 tabular-nums">{r.date}</td>
              <td className="px-2 py-1.5">
                <Badge variant="secondary">{r.bucket || "—"}</Badge>
              </td>
              <td className="px-2 py-1.5">{TYPE_LABEL[r.type]}</td>
              <td className={`px-2.5 py-1.5 text-right tabular-nums ${r.amountPaise >= 0 ? "text-profit" : "text-loss"}`}>
                {r.amountPaise >= 0 ? "+" : ""}
                {formatPaise(r.amountPaise, { decimals: 0 })}
              </td>
              <td className="px-2.5 py-1.5 text-right tabular-nums font-medium">{formatPaise(r.balancePaise, { decimals: 0 })}</td>
              <td className="px-2.5 py-1.5 text-muted-foreground">{r.note ?? "—"}</td>
              <td className="px-2 py-1.5 text-right">
                <button
                  onClick={() => del(r.id)}
                  disabled={busy === r.id}
                  className="text-muted-foreground hover:text-loss disabled:opacity-50"
                  aria-label="Delete entry"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
