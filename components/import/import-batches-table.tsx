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
import type { DeletePreview } from "@/lib/domain/delete-scope";
import { importShapeSentence, importShapeCompact } from "@/lib/domain/import-shape";

export interface ImportBatchRow {
  id: number;
  broker: string;
  fileName: string;
  rowCount: number;
  addedCount: number;
  skippedCount: number;
  importedAt: string;
  tradeCount: number;
  /** Statement lines read from the file when the parser paired them into
   *  fewer positions (Dhan GTR). Null when rows === trades. */
  sourceRows: number | null;
  /** Positions still holding quantity, excluding opening sells. */
  openCount: number;
  /** Sells whose matching buy the file never showed — P&L reads "—". */
  openingSells: number;
  /** Resolved server-side so the dialog shows the real blast radius, not a
   *  count. Null when the batch has no trades left. */
  preview: DeletePreview | null;
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
          <ReportTh align="right">Executions → positions</ReportTh>
          <ReportTh align="right">Added</ReportTh>
          <ReportTh align="right">Skipped</ReportTh>
          <ReportTh align="right">Trades now</ReportTh>
          <ReportTh aria-label="Actions" />
        </ReportThead>
        <tbody>
          {batches.map((b) => {
            const shape = {
              sourceRows: b.sourceRows,
              positions: b.rowCount,
              open: b.openCount,
              openingSells: b.openingSells,
            };
            return (
            <ReportTr key={b.id}>
              <ReportTd muted>{fmtDate(b.importedAt)}</ReportTd>
              <ReportTd>{BROKER_LABELS[b.broker as Broker] ?? b.broker}</ReportTd>
              <ReportTd className="font-mono text-xs">{b.fileName}</ReportTd>
              {/* The compact form fits the column; the full sentence is the
                  title, so hovering answers "where did my other rows go?"
                  without widening the table. */}
              <ReportTd align="right" title={importShapeSentence(shape)}>
                <span className="whitespace-nowrap">{importShapeCompact(shape)}</span>
                {(b.openCount > 0 || b.openingSells > 0) && (
                  <span className="block text-[0.65rem] font-normal text-muted-foreground">
                    {[b.openCount > 0 ? `${b.openCount} open` : null,
                      b.openingSells > 0 ? `${b.openingSells} opening ${b.openingSells === 1 ? "sell" : "sells"}` : null]
                      .filter(Boolean).join(", ")}
                  </span>
                )}
              </ReportTd>
              <ReportTd align="right" className="text-profit">{b.addedCount}</ReportTd>
              <ReportTd align="right" muted>{b.skippedCount}</ReportTd>
              <ReportTd align="right">{b.tradeCount > 0 ? b.tradeCount : <Badge variant="outline">none</Badge>}</ReportTd>
              <ReportTd className="text-right">
                <Button size="sm" variant="ghost" title="Delete this import" onClick={() => setTarget(b)}>
                  <Trash2 className="size-3.5 text-loss" />
                </Button>
              </ReportTd>
            </ReportTr>
            );
          })}
        </tbody>
      </ReportTable>
      <DeleteImportDialog
        batch={target}
        preview={target?.preview ?? null}
        open={target != null}
        onOpenChange={(v) => !v && setTarget(null)}
      />
    </>
  );
}
