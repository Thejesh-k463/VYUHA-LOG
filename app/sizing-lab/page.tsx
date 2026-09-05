import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { ProGate } from "@/components/system/pro-gate";
import { getBucketCapital } from "@/lib/queries/capital";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { findRates } from "@/lib/engine/rates";
import { BROKERS, type Broker, type Exchange, type Segment } from "@/lib/domain/constants";
import type { ChargeRates } from "@/lib/engine/types";
import defaultsJson from "@/lib/data/charge-rates-defaults.json";
import {
  LAB_PRODUCTS,
  LAB_PRODUCT_SEGMENT,
  compareAll_forSample,
  resolveLiveDeskRisk,
  type ResolvedLiveDeskRisk,
} from "@/components/sizing/lab-config";
import { LabClient, type LabSchedule } from "@/components/sizing/lab-client";

/** Reads the DB on every request, like every other data page in the app. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Sizing Lab · Vyuha" };

/**
 * The Sizing Lab (owner Q37/Q55): all seven method tabs, the deploy-cap
 * toggle, and the explicit Live Desk write-back. Full-page Pro, so the whole
 * body sits inside <ProGate>.
 *
 * The server's only jobs are the three things a browser cannot know: the
 * account's capital, the stored migration-0064 risk columns, and the CHARGE
 * RATES. The last one is invariant 3 — rates are resolved here through the
 * shipped engine (`loadRatesMap` + `findRates`, the server-only pair) and
 * handed to the client as data. `lib/data/charge-rates-defaults.json` is used
 * ONLY when a broker has no row on file, and that case is labelled "default
 * schedule" on screen so a fallback never reads as the user's own schedule.
 */

const EXCHANGE_FOR: Record<Segment, Exchange> = {
  eq_delivery: "NSE",
  eq_mtf: "NSE",
  eq_intraday: "NSE",
  index_option: "NSE",
  stock_option: "NSE",
  future: "NSE",
  commodity_future: "MCX",
  commodity_option: "MCX",
};

/** Today, as the local calendar date — the epoch a rate is resolved against. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface DefaultEpoch {
  segment: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  rates: Record<string, unknown>;
}

/**
 * The dated reference table, shaped into a `ChargeRates`. It is a FALLBACK,
 * never a seed: nothing here is written to `charge_config`, and the caller
 * marks the result `default-schedule` so the UI can say where it came from.
 * A segment the file does not cover returns null rather than borrowing
 * another segment's numbers.
 */
function defaultRatesFor(broker: Broker, segment: Segment, onDate: string): ChargeRates | null {
  const epochs = (defaultsJson.epochs as unknown as DefaultEpoch[]).filter(
    (e) => e.segment === segment && e.effectiveFrom <= onDate && (e.effectiveTo == null || onDate < e.effectiveTo),
  );
  const hit = epochs[epochs.length - 1];
  if (!hit) return null;
  const preset = (defaultsJson.mtfPresets as { brokers: { broker: string; annualPpm: number }[] }).brokers.find(
    (b) => b.broker === broker,
  );
  return {
    effectiveFrom: hit.effectiveFrom,
    effectiveTo: hit.effectiveTo,
    broker,
    plan: "default",
    planLabel: null,
    subscriptionMonthly: 0,
    segment,
    exchange: EXCHANGE_FOR[segment],
    ...(hit.rates as unknown as Omit<
      ChargeRates,
      | "effectiveFrom"
      | "effectiveTo"
      | "broker"
      | "plan"
      | "planLabel"
      | "subscriptionMonthly"
      | "segment"
      | "exchange"
      | "mtfInterestAnnual"
      | "mtfRateUnknown"
      | "mtfTiers"
      | "pledgeCharge"
      | "unpledgeCharge"
    >),
    mtfInterestAnnual: preset ? preset.annualPpm / 1_000_000 : 0,
    mtfRateUnknown: preset == null,
    mtfTiers: null,
    pledgeCharge: 0,
    unpledgeCharge: 0,
  };
}

export interface SizingLabData {
  capitalRupees: number;
  accountId: number;
  risk: ResolvedLiveDeskRisk;
  brokers: Broker[];
  schedules: LabSchedule[];
  ratesAsOf: string;
}

/**
 * Everything the Lab needs, resolved server-side. Exported so the loader can
 * be asserted directly against a temp database — a page whose data resolution
 * only exists inside a React component cannot be tested without rendering one.
 */
export function loadSizingLab(onDate = todayIso()): SizingLabData {
  const capital = getBucketCapital();

  const storedRow = db
    .select()
    .from(riskConfig)
    .where(and(eq(riskConfig.scope, "global"), eq(riskConfig.key, "")))
    .get();

  const risk = resolveLiveDeskRisk(
    storedRow
      ? {
          riskPctPpm: storedRow.riskPctPpm,
          stopMethod: storedRow.stopMethod,
          stopAtrLen: storedRow.stopAtrLen,
          stopAtrMultPermille: storedRow.stopAtrMultPermille,
          stopDefaultPctPpm: storedRow.stopDefaultPctPpm,
          deployCapPpm: storedRow.deployCapPpm,
          heatCeilingPpm: storedRow.heatCeilingPpm,
        }
      : null,
  );

  const map = loadRatesMap();
  const schedules: LabSchedule[] = [];
  const brokers: Broker[] = [];

  for (const broker of BROKERS) {
    let any = false;
    for (const product of LAB_PRODUCTS) {
      const segment = LAB_PRODUCT_SEGMENT[product];
      let rates: ChargeRates | null = null;
      let source: LabSchedule["source"] = "charge_config";
      try {
        rates = findRates(map, broker, segment, EXCHANGE_FOR[segment], onDate);
      } catch {
        // No configured row for this broker × segment × date. The dated
        // reference table is the stated fallback, and it is labelled as one.
        rates = defaultRatesFor(broker, segment, onDate);
        source = "default-schedule";
      }
      if (!rates) continue;
      schedules.push({ broker, segment, rates, source });
      any = true;
    }
    if (any) brokers.push(broker);
  }

  return {
    capitalRupees: capital.totalCapital,
    accountId: getSelectedAccountId(),
    risk,
    brokers,
    schedules,
    ratesAsOf: onDate,
  };
}

/** The seven `compareAll` rows for the lab's own sample setup, at a given risk. */
export { compareAll_forSample as sampleCompare };

export default function SizingLabPage() {
  const data = loadSizingLab();
  return (
    <ProGate>
      <LabClient
        capitalRupees={data.capitalRupees}
        risk={data.risk}
        brokers={data.brokers}
        schedules={data.schedules}
        ratesAsOf={data.ratesAsOf}
      />
    </ProGate>
  );
}
