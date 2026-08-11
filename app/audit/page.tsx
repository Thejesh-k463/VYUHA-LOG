import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { getAuditLog } from "@/lib/queries/audit";
import { diffFields } from "@/lib/analytics/audit-diff";
import { categorizeAuditRow } from "@/lib/domain/audit-categories";
import { AuditLogClient, type AuditDisplayRow } from "@/components/system/audit-log-client";

export const dynamic = "force-dynamic";

const ENTITY_LABEL: Record<string, string> = {
  trade: "Trade",
  charge_config: "Charge config",
  risk_config: "Risk config",
  settings: "Settings",
  capital: "Capital",
  ledger: "Ledger",
  restriction: "Restriction",
};

function fmt(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function AuditPage() {
  const raw = getAuditLog(250);

  // Classify and diff server-side — the client component only filters/displays.
  const rows: AuditDisplayRow[] = raw.map((r) => ({
    id: r.id,
    ts: r.ts,
    entity: r.entity,
    entityLabel: ENTITY_LABEL[r.entity] ?? r.entity,
    entityId: r.entityId,
    action: r.action,
    summary: r.summary,
    source: r.source,
    category: categorizeAuditRow(r),
    changes: diffFields(r.before, r.after).map((c) => ({
      field: c.field,
      from: fmt(c.from),
      to: fmt(c.to),
    })),
  }));

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Immutable change history — every trade, config, capital and ledger mutation, grouped by what happened."
        actions={<Badge variant="secondary">{rows.length} entries</Badge>}
      />
      <div className="space-y-5 p-6">
        <AuditLogClient rows={rows} />
        <p className="text-[0.6875rem] text-muted-foreground">
          Append-only: entries are written from a best-effort hook inside each mutation and are never edited or deleted
          from the UI. Shows the most recent 250 changes.
        </p>
      </div>
    </>
  );
}
