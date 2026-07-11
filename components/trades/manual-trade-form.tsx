"use client";

import { useActionState, useEffect, useState } from "react";
import { createManualTrade, type ActionState } from "@/app/trades/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { inr } from "@/lib/format";
import { BROKERS, BROKER_LABELS, SEGMENTS, SEGMENT_LABELS, EXCHANGES, type Segment } from "@/lib/domain/constants";
import { LimitVerdict } from "@/components/risk/limit-verdict";
import type { LimitResult } from "@/lib/risk/limits";
import { CheckCircle2, AlertCircle } from "lucide-react";

interface PreviewResp {
  classification: { segment: Segment; bucket: string; exchange: string; symbol: string; optionType: string | null };
  breakdown: { brokerage: number; sttCtt: number; exchangeTxn: number; sebi: number; stampDuty: number; gst: number; dpCharges: number; mtfInterest: number; total: number };
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

export function ManualTradeForm({ onDone, mode = "closed" }: { onDone?: () => void; mode?: "open" | "closed" }) {
  const open = mode === "open";
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createManualTrade, { ok: false, message: "" });

  const [kind, setKind] = useState<"equity" | "fno">("equity");
  const [broker, setBroker] = useState("dhan");
  const [tradingsymbol, setSymbol] = useState("");
  const [productHint, setProductHint] = useState("");
  const [segment, setSegment] = useState("");
  const [exchange, setExchange] = useState("");
  const [buyQty, setBuyQty] = useState("");
  const [avgBuyPrice, setBuyPrice] = useState("");
  const [sellQty, setSellQty] = useState("");
  const [avgSellPrice, setSellPrice] = useState("");
  const [currentPrice, setCurrentPrice] = useState("");
  const [sl, setSl] = useState("");
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
    if (state.ok && onDone) onDone();
  }, [state.ok, onDone]);

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
          }),
        });
        if (res.ok) setPreview(await res.json());
      } catch { /* aborted */ }
    }, 300);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [broker, tradingsymbol, productHint, segment, exchange, buyQty, avgBuyPrice, sellQty, avgSellPrice]);

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

  const isEquity = kind === "equity" && (preview?.classification.segment.startsWith("eq_") ?? true);
  const blocked = open && limit?.status === "block";
  const dte = kind === "fno" && expiry ? daysBetween(new Date().toISOString().slice(0, 10), expiry) : null;
  const fnoQty = (Number(lots) || 0) * (Number(lotSize) || 0);

  return (
    <form action={formAction} className="space-y-4">
      {open && <input type="hidden" name="open" value="true" />}
      <input type="hidden" name="direction" value={kind === "fno" ? direction : "buy"} />

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
        <Field label="Target"><Input name="targetPlanned" type="number" step="any" /></Field>
        <Field label="Risk amount (₹)"><Input name="riskAmount" type="number" step="any" placeholder="from SL, else 9500" /></Field>
        <Field label={kind === "fno" ? "Strategy" : "Setup tag"}><Input name="setupTag" placeholder={kind === "fno" ? "e.g. Iron condor, ORB" : "e.g. ORB, pullback"} /></Field>
        {!isEquity ? null : (
          <>
            <Field label="MTF funded (₹)"><Input name="fundedAmount" type="number" step="any" /></Field>
            <Field label="Days held (MTF)"><Input name="daysHeld" type="number" step="any" /></Field>
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
            <Cell k="Total charges" v={preview.breakdown.total} strong />
          </div>
          <div className="mt-2 flex gap-6 border-t border-border pt-2">
            <span className="text-muted-foreground">Gross: <span className="font-medium text-foreground">{inr(preview.grossPnl)}</span></span>
            <span className="text-muted-foreground">Net: <span className={`font-semibold ${preview.netPnl >= 0 ? "text-profit" : "text-loss"}`}>{inr(preview.netPnl)}</span></span>
          </div>
        </div>
      )}

      {/* Pre-trade limits verdict (open trades) */}
      {open && limit && <LimitVerdict result={limit} />}

      <div className="flex items-center gap-3">
        {/* Limits are advisory — the trader always has final say. A breach flips
            the button to an explicit override (recorded in rule_violations and
            on the Discipline scorecard) but never disables saving. */}
        <Button type="submit" disabled={pending} variant={blocked ? "destructive" : "default"}>
          {pending ? "Saving…" : blocked ? "Override & add anyway" : open ? "Add open trade" : "Add trade"}
        </Button>
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        {blocked && <span className="text-xs text-loss">Limit breached — you stay in control; saving records the breach on your Discipline scorecard.</span>}
        {state.message && (
          <span className={`flex items-center gap-1.5 text-sm ${state.ok ? "text-profit" : "text-loss"}`}>
            {state.ok ? <CheckCircle2 className="size-4" /> : <AlertCircle className="size-4" />}
            {state.message}
          </span>
        )}
      </div>
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
