import { PageHeader } from "@/components/layout/page-header";
import { ImportClient } from "@/components/import/import-client";
import { BrokerConnect } from "@/components/import/broker-connect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getImportBatches } from "@/lib/queries/trades";
import { getAccounts, isAggregateView } from "@/lib/queries/accounts";
import { ImportBatchesTable } from "@/components/import/import-batches-table";
import { tradesInBatch } from "@/lib/queries/delete";

export const dynamic = "force-dynamic";

export default function ImportPage() {
  const batches = getImportBatches();
  // A6 — only the aggregate view leaves the destination account unanswered.
  const writeAccounts = isAggregateView() ? getAccounts().filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name })) : [];

  return (
    <>
      <PageHeader
        title="Import"
        description="Auto-detect broker & format, preview, then commit. Re-imports are de-duplicated."
      />
      <div className="space-y-6 p-6">
        <ImportClient writeAccounts={writeAccounts} />

        <BrokerConnect />

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recent imports</CardTitle>
            <Badge variant="secondary">{batches.length}</Badge>
          </CardHeader>
          <CardContent>
            <ImportBatchesTable
              batches={batches.map((b) => ({
                id: b.id, broker: b.broker, fileName: b.fileName, rowCount: b.rowCount,
                addedCount: b.addedCount, skippedCount: b.skippedCount, importedAt: b.importedAt,
                tradeCount: tradesInBatch(b.id),
              }))}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
