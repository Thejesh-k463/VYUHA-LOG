"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { exportRows, type ExportColumn } from "@/lib/export";
import type { ItrExportRow } from "@/lib/queries/tax-itr";

/**
 * ITR CSV/XLSX export that fetches its rows on click instead of shipping one
 * row per closed trade in the RSC payload on every render (~4.8 MB at 25k
 * trades, paid even by visitors who never export). Same columns, same values,
 * same order (closed trades then exited IPOs) as the old inline `itrRows` —
 * /api/tax-itr builds them from the identical shared base the page renders
 * from (lib/queries/tax-itr.ts). Pattern copied from the /cash ledger export.
 */

const COLS: ExportColumn<ItrExportRow>[] = [
  { key: "scrip", label: "Scrip" }, { key: "acquired", label: "Date of acquisition" },
  { key: "sold", label: "Date of sale" }, { key: "cost", label: "Cost of acquisition" },
  { key: "consideration", label: "Sale consideration" }, { key: "netGain", label: "Net gain (post-charge)" },
  { key: "term", label: "Term" }, { key: "head", label: "Head / schedule" },
  { key: "taxableGain", label: "Taxable gain (grandfathered)" },
];

export function ItrExportButtons({ filename, total }: { filename: string; total: number }) {
  const [busy, setBusy] = useState<"csv" | "xlsx" | null>(null);

  async function run(format: "csv" | "xlsx") {
    setBusy(format);
    try {
      const res = await fetch("/api/tax-itr");
      const json = await res.json().catch(() => null);
      if (!json?.ok || !Array.isArray(json.rows)) return;
      await exportRows(filename, COLS, json.rows as ItrExportRow[], format);
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
