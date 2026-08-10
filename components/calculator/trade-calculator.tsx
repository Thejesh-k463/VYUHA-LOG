"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  computeTradeCalc,
  marginForTrade,
  solveTargetForNetRR,
  type Side,
} from "@/lib/analytics/trade-calc";
import type { ChargeRates } from "@/lib/engine/types";
import { BROKERS, BROKER_LABELS, type OptionType, type Segment } from "@/lib/domain/constants";
import { formatPaise } from "@/lib/money";
import { inr } from "@/lib/format";
import { optionLotSize, positionSize } from "@/lib/risk/calculators";
import { defaultMtfFundedAmount, DEFAULT_MTF_OWN_MARGIN_PCT } from "@/lib/risk/margin";
import { AlertCircle, Info } from "lucide-react";
import {
  CALC_SNAPSHOT_KEY,
  parseCalcSnapshot,
  type CalcBranchShared,
  type CalcEquityBranch,
  type CalcFnoBranch,
  type CalcSnapshot,
} from "@/lib/domain/calc-snapshot";
import { writeStored } from "@/components/layout/use-stored-value";
import { INDEX_CONTRACTS, INDEX_LOTS_AS_OF, resolveIndexLot } from "@/lib/domain/index-contracts";

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
const OPTION_SEGMENTS = new Set(["index_option", "stock_option", "commodity_option"]);

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** A positive number, or null — never a fabricated 0 standing in for "unknown". */
const posOrNull = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The per-stock MTF resolution as the API hands it back. `label` is produced
 * server-side by `mtfSourceLabel()` (lib/risk/mtf-margins) — deliberately NOT
 * imported here, because that module carries the 828 KB bundled scrip list and
 * importing it into a client component would ship all of it to the browser.
 */
interface MtfStockInfo {
  pct: number;
  label: string;
  source: string;
  symbol: string;
}
/** Sources that are NOT this stock's own published margin — a fallback. */
const FALLBACK_SOURCES = new Set(["broker-rule", "margin-config", "default"]);

export function TradeCalculator({
  rates,
  mtfMarginByBroker = {},
  marginRates = {},
  indexLots = {},
}: {
  rates: Record<string, ChargeRates>;
  mtfMarginByBroker?: Record<string, number>;
  /** "broker|segment" → margin %, from margin_config (see lib/risk/margin.ts). */
  marginRates?: Record<string, number>;
  /** Index underlying → market lot from the instruments table (the user's own
   *  fo_mktlots.csv upload). Beats the bundled snapshot when present. */
  indexLots?: Record<string, { lotSize: number; asOf: string }>;
}) {
  const [mode, setMode] = useState<"equity" | "fno">("equity");
  const [broker, setBroker] = useState("dhan");
  // Most accounts are on no plan at all, so "default" — the free tier — is
  // where the calculator starts, whatever paid tiers a broker also sells.
  const [plan, setPlan] = useState("default");
  const brokerMtfPct = mtfMarginByBroker[broker] ?? DEFAULT_MTF_OWN_MARGIN_PCT;
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
  // Contract detail — a short option's margin is a % of the UNDERLYING, so
  // without one of these it cannot be computed at all (see marginForTrade).
  const [optionType, setOptionType] = useState<OptionType>("CE");
  const [strike, setStrike] = useState("");
  const [spot, setSpot] = useState("");
  // Position sizing + reverse solve are OPT-IN: they suggest, and only write
  // into the quantity/target fields when the user presses Apply.
  const [riskBudget, setRiskBudget] = useState("");
  const [desiredRR, setDesiredRR] = useState("2");
  const [mtfStock, setMtfStock] = useState<MtfStockInfo | null>(null);

  // ── Per-mode persistence ────────────────────────────────────────────────
  // One envelope, two branches (lib/domain/calc-snapshot.ts). Equity and F&O
  // each remember their own inputs; broker/plan/mode are shared facts about
  // the user, not the trade. Every save happens in an event handler or a
  // debounced no-setState effect; the one restore is the deferred mount-restore
  // idiom the sidebar uses.
  const collectEquity = useCallback(
    (): CalcEquityBranch => ({ side, ticker, exchange: exchange as CalcBranchShared["exchange"], entry, sl, target, numTrades, riskBudget, desiredRR, product: product as CalcEquityBranch["product"], shares, ownCapital, holdDays }),
    [side, ticker, exchange, entry, sl, target, numTrades, riskBudget, desiredRR, product, shares, ownCapital, holdDays],
  );
  const collectFno = useCallback(
    (): CalcFnoBranch => ({ side, ticker, exchange: exchange as CalcBranchShared["exchange"], entry, sl, target, numTrades, riskBudget, desiredRR, instrument: instrument as CalcFnoBranch["instrument"], lots, lotSize, optionType, strike, spot }),
    [side, ticker, exchange, entry, sl, target, numTrades, riskBudget, desiredRR, instrument, lots, lotSize, optionType, strike, spot],
  );

  const applyShared = (b: CalcBranchShared) => {
    if (b.side !== undefined) setSide(b.side);
    if (b.ticker !== undefined) setTicker(b.ticker);
    if (b.exchange !== undefined) setExchange(b.exchange);
    if (b.entry !== undefined) setEntry(b.entry);
    if (b.sl !== undefined) setSl(b.sl);
    if (b.target !== undefined) setTarget(b.target);
    if (b.numTrades !== undefined) setNumTrades(b.numTrades);
    if (b.riskBudget !== undefined) setRiskBudget(b.riskBudget);
    if (b.desiredRR !== undefined) setDesiredRR(b.desiredRR);
  };
  const applyEquity = (b: CalcEquityBranch) => {
    applyShared(b);
    if (b.product !== undefined) setProduct(b.product);
    if (b.shares !== undefined) setShares(b.shares);
    if (b.ownCapital !== undefined) setOwnCapital(b.ownCapital);
    if (b.holdDays !== undefined) setHoldDays(b.holdDays);
  };
  const applyFno = (b: CalcFnoBranch) => {
    applyShared(b);
    if (b.instrument !== undefined) setInstrument(b.instrument);
    if (b.lots !== undefined) setLots(b.lots);
    if (b.lotSize !== undefined) setLotSize(b.lotSize);
    if (b.optionType !== undefined) setOptionType(b.optionType);
    if (b.strike !== undefined) setStrike(b.strike);
    if (b.spot !== undefined) setSpot(b.spot);
  };

  const switchMode = (m: "equity" | "fno") => {
    if (m === mode) return;
    // Save the branch being LEFT synchronously — the debounced write below may
    // not have fired yet, and its pending timeout carries the old values.
    const prev = parseCalcSnapshot(localStorage.getItem(CALC_SNAPSHOT_KEY));
    const next: CalcSnapshot = {
      v: 1,
      mode: m,
      broker: broker as CalcSnapshot["broker"],
      plan,
      equity: mode === "equity" ? collectEquity() : (prev?.equity ?? {}),
      fno: mode === "fno" ? collectFno() : (prev?.fno ?? {}),
    };
    writeStored(CALC_SNAPSHOT_KEY, JSON.stringify(next));
    setMode(m);
    // Restore the branch being entered. Deliberately NOT the old
    // setExchange("NSE") reset: a stored F&O exchange of BSE (Sensex) must
    // survive the toggle. A branch never visited inherits the leaving mode's
    // shared fields unchanged — except exchange, which falls back to NSE so an
    // MCX commodity selection cannot leak into an equity book.
    const target = m === "equity" ? next.equity : next.fno;
    if (m === "equity") applyEquity(next.equity);
    else applyFno(next.fno);
    if (target.exchange === undefined) setExchange("NSE");
  };

  // One-shot restore after hydration (deferred like the sidebar's collapse
  // flag; SSR paints defaults, the microtask applies the stored branch).
  useEffect(() => {
    const snap = parseCalcSnapshot(localStorage.getItem(CALC_SNAPSHOT_KEY));
    if (!snap) return;
    Promise.resolve().then(() => {
      if (snap.broker !== undefined) setBroker(snap.broker);
      if (snap.plan !== undefined) setPlan(snap.plan);
      const m = snap.mode ?? "equity";
      setMode(m);
      if (m === "equity") applyEquity(snap.equity);
      else applyFno(snap.fno);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only restore
  }, []);

  // Cross-session capture: persist the ACTIVE branch as the user types, so a
  // reload without ever toggling still restores. No setState in here.
  useEffect(() => {
    const id = setTimeout(() => {
      const prev = parseCalcSnapshot(localStorage.getItem(CALC_SNAPSHOT_KEY));
      const next: CalcSnapshot = {
        v: 1,
        mode,
        broker: broker as CalcSnapshot["broker"],
        plan,
        equity: mode === "equity" ? collectEquity() : (prev?.equity ?? {}),
        fno: mode === "fno" ? collectFno() : (prev?.fno ?? {}),
      };
      writeStored(CALC_SNAPSHOT_KEY, JSON.stringify(next));
    }, 400);
    return () => clearTimeout(id);
  }, [mode, broker, plan, collectEquity, collectFno]);

  const segment = (mode === "equity" ? product : instrument) as Segment;
  const isEquity = mode === "equity";
  const isOptionSeg = OPTION_SEGMENTS.has(segment);
  const effOptionType: OptionType | null = isOptionSeg ? optionType : null;
  const effExchange = segment.startsWith("commodity") ? "MCX" : exchange;
  const qty = isEquity ? num(shares) : num(lots) * num(lotSize);
  const symbol = ticker.trim().toUpperCase();

  // ── Index underlying picker ─────────────────────────────────────────────
  // DERIVED from the ticker, not separate state: the picker simply writes the
  // underlying's symbol into the ticker field, so per-mode persistence (the
  // snapshot stores ticker) and "Custom = type anything" both come for free.
  const selectedContract = !isEquity ? (INDEX_CONTRACTS.find((c) => c.symbol === symbol) ?? null) : null;
  const resolvedLot = selectedContract
    ? resolveIndexLot(selectedContract.symbol, indexLots[selectedContract.symbol] ?? null)
    : null;
  const pickUnderlying = (sym: string) => {
    if (!sym) {
      setTicker("");
      return;
    }
    const c = INDEX_CONTRACTS.find((x) => x.symbol === sym);
    if (!c) return;
    const r = resolveIndexLot(c.symbol, indexLots[c.symbol] ?? null);
    setTicker(c.symbol);
    setLotSize(String(r.lot));
    // The index's HOME exchange — Sensex/Bankex trade on BSE (classify.ts
    // routes them the same way). If the broker has no BSE rate card the
    // results pane already says so, with the remedy.
    setExchange(c.exchange);
  };
  const showUnderlyingPicker = !isEquity && (instrument === "index_option" || instrument === "future");

  /** The plans this broker actually sells, free tier first. */
  const brokerPlans = useMemo(() => {
    const seen = new Map<string, string | null>();
    for (const [k, r] of Object.entries(rates)) {
      if (k.startsWith(`${broker}|`) && !seen.has(r.plan)) seen.set(r.plan, r.planLabel);
    }
    return [...seen.entries()].sort((a) => (a[0] === "default" ? -1 : 1));
  }, [rates, broker]);
  const effPlan = brokerPlans.some(([p]) => p === plan) ? plan : "default";
  /** Monthly fee of one of this broker's plans, for the picker's label. */
  const subscriptionOf = (p: string) =>
    rates[`${broker}|${p}|eq_delivery|NSE`]?.subscriptionMonthly ?? 0;
  const rateCard = rates[`${broker}|${effPlan}|${segment}|${effExchange}`];

  // ── Per-stock MTF margin ────────────────────────────────────────────────
  // Resolve the ticker's own MTF margin as broker/symbol settle (debounced;
  // the async .then keeps every setState off the synchronous effect path).
  useEffect(() => {
    if (!isEquity || symbol.length < 2) {
      Promise.resolve().then(() => setMtfStock(null));
      return;
    }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/mtf-margin?broker=${broker}&symbol=${encodeURIComponent(symbol)}`, { signal: ctrl.signal });
        const d = await res.json();
        if (d?.ok) setMtfStock({ pct: d.pct, label: d.label, source: d.source, symbol });
      } catch {
        /* keep the broker-level fallback */
      }
    }, 400);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [broker, symbol, isEquity]);

  // A resolution for a DIFFERENT symbol is stale while the user types — never
  // let RELIANCE's margin sit under a half-typed INFY.
  const stockInfo = mtfStock && mtfStock.symbol === symbol ? mtfStock : null;
  /** True when the number on screen is not this stock's own published margin. */
  const mtfIsFallback = stockInfo == null || FALLBACK_SOURCES.has(stockInfo.source);
  const mtfOwnMarginPct = stockInfo ? stockInfo.pct : brokerMtfPct;
  const mtfSourceText = stockInfo
    ? `${stockInfo.label}${FALLBACK_SOURCES.has(stockInfo.source) ? ` — ${symbol} is not on ${BROKER_LABELS[broker as keyof typeof BROKER_LABELS] ?? broker}'s list, so this is a fallback, not the stock's own rate` : ""}`
    : symbol.length >= 2
      ? "broker-level rate (Settings → Margin) — resolving this stock…"
      : "broker-level rate (Settings → Margin) — enter a ticker for this stock's own margin";

  // Own capital (what YOU put in) is the primary input; funded = position value
  // − that. 0 (unset) auto-estimates own capital from the resolved own-margin
  // % — treating the FULL position as broker-financed overstates interest (see
  // lib/risk/margin.ts#defaultMtfFundedAmount).
  const mtfArg = useMemo(() => {
    if (segment !== "eq_mtf") return null;
    const positionValue = num(entry) * qty;
    const fundedAmount = num(ownCapital) > 0
      ? Math.max(0, positionValue - num(ownCapital))
      : defaultMtfFundedAmount(positionValue, mtfOwnMarginPct);
    return { fundedAmount, daysHeld: num(holdDays) };
  }, [segment, entry, qty, ownCapital, holdDays, mtfOwnMarginPct]);

  const result = useMemo(() => {
    if (!rateCard || qty <= 0 || num(entry) <= 0) return null;
    return computeTradeCalc(
      {
        segment,
        side,
        entry: num(entry),
        sl: num(sl),
        target: num(target),
        qty,
        mtf: mtfArg,
        numTrades: num(numTrades),
      },
      rateCard,
    );
  }, [rateCard, segment, side, entry, sl, target, qty, mtfArg, numTrades]);

  // ── (a) Position sizing from a ₹ risk budget ────────────────────────────
  const sizing = useMemo(() => {
    const budget = num(riskBudget);
    const e = num(entry), stop = num(sl), ls = num(lotSize);
    if (!(budget > 0) || !(e > 0) || !(stop > 0) || e === stop) return null;
    if (!isEquity && isOptionSeg) {
      // Options size off the premium, and the answer is in LOTS.
      const r = optionLotSize({ premium: e, stopPremium: stop, lotSize: ls, riskAmount: budget });
      return { lots: r.maxLots, qty: r.maxLots * ls, riskPerUnit: r.riskPerLot, totalRisk: r.totalRisk, capital: r.premiumOutlay, unit: "lot" as const };
    }
    const r = positionSize({ entry: e, stop, riskAmount: budget, lotSize: isEquity ? undefined : ls || undefined });
    return { lots: r.lots, qty: r.maxQty, riskPerUnit: r.riskPerUnit, totalRisk: r.totalRisk, capital: r.capitalRequired, unit: isEquity ? ("share" as const) : ("lot" as const) };
  }, [riskBudget, entry, sl, lotSize, isEquity, isOptionSeg]);

  /** Suggestion → the quantity field. Only ever on an explicit click. */
  const applySize = () => {
    if (!sizing) return;
    if (isEquity) setShares(String(sizing.qty));
    else if (sizing.lots != null) setLots(String(sizing.lots));
  };

  // ── (c) Capital blocked ─────────────────────────────────────────────────
  const marginRateMap = useMemo(() => new Map(Object.entries(marginRates)), [marginRates]);
  const margin = useMemo(
    () =>
      marginForTrade(
        {
          broker,
          segment,
          side,
          qty,
          entry: num(entry),
          symbol: symbol || undefined,
          optionType: effOptionType,
          strike: isOptionSeg ? posOrNull(strike) : null,
          spot: isOptionSeg ? posOrNull(spot) : null,
          mtfStockPct: segment === "eq_mtf" && stockInfo && !mtfIsFallback ? stockInfo.pct : null,
        },
        marginRateMap,
      ),
    [broker, segment, side, qty, entry, symbol, effOptionType, isOptionSeg, strike, spot, stockInfo, mtfIsFallback, marginRateMap],
  );

  // ── (d) Reverse solve: the target that delivers a net R:R ───────────────
  const reverse = useMemo(() => {
    if (!rateCard || qty <= 0 || num(entry) <= 0 || num(sl) <= 0) return null;
    const rr = num(desiredRR);
    if (!(rr > 0)) return null;
    return solveTargetForNetRR(
      { segment, side, entry: num(entry), sl: num(sl), qty, mtf: mtfArg, desiredRR: rr },
      rateCard,
    );
  }, [rateCard, segment, side, entry, sl, qty, mtfArg, desiredRR]);

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
      <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Trade</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-1.5">
            {(["equity", "fno"] as const).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                data-testid={`calc-mode-${m}`}
                className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium ${mode === m ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground"}`}
              >
                {m === "equity" ? "Equity" : "F&O"}
              </button>
            ))}
          </div>

          {brokerPlans.length > 1 && (
            <Field label="Plan">
              <select value={effPlan} onChange={(e) => setPlan(e.target.value)} className={selectCls}>
                {brokerPlans.map(([p, lbl]) => (
                  <option key={p} value={p}>
                    {p === "default" ? "Free plan" : (lbl ?? p)}
                    {subscriptionOf(p) > 0 ? ` — ₹${subscriptionOf(p)}/month` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Field label="Broker">
              {/* Driven by the rate cards themselves — a hard-coded list went
                  stale the moment a broker was added, silently hiding it. */}
              <select value={broker} onChange={(e) => setBroker(e.target.value)} className={selectCls}>
                {BROKERS.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
              </select>
            </Field>
            <Field label={isEquity ? "Product" : "Instrument"}>
              {isEquity ? (
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
              <select value={effExchange} onChange={(e) => setExchange(e.target.value)} disabled={segment.startsWith("commodity")} className={selectCls} data-testid="calc-exchange">
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

          {showUnderlyingPicker && (
            <Field label="Underlying index">
              <select
                value={selectedContract?.symbol ?? ""}
                onChange={(e) => pickUnderlying(e.target.value)}
                className={selectCls}
                data-testid="calc-underlying"
              >
                <option value="">Custom (type a ticker below)</option>
                {INDEX_CONTRACTS.map((c) => (
                  <option key={c.symbol} value={c.symbol}>
                    {c.label} · {c.exchange}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label={isEquity ? "Ticker (drives this stock's MTF margin)" : "Ticker (optional)"}>
            <Input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="RELIANCE / NIFTY" className="h-8" data-testid="calc-ticker" />
          </Field>

          {isOptionSeg && (
            <div className="grid grid-cols-3 gap-2">
              <Field label="Option type">
                <select value={optionType} onChange={(e) => setOptionType(e.target.value as OptionType)} className={selectCls} data-testid="calc-option-type">
                  <option value="CE">CE (call)</option>
                  <option value="PE">PE (put)</option>
                </select>
              </Field>
              <Field label="Strike"><Input type="number" value={strike} onChange={(e) => setStrike(e.target.value)} placeholder="24000" className="h-8 tabular-nums" data-testid="calc-strike" /></Field>
              <Field label="Spot (optional)"><Input type="number" value={spot} onChange={(e) => setSpot(e.target.value)} placeholder="live" className="h-8 tabular-nums" data-testid="calc-spot" /></Field>
            </div>
          )}

          {isEquity ? (
            <Field label="Quantity (shares)">
              <Input type="number" value={shares} onChange={(e) => setShares(e.target.value)} className="h-8 tabular-nums" data-testid="calc-shares" />
            </Field>
          ) : (
            <div className="space-y-1">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Lots"><Input type="number" value={lots} onChange={(e) => setLots(e.target.value)} className="h-8 tabular-nums" data-testid="calc-lots" /></Field>
                <Field label="Lot size"><Input type="number" value={lotSize} onChange={(e) => setLotSize(e.target.value)} className="h-8 tabular-nums" data-testid="calc-lot-size" /></Field>
              </div>
              {selectedContract && resolvedLot && (
                <p className="text-[10px] leading-relaxed text-muted-foreground" data-testid="calc-lot-source">
                  {num(lotSize) === resolvedLot.lot
                    ? resolvedLot.source === "instruments"
                      ? `${selectedContract.label} market lot from your F&O lots upload${resolvedLot.asOf ? ` (as of ${resolvedLot.asOf})` : ""}`
                      : `${selectedContract.label} market lot, bundled ${INDEX_LOTS_AS_OF} snapshot — lots change by exchange circular; upload fo_mktlots.csv on Instruments to stay current`
                    : `manual override — ${selectedContract.label}'s market lot is ${resolvedLot.lot}`}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <Field label={mode === "fno" ? "Entry (premium)" : "Entry ₹"}><Input type="number" value={entry} onChange={(e) => setEntry(e.target.value)} className="h-8 tabular-nums" data-testid="calc-entry" /></Field>
            <Field label="Stop-loss ₹"><Input type="number" value={sl} onChange={(e) => setSl(e.target.value)} className="h-8 tabular-nums" data-testid="calc-sl" /></Field>
            <Field label="Target ₹"><Input type="number" value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 tabular-nums" data-testid="calc-target" /></Field>
          </div>

          {segment === "eq_mtf" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label={`Own capital ₹ (0 = auto @ ${mtfOwnMarginPct}% margin)`}>
                  <Input type="number" value={ownCapital} onChange={(e) => setOwnCapital(e.target.value)} className="h-8 tabular-nums" />
                </Field>
                <Field label="Holding days"><Input type="number" value={holdDays} onChange={(e) => setHoldDays(e.target.value)} className="h-8 tabular-nums" /></Field>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground" data-testid="calc-mtf-source">
                <span className={mtfIsFallback ? "text-muted-foreground" : "font-semibold text-primary"} data-testid="calc-mtf-pct">
                  MTF own margin {mtfOwnMarginPct}%
                </span>{" "}
                · {mtfSourceText}
              </p>
            </>
          )}

          <Field label="Number of trades (project across N)">
            <Input type="number" value={numTrades} onChange={(e) => setNumTrades(e.target.value)} className="h-8 tabular-nums" />
          </Field>
          <p className="text-[10px] text-muted-foreground">
            {mode === "fno" ? `Quantity = ${num(lots)} lot × ${num(lotSize)} = ${qty}. ` : ""}
            Charges use {broker} {effExchange} {segment} rates from charge config.
            {segment === "eq_mtf" ? ` Own capital ₹ is what YOU put in — the broker funds the rest; 0 auto-estimates it at the ${mtfOwnMarginPct}% own-margin rate above.` : ""}
          </p>
        </CardContent>
      </Card>

      {/* ---------------- (a) Size it for me ---------------- */}
      <Card>
        <CardHeader><CardTitle>Size it for me</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Field label="Risk budget ₹ (most you'll lose if the SL hits)">
            <Input type="number" value={riskBudget} onChange={(e) => setRiskBudget(e.target.value)} placeholder="9500" className="h-8 tabular-nums" data-testid="calc-risk-budget" />
          </Field>
          {!sizing ? (
            <p className="text-[11px] text-muted-foreground">
              Enter a risk budget with a valid entry and stop-loss. Sizing works off the gap between
              them — an entry equal to its stop has no risk per unit to divide by.
            </p>
          ) : sizing.qty <= 0 ? (
            <p className="text-[11px] text-loss" data-testid="calc-size-none">
              {inr(num(riskBudget), { decimals: 0 })} doesn&apos;t cover one {sizing.unit} — risk per {sizing.unit} is{" "}
              {inr(sizing.riskPerUnit)}. Widen the budget or tighten the stop.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Kpi
                  label={sizing.unit === "lot" ? "Suggested lots" : "Suggested qty"}
                  value={(sizing.unit === "lot" ? (sizing.lots ?? 0) : sizing.qty).toLocaleString("en-IN")}
                  tone="text-primary"
                  sub={sizing.unit === "lot" ? `${sizing.qty.toLocaleString("en-IN")} units` : `risk/${sizing.unit} ${inr(sizing.riskPerUnit)}`}
                  testId="calc-suggested-qty"
                />
                <Kpi label="Actual risk at SL" value={inr(sizing.totalRisk, { decimals: 0 })} sub={`outlay ${inr(sizing.capital, { decimals: 0 })}`} />
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={applySize} data-testid="calc-apply-size">
                  Apply to {isEquity ? "quantity" : "lots"}
                </Button>
                <span className="text-[10px] text-muted-foreground">
                  {sizing.qty === qty ? "matches the quantity above" : `currently ${qty.toLocaleString("en-IN")} — nothing changes until you press Apply`}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Sizing is gross: it divides your budget by the price gap. The charges below still come
                off the top, so the real loss at the stop is a little worse than {inr(sizing.totalRisk, { decimals: 0 })}.
              </p>
            </>
          )}
        </CardContent>
      </Card>
      </div>

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
              <Kpi label="Net @ target" value={formatPaise(result.rewardPaise, { decimals: 0 })} tone={result.rewardPaise >= 0 ? "text-profit" : "text-loss"} sub={`gross ${formatPaise(result.target.grossPaise, { decimals: 0 })}`} testId="calc-net-target" />
              <Kpi label="Net @ SL" value={formatPaise(result.riskPaise, { decimals: 0 })} tone={result.riskPaise >= 0 ? "text-profit" : "text-loss"} sub={`gross ${formatPaise(result.sl.grossPaise, { decimals: 0 })}`} />
              <Kpi label="Reward : risk" value={result.rrNet == null ? "—" : `${result.rrNet}:1`} sub={`gross ${result.rrGross ?? "—"}:1 · BE ${result.breakevenPrice}`} testId="calc-rr-net" />
            </section>

            <div className="grid gap-4 md:grid-cols-2">
              {/* ---------------- (c) Capital blocked ---------------- */}
              <Card>
                <CardHeader><CardTitle>Capital blocked</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {margin.marginPaise == null ? (
                    <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="calc-margin-note">
                      <Info className="mt-0.5 size-3.5 shrink-0" />
                      <span>Can&apos;t be computed — {margin.needs}.</span>
                    </p>
                  ) : (
                    <>
                      <div className="text-xl font-semibold tabular-nums" data-testid="calc-margin-value">
                        {formatPaise(margin.marginPaise, { decimals: 0 })}
                      </div>
                      <p className="text-[11px] text-muted-foreground" data-testid="calc-margin-basis">{margin.basis}</p>
                      {margin.missingRate ? (
                        <p className="text-[11px] text-loss">No margin rate configured for {margin.missingRate} — set one in Settings → Margin.</p>
                      ) : null}
                      {result.rewardPaise > 0 && margin.marginPaise > 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          Net at target is {((result.rewardPaise / margin.marginPaise) * 100).toFixed(2)}% of the capital this ties up.
                        </p>
                      ) : null}
                    </>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    Same rule as the /risk margin cockpit and the Return-on-Margin report — an estimate
                    from your margin_config rates, not a broker SPAN file.
                  </p>
                </CardContent>
              </Card>

              {/* ---------------- (d) Reverse solve ---------------- */}
              <Card>
                <CardHeader><CardTitle>Target for a net R:R</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  <Field label="Desired reward : risk, AFTER charges">
                    <Input type="number" step="0.1" value={desiredRR} onChange={(e) => setDesiredRR(e.target.value)} className="h-8 tabular-nums" data-testid="calc-desired-rr" />
                  </Field>
                  {!reverse ? (
                    <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="calc-reverse-note">
                      <Info className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        No target reaches {num(desiredRR) || "that"}:1 here. Either the stop sits on the wrong
                        side of entry, or the reward needed is more than this trade can produce — a short
                        can never make more than a fall to zero.
                      </span>
                    </p>
                  ) : (
                    <>
                      <div className="text-xl font-semibold tabular-nums text-profit" data-testid="calc-reverse-target">₹{reverse.target}</div>
                      <p className="text-[11px] text-muted-foreground" data-testid="calc-reverse-detail">
                        Nets {formatPaise(reverse.netRewardPaise, { decimals: 0 })} against{" "}
                        {formatPaise(reverse.netRiskPaise, { decimals: 0 })} at the stop — {reverse.achievedRR}:1 after every charge.
                      </p>
                      <Button size="sm" variant="secondary" onClick={() => setTarget(String(reverse.target))} data-testid="calc-apply-target">
                        Apply to target
                      </Button>
                    </>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    Charges scale with the exit price, so this is solved by iteration, not algebra — and
                    it always rounds in your favour: the price quoted clears the ratio, never misses it.
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* ---------------- (d) MTF breakeven move ---------------- */}
            {result.mtfCost ? (
              <Card>
                <CardHeader><CardTitle>Cost of carry — MTF</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Kpi
                      label="Breakeven move"
                      value={`${result.mtfCost.breakevenMovePct}%`}
                      sub={`≥ ₹${result.breakevenPrice} to be square`}
                      testId="calc-mtf-breakeven-pct"
                    />
                    <Kpi
                      label="Interest"
                      value={formatPaise(result.mtfCost.interestPaise, { decimals: 0 })}
                      tone="text-loss"
                      sub={`${(result.mtfCost.annualRate * 100).toFixed(2)}% p.a. on ${inr(result.mtfCost.fundedAmount, { decimals: 0 })}`}
                      testId="calc-mtf-interest"
                    />
                    <Kpi label="Per day" value={formatPaise(result.mtfCost.dailyInterestPaise, { decimals: 0 })} sub={`${num(holdDays)} days held`} testId="calc-mtf-daily" />
                    <Kpi label="Other charges" value={formatPaise(result.mtfCost.otherChargesPaise, { decimals: 0 })} sub={`total ${formatPaise(result.mtfCost.totalCostPaise, { decimals: 0 })}`} />
                  </div>
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    Carry is the charge that grows while you do nothing: {formatPaise(result.mtfCost.dailyInterestPaise, { decimals: 0 })} a
                    day on {inr(result.mtfCost.fundedAmount, { decimals: 0 })} of the broker&apos;s money. The breakeven move is
                    against the {inr(result.mtfCost.positionValue, { decimals: 0 })} position, interest and charges together.
                  </p>
                </CardContent>
              </Card>
            ) : null}

            <Card className="p-0">
              <CardHeader><CardTitle>Charge breakdown — one round trip (exit at target)</CardTitle></CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-xs">
                  <tbody>
                    {breakdown.map(([label, v]) => (
                      <tr key={label} className="border-b border-rule">
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

function Kpi({ label, value, sub, tone, testId }: { label: string; value: string; sub?: string; tone?: string; testId?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${tone ?? ""}`} data-testid={testId}>{value}</div>
      {sub ? <div className="text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
