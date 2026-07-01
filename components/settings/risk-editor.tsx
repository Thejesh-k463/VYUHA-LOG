"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { CheckCircle2, AlertCircle } from "lucide-react";
import type { RiskConfigRow } from "@/lib/db/schema";

type Editable = Record<string, string | number>;

const FIELDS: { key: keyof RiskConfigRow; label: string }[] = [
  { key: "perTradeMaxLoss", label: "Per-trade max loss" },
  { key: "maxOpen", label: "Max open" },
  { key: "maxTradesDay", label: "Max trades/day" },
  { key: "dailyLossStop", label: "Daily loss stop" },
  { key: "concentrationPct", label: "Concentration %" },
  { key: "monthlyTargetBase", label: "Monthly base" },
  { key: "monthlyTargetStretch", label: "Monthly stretch" },
];

export function RiskEditor({ rows }: { rows: RiskConfigRow[] }) {
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [edits, setEdits] = React.useState<Record<number, Editable>>(() => {
    const o: Record<number, Editable> = {};
    for (const r of rows) {
      o[r.id] = {};
      for (const f of FIELDS) o[r.id][f.key as string] = (r[f.key] as number | null) ?? "";
    }
    return o;
  });

  const set = (id: number, key: string, v: string) => setEdits((p) => ({ ...p, [id]: { ...p[id], [key]: v } }));

  async function save() {
    setPending(true);
    setMsg(null);
    try {
      const rowsPayload = Object.entries(edits).map(([id, fields]) => ({ id: Number(id), ...fields }));
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "risk", rows: rowsPayload }),
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
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Risk rules (risk_config)</CardTitle>
        <Badge variant="secondary">{rows.length} rules</Badge>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Scope / key</th>
                  {FIELDS.map((f) => <th key={f.key as string} className="py-2 pr-3 text-right font-medium">{f.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/40">
                    <td className="py-1.5 pr-3">
                      <Badge variant={r.scope === "global" ? "default" : "secondary"}>{r.scope}</Badge>{" "}
                      <span className="text-muted-foreground">{r.key ? (SEGMENT_LABELS[r.key as Segment] ?? r.key) : ""}</span>
                    </td>
                    {FIELDS.map((f) => (
                      <td key={f.key as string} className="py-1 pr-2">
                        <Input
                          type="number" step="any"
                          value={edits[r.id]?.[f.key as string] ?? ""}
                          onChange={(e) => set(r.id, f.key as string, e.target.value)}
                          className="h-7 w-28 text-right text-xs"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save risk rules"}</Button>
            {msg && (
              <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
                {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}{msg.text}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
