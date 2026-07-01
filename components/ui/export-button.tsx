"use client";

import { Button } from "@/components/ui/button";
import { exportRows, type ExportColumn } from "@/lib/export";
import { Download } from "lucide-react";

export function ExportButtons<T>({
  filename,
  columns,
  rows,
}: {
  filename: string;
  columns: ExportColumn<T>[];
  rows: T[];
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" variant="outline" onClick={() => exportRows(filename, columns, rows, "csv")} disabled={rows.length === 0}>
        <Download className="size-3.5" /> CSV
      </Button>
      <Button size="sm" variant="outline" onClick={() => exportRows(filename, columns, rows, "xlsx")} disabled={rows.length === 0}>
        <Download className="size-3.5" /> XLSX
      </Button>
    </div>
  );
}
