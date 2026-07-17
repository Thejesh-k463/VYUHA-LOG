import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { chargeConfig } from "@/lib/db/schema";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";
import type { ChargeRates } from "./types";

function key(broker: string, segment: string, exchange: string) {
  return `${broker}|${segment}|${exchange}`;
}

/** Load all charge_config rows into an in-memory lookup (one query per import). */
export const loadRatesMap = cache((): Map<string, ChargeRates> => {
  const rows = db.select().from(chargeConfig).all();
  const map = new Map<string, ChargeRates>();
  for (const r of rows) {
    map.set(key(r.broker, r.segment, r.exchange), {
      broker: r.broker as Broker,
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
      dpGstApplicable: r.dpGstApplicable,
      dpMinValue: r.dpMinValue,
      mtfInterestAnnual: r.mtfInterestAnnual,
      mtfTiers: r.mtfTiers,
      pledgeCharge: r.pledgeCharge,
      unpledgeCharge: r.unpledgeCharge,
    });
  }
  return map;
});
