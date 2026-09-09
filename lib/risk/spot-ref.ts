/**
 * R7 — the moneyness reference price, as PURE data and pure rules.
 *
 * WHY THIS FILE EXISTS AT ALL. These names were born inside
 * `components/risk/spot-mark-editor.tsx`, which is a `"use client"` module, and
 * `app/risk/page.tsx` (a server component) imported `resolveSpotRef` from it and
 * CALLED it during the server render. Next's flight loader rewrites EVERY export
 * of a client module reached from the server layer into a `registerClientReference`
 * stub whose body throws — `node_modules/next/dist/build/webpack/loaders/next-flight-loader/index.js`
 * builds exactly that proxy — so `/risk` threw at request time for any book with
 * an open F&O position ("Attempted to call resolveSpotRef() from the server but
 * resolveSpotRef is on the client"). Neither gate could see it: vitest imports the
 * raw module (no loader), and `next build` compiles the stub happily because the
 * call only happens at request time. `tests/client-value-imports.test.ts` is the
 * guard that now fails on the shape rather than on the symptom.
 *
 * PURE (invariant 2): no DB, no React, no `"use client"`. `@/lib/format` is
 * itself dependency-free, so the chip's label can be derived here rather than
 * duplicated. That purity is also load-bearing for the tests —
 * `components/risk/expiry-obligations.tsx` is imported STATICALLY by two seam
 * files, and a `lib/db` anywhere in that graph binds the connection before
 * `openTempDb()` sets `VYUHA_DB_PATH`.
 *
 * MONEY: every price here is REAL RUPEES per unit — a level, invariant 1's
 * documented REAL exception. Nothing here converts paise.
 */

import { num } from "@/lib/format";

/** Where the reference price the panel judged moneyness with came from. */
export type SpotSource = "typed" | "eod" | "none";

export interface SpotRef {
  /** The underlying's cash price in RUPEES (a per-unit price — invariant 1's
   *  documented REAL exception), or `null` when the book has neither source. */
  value: number | null;
  source: SpotSource;
  /** The EOD close's own date, when the caller knows it cheaply. */
  asOf?: string | null;
}

/** Neither a typed mark nor a close on record. */
export const UNKNOWN_SPOT: SpotRef = { value: null, source: "none" };

/** What the chip calls each source. "spot?" is kept verbatim from the badge
 *  the editor replaces — the unknown state reads the same as it always did. */
export const SPOT_SOURCE_LABEL: Record<SpotSource, string> = {
  typed: "typed",
  eod: "EOD close",
  none: "spot?",
};

/** A price of 0 or less is not a price, and `null` stays unknown (invariant 6). */
const nonZero = (n: number | null | undefined): number | null =>
  n != null && Number.isFinite(n) && n > 0 ? n : null;

/** `mtm_prices` keys its derivative rows `OPT …` / `FUT …`. A spot mark is
 *  never one of those — it belongs to the cash underlying. */
export function isContractKey(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  return s.startsWith("OPT ") || s.startsWith("FUT ");
}

/**
 * The reference price for one underlying: a TYPED MARK ALWAYS WINS, then the
 * newest end-of-day close on record, then unknown.
 *
 * The order is the ruling and it is also the only safe one: the typed mark is
 * the number the user just looked at, the close is yesterday's fact, and a
 * missing reference must stay missing rather than become 0 — a coerced zero
 * prints every put in the book as deep in-the-money.
 */
export function resolveSpotRef(
  symbol: string,
  typedMarks: ReadonlyMap<string, number>,
  eodCloses: ReadonlyMap<string, number>,
): SpotRef {
  const key = symbol.trim().toUpperCase();
  const typed = nonZero(typedMarks.get(key));
  if (typed != null) return { value: typed, source: "typed" };
  const eod = nonZero(eodCloses.get(key));
  if (eod != null) return { value: eod, source: "eod" };
  return UNKNOWN_SPOT;
}

/** What the chip reads. With NEITHER source it reads exactly what the dead
 *  badge before it read — "spot?" — so nothing about the unknown state changed
 *  except that it is now clickable. */
export function spotChipLabel(spot: SpotRef): string {
  if (spot.value == null) return SPOT_SOURCE_LABEL.none;
  return `₹${num(spot.value, 2)} · ${SPOT_SOURCE_LABEL[spot.source]}`;
}
