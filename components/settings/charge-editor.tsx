"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { SEGMENT_LABELS, BROKER_LABELS, type Segment, type Broker } from "@/lib/domain/constants";
import { CheckCircle2, AlertCircle } from "lucide-react";
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

export function ChargeEditor({ rows }: { rows: ChargeConfigRow[] }) {
  const [id, setId] = React.useState<number>(rows[0]?.id ?? 0);
  const [vals, setVals] = React.useState<Record<string, string>>(() => initVals(rows[0]));
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  function initVals(row: ChargeConfigRow | undefined): Record<string, string> {
    const o: Record<string, string> = {};
    if (row) for (const f of FIELDS) { const v = row[f.key] as number | null; o[f.key as string] = v == null ? "" : String(v); }
    return o;
  }

  function selectRow(next: number) {
    setId(next);
    setMsg(null);
    setVals(initVals(rows.find((r) => r.id === next)));
  }

  async function save() {
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "charge", id, ...vals }),
      });
      const json = await res.json();
      setMsg({ ok: !!json.ok, text: json.message ?? (json.ok ? "Saved." : "Failed.") });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
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
            <Label>Rate row (broker × segment × exchange)</Label>
            <Select value={id} onChange={(e) => selectRow(Number(e.target.value))} className="max-w-md">
              {rows
                .slice()
                .sort((a, b) => a.broker.localeCompare(b.broker) || a.segment.localeCompare(b.segment) || a.exchange.localeCompare(b.exchange))
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {BROKER_LABELS[r.broker as Broker]} · {SEGMENT_LABELS[r.segment as Segment]} · {r.exchange}
                  </option>
                ))}
            </Select>
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
            {msg && (
              <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
                {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
                {msg.text}
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Rates are fractions of turnover (0.1% → 0.001). Editing a rate affects newly imported / re-tagged trades; existing rows recompute on re-import or re-tag.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
