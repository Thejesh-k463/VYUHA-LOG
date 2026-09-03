"use client";

import { todayIstIso } from "@/lib/domain/trading-day";
import { useActionState, useEffect, useState } from "react";
import { createManualTrade, type ActionState } from "@/app/trades/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { inr } from "@/lib/format";
import { toast } from "@/components/ui/toaster";
import { BROKERS, BROKER_LABELS, SEGMENTS, SEGMENT_LABELS, EXCHANGES, type Segment } from "@/lib/domain/constants";
import { LimitVerdict } from "@/components/risk/limit-verdict";
import type { LimitResult } from "@/lib/risk/limits";
import { defaultMtfFundedAmount, DEFAULT_MTF_OWN_MARGIN_PCT } from "@/lib/risk/margin";
import { TradeAttachments } from "@/components/trades/trade-attachments";
import { plannedRewardRisk } from "@/lib/risk/calculators";
import { WriteAccountPicker, type WriteAccountOption } from "@/components/system/write-account-picker";
import { CheckCircle2, Paperclip } from "lucide-react";

interface PreviewResp {
  classification: { segment: Segment; bucket: string; exchange: string; symbol: string; optionType: string | null };
  breakdown: { brokerage: number; sttCtt: number; exchangeTxn: number; sebi: number; stampDuty: number; gst: number; dpCharges: number; mtfInterest: number; pledgeCharges: number; total: number };
  grossPnl: number;
  netPnl: number;
}

const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-28" -> "28 Jul 2026" (the OPT/FUT format classify() parses). */
function toDDMonYYYY(iso: string): string {
  const [y, m, d] = iso.split("-");
  const mi = Number(m) - 1;
  if (!y || !d || mi < 0 || mi > 11) return "";
  return `${d} ${MONTHS_ABBR[mi]} ${y}`;
}

function daysBetween(a: string, b: string): number | null {
  const d1 = new Date(a + "T00:00:00").getTime();
  const d2 = new Date(b + "T00:00:00").getTime();
  if (Number.isNaN(d1) || Number.isNaN(d2)) return null;
  return Math.round((d2 - d1) / 86400000);
}

export function ManualTradeForm({
  onDone,
  mode = "closed",
  mtfMarginByBroker = {},
  writeAccounts = [],
}: {
  onDone?: () => void;
  mode?: "open" | "closed";
  /** eq_mtf own-margin % per broker (real leverage varies by broker) — looked
   * up against whichever broker is currently selected in this form. */
  mtfMarginByBroker?: Record<string, number>;
  /** Non-empty only in the aggregate view with 2+ accounts — see A6. */
  writeAccounts?: WriteAccountOption[];
}) {
  const open = mode === "open";
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createManualTrade, { ok: false, message: "" });

  const [kind, setKind] = useState<"equity" | "fno">("equity");
  const [broker, setBroker] = useState("dhan");
  const mtfOwnMarginPct = mtfMarginByBroker[broker] ?? DEFAULT_MTF_OWN_MARGIN_PCT;
  const [tradingsymbol, setSymbol] = useState("");
  // Per-stock MTF own-margin from the broker's approved list (bundled snapshot
  // or the user's uploaded refresh) — resolved live as broker/symbol change.
  const [mtfStockInfo, setMtfStockInfo] = useState<{ pct: number; label: string } | null>(null);
  const symbolForMtf = tradingsymbol.trim().toUpperCase();
  const [productHint, setProductHint] = useState("");
  const [segment, setSegment] = useState("");
  const [exchange, setExchange] = useState("");
  const [buyQty, setBuyQty] = useState("");
  const [avgBuyPrice, setBuyPrice] = useState("");
  const [sellQty, setSellQty] = useState("");
  const [avgSellPrice, setSellPrice] = useState("");
  const [currentPrice, setCurrentPrice] = useState("");
  const [sl, setSl] = useState("");
  const [target, setTarget] = useState("");
  const [riskAmount, setRiskAmount] = useState("");
  const [riskTouched, setRiskTouched] = useState(false);
  const [ownCapitalUsed, setOwnCapitalUsed] = useState("");
  const [daysHeld, setDaysHeld] = useState("");
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [limit, setLimit] = useState<LimitResult | null>(null);

  // F&O structured entry (task: strike/CE-PE/DTE/lots/direction — see manual-trade-form).
  const [underlying, setUnderlying] = useState("");
  const [contractType, setContractType] = useState<"option" | "future">("option");
  const [expiry, setExpiry] = useState("");
  const [strike, setStrike] = useState("");
  const [optType, setOptType] = useState<"CE" | "PE">("CE");
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [lotSize, setLotSize] = useState("");
  const [lots, setLots] = useState("");
  const [entryPremium, setEntryPremium] = useState("");
  const [exitPremium, setExitPremium] = useState("");

  useEffect(() => {
    // With a tradeId the dialog stays open for the attach-charts step below —
    // it closes via that step's Done button instead of snapping shut (and that
    // step shows the success message itself, so no toast for it here).
    if (state.ok && !state.tradeId) {
      if (state.message) toast.success(state.message);
      onDone?.();
    } else if (!state.ok && state.message) {
      toast.error(state.message);
    }
  }, [state, onDone]);

  // Resolve the per-stock MTF margin as broker/symbol settle (debounced; the
  // async .then keeps every setState off the synchronous effect path).
  useEffect(() => {
    if (!symbolForMtf || symbolForMtf.length < 2) {
      Promise.resolve().then(() => setMtfStockInfo(null));
      return;
    }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/mtf-margin?broker=${broker}&symbol=${encodeURIComponent(symbolForMtf)}`, { signal: ctrl.signal });
        const d = await res.json();
        setMtfStockInfo(d.ok ? { pct: d.pct, label: d.label } : null);
      } catch {
        /* keep the broker-level fallback */
      }
    }, 400);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [broker, symbolForMtf]);

  // F&O structured fields -> the same tradingsymbol/buyQty/avgBuyPrice/sellQty/
  // avgSellPrice state the equity form uses, so charge preview + limits check +
  // form submission all reuse the exact same pipeline. "direction" is submitted
  // separately (hidden input below) — the action decides which DB column (buy*
  // vs sell*) the entry/exit leg lands in; the client always feeds entry into
  // buyQty/avgBuyPrice and exit (if any) into sellQty/avgSellPrice.
  useEffect(() => {
    if (kind !== "fno") return;
    const u = underlying.trim().toUpperCase();
    const expFmt = expiry ? toDDMonYYYY(expiry) : "";
    const sym =
      contractType === "option" && u && expFmt && strike
        ? `OPT ${u} ${expFmt} ${strike} ${optType}`
        : contractType === "future" && u && expFmt
          ? `FUT ${u} ${expFmt}`
          : "";
    // Deliberate: syncs derived F&O fields into the shared equity-mode state
    // (tradingsymbol/buyQty/…) so the existing preview + limits effects below pick
    // them up unchanged.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSymbol(sym);

    const qty = (Number(lots) || 0) * (Number(lotSize) || 0);
    setBuyQty(qty > 0 ? String(qty) : "");
    setBuyPrice(entryPremium);
    if (!open) {
      setSellQty(qty > 0 ? String(qty) : "");
      setSellPrice(exitPremium);
    } else {
      setSellQty("");
      setSellPrice("");
    }
  }, [kind, underlying, contractType, expiry, strike, optType, lots, lotSize, entryPremium, exitPremium, open]);

  // Auto-compute risk amount from the SL the user set — |entry − SL| × qty —
  // instead of leaving it a manual field with just a placeholder hint. Typing
  // a value here overrides the auto-fill (riskTouched); clearing it back to
  // blank resumes auto-computing, matching the MTF own-capital field's pattern.
  useEffect(() => {
    if (riskTouched) return;
    const entryNum = Number(avgBuyPrice) || 0;
    const qtyNum = Number(buyQty) || 0;
    const slNum = Number(sl);
    if (sl !== "" && entryNum > 0 && qtyNum > 0 && Number.isFinite(slNum)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRiskAmount(String(Math.round(Math.abs(entryNum - slNum) * qtyNum * 100) / 100));
    } else {
      setRiskAmount("");
    }
  }, [sl, avgBuyPrice, buyQty, riskTouched]);

  // Debounced live charge preview
  useEffect(() => {
    const bq = Number(buyQty) || 0, bp = Number(avgBuyPrice) || 0;
    const sq = Number(sellQty) || 0, sp = Number(avgSellPrice) || 0;
    // Deliberate: clears the stale preview synchronously when inputs go invalid,
    // before the debounced fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!tradingsymbol || (bq <= 0 && sq <= 0)) { setPreview(null); return; }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch("/api/charges/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            broker, tradingsymbol,
            productHint: productHint || null,
            segment: segment || null,
            exchange: exchange || null,
            buyValue: bq * bp, sellValue: sq * sp, buyQty: bq, sellQty: sq,
            grossPnl: sq > 0 && bq > 0 ? sq * sp - bq * bp : 0,
            // MTF-only (ignored server-side unless the classified segment is
            // eq_mtf); daysHeld is forced 0 for an open position — interest
            // can't have accrued before the daily accrual job runs from T+1.
            ownCapitalUsed: Number(ownCapitalUsed) >= 0 && ownCapitalUsed !== "" ? Number(ownCapitalUsed) : null,
            daysHeld: open ? 0 : Number(daysHeld) || 0,
            isOpen: open,
          }),
        });
        if (res.ok) setPreview(await res.json());
      } catch { /* aborted */ }
    }, 300);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [broker, tradingsymbol, productHint, segment, exchange, buyQty, avgBuyPrice, sellQty, avgSellPrice, ownCapitalUsed, daysHeld, open]);

  // Pre-trade limits check (open trades only) — block/warn before saving (P1.4).
  useEffect(() => {
    // Deliberate: clears any stale verdict synchronously outside "open" mode,
    // before the debounced check.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) { setLimit(null); return; }
    const bq = Number(buyQty) || 0, bp = Number(avgBuyPrice) || 0;
    if (!preview || bq <= 0 || bp <= 0) { setLimit(null); return; }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch("/api/risk/limits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            bucket: preview.classification.bucket,
            segment: preview.classification.segment,
            symbol: preview.classification.symbol,
            entry: bp,
            qty: bq,
            stop: sl || null,
          }),
        });
        if (res.ok) { const d = await res.json(); setLimit(d.ok ? d.result : null); }
      } catch { /* aborted */ }
    }, 350);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [open, preview, buyQty, avgBuyPrice, sl]);

  // The own-capital / broker-funds split is MEANINGFUL ONLY FOR MTF — a delivery
  // or intraday equity trade has no broker funding. Showing it (with a 25%
  // default) on every equity trade made testers think the app always assumes
  // 25%. Gate strictly on MTF: the user picked "MTF" as the product, or the
  // classifier resolved eq_mtf, or they overrode the segment to eq_mtf.
  const isMtf =
    kind === "equity" &&
    (productHint === "mtf" || segment === "eq_mtf" || preview?.classification.segment === "eq_mtf");
  const blocked = open && limit?.status === "block";
  const dte = kind === "fno" && expiry ? daysBetween(todayIstIso(), expiry) : null;
  const fnoQty = (Number(lots) || 0) * (Number(lotSize) || 0);

  // MTF: "own capital used" (what YOU actually put in) is the primary input —
  // funded amount (what interest accrues on) is derived as buyValue − that,
  // never the full position value. The auto-estimate uses the PER-STOCK
  // own-margin from the broker's approved list when the app knows it
  // (/api/mtf-margin: uploads → bundled list → broker rule), falling back to
  // the broker-level rate.
  const positionValue = (Number(buyQty) || 0) * (Number(avgBuyPrice) || 0);
  const mtfEffectivePct = mtfStockInfo?.pct ?? mtfOwnMarginPct;
  const mtfDefaultOwnCapital = positionValue > 0 ? Math.round((positionValue - defaultMtfFundedAmount(positionValue, mtfEffectivePct)) * 100) / 100 : 0;
  const mtfDefaultFunded = positionValue > 0 ? defaultMtfFundedAmount(positionValue, mtfEffectivePct) : 0;
  const mtfEffectiveFunded =
    ownCapitalUsed !== "" && Number(ownCapitalUsed) >= 0
      ? Math.max(0, Math.round((positionValue - Number(ownCapitalUsed)) * 100) / 100)
      : mtfDefaultFunded;
  const mtfEffectiveOwnCapital = Math.max(0, Math.round((positionValue - mtfEffectiveFunded) * 100) / 100);
  const mtfLeverage = mtfEffectiveOwnCapital > 0 ? positionValue / mtfEffectiveOwnCapital : null;

  // Unrealized P&L for an OPEN position at the entered current price — informational
  // only, never merged into the entry-charges figure below (that reported bug: a
  // rising price showing as a "loss" because the preview only ever showed realized
  // gross, which is always ₹0 before any exit leg exists).
  const entryPriceNum = Number(avgBuyPrice) || 0;
  const currentPriceNum = Number(currentPrice) || 0;
  const openQty = Number(buyQty) || 0;
  const openSide = kind === "fno" && direction === "sell" ? -1 : 1; // short gains when price falls
  const unrealizedPnl =
    open && currentPriceNum > 0 && entryPriceNum > 0 && openQty > 0
      ? Math.round((currentPriceNum - entryPriceNum) * openQty * openSide * 100) / 100
      : null;

  // Target R:R — the planned "risk 1 to make X" ratio from entry/SL/target,
  // static (doesn't move with price); Current R — this trade's LIVE R-multiple
  // if using the entered current price, using the same riskAmount that will be
  // saved. Distinct concepts: one is the plan, the other is where you are now.
  const liveTargetRR = plannedRewardRisk(entryPriceNum, sl !== "" ? Number(sl) : null, target !== "" ? Number(target) : null);
  const riskAmountNum = Number(riskAmount) || 0;
  const liveCurrentR = open && unrealizedPnl != null && riskAmountNum > 0 ? Math.round((unrealizedPnl / riskAmountNum) * 100) / 100 : null;

  // Saved — offer the chart-attach step in place of the form. The trade is
  // already committed; screenshots are optional and never block the save.
  if (state.ok && state.tradeId) {
    return (
      <div className="space-y-4">
        <p className="flex items-center gap-1.5 text-sm text-profit">
          <CheckCircle2 className="size-4" /> {state.message}
        </p>
        <p className="text-xs text-muted-foreground">
          Add the chart you traded — it stays with this trade for review. Skip with <b>Done</b>.
        </p>
        <TradeAttachments tradeId={state.tradeId} label="Attach chart screenshots (optional)" />
        <DialogFooter>
          <Button type="button" onClick={() => onDone?.()}>Done</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {open && <input type="hidden" name="open" value="true" />}
      <input type="hidden" name="direction" value={kind === "fno" ? direction : "buy"} />

      {/* Ambiguous only in the "All accounts" view with 2+ accounts; renders
          nothing otherwise. */}
      <WriteAccountPicker accounts={writeAccounts} />

      <div className="flex rounded-lg border border-border bg-background/40 p-0.5 text-xs">
        {(["equity", "fno"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`rounded-md px-3 py-1 transition-colors ${kind === k ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            {k === "equity" ? "Equity" : "F&O (options / futures)"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Broker">
          <Select name="broker" value={broker} onChange={(e) => setBroker(e.target.value)}>
            {BROKERS.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
          </Select>
        </Field>

        {kind === "equity" ? (
          <>
            <Field label="Symbol / scrip name" className="col-span-2">
              <Input name="tradingsymbol" value={tradingsymbol} onChange={(e) => setSymbol(e.target.value)}
                placeholder="RELIANCE or OPT NIFTY 26 Jun 2026 24000 CE" />
            </Field>
            <Field label="Product (equity)">
              <Select name="productHint" value={productHint} onChange={(e) => setProductHint(e.target.value)}>
                <option value="">Auto</option>
                <option value="delivery">Delivery</option>
                <option value="intraday">Intraday</option>
                <option value="mtf">MTF</option>
              </Select>
            </Field>
            <Field label="Segment (override)">
              <Select name="segment" value={segment} onChange={(e) => setSegment(e.target.value)}>
                <option value="">Auto-classify</option>
                {SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
              </Select>
            </Field>
            <Field label="Exchange (override)">
              <Select name="exchange" value={exchange} onChange={(e) => setExchange(e.target.value)}>
                <option value="">Auto</option>
                {EXCHANGES.map((x) => <option key={x} value={x}>{x}</option>)}
              </Select>
            </Field>
          </>
        ) : (
          <>
            <Field label="Underlying / ticker">
              <Input value={underlying} onChange={(e) => setUnderlying(e.target.value)} placeholder="NIFTY, BANKNIFTY, RELIANCE, CRUDEOIL…" />
            </Field>
            <Field label="Contract">
              <Select value={contractType} onChange={(e) => setContractType(e.target.value as "option" | "future")}>
                <option value="option">Option</option>
                <option value="future">Future</option>
              </Select>
            </Field>
            <Field label="Direction">
              <Select value={direction} onChange={(e) => setDirection(e.target.value as "buy" | "sell")}>
                <option value="buy">Buy (long)</option>
                <option value="sell">Sell / write (short)</option>
              </Select>
            </Field>
            <Field label="Expiry">
              <div className="flex items-center gap-2">
                <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
                {dte != null && (
                  <span className={`shrink-0 rounded px-1.5 py-1 text-[10px] font-medium ${dte <= 3 ? "bg-loss/15 text-loss" : dte <= 7 ? "bg-warning/15 text-warning" : "bg-card-hover text-muted-foreground"}`}>
                    {dte < 0 ? "expired" : `${dte}d`}
                  </span>
                )}
              </div>
            </Field>
            {contractType === "option" && (
              <>
                <Field label="Strike">
                  <Input type="number" step="any" value={strike} onChange={(e) => setStrike(e.target.value)} />
                </Field>
                <Field label="Option type">
                  <Select value={optType} onChange={(e) => setOptType(e.target.value as "CE" | "PE")}>
                    <option value="CE">CE (Call)</option>
                    <option value="PE">PE (Put)</option>
                  </Select>
                </Field>
              </>
            )}
            <Field label="Lot size">
              <Input type="number" step="any" value={lotSize} onChange={(e) => setLotSize(e.target.value)} placeholder="e.g. 75" />
            </Field>
            <Field label={`Lots${fnoQty > 0 ? ` (= ${fnoQty} qty)` : ""}`}>
              <Input type="number" step="1" value={lots} onChange={(e) => setLots(e.target.value)} />
            </Field>
            <Field label="Entry premium">
              <Input type="number" step="any" value={entryPremium} onChange={(e) => setEntryPremium(e.target.value)} />
            </Field>
            {!open && (
              <Field label="Exit premium">
                <Input type="number" step="any" value={exitPremium} onChange={(e) => setExitPremium(e.target.value)} placeholder="blank = still open" />
              </Field>
            )}
            <input type="hidden" name="tradingsymbol" value={tradingsymbol} />
            <input type="hidden" name="lotSize" value={lotSize} />
            {tradingsymbol && <Field label="Constructed contract" className="col-span-2 sm:col-span-3"><Input value={tradingsymbol} readOnly className="font-mono text-xs text-muted-foreground" /></Field>}
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {kind === "equity" && (
          <>
            <Field label={open ? "Quantity" : "Buy qty"}><Input name="buyQty" type="number" step="any" value={buyQty} onChange={(e) => setBuyQty(e.target.value)} /></Field>
            <Field label={open ? "Entry price" : "Avg buy price"}><Input name="avgBuyPrice" type="number" step="any" value={avgBuyPrice} onChange={(e) => setBuyPrice(e.target.value)} /></Field>
          </>
        )}
        {open ? (
          <Field label="Current price (MTM)"><Input name="currentPrice" type="number" step="any" value={currentPrice} onChange={(e) => setCurrentPrice(e.target.value)} /></Field>
        ) : kind === "equity" ? (
          <>
            <Field label="Sell qty"><Input name="sellQty" type="number" step="any" value={sellQty} onChange={(e) => setSellQty(e.target.value)} /></Field>
            <Field label="Avg sell price"><Input name="avgSellPrice" type="number" step="any" value={avgSellPrice} onChange={(e) => setSellPrice(e.target.value)} /></Field>
          </>
        ) : null}
        {kind === "fno" && (
          // Hidden mirrors of the qty/price state the F&O fields already computed above,
          // so the server reads the same buyQty/avgBuyPrice/sellQty/avgSellPrice names.
          <>
            <input type="hidden" name="buyQty" value={buyQty} />
            <input type="hidden" name="avgBuyPrice" value={avgBuyPrice} />
            <input type="hidden" name="sellQty" value={sellQty} />
            <input type="hidden" name="avgSellPrice" value={avgSellPrice} />
          </>
        )}
        <Field label={open ? "Entry date" : kind === "fno" ? "Entry date" : "Buy date"}><Input name="buyDate" type="date" /></Field>
        {!open && <Field label={kind === "fno" ? "Exit date" : "Sell date"}><Input name="sellDate" type="date" /></Field>}
        <Field label="SL (original)"><Input name="slPlanned" type="number" step="any" value={sl} onChange={(e) => setSl(e.target.value)} /></Field>
        <Field label="Trailing SL"><Input name="trailingSl" type="number" step="any" /></Field>
        <Field label="Target"><Input name="targetPlanned" type="number" step="any" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
        <Field label="Risk amount (₹)">
          <Input
            name="riskAmount"
            type="number"
            step="any"
            value={riskAmount}
            onChange={(e) => { setRiskAmount(e.target.value); setRiskTouched(e.target.value !== ""); }}
            placeholder="from SL, else 9500"
          />
        </Field>
        <Field label={kind === "fno" ? "Strategy" : "Setup tag"}><Input name="setupTag" placeholder={kind === "fno" ? "e.g. Iron condor, ORB" : "e.g. ORB, pullback"} /></Field>
        {!isMtf ? null : (
          <>
            <Field label="Own capital used (₹)">
              <Input
                name="ownCapitalUsed"
                type="number"
                step="any"
                value={ownCapitalUsed}
                onChange={(e) => setOwnCapitalUsed(e.target.value)}
                placeholder={mtfDefaultOwnCapital > 0 ? `≈ ${Math.round(mtfDefaultOwnCapital).toLocaleString("en-IN")} auto` : "auto-estimated"}
              />
            </Field>
            <Field label="Broker funds (₹)">
              {/* Bidirectional: type EITHER side of the split and the other
                  derives — value − funded = own, value − own = funded. */}
              <Input
                type="number"
                step="any"
                value={positionValue > 0 ? String(Math.round(mtfEffectiveFunded)) : ""}
                onChange={(e) => {
                  const funded = Number(e.target.value);
                  if (positionValue > 0 && Number.isFinite(funded)) {
                    setOwnCapitalUsed(String(Math.max(0, Math.round((positionValue - funded) * 100) / 100)));
                  }
                }}
                placeholder="derived from own capital"
              />
            </Field>
            {!open && (
              <Field label="Days held so far (MTF)">
                <Input name="daysHeld" type="number" step="any" value={daysHeld} onChange={(e) => setDaysHeld(e.target.value)} />
              </Field>
            )}
            {/* The margin RATE gets its own full-width line, because which rate
                was used and where it came from is the question a trader asks
                first. A per-stock hit names the stock and its list; only a
                genuine fallback shows the generic rate — the old copy quoted
                "25%" even when a real per-stock margin had been resolved. */}
            <div className="col-span-2 rounded-md border border-border bg-card-hover/30 p-2.5 sm:col-span-4">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <span className="text-muted-foreground">Own margin</span>
                <span className="font-mono text-sm font-semibold tabular-nums text-primary">{mtfEffectivePct}%</span>
                {mtfStockInfo ? (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                    {symbolForMtf} · {BROKER_LABELS[broker as never] ?? broker} list
                  </span>
                ) : symbolForMtf.length >= 2 ? (
                  <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
                    {symbolForMtf} not on {BROKER_LABELS[broker as never] ?? broker}&apos;s MTF list — fallback rate
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground">enter the symbol for its exact broker rate</span>
                )}
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {positionValue > 0
                  ? `You ₹${Math.round(mtfEffectiveOwnCapital).toLocaleString("en-IN")} + broker ₹${Math.round(mtfEffectiveFunded).toLocaleString("en-IN")}${mtfLeverage != null ? ` · ${mtfLeverage.toFixed(2)}x leverage` : ""} — interest accrues on the broker's share only. `
                  : "Enter buy price and quantity and the split fills itself. "}
                {mtfStockInfo ? mtfStockInfo.label : "Source: Settings → Margin (no per-stock entry matched)."}
              </p>
            </div>
          </>
        )}
        <Field label="Notes" className="col-span-2 sm:col-span-4"><Input name="notes" placeholder="optional" /></Field>
      </div>

      {/* Live charge preview */}
      {preview && (
        <div className="rounded-md border border-border bg-card-hover/30 p-3 text-xs">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Auto-classified:</span>
            <span className="font-medium">{SEGMENT_LABELS[preview.classification.segment]}</span>
            <span className="text-muted-foreground">· {preview.classification.bucket} · {preview.classification.exchange}</span>
            {preview.classification.optionType && <span className="text-muted-foreground">· {preview.classification.optionType}</span>}
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-1 sm:grid-cols-4">
            <Cell k="Brokerage" v={preview.breakdown.brokerage} />
            <Cell k="STT/CTT" v={preview.breakdown.sttCtt} />
            <Cell k="Exchange" v={preview.breakdown.exchangeTxn} />
            <Cell k="Stamp" v={preview.breakdown.stampDuty} />
            <Cell k="GST" v={preview.breakdown.gst} />
            <Cell k="DP" v={preview.breakdown.dpCharges} />
            {preview.breakdown.mtfInterest > 0 && <Cell k="MTF int." v={preview.breakdown.mtfInterest} />}
            {preview.breakdown.pledgeCharges > 0 && <Cell k="Pledge" v={preview.breakdown.pledgeCharges} />}
            <Cell k="Total charges" v={preview.breakdown.total} strong />
          </div>
          {open ? (
            <>
              {/* Open trades have no exit leg yet, so "Gross/Net" would always read
                  ₹0 / a charges-only loss — misleading when the position is actually
                  up. Show entry-side cost plainly, and unrealized P&L (at the entered
                  current price) as a clearly separate, informational figure. */}
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

      {/* Pre-trade limits verdict (open trades) */}
      {open && limit && <LimitVerdict result={limit} />}

      {/* Chart screenshots need a trade id to attach to, so the picker itself
          can only appear after the save. Announce it HERE anyway: testers had
          no way to know the feature existed, because the only mention lived on
          a screen you reach by saving first. */}
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-[0.6875rem] text-muted-foreground">
        <Paperclip className="size-3.5 shrink-0" />
        <span>
          <b className="text-foreground">Chart screenshots:</b> attach them on the next step, right after you save
          this trade — or any time later from the trade&apos;s journal.
        </span>
      </div>

      <DialogFooter>
        {blocked && <span className="mr-auto text-xs text-loss">Limit breached — you stay in control; saving records the breach on your Discipline scorecard.</span>}
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        {/* Limits are advisory — the trader always has final say. A breach flips
            the button to an explicit override (recorded in rule_violations and
            on the Discipline scorecard) but never disables saving. */}
        <Button type="submit" disabled={pending} variant={blocked ? "destructive" : "default"}>
          {pending ? "Saving…" : blocked ? "Override & add anyway" : open ? "Add open trade" : "Add trade"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Cell({ k, v, strong }: { k: string; v: number; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={`tabular-nums ${strong ? "font-semibold" : ""}`}>{inr(v)}</span>
    </div>
  );
}
