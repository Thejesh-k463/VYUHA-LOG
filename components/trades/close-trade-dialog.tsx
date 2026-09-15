"use client";

import { todayIstIso } from "@/lib/domain/trading-day";
import { useActionState, useEffect, useState } from "react";
import { closeTradeAction, type ActionState } from "@/app/trades/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { inr } from "@/lib/format";
import { toast } from "@/components/ui/toaster";
import type { SlimTrade as Trade } from "@/lib/domain/slim-trade"; // wire projection — see slim-trade.ts
import { closeRemainder, closingAggregate, closingCountIsDefault } from "@/lib/domain/close-aggregate";

interface PreviewResp {
  breakdown: { total: number };
  grossPnl: number;
  netPnl: number;
}

/**
 * The exit date `closePosition` will actually store (I1 [1]): its own rule,
 * `normalizeDate(exitDate) ?? todayIstIso()` (lib/import/commit.ts) — restated
 * here because commit.ts is server-only and this is a client component.
 *
 * ONE resolution serves the dates the preview is priced at AND the holding
 * period it bills. Reading the RAW field for `daysHeld` made a cleared or
 * unreadable date an Invalid Date, so `daysHeld` was NaN, `JSON.stringify` sent
 * it as null, and the route billed 0 days of MTF interest against a save that
 * charged the real holding period (a preview of ₹168.71 charges beside a stored
 * ₹405.42 on a 30-day ₹16,000-funded MTF row).
 *
 * L3 (wave 2L): NULL when the field holds something that is not a real calendar
 * day — the save refuses such a date now ('2026-02-31' used to be stored as a
 * sell date; '99-99-9999' threw on an MTF row), so there is no date to preview
 * at either. A BLANK field is still today: unanswered, not unreadable.
 */
export function resolveExitIso(exitDate: string): string | null {
  const s = (exitDate ?? "").trim();
  if (s === "") return todayIstIso();
  const dmy = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (dmy) return realDay(dmy[3], dmy[2], dmy[1]);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return realDay(iso[1], iso[2], iso[3]);
  return null;
}

/** T+1-through-settlement day count, as `closePosition` bills it; 0 without both dates. */
function daysBetween(buyDate: string | null, exitIso: string | null): number {
  if (!buyDate || !exitIso) return 0;
  return Math.max(0, Math.floor((new Date(exitIso).getTime() - new Date(buyDate).getTime()) / 86400000));
}

/** `${y}-${mo}-${d}` when that day exists, else null (commit.ts `isRealDay`). */
function realDay(y: string, mo: string, d: string): string | null {
  const [yy, mm, dd] = [Number(y), Number(mo), Number(d)];
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  return t.getUTCFullYear() === yy && t.getUTCMonth() === mm - 1 && t.getUTCDate() === dd ? `${y}-${mo}-${d}` : null;
}

/**
 * The /api/charges/preview body for closing `trade` at `exitPrice` — built from
 * the SAME closing-leg aggregate `closePosition` writes (lib/domain/close-aggregate.ts),
 * so a partly closed row previews prior leg + remainder × exit, not the remainder
 * alone (seam S1: it previewed sell 40 for ₹10,200 beside a save of sell 100 for
 * ₹25,200). The open side is the row's stored value. `dates` are the dates the
 * close stores, decided at the call site.
 */
export function closePreviewBody(
  trade: Trade,
  exitPrice: number,
  exitDate: string,
  dates: { buyDate: string | null; sellDate: string | null },
) {
  const close = closingAggregate(trade, exitPrice);
  const isShort = close.isShort;
  // V4 — a closing leg gaining its first quantity with no stored count bills the
  // settings default, which the wire row does not carry: omitted, the route fills it.
  const closeOrders = closingCountIsDefault(trade) ? undefined : close.closeOrderCount;
  const buyQty = isShort ? close.closeQty : trade.buyQty;
  const buyValue = isShort ? close.closeValue : trade.buyValue;
  const sellQty = isShort ? trade.sellQty : close.closeQty;
  const sellValue = isShort ? trade.sellValue : close.closeValue;
  return {
    broker: trade.broker,
    tradingsymbol: trade.tradingsymbol,
    segment: trade.segment,
    exchange: trade.exchange,
    buyValue,
    sellValue,
    buyQty,
    sellQty,
    // Both sides' order counts as closePosition bills them (T2): the closing side
    // as the aggregate writes it, the open side the stored count.
    buyOrders: isShort ? closeOrders : trade.buyOrderCount,
    sellOrders: isShort ? trade.sellOrderCount : closeOrders,
    grossPnl: Math.round((sellValue - buyValue) * 100) / 100,
    ownCapitalUsed: trade.mtfFundedAmount != null ? Math.max(0, buyValue - trade.mtfFundedAmount) : null,
    // The RESOLVED exit date, the same one `dates` carries and `closePosition`
    // stores — never the raw field (I1 [1]). A date the save would refuse (L3)
    // bills no holding period; the dialog shows no preview for it at all.
    daysHeld: daysBetween(trade.buyDate, resolveExitIso(exitDate)),
    isOpen: false,
    buyDate: dates.buyDate,
    sellDate: dates.sellDate,
  };
}

/** Quick close: exit price + date, with a live recomputed preview before you confirm. */
export function CloseTradeDialog({ trade, onDone }: { trade: Trade; onDone: () => void }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(closeTradeAction, { ok: false, message: "" });
  const { isShort, qty } = closeRemainder(trade);
  const entryPrice = isShort ? trade.avgSellPrice : trade.avgBuyPrice;

  const [exitPrice, setExitPrice] = useState("");
  const [exitDate, setExitDate] = useState(todayIstIso());
  const [preview, setPreview] = useState<PreviewResp | null>(null);

  useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
      onDone();
    } else if (state.message) {
      toast.error(state.message);
    }
  }, [state, onDone]);

  useEffect(() => {
    const price = Number(exitPrice) || 0;
    const exitIso = resolveExitIso(exitDate);
    // Deliberate: clears the stale preview synchronously when the price goes
    // invalid — or the date goes unreadable, which the save refuses (L3) — before
    // the debounced fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (price <= 0 || exitIso == null) { setPreview(null); return; }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch("/api/charges/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify(
            closePreviewBody(trade, price, exitDate, {
              // The dates closePosition will store, so the preview prices at the
              // same epoch (R56): the exit lands on the covering side — the SELL
              // for a long, the BUY for a short — and a blank exit date is today.
              buyDate: isShort ? exitIso : trade.buyDate,
              sellDate: isShort ? trade.sellDate : exitIso,
            }),
          ),
        });
        if (res.ok) setPreview(await res.json());
      } catch { /* aborted */ }
    }, 300);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [exitPrice, exitDate, isShort, trade]);

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

      <DialogFooter>
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button type="submit" disabled={pending || !(Number(exitPrice) > 0)}>
          {pending ? "Closing…" : isShort ? "Cover & close" : "Sell & close"}
        </Button>
      </DialogFooter>
    </form>
  );
}
