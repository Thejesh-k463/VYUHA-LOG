"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WORKSPACE_LABELS, asWorkspace, type Workspace } from "@/lib/domain/workspace";
import { SKINS, SKIN_META, asSkin, type Skin } from "@/lib/domain/skin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Settings } from "@/lib/db/schema";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CUSTOM_THEME,
  DEFAULT_WALLPAPER_OPACITY,
  appearanceVars,
  asPanelStyle,
  clampIntensity,
  parseCustomTheme,
  type CustomTheme,
  type PanelStyle,
  type Theme,
} from "@/lib/domain/appearance";
import { TintControl } from "@/components/settings/appearance/tint-control";
import { PanelStyleSelect } from "@/components/settings/appearance/panel-style-select";
import { CustomThemeBuilder } from "@/components/settings/appearance/custom-theme-builder";
import { WallpaperPicker } from "@/components/settings/appearance/wallpaper-picker";
import { adoptServerVars, applyAppearancePreview } from "@/components/settings/appearance/live-preview";

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
  // ── Appearance (lib/domain/appearance.ts) ──
  const [tintIntensity, setTint] = useState(clampIntensity(current.tintIntensity));
  const [panelStyle, setPanelStyle] = useState<PanelStyle>(asPanelStyle(current.panelStyle));
  const [customTheme, setCustomTheme] = useState<CustomTheme>(
    parseCustomTheme(current.customTheme) ?? DEFAULT_CUSTOM_THEME,
  );
  const [wallpaperStoredName, setWallpaperName] = useState<string | null>(current.wallpaperStoredName ?? null);
  const [wallpaperOpacity, setWallpaperOpacity] = useState(
    clampIntensity(current.wallpaperOpacity ?? DEFAULT_WALLPAPER_OPACITY),
  );
  // The last built-in skin picked — the seed for the custom builder's "Start from …".
  const [sourceSkin, setSourceSkin] = useState<Skin>(() => {
    const s = asSkin(current.accentSkin);
    return s === "custom" ? "luxe" : s;
  });

  const themeSide: Theme = theme === "light" ? "light" : "dark";

  /**
   * One live-preview path for everything that lands on <html>: the inline
   * --color-* / --wallpaper vars (the same appearanceVars() app/layout.tsx
   * server-renders) plus the skin / panel / wallpaper classes. Every appearance
   * handler funnels through here with its own field overridden, so a skin
   * change re-applies the chrome at the current intensity, a theme change
   * re-derives the custom side, and switching to Terminal REMOVES the tint.
   */
  function preview(next: {
    skin?: Skin;
    theme?: Theme;
    intensity?: number;
    panelStyle?: PanelStyle;
    customTheme?: CustomTheme;
    wallpaper?: { storedName: string | null; opacity: number };
  } = {}) {
    adoptServerVars();
    const s = next.skin ?? skin;
    const wp = next.wallpaper ?? { storedName: wallpaperStoredName, opacity: wallpaperOpacity };
    applyAppearancePreview(
      appearanceVars({
        skin: s,
        theme: next.theme ?? themeSide,
        intensity: next.intensity ?? tintIntensity,
        customTheme: next.customTheme ?? customTheme,
        wallpaper: wp,
      }),
      { skin: s, panel: next.panelStyle ?? panelStyle, wallpaper: Boolean(wp.storedName) },
    );
  }

  // Apply theme / colorblind to <html> instantly for live preview.
  function applyTheme(next: string) {
    setTheme(next);
    document.documentElement.classList.toggle("theme-light", next === "light");
    // The chrome tint and the custom theme are per-side: re-derive them.
    preview({ theme: next === "light" ? "light" : "dark" });
  }
  /** Live preview — same mechanism as applyTheme, so the picker shows the real
   *  thing rather than a swatch approximation. The skin class AND the skin's
   *  chrome tint at the current intensity go on together, so two skins never
   *  share a canvas by hex in the picker either. */
  function applySkin(next: Skin) {
    setSkin(next);
    if (next !== "custom") setSourceSkin(next);
    preview({ skin: next });
  }
  function applyTint(next: number) {
    setTint(next);
    preview({ intensity: next });
  }
  function applyPanelStyle(next: PanelStyle) {
    setPanelStyle(next);
    preview({ panelStyle: next });
  }
  function applyCustomTheme(next: CustomTheme) {
    setCustomTheme(next);
    preview({ customTheme: next });
  }
  function applyWallpaperOpacity(next: number) {
    setWallpaperOpacity(next);
    preview({ wallpaper: { storedName: wallpaperStoredName, opacity: next } });
  }
  function onWallpaperUploaded(storedName: string) {
    setWallpaperName(storedName);
    preview({ wallpaper: { storedName, opacity: wallpaperOpacity } });
    // The upload route wrote the column itself; the layout must learn the new
    // file so a hard reload after "Save" (or without it) shows the same thing.
    router.refresh();
  }
  function onWallpaperRemoved() {
    setWallpaperName(null);
    preview({ wallpaper: { storedName: null, opacity: wallpaperOpacity } });
    router.refresh();
  }

  const tintDisabledReason =
    skin === "mono"
      ? "Terminal is deliberately flat — it takes no tint."
      : skin === "custom"
        ? "Custom theme sets its own chrome; the tint curve does not apply."
        : null;
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
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "settings",
          goLiveDate, equityCapital, activeCapital, theme, accentSkin: skin, density, workspace, fyStartMonth,
          defaultBuyOrders, defaultSellOrders, colorblindSafe: colorblind,
          autoMtmEnabled: autoMtm,
          // Appearance. customTheme goes only while the Custom skin is selected
          // ("Save as my theme" is explicit); otherwise it is omitted and the
          // stored theme is kept. wallpaperStoredName is NOT sent — the upload
          // route owns that column.
          tintIntensity, panelStyle, wallpaperOpacity,
          ...(skin === "custom" && { customTheme }),
        }),
      });
      const json = await res.json();
      const text = json.message ?? (json.ok ? "Saved." : "Failed.");
      if (json.ok) toast.success(text);
      else toast.error(text);
      // The sidebar and command palette live in the root layout, so a changed
      // workspace only reaches them on a server re-render — and the appearance
      // vars/classes on <html> are server-rendered there too. Refreshing here
      // (rather than letting a server action do it) is what keeps this form's
      // other in-progress edits intact — see AGENTS.md.
      if (json.ok) router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
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
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2" data-testid="appearance-section">
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

          <TintControl value={tintIntensity} onChange={applyTint} disabledReason={tintDisabledReason} />
          <PanelStyleSelect value={panelStyle} onChange={applyPanelStyle} />

          {skin === "custom" && (
            <div className="sm:col-span-2">
              <CustomThemeBuilder
                value={customTheme}
                onChange={applyCustomTheme}
                activeTheme={themeSide}
                sourceSkin={sourceSkin}
                intensity={tintIntensity}
              />
            </div>
          )}

          <div className="sm:col-span-2">
            <WallpaperPicker
              storedName={wallpaperStoredName}
              opacity={wallpaperOpacity}
              onOpacityChange={applyWallpaperOpacity}
              onUploaded={onWallpaperUploaded}
              onRemoved={onWallpaperRemoved}
            />
          </div>

          <p className="text-xs text-muted-foreground sm:col-span-2">
            Everything above previews at once and is kept by{" "}
            <span className="text-foreground">Save settings</span> below. Leave without saving and the app
            reverts to what was stored.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
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
