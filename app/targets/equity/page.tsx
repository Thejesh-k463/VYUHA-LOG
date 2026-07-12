import { PageHeader } from "@/components/layout/page-header";
import { TargetEquityClient, type MtfSummary } from "@/components/targets/target-equity-client";
import { getTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { deriveOpenPositions } from "@/lib/analytics/positions";
import { dailyPnl } from "@/lib/analytics/metrics";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { findRates } from "@/lib/engine/rates";
import { mtfRateFor } from "@/lib/engine/charges";
import { getMtfMarginByBroker } from "@/lib/queries/margin";
import type { Broker, Exchange } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

export default function TargetEquityPage() {
  const today = new Date().toISOString().slice(0, 10);
  const trades = getTrades();
  const mtm = getMtmMap();
  const settings = getSettings();
  const risk = db.select().from(riskConfig).all();

  const equityRisk = risk.find((r) => r.scope === "bucket" && r.key === "equity");
  const globalRisk = risk.find((r) => r.scope === "global");
  const equityCapital = settings?.equityCapital ?? 1300000;

  const positions = deriveOpenPositions(trades, mtm, today, getMtfMarginByBroker()).filter((p) => p.bucket === "equity");
  const top = positions.reduce<{ symbol: string; pct: number } | null>((best, p) => {
    const pct = equityCapital > 0 ? (p.invested / equityCapital) * 100 : 0;
    return best == null || pct > best.pct ? { symbol: p.symbol, pct } : best;
  }, null);

  // combined monthly ladder
  const daily = dailyPnl(trades);
  const monthsMap = new Map<string, number>();
  for (const [d, v] of daily) {
    const k = d.slice(0, 7);
    monthsMap.set(k, (monthsMap.get(k) ?? 0) + v);
  }
  const monthly = [...monthsMap.entries()].sort().map(([month, net]) => ({ month, net: Math.round(net * 100) / 100 }));

  // MTF summary
  const rates = loadRatesMap();
  const mtfPos = positions.filter((p) => p.isMtf);
  let funded = 0, dailyInterest = 0, accrued = 0, interestToDate = 0, value = 0;
  for (const p of mtfPos) {
    const r = findRates(rates, p.broker as Broker, "eq_mtf", p.exchange as Exchange);
    const rate = mtfRateFor(p.fundedAmount, r);
    funded += p.fundedAmount;
    dailyInterest += (p.fundedAmount * rate) / 365;
    accrued += p.accruedInterest;
    interestToDate += (p.fundedAmount * rate * (p.daysHeld ?? 0)) / 365;
    value += p.currentValue;
  }
  const mtf: MtfSummary = {
    count: mtfPos.length,
    funded: Math.round(funded * 100) / 100,
    dailyInterest: Math.round(dailyInterest * 100) / 100,
    accrued: Math.round(accrued * 100) / 100,
    blendedRate: funded > 0 ? (dailyInterest * 365) / funded : 0,
    breakevenMovePct: value > 0 ? Math.round((interestToDate / value) * 10000) / 100 : 0,
  };

  return (
    <>
      <PageHeader title="Target Tracker — Equity" description="Position sizing, max-open monitor, monthly ladder, MTF break-even." />
      <div className="space-y-5 p-6">
        <TargetEquityClient
          defaultRisk={globalRisk?.perTradeMaxLoss ?? 9500}
          equityCapital={equityCapital}
          openCount={positions.length}
          maxOpen={equityRisk?.maxOpen ?? 6}
          topConcentration={top}
          concentrationLimit={equityRisk?.concentrationPct ?? 20}
          monthly={monthly}
          monthlyBase={globalRisk?.monthlyTargetBase ?? 425000}
          monthlyStretch={globalRisk?.monthlyTargetStretch ?? 510000}
          mtf={mtf}
        />
      </div>
    </>
  );
}
