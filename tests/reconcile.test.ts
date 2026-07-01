import { describe, it, expect } from "vitest";
import { classify } from "@/lib/engine/classify";
import { computeCharges } from "@/lib/engine/charges";
import { seedRatesMap, findRates } from "@/lib/engine/rates";
import type { ChargeBreakdown } from "@/lib/engine/types";
import { loadDhan, loadGroww } from "./fixtures-loader";

const rates = seedRatesMap();

function zeroBreakdown(): ChargeBreakdown {
  return {
    brokerage: 0, sttCtt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0,
    ipft: 0, gst: 0, dpCharges: 0, mtfInterest: 0, pledgeCharges: 0, total: 0,
  };
}

function add(a: ChargeBreakdown, b: ChargeBreakdown): ChargeBreakdown {
  return {
    brokerage: a.brokerage + b.brokerage,
    sttCtt: a.sttCtt + b.sttCtt,
    exchangeTxn: a.exchangeTxn + b.exchangeTxn,
    sebi: a.sebi + b.sebi,
    stampDuty: a.stampDuty + b.stampDuty,
    ipft: a.ipft + b.ipft,
    gst: a.gst + b.gst,
    dpCharges: a.dpCharges + b.dpCharges,
    mtfInterest: a.mtfInterest + b.mtfInterest,
    pledgeCharges: a.pledgeCharges + b.pledgeCharges,
    total: a.total + b.total,
  };
}

const pctDiff = (computed: number, reported: number) =>
  reported === 0 ? 0 : ((computed - reported) / reported) * 100;

function reportLine(name: string, computed: number, reported: number) {
  const d = computed - reported;
  const p = pctDiff(computed, reported);
  return `  ${name.padEnd(14)} computed ${computed.toFixed(2).padStart(12)}  reported ${reported.toFixed(2).padStart(12)}  Δ ${d.toFixed(2).padStart(10)} (${p.toFixed(1)}%)`;
}

describe("Reconciliation — Dhan P&L", () => {
  const { trades, reco } = loadDhan();
  let agg = zeroBreakdown();
  let gross = 0;
  for (const t of trades) {
    const c = classify({ tradingsymbol: t.tradingsymbol, broker: t.broker, productHint: t.productHint });
    const r = findRates(rates, t.broker, c.segment, c.exchange);
    agg = add(agg, computeCharges(
      { segment: c.segment, buyValue: t.buyValue, sellValue: t.sellValue, buyQty: t.buyQty, sellQty: t.sellQty },
      r,
    ));
    gross += t.grossPnl;
  }

  // Brokerage from scrip-aggregated P&L is underivable (order counts hidden).
  // Reconcile the total using the broker-REPORTED brokerage; statutory side is engine-computed.
  // Dhan DP is GST-applicable, so include it in the GST base.
  const gstBaseNonBrokerage = agg.exchangeTxn + agg.sebi + agg.ipft + agg.dpCharges + agg.pledgeCharges;
  const recomputedGst = 0.18 * (reco.brokerage + gstBaseNonBrokerage);
  const totalWithReportedBrokerage =
    reco.brokerage + agg.sttCtt + agg.exchangeTxn + agg.sebi + agg.stampDuty +
    agg.ipft + recomputedGst + agg.dpCharges + agg.mtfInterest + agg.pledgeCharges;

  it("prints a reconciliation report", () => {
    console.log("\n── Dhan reconciliation ──");
    console.log(reportLine("Gross P&L", gross, reco.grossPnl));
    console.log(reportLine("Brokerage", agg.brokerage, reco.brokerage) + "  ← engine 2-order vs actual (underivable)");
    console.log(reportLine("Total charges", totalWithReportedBrokerage, reco.totalCharges) + "  ← using reported brokerage");
    console.log(`  Net P&L (gross − total): ${(gross - totalWithReportedBrokerage).toFixed(2)}  (reported ${reco.netPnl})`);
    expect(true).toBe(true);
  });

  it("gross P&L ties out exactly (±₹1)", () => {
    expect(Math.abs(gross - reco.grossPnl)).toBeLessThanOrEqual(1);
  });

  it("total charges reconcile within tolerance (using reported brokerage)", () => {
    // Wider tolerance: brief's FY2026-27 option STT (0.15%) exceeds the rate in
    // force when the file was generated; equity segment defaults to delivery.
    expect(Math.abs(pctDiff(totalWithReportedBrokerage, reco.totalCharges))).toBeLessThan(12);
  });
});

describe("Reconciliation — Groww P&L", () => {
  const { trades, reco } = loadGroww();
  let agg = zeroBreakdown();
  let grossRealised = 0;
  let unreal = 0;
  for (const t of trades) {
    const c = classify({ tradingsymbol: t.tradingsymbol, broker: t.broker, productHint: t.productHint });
    const r = findRates(rates, t.broker, c.segment, c.exchange);
    agg = add(agg, computeCharges(
      { segment: c.segment, buyValue: t.buyValue, sellValue: t.sellValue, buyQty: t.buyQty, sellQty: t.sellQty },
      r,
    ));
    grossRealised += t.grossPnl;
    unreal += t.unrealisedPnl;
  }

  it("prints a per-component reconciliation report", () => {
    console.log("\n── Groww reconciliation ──");
    console.log(reportLine("Realised P&L", grossRealised, reco.realisedPnl));
    console.log(reportLine("Unrealised", unreal, reco.unrealisedPnl));
    console.log(reportLine("STT", agg.sttCtt, reco.stt));
    console.log(reportLine("Exchange txn", agg.exchangeTxn, reco.exchangeTxn));
    console.log(reportLine("Stamp duty", agg.stampDuty, reco.stamp));
    console.log(reportLine("SEBI", agg.sebi, reco.sebi));
    console.log(reportLine("Brokerage", agg.brokerage, reco.brokerage) + "  ← order counts hidden in aggregated file");
    console.log(`  (MTF interest ${reco.mtfInterest}, pledge ${reco.mtfPledge}+${reco.mtfUnpledge}, DP ${reco.cdslDp}+${reco.growwDp} not derivable from trade rows)`);
    expect(true).toBe(true);
  });

  it("realised & unrealised P&L tie out exactly (±₹1)", () => {
    expect(Math.abs(grossRealised - reco.realisedPnl)).toBeLessThanOrEqual(1);
    expect(Math.abs(unreal - reco.unrealisedPnl)).toBeLessThanOrEqual(1);
  });

  it("statutory components reconcile within 8% (rates validated)", () => {
    expect(Math.abs(pctDiff(agg.sttCtt, reco.stt))).toBeLessThan(8);
    expect(Math.abs(pctDiff(agg.exchangeTxn, reco.exchangeTxn))).toBeLessThan(8);
    expect(Math.abs(pctDiff(agg.stampDuty, reco.stamp))).toBeLessThan(8);
    expect(Math.abs(pctDiff(agg.sebi, reco.sebi))).toBeLessThan(8);
  });
});
