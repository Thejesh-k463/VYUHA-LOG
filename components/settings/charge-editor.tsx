"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { SEGMENT_LABELS, BROKER_LABELS, type Segment, type Broker } from "@/lib/domain/constants";
import { toast } from "@/components/ui/toaster";
import type { ChargeConfigRow } from "@/lib/db/schema";

const FIELDS: { key: keyof ChargeConfigRow; label: string }[] = [
  { key: "brokerageFlat", label: "Brokerage flat (₹/order)" },
  { key: "brokeragePct", label: "Brokerage % (fraction)" },
  { key: "brokerageCap", label: "Brokerage cap (₹)" },
  { key: "brokerageFloor", label: "Brokerage floor (₹)" },
  { key: "sttPct", label: "STT/CTT (fraction)" },
  { key: "exchangeTxnPct", label: "Exchange txn (fraction)" },
  { key: "sebiPct", label: "SEBI (fraction)" },
  { key: "stampPct", label: "Stamp (fraction)" },
  { key: "ipftPct", label: "IPFT (fraction)" },
  { key: "gstPct", label: "GST (fraction)" },
  { key: "dpCharge", label: "DP charge (₹)" },
  { key: "mtfInterestAnnual", label: "MTF interest (annual)" },
];

/**
 * A rate row's window, rendered so two epochs of one key never look alike.
 * "Current" for the open-ended one, an explicit range for a closed one.
 */
function periodLabel(r: ChargeConfigRow): string {
  const from = r.effectiveFrom ?? "1970-01-01";
  if (r.effectiveTo == null) return from === "1970-01-01" ? "current" : `from ${from}`;
  return `${from} to ${r.effectiveTo}`;
}

/** A window that has already closed — editing it re-prices the PAST. */
function isHistorical(r: ChargeConfigRow): boolean {
  return r.effectiveTo != null && r.effectiveTo <= new Date().toISOString().slice(0, 10);
}

export function ChargeEditor({ rows }: { rows: ChargeConfigRow[] }) {
  const router = useRouter();
  const [id, setId] = React.useState<number>(rows[0]?.id ?? 0);
  const selected = rows.find((r) => r.id === id);
  const [vals, setVals] = React.useState<Record<string, string>>(() => initVals(rows[0]));
  const [pending, setPending] = React.useState(false);

  function initVals(row: ChargeConfigRow | undefined): Record<string, string> {
    const o: Record<string, string> = {};
    if (row) for (const f of FIELDS) { const v = row[f.key] as number | null; o[f.key as string] = v == null ? "" : String(v); }
    return o;
  }

  function selectRow(next: number) {
    setId(next);
    setVals(initVals(rows.find((r) => r.id === next)));
  }

  async function save() {
    setPending(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "charge", id, ...vals }),
      });
      const json = await res.json();
      const text = json.message ?? (json.ok ? "Saved." : "Failed.");
      if (json.ok) {
        toast.success(text);
        // Invalidate the router cache so a revisit within staleTimes.dynamic
        // does not remount from the pre-save RSC payload. router.refresh()
        // preserves this component's client state (unlike server actions).
        router.refresh();
      } else toast.error(text);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Charge rates (charge_config)</CardTitle>
        <Badge variant="secondary">{rows.length} rate rows</Badge>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-1">
            {/*
              The window is part of a row's IDENTITY (migration 0050), so it has
              to be on screen. A key can now hold several dated epochs, and
              without the dates two of them render identically — the user picks
              one at random and edits history without knowing it. `plan` was
              always part of the key too and was never shown either.
            */}
            <Label>Rate row (broker × plan × segment × exchange × period)</Label>
            <Select value={id} onChange={(e) => selectRow(Number(e.target.value))} className="max-w-md">
              {rows
                .slice()
                .sort(
                  (a, b) =>
                    a.broker.localeCompare(b.broker) ||
                    (a.plan ?? "default").localeCompare(b.plan ?? "default") ||
                    a.segment.localeCompare(b.segment) ||
                    a.exchange.localeCompare(b.exchange) ||
                    // Newest window first, so today's rate is the obvious pick.
                    (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""),
                )
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {BROKER_LABELS[r.broker as Broker]}
                    {r.plan && r.plan !== "default" ? ` (${r.planLabel ?? r.plan})` : ""} ·{" "}
                    {SEGMENT_LABELS[r.segment as Segment]} · {r.exchange} · {periodLabel(r)}
                  </option>
                ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              {selected && isHistorical(selected)
                ? "This is a CLOSED historical window. Editing it changes how past trades are priced, not future ones."
                : "This window is in force today."}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {FIELDS.map((f) => (
              <div key={f.key as string} className="space-y-1">
                <Label>{f.label}</Label>
                <Input
                  type="number" step="any"
                  value={vals[f.key as string] ?? ""}
                  onChange={(e) => setVals((p) => ({ ...p, [f.key as string]: e.target.value }))}
                  className="h-8 text-xs"
                  placeholder="—"
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save rate"}
            </Button>
          </div>
          <p className="text-[0.6875rem] text-muted-foreground">
            Rates are fractions of turnover (0.1% → 0.001). Editing a rate affects newly imported / re-tagged trades; existing rows recompute on re-import or re-tag.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
