"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LEDGER_TYPES, TYPE_LABEL, type LedgerType } from "@/lib/analytics/ledger";
import { CheckCircle2, AlertCircle } from "lucide-react";

const selectCls =
  "h-8 rounded-md border border-border bg-input px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SIGNED: LedgerType[] = ["realised_pnl", "adjustment"];

export function LedgerForm() {
  const router = useRouter();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [bucket, setBucket] = useState("equity");
  const [type, setType] = useState<LedgerType>("deposit");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function add() {
    setPending(true);
    setMsg(null);
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", date, bucket, type, amount: Number(amount), note }),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setPending(false);
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) {
      setAmount("");
      setNote("");
      router.refresh();
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8 w-36" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Bucket</Label>
          <select value={bucket} onChange={(e) => setBucket(e.target.value)} className={selectCls}>
            <option value="equity">Equity</option>
            <option value="active">Trade F&O</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Type</Label>
          <select value={type} onChange={(e) => setType(e.target.value as LedgerType)} className={selectCls}>
            {LEDGER_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABEL[t]}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Amount (₹){SIGNED.includes(type) ? " ±" : ""}</Label>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={SIGNED.includes(type) ? "e.g. -2500" : "e.g. 50000"}
            className="h-8 w-36 tabular-nums"
          />
        </div>
        <div className="space-y-1 grow">
          <Label className="text-xs">Note</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" className="h-8" />
        </div>
        <Button size="sm" disabled={pending || !amount} onClick={add}>
          {pending ? "Adding…" : "Add entry"}
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-[10px] text-muted-foreground">
          Deposits/interest add cash; withdrawals/charges/MTF interest remove it. Realised P&L and adjustments take the
          sign you enter (use − for a loss). Available capital = opening + Σ entries.
        </p>
        {msg && (
          <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
            {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
