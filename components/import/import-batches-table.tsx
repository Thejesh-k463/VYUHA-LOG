"use client";

/** Recent-imports table with per-row delete (batch, optionally cascading). */

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteImportDialog } from "./delete-import-dialog";
import { BROKER_LABELS, type Broker } from "@/lib/domain/constants";
import { fmtDate } from "@/lib/format";
import { Trash2 } from "lucide-react";

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

  if (batches.length === 0) return <p className="text-sm text-muted-foreground">No imports yet.</p>;

  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-4 font-medium">When</th>
            <th className="py-2 pr-4 font-medium">Broker</th>
            <th className="py-2 pr-4 font-medium">File</th>
            <th className="py-2 pr-4 text-right font-medium">Rows</th>
            <th className="py-2 pr-4 text-right font-medium">Added</th>
            <th className="py-2 pr-4 text-right font-medium">Skipped</th>
            <th className="py-2 pr-4 text-right font-medium">Trades now</th>
            <th className="py-2 font-medium" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className="border-b border-border/50">
              <td className="py-1.5 pr-4 text-muted-foreground">{fmtDate(b.importedAt)}</td>
              <td className="py-1.5 pr-4">{BROKER_LABELS[b.broker as Broker] ?? b.broker}</td>
              <td className="py-1.5 pr-4 font-mono text-xs">{b.fileName}</td>
              <td className="py-1.5 pr-4 text-right tabular-nums">{b.rowCount}</td>
              <td className="py-1.5 pr-4 text-right tabular-nums text-profit">{b.addedCount}</td>
              <td className="py-1.5 pr-4 text-right tabular-nums text-muted-foreground">{b.skippedCount}</td>
              <td className="py-1.5 pr-4 text-right tabular-nums">{b.tradeCount > 0 ? b.tradeCount : <Badge variant="outline">none</Badge>}</td>
              <td className="py-1.5 text-right">
                <Button size="sm" variant="ghost" title="Delete this import" onClick={() => setTarget(b)}>
                  <Trash2 className="size-3.5 text-loss" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <DeleteImportDialog batch={target} open={target != null} onOpenChange={(v) => !v && setTarget(null)} />
    </>
  );
}
