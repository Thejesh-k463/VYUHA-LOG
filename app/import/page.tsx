import { PageHeader } from "@/components/layout/page-header";
import { ImportClient } from "@/components/import/import-client";
import { BrokerConnect } from "@/components/import/broker-connect";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getImportBatches } from "@/lib/queries/trades";
import { getAccounts, isAggregateView } from "@/lib/queries/accounts";
import { BROKER_LABELS, type Broker } from "@/lib/domain/constants";
import { fmtDate } from "@/lib/format";

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
            {batches.length === 0 ? (
              <p className="text-sm text-muted-foreground">No imports yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Broker</th>
                    <th className="py-2 pr-4 font-medium">File</th>
                    <th className="py-2 pr-4 text-right font-medium">Rows</th>
                    <th className="py-2 pr-4 text-right font-medium">Added</th>
                    <th className="py-2 pr-4 text-right font-medium">Skipped</th>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
