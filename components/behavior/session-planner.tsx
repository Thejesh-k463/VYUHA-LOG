"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toaster";
import { todayIstIso } from "@/lib/domain/trading-day";

interface Candidate {
  symbol: string;
  checked: boolean;
}

/** What /api/sessions/watchlist handed back, awaiting the user's confirmation. */
interface PendingImport {
  filename: string;
  candidates: Candidate[];
  requiresConfirmation: boolean;
  note: string | null;
  /** Set when the file had several ticker-looking columns — the user picks one. */
  columns: { header: string; index: number; symbols: string[] }[] | null;
}

export function SessionPlanner({ playbooks }: { playbooks: { id: number; name: string }[] }) {
  const router = useRouter();
  const today = todayIstIso();
  const [busy, setBusy] = useState(false);
  const [symbolsText, setSymbolsText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(form: HTMLFormElement) {
    const fd = new FormData(form); setBusy(true);
    const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionDate: fd.get("date"), market: fd.get("market"), plannedSymbols: String(fd.get("symbols") ?? "").split(/[\s,]+/), plannedPlaybookIds: fd.getAll("playbooks").map(Number), maxTrades: Number(fd.get("maxTrades")) || null, maxLoss: Number(fd.get("maxLoss")) || null, cutoffTime: fd.get("cutoff") || null, thesis: fd.get("thesis") || null, status: "planned" }) });
    const data = await res.json(); setBusy(false); if (data.ok) toast.success("Plan saved."); else toast.error(data.message); if (data.ok) router.refresh();
  }

  async function onFile(file: File) {
    setUploading(true); setPending(null);
    const fd = new FormData(); fd.append("file", file);
    const res = await fetch("/api/sessions/watchlist", { method: "POST", body: fd });
    const data = await res.json().catch(() => null);
    setUploading(false);
    if (!res.ok || !data?.ok) { toast.error(data?.error ?? "Could not read that file."); return; }
    if (data.ambiguousColumns?.length) {
      setPending({ filename: file.name, candidates: [], requiresConfirmation: true, note: data.note, columns: data.ambiguousColumns });
    } else {
      // Flat-text sources (PDF) start UNchecked: every symbol the user takes
      // from them is an explicit choice, not a default accepted in bulk.
      setPending({ filename: file.name, candidates: (data.symbols as string[]).map((s) => ({ symbol: s, checked: !data.requiresConfirmation })), requiresConfirmation: !!data.requiresConfirmation, note: data.note, columns: null });
    }
  }

  function pickColumn(symbols: string[]) {
    setPending((p) => p && { ...p, columns: null, candidates: symbols.map((s) => ({ symbol: s, checked: true })) });
  }

  function toggle(symbol: string) {
    setPending((p) => p && { ...p, candidates: p.candidates.map((c) => (c.symbol === symbol ? { ...c, checked: !c.checked } : c)) });
  }

  function addSelected() {
    if (!pending) return;
    const chosen = pending.candidates.filter((c) => c.checked).map((c) => c.symbol);
    const existing = symbolsText.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    const merged = [...new Set([...existing, ...chosen])];
    setSymbolsText(merged.join(", "));
    setPending(null);
    toast.success(`${chosen.length} symbol${chosen.length === 1 ? "" : "s"} added — save the plan to keep them.`);
  }

  return <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget); }}>
    <div className="grid gap-3 md:grid-cols-4"><div><Label>Date</Label><Input name="date" type="date" defaultValue={today} required /></div><div><Label>Market</Label><Input name="market" defaultValue="NSE" /></div><div><Label>Max trades</Label><Input name="maxTrades" type="number" min="1" /></div><div><Label>Loss budget ₹</Label><Input name="maxLoss" type="number" min="1" /></div></div>
    <div className="grid gap-3 md:grid-cols-2">
      <div>
        <div className="flex items-center justify-between">
          <Label>Watchlist symbols</Label>
          <button type="button" className="text-xs text-primary hover:underline disabled:opacity-50" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? "Reading…" : "Import from file"}
          </button>
        </div>
        <Input name="symbols" placeholder="NIFTY, RELIANCE, HDFCBANK" value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} />
        <input ref={fileRef} type="file" accept=".txt,.csv,.xlsx,.xls,.pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
      </div>
      <div><Label>Last entry time</Label><Input name="cutoff" type="time" /></div>
    </div>
    {pending && <div className="space-y-2 rounded-md border border-border bg-card p-3 text-xs">
      <p className="font-medium">{pending.filename}</p>
      {pending.note && <p className="text-muted-foreground">{pending.note}</p>}
      {pending.columns ? (
        <div className="space-y-1">
          {pending.columns.map((c) => (
            <button key={c.index} type="button" className="block w-full rounded-md border border-border px-2 py-1.5 text-left hover:border-primary/50" onClick={() => pickColumn(c.symbols)}>
              <span className="font-medium">{c.header}</span>
              <span className="ml-2 text-muted-foreground">{c.symbols.slice(0, 5).join(", ")}{c.symbols.length > 5 ? `, … (${c.symbols.length})` : ""}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {pending.candidates.map((c) => (
              <button key={c.symbol} type="button" onClick={() => toggle(c.symbol)} className={`rounded-[var(--radius-pill)] border px-2 py-0.5 ${c.checked ? "border-primary/40 bg-primary/[0.07] text-primary" : "border-border text-muted-foreground"}`}>
                {c.symbol}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button type="button" size="sm" onClick={addSelected} disabled={!pending.candidates.some((c) => c.checked)}>
              Add {pending.candidates.filter((c) => c.checked).length} to watchlist
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPending(null)}>Discard</Button>
          </div>
        </>
      )}
    </div>}
    <div><Label>Planned playbooks</Label><div className="mt-1 flex flex-wrap gap-2">{playbooks.map((p) => <label key={p.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"><input type="checkbox" name="playbooks" value={p.id} />{p.name}</label>)}</div></div>
    <div><Label>Thesis and invalidation</Label><textarea name="thesis" rows={3} className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm" placeholder="What must be true before you trade, and what makes the plan invalid?" /></div>
    <div className="flex items-center gap-3"><Button disabled={busy}>{busy ? "Saving…" : "Save session plan"}</Button></div>
  </form>;
}
