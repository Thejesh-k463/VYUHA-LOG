"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Settings } from "@/lib/db/schema";
import { toast } from "@/components/ui/toaster";
import { CheckCircle2, AlertCircle } from "lucide-react";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function SettingsForm({ current }: { current: Settings }) {
  const [colorblind, setColorblind] = useState(current.colorblindSafe);
  const [theme, setTheme] = useState(current.theme);
  const [skin, setSkin] = useState(current.accentSkin ?? "terminal");
  const [goLiveDate, setGoLive] = useState(current.goLiveDate);
  const [equityCapital, setEquity] = useState(String(current.equityCapital));
  const [activeCapital, setActive] = useState(String(current.activeCapital));
  const [fyStartMonth, setFy] = useState(String(current.fyStartMonth));
  const [defaultBuyOrders, setBuyOrders] = useState(String(current.defaultBuyOrders));
  const [defaultSellOrders, setSellOrders] = useState(String(current.defaultSellOrders));
  const [autoMtm, setAutoMtm] = useState(current.autoMtmEnabled);
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
  function applySkin(next: string) {
    setSkin(next);
    document.documentElement.classList.remove("skin-tape", "skin-ice");
    if (next !== "terminal") document.documentElement.classList.add(`skin-${next}`);
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
          goLiveDate, equityCapital, activeCapital, theme, accentSkin: skin, fyStartMonth,
          defaultBuyOrders, defaultSellOrders, colorblindSafe: colorblind,
          autoMtmEnabled: autoMtm,
        }),
      });
      const json = await res.json();
      const text = json.message ?? (json.ok ? "Saved." : "Failed.");
      if (json.ok) toast.success(text);
      else toast.error(text);
      setMsg(null);
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
          <Field label="Trade F&O bucket capital (₹)">
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
          <Field label="Accent skin">
            <Select value={skin} onChange={(e) => applySkin(e.target.value)}>
              <option value="terminal">Terminal (teal)</option>
              <option value="tape">Tape (amber)</option>
              <option value="ice">Ice (blue)</option>
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
          <div className="flex items-center justify-between rounded-md border border-border bg-card-hover/40 px-3 py-2 sm:col-span-2">
            <div>
              <div className="text-sm font-medium">Auto-MTM from NSE bhavcopy (EOD)</div>
              <div className="text-xs text-muted-foreground">
                Once per trading day (after ~7pm IST), fetch the NSE EOD file and mark open equity
                positions to close. <span className="text-warning">Overwrites the MTM price for symbols
                found in the file</span> — manual marks for anything else stay untouched. Needs internet;
                skips silently offline. Every run is recorded in the Audit Log.
              </div>
            </div>
            <Switch checked={autoMtm} onCheckedChange={(v) => setAutoMtm(Boolean(v))} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>App updates</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          The desktop app checks for a new signed release once at launch. Nothing ever installs on its
          own: you get a dialog with <span className="text-foreground">Update now</span> /{" "}
          <span className="text-foreground">Later</span>, and your journal database is backed up
          automatically before any migration. Offline launches skip the check silently.
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
