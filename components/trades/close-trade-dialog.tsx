"use client";

import { useActionState, useEffect, useState } from "react";
import { closeTradeAction, type ActionState } from "@/app/trades/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { inr } from "@/lib/format";
import { CheckCircle2, AlertCircle } from "lucide-react";
import type { Trade } from "@/lib/db/schema";

interface PreviewResp {
  breakdown: { total: number };
  grossPnl: number;
  netPnl: number;
}

/** Quick close: exit price + date, with a live recomputed preview before you confirm. */
export function CloseTradeDialog({ trade, onDone }: { trade: Trade; onDone: () => void }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(closeTradeAction, { ok: false, message: "" });
  const isShort = trade.sellQty > trade.buyQty;
  const qty = Math.abs(trade.buyQty - trade.sellQty) || Math.max(trade.buyQty, trade.sellQty);
  const entryPrice = isShort ? trade.avgSellPrice : trade.avgBuyPrice;

  const [exitPrice, setExitPrice] = useState("");
  const [exitDate, setExitDate] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<PreviewResp | null>(null);

  useEffect(() => {
    if (state.ok) onDone();
  }, [state.ok, onDone]);

  useEffect(() => {
    const price = Number(exitPrice) || 0;
    // Deliberate: clears the stale preview synchronously when the price goes
    // invalid, before the debounced fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (price <= 0) { setPreview(null); return; }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const buyQty = isShort ? qty : trade.buyQty;
        const avgBuyPrice = isShort ? price : trade.avgBuyPrice;
        const sellQty = isShort ? trade.sellQty : qty;
        const avgSellPrice = isShort ? trade.avgSellPrice : price;
        const res = await fetch("/api/charges/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            broker: trade.broker,
            tradingsymbol: trade.tradingsymbol,
            segment: trade.segment,
            exchange: trade.exchange,
            buyValue: buyQty * avgBuyPrice,
            sellValue: sellQty * avgSellPrice,
            buyQty,
            sellQty,
            grossPnl: (avgSellPrice - avgBuyPrice) * qty,
            ownCapitalUsed: trade.mtfFundedAmount != null ? Math.max(0, buyQty * avgBuyPrice - trade.mtfFundedAmount) : null,
            daysHeld: trade.buyDate ? Math.max(0, Math.floor((new Date(exitDate).getTime() - new Date(trade.buyDate).getTime()) / 86400000)) : 0,
            isOpen: false,
          }),
        });
        if (res.ok) setPreview(await res.json());
      } catch { /* aborted */ }
    }, 300);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [exitPrice, exitDate, isShort, qty, trade]);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="tradeId" value={trade.id} />
      <div className="rounded-md border border-border bg-card-hover/30 p-2.5 text-xs">
        <span className="font-medium">{trade.symbol}</span>{" "}
        <span className="text-muted-foreground">
          {isShort ? "Short" : "Long"} {qty} @ {entryPrice}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Exit price</Label>
          <Input name="exitPrice" type="number" step="any" value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} autoFocus />
        </div>
        <div className="space-y-1">
          <Label>Exit date</Label>
          <Input name="exitDate" type="date" value={exitDate} onChange={(e) => setExitDate(e.target.value)} />
        </div>
      </div>

      {preview && (
        <div className="rounded-md border border-border bg-card-hover/30 p-3 text-xs">
          <div className="flex gap-6">
            <span className="text-muted-foreground">Charges: <span className="font-medium text-foreground">{inr(preview.breakdown.total)}</span></span>
            <span className="text-muted-foreground">Gross: <span className="font-medium text-foreground">{inr(preview.grossPnl)}</span></span>
            <span className="text-muted-foreground">
              Net: <span className={`font-semibold ${preview.netPnl >= 0 ? "text-profit" : "text-loss"}`}>{inr(preview.netPnl)}</span>
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !(Number(exitPrice) > 0)}>
          {pending ? "Closing…" : isShort ? "Cover & close" : "Sell & close"}
        </Button>
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
