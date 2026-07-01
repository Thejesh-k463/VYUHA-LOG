"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Trash2, CheckCircle2, AlertCircle, Play } from "lucide-react";
import type { CorporateAction } from "@/lib/db/schema";

const PLACEHOLDER = `One event per line:  SYMBOL, TYPE, EX-DATE, RATIO_OR_AMOUNT
TCS, split, 01-Aug-2026, 1:5
RELIANCE, bonus, 2026-09-01, 1:1
HDFCBANK, dividend, 2026-07-15, 19`;

type CAType = "split" | "bonus" | "dividend";

export function CorporateActionManager({ rows }: { rows: CorporateAction[] }) {
  const router = useRouter();
  const [symbol, setSymbol] = useState("");
  const [type, setType] = useState<CAType>("split");
  const [exDate, setExDate] = useState("");
  const [ratio, setRatio] = useState("");
  const [amount, setAmount] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState<"" | "add" | "load" | "clear" | number>("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function post(payload: object, kind: "add" | "load" | "clear" | "delete" | "apply", pendingKey: "" | "add" | "load" | "clear" | number) {
    setPending(pendingKey);
    setMsg(null);
    const res = await fetch("/api/corporate-actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setPending("");
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) {
      if (kind === "add") { setSymbol(""); setRatio(""); setAmount(""); }
      if (kind === "load") setText("");
      router.refresh();
    }
  }

  function addOne() {
    const [fromUnits, toUnits] = ratio.split(":").map((s) => s.trim());
    post(
      {
        action: "add",
        symbol,
        type,
        exDate,
        ...(type === "dividend" ? { dividendPerShare: amount } : { fromUnits, toUnits }),
      },
      "add",
      "add",
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Symbol</Label>
          <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="TCS" className="h-8 w-28" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Type</Label>
          <Select value={type} onChange={(e) => setType(e.target.value as CAType)} className="h-8 w-32">
            <option value="split">Split</option>
            <option value="bonus">Bonus</option>
            <option value="dividend">Dividend</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Ex-date</Label>
          <Input type="date" value={exDate} onChange={(e) => setExDate(e.target.value)} className="h-8" />
        </div>
        {type === "dividend" ? (
          <div className="space-y-1">
            <Label className="text-xs">₹ per share</Label>
            <Input type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="19" className="h-8 w-24" />
          </div>
        ) : (
          <div className="space-y-1">
            <Label className="text-xs">Ratio (from:to)</Label>
            <Input value={ratio} onChange={(e) => setRatio(e.target.value)} placeholder="1:5" className="h-8 w-24" />
          </div>
        )}
        <Button size="sm" disabled={pending !== "" || !symbol.trim() || !exDate} onClick={addOne}>
          {pending === "add" ? "Adding…" : "Add event"}
        </Button>
      </div>

      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={PLACEHOLDER}
          className="w-full rounded-md border border-border bg-input p-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={pending !== "" || !text.trim()} onClick={() => post({ action: "load", text }, "load", "load")}>
            {pending === "load" ? "Loading…" : "Bulk load"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== "" || rows.length === 0}
            onClick={() => { if (confirm("Clear all corporate action events? Already-applied adjustments to trades are NOT reversed.")) post({ action: "clear" }, "clear", "clear"); }}
          >
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
                <th className="px-2 py-2 font-medium">Type</th>
                <th className="px-2 py-2 font-medium">Ex-date</th>
                <th className="px-2 py-2 font-medium">Ratio / ₹ per share</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/40">
                  <td className="px-2.5 py-1.5 font-medium">{r.symbol}</td>
                  <td className="px-2 py-1.5 capitalize">{r.type}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.exDate}</td>
                  <td className="px-2 py-1.5 tabular-nums">
                    {r.type === "dividend" ? `₹${r.dividendPerShare}/share` : `${r.fromUnits}:${r.toUnits}`}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.appliedAt ? <Badge variant="secondary">Applied</Badge> : <Badge variant="warning">Pending</Badge>}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-2">
                      {!r.appliedAt && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending !== ""}
                          onClick={() => post({ action: "apply", id: r.id }, "apply", r.id)}
                        >
                          <Play className="size-3.5" /> {pending === r.id ? "Applying…" : "Apply"}
                        </Button>
                      )}
                      <button onClick={() => post({ action: "delete", id: r.id }, "delete", r.id)} className="text-muted-foreground hover:text-loss" aria-label="Delete event">
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
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
