import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { chargeConfig } from "@/lib/db/schema";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";
import type { ChargeRates } from "./types";
import { addEpoch, type RatesMap } from "./rates";

/**
 * Load all charge_config rows into an in-memory lookup (one query per import).
 *
 * Each key holds a LIST of dated epochs (migration 0050), so the map is built
 * through `addEpoch`, which keeps each list sorted newest-first.
 */
export const loadRatesMap = cache((): RatesMap => {
  const rows = db.select().from(chargeConfig).all();
  const map: RatesMap = new Map();
  for (const r of rows) {
    addEpoch(map, {
      effectiveFrom: r.effectiveFrom ?? "1970-01-01",
      effectiveTo: r.effectiveTo ?? null,
      broker: r.broker as Broker,
      plan: r.plan ?? "default",
      planLabel: r.planLabel ?? null,
      subscriptionMonthly: r.subscriptionMonthly ?? 0,
      segment: r.segment as Segment,
      exchange: r.exchange as Exchange,
      brokerageFlat: r.brokerageFlat,
      brokeragePct: r.brokeragePct,
      brokerageCap: r.brokerageCap,
      brokerageFloor: r.brokerageFloor,
      sttPct: r.sttPct,
      sttSide: r.sttSide as ChargeRates["sttSide"],
      exchangeTxnPct: r.exchangeTxnPct,
      sebiPct: r.sebiPct,
      stampPct: r.stampPct,
      ipftPct: r.ipftPct,
      gstPct: r.gstPct,
      dpCharge: r.dpCharge,
    dpPct: r.dpPct ?? 0,
      dpGstApplicable: r.dpGstApplicable,
      dpMinValue: r.dpMinValue,
      mtfInterestAnnual: r.mtfInterestAnnual,
    mtfRateUnknown: r.mtfRateUnknown ?? false,
      mtfTiers: r.mtfTiers,
      pledgeCharge: r.pledgeCharge,
      unpledgeCharge: r.unpledgeCharge,
    });
  }
  return map;
});
