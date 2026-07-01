import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getAuditLog } from "@/lib/queries/audit";
import { diffFields } from "@/lib/analytics/audit-diff";

export const dynamic = "force-dynamic";

const actionVariant: Record<string, "profit" | "secondary" | "loss" | "accent" | "warning"> = {
  create: "profit",
  update: "secondary",
  delete: "loss",
  close: "accent",
  override: "warning",
};

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
  const rows = getAuditLog(250);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Immutable change history — every trade, config, capital and ledger mutation."
        actions={<Badge variant="secondary">{rows.length} entries</Badge>}
      />
      <div className="space-y-5 p-6">
        <Card className="p-0">
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                No changes recorded yet. Edits to trades, settings, capital and the ledger will appear here.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-y border-border text-left text-muted-foreground">
                      <th className="px-2.5 py-2 font-medium">When</th>
                      <th className="px-2 py-2 font-medium">Entity</th>
                      <th className="px-2 py-2 font-medium">Action</th>
                      <th className="px-2.5 py-2 font-medium">Summary</th>
                      <th className="px-2.5 py-2 font-medium">Changes</th>
                      <th className="px-2 py-2 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const changes = diffFields(r.before, r.after);
                      return (
                        <tr key={r.id} className="border-b border-border/40 align-top">
                          <td className="px-2.5 py-1.5 tabular-nums text-muted-foreground whitespace-nowrap">{r.ts}</td>
                          <td className="px-2 py-1.5">
                            <Badge variant="outline">{ENTITY_LABEL[r.entity] ?? r.entity}</Badge>
                            {r.entityId != null ? <span className="ml-1 text-muted-foreground">#{r.entityId}</span> : null}
                          </td>
                          <td className="px-2 py-1.5">
                            <Badge variant={actionVariant[r.action] ?? "secondary"}>{r.action}</Badge>
                          </td>
                          <td className="px-2.5 py-1.5">{r.summary ?? "—"}</td>
                          <td className="px-2.5 py-1.5 text-muted-foreground">
                            {changes.length === 0
                              ? "—"
                              : changes.slice(0, 4).map((c, i) => (
                                  <span key={c.field} className="mr-2 inline-block">
                                    <span className="text-foreground">{c.field}</span>: {fmt(c.from)} →{" "}
                                    <span className="text-foreground">{fmt(c.to)}</span>
                                    {i < Math.min(changes.length, 4) - 1 ? "" : ""}
                                  </span>
                                ))}
                            {changes.length > 4 ? <span>+{changes.length - 4} more</span> : null}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">{r.source}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        <p className="text-[11px] text-muted-foreground">
          Append-only: entries are written from a best-effort hook inside each mutation and are never edited or deleted
          from the UI. Shows the most recent 250 changes.
        </p>
      </div>
    </>
  );
}
