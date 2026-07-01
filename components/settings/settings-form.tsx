"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Settings } from "@/lib/db/schema";
import { CheckCircle2, AlertCircle } from "lucide-react";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function SettingsForm({ current }: { current: Settings }) {
  const [colorblind, setColorblind] = useState(current.colorblindSafe);
  const [theme, setTheme] = useState(current.theme);
  const [goLiveDate, setGoLive] = useState(current.goLiveDate);
  const [equityCapital, setEquity] = useState(String(current.equityCapital));
  const [activeCapital, setActive] = useState(String(current.activeCapital));
  const [fyStartMonth, setFy] = useState(String(current.fyStartMonth));
  const [defaultBuyOrders, setBuyOrders] = useState(String(current.defaultBuyOrders));
  const [defaultSellOrders, setSellOrders] = useState(String(current.defaultSellOrders));
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Apply theme / colorblind to <html> instantly for live preview.
  function applyTheme(next: string) {
    setTheme(next);
    document.documentElement.classList.toggle("theme-light", next === "light");
  }
  function applyColorblind(next: boolean) {
    setColorblind(next);
    document.documentElement.classList.toggle("cb-safe", next);
  }

  async function save() {
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "settings",
          goLiveDate, equityCapital, activeCapital, theme, fyStartMonth,
          defaultBuyOrders, defaultSellOrders, colorblindSafe: colorblind,
        }),
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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Capital & Go-Live</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="Go-live date">
            <Input type="date" value={goLiveDate} onChange={(e) => setGoLive(e.target.value)} />
          </Field>
          <Field label="Equity bucket capital (₹)">
            <Input type="number" step="1" value={equityCapital} onChange={(e) => setEquity(e.target.value)} />
          </Field>
          <Field label="Active bucket capital (₹)">
            <Input type="number" step="1" value={activeCapital} onChange={(e) => setActive(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Theme">
            <Select value={theme} onChange={(e) => applyTheme(e.target.value)}>
              <option value="dark">Dark (terminal)</option>
              <option value="light">Light</option>
            </Select>
          </Field>
          <Field label="Financial year starts">
            <Select value={fyStartMonth} onChange={(e) => setFy(e.target.value)}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="Default BUY orders / closed trade">
            <Input type="number" min={1} value={defaultBuyOrders} onChange={(e) => setBuyOrders(e.target.value)} />
          </Field>
          <Field label="Default SELL orders / closed trade">
            <Input type="number" min={1} value={defaultSellOrders} onChange={(e) => setSellOrders(e.target.value)} />
          </Field>
          <div className="flex items-center justify-between rounded-md border border-border bg-card-hover/40 px-3 py-2 sm:col-span-2">
            <div>
              <div className="text-sm font-medium">Colorblind-safe P&L colours</div>
              <div className="text-xs text-muted-foreground">Swap red/green for orange/blue across the app.</div>
            </div>
            <Switch checked={colorblind} onCheckedChange={(v) => applyColorblind(Boolean(v))} />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        {msg && (
          <span className={`flex items-center gap-1.5 text-sm ${msg.ok ? "text-profit" : "text-loss"}`}>
            {msg.ok ? <CheckCircle2 className="size-4" /> : <AlertCircle className="size-4" />}
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
