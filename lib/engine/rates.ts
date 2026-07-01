import { buildChargeConfigSeed } from "@/lib/db/seed-data";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";
import type { ChargeRates } from "./types";

function key(broker: string, segment: string, exchange: string) {
  return `${broker}|${segment}|${exchange}`;
}

/** Build an in-memory rate lookup from the canonical seed (pure — no DB). */
export function seedRatesMap(): Map<string, ChargeRates> {
  const map = new Map<string, ChargeRates>();
  for (const r of buildChargeConfigSeed()) {
    map.set(key(r.broker, r.segment, r.exchange), { ...r });
  }
  return map;
}

export function findRates(
  map: Map<string, ChargeRates>,
  broker: Broker,
  segment: Segment,
  exchange: Exchange,
): ChargeRates {
  const r = map.get(key(broker, segment, exchange));
  if (!r) {
    throw new Error(
      `No charge_config for ${broker} / ${segment} / ${exchange}`,
    );
  }
  return r;
}
