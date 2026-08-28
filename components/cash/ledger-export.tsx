"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { exportRows, type ExportColumn } from "@/lib/export";
import { toRupees } from "@/lib/money";
import type { RunningRow } from "@/lib/analytics/ledger";

/**
 * Ledger CSV/XLSX export that fetches ALL rows on click instead of shipping
 * the whole ledger in the RSC payload on every render (8 MB+ at 60k entries,
 * paid even by visitors who never export). Same columns, same values, same
 * order (latest first) as the old inline exportData — the balance column comes
 * from the identical SQL window the table uses.
 */

const COLS: ExportColumn<Record<string, string | number>>[] = [
  { key: "date", label: "Date" },
  { key: "bucket", label: "Bucket" },
  { key: "type", label: "Type" },
  { key: "amount", label: "Amount" },
  { key: "balance", label: "Balance" },
  { key: "note", label: "Note" },
];

export function LedgerExportButtons({ filename, total }: { filename: string; total: number }) {
  const [busy, setBusy] = useState<"csv" | "xlsx" | null>(null);

  async function run(format: "csv" | "xlsx") {
    setBusy(format);
    try {
      const res = await fetch("/api/ledger?all=1");
      const json = await res.json().catch(() => null);
      if (!json?.ok || !Array.isArray(json.rows)) return;
      const rows = (json.rows as RunningRow[]).map((r) => ({
        date: r.date,
        bucket: r.bucket || "—",
        type: r.type,
        amount: toRupees(r.amountPaise),
        balance: toRupees(r.balancePaise),
        note: r.note ?? "",
      }));
      await exportRows(filename, COLS, rows, format);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-1.5 print:hidden">
      <Button size="sm" variant="outline" onClick={() => run("csv")} disabled={total === 0 || busy !== null}>
        <Download className="size-3.5" /> {busy === "csv" ? "Preparing…" : "CSV"}
      </Button>
      <Button size="sm" variant="outline" onClick={() => run("xlsx")} disabled={total === 0 || busy !== null}>
        <Download className="size-3.5" /> {busy === "xlsx" ? "Preparing…" : "XLSX"}
      </Button>
    </div>
  );
}
