"use client";

/**
 * Grouped audit log.
 *
 * Category cards up top (count + most recent entry), the detail table below
 * showing only the selected category — "everything in one table" stopped
 * scaling once auto-MTM began writing a row per trading day. Selection is
 * plain useState derived at render; the rows themselves are classified and
 * diffed server-side, so this component only filters and displays.
 */

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  AUDIT_CATEGORIES,
  type AuditCategoryId,
} from "@/lib/domain/audit-categories";

export interface AuditDisplayRow {
  id: number;
  ts: string;
  entity: string;
  entityLabel: string;
  entityId: number | null;
  action: string;
  summary: string | null;
  source: string;
  category: AuditCategoryId;
  changes: { field: string; from: string; to: string }[];
}

const actionVariant: Record<string, "profit" | "secondary" | "loss" | "accent" | "warning"> = {
  create: "profit",
  update: "secondary",
  delete: "loss",
  close: "accent",
  override: "warning",
};

export function AuditLogClient({ rows }: { rows: AuditDisplayRow[] }) {
  const [selected, setSelected] = React.useState<AuditCategoryId | "all">("all");

  const counts = React.useMemo(() => {
    const m = new Map<AuditCategoryId, { n: number; latest: string }>();
    for (const r of rows) {
      const cur = m.get(r.category);
      if (cur) cur.n += 1;
      else m.set(r.category, { n: 1, latest: r.ts }); // rows arrive newest-first
    }
    return m;
  }, [rows]);

  const visible = selected === "all" ? rows : rows.filter((r) => r.category === selected);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <CategoryCard
          active={selected === "all"}
          label="All entries"
          hint="The full append-only record"
          count={rows.length}
          onClick={() => setSelected("all")}
        />
        {AUDIT_CATEGORIES.filter((c) => (counts.get(c.id)?.n ?? 0) > 0).map((c) => (
          <CategoryCard
            key={c.id}
            active={selected === c.id}
            label={c.label}
            hint={c.hint}
            count={counts.get(c.id)!.n}
            latest={counts.get(c.id)!.latest}
            onClick={() => setSelected(selected === c.id ? "all" : c.id)}
          />
        ))}
      </div>

      <Card className="p-0">
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Nothing in this category yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-y border-border text-left text-muted-foreground">
                    <th className="px-2.5 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">When</th>
                    <th className="px-2 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Entity</th>
                    <th className="px-2 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Action</th>
                    <th className="px-2.5 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Summary</th>
                    <th className="px-2.5 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Changes</th>
                    <th className="px-2 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id} className="border-b border-rule align-top">
                      <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums text-muted-foreground">{r.ts}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant="outline">{r.entityLabel}</Badge>
                        {r.entityId != null ? <span className="ml-1 text-muted-foreground">#{r.entityId}</span> : null}
                      </td>
                      <td className="px-2 py-1.5">
                        <Badge variant={actionVariant[r.action] ?? "secondary"}>{r.action}</Badge>
                      </td>
                      <td className="px-2.5 py-1.5">{r.summary ?? "—"}</td>
                      <td className="px-2.5 py-1.5 text-muted-foreground">
                        {r.changes.length === 0
                          ? "—"
                          : r.changes.slice(0, 4).map((c) => (
                              <span key={c.field} className="mr-2 inline-block">
                                <span className="text-foreground">{c.field}</span>: {c.from} →{" "}
                                <span className="text-foreground">{c.to}</span>
                              </span>
                            ))}
                        {r.changes.length > 4 ? <span>+{r.changes.length - 4} more</span> : null}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{r.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CategoryCard({
  active,
  label,
  hint,
  count,
  latest,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  count: number;
  latest?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-primary/50 bg-primary/10"
          : "border-border bg-card hover:bg-card-hover",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn("text-xs font-semibold", active ? "text-primary" : "text-foreground")}>{label}</span>
        <span className="tabular-nums text-xs text-muted-foreground">{count}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {latest ? `latest ${latest.slice(0, 16)}` : hint}
      </div>
    </button>
  );
}
