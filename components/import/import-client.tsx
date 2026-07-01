"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { inr, num } from "@/lib/format";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { Upload, FileCheck2, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

interface PreviewRow {
  tradingsymbol: string; symbol: string; segment: Segment; bucket: string; exchange: string;
  buyQty: number; sellQty: number; buyValue: number; sellValue: number;
  grossPnl: number; chargesTotal: number; netPnl: number; isOpen: boolean; isDuplicate: boolean;
}
interface PreviewResp {
  mode: "preview";
  detected: { sourceId: string; label: string; confidence: number };
  candidates: { sourceId: string; label: string; confidence: number }[];
  preview: {
    sourceId: string; broker: string; format: string; warnings: string[]; rawText?: string;
    rows: PreviewRow[];
    summary: { total: number; newCount: number; dupCount: number; grossPnl: number; chargesTotal: number; netPnl: number };
    reconciliation?: { reported: Record<string, number>; computed: Record<string, number> };
  };
}

export function ImportClient() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<{ added: number; skipped: number } | null>(null);

  async function doPreview(f: File) {
    setBusy(true); setError(null); setPreview(null); setCommitted(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("mode", "preview");
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Failed to parse file"); return; }
      setPreview(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mode", "commit");
      if (preview) fd.append("sourceId", preview.detected.sourceId);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Commit failed"); return; }
      setCommitted(json.result);
      setPreview(null);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onPick(f: File | null) {
    setFile(f);
    if (f) doPreview(f);
  }

  const p = preview?.preview;

  return (
    <div className="space-y-5">
      {/* Dropzone */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onPick(e.dataTransfer.files?.[0] ?? null); }}
        onClick={() => inputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/40 py-10 text-center transition-colors hover:bg-card-hover/50"
      >
        <Upload className="size-6 text-muted-foreground" />
        <div className="text-sm">
          <span className="font-medium text-foreground">Drop a broker file</span>{" "}
          <span className="text-muted-foreground">or click to browse</span>
        </div>
        <div className="text-xs text-muted-foreground">Dhan CSV · Groww XLSX · Zerodha CSV/XLSX · PDF</div>
        {file && <Badge variant="secondary" className="mt-1">{file.name}</Badge>}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls,.pdf"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
      </div>

      {busy && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Working…
        </div>
      )}

      {error && (
        <Card className="border-loss/40">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-loss">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      )}

      {committed && (
        <Card className="border-profit/40">
          <CardContent className="flex items-center justify-between p-4 text-sm">
            <span className="flex items-center gap-2 text-profit">
              <CheckCircle2 className="size-4" />
              Imported {committed.added} trade{committed.added === 1 ? "" : "s"} ·{" "}
              {committed.skipped} duplicate{committed.skipped === 1 ? "" : "s"} skipped.
            </span>
            <Button size="sm" variant="secondary" onClick={() => router.push("/trades")}>
              View trades →
            </Button>
          </CardContent>
        </Card>
      )}

      {p && (
        <>
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <FileCheck2 className="size-4 text-primary" />
                Detected: {preview!.detected.label}
                <Badge variant="accent">{Math.round(preview!.detected.confidence * 100)}% match</Badge>
              </CardTitle>
              <Button onClick={doCommit} disabled={busy || p.summary.newCount === 0}>
                Commit {p.summary.newCount} new trade{p.summary.newCount === 1 ? "" : "s"}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="Rows" value={String(p.summary.total)} />
                <Stat label="New" value={String(p.summary.newCount)} cls="text-primary" />
                <Stat label="Duplicates" value={String(p.summary.dupCount)} cls="text-warning" />
                <Stat label="Gross P&L" value={inr(p.summary.grossPnl, { decimals: 0 })} />
                <Stat label="Net P&L" value={inr(p.summary.netPnl, { decimals: 0 })} cls={p.summary.netPnl >= 0 ? "text-profit" : "text-loss"} />
              </div>

              {p.warnings.length > 0 && (
                <div className="space-y-1 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning/90">
                  {p.warnings.map((w, i) => (
                    <div key={i} className="flex gap-2"><AlertTriangle className="size-3.5 shrink-0" /> {w}</div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {p.reconciliation && <Reconciliation reco={p.reconciliation} />}

          <Card>
            <CardHeader><CardTitle>Preview ({p.rows.length})</CardTitle></CardHeader>
            <CardContent>
              <div className="max-h-[480px] overflow-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-muted-foreground">
                      <th className="px-2 py-1.5 font-medium">Symbol</th>
                      <th className="px-2 py-1.5 font-medium">Segment</th>
                      <th className="px-2 py-1.5 text-right font-medium">Buy</th>
                      <th className="px-2 py-1.5 text-right font-medium">Sell</th>
                      <th className="px-2 py-1.5 text-right font-medium">Gross</th>
                      <th className="px-2 py-1.5 text-right font-medium">Charges</th>
                      <th className="px-2 py-1.5 text-right font-medium">Net</th>
                      <th className="px-2 py-1.5 font-medium">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((r, i) => (
                      <tr key={i} className={`border-t border-border/40 ${r.isDuplicate ? "opacity-50" : ""}`}>
                        <td className="px-2 py-1 font-medium">{r.symbol}</td>
                        <td className="px-2 py-1 text-muted-foreground">{SEGMENT_LABELS[r.segment]}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{num(r.buyValue, 0)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{num(r.sellValue, 0)}</td>
                        <td className={`px-2 py-1 text-right tabular-nums ${r.grossPnl >= 0 ? "text-profit" : "text-loss"}`}>{num(r.grossPnl, 0)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{num(r.chargesTotal, 0)}</td>
                        <td className={`px-2 py-1 text-right tabular-nums ${r.netPnl >= 0 ? "text-profit" : "text-loss"}`}>{num(r.netPnl, 0)}</td>
                        <td className="px-2 py-1">
                          <div className="flex gap-1">
                            {r.isOpen && <Badge variant="secondary">open</Badge>}
                            {r.isDuplicate && <Badge variant="warning">dup</Badge>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md border border-border bg-card-hover/30 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${cls ?? ""}`}>{value}</div>
    </div>
  );
}

function Reconciliation({ reco }: { reco: { reported: Record<string, number>; computed: Record<string, number> } }) {
  const keys = Object.keys(reco.reported).filter((k) => reco.computed[k] != null || ["brokerage", "stt", "exchangeTxn", "stamp", "sebi", "totalCharges", "total"].includes(k));
  const label: Record<string, string> = {
    stt: "STT/CTT", sttCtt: "STT/CTT", exchangeTxn: "Exchange", stamp: "Stamp", stampDuty: "Stamp",
    sebi: "SEBI", brokerage: "Brokerage", gst: "GST", total: "Total charges", totalCharges: "Total charges",
    grossPnl: "Gross P&L", netPnl: "Net P&L", mtfInterest: "MTF interest",
  };
  const rows = keys
    .map((k) => ({ k, reported: reco.reported[k], computed: reco.computed[k] ?? reco.computed[k === "stt" ? "sttCtt" : k === "stamp" ? "stampDuty" : k === "totalCharges" ? "total" : k] }))
    .filter((r) => r.reported != null);

  return (
    <Card>
      <CardHeader><CardTitle>Reconciliation (computed vs broker-reported)</CardTitle></CardHeader>
      <CardContent>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-medium">Component</th>
              <th className="py-1 text-right font-medium">Computed</th>
              <th className="py-1 text-right font-medium">Reported</th>
              <th className="py-1 text-right font-medium">Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = (r.computed ?? 0) - r.reported;
              const pct = r.reported ? (d / r.reported) * 100 : 0;
              const big = Math.abs(pct) > 10;
              return (
                <tr key={r.k} className="border-t border-border/40">
                  <td className="py-1">{label[r.k] ?? r.k}</td>
                  <td className="py-1 text-right tabular-nums">{r.computed != null ? num(r.computed, 0) : "—"}</td>
                  <td className="py-1 text-right tabular-nums">{num(r.reported, 0)}</td>
                  <td className={`py-1 text-right tabular-nums ${big ? "text-warning" : "text-muted-foreground"}`}>
                    {r.computed != null ? `${pct.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Brokerage &amp; MTF interest can&apos;t be derived from scrip-aggregated P&amp;L (order counts / financing days are hidden); large Δ there is expected.
        </p>
      </CardContent>
    </Card>
  );
}
