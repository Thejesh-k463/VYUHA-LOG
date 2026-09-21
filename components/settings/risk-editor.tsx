"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SEGMENT_BUCKET, SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { inheritedPerTradeCap, isLegacySeedCap, type CapRow } from "@/lib/risk/limits";
import { toast } from "@/components/ui/toaster";
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
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [edits, setEdits] = React.useState<Record<number, Editable>>(() => {
    const o: Record<number, Editable> = {};
    for (const r of rows) {
      o[r.id] = {};
      for (const f of FIELDS) o[r.id][f.key as string] = (r[f.key] as number | null) ?? "";
      // D1 (v4.4.0): the v1–v4.3 seed stamped ₹9,500 on every bucket and segment
      // row, and the resolver reads that literal as UNSET (lib/risk/limits.ts).
      // The cell says so — BLANK, with what it inherits — because this editor
      // posts every row on save, and a 9500 shown here would come back as a
      // value the user chose.
      if (isLegacySeedCap(r)) o[r.id].perTradeMaxLoss = "";
    }
    return o;
  });

  // What each blank per-trade cap inherits, read off the CURRENT edits — so the
  // placeholder follows the global cell as it is typed, exactly as the save's
  // resolver will read it (every posted row carries capScheme 1).
  const capRows: CapRow[] = rows.map((r) => {
    const v = edits[r.id]?.perTradeMaxLoss;
    const n = v === "" || v == null ? null : Number(v);
    return { scope: r.scope, key: r.key, perTradeMaxLoss: n != null && Number.isFinite(n) ? n : null, capScheme: 1 };
  });
  const inheritsText = (r: RiskConfigRow): string | undefined => {
    if (r.scope === "global") return undefined;
    const got = inheritedPerTradeCap(capRows, { scope: r.scope, key: r.key, perTradeMaxLoss: null, capScheme: 1 }, (seg) => SEGMENT_BUCKET[seg as Segment] ?? "");
    return got.cap == null ? "no cap — no R" : `inherits ₹${got.cap.toLocaleString("en-IN")} from ${got.from}`;
  };

  const set = (id: number, key: string, v: string) => setEdits((p) => ({ ...p, [id]: { ...p[id], [key]: v } }));

  async function save() {
    setPending(true);
    try {
      const rowsPayload = Object.entries(edits).map(([id, fields]) => ({ id: Number(id), ...fields }));
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "risk", rows: rowsPayload }),
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
                  <tr key={r.id} className="border-b border-rule">
                    <td className="py-1.5 pr-3">
                      <Badge variant={r.scope === "global" ? "default" : "secondary"}>{r.scope}</Badge>{" "}
                      <span className="text-muted-foreground">{r.key ? (SEGMENT_LABELS[r.key as Segment] ?? r.key) : ""}</span>
                    </td>
                    {FIELDS.map((f) => {
                      const inherits = f.key === "perTradeMaxLoss" ? inheritsText(r) : undefined;
                      return (
                        <td key={f.key as string} className="py-1 pr-2">
                          <Input
                            type="number" step="any"
                            value={edits[r.id]?.[f.key as string] ?? ""}
                            onChange={(e) => set(r.id, f.key as string, e.target.value)}
                            placeholder={inherits}
                            title={inherits}
                            className={`h-7 text-right text-xs ${inherits ? "w-44" : "w-28"}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[0.6875rem] text-muted-foreground">
            A blank per-trade max loss inherits — a segment takes its bucket&apos;s cap, else the global one. Saving
            re-prices every trade whose R is measured in the cap (no stop, no typed risk).
          </p>
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save risk rules"}</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
