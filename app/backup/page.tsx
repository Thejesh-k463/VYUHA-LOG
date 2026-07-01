import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BackupPanel } from "@/components/system/backup-panel";
import { dbCounts } from "@/lib/backup";
import { BACKUP_TABLES } from "@/lib/backup-format";

export const dynamic = "force-dynamic";

const TABLE_LABEL: Record<string, string> = {
  settings: "Settings",
  charge_config: "Charge config",
  risk_config: "Risk config",
  capital_snapshots: "Capital snapshots",
  import_batches: "Import batches",
  trades: "Trades",
  positions: "Positions",
  classification_overrides: "Overrides",
  mtm_prices: "MTM prices",
  ipos: "IPOs",
  restricted_securities: "Restricted",
  ledger_entries: "Ledger",
  audit_log: "Audit log",
};

export default function BackupPage() {
  const counts = dbCounts();
  const total = Object.values(counts).reduce((s, n) => s + n, 0);

  return (
    <>
      <PageHeader
        title="Backup & restore"
        description="Export the full journal as a portable file, or restore from one — your data never leaves the device."
        actions={<Badge variant="secondary">{total} rows</Badge>}
      />
      <div className="space-y-5 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Snapshot</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <BackupPanel />
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-4">
              {BACKUP_TABLES.map((t) => (
                <div key={t} className="flex justify-between border-b border-border/40 py-0.5">
                  <span className="text-muted-foreground">{TABLE_LABEL[t] ?? t}</span>
                  <span className="tabular-nums">{counts[t] ?? 0}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <p className="text-[11px] text-muted-foreground">
          The JSON backup is a complete, human-readable dump of every table and restores exactly (round-trips all rows).
          The SQLite download is the raw database file. <strong>Restore replaces all current data</strong> after validating
          the file is a Vyuha backup. A pre-migration snapshot is also written to <code>data/backups/</code> automatically
          before any schema migration.
        </p>
      </div>
    </>
  );
}
