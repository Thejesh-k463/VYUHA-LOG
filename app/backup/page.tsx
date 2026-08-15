import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BackupPanel } from "@/components/system/backup-panel";
import { DeletedItemsPanel, DeletedItemsBadge } from "@/components/system/deleted-items-panel";
import { dbCounts } from "@/lib/backup";
import { listTrashSnapshots } from "@/lib/trash";
import { BACKUP_TABLES } from "@/lib/backup-format";

export const dynamic = "force-dynamic";

const TABLE_LABEL: Record<string, string> = {
  accounts: "Accounts",
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
  trade_legs: "Trade legs",
  symbol_aliases: "Aliases",
  benchmark_prices: "Benchmarks",
  instruments: "Instruments",
  price_history: "Price history",
  corporate_actions: "Corporate actions",
  playbooks: "Playbooks",
  margin_config: "Margin config",
  trade_attachments: "Attachments",
  broker_connections: "Broker connections",
  trading_sessions: "Session plans",
  regulatory_rule_packs: "Rule packs",
};

export default function BackupPage() {
  const counts = dbCounts();
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const snapshots = listTrashSnapshots();

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
                <div key={t} className="flex justify-between border-b border-rule py-0.5">
                  <span className="text-muted-foreground">{TABLE_LABEL[t] ?? t}</span>
                  <span className="tabular-nums">{counts[t] ?? 0}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Deleted items. Sits here rather than on the Trades screen because
            this is the page people reach for when something is missing. */}
        <Card id="deleted-items">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Deleted items</CardTitle>
            <DeletedItemsBadge snapshots={snapshots} />
          </CardHeader>
          <CardContent>
            <DeletedItemsPanel snapshots={snapshots} />
          </CardContent>
        </Card>

        <p className="text-[0.6875rem] text-muted-foreground">
          The portable backup includes every table and attachment and restores exactly after a preview.
          Wallpaper images are not included in backups. The SQLite download is the raw database file. <strong>Restore replaces all current data</strong> after validating
          the file is a Vyuha backup. A pre-migration snapshot is also written to <code>data/backups/</code> automatically
          before any schema migration.
        </p>
      </div>
    </>
  );
}
