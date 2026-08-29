"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WriteAccountPicker, type WriteAccountOption } from "@/components/system/write-account-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { inr, num } from "@/lib/format";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { Upload, FileCheck2, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { dropzoneHint } from "@/lib/import/registry-meta"; // client-safe leaf — detect.ts drags every parser (incl. 399 KB xlsx) into the bundle
import { ColumnMapper } from "./column-mapper";
import type { ColumnMapping } from "@/lib/import/generic-map";
import type { Broker } from "@/lib/domain/constants";
import { importShapeSentence, openingSellNote, type ImportShape } from "@/lib/domain/import-shape";

interface PreviewRow {
  tradingsymbol: string; symbol: string; segment: Segment; bucket: string; exchange: string;
  buyQty: number; sellQty: number; buyValue: number; sellValue: number;
  grossPnl: number; chargesTotal: number; netPnl: number; isOpen: boolean; isDuplicate: boolean;
  buyDate?: string | null; sellDate?: string | null; tradingsymbol_?: string;
}
type ProductHint = "delivery" | "mtf" | "intraday";
/**
 * The only segments where the product type is genuinely in QUESTION.
 *
 * Intraday is excluded deliberately. It is never in doubt: a same-day round
 * trip is a fact in a P&L file, and in a transaction report the intraday stamp
 * duty rate (0.003% against delivery's 0.015%) states it outright. What cannot
 * be known either way is whether a DELIVERY row was actually MTF — the two are
 * identical in STT and stamp duty, and financing interest never appears in
 * either kind of file. So that, and only that, is what the user is asked.
 */
const AMBIGUOUS_SEGMENTS = new Set<Segment>(["eq_delivery", "eq_mtf"]);
const PRODUCT_CHOICES: { value: ProductHint; label: string; hint: string }[] = [
  { value: "delivery", label: "Equity Delivery", hint: "Paid in full, held overnight" },
  { value: "mtf", label: "Equity MTF", hint: "Broker-funded; interest accrues daily" },
  { value: "intraday", label: "Equity Intraday", hint: "Squared off the same day" },
];
interface FileKindCapability {
  kind: "transactions" | "pnl";
  label: string;
  knowsProduct: boolean;
  knowsTime: boolean;
  knowsFills: boolean;
}
interface PreviewResp {
  mode: "preview";
  fileKind?: FileKindCapability;
  /** Present only when the file needs its columns mapped before it can be read. */
  table?: {
    headers: string[];
    sampleRows: string[][];
    totalRows: number;
    suggested: ColumnMapping;
  } | null;
  detected: { sourceId: string; label: string; confidence: number };
  candidates: { sourceId: string; label: string; confidence: number }[];
  preview: {
    sourceId: string; broker: string; format: string; warnings: string[]; rawText?: string;
    rows: PreviewRow[];
    shape: ImportShape;
    summary: { total: number; newCount: number; dupCount: number; grossPnl: number; chargesTotal: number; netPnl: number };
    reconciliation?: { reported: Record<string, number>; computed: Record<string, number> };
    crossSource?: { collisions: { symbol: string; kind: string; detail: string }[]; symbols: string[]; risky: boolean; message: string | null };
  };
}

export function ImportClient({ writeAccounts = [] }: { writeAccounts?: WriteAccountOption[] }) {
  const router = useRouter();
  // A6 — which book do these trades belong to? Only asked in the aggregate
  // view with 2+ accounts; dedup is per (account, broker), so this must be
  // decided BEFORE the preview, not at commit.
  const [accountId, setAccountId] = useState<number>(writeAccounts[0]?.id ?? 0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<{ added: number; skipped: number; shape?: ImportShape } | null>(null);
  const [tab, setTab] = useState<"transactions" | "pnl">("transactions");
  /** Per-symbol product corrections for a P&L file. Empty = use the guesses. */
  const [productOverrides, setProductOverrides] = useState<Record<string, ProductHint>>({});
  /**
   * The column mapping the user applied to an unrecognised file, if any.
   *
   * It must be re-sent on COMMIT as well as preview: the server re-parses the
   * uploaded bytes on every call and has no memory of the mapping between
   * them. Forgetting it here would commit an empty batch.
   */
  const [mapping, setMapping] = useState<{ broker: Broker; mapping: ColumnMapping } | null>(null);

  async function doPreview(f: File, withMapping?: { broker: Broker; mapping: ColumnMapping } | null) {
    setBusy(true); setError(null); setPreview(null); setCommitted(null); setProductOverrides({});
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("mode", "preview");
      if (accountId > 0) fd.append("accountId", String(accountId));
      if (withMapping) fd.append("mapping", JSON.stringify(withMapping));
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
      if (accountId > 0) fd.append("accountId", String(accountId));
      if (preview) fd.append("sourceId", preview.detected.sourceId);
      if (mapping) fd.append("mapping", JSON.stringify(mapping));
      // Only a P&L file needs these — a tradebook states the product itself.
      if (Object.keys(productOverrides).length > 0) {
        fd.append("productOverrides", JSON.stringify(productOverrides));
      }
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
    setMapping(null); // a new file is a new question
    if (f) doPreview(f);
  }

  /** The user has matched the columns — re-read the same file through them. */
  function applyMapping(broker: Broker, cols: ColumnMapping) {
    if (!file) return;
    const next = { broker, mapping: cols };
    setMapping(next);
    doPreview(file, next);
  }

  /**
   * Apply a product type to every row of a symbol and re-price.
   *
   * The re-preview matters: segment, charges, MTF interest and ROM all derive
   * from the product, so showing the OLD numbers next to a NEW choice would be
   * quietly wrong at exactly the moment the user is deciding.
   */
  async function setProduct(symbol: string, hint: ProductHint) {
    if (!file) return;
    const next = { ...productOverrides, [symbol]: hint };
    setProductOverrides(next);
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mode", "preview");
      if (preview) fd.append("sourceId", preview.detected.sourceId);
      if (mapping) fd.append("mapping", JSON.stringify(mapping));
      fd.append("productOverrides", JSON.stringify(next));
      if (accountId > 0) fd.append("accountId", String(accountId));
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Failed to re-price"); return; }
      setPreview(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Rows the product question actually APPLIES to.
   *
   * Only equity is ambiguous. A derivative names itself — `OPT NIFTY 26 Jun
   * 2026 24000 CE` is an index option no matter what a P&L file omits — and
   * `classify()` derives its segment from the symbol, ignoring the product
   * hint entirely. Offering it "Equity Delivery / MTF / Intraday" would be a
   * control that looks like it does something and does nothing.
   *
   * Keyed by TRADINGSYMBOL, because that is what the override map is looked up
   * by on the server. `symbol` is the display name and the two can differ.
   */
  const productRows = preview?.preview
    ? [
        ...new Map(
          preview.preview.rows
            .filter((r) => !r.isDuplicate && AMBIGUOUS_SEGMENTS.has(r.segment))
            .map((r) => [r.tradingsymbol, r.symbol] as const),
        ).entries(),
      ].sort((a, b) => a[1].localeCompare(b[1]))
    : [];

  /** Rows that answer the question themselves — reported, so the panel can say
   *  what it is NOT asking about rather than leaving the user to wonder. */
  const derivativeRowCount = preview?.preview
    ? preview.preview.rows.filter((r) => !r.isDuplicate && !AMBIGUOUS_SEGMENTS.has(r.segment)).length
    : 0;

  const p = preview?.preview;

  const isPnlTab = tab === "pnl";

  return (
    <div className="space-y-5">
      {/* Asked before the file, because dedup is per (account, broker): a
          preview run against one account would report the wrong duplicate
          count for another. Changing it discards the current preview. */}
      <WriteAccountPicker
        accounts={writeAccounts}
        value={accountId}
        onChange={(id) => { setAccountId(id); setPreview(null); setCommitted(null); }}
        label="Import into account"
      />

      {/* ── Which kind of file are you importing? ─────────────────────────
          The two are not equivalent: a tradebook states the product and the
          time; a P&L statement states neither. Making the choice explicit is
          the whole point — it sets expectations BEFORE the numbers appear. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => { setTab("transactions"); setPreview(null); setFile(null); setCommitted(null); }}
          className={`flex-1 rounded-lg border p-3 text-left transition-colors ${
            !isPnlTab ? "border-primary/60 bg-primary/5" : "border-border hover:bg-card-hover/40"
          }`}
        >
          <div className="flex items-center gap-2 text-sm font-semibold">
            📗 Transactions / Tradebook
            <Badge variant="accent">recommended</Badge>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Every execution, with product type and timestamps. Delivery, MTF and intraday are
            identified automatically, scaled positions keep their entry ladder, and time-of-day
            analytics work.
          </div>
        </button>
        <button
          type="button"
          onClick={() => { setTab("pnl"); setPreview(null); setFile(null); setCommitted(null); }}
          className={`flex-1 rounded-lg border p-3 text-left transition-colors ${
            isPnlTab ? "border-primary/60 bg-primary/5" : "border-border hover:bg-card-hover/40"
          }`}
        >
          <div className="text-sm font-semibold">📘 P&amp;L Statement</div>
          <div className="mt-1 text-xs text-muted-foreground">
            A pre-aggregated summary. It carries no product column and no times, so Vyuha will
            ask you to confirm delivery / MTF / intraday before committing.
          </div>
        </button>
      </div>

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
        <div className="text-xs text-muted-foreground">
          {/* Generated from the parser registry — the two hand-written
              strings this replaces had drifted, and the screen claimed
              three brokers while the code already read five. */}
          {dropzoneHint(isPnlTab ? "pnl" : "transactions")}
        </div>
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

      {p?.crossSource?.message && (
        <div className={`flex items-start gap-2 rounded-lg border p-4 text-xs ${p.crossSource.risky ? "border-loss/50 bg-loss/10" : "border-warning/40 bg-warning/10"}`}>
          <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${p.crossSource.risky ? "text-loss" : "text-warning"}`} />
          <div className="space-y-1.5">
            <p className="font-semibold">{p.crossSource.risky ? "These trades may already be in your journal" : "Possible overlap with an earlier import"}</p>
            <p>{p.crossSource.message}</p>
            <ul className="space-y-0.5 text-muted-foreground">
              {p.crossSource.collisions.slice(0, 6).map((c, i) => (
                <li key={i}>▸ <b>{c.symbol}</b> — {c.detail}</li>
              ))}
              {p.crossSource.collisions.length > 6 && <li>…and {p.crossSource.collisions.length - 6} more.</li>}
            </ul>
          </div>
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
          <CardContent className="flex items-start justify-between gap-4 p-4 text-sm">
            <div className="space-y-1.5">
              <span className="flex items-center gap-2 text-profit">
                <CheckCircle2 className="size-4" />
                Imported {committed.added} trade{committed.added === 1 ? "" : "s"} ·{" "}
                {committed.skipped} duplicate{committed.skipped === 1 ? "" : "s"} skipped.
              </span>
              {/* The file's own arithmetic, so a tradebook's execution count is
                  never replaced by a smaller number with no explanation. */}
              {committed.shape && (
                <p data-testid="commit-shape" className="text-xs text-muted-foreground">
                  {importShapeSentence(committed.shape)}
                </p>
              )}
              {committed.shape && openingSellNote(committed.shape.openingSells) && (
                <p className="text-xs text-muted-foreground">
                  {openingSellNote(committed.shape.openingSells)}
                </p>
              )}
            </div>
            <Button size="sm" variant="secondary" className="shrink-0" onClick={() => router.push("/trades")}>
              View trades →
            </Button>
          </CardContent>
        </Card>
      )}

      {/* An unrecognised file asks its question here, before any preview. */}
      {preview?.table && preview.preview.format === "generic-unmapped" && (
        <ColumnMapper
          headers={preview.table.headers}
          sampleRows={preview.table.sampleRows}
          totalRows={preview.table.totalRows}
          suggested={preview.table.suggested}
          busy={busy}
          onApply={applyMapping}
        />
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
              {/* Stated ABOVE the stat tiles, because the tiles show the
                  position count alone and that is the number a trader reads as
                  "you lost most of my file". The sentence is the arithmetic. */}
              <p data-testid="preview-shape" className="text-sm font-medium">
                {importShapeSentence(p.shape)}
              </p>
              {openingSellNote(p.shape.openingSells) && (
                <p className="text-xs text-muted-foreground">{openingSellNote(p.shape.openingSells)}</p>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="Positions" value={String(p.summary.total)} />
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

          {/* The file kind is DETECTED, not taken on trust from the tab —
              dropping a tradebook on the P&L tab should say so rather than
              silently asking for product types the file already knows. */}
          {preview!.fileKind && preview!.fileKind.kind !== tab && (
            <Card className="border-warning/40">
              <CardContent className="flex items-start gap-2.5 p-4 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>
                  This looks like a <b>{preview!.fileKind.label}</b>, not what the{" "}
                  <b>{isPnlTab ? "P&L Statement" : "Transactions"}</b> tab expects. It will still
                  import correctly — the tab only decides what Vyuha asks you.
                </span>
              </CardContent>
            </Card>
          )}

          {/* Product confirmation — only when the file genuinely cannot say. */}
          {preview!.fileKind && !preview!.fileKind.knowsProduct && productRows.length > 0 && (
            <Card className="border-accent/40">
              <CardHeader>
                <CardTitle className="text-base">Confirm the product type</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  A P&amp;L file has no product column, so these were <b>assumed</b>. Same-day round
                  trips are inferred as intraday; everything else defaults to <b>delivery</b>, which
                  is the safest wrong answer — it neither invents MTF interest nor applies intraday
                  leverage. Correct any that were actually MTF: charges, interest and Return-on-Margin
                  all depend on it.
                </p>
                {derivativeRowCount > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Only rows that could be MTF are listed. The other <b>{num(derivativeRowCount)}</b>{" "}
                    {derivativeRowCount === 1 ? "row is" : "rows are"} intraday or F&amp;O, which
                    identify themselves — <b>neither can ever be MTF</b>, so there is nothing to confirm.
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <div data-testid="product-confirm-rows" className="max-h-64 space-y-1.5 overflow-auto">
                  {productRows.map(([key, sym]) => {
                    const current = productOverrides[key];
                    return (
                      <div key={key} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5">
                        <span className="min-w-[140px] text-xs font-medium">{sym}</span>
                        <div className="flex gap-1">
                          {PRODUCT_CHOICES.map((c) => (
                            <button
                              key={c.value}
                              type="button"
                              title={c.hint}
                              disabled={busy}
                              onClick={() => setProduct(key, c.value)}
                              className={`rounded px-2 py-0.5 text-[0.6875rem] transition-colors ${
                                current === c.value
                                  ? "bg-primary text-primary-foreground"
                                  : "border border-border text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {c.label}
                            </button>
                          ))}
                        </div>
                        {!current && <span className="text-[10px] text-muted-foreground">assumed</span>}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

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
                      <tr key={i} className={`border-t border-rule ${r.isDuplicate ? "opacity-50" : ""}`}>
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

  /**
   * The reconciliation that actually judges the cost engine.
   *
   * A scrip-aggregated P&L hides order counts, so brokerage genuinely cannot
   * be derived and its Δ is structural, not an error. It also dominates the
   * TOTAL Δ — leaving a headline like "-32%" that reads as "the charge engine
   * is wrong" when every statutory component may be within a rupee. Taking
   * brokerage out of both sides is the comparison worth showing.
   */
  const repTotal = reco.reported.totalCharges ?? reco.reported.total;
  const compTotal = reco.computed.total;
  const repBrok = reco.reported.brokerage;
  const compBrok = reco.computed.brokerage;
  const exBrokerage =
    repTotal != null && compTotal != null && repBrok != null && compBrok != null && repTotal - repBrok > 0
      ? (() => {
          const reported = repTotal - repBrok;
          const computed = compTotal - compBrok;
          const delta = computed - reported;
          return { reported, computed, delta, pct: (delta / reported) * 100 };
        })()
      : null;

  return (
    <Card>
      <CardHeader><CardTitle>Reconciliation (computed vs broker-reported)</CardTitle></CardHeader>
      <CardContent>
        <div className="overflow-x-auto"><table className="w-full text-xs">
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
                <tr key={r.k} className="border-t border-rule">
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
        </table></div>
        {exBrokerage && (
          <p className="mt-2 text-[0.6875rem]">
            <b>Excluding brokerage, the statutory charges reconcile to{" "}
              {Math.abs(exBrokerage.pct).toFixed(2)}%</b>{" "}
            — {num(exBrokerage.computed, 0)} computed against {num(exBrokerage.reported, 0)} reported,
            a gap of {num(Math.abs(exBrokerage.delta), 0)}. STT, exchange, SEBI, stamp, IPFT and GST
            are all derivable from the file; brokerage is not, so it is the honest number to judge
            the cost engine on.
          </p>
        )}
        <p className="mt-2 text-[0.6875rem] text-muted-foreground">
          Brokerage &amp; MTF interest can&apos;t be derived from scrip-aggregated P&amp;L (order counts / financing days are hidden); large Δ there is expected.
        </p>
      </CardContent>
    </Card>
  );
}
