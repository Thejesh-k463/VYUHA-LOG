"use client";

/** Recent-imports table with per-row delete (batch, optionally cascading). */

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteImportDialog } from "./delete-import-dialog";
import { BROKER_LABELS, type Broker } from "@/lib/domain/constants";
import { fmtDate } from "@/lib/format";
import { Trash2 } from "lucide-react";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

export interface ImportBatchRow {
  id: number;
  broker: string;
  fileName: string;
  rowCount: number;
  addedCount: number;
  skippedCount: number;
  importedAt: string;
  tradeCount: number;
}

export function ImportBatchesTable({ batches }: { batches: ImportBatchRow[] }) {
  const [target, setTarget] = React.useState<ImportBatchRow | null>(null);

  if (batches.length === 0) return <EmptyState variant="journal" title="No imports yet" />;

  return (
    <>
      <ReportTable>
        <ReportThead>
          <ReportTh>When</ReportTh>
          <ReportTh>Broker</ReportTh>
          <ReportTh>File</ReportTh>
          <ReportTh align="right">Rows</ReportTh>
          <ReportTh align="right">Added</ReportTh>
          <ReportTh align="right">Skipped</ReportTh>
          <ReportTh align="right">Trades now</ReportTh>
          <ReportTh aria-label="Actions" />
        </ReportThead>
        <tbody>
          {batches.map((b) => (
            <ReportTr key={b.id}>
              <ReportTd muted>{fmtDate(b.importedAt)}</ReportTd>
              <ReportTd>{BROKER_LABELS[b.broker as Broker] ?? b.broker}</ReportTd>
              <ReportTd className="font-mono text-xs">{b.fileName}</ReportTd>
              <ReportTd align="right">{b.rowCount}</ReportTd>
              <ReportTd align="right" className="text-profit">{b.addedCount}</ReportTd>
              <ReportTd align="right" muted>{b.skippedCount}</ReportTd>
              <ReportTd align="right">{b.tradeCount > 0 ? b.tradeCount : <Badge variant="outline">none</Badge>}</ReportTd>
              <ReportTd className="text-right">
                <Button size="sm" variant="ghost" title="Delete this import" onClick={() => setTarget(b)}>
                  <Trash2 className="size-3.5 text-loss" />
                </Button>
              </ReportTd>
            </ReportTr>
          ))}
        </tbody>
      </ReportTable>
      <DeleteImportDialog batch={target} open={target != null} onOpenChange={(v) => !v && setTarget(null)} />
    </>
  );
}
