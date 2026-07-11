"use client";

import { CheckCircle2, AlertTriangle, ShieldX } from "lucide-react";
import type { LimitResult, LimitStatus } from "@/lib/risk/limits";

const META: Record<LimitStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  pass: { label: "Cleared", cls: "text-profit border-profit/40 bg-profit/10", Icon: CheckCircle2 },
  warn: { label: "Warning", cls: "text-warning border-warning/40 bg-warning/10", Icon: AlertTriangle },
  block: { label: "Limit breached (you can override)", cls: "text-loss border-loss/40 bg-loss/10", Icon: ShieldX },
};

const dot: Record<LimitStatus, string> = {
  pass: "text-profit",
  warn: "text-warning",
  block: "text-loss",
};

export function LimitVerdict({ result, compact = false }: { result: LimitResult; compact?: boolean }) {
  const m = META[result.status];
  return (
    <div className={`rounded-md border p-3 text-xs ${m.cls}`}>
      <div className="flex items-center gap-2 font-semibold">
        <m.Icon className="size-4" />
        <span>Pre-trade check: {m.label}</span>
        {result.orderRisk != null && (
          <span className="ml-auto font-normal text-muted-foreground">
            risk ₹{Math.round(result.orderRisk).toLocaleString("en-IN")} · value ₹{Math.round(result.orderValue).toLocaleString("en-IN")}
          </span>
        )}
      </div>
      {!compact && (
        <ul className="mt-2 space-y-1">
          {result.checks.map((c) => (
            <li key={c.rule} className="flex items-start gap-2">
              <span className={`mt-0.5 ${dot[c.status]}`}>●</span>
              <span className="text-foreground">
                <span className="font-medium">{c.label}:</span> {c.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
