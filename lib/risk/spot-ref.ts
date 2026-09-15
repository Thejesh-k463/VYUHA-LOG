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
// TYPE-ONLY: lib/domain/dismissals.ts imports node:crypto, and this module is
// read by two client components. A type import is erased at compile time.
import type { DismissiblePanel } from "@/lib/domain/dismissals";

/**
 * Where the reference price the panel judged moneyness with came from.
 *
 * R13 — "mark", never "typed". `mtm_prices` cannot tell a number the user typed
 * from a bhavcopy auto-MTM row or a live-feed mark: all three are the same row
 * shape under the same symbol, so a chip that said "typed" claimed something
 * the database cannot back.
 */
export type SpotSource = "mark" | "eod" | "none";

/** A per-unit price and the day it belongs to (ISO `YYYY-MM-DD`). */
export interface DatedPrice {
  /** RUPEES per unit — invariant 1's documented REAL exception. */
  price: number;
  asOf: string;
}

export interface SpotRef {
  /** The underlying's cash price in RUPEES (a per-unit price — invariant 1's
   *  documented REAL exception), or `null` when the book has neither source. */
  value: number | null;
  source: SpotSource;
  /** The day `value` belongs to: the mark's own day, or the close's own day. */
  asOf?: string | null;
  /** With a stored mark only: the newest end-of-day close on record, when there
   *  is one, so the row can say when a newer official close differs (R13). */
  close?: DatedPrice;
}

/** Neither a stored mark nor a close on record. */
export const UNKNOWN_SPOT: SpotRef = { value: null, source: "none" };

/** What the chip calls each source. "spot?" is kept verbatim from the badge
 *  the editor replaces — the unknown state reads the same as it always did. */
export const SPOT_SOURCE_LABEL: Record<SpotSource, string> = {
  mark: "mark",
  eod: "EOD close",
  none: "spot?",
};

/** A price of 0 or less is not a price, and `null` stays unknown (invariant 6). */
const nonZero = (n: number | null | undefined): number | null =>
  n != null && Number.isFinite(n) && n > 0 ? n : null;

const datedNonZero = (d: DatedPrice | null | undefined): DatedPrice | null => {
  const price = nonZero(d?.price);
  return price != null && d?.asOf ? { price, asOf: d.asOf } : null;
};

/** `mtm_prices` keys its derivative rows `OPT …` / `FUT …`. A spot mark is
 *  never one of those — it belongs to the cash underlying. */
export function isContractKey(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  return s.startsWith("OPT ") || s.startsWith("FUT ");
}

/** A real calendar day written `YYYY-MM-DD` (2026-02-30 is not one). */
export function isIsoDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * The reference price for one underlying: the STORED MARK WINS, then the
 * newest end-of-day close on record, then unknown.
 *
 * The order is the ruling (225) and it is also the only safe one: a missing
 * reference must stay missing rather than become 0 — a coerced zero prints
 * every put in the book as deep in-the-money. The mark wins EVEN WHEN IT IS
 * OLDER than the close (R13): the page never swaps the number silently; the
 * row says so through `spotCloseNotice`, and the user picks.
 */
export function resolveSpotRef(
  symbol: string,
  marks: ReadonlyMap<string, DatedPrice>,
  eodCloses: ReadonlyMap<string, DatedPrice>,
): SpotRef {
  const key = symbol.trim().toUpperCase();
  const mark = datedNonZero(marks.get(key));
  const close = datedNonZero(eodCloses.get(key));
  if (mark != null) {
    return close != null
      ? { value: mark.price, source: "mark", asOf: mark.asOf, close }
      : { value: mark.price, source: "mark", asOf: mark.asOf };
  }
  if (close != null) return { value: close.price, source: "eod", asOf: close.asOf };
  return UNKNOWN_SPOT;
}

/**
 * Does the official close say something the mark does not? (R13)
 *
 *  - a mark NEWER than the close → false: today's mark (typed or live) is the
 *    fresher number, and an older close has nothing to add to it;
 *  - otherwise (a LATER close, or one on the SAME day) → true ONLY when the two
 *    prices differ at the paisa.
 *
 * N23 (fix wave 2R): a later close at the SAME price used to return true, and
 * the row then printed "differs from your mark ₹800.00" over ₹800.00 — a false
 * sentence. The owner's own R13 intent is "if the user marks a different price
 * than the closing price", so equal prices never raise the notice, whatever the
 * days (docs/DECISIONS.md 2026-09-15, N23).
 *
 * ISO days compare correctly as strings. Prices are REAL rupees per unit; the
 * paise are `shownPaise` — a comparison at the paisa AS DISPLAYED, not a stored
 * conversion (invariant 1).
 */
export function closeDiffers(mark: DatedPrice, close: DatedPrice): boolean {
  if (close.asOf < mark.asOf) return false;
  return shownPaise(mark.price) !== shownPaise(close.price);
}

/**
 * The whole paise a per-unit price SHOWS as — the ONE rounding that
 * `closeDiffers` compares, the notice sentence prints and the "Keep my mark"
 * fingerprint keys on.
 *
 * L8 (fix wave 2G): the comparison used `Math.round(price * 100)` on the binary
 * double while the sentence formatted with `num` (Intl). The two disagree on a
 * price whose ×100 lands just under .5: 1.005 × 100 is 100.49999999999999, so
 * the comparison read 100 paise while the screen read "1.01" — and a mark of
 * 1.005 against a close of 1.01 printed "differs from your mark ₹1.01" over
 * ₹1.01 (the N23 symptom class). Deriving the paise FROM `num`'s own output
 * makes compare and display one rounding by construction, whatever Intl does.
 *
 * DISPLAY/COMPARE ROUNDING ONLY: the price itself stays REAL rupees per unit
 * (invariant 1's documented exception); nothing here is stored. `num` groups
 * en-IN ("1,23,456.79"), so the separators are dropped before reading it back.
 */
export function shownPaise(price: number): number {
  return Math.round(Number(num(price, 2).replace(/,/g, "")) * 100);
}

/** The panel a "Keep my mark" dismissal is filed under (`panel_dismissals`). */
export const SPOT_CLOSE_DIFF_PANEL = "spot-close-diff" as const satisfies DismissiblePanel;

/**
 * ONE dismissal PER SYMBOL, keyed on the close it was shown for:
 * `${SYMBOL}|${close day}|${close in paise}`. A newer close changes the day and
 * a corrected close changes the paise — either way the fingerprint moves and
 * the notice returns.
 */
export function spotCloseFingerprint(symbol: string, close: DatedPrice): string {
  return `${symbol.trim().toUpperCase()}|${close.asOf}|${shownPaise(close.price)}`;
}

export interface SpotCloseNotice {
  /** "Official close <day>: ₹X — differs from your mark ₹Y" — descriptive only. */
  text: string;
  close: DatedPrice;
  fingerprint: string;
}

/**
 * The line the row and the editor print when a newer (or same-day) official
 * close disagrees with the stored mark at the paisa — or null when there is nothing
 * to say, or when the user kept the mark against THIS close.
 */
export function spotCloseNotice(
  symbol: string,
  spot: SpotRef,
  dismissedFingerprints: readonly string[] = [],
): SpotCloseNotice | null {
  if (spot.source !== "mark" || spot.value == null || !spot.asOf || !spot.close) return null;
  if (!closeDiffers({ price: spot.value, asOf: spot.asOf }, spot.close)) return null;
  const fingerprint = spotCloseFingerprint(symbol, spot.close);
  if (dismissedFingerprints.includes(fingerprint)) return null;
  // L8: the sentence prints the SAME paise `closeDiffers` just compared.
  return {
    text: `Official close ${spot.close.asOf}: ₹${num(shownPaise(spot.close.price) / 100, 2)} — differs from your mark ₹${num(shownPaise(spot.value) / 100, 2)}`,
    close: spot.close,
    fingerprint,
  };
}

/** What the chip reads: "₹X · mark · <day>" or "₹X · EOD close · <day>". With
 *  NEITHER source it reads exactly what the dead badge before it read —
 *  "spot?" — so nothing about the unknown state changed except that it is now
 *  clickable. The day stays ISO, so the server render and the client agree. */
export function spotChipLabel(spot: SpotRef): string {
  if (spot.value == null) return SPOT_SOURCE_LABEL.none;
  const day = spot.asOf ? ` · ${spot.asOf}` : "";
  return `₹${num(spot.value, 2)} · ${SPOT_SOURCE_LABEL[spot.source]}${day}`;
}
