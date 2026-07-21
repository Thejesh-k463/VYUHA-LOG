import { PageHeader } from "@/components/layout/page-header";
import { RiskCockpitClient } from "@/components/risk/risk-cockpit-client";
import { ExpiryObligations } from "@/components/risk/expiry-obligations";
import { MtmForm } from "@/components/trackers/mtm-form";
import { BhavcopyMtm } from "@/components/trackers/bhavcopy-mtm";
import { LimitCheck } from "@/components/risk/limit-check";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTrades } from "@/lib/queries/trades";
import { getMtmMap, getSpotMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { getSectorMap } from "@/lib/queries/instruments";
import { getAliasMap } from "@/lib/queries/aliases";
import { resolveTicker } from "@/lib/analytics/aliases";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { getStagedView } from "@/lib/queries/staged";
import type { ExposureInput } from "@/lib/analytics/exposure";
import {
  computeSettlement,
  DEFAULT_SETTLEMENT_RATES,
  type SettlementInput,
} from "@/lib/analytics/settlement";
import { portfolioGreeks, type PositionGreeksInput, type OptionType } from "@/lib/analytics/greeks";
import { GreeksPanel } from "@/components/risk/greeks-panel";
import { getLatestVixClose, VIX_SYMBOL } from "@/lib/queries/vix";
import { getBenchmarkMeta, getBenchmarkCloses, DEFAULT_BENCHMARK } from "@/lib/queries/benchmark";
import { BenchmarkPanel } from "@/components/reports/benchmark-panel";
import { ProGate } from "@/components/system/pro-gate";
import {
  computePortfolioVar,
  symbolBeta,
  betaWeightedExposure,
  stressScenarios,
  closesToReturnSeries,
  type VarPosition,
  type BetaPosition,
  type StressPosition,
} from "@/lib/risk/portfolio";
import { getReturnsMap } from "@/lib/queries/price-history";
import { VarPanel } from "@/components/risk/var-panel";
import { estimateMargin, type MarginPositionInput } from "@/lib/risk/margin";
import { getMarginConfig, getMarginRates } from "@/lib/queries/margin";
import { MarginPanel } from "@/components/risk/margin-panel";
import { BreachBanner } from "@/components/risk/breach-banner";
import { SebiRadarPanel } from "@/components/risk/sebi-radar-panel";
import { sebiRadar, type RadarPosition } from "@/lib/risk/sebi-radar";
import { scanBreaches } from "@/lib/jobs/auto-mtm";

export const dynamic = "force-dynamic";

const DERIVATIVE_SEGMENTS = new Set([
  "stock_option",
  "index_option",
  "future",
  "commodity_future",
  "commodity_option",
]);

/** Statutory equity-delivery STT, read from charge_config (not hard-coded). */
function deliverySttFromConfig(): number {
  for (const r of loadRatesMap().values()) {
    if (r.segment === "eq_delivery" && r.sttPct > 0) return r.sttPct;
  }
  return DEFAULT_SETTLEMENT_RATES.deliverySttPct;
}

function daysBetween(a: string | null, b: string): number | null {
  if (!a) return null;
  const d1 = new Date(a + "T00:00:00").getTime();
  const d2 = new Date(b + "T00:00:00").getTime();
  if (Number.isNaN(d1) || Number.isNaN(d2)) return null;
  return Math.round((d2 - d1) / 86400000);
}

export default function RiskPage() {
  const today = new Date().toISOString().slice(0, 10);
  const trades = getTrades();
  const mtm = getMtmMap();
  const spot = getSpotMap();
  const settings = getSettings();
  const equityCapital = settings?.equityCapital ?? 1300000;
  const activeCapital = settings?.activeCapital ?? 400000;
  const sectorMap = getSectorMap();
  const aliasMap = getAliasMap();
  const sectorFor = (symbol: string): string | null => {
    const up = symbol.toUpperCase();
    return sectorMap.get(up) ?? sectorMap.get(resolveTicker(up, aliasMap)) ?? null;
  };

  // Per-tranche stops for every staged position, resolved in one pass so the
  // exposure mapping below stays a pure lookup.
  const trancheMap = new Map<number, Array<{ qty: number; price: number; stop: number | null }>>();
  for (const t of trades) {
    if (!t.isOpen || !t.staged) continue;
    const view = getStagedView(t.id);
    if (!view) continue;
    trancheMap.set(
      t.id,
      view.position.openTranches.map((tr) => ({ qty: tr.openQty, price: tr.price, stop: tr.effectiveSl })),
    );
  }

  const inputs: ExposureInput[] = trades
    .filter((t) => t.isOpen)
    .map((t) => {
      // Short (sell-to-open, e.g. a written CE/PE) has the open leg on sellQty with
      // buyQty still 0 — same convention as /strategies and the settlement engine.
      const side: "long" | "short" = t.buyQty >= t.sellQty ? "long" : "short";
      const qty = Math.abs(t.buyQty - t.sellQty) || Math.max(t.buyQty, t.sellQty);
      const entry = side === "long" ? t.avgBuyPrice : t.avgSellPrice;
      const mtmPrice =
        mtm.get(t.symbol.toUpperCase()) ??
        mtm.get(t.tradingsymbol.toUpperCase()) ??
        t.closingPrice ??
        entry;
      return {
        id: t.id,
        symbol: t.symbol,
        tradingsymbol: t.tradingsymbol,
        broker: t.broker,
        bucket: t.bucket,
        segment: t.segment,
        exchange: t.exchange,
        optionType: t.optionType,
        strike: t.strike,
        expiry: t.expiry,
        qty,
        entry,
        mtm: mtmPrice,
        originalSl: t.slPlanned,
        trailingSl: t.trailingSl,
        target: t.targetPlanned,
        daysHeld: daysBetween(side === "long" ? t.buyDate : t.sellDate, today),
        dte: t.expiry ? daysBetween(today, t.expiry) : null,
        sector: sectorFor(t.symbol),
        side,
        impliedVol: t.impliedVol,
        spot: t.instrumentType === "option" ? spot.get(t.symbol.toUpperCase()) ?? null : null,
        // Staged positions carry a stop per tranche; handing them to the
        // exposure engine lets it sum the real risk instead of inferring it
        // from the single widest stop on the parent row.
        tranches: t.staged ? (trancheMap.get(t.id) ?? null) : null,
      };
    });

  // Option Greeks (P1.2 slice) — Black-Scholes off the underlying spot; only priceable
  // when a spot is on record (from bhavcopy/manual MTM) and the contract has an expiry.
  // IND-12 — when a position has no per-position IV, fall back to the latest India VIX
  // close (a real market-wide vol read) before the flat 20% estimate.
  const latestVix = getLatestVixClose();
  const vixMeta = getBenchmarkMeta(VIX_SYMBOL);
  const greeksInputs: PositionGreeksInput[] = inputs
    .filter((p) => p.optionType === "CE" || p.optionType === "PE")
    .map((p) => ({
      id: p.id,
      symbol: p.symbol,
      spot: p.spot ?? null,
      strike: p.strike ?? 0,
      dte: p.dte,
      optionType: p.optionType as OptionType,
      ivPct: p.impliedVol ?? null,
      marketIvPct: latestVix,
      qty: p.qty,
      side: p.side ?? "long",
    }));
  const greeks = portfolioGreeks(greeksInputs);

  // P1.2 — VaR / beta-weighted exposure / stress tests off delta-equivalent exposures.
  // Options enter at positionDelta × spot (Greeks above); equity/futures at qty × mtm,
  // signed by side. Symbols resolve to canonical tickers for the price-history lookup.
  const greeksById = new Map(greeks.positions.map((g) => [g.id, g]));
  const sideSign = (p: (typeof inputs)[number]) => (p.side === "short" ? -1 : 1);
  const exposures = inputs
    .map((p) => {
      const ticker = resolveTicker(p.symbol.toUpperCase(), aliasMap);
      const isOption = p.optionType === "CE" || p.optionType === "PE";
      const g = greeksById.get(p.id);
      let exposure: number | null = null;
      if (isOption) exposure = g && p.spot != null ? g.delta * p.spot : null; // delta already qty-scaled & side-signed
      else exposure = p.qty * p.mtm * sideSign(p);
      return exposure == null ? null : { p, ticker, exposure, g };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  const returnsMap = getReturnsMap(exposures.map((e) => e.ticker));
  const niftyReturns = closesToReturnSeries(getBenchmarkCloses(DEFAULT_BENCHMARK));
  const betaFor = (ticker: string): number | null => {
    const rets = returnsMap.get(ticker);
    if (!rets || niftyReturns.length === 0) return null;
    return symbolBeta(rets, niftyReturns)?.beta ?? null;
  };

  const varPositions: VarPosition[] = exposures.map((e) => ({ id: e.p.id, symbol: e.ticker, exposure: e.exposure }));
  const varResult = computePortfolioVar(varPositions, returnsMap);

  const betaPositions: BetaPosition[] = exposures.map((e) => ({ id: e.p.id, symbol: e.ticker, exposure: e.exposure, beta: betaFor(e.ticker) }));
  const betaExp = exposures.length > 0 ? betaWeightedExposure(betaPositions) : null;

  const stressPositions: StressPosition[] = exposures.map((e) => ({
    id: e.p.id,
    symbol: e.ticker,
    exposure: e.exposure,
    beta: betaFor(e.ticker) ?? 1,
    gamma: e.g?.gamma ?? null,
    vega: e.g?.vega ?? null,
    spot: e.p.spot ?? null,
  }));
  const stress = exposures.length > 0 ? stressScenarios(stressPositions) : null;

  // P1.2 margin slice — estimated margin blocked per position vs bucket capital.
  const marginInputs: MarginPositionInput[] = inputs.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    broker: p.broker,
    bucket: p.bucket,
    segment: p.segment,
    side: p.side ?? "long",
    qty: p.qty,
    entry: p.entry,
    mtm: p.mtm,
    strike: p.strike ?? null,
    optionType: p.optionType ?? null,
    spot: p.spot ?? null,
  }));
  // T1.2 — SEBI rule radar off the same open-position inputs.
  const radarInputs: RadarPosition[] = inputs.map((p) => ({
    id: p.id,
    symbol: p.tradingsymbol || p.symbol,
    segment: p.segment,
    side: p.side ?? "long",
    optionType: p.optionType,
    expiry: p.expiry,
    qty: p.qty,
    entry: p.entry,
    mtm: p.mtm,
    exchange: p.exchange,
  }));
  const radar = sebiRadar(radarInputs, today);

  const marginSummary = estimateMargin(marginInputs, getMarginRates(), {
    equity: equityCapital,
    active: activeCapital,
  });
  const marginRates = getMarginConfig().map((r) => ({ broker: r.broker, segment: r.segment, marginPct: r.marginPct }));

  // Physical-settlement / expiry obligations (IND-7) — open F&O positions only.
  const settlementInputs: SettlementInput[] = trades
    .filter((t) => t.isOpen && DERIVATIVE_SEGMENTS.has(t.segment))
    .map((t) => {
      const netQty = Math.abs(t.buyQty - t.sellQty) || t.buyQty;
      const side: "long" | "short" = t.buyQty >= t.sellQty ? "long" : "short";
      // futures: settlement uses the futures price (its MTM); options: underlying spot.
      const refPrice =
        t.instrumentType === "option"
          ? spot.get(t.symbol.toUpperCase()) ?? null
          : mtm.get(t.symbol.toUpperCase()) ?? t.closingPrice ?? t.avgBuyPrice;
      return {
        id: t.id,
        symbol: t.symbol,
        tradingsymbol: t.tradingsymbol,
        segment: t.segment,
        optionType: t.optionType,
        strike: t.strike,
        expiry: t.expiry,
        netQty,
        side,
        refPrice,
      };
    });
  const settlement = computeSettlement(
    settlementInputs,
    { ...DEFAULT_SETTLEMENT_RATES, deliverySttPct: deliverySttFromConfig() },
    today,
  );

  return (
    <>
      <PageHeader title="Portfolio Risk" description="Live exposure across open positions — initial risk, open P&L and open risk at stop." />
      <div className="space-y-5 p-6">
        <ProGate>
        <BreachBanner breaches={scanBreaches()} />
        <RiskCockpitClient
          inputs={inputs}
          capitals={{ equity: equityCapital, active: activeCapital, all: equityCapital + activeCapital }}
        />
        <SebiRadarPanel report={radar} />
        <ExpiryObligations summary={settlement} />
        <MarginPanel summary={marginSummary} rates={marginRates} />
        {exposures.length > 0 && (
          <VarPanel varResult={varResult} betaExp={betaExp} stress={stress} niftyDays={niftyReturns.length} />
        )}
        {greeks.count > 0 && (
          <>
            <GreeksPanel greeks={greeks} latestVix={latestVix} />
            <Card>
              <CardHeader>
                <CardTitle>India VIX (Greeks IV fallback)</CardTitle>
              </CardHeader>
              <CardContent>
                <BenchmarkPanel
                  symbol={VIX_SYMBOL}
                  meta={vixMeta}
                  purpose="Used as the IV fallback for the Greeks above when a position has no per-position implied vol set."
                />
              </CardContent>
            </Card>
          </>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Pre-trade limits check</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-muted-foreground">
              What-if: test a prospective order against your per-trade cap, daily-loss stop, max-open, max-trades and
              concentration limits (from Settings → Risk) before you place it.
            </p>
            <LimitCheck />
          </CardContent>
        </Card>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Bulk update — MTM price &amp; stops</CardTitle>
            </CardHeader>
            <CardContent>
              <MtmForm />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Auto-MTM from bhavcopy</CardTitle>
            </CardHeader>
            <CardContent>
              <BhavcopyMtm />
            </CardContent>
          </Card>
        </div>
        </ProGate>
      </div>
    </>
  );
}
