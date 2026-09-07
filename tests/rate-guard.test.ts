import { describe, expect, it } from "vitest";
import { createRateGuard, DEFAULT_RATE_LIMIT_PER_SECOND } from "@/lib/quotes/rate-guard";
import { createRateGuard as openAlgoRateGuard, RATE_LIMIT_PER_SECOND } from "@/lib/quotes/openalgo";
import { UPSTOX_RATE_LIMIT_PER_SECOND } from "@/lib/quotes/upstox";

/**
 * THE SHARED RATE GUARD (v4.2). One rule, two adapters, two numbers.
 *
 * The guard was OpenAlgo's private helper until Upstox needed the same policy
 * at a different ceiling. What this file holds to account is the property both
 * adapters depend on: past the ceiling it REFUSES, and a refusal is not a
 * deferral — nothing is queued, so no poll can arrive a minute late wearing a
 * "live" label.
 */

describe("createRateGuard", () => {
  it("allows exactly `limit` requests in a rolling second, then refuses", () => {
    const guard = createRateGuard(5);
    for (let i = 0; i < 5; i++) expect(guard.take(1000), `request ${i + 1} of 5`).toBe(true);
    expect(guard.take(1000), "the 6th request in the same second").toBe(false);
    // Still refused at 1,999 ms — the window is a second, not a calendar second.
    expect(guard.take(1999)).toBe(false);
    // …and the window rolls: the first stamp is a full second old at 2,000.
    expect(guard.take(2000)).toBe(true);
  });

  it("REFUSES rather than queues — a refused take leaves no debt behind", () => {
    const guard = createRateGuard(2);
    expect(guard.take(0)).toBe(true);
    expect(guard.take(0)).toBe(true);
    expect(guard.take(0)).toBe(false);
    expect(guard.take(0)).toBe(false);
    // Three refusals did NOT accumulate: one second later the budget is a full
    // 2, not 2 minus the refusals it would have owed if anything were queued.
    expect(guard.take(1000)).toBe(true);
    expect(guard.take(1000)).toBe(true);
    expect(guard.take(1000)).toBe(false);
  });

  it("defaults to OpenAlgo's number, and openalgo.ts re-exports this exact function", () => {
    expect(DEFAULT_RATE_LIMIT_PER_SECOND).toBe(RATE_LIMIT_PER_SECOND);
    // Identity, not behaviour: two copies of a refusal policy is how one of
    // them becomes a queue without anybody noticing.
    expect(openAlgoRateGuard).toBe(createRateGuard);
    const guard = openAlgoRateGuard();
    for (let i = 0; i < RATE_LIMIT_PER_SECOND; i++) expect(guard.take(1000)).toBe(true);
    expect(guard.take(1000)).toBe(false);
  });

  it("gives Upstox its own, stricter ceiling — well under the documented 50/s", () => {
    expect(UPSTOX_RATE_LIMIT_PER_SECOND).toBe(5);
    expect(UPSTOX_RATE_LIMIT_PER_SECOND).toBeLessThan(RATE_LIMIT_PER_SECOND);
    const guard = createRateGuard(UPSTOX_RATE_LIMIT_PER_SECOND);
    for (let i = 0; i < UPSTOX_RATE_LIMIT_PER_SECOND; i++) expect(guard.take(0)).toBe(true);
    expect(guard.take(0)).toBe(false);
  });
});
