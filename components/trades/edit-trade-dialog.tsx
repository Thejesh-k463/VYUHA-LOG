"use client";

import { useActionState, useEffect, useState } from "react";
import { updateTradeAction, type ActionState } from "@/app/trades/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { inr } from "@/lib/format";
import { defaultMtfFundedAmount } from "@/lib/risk/margin";
import { CheckCircle2, AlertCircle } from "lucide-react";
import type { Trade } from "@/lib/db/schema";

interface PreviewResp {
  breakdown: { brokerage: number; sttCtt: number; exchangeTxn: number; sebi: number; stampDuty: number; gst: number; dpCharges: number; mtfInterest: number; pledgeCharges: number; total: number };
  grossPnl: number;
  netPnl: number;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

/** Full editor for any trade, open or closed — quantities, prices, dates, SL/TSL/
 * target, risk, MTF own-capital, tags/notes. Symbol/broker/segment/exchange stay
 * fixed here (use the Re-tag dialog for reclassification). */
export function EditTradeDialog({ trade, onDone }: { trade: Trade; onDone: () => void }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(updateTradeAction, { ok: false, message: "" });
  const isMtf = trade.segment === "eq_mtf";

  const [buyQty, setBuyQty] = useState(String(trade.buyQty || ""));
  const [avgBuyPrice, setAvgBuyPrice] = useState(String(trade.avgBuyPrice || ""));
  const [buyDate, setBuyDate] = useState(trade.buyDate ?? "");
  const [sellQty, setSellQty] = useState(String(trade.sellQty || ""));
  const [avgSellPrice, setAvgSellPrice] = useState(String(trade.avgSellPrice || ""));
  const [sellDate, setSellDate] = useState(trade.sellDate ?? "");
  const [slPlanned, setSlPlanned] = useState(trade.slPlanned != null ? String(trade.slPlanned) : "");
  const [trailingSl, setTrailingSl] = useState(trade.trailingSl != null ? String(trade.trailingSl) : "");
  const [targetPlanned, setTargetPlanned] = useState(trade.targetPlanned != null ? String(trade.targetPlanned) : "");
  const [riskAmount, setRiskAmount] = useState(trade.riskAmount != null ? String(trade.riskAmount) : "");
  const [ownCapitalUsed, setOwnCapitalUsed] = useState("");
  const [setupTag, setSetupTag] = useState(trade.setupTag ?? "");
  const [notes, setNotes] = useState(trade.notes ?? "");
  const [preview, setPreview] = useState<PreviewResp | null>(null);

  useEffect(() => {
    if (state.ok) onDone();
  }, [state.ok, onDone]);

  const positionValue = (Number(buyQty) || 0) * (Number(avgBuyPrice) || 0);
  // The trade's ALREADY-PERSISTED funded amount is fixed — editing buyQty/price
  // doesn't retroactively re-derive it, it just changes what's left as "own
  // capital". Mirrors updateManualTrade's own fallback exactly (never the
  // generic margin-% guess) so the preview never drifts from what gets saved.
  const currentFundedGuess = trade.mtfFundedAmount ?? (positionValue > 0 ? defaultMtfFundedAmount(positionValue, 25) : 0);
  const currentOwnCapitalGuess = Math.max(0, Math.round((positionValue - currentFundedGuess) * 100) / 100);

  // Live recomputed preview as fields change — same engine, same MTF defaulting
  // as the create/close paths, so what you see matches what gets saved.
  useEffect(() => {
    const bq = Number(buyQty) || 0, bp = Number(avgBuyPrice) || 0;
    const sq = Number(sellQty) || 0, sp = Number(avgSellPrice) || 0;
    // Deliberate: clears the stale preview synchronously when inputs go invalid,
    // before the debounced fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (bq <= 0 && sq <= 0) { setPreview(null); return; }
    const isOpen = bq !== sq;
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch("/api/charges/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            broker: trade.broker,
            tradingsymbol: trade.tradingsymbol,
            segment: trade.segment,
            exchange: trade.exchange,
            buyValue: bq * bp,
            sellValue: sq * sp,
            buyQty: bq,
            sellQty: sq,
            grossPnl: !isOpen ? sq * sp - bq * bp : 0,
            ownCapitalUsed: ownCapitalUsed !== "" ? Number(ownCapitalUsed) : isMtf ? currentOwnCapitalGuess : null,
            daysHeld: !isOpen && buyDate && sellDate ? Math.max(0, Math.floor((new Date(sellDate).getTime() - new Date(buyDate).getTime()) / 86400000)) : 0,
            isOpen,
          }),
        });
        if (res.ok) setPreview(await res.json());
      } catch { /* aborted */ }
    }, 300);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [buyQty, avgBuyPrice, sellQty, avgSellPrice, buyDate, sellDate, ownCapitalUsed, isMtf, currentOwnCapitalGuess, trade]);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="tradeId" value={trade.id} />
      <div className="rounded-md border border-border bg-card-hover/30 p-2.5 text-xs">
        <span className="font-medium">{trade.symbol}</span>{" "}
        <span className="text-muted-foreground">{trade.broker} · {trade.segment} · {trade.exchange}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Buy qty"><Input name="buyQty" type="number" step="any" value={buyQty} onChange={(e) => setBuyQty(e.target.value)} /></Field>
        <Field label="Avg buy price"><Input name="avgBuyPrice" type="number" step="any" value={avgBuyPrice} onChange={(e) => setAvgBuyPrice(e.target.value)} /></Field>
        <Field label="Buy date"><Input name="buyDate" type="date" value={buyDate} onChange={(e) => setBuyDate(e.target.value)} /></Field>
        <Field label="Sell qty"><Input name="sellQty" type="number" step="any" value={sellQty} onChange={(e) => setSellQty(e.target.value)} /></Field>
        <Field label="Avg sell price"><Input name="avgSellPrice" type="number" step="any" value={avgSellPrice} onChange={(e) => setAvgSellPrice(e.target.value)} /></Field>
        <Field label="Sell date (blank = open)"><Input name="sellDate" type="date" value={sellDate} onChange={(e) => setSellDate(e.target.value)} /></Field>
        <Field label="Current price (MTM)"><Input name="currentPrice" type="number" step="any" placeholder="if still open" /></Field>
        <Field label="SL (original)"><Input name="slPlanned" type="number" step="any" value={slPlanned} onChange={(e) => setSlPlanned(e.target.value)} /></Field>
        <Field label="Trailing SL"><Input name="trailingSl" type="number" step="any" value={trailingSl} onChange={(e) => setTrailingSl(e.target.value)} /></Field>
        <Field label="Target"><Input name="targetPlanned" type="number" step="any" value={targetPlanned} onChange={(e) => setTargetPlanned(e.target.value)} /></Field>
        <Field label="Risk amount (₹)"><Input name="riskAmount" type="number" step="any" value={riskAmount} onChange={(e) => setRiskAmount(e.target.value)} /></Field>
        {isMtf && (
          <Field label="Own capital used (₹)">
            <Input
              name="ownCapitalUsed"
              type="number"
              step="any"
              value={ownCapitalUsed}
              onChange={(e) => setOwnCapitalUsed(e.target.value)}
              placeholder={currentOwnCapitalGuess > 0 ? `currently ≈ ${Math.round(currentOwnCapitalGuess).toLocaleString("en-IN")}` : "auto-estimated"}
            />
          </Field>
        )}
        <Field label="Setup tag"><Input name="setupTag" value={setupTag} onChange={(e) => setSetupTag(e.target.value)} /></Field>
        <Field label="Notes"><Input name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>

      {preview && (
        <div className="rounded-md border border-border bg-card-hover/30 p-3 text-xs">
          <div className="grid grid-cols-3 gap-x-4 gap-y-1 sm:grid-cols-4">
            <span className="text-muted-foreground">Brokerage <span className="tabular-nums text-foreground">{inr(preview.breakdown.brokerage)}</span></span>
            <span className="text-muted-foreground">STT/CTT <span className="tabular-nums text-foreground">{inr(preview.breakdown.sttCtt)}</span></span>
            <span className="text-muted-foreground">Exchange <span className="tabular-nums text-foreground">{inr(preview.breakdown.exchangeTxn)}</span></span>
            <span className="text-muted-foreground">GST <span className="tabular-nums text-foreground">{inr(preview.breakdown.gst)}</span></span>
            {preview.breakdown.mtfInterest > 0 && <span className="text-muted-foreground">MTF int. <span className="tabular-nums text-foreground">{inr(preview.breakdown.mtfInterest)}</span></span>}
            {preview.breakdown.pledgeCharges > 0 && <span className="text-muted-foreground">Pledge <span className="tabular-nums text-foreground">{inr(preview.breakdown.pledgeCharges)}</span></span>}
          </div>
          <div className="mt-2 flex gap-6 border-t border-border pt-2">
            <span className="text-muted-foreground">Gross: <span className="font-medium text-foreground">{inr(preview.grossPnl)}</span></span>
            <span className="text-muted-foreground">Net: <span className={`font-semibold ${preview.netPnl >= 0 ? "text-profit" : "text-loss"}`}>{inr(preview.netPnl)}</span></span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        {state.message && !state.ok && (
          <span className="flex items-center gap-1.5 text-sm text-loss"><AlertCircle className="size-4" />{state.message}</span>
        )}
        {state.ok && (
          <span className="flex items-center gap-1.5 text-sm text-profit"><CheckCircle2 className="size-4" />{state.message}</span>
        )}
      </div>
    </form>
  );
}
