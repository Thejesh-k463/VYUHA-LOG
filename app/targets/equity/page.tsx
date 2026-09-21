import { todayIstIso } from "@/lib/domain/trading-day";
import { PageHeader } from "@/components/layout/page-header";
import { TargetEquityClient, type MtfSummary } from "@/components/targets/target-equity-client";
import { getTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { deriveOpenPositions, mtfFundedStated } from "@/lib/analytics/positions";
import { dailyPnl } from "@/lib/analytics/metrics";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { findRates } from "@/lib/engine/rates";
import { mtfRateFor } from "@/lib/engine/charges";
import { getGoalView } from "@/lib/queries/goals";
import { getBucketCapital } from "@/lib/queries/bucket-capital";
import { goalProgress } from "@/lib/analytics/goal";
import { GoalStrip } from "@/components/targets/goal-strip";
import type { Broker, Exchange } from "@/lib/domain/constants";
import { resolvePerTradeCap } from "@/lib/risk/limits";

export const dynamic = "force-dynamic";

export default function TargetEquityPage() {
  const today = todayIstIso();
  const trades = getTrades();
  const mtm = getMtmMap();
  const risk = db.select().from(riskConfig).all();

  const equityRisk = risk.find((r) => r.scope === "bucket" && r.key === "equity");
  const globalRisk = risk.find((r) => r.scope === "global");
  // 0 means NOT CONFIGURED — the old ₹13,00,000 fallback fabricated every
  // %-of-capital gauge on a fresh install (invariant 6). Capital-relative
  // figures render "—" with a nudge instead; ₹ figures stay exact.
  // ACCOUNT-FIRST (v3.7): this is now the SAME base the goal strip below reads.
  // Until v3.7 the sizing calculator and concentration gauge used the global
  // settings figure while the goal three blocks down already resolved
  // account-first — one page, two capital bases.
  const equityCapital = getBucketCapital().equityCapital;

  // No margin map: nothing estimates a funded amount any more (D7).
  const positions = deriveOpenPositions(trades, mtm, today).filter((p) => p.bucket === "equity");
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
  // D8 (wave 2O, mtf#2 ≡ seams#0): the FUNDED total and the count of rows that
  // state none come from the one exported helper the /equity KPI face and its
  // dialog read, so the two screens cannot state two figures for one book. The
  // per-row rate work below stays here — it needs charge_config, which the pure
  // analytics module deliberately does not touch.
  const stated = mtfFundedStated(mtfPos);
  let dailyInterest = 0, accrued = 0, interestToDate = 0, value = 0;
  // A guard per position: a broker with no rate epoch covering today must cost
  // that ONE position its interest line, not blank the entire Target Tracker.
  // `today` is already in scope above — no second clock read.
  for (const p of mtfPos) {
    // D7 (close-readers#1) — every ₹ figure below is built from the STATED
    // funded amount. A row the journal never priced is left out of all of them
    // (funded, daily interest, interest to date, the blended rate and the
    // breakeven move's own denominator) rather than estimated into them: the
    // estimate was money nothing recorded (invariant 6). `accrued` is stored
    // money and still counts every row — an unpriced row now accrues 0 anyway
    // (Q-A, lib/jobs/mtf-accrual.ts).
    const fundedRow = p.fundedAmount;
    accrued += p.accruedInterest;
    if (fundedRow == null) continue;
    let r;
    try {
      r = findRates(rates, p.broker as Broker, "eq_mtf", p.exchange as Exchange, today);
    } catch {
      value += p.currentValue;
      continue;
    }
    const rate = mtfRateFor(fundedRow, r);
    dailyInterest += (fundedRow * rate) / 365;
    interestToDate += (fundedRow * rate * (p.daysHeld ?? 0)) / 365;
    value += p.currentValue;
  }
  // Wave 2N (B-ASK, D7's owed half): the count rides to the card, which states
  // it beside the figures it is left out of (invariant 6).
  const mtf: MtfSummary = {
    count: mtfPos.length,
    unstated: stated.unstated,
    funded: stated.funded,
    dailyInterest: Math.round(dailyInterest * 100) / 100,
    accrued: Math.round(accrued * 100) / 100,
    blendedRate: stated.funded > 0 ? (dailyInterest * 365) / stated.funded : 0,
    breakevenMovePct: value > 0 ? Math.round((interestToDate / value) * 10000) / 100 : 0,
  };

  // Expected-capital goal for THIS bucket (v3.6) — nothing renders without one.
  // The maths runs on the trades already loaded; capital resolves account-first.
  const equityGoal = getGoalView().goals.find((g) => g.bucket === "equity") ?? null;
  const goalProg = equityGoal
    ? goalProgress(equityGoal, {
        currentCapital: equityCapital > 0 ? equityCapital : null,
        realised: [...dailyPnl(trades.filter((t) => t.bucket === "equity")).entries()].map(([date, net]) => ({ date, net })),
        today,
      })
    : null;

  return (
    <>
      <PageHeader title="Target Tracker — Equity" description="Position sizing, max-open monitor, monthly ladder, MTF break-even." />
      <div className="space-y-5 p-6">
        {equityGoal && goalProg && <GoalStrip goal={equityGoal} progress={goalProg} />}
        {/* v4.4.0 (D1 + the invented-limits sweep): every limit is the user's
            or null — the cap through THE resolver (the equity bucket's cap,
            which is what an equity-delivery trade is measured in), and no
            ₹9,500 / 6 / 20% / ₹4.25L / ₹5.1L stand-ins. The client says "not
            set" for each null (invariant 6). */}
        <TargetEquityClient
          defaultRisk={resolvePerTradeCap(risk, "equity", "eq_delivery")}
          equityCapital={equityCapital}
          openCount={positions.length}
          maxOpen={equityRisk?.maxOpen ?? null}
          topConcentration={top}
          concentrationLimit={equityRisk?.concentrationPct ?? null}
          monthly={monthly}
          monthlyBase={globalRisk?.monthlyTargetBase ?? null}
          monthlyStretch={globalRisk?.monthlyTargetStretch ?? null}
          mtf={mtf}
        />
      </div>
    </>
  );
}
