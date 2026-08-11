"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toaster";

export function SessionPlanner({ playbooks }: { playbooks: { id: number; name: string }[] }) {
  const router = useRouter();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const [busy, setBusy] = useState(false);
  async function submit(form: HTMLFormElement) {
    const fd = new FormData(form); setBusy(true);
    const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionDate: fd.get("date"), market: fd.get("market"), plannedSymbols: String(fd.get("symbols") ?? "").split(/[\s,]+/), plannedPlaybookIds: fd.getAll("playbooks").map(Number), maxTrades: Number(fd.get("maxTrades")) || null, maxLoss: Number(fd.get("maxLoss")) || null, cutoffTime: fd.get("cutoff") || null, thesis: fd.get("thesis") || null, status: "planned" }) });
    const data = await res.json(); setBusy(false); if (data.ok) toast.success("Plan saved."); else toast.error(data.message); if (data.ok) router.refresh();
  }
  return <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget); }}>
    <div className="grid gap-3 md:grid-cols-4"><div><Label>Date</Label><Input name="date" type="date" defaultValue={today} required /></div><div><Label>Market</Label><Input name="market" defaultValue="NSE" /></div><div><Label>Max trades</Label><Input name="maxTrades" type="number" min="1" /></div><div><Label>Loss budget ₹</Label><Input name="maxLoss" type="number" min="1" /></div></div>
    <div className="grid gap-3 md:grid-cols-2"><div><Label>Watchlist symbols</Label><Input name="symbols" placeholder="NIFTY, RELIANCE, HDFCBANK" /></div><div><Label>Last entry time</Label><Input name="cutoff" type="time" /></div></div>
    <div><Label>Planned playbooks</Label><div className="mt-1 flex flex-wrap gap-2">{playbooks.map((p) => <label key={p.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"><input type="checkbox" name="playbooks" value={p.id} />{p.name}</label>)}</div></div>
    <div><Label>Thesis and invalidation</Label><textarea name="thesis" rows={3} className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm" placeholder="What must be true before you trade, and what makes the plan invalid?" /></div>
    <div className="flex items-center gap-3"><Button disabled={busy}>{busy ? "Saving…" : "Save session plan"}</Button></div>
  </form>;
}
