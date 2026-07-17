"use client";

import * as React from "react";
import { inr } from "@/lib/format";

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
  format?: "inr" | "plain";
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
    format === "inr" ? inr(display, { decimals }) : `${display.toFixed(decimals)}${suffix}`;
  return <span>{text}</span>;
}
