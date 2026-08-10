"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WORKSPACE_LABELS, asWorkspace, type Workspace } from "@/lib/domain/workspace";
import { SKINS, SKIN_META, asSkin, skinClass, type Skin } from "@/lib/domain/skin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Settings } from "@/lib/db/schema";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { CheckCircle2, AlertCircle } from "lucide-react";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function SettingsForm({ current }: { current: Settings }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<Workspace>(asWorkspace(current.workspace));
  const [colorblind, setColorblind] = useState(current.colorblindSafe);
  const [theme, setTheme] = useState(current.theme);
  const [skin, setSkin] = useState<Skin>(asSkin(current.accentSkin));
  const [density, setDensity] = useState(current.density ?? "compact");
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
  /** Live preview — same mechanism as applyTheme, so the picker shows the real
   *  thing rather than a swatch approximation. */
  function applySkin(next: Skin) {
    setSkin(next);
    const el = document.documentElement;
    for (const s of SKINS) {
      const c = skinClass(s);
      if (c) el.classList.remove(c);
    }
    const c = skinClass(next);
    if (c) el.classList.add(c);
  }
  function applyColorblind(next: boolean) {
    setColorblind(next);
    document.documentElement.classList.toggle("cb-safe", next);
  }
  function applyDensity(next: string) {
    setDensity(next);
    document.documentElement.classList.toggle("density-comfortable", next === "comfortable");
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
          // accentSkin is not sent: the skin picker was retired in v3. The API
          // still accepts the field (defaulting to "terminal"), so a saved
          // "tape"/"ice" row quietly normalises the next time this form saves.
          goLiveDate, equityCapital, activeCapital, theme, accentSkin: skin, density, workspace, fyStartMonth,
          defaultBuyOrders, defaultSellOrders, colorblindSafe: colorblind,
          autoMtmEnabled: autoMtm,
        }),
      });
      const json = await res.json();
      const text = json.message ?? (json.ok ? "Saved." : "Failed.");
      if (json.ok) toast.success(text);
      else toast.error(text);
      // The sidebar and command palette live in the root layout, so a changed
      // workspace only reaches them on a server re-render. Refreshing here
      // (rather than letting a server action do it) is what keeps this form's
      // other in-progress edits intact — see AGENTS.md.
      if (json.ok && workspace !== asWorkspace(current.workspace)) router.refresh();
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
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What do you trade?">
              <Select value={workspace} onChange={(e) => setWorkspace(asWorkspace(e.target.value))}>
                <option value="both">{WORKSPACE_LABELS.both} — show everything</option>
                <option value="equity">{WORKSPACE_LABELS.equity}</option>
                <option value="fno">{WORKSPACE_LABELS.fno}</option>
              </Select>
            </Field>
            <div className="self-end text-xs text-muted-foreground">
              {workspace === "both"
                ? "Every screen is shown. Pick a single book to quieten the sidebar."
                : workspace === "equity"
                  ? "Hides Trade F&O Tracker, Option Strategies, Options Seller Journal, F&O targets and Expiry Analytics."
                  : "Hides Equity Tracker, equity targets, IPOs, Corporate Actions and Tax Harvest."}
            </div>
          </div>
          <p className="rounded-md border border-border bg-card-hover/40 px-3 py-2 text-xs text-muted-foreground">
            This tidies the <span className="text-foreground">sidebar and command palette</span> and sets the
            bucket filter on Trades and the Dashboard. It is <span className="text-foreground">not a lock</span>:
            nothing is deleted, hidden screens still open from a direct link or a saved bookmark, and every
            total keeps counting <span className="text-foreground">both</span> books. Switch back to{" "}
            {WORKSPACE_LABELS.both} here at any time.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2 space-y-2">
            <Label>Accent skin</Label>
            <div className="flex flex-wrap gap-2">
              {SKINS.map((id) => {
                const m = SKIN_META[id];
                const active = skin === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => applySkin(id)}
                    title={m.hint}
                    aria-pressed={active}
                    className={cn(
                      "flex items-center gap-2 rounded-[var(--radius-pill)] border px-3 py-1.5 text-xs transition-colors",
                      active
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    {/* The three roles, in order: interactive / money / analytics. */}
                    <span className="flex shrink-0 overflow-hidden rounded-full" aria-hidden>
                      <span className="size-3" style={{ background: m.swatch.primary }} />
                      <span className="size-3" style={{ background: m.swatch.money }} />
                      <span className="size-3" style={{ background: m.swatch.analytics }} />
                    </span>
                    {m.label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {SKIN_META[skin].hint}{" "}
              <span className="text-foreground">
                Money reads {SKIN_META[skin].moneyLabel} in this skin.
              </span>{" "}
              Profit and loss colours never change — those belong to the
              colourblind-safe setting below.
            </p>
          </div>

          <Field label="Theme">
            <Select value={theme} onChange={(e) => applyTheme(e.target.value)}>
              <option value="dark">Dark (terminal)</option>
              <option value="light">Light</option>
            </Select>
          </Field>
          <Field label="Display density">
            <Select value={density} onChange={(e) => applyDensity(e.target.value)}>
              <option value="compact">Compact (terminal default)</option>
              <option value="comfortable">Comfortable (larger type)</option>
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
