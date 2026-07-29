import { buildChargeConfigSeed } from "@/lib/db/seed-data";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";
import type { ChargeRates } from "./types";

function key(broker: string, plan: string, segment: string, exchange: string) {
  return `${broker}|${plan}|${segment}|${exchange}`;
}

/** Build an in-memory rate lookup from the canonical seed (pure — no DB). */
export function seedRatesMap(): Map<string, ChargeRates> {
  const map = new Map<string, ChargeRates>();
  for (const r of buildChargeConfigSeed()) {
    map.set(key(r.broker, r.plan, r.segment, r.exchange), { ...r });
  }
  return map;
}

export function findRates(
  map: Map<string, ChargeRates>,
  broker: Broker,
  segment: Segment,
  exchange: Exchange,
  /** Which pricing plan. Defaults to the free tier most accounts are on. */
  plan = "default",
): ChargeRates {
  const r = map.get(key(broker, plan, segment, exchange));
  if (!r) {
    throw new Error(
      `No charge_config for ${broker} / ${plan} / ${segment} / ${exchange}`,
    );
  }
  return r;
}
