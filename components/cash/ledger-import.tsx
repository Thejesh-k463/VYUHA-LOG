"use client";

/**
 * Ledger import — the only route by which REAL MTF interest enters Vyuha.
 *
 * Everything else in the app estimates it: funded amount × rate × days held.
 * Dhan posts the actual figure weekly to the ledger, and nowhere else. So this
 * card exists mainly to show the two numbers side by side and let the trader
 * see whether the estimate has been trustworthy.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { inr } from "@/lib/format";
import { Upload, TriangleAlert } from "lucide-react";

interface Mtf {
  actual: number;
  estimated: number;
  delta: number;
  deltaPct: number | null;
}

interface Preview {
  from: string;
  to: string;
  total: number;
  newCount: number;
  dupCount: number;
  openingBalance: number | null;
  mtf: Mtf;
  byKind: { kind: string; count: number; amount: number }[];
  unclassified: { date: string; narration: string; amount: number }[];
  warnings: string[];
}

const KIND_LABEL: Record<string, string> = {
  mtf_interest: "MTF interest",
  charge: "Charges",
  deposit: "Deposits",
  withdrawal: "Withdrawals",
  dividend: "Dividends",
  realised_pnl: "Settlement / obligations",
  adjustment: "Adjustments",
};

export function LedgerImport() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(f: File, mode: "preview" | "commit") {
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("mode", mode);
      const res = await fetch("/api/import/ledger", { method: "POST", body: fd });
      const data = await res.json();
      if (!data.ok) {
        setMsg({ ok: false, text: data.message ?? "Import failed" });
        return null;
      }
      return data;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onPick(f: File | null) {
    setFile(f);
    setPreview(null);
    if (!f) return;
    const data = await send(f, "preview");
    if (data) setPreview(data as Preview);
  }

  async function commit() {
    if (!file) return;
    const data = await send(file, "commit");
    if (!data) return;
    setMsg({
      ok: true,
      text: `Imported ${data.added} ledger entries (${data.skipped} already present). Real MTF interest ${inr(data.mtf.actual, { decimals: 0 })}.`,
    });
    setPreview(null);
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  const m = preview?.mtf;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import Dhan ledger — real MTF interest</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          MTF interest is <b>not</b> a transaction charge. Dhan calculates it daily and posts it{" "}
          <b>weekly to the ledger</b>, which is why it appears in no P&amp;L export and on no contract note.
          Everywhere else Vyuha has to <i>estimate</i> it from the funded amount and a day count — this reads what
          you were actually charged. Get it from <span className="font-mono text-[0.6875rem]">Profile → All Statements → Ledger</span>,
          downloaded as CSV.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            className="hidden"
            id="ledger-file"
          />
          <Button asChild variant="outline" disabled={busy}>
            <label htmlFor="ledger-file" className="cursor-pointer">
              <Upload className="mr-1.5 size-3.5" />
              {busy ? "Reading…" : "Choose ledger CSV"}
            </label>
          </Button>
          {file && <span className="text-xs text-muted-foreground">{file.name}</span>}
        </div>

        {preview && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="secondary">
                {preview.from} → {preview.to}
              </Badge>
              <Badge variant="secondary">{preview.newCount} new</Badge>
              {preview.dupCount > 0 && <Badge variant="secondary">{preview.dupCount} already imported</Badge>}
              {preview.openingBalance != null && (
                <span className="text-muted-foreground">opening balance {inr(preview.openingBalance, { decimals: 0 })}</span>
              )}
            </div>

            {/* The comparison this card exists for. */}
            {m && (
              <div className="rounded-md border border-accent/40 p-3">
                <div className="text-sm font-medium">MTF interest — actual vs estimated</div>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <div className="text-[0.6875rem] text-muted-foreground">Broker charged</div>
                    <div className="font-mono text-sm tabular-nums">{inr(m.actual, { decimals: 0 })}</div>
                  </div>
                  <div>
                    <div className="text-[0.6875rem] text-muted-foreground">Vyuha estimated</div>
                    <div className="font-mono text-sm tabular-nums">{inr(m.estimated, { decimals: 0 })}</div>
                  </div>
                  <div>
                    <div className="text-[0.6875rem] text-muted-foreground">Difference</div>
                    <div className={`font-mono text-sm tabular-nums ${Math.abs(m.delta) > 1 ? "text-warning" : "text-profit"}`}>
                      {inr(m.delta, { decimals: 0 })}
                    </div>
                  </div>
                  <div>
                    <div className="text-[0.6875rem] text-muted-foreground">vs estimate</div>
                    <div className="font-mono text-sm tabular-nums">
                      {m.deltaPct == null ? "—" : `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct}%`}
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-[0.6875rem] text-muted-foreground">
                  Shown as a comparison, not a correction. Ledger interest is a weekly <b>account-level</b> posting;
                  splitting it back across individual positions would mean inventing a per-trade allocation the
                  broker never stated.
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {preview.byKind.map((k) => (
                <span key={k.kind} className="text-muted-foreground">
                  <b className="text-foreground">{KIND_LABEL[k.kind] ?? k.kind}</b> {k.count} ·{" "}
                  <span className="font-mono tabular-nums">{inr(k.amount, { decimals: 0 })}</span>
                </span>
              ))}
            </div>

            {preview.unclassified.length > 0 && (
              <div className="rounded-md border border-warning/40 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-warning">
                  <TriangleAlert className="size-3.5" />
                  {preview.unclassified.length} row{preview.unclassified.length === 1 ? "" : "s"} could not be classified
                </div>
                <p className="mt-1 text-muted-foreground">
                  These are imported as adjustments and listed here rather than filed under a guess — a ledger
                  importer that silently mislabels a debit is worse than one that admits it is unsure.
                </p>
                <ul className="mt-1.5 space-y-0.5 font-mono text-[0.6875rem] text-muted-foreground">
                  {preview.unclassified.slice(0, 5).map((u, i) => (
                    <li key={i}>
                      {u.date} · {u.narration.slice(0, 60)} · {inr(u.amount, { decimals: 0 })}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Button onClick={commit} disabled={busy || preview.newCount === 0}>
              {busy ? "Importing…" : `Import ${preview.newCount} entr${preview.newCount === 1 ? "y" : "ies"}`}
            </Button>
          </div>
        )}

        {msg && <p className={`text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>{msg.text}</p>}
      </CardContent>
    </Card>
  );
}
