/**
 * THE SELF-IMPOSED RATE GUARD — PURE (no DB, no React, no clock of its own).
 *
 * Extracted in v4.2 from `lib/quotes/openalgo.ts`, unchanged, because the
 * Upstox adapter needs exactly the same rule at a different number and two
 * copies of a refusal policy is how one of them quietly becomes a queue.
 *
 * IT REFUSES, IT NEVER QUEUES. That is the whole design and it is the same
 * reasoning in both adapters: a refusal is one visible error on one poll,
 * while a queue would hand the desk a price from a minute ago and let the UI
 * call it live. Nothing here retries, sleeps or buffers.
 *
 * The window is rolling and the clock is an ARGUMENT — `take(now)` — so the
 * behaviour is exact in a test instead of timing-dependent.
 */

/** OpenAlgo's own documented ceiling is 50 req/s; Vyuha caps itself at a fifth. */
export const DEFAULT_RATE_LIMIT_PER_SECOND = 10;

export interface RateGuard {
  /** True when the request may go. False means REFUSE — never "try later". */
  take(now: number): boolean;
}

/** A rolling one-second window. Refuses the request past `limit`, never queues it. */
export function createRateGuard(limit = DEFAULT_RATE_LIMIT_PER_SECOND): RateGuard {
  const stamps: number[] = [];
  return {
    take(now: number): boolean {
      while (stamps.length > 0 && now - stamps[0] >= 1000) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(now);
      return true;
    },
  };
}
