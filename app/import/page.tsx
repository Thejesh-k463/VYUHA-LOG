import { PageHeader } from "@/components/layout/page-header";
import { ImportClient } from "@/components/import/import-client";
import { BrokerConnect } from "@/components/import/broker-connect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getImportBatches, getImportBatchShapes } from "@/lib/queries/trades";
import { getAccounts, getSelectedAccountId, isAggregateView } from "@/lib/queries/accounts";
import { ImportBatchesTable } from "@/components/import/import-batches-table";
import { tradesInBatch, previewImportBatchDelete } from "@/lib/queries/delete";

export const dynamic = "force-dynamic";

export default function ImportPage() {
  const batches = getImportBatches();
  const shapes = getImportBatchShapes();
  // A6 — only the aggregate view leaves the destination account unanswered.
  const writeAccounts = isAggregateView() ? getAccounts().filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name })) : [];
  // The remove-broker panel names the account it removes from. 0 (All
  // accounts) resolves to null: a view, never a write target (invariant 9).
  const selectedId = getSelectedAccountId();
  const selectedAccount = selectedId > 0 ? (getAccounts().find((a) => a.id === selectedId) ?? null) : null;

  return (
    <>
      <PageHeader
        title="Import"
        description="Auto-detect broker & format, preview, then commit. Re-imports are de-duplicated."
      />
      <div className="space-y-6 p-6">
        <ImportClient writeAccounts={writeAccounts} selectedAccount={selectedAccount ? { id: selectedAccount.id, name: selectedAccount.name } : null} />

        <BrokerConnect writeAccounts={writeAccounts} />

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recent imports</CardTitle>
            <Badge variant="secondary">{batches.length}</Badge>
          </CardHeader>
          <CardContent>
            <ImportBatchesTable
              batches={batches.map((b) => {
                const preview = previewImportBatchDelete(b.id);
                // "92 source lines" in notes → the Rows cell reads 92 → 73.
                const sourceRows = Number(b.notes?.match(/^(\d+) source lines$/)?.[1] ?? 0) || null;
                const shape = shapes.get(b.id) ?? { open: 0, openingSells: 0 };
                return {
                  id: b.id, broker: b.broker, fileName: b.fileName, rowCount: b.rowCount,
                  addedCount: b.addedCount, skippedCount: b.skippedCount, importedAt: b.importedAt,
                  tradeCount: tradesInBatch(b.id),
                  sourceRows,
                  openCount: shape.open,
                  openingSells: shape.openingSells,
                  preview: preview.empty ? null : preview,
                };
              })}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
