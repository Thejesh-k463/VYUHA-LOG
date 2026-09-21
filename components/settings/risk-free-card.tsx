"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toaster";
import { todayIstIso } from "@/lib/domain/trading-day";

/**
 * The ONE dated risk-free rate (v4.4.0 D5) — what Sharpe, Sortino, alpha and the
 * option Greeks discount at. A rate is a statement about a day, so an edit
 * REQUIRES the date it was true on, prefilled with today (IST); until the user
 * saves one, every figure says "7% · Vyuha default" — an assumption, not a
 * market quote.
 *
 * Its own save through the settings ROUTE (`type: "riskFree"`) + router.refresh()
 * — never a server action, which would remount the sibling editors on this page
 * and reset their state (AGENTS.md conventions).
 */
export function RiskFreeCard({ ppm, asOf, label }: { ppm: number; asOf: string | null; label: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [ratePct, setRatePct] = React.useState(String(Number((ppm / 10_000).toFixed(2))));
  // Prefilled with TODAY, never with the stored day: saving says "this rate is
  // true as of the day I saved it" unless the user types an earlier one.
  const [day, setDay] = React.useState(() => todayIstIso());

  async function save() {
    setPending(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "riskFree", ratePct, asOf: day }),
      });
      const json = (await res.json()) as { ok?: boolean; message?: string };
      if (json.ok) {
        toast.success(json.message ?? "Saved.");
        router.refresh();
      } else toast.error(json.message ?? "Failed.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Risk-free rate</CardTitle>
        <Badge variant="secondary" data-testid="risk-free-label">{label}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[0.6875rem] text-muted-foreground">
          The annual rate Sharpe, Sortino, alpha and the option Greeks use.{" "}
          {asOf ? `You set it as true on ${asOf}.` : "Until you set one, Vyuha assumes 7% — an assumption, not a market quote."}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Rate (% a year)</span>
            <Input
              type="number"
              step="0.01"
              min={0}
              max={20}
              value={ratePct}
              onChange={(e) => setRatePct(e.target.value)}
              className="h-8 w-28 text-right tabular-nums"
              data-testid="risk-free-rate"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">True as of</span>
            <Input
              type="date"
              value={day}
              max={todayIstIso()}
              onChange={(e) => setDay(e.target.value)}
              className="h-8 w-40"
              data-testid="risk-free-as-of"
            />
          </label>
          <Button type="button" size="sm" onClick={save} disabled={pending || day === ""}>
            {pending ? "Saving…" : "Save rate"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
