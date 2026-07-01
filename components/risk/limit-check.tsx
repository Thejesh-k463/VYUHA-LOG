"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { LimitVerdict } from "@/components/risk/limit-verdict";
import { SEGMENTS, SEGMENT_LABELS } from "@/lib/domain/constants";
import type { LimitResult } from "@/lib/risk/limits";

/** What-if pre-trade limits check — enter a prospective order, see pass/warn/block. */
export function LimitCheck() {
  const [segment, setSegment] = useState<string>("eq_intraday");
  const [symbol, setSymbol] = useState("");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [qty, setQty] = useState("");
  const [result, setResult] = useState<LimitResult | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");

  async function check() {
    setPending(true);
    setErr("");
    try {
      const res = await fetch("/api/risk/limits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segment, symbol, entry, qty, stop: stop || null }),
      });
      const d = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
      if (d.ok) setResult(d.result);
      else { setResult(null); setErr(d.message ?? "Check failed"); }
    } finally {
      setPending(false);
    }
  }

  const ready = Number(entry) > 0 && Number(qty) > 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Segment</Label>
          <Select value={segment} onChange={(e) => setSegment(e.target.value)}>
            {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Symbol</Label>
          <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="RELIANCE" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Entry</Label>
          <Input type="number" step="any" value={entry} onChange={(e) => setEntry(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Stop-loss</Label>
          <Input type="number" step="any" value={stop} onChange={(e) => setStop(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Quantity</Label>
          <Input type="number" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={check} disabled={pending || !ready}>{pending ? "Checking…" : "Check limits"}</Button>
        {err && <span className="text-xs text-loss">{err}</span>}
      </div>
      {result && <LimitVerdict result={result} />}
    </div>
  );
}
