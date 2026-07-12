"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { computeTradeCalc, type Side } from "@/lib/analytics/trade-calc";
import type { ChargeRates } from "@/lib/engine/types";
import { formatPaise } from "@/lib/money";
import { defaultMtfFundedAmount, DEFAULT_MTF_OWN_MARGIN_PCT } from "@/lib/risk/margin";
import { AlertCircle } from "lucide-react";

const selectCls =
  "h-8 rounded-md border border-border bg-input px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const EQUITY_PRODUCTS = [
  { v: "eq_delivery", label: "Delivery" },
  { v: "eq_intraday", label: "Intraday" },
  { v: "eq_mtf", label: "MTF (margin funding)" },
];
const FNO_INSTRUMENTS = [
  { v: "stock_option", label: "Stock Option" },
  { v: "index_option", label: "Index Option" },
  { v: "future", label: "Future" },
  { v: "commodity_future", label: "Commodity Future" },
  { v: "commodity_option", label: "Commodity Option" },
];

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function TradeCalculator({
  rates,
  mtfMarginByBroker = {},
}: {
  rates: Record<string, ChargeRates>;
  mtfMarginByBroker?: Record<string, number>;
}) {
  const [mode, setMode] = useState<"equity" | "fno">("equity");
  const [broker, setBroker] = useState("dhan");
  const mtfOwnMarginPct = mtfMarginByBroker[broker] ?? DEFAULT_MTF_OWN_MARGIN_PCT;
  const [product, setProduct] = useState("eq_delivery");
  const [instrument, setInstrument] = useState("index_option");
  const [exchange, setExchange] = useState("NSE");
  const [side, setSide] = useState<Side>("long");
  const [ticker, setTicker] = useState("");
  const [shares, setShares] = useState("100");
  const [lots, setLots] = useState("1");
  const [lotSize, setLotSize] = useState("75");
  const [entry, setEntry] = useState("100");
  const [sl, setSl] = useState("90");
  const [target, setTarget] = useState("130");
  const [ownCapital, setOwnCapital] = useState("0");
  const [holdDays, setHoldDays] = useState("30");
  const [numTrades, setNumTrades] = useState("1");

  const segment = mode === "equity" ? product : instrument;
  const effExchange = segment.startsWith("commodity") ? "MCX" : exchange;
  const qty = mode === "equity" ? num(shares) : num(lots) * num(lotSize);
  const rateCard = rates[`${broker}|${segment}|${effExchange}`];

  const result = useMemo(() => {
    if (!rateCard || qty <= 0 || num(entry) <= 0) return null;
    // Own capital (what YOU put in) is the primary input; funded = position value
    // − that. 0 (unset) auto-estimates own capital from the configured own-margin
    // % — treating the FULL position as broker-financed overstates interest (see
    // lib/risk/margin.ts#defaultMtfFundedAmount).
    const positionValue = num(entry) * qty;
    const fundedAmount = num(ownCapital) > 0 ? Math.max(0, positionValue - num(ownCapital)) : defaultMtfFundedAmount(positionValue, mtfOwnMarginPct);
    return computeTradeCalc(
      {
        segment: segment as ChargeRates["segment"],
        side,
        entry: num(entry),
        sl: num(sl),
        target: num(target),
        qty,
        mtf: segment === "eq_mtf" ? { fundedAmount, daysHeld: num(holdDays) } : null,
        numTrades: num(numTrades),
      },
      rateCard,
    );
  }, [rateCard, segment, side, entry, sl, target, qty, ownCapital, holdDays, numTrades, mtfOwnMarginPct]);

  const breakdown = result
    ? ([
        ["Brokerage", result.target.charges.brokerage],
        ["STT / CTT", result.target.charges.sttCtt],
        ["Exchange txn", result.target.charges.exchangeTxn],
        ["SEBI", result.target.charges.sebi],
        ["Stamp duty", result.target.charges.stampDuty],
        ["IPFT", result.target.charges.ipft],
        ["GST", result.target.charges.gst],
        ["DP charges", result.target.charges.dpCharges],
        ["MTF interest", result.target.charges.mtfInterest],
      ] as const).filter(([, v]) => v > 0)
    : [];

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      {/* ---------------- Inputs ---------------- */}
      <Card>
        <CardHeader><CardTitle>Trade</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-1.5">
            {(["equity", "fno"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setExchange("NSE"); }}
                className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium ${mode === m ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground"}`}
              >
                {m === "equity" ? "Equity" : "F&O"}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Broker">
              <select value={broker} onChange={(e) => setBroker(e.target.value)} className={selectCls}>
                <option value="dhan">Dhan</option>
                <option value="zerodha">Zerodha</option>
                <option value="groww">Groww</option>
              </select>
            </Field>
            <Field label={mode === "equity" ? "Product" : "Instrument"}>
              {mode === "equity" ? (
                <select value={product} onChange={(e) => setProduct(e.target.value)} className={selectCls}>
                  {EQUITY_PRODUCTS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
                </select>
              ) : (
                <select value={instrument} onChange={(e) => setInstrument(e.target.value)} className={selectCls}>
                  {FNO_INSTRUMENTS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
                </select>
              )}
            </Field>
            <Field label="Exchange">
              <select value={effExchange} onChange={(e) => setExchange(e.target.value)} disabled={segment.startsWith("commodity")} className={selectCls}>
                <option value="NSE">NSE</option>
                <option value="BSE">BSE</option>
                <option value="MCX">MCX</option>
              </select>
            </Field>
            <Field label="Side">
              <select value={side} onChange={(e) => setSide(e.target.value as Side)} className={selectCls}>
                <option value="long">Buy (long)</option>
                <option value="short">Sell (short)</option>
              </select>
            </Field>
          </div>

          <Field label="Ticker (optional)">
            <Input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="RELIANCE / NIFTY" className="h-8" />
          </Field>

          {mode === "equity" ? (
            <Field label="Quantity (shares)">
              <Input type="number" value={shares} onChange={(e) => setShares(e.target.value)} className="h-8 tabular-nums" />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Lots"><Input type="number" value={lots} onChange={(e) => setLots(e.target.value)} className="h-8 tabular-nums" /></Field>
              <Field label="Lot size"><Input type="number" value={lotSize} onChange={(e) => setLotSize(e.target.value)} className="h-8 tabular-nums" /></Field>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <Field label={mode === "fno" ? "Entry (premium)" : "Entry ₹"}><Input type="number" value={entry} onChange={(e) => setEntry(e.target.value)} className="h-8 tabular-nums" /></Field>
            <Field label="Stop-loss ₹"><Input type="number" value={sl} onChange={(e) => setSl(e.target.value)} className="h-8 tabular-nums" /></Field>
            <Field label="Target ₹"><Input type="number" value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 tabular-nums" /></Field>
          </div>

          {segment === "eq_mtf" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label={`Own capital ₹ (0 = auto @ ${mtfOwnMarginPct}% margin)`}>
                <Input type="number" value={ownCapital} onChange={(e) => setOwnCapital(e.target.value)} className="h-8 tabular-nums" />
              </Field>
              <Field label="Holding days"><Input type="number" value={holdDays} onChange={(e) => setHoldDays(e.target.value)} className="h-8 tabular-nums" /></Field>
            </div>
          )}

          <Field label="Number of trades (project across N)">
            <Input type="number" value={numTrades} onChange={(e) => setNumTrades(e.target.value)} className="h-8 tabular-nums" />
          </Field>
          <p className="text-[10px] text-muted-foreground">
            {mode === "fno" ? `Quantity = ${num(lots)} lot × ${num(lotSize)} = ${qty}. ` : ""}
            Charges use {broker} {effExchange} {segment} rates from charge config.
            {segment === "eq_mtf" ? ` Own capital ₹ is what YOU put in — the broker funds the rest; 0 auto-estimates it at your configured ${mtfOwnMarginPct}% own-margin rate (Settings → Margin).` : ""}
          </p>
        </CardContent>
      </Card>

      {/* ---------------- Results ---------------- */}
      <div className="space-y-4">
        {!rateCard ? (
          <Card><CardContent className="flex items-center gap-2 p-6 text-sm text-loss"><AlertCircle className="size-4" /> No rate card for {broker} · {segment} · {effExchange}. Add it in Settings → charge config.</CardContent></Card>
        ) : !result ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">Enter a positive entry price and quantity.</CardContent></Card>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label="Round-trip charges" value={formatPaise(result.chargesPerTradePaise, { decimals: 0 })} tone="text-loss" sub={`${result.chargesPctOfTurnover}% of turnover`} />
              <Kpi label="Net @ target" value={formatPaise(result.rewardPaise, { decimals: 0 })} tone={result.rewardPaise >= 0 ? "text-profit" : "text-loss"} sub={`gross ${formatPaise(result.target.grossPaise, { decimals: 0 })}`} />
              <Kpi label="Net @ SL" value={formatPaise(result.riskPaise, { decimals: 0 })} tone={result.riskPaise >= 0 ? "text-profit" : "text-loss"} sub={`gross ${formatPaise(result.sl.grossPaise, { decimals: 0 })}`} />
              <Kpi label="Reward : risk" value={result.rrNet == null ? "—" : `${result.rrNet}:1`} sub={`gross ${result.rrGross ?? "—"}:1 · BE ${result.breakevenPrice}`} />
            </section>

            <Card className="p-0">
              <CardHeader><CardTitle>Charge breakdown — one round trip (exit at target)</CardTitle></CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-xs">
                  <tbody>
                    {breakdown.map(([label, v]) => (
                      <tr key={label} className="border-b border-border/40">
                        <td className="px-3 py-1.5 text-muted-foreground">{label}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatPaise(v, { decimals: 0 })}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-border">
                      <td className="px-3 py-2 font-semibold">Total charges</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-loss">{formatPaise(result.chargesPerTradePaise, { decimals: 0 })}</td>
                    </tr>
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Across {result.numTrades} trade{result.numTrades === 1 ? "" : "s"}</CardTitle>
                <Badge variant="secondary">{ticker || segment}</Badge>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Kpi label="Total charges" value={formatPaise(result.totalChargesPaise, { decimals: 0 })} tone="text-loss" sub={`STT ${formatPaise(result.totalSttPaise, { decimals: 0 })}`} />
                  <Kpi label="If all hit target" value={formatPaise(result.totalNetTargetPaise, { decimals: 0 })} tone={result.totalNetTargetPaise >= 0 ? "text-profit" : "text-loss"} sub="net P&L" />
                  <Kpi label="If all hit SL" value={formatPaise(result.totalNetSlPaise, { decimals: 0 })} tone={result.totalNetSlPaise >= 0 ? "text-profit" : "text-loss"} sub="net P&L" />
                  <Kpi label="Charges / trade" value={formatPaise(result.chargesPerTradePaise, { decimals: 0 })} sub="round trip" />
                </div>
              </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground">
              Exact charges from the same engine that books your trades (statutory STT/stamp rounded to the rupee, GST 18%
              on brokerage+exchange+SEBI+IPFT). The two scenarios re-price the sell leg at target vs SL, so STT differs
              slightly between them. Edit any rate in Settings → charge config to model a different plan or a rate change.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      {sub ? <div className="text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
