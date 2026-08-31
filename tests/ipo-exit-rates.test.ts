import { describe, expect, it, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { ratesMapOf, type RatesMap } from "@/lib/engine/rates";
import { ipoSellCharges } from "@/lib/analytics/ipo";
import type { ChargeRates } from "@/lib/engine/types";

// IMPORTANT: point the DB at a throwaway file BEFORE any module imports
// @/lib/db — lib/queries/ipos pulls it in statically. chargerFor itself never
// touches the DB (the rates map is injected), so no migration is needed.
process.env.VYUHA_DB_PATH ??= path.join(os.tmpdir(), `vyuha-ipo-rates-${process.pid}-${Date.now()}.sqlite`);

/**
 * B7 — IPO exit charges must be priced at the EXIT DATE's charge_config epoch,
 * not today's. An exit sold before a rate change (the 1-Apr-2026 STT bump is
 * the live example) was being re-priced at today's rates, silently restating
 * its realised net — which flows into capital compounding.
 */

let chargerFor: typeof import("@/lib/queries/ipos").chargerFor;

beforeAll(async () => {
  ({ chargerFor } = await import("@/lib/queries/ipos"));
});

const base = (over: Partial<ChargeRates> = {}): ChargeRates =>
  ({
    broker: "zerodha",
    plan: "default",
    planLabel: null,
    subscriptionMonthly: 0,
    segment: "eq_delivery",
    exchange: "NSE",
    brokerageFlat: 0,
    brokeragePct: 0,
    brokerageCap: 0,
    brokerageFloor: 0,
    sttPct: 0.001,
    sttSide: "sell",
    exchangeTxnPct: 0,
    sebiPct: 0,
    stampPct: 0,
    ipftPct: 0,
    gstPct: 0.18,
    dpCharge: 0,
    dpPct: 0,
    dpGstApplicable: false,
    dpMinValue: 0,
    mtfInterestAnnual: 0,
    mtfRateUnknown: false,
    mtfTiers: null,
    pledgeCharge: 0,
    unpledgeCharge: 0,
    ...over,
  }) as ChargeRates;

/** STT doubles at 2026-04-01 — the only difference between the two epochs. */
function twoEpochs(): RatesMap {
  return ratesMapOf([
    base({ effectiveFrom: "1970-01-01", effectiveTo: "2026-04-01", sttPct: 0.001 }),
    base({ effectiveFrom: "2026-04-01", effectiveTo: null, sttPct: 0.002 }),
  ]);
}

describe("IPO exit charges — effective-dated rates (B7)", () => {
  it("prices the exit at the epoch in force on the EXIT DATE, not today's", () => {
    const m = twoEpochs();
    const before = chargerFor("zerodha", "NSE", "2026-03-15", m)(100000, 90000);
    const after = chargerFor("zerodha", "NSE", "2026-04-15", m)(100000, 90000);
    // Same sale, same size — only the epoch differs. Old STT 0.1% = ₹100,
    // new 0.2% = ₹200 on a ₹1,00,000 sell (STT rounds to the rupee).
    expect(after - before).toBeCloseTo(100, 2);
    expect(before).toBeCloseTo(100, 2);
  });

  it("prices a not-yet-exited IPO prospectively at today (no exit date)", () => {
    const m = twoEpochs();
    // Today is inside the open-ended 2026-04-01 epoch.
    expect(chargerFor("zerodha", "NSE", null, m)(100000, 90000)).toBeCloseTo(200, 2);
  });

  it("falls back to the static estimate when no epoch covers the exit date", () => {
    // Only an epoch from 2026-04-01 — nothing covers a 2025 exit. Substituting
    // a neighbouring epoch would invent a number; the documented fallback is
    // the pure static estimate, same as an IPO that names no broker.
    const m = ratesMapOf([base({ effectiveFrom: "2026-04-01", effectiveTo: null })]);
    expect(chargerFor("zerodha", "NSE", "2025-06-01", m)(100000, 90000)).toBe(
      ipoSellCharges(100000, 90000),
    );
  });

  it("still uses the static estimate when the IPO names no broker", () => {
    expect(chargerFor(null, "NSE", "2026-03-15", twoEpochs())(100000, 90000)).toBe(
      ipoSellCharges(100000, 90000),
    );
  });
});
