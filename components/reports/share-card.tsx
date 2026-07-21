"use client";

// T1.4 — privacy-first shareable stat card. Everything happens on this machine:
// the PNG is drawn on a <canvas> and downloaded directly. No upload, no network,
// no third-party image service. The watermark is not user-editable.

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Download, Share2 } from "lucide-react";
import { toast } from "@/components/ui/toaster";
import {
  buildShareCard,
  SHARE_METRICS,
  SHARE_WATERMARK,
  type PrivacyMode,
  type ShareMetricId,
  type ShareStats,
} from "@/lib/analytics/share-card";

const DEFAULT_METRICS: ShareMetricId[] = ["netPnl", "winRate", "profitFactor", "avgR", "trades", "expectancy"];

export function ShareCard({ stats, capital, period }: { stats: ShareStats; capital: number; period?: string }) {
  const [privacy, setPrivacy] = React.useState<PrivacyMode>("percent");
  const [picked, setPicked] = React.useState<ShareMetricId[]>(DEFAULT_METRICS);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  const rows = React.useMemo(
    () => buildShareCard(stats, { metrics: picked, privacy, capital, period }).filter((r) => r.display !== "hidden"),
    [stats, picked, privacy, capital, period],
  );

  function toggle(id: ShareMetricId) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** Draw the card at 2× for crisp social images, then download it. */
  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const S = 2;
    const W = 600;
    const H = 340;
    canvas.width = W * S;
    canvas.height = H * S;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(S, S);

    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const bg = v("--color-card", "#111a26");
    const fg = v("--color-foreground", "#e6edf3");
    const mut = v("--color-muted-foreground", "#8a98a7");
    const primary = v("--color-primary", "#2dd4bf");
    const profit = v("--color-profit", "#16c784");
    const loss = v("--color-loss", "#f6465d");
    const border = v("--color-border", "#1f2b3a");

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = border;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

    // Header: mark + wordmark + period
    ctx.fillStyle = primary;
    ctx.beginPath();
    ctx.roundRect(28, 26, 34, 34, 9);
    ctx.fill();
    ctx.fillStyle = bg;
    ctx.font = "600 20px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("व", 37, 44);
    ctx.fillStyle = fg;
    ctx.font = "600 17px Inter, system-ui, sans-serif";
    ctx.fillText("VYUHA", 74, 38);
    ctx.fillStyle = mut;
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.fillText(period ?? "Trading journal", 74, 54);

    // Metric grid — 3 across
    const cols = 3;
    const cw = (W - 56) / cols;
    rows.slice(0, 9).forEach((r, i) => {
      const x = 28 + (i % cols) * cw;
      const y = 98 + Math.floor(i / cols) * 74;
      ctx.fillStyle = mut;
      ctx.font = "10px Inter, system-ui, sans-serif";
      ctx.fillText(r.label.toUpperCase(), x, y);
      ctx.fillStyle = r.tone === "profit" ? profit : r.tone === "loss" ? loss : fg;
      ctx.font = "300 26px 'JetBrains Mono', ui-monospace, monospace";
      ctx.fillText(r.display, x, y + 26);
    });

    // Footer watermark — the honesty line
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(28, H - 52);
    ctx.lineTo(W - 28, H - 52);
    ctx.stroke();
    ctx.fillStyle = mut;
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.fillText(SHARE_WATERMARK, 28, H - 34);
    ctx.fillText("Local-first · offline · github.com/Thejesh-k463/VYUHA-LOG", 28, H - 20);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vyuha-stats-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Stat card saved — check your downloads.");
    }, "image/png");
  }

  const tone = (t: string) => (t === "profit" ? "text-profit" : t === "loss" ? "text-loss" : "");

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2"><Share2 className="size-4" /> Shareable stat card</CardTitle>
        <Button size="sm" onClick={download}><Download className="size-4" /> Save PNG</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
          <div className="space-y-1.5">
            <Label className="text-xs">Amounts</Label>
            <Select value={privacy} onChange={(e) => setPrivacy(e.target.value as PrivacyMode)} className="h-8 text-xs">
              <option value="percent">Show as % of capital</option>
              <option value="r">Hide ₹ amounts entirely</option>
              <option value="amounts">Show real ₹ amounts</option>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Percentages and R-multiples say everything about skill without revealing account size.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Metrics on the card</Label>
            <div className="flex flex-wrap gap-1.5">
              {SHARE_METRICS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggle(m.id)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    picked.includes(m.id)
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Live preview of exactly what the PNG will contain */}
        <div className="rounded-lg border border-border bg-card-hover/30 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-primary font-bold text-primary-foreground">व</span>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-wide">VYUHA</div>
              <div className="text-[10px] text-muted-foreground">{period ?? "Trading journal"}</div>
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Pick at least one metric to show.</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              {rows.slice(0, 9).map((r) => (
                <div key={r.id}>
                  <div className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">{r.label}</div>
                  <div className={`font-mono text-xl font-light tabular-nums ${tone(r.tone)}`}>{r.display}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">{SHARE_WATERMARK}</div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          The image is drawn and saved <span className="text-foreground">on this machine</span> — nothing is uploaded.
          The &ldquo;self-reported&rdquo; watermark is permanent: Vyuha is offline and cannot verify anything with your
          broker, so the card never claims it does.
        </p>
        <canvas ref={canvasRef} className="hidden" />
      </CardContent>
    </Card>
  );
}
