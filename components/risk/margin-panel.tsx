"use client";

// P1.2 margin slice — used-vs-available margin gauge + the editable per-segment
// rate table that drives it. Rates persist via /api/margin (route-handler +
// fetch + router.refresh(), per the settings-editor convention).

import { useState } from "react";
import { ShowMore, useRowWindow } from "@/components/ui/show-more";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inr } from "@/lib/format";
import type { MarginSummary } from "@/lib/risk/margin";
import { toast } from "@/components/ui/toaster";

interface RateRow {
  broker: string;
  segment: string;
  marginPct: number;
}

export function MarginPanel({ summary, rates }: { summary: MarginSummary; rates: RateRow[] }) {
  const router = useRouter();
  // Every open position used to land in the DOM here — a second full copy of
  // the book alongside the cockpit's own list, both unwindowed.
  const positionWindow = useRowWindow(summary.positions);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const rowKey = (r: RateRow) => `${r.broker}|${r.segment}`;

  const save = async (r: RateRow) => {
    const key = rowKey(r);
    const raw = edits[key];
    if (raw == null || raw === "") return;
    setBusy(key);
    try {
      const res = await fetch("/api/margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broker: r.broker, segment: r.segment, marginPct: Number(raw) }),
      });
      const data = await res.json();
      const text = data.message ?? (res.ok ? "Saved." : "Failed.");
      if (res.ok) toast.success(text);
      else toast.error(text);
      if (res.ok) {
        setEdits((e) => ({ ...e, [key]: "" }));
        router.refresh();
      }
    } catch {
      toast.error("Network error.");
    } finally {
      setBusy(null);
    }
  };

  const utilColor = (pct: number) =>
    pct >= 90 ? "bg-loss" : pct >= 70 ? "bg-warning" : "bg-accent";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Margin estimate (SPAN approx.)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          {summary.byBucket.map((b) => (
            <div key={b.bucket} className="rounded-md border border-border p-3">
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium uppercase text-muted-foreground">
                  {b.bucket === "active" ? "Trade F&O" : b.bucket}
                </span>
                <span className="tabular-nums">
                  {inr(b.margin, { decimals: 0 })} / {b.utilisationPct == null ? "—" : inr(b.capital, { decimals: 0 })}
                </span>
              </div>
              {/* null utilisation = capital not configured. No gauge at all:
                  an empty bar reads as 0% utilised, which is fake safety. */}
              {b.utilisationPct == null ? (
                <p className="mt-1 text-[0.6875rem] text-muted-foreground">
                  utilisation % needs this bucket&apos;s capital — set it in Settings
                </p>
              ) : (
                <>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded bg-border/60">
                    <div
                      className={`h-full ${utilColor(b.utilisationPct)}`}
                      style={{ width: `${Math.min(100, b.utilisationPct)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[0.6875rem] text-muted-foreground">
                    {b.utilisationPct}% of bucket capital blocked as estimated margin
                  </p>
                </>
              )}
            </div>
          ))}
          {summary.byBucket.length === 0 && (
            <p className="text-sm text-muted-foreground">No open positions — nothing blocked.</p>
          )}
        </div>

        {summary.positions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-y border-border text-left text-muted-foreground">
                  <th className="px-2.5 py-2 font-medium">Position</th>
                  <th className="px-2 py-2 font-medium">Segment</th>
                  <th className="px-2 py-2 text-right font-medium">Est. margin</th>
                  <th className="px-2.5 py-2 font-medium">Basis</th>
                </tr>
              </thead>
              <tbody>
                {positionWindow.visible.map((p) => (
                  <tr key={p.id} className="border-b border-rule">
                    <td className="px-2.5 py-1.5 font-medium">{p.symbol}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{p.segment}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{inr(p.margin, { decimals: 0 })}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{p.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ShowMore
              hidden={positionWindow.hidden}
              total={positionWindow.total}
              onClick={positionWindow.showMore}
              noun="positions"
            />
          </div>
        )}

        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Margin rates (% of notional, editable approximation)
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {rates.map((r) => {
              const key = rowKey(r);
              return (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <span className="w-40 shrink-0">
                    <span className="text-muted-foreground">{r.broker}</span> · {r.segment}
                  </span>
                  <Input
                    className="h-7 w-20 text-right text-xs"
                    inputMode="decimal"
                    placeholder={String(r.marginPct)}
                    value={edits[key] ?? ""}
                    onChange={(e) => setEdits((s) => ({ ...s, [key]: e.target.value }))}
                  />
                  <span className="text-muted-foreground">%</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={busy === key || !edits[key]}
                    onClick={() => save(r)}
                  >
                    {busy === key ? "…" : "Save"}
                  </Button>
                </div>
              );
            })}
          </div>
        </details>

        {summary.missingRateSegments.length > 0 && (
          <p className="text-[0.6875rem] text-warning">
            No margin rate configured for {summary.missingRateSegments.join("; ")}.
          </p>
        )}
        <p className="text-[0.6875rem] text-muted-foreground">
          Estimate only: long options count the premium paid; short options and futures apply the segment rate to
          notional; delivery blocks the full invested value. <b>MTF blocks only your own-margin share</b> — the
          broker funds the rest, and interest accrues on exactly that funded amount (same rate the Charges &amp; MTF
          Leak report uses). Real broker SPAN+exposure margins differ — tune the rates above to match your
          broker&apos;s margin file.
        </p>
      </CardContent>
    </Card>
  );
}
