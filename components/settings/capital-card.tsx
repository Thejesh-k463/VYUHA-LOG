"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { inr, inrCompact } from "@/lib/format";
import type { CapitalSummary } from "@/lib/queries/capital";
import { CheckCircle2, AlertCircle, TrendingUp } from "lucide-react";

const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

export function CapitalCard({ summary }: { summary: CapitalSummary }) {
  const router = useRouter();
  const [bucket, setBucket] = React.useState<"equity" | "active">("equity");
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  async function compound() {
    setPending(true); setMsg(null);
    try {
      const res = await fetch("/api/capital", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bucket }),
      });
      const json = await res.json();
      setMsg({ ok: !!json.ok, text: json.message ?? (json.ok ? "Done." : "Failed.") });
      if (json.ok) router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setPending(false);
    }
  }

  const canCompound = Math.abs(summary.available) >= 1;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Capital management</CardTitle>
        <Badge variant="secondary">Total {inrCompact(summary.totalCapital)}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Equity capital" value={inrCompact(summary.equityCapital)} />
          <Stat label="Active capital" value={inrCompact(summary.activeCapital)} />
          <Stat label="Realised — trades" value={inrCompact(summary.equityRealised + summary.activeRealised)} cls={pnl(summary.equityRealised + summary.activeRealised)} />
          <Stat label="Realised — IPOs" value={inrCompact(summary.ipoRealised)} cls={pnl(summary.ipoRealised)} />
        </div>

        <div className="rounded-md border border-border bg-card-hover/30 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Realised P&L available to compound</div>
              <div className={`text-xl font-bold tabular-nums ${pnl(summary.available)}`}>
                {summary.available >= 0 ? "+" : ""}{inr(summary.available, { decimals: 0 })}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Total realised {inr(summary.totalRealised, { decimals: 0 })} · already compounded {inr(summary.rolledIn, { decimals: 0 })}
              </div>
            </div>
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Credit to</div>
                <Select value={bucket} onChange={(e) => setBucket(e.target.value as "equity" | "active")} className="h-9 w-32">
                  <option value="equity">Equity bucket</option>
                  <option value="active">Trade F&O bucket</option>
                </Select>
              </div>
              <Button type="button" onClick={compound} disabled={pending || !canCompound}>
                <TrendingUp className="size-4" />
                {pending ? "Applying…" : "Add to capital"}
              </Button>
            </div>
          </div>
          {msg && (
            <div className={`mt-2 flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
              {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}{msg.text}
            </div>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          Compounding rolls realised P&L (closed trades + exited IPOs) into the chosen bucket&apos;s capital — only the
          portion not already added. Every risk %, allocation and target on the app is computed against bucket capital, so
          they all re-scale automatically. For an arbitrary value, edit the bucket capital fields above and Save.
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md border border-border bg-background/30 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${cls ?? ""}`}>{value}</div>
    </div>
  );
}
