"use client";

import { useActionState, useEffect, useState } from "react";
import { updateTradeAction, type ActionState } from "@/app/trades/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { inr } from "@/lib/format";
import { normalizeDate, unreadableDateMessage } from "@/lib/domain/trading-day";
import { plannedRewardRisk } from "@/lib/risk/calculators";
import { toast } from "@/components/ui/toaster";
import type { SlimTrade as Trade } from "@/lib/domain/slim-trade"; // wire projection — see slim-trade.ts
import { TradeAttachments } from "@/components/trades/trade-attachments";
import { ExitTriggerField } from "@/components/trades/exit-trigger-field";

interface PreviewResp {
  breakdown: { brokerage: number; sttCtt: number; exchangeTxn: number; sebi: number; stampDuty: number; gst: number; dpCharges: number; mtfInterest: number; pledgeCharges: number; total: number };
  grossPnl: number;
  netPnl: number;
  /** D4 (wave 2N) / D20 (wave 2O): the route kept the row's stored bill — a
   *  notes-only edit, or a staged parent whose ladder owns the pricing. */
  keptCharges?: boolean;
  /** The sentence that says WHY the bill was kept (or why the save will refuse
   *  a moved fill on a ladder) — rendered in the `dateProblem` shape. */
  keptReason?: string;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

/** The editor's typed legs, as numbers, with the dates it will save. */
export interface EditPreviewFields {
  buyQty: number;
  avgBuyPrice: number;
  sellQty: number;
  avgSellPrice: number;
  ownCapitalUsed: number | null;
  buyDate: string | null;
  sellDate: string | null;
}

/**
 * The refusal `updateManualTrade` answers for a date it was given and cannot read
 * (L3), or null when the field is blank (blank means "clear this", as every other
 * field in this form does) or readable. The SAME sentence, from the same module the
 * save's rule now lives in — not a restatement of it.
 */
export function editDateProblem(buyDate: string | null, sellDate: string | null): string | null {
  for (const [label, value] of [["buy date", buyDate], ["sell date", sellDate]] as const) {
    const raw = (value ?? "").trim();
    if (raw !== "" && normalizeDate(raw) == null) return unreadableDateMessage(label, raw);
  }
  return null;
}

/**
 * The /api/charges/preview body for `trade` as the editor holds it — the request
 * the dialog's live preview sends, and what `updateManualTrade` (lib/import/commit.ts)
 * re-prices on Save.
 *
 * NULL when a non-empty date is not a real calendar day (G-G3-2): the save refuses
 * such a value outright (L3), so there is no figure to preview and nothing is sent —
 * the dialog states the refusal where the figure would be, rather than pricing a
 * trade the Save button will not store (invariant 6).
 */
export function editPreviewBody(trade: Trade, f: EditPreviewFields) {
  if (editDateProblem(f.buyDate, f.sellDate)) return null;
  const isOpen = f.buyQty !== f.sellQty;
  // G-G3-2 — BOTH dates resolved ONCE, through the calendar the save reads
  // (`normalizeDate`, lib/domain/trading-day), and the resolved days are what goes
  // on the wire: the raw `new Date("14-08-2026")` was an Invalid Date, so daysHeld
  // was NaN, JSON sent it as null and the route's `v.daysHeld ?? 0` billed ZERO days
  // against a save that charged the real 30 (₹205.15 of MTF interest, angelone
  // eq_mtf 100 @200 → @255 funded 16,000). A BLANK date resolves to null and bills
  // no days — `updateManualTrade`'s own semantics, where blank CLEARS the field;
  // the close dialog's blank-is-today belongs to the close, not here.
  const buyIso = normalizeDate(f.buyDate);
  const sellIso = normalizeDate(f.sellDate);
  return {
    broker: trade.broker,
    tradingsymbol: trade.tradingsymbol,
    segment: trade.segment,
    exchange: trade.exchange,
    // D4 (v4.3.0 wave 2N) — WHICH row is being edited, and the two average prices,
    // so the route can ask the save's own question: does this edit change anything
    // the charge engine is fed? If not it answers the charges the row already
    // states, because that is what the save will keep (owner ruling F1). Sent by
    // this dialog only; the close dialog and the Add form price fresh, as before.
    tradeId: trade.id,
    avgBuyPrice: f.avgBuyPrice,
    avgSellPrice: f.avgSellPrice,
    buyValue: f.buyQty * f.avgBuyPrice,
    sellValue: f.sellQty * f.avgSellPrice,
    buyQty: f.buyQty,
    sellQty: f.sellQty,
    // The order counts updateManualTrade bills (U2): a side with quantity bills its
    // stored count, a side without bills none. A stored 0 is omitted, so the route's
    // default stands in for the save's settings default — which the wire row does not
    // carry. Omitted, the route billed one order a side: a Dhan option sold in 2 orders
    // and covered in 3 previewed ₹48.52 beside a save of ₹119.32.
    buyOrders: f.buyQty > 0 ? trade.buyOrderCount || undefined : 0,
    sellOrders: f.sellQty > 0 ? trade.sellOrderCount || undefined : 0,
    grossPnl: !isOpen ? f.sellQty * f.avgSellPrice - f.buyQty * f.avgBuyPrice : 0,
    ownCapitalUsed: f.ownCapitalUsed,
    // Q-A (wave 2N) — with nothing typed in "Own capital used", a row the
    // journal never priced keeps its NULL through the save and bills 0 interest
    // (the pledge charge stands). The route prices this preview the same way,
    // so the dialog cannot show a figure the save will not store.
    mtfFundingUnstated: trade.segment === "eq_mtf" && trade.mtfFundedAmount == null && f.ownCapitalUsed == null,
    daysHeld: !isOpen && buyIso && sellIso ? Math.max(0, Math.floor((new Date(sellIso).getTime() - new Date(buyIso).getTime()) / 86400000)) : 0,
    isOpen,
    // The dates the save will STORE (`normalizeDate` at both ends), so the route
    // prices at the same epoch it does — `pricingDate` reads the sell date, else
    // the buy date (R56).
    buyDate: buyIso,
    sellDate: sellIso,
  };
}

/** Full editor for any trade, open or closed — quantities, prices, dates, SL/TSL/
 * target, risk, MTF own-capital, tags/notes. Symbol/broker/segment/exchange stay
 * fixed here (use the Re-tag dialog for reclassification). */
export function EditTradeDialog({
  trade,
  onDone,
}: {
  trade: Trade;
  onDone: () => void;
  /** Kept on the props so the caller compiles unchanged; nothing in this dialog
   *  estimates a funded amount any more (Q-A). */
  mtfMarginByBroker?: Record<string, number>;
}) {
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
  // Only treat risk as "manually touched" (exempt from SL auto-recompute) if
  // the STORED value doesn't match what SL-derivation would already produce —
  // otherwise opening Edit would silently overwrite a genuinely custom risk
  // amount the instant the dialog mounts, before the user has touched anything.
  const [riskTouched, setRiskTouched] = useState(() => {
    const origEntry = trade.sellQty > trade.buyQty ? trade.avgSellPrice : trade.avgBuyPrice;
    const origQty = trade.sellQty > trade.buyQty ? trade.sellQty : trade.buyQty;
    if (trade.riskAmount == null || trade.slPlanned == null || !(origEntry > 0) || !(origQty > 0)) return trade.riskAmount != null;
    const derived = Math.round(Math.abs(origEntry - trade.slPlanned) * origQty * 100) / 100;
    return Math.abs(trade.riskAmount - derived) > 0.5;
  });
  const [ownCapitalUsed, setOwnCapitalUsed] = useState("");
  const [setupTag, setSetupTag] = useState(trade.setupTag ?? "");
  const [exitTrigger, setExitTrigger] = useState(trade.exitTrigger ?? "");
  const [notes, setNotes] = useState(trade.notes ?? "");
  const [currentPrice, setCurrentPrice] = useState("");
  const [preview, setPreview] = useState<PreviewResp | null>(null);

  // MTF is long-only in India (you fund a purchase, never a short), but this
  // dialog is generic across segments — direction is read off the ORIGINAL
  // trade (stable for the dialog's lifetime), same convention as CloseTradeDialog.
  const isShort = trade.sellQty > trade.buyQty;

  useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
      onDone();
    } else if (state.message) {
      toast.error(state.message);
    }
  }, [state, onDone]);

  const positionValue = (Number(buyQty) || 0) * (Number(avgBuyPrice) || 0);
  // The trade's ALREADY-PERSISTED funded amount is fixed — editing buyQty/price
  // doesn't retroactively re-derive it, it just changes what's left as "own
  // capital". Mirrors updateManualTrade's own fallback exactly (never the
  // generic margin-% guess) so the preview never drifts from what gets saved.
  // Q-A (wave 2N) — NULL when the journal never recorded what the broker
  // funded. It used to be filled with `defaultMtfFundedAmount(positionValue,
  // margin_config)`, and the dialog SENT that guess as the user's own capital,
  // so re-saving a notes field turned an unpriced row into a stated
  // margin-default amount. `updateManualTrade` keeps the null now, and this
  // sends nothing rather than a figure nobody recorded.
  const currentOwnCapital =
    trade.mtfFundedAmount == null ? null : Math.max(0, Math.round((positionValue - trade.mtfFundedAmount) * 100) / 100);

  // DERIVED at render time, never stored in state (AGENTS.md: derive instead of
  // syncing state in an effect): the sentence the Save would answer for a date
  // this dialog cannot read. While it stands there is no figure to show, because
  // there is no save to preview.
  const dateProblem = editDateProblem(buyDate || null, sellDate || null);

  // Unrealized P&L at the entered current price — informational only, never
  // merged into the entry-cost figure below. This was the reported bug: a
  // position up in price still showed a "loss" because the preview only ever
  // computed realized gross (always ₹0 pre-exit).
  const isOpenNow = (Number(buyQty) || 0) !== (Number(sellQty) || 0);
  const entryPrice = isShort ? Number(avgSellPrice) || 0 : Number(avgBuyPrice) || 0;
  const openQty = isShort ? Number(sellQty) || 0 : Number(buyQty) || 0;
  const currentPriceNum = Number(currentPrice) || 0;
  const unrealizedPnl =
    isOpenNow && currentPriceNum > 0 && entryPrice > 0 && openQty > 0
      ? Math.round((isShort ? entryPrice - currentPriceNum : currentPriceNum - entryPrice) * openQty * 100) / 100
      : null;

  // Target R:R (planned, static, from entry/SL/target) and Current R (live —
  // this trade's unrealized P&L ÷ risk amount, if open).
  const liveTargetRR = plannedRewardRisk(entryPrice, slPlanned !== "" ? Number(slPlanned) : null, targetPlanned !== "" ? Number(targetPlanned) : null);
  const riskAmountNum = Number(riskAmount) || 0;
  const liveCurrentR = isOpenNow && unrealizedPnl != null && riskAmountNum > 0 ? Math.round((unrealizedPnl / riskAmountNum) * 100) / 100 : null;

  // Auto-compute risk amount from SL — |entry − SL| × qty — unless the user
  // has touched the field (or it started out as a genuinely custom value; see
  // the riskTouched initializer above).
  useEffect(() => {
    if (riskTouched) return;
    const slNum = Number(slPlanned);
    if (slPlanned !== "" && entryPrice > 0 && openQty > 0 && Number.isFinite(slNum)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRiskAmount(String(Math.round(Math.abs(entryPrice - slNum) * openQty * 100) / 100));
    } else {
      setRiskAmount("");
    }
  }, [slPlanned, entryPrice, openQty, riskTouched]);

  // Live recomputed preview as fields change — same engine, same MTF defaulting
  // as the create/close paths, so what you see matches what gets saved.
  useEffect(() => {
    const bq = Number(buyQty) || 0, bp = Number(avgBuyPrice) || 0;
    const sq = Number(sellQty) || 0, sp = Number(avgSellPrice) || 0;
    // Deliberate: clears the stale preview synchronously when inputs go invalid —
    // or a date goes unreadable, which the save refuses (L3) and `editPreviewBody`
    // answers null for — before the debounced fetch. The SAME condition, so the
    // request below is never built from a body the dialog would not send.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if ((bq <= 0 && sq <= 0) || editDateProblem(buyDate || null, sellDate || null)) { setPreview(null); return; }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch("/api/charges/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify(
            editPreviewBody(trade, {
              buyQty: bq,
              avgBuyPrice: bp,
              sellQty: sq,
              avgSellPrice: sp,
              ownCapitalUsed: ownCapitalUsed !== "" ? Number(ownCapitalUsed) : isMtf ? currentOwnCapital : null,
              // The save re-prices at pricingDate({ buyDate, sellDate }); so does the preview (R56).
              buyDate: buyDate || null,
              sellDate: sellDate || null,
            }),
          ),
        });
        if (res.ok) setPreview(await res.json());
      } catch { /* aborted */ }
    }, 300);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [buyQty, avgBuyPrice, sellQty, avgSellPrice, buyDate, sellDate, ownCapitalUsed, isMtf, currentOwnCapital, trade]);

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
        <Field label="Current price (MTM)">
          <Input name="currentPrice" type="number" step="any" value={currentPrice} onChange={(e) => setCurrentPrice(e.target.value)} placeholder="if still open" />
        </Field>
        <Field label="SL (original)"><Input name="slPlanned" type="number" step="any" value={slPlanned} onChange={(e) => setSlPlanned(e.target.value)} /></Field>
        <Field label="Trailing SL"><Input name="trailingSl" type="number" step="any" value={trailingSl} onChange={(e) => setTrailingSl(e.target.value)} /></Field>
        <Field label="Target"><Input name="targetPlanned" type="number" step="any" value={targetPlanned} onChange={(e) => setTargetPlanned(e.target.value)} /></Field>
        <Field label="Risk amount (₹)">
          <Input
            name="riskAmount"
            type="number"
            step="any"
            value={riskAmount}
            onChange={(e) => { setRiskAmount(e.target.value); setRiskTouched(e.target.value !== ""); }}
          />
        </Field>
        {isMtf && (
          <Field label="Own capital used (₹)">
            <Input
              name="ownCapitalUsed"
              type="number"
              step="any"
              value={ownCapitalUsed}
              onChange={(e) => setOwnCapitalUsed(e.target.value)}
              placeholder={currentOwnCapital != null ? `currently ≈ ${Math.round(currentOwnCapital).toLocaleString("en-IN")}` : "not recorded"}
            />
          </Field>
        )}
        <Field label="Setup tag"><Input name="setupTag" value={setupTag} onChange={(e) => setSetupTag(e.target.value)} /></Field>
        <Field label="Exit trigger"><ExitTriggerField name="exitTrigger" value={exitTrigger} onChange={setExitTrigger} /></Field>
        <Field label="Notes"><Input name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>

      <TradeAttachments tradeId={trade.id} />

      {dateProblem && (
        <p className="rounded-md border border-border bg-card-hover/30 p-3 text-xs text-muted-foreground">{dateProblem}</p>
      )}

      {!dateProblem && preview?.keptReason && (
        <p className="rounded-md border border-border bg-card-hover/30 p-3 text-xs text-muted-foreground">{preview.keptReason}</p>
      )}

      {!dateProblem && preview && (
        <div className="rounded-md border border-border bg-card-hover/30 p-3 text-xs">
          <div className="grid grid-cols-3 gap-x-4 gap-y-1 sm:grid-cols-4">
            <span className="text-muted-foreground">Brokerage <span className="tabular-nums text-foreground">{inr(preview.breakdown.brokerage)}</span></span>
            <span className="text-muted-foreground">STT/CTT <span className="tabular-nums text-foreground">{inr(preview.breakdown.sttCtt)}</span></span>
            <span className="text-muted-foreground">Exchange <span className="tabular-nums text-foreground">{inr(preview.breakdown.exchangeTxn)}</span></span>
            <span className="text-muted-foreground">GST <span className="tabular-nums text-foreground">{inr(preview.breakdown.gst)}</span></span>
            {preview.breakdown.mtfInterest > 0 && <span className="text-muted-foreground">MTF int. <span className="tabular-nums text-foreground">{inr(preview.breakdown.mtfInterest)}</span></span>}
            {preview.breakdown.pledgeCharges > 0 && <span className="text-muted-foreground">Pledge <span className="tabular-nums text-foreground">{inr(preview.breakdown.pledgeCharges)}</span></span>}
          </div>
          {isOpenNow ? (
            <>
              <div className="mt-2 flex flex-wrap gap-6 border-t border-border pt-2">
                <span className="text-muted-foreground">
                  Entry cost so far: <span className="font-semibold text-loss">{inr(preview.netPnl)}</span>
                </span>
                {unrealizedPnl != null && (
                  <span className="text-muted-foreground">
                    Unrealized P&L (at current price):{" "}
                    <span className={`font-semibold ${unrealizedPnl >= 0 ? "text-profit" : "text-loss"}`}>{inr(unrealizedPnl)}</span>
                  </span>
                )}
              </div>
              {unrealizedPnl != null && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Before exit charges — not part of the entry cost above; the position isn&apos;t closed yet.
                </p>
              )}
            </>
          ) : (
            <div className="mt-2 flex gap-6 border-t border-border pt-2">
              <span className="text-muted-foreground">Gross: <span className="font-medium text-foreground">{inr(preview.grossPnl)}</span></span>
              <span className="text-muted-foreground">Net: <span className={`font-semibold ${preview.netPnl >= 0 ? "text-profit" : "text-loss"}`}>{inr(preview.netPnl)}</span></span>
            </div>
          )}
          {(liveTargetRR != null || liveCurrentR != null) && (
            <div className="mt-2 flex flex-wrap gap-6 border-t border-border pt-2 text-[0.6875rem]">
              {liveCurrentR != null && (
                <span className="text-muted-foreground">
                  Current R: <span className={`font-semibold ${liveCurrentR >= 0 ? "text-profit" : "text-loss"}`}>{liveCurrentR.toFixed(2)}</span>
                </span>
              )}
              {liveTargetRR != null && (
                <span className="text-muted-foreground">
                  Target R:R: <span className="font-semibold text-foreground">1:{liveTargetRR.toFixed(2)}</span>
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <DialogFooter>
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
      </DialogFooter>
    </form>
  );
}
