"use client";

/**
 * "My Default Settings" — the baseline captured on first run, restorable in one
 * click. Uses route handlers + fetch + router.refresh(), NOT server actions
 * (house rule: server actions remount sibling client editors and reset them).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { RotateCcw, Save } from "lucide-react";

const FIELD_LABELS: Record<string, string> = {
  equityCapital: "equity capital", activeCapital: "F&O capital", theme: "theme",
  accentSkin: "accent skin", baseCurrency: "currency", fyStartMonth: "FY start",
  colorblindSafe: "colorblind mode", defaultBuyOrders: "default buy orders",
  defaultSellOrders: "default sell orders", autoMtmEnabled: "auto-MTM",
};

export function DefaultSettingsCard() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [diff, setDiff] = React.useState<{ fields: string[]; capturedAt: string | null } | null>(null);

  const call = (action: "save" | "restore") => {
    setBusy(true);
    fetch("/api/settings-baseline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) })
      .then((r) => r.json())
      .then((d) => { if (d.ok) toast.success(d.message ?? ""); else toast.error(d.message ?? ""); if (d.ok) { setDiff(null); router.refresh(); } })
      .finally(() => setBusy(false));
  };

  const loadDiff = () => {
    fetch("/api/settings-baseline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "diff" }) })
      .then((r) => r.json())
      .then((d) => setDiff({ fields: d.fields ?? [], capturedAt: d.capturedAt ?? null }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>My Default Settings</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Your first configuration was kept as a baseline — preferences plus the charge, margin and risk
          rate tables. Change anything freely; one click brings it all back. Trades, journal data, your
          licence and the trial are never part of this.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {diff && (
          <p className="rounded-md border border-border bg-card-hover/30 p-2.5">
            {diff.fields.length === 0
              ? "Preferences currently match your default."
              : <>Restoring would change: <b>{diff.fields.map((f) => FIELD_LABELS[f] ?? f).join(", ")}</b> — plus all three rate tables back to the snapshot.</>}
            {diff.capturedAt && <span className="text-muted-foreground"> Baseline saved {diff.capturedAt.slice(0, 10)}.</span>}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => (diff ? call("restore") : loadDiff())}>
            <RotateCcw className="mr-1.5 size-3.5" />
            {diff ? "Confirm — restore my defaults" : "Restore my defaults…"}
          </Button>
          {diff && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDiff(null)}>Cancel</Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => call("save")}>
            <Save className="mr-1.5 size-3.5" /> Save current as my default
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
