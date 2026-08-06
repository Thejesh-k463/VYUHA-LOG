"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2, CheckCircle2, AlertCircle } from "lucide-react";
import type { InstrumentDisplay } from "@/lib/queries/instruments";

const PLACEHOLDER = `One per line:  SYMBOL, SECTOR, [NAME], [LOT], [ISIN]
RELIANCE, Energy, Reliance Industries
HDFCBANK, Financials, HDFC Bank
TCS, IT, Tata Consultancy, 175, INE467B01029
INFY, IT`;

export function InstrumentManager({ rows }: { rows: InstrumentDisplay[] }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState("");
  const [sector, setSector] = useState("");
  const [text, setText] = useState("");
  const [addAll, setAddAll] = useState(false);
  const [pending, setPending] = useState<"" | "add" | "load" | "clear" | "file">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onFile(file: File) {
    setPending("file");
    setMsg(null);
    const content = await file.text();
    await post({ action: "file", text: content, addAll }, "file");
  }

  async function post(payload: object, kind: "add" | "load" | "clear" | "delete" | "file") {
    if (kind !== "delete") setPending(kind);
    setMsg(null);
    const res = await fetch("/api/instruments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setPending("");
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) {
      if (kind === "add") { setSymbol(""); setSector(""); }
      if (kind === "load") setText("");
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      {/* ── NSE file upload — the no-typing path ─────────────────────────── */}
      <div className="space-y-2 rounded-md border border-border bg-card-hover/30 p-3">
        <div className="text-xs font-semibold">Fill from an NSE file</div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Three files work here, all free from nseindia.com — download <b>after ~6 PM IST</b> on a
          trading day so the day&apos;s final data is in them:
        </p>
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
          <li>
            <b>Daily bhavcopy</b> (names + ISINs): Market Data → Reports → Daily Reports → Cash Market
            → <span className="font-mono">BhavCopy_NSE_CM_…csv</span>
          </li>
          <li>
            <b>Securities list</b> (names + ISINs for everything listed): Market Data → Securities
            Available for Trading → <span className="font-mono">EQUITY_L.csv</span>
          </li>
          <li>
            <b>F&amp;O market lots</b> (lot sizes): Derivatives → Contract Information → Market Lots
            → <span className="font-mono">fo_mktlots.csv</span>
          </li>
        </ul>
        <p className="text-[11px] text-muted-foreground">
          Only the columns a file actually carries are written — your sector tags are never touched
          (no NSE file publishes sectors; those stay yours to assign below).
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center">
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = "";
              }}
              disabled={pending !== ""}
            />
            <span className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90">
              {pending === "file" ? "Reading…" : "Upload NSE file"}
            </span>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={addAll} onChange={(e) => setAddAll(e.target.checked)} className="size-3.5" />
            Add every symbol in the file (default: only enrich symbols already in your master)
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Symbol</Label>
          <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="RELIANCE" className="h-8 w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Sector</Label>
          <Input value={sector} onChange={(e) => setSector(e.target.value)} placeholder="Energy" className="h-8 w-44" />
        </div>
        <Button size="sm" disabled={pending !== "" || !symbol.trim()} onClick={() => post({ action: "add", symbol, sector }, "add")}>
          {pending === "add" ? "Saving…" : "Add / update"}
        </Button>
      </div>

      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder={PLACEHOLDER}
          className="w-full rounded-md border border-border bg-input p-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={pending !== "" || !text.trim()} onClick={() => post({ action: "load", text }, "load")}>
            {pending === "load" ? "Loading…" : "Bulk load"}
          </Button>
          <Button size="sm" variant="outline" disabled={pending !== "" || rows.length === 0} onClick={() => { if (confirm("Clear all instruments?")) post({ action: "clear" }, "clear"); }}>
            {pending === "clear" ? "Clearing…" : `Clear${rows.length ? ` (${rows.length})` : ""}`}
          </Button>
          {msg && (
            <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
              {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
              {msg.text}
            </span>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-y border-border text-left text-muted-foreground">
                <th className="px-2.5 py-2 font-medium">Symbol</th>
                <th className="px-2 py-2 font-medium">Sector</th>
                <th className="px-2.5 py-2 font-medium">Name</th>
                <th className="px-2 py-2 text-right font-medium">Lot</th>
                <th className="px-2.5 py-2 font-medium">ISIN</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-rule">
                  <td className="px-2.5 py-1.5 font-medium">{r.symbol}</td>
                  <td className="px-2 py-1.5">{r.sector ?? "—"}</td>
                  <td className="px-2.5 py-1.5 text-muted-foreground">{r.name ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.lotSize ?? "—"}</td>
                  <td className="px-2.5 py-1.5 tabular-nums text-muted-foreground">{r.isin ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button onClick={() => post({ action: "delete", id: r.id }, "delete")} className="text-muted-foreground hover:text-loss" aria-label="Delete instrument">
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
