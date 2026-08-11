"use client";

import * as React from "react";
import { inr } from "@/lib/format";

/** Leading sign + rupee symbol of an already-formatted money string. `inr()`
 *  emits "₹39,701.00" and "-₹39,701.00"; `inrCompact()` emits "-₹39.7K". */
const CURRENCY_PREFIX = /^([+\-−–]?\s?₹)/;

/** v3 §2.2: the currency sign renders smaller and muted so the MAGNITUDE reads
 *  first — `<span style="font-size:.6em">-₹</span>39,701`. This only wraps the
 *  leading sign/symbol; the digits are passed through byte-for-byte, so no
 *  formatting decision moves out of `lib/format.ts`. Non-string values (a
 *  caller-composed ReactNode) are left completely alone. Lives HERE, not in
 *  kpi-card, because both components need it and kpi-card imports CountUp —
 *  the other direction would be a module cycle. */
export function quietCurrency(value: React.ReactNode): React.ReactNode {
  if (typeof value !== "string") return value;
  const m = CURRENCY_PREFIX.exec(value);
  if (!m) return value;
  return (
    <>
      <span className="text-[0.6em] font-normal text-muted-foreground">{m[1]}</span>
      {value.slice(m[1].length)}
    </>
  );
}

/**
 * C4 — animated number. Counts from 0 to `value` over ~700ms with an ease-out
 * curve; renders the final value immediately when the user prefers reduced
 * motion (or on re-renders of an unchanged value, via the settled ref).
 */
export function CountUp({
  value,
  decimals = 0,
  format = "inr",
  suffix = "",
}: {
  value: number;
  decimals?: number;
  /** "inr" | "plain", or any formatter from lib/format (inrCompact, pct, …) —
   *  a function receives the animated intermediate values too, so it must be
   *  pure and total over the [0, value] range (every lib/format one is). */
  format?: "inr" | "plain" | ((n: number) => string);
  suffix?: string;
}) {
  const [display, setDisplay] = React.useState<number>(value);
  const settled = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (settled.current === value) return;
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      settled.current = value;
      // .then keeps the write async (react-compiler set-state-in-effect rule)
      Promise.resolve().then(() => setDisplay(value));
      return;
    }
    const from = 0;
    const dur = 700;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (value - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else settled.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const text =
    typeof format === "function"
      ? format(display)
      : format === "inr"
        ? inr(display, { decimals })
        : `${display.toFixed(decimals)}${suffix}`;
  // The v3 KPI rule — currency sign smaller and muted so the magnitude reads
  // first — has to happen HERE for animated values. KpiCard can only split a
  // string it was handed, and these values arrive as a component that formats
  // itself on every frame. Skipping this is not cosmetic: Net P&L and Total
  // charges are the biggest numbers on the dashboard, so the rule would have
  // missed precisely the values it exists for. quietCurrency is a no-op on
  // strings without a leading ₹, so custom formatters get it unconditionally.
  return <span>{format === "plain" ? text : quietCurrency(text)}</span>;
}
