// P0.1 — Money as integer paise (PURE).
//
// Institutions reconcile to the paisa; binary floats drift (0.1 + 0.2 ≠ 0.3).
// The fix is to keep money as an INTEGER number of paise and only convert to
// rupees at the edges (parsers in, formatting out). This module is the single
// place money arithmetic lives. New subsystems (e.g. the cash ledger, P0.2)
// store and compute in paise; existing REAL columns migrate onto this gradually.
//
//   ₹1 = 100 paise.  A `Paise` value is always an integer.

/** An integer number of paise. (Type alias — discipline, not a hard brand.) */
export type Paise = number;

/** Rupees (possibly fractional) → integer paise, rounded to the nearest paisa. */
export function toPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

/** Integer paise → rupees (may be fractional). For formatting/UI only. */
export function toRupees(paise: Paise): number {
  return paise / 100;
}

/** Parse a money string ("1,380.55", "₹1380.5", "-200") to paise. */
export function parsePaise(s: string | number | null | undefined): Paise {
  if (s == null) return 0;
  if (typeof s === "number") return toPaise(s);
  const n = Number(s.replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? toPaise(n) : 0;
}

export const addP = (...vals: Paise[]): Paise => vals.reduce((a, b) => a + b, 0);
export const subP = (a: Paise, b: Paise): Paise => a - b;
export const sumP = (vals: Paise[]): Paise => vals.reduce((a, b) => a + b, 0);

/** Multiply paise by a (possibly fractional) factor, rounding back to whole paise. */
export const mulP = (paise: Paise, factor: number): Paise => Math.round(paise * factor);

/** Apply a percentage given as a fraction (0.001 = 0.1%), rounded to whole paise. */
export const pctP = (paise: Paise, fraction: number): Paise => Math.round(paise * fraction);

/** Statutory rounding to the nearest whole rupee, expressed back in paise. */
export const roundRupee = (paise: Paise): Paise => Math.round(paise / 100) * 100;

/** Absolute value, keeping integer-paise. */
export const absP = (paise: Paise): Paise => Math.abs(paise);

/** Format paise as INR. Delegates to the locale formatter on the rupee value. */
export function formatPaise(paise: Paise, opts?: { decimals?: number }): string {
  const decimals = opts?.decimals ?? 2;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(toRupees(paise));
}
