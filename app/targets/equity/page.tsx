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
import { getGoalView } from "@/lib/queries/goals";
import { getBucketCapital } from "@/lib/queries/capital";
import { goalProgress } from "@/lib/analytics/goal";
import { GoalStrip } from "@/components/targets/goal-strip";
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
  // 0 means NOT CONFIGURED — the old ₹13,00,000 fallback fabricated every
  // %-of-capital gauge on a fresh install (invariant 6). Capital-relative
  // figures render "—" with a nudge instead; ₹ figures stay exact.
  const equityCapital = settings?.equityCapital ?? 0;

  const positions = deriveOpenPositions(trades, mtm, today, getMtfMarginByBroker()).filter((p) => p.bucket === "equity");
  // Largest position by invested ₹ (same winner as largest % when capital is
  // known); its pct is null when no capital is configured — the client renders
  // "—" rather than a fake 0% concentration.
  const topByInvested = positions.reduce<{ symbol: string; invested: number } | null>(
    (best, p) => (best == null || p.invested > best.invested ? { symbol: p.symbol, invested: p.invested } : best),
    null,
  );
  const top = topByInvested
    ? { symbol: topByInvested.symbol, pct: equityCapital > 0 ? (topByInvested.invested / equityCapital) * 100 : null }
    : null;

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
  // A guard per position: a broker with no rate epoch covering today must cost
  // that ONE position its interest line, not blank the entire Target Tracker.
  // `today` is already in scope above — no second clock read.
  for (const p of mtfPos) {
    let r;
    try {
      r = findRates(rates, p.broker as Broker, "eq_mtf", p.exchange as Exchange, today);
    } catch {
      funded += p.fundedAmount;
      value += p.currentValue;
      accrued += p.accruedInterest;
      continue;
    }
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

  // Expected-capital goal for THIS bucket (v3.6) — nothing renders without one.
  // The maths runs on the trades already loaded; capital resolves account-first.
  const equityGoal = getGoalView().goals.find((g) => g.bucket === "equity") ?? null;
  const goalProg = equityGoal
    ? goalProgress(equityGoal, {
        currentCapital: getBucketCapital().equityCapital > 0 ? getBucketCapital().equityCapital : null,
        realised: [...dailyPnl(trades.filter((t) => t.bucket === "equity")).entries()].map(([date, net]) => ({ date, net })),
        today,
      })
    : null;

  return (
    <>
      <PageHeader title="Target Tracker — Equity" description="Position sizing, max-open monitor, monthly ladder, MTF break-even." />
      <div className="space-y-5 p-6">
        {equityGoal && goalProg && <GoalStrip goal={equityGoal} progress={goalProg} />}
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
