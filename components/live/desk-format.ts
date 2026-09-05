/**
 * THE RENDER EDGE. Paise and ppm go in; a string a human reads comes out.
 *
 * Invariant 1: money is integer paise everywhere behind this file, rupees only
 * here, and only through `Intl.NumberFormat('en-IN')`. Nothing in `lib/` may
 * import this module, and this module imports nothing from `lib/` but types.
 *
 * Invariant 6: EVERY function returns `EM_DASH` for null. Not "0", not "0.00",
 * not "N/A" — a dash is the only honest rendering of a figure whose
 * denominator does not exist, and the desk shows the reason beside it.
 *
 * A11y (spec §9): signed figures carry an explicit `+`/`−` and a direction
 * glyph, because colour alone is not a meaning (WCAG 1.4.1).
 */

import { PPM } from "@/lib/live/types";
import { EM_DASH } from "./desk-copy";

const RUPEES = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const RUPEES_2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const QTY = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 4 });

/** ₹1,23,456 — a whole-rupee amount. Paise in, en-IN grouping out. */
export function money(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return EM_DASH;
  return `₹${RUPEES.format(Math.round(paise / 100))}`;
}

/** ₹2,600.00 — a per-unit LEVEL keeps its two decimals; a level is not an amount. */
export function level(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return EM_DASH;
  return `₹${RUPEES_2.format(paise / 100)}`;
}

/** +₹1,234 / −₹1,234. The sign is part of the string, never only a colour. */
export function signedMoney(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return EM_DASH;
  const sign = paise > 0 ? "+" : paise < 0 ? "−" : "";
  return `${sign}₹${RUPEES.format(Math.abs(Math.round(paise / 100)))}`;
}

/** +1.23% from ppm. Two decimals is the resolution a ppm integer can honour. */
export function signedPct(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined || !Number.isFinite(ppm)) return EM_DASH;
  const pct = (ppm / PPM) * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

/** 1.23% — an unsigned share (heat, concentration, % of capital). */
export function pct(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined || !Number.isFinite(ppm)) return EM_DASH;
  return `${((ppm / PPM) * 100).toFixed(2)}%`;
}

/** +1.42R. R is frozen at first entry, so a null here means it was never recorded. */
export function rMultiple(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined || !Number.isFinite(ppm)) return EM_DASH;
  const r = ppm / PPM;
  const sign = r > 0 ? "+" : r < 0 ? "−" : "";
  return `${sign}${Math.abs(r).toFixed(2)}R`;
}

/** 1.8× — ATR units, carried as ×100 integers so no float ever reaches here. */
export function atrUnits(x100: number | null | undefined): string {
  if (x100 === null || x100 === undefined || !Number.isFinite(x100)) return EM_DASH;
  return `${(x100 / 100).toFixed(2)}×`;
}

/** ATR as a percentage of the mark. Both inputs paise-native; null-safe. */
export function atrPctOfMark(atrP3: number | null, markP: number | null): string {
  if (atrP3 === null || markP === null || markP <= 0) return EM_DASH;
  return `${((atrP3 / 1000 / markP) * 100).toFixed(2)}%`;
}

/** 1.42× — RVOL is a ratio in ppm, published with its denominator elsewhere. */
export function ratio(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined || !Number.isFinite(ppm)) return EM_DASH;
  return `${(ppm / PPM).toFixed(2)}×`;
}

/** Net open quantity. Fractional lots exist (partial fills), so 4 dp. */
export function qty(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH;
  return QTY.format(n);
}

/** "4 Sep" from an ISO date or an ISO datetime. Never throws on a bad input. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00+05:30` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(d);
}

/** The date part of an `asOf`, for comparing one mark's age against another's. */
export function dayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

/** ▲ / ▼ / · — a glyph beside the sign, never a colour on its own (WCAG 1.4.1). */
export function directionGlyph(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "·";
  return v > 0 ? "▲" : "▼";
}

/** The token class for a P&L figure. Reads --color-profit / --color-loss ONLY. */
export function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return "text-muted-foreground";
  return v > 0 ? "text-profit" : "text-loss";
}
