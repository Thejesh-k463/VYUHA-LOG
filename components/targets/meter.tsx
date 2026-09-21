"use client";

import { counter } from "@/lib/risk/calculators";
import { Card } from "@/components/ui/card";

export function Meter({
  label,
  used,
  limit,
  unit,
}: {
  label: string;
  used: number;
  /** null = the user never set this limit (v4.4.0): the meter says so instead of
   *  measuring against a number nobody configured (invariant 6). */
  limit: number | null;
  unit?: string;
}) {
  if (limit == null) {
    return (
      <Card className="p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="tabular-nums font-medium">{used}/— {unit ?? ""}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-card-hover" />
        <div className="mt-1 text-[10px] text-muted-foreground">No limit set — Settings → Risk rules</div>
      </Card>
    );
  }
  const s = counter(used, limit);
  const color = s.exceeded ? "var(--color-loss)" : s.warn ? "var(--color-warning)" : "var(--color-primary)";
  return (
    <Card className="p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium" style={{ color: s.exceeded ? "var(--color-loss)" : undefined }}>
          {used}/{limit} {unit ?? ""}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-card-hover">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, s.pctUsed * 100)}%`, background: color }} />
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        {s.exceeded ? "Limit exceeded" : s.warn ? "Approaching limit" : `${s.remaining} remaining`}
      </div>
    </Card>
  );
}
