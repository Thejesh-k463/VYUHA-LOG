"use client";

import * as React from "react";

/**
 * Mount children only once they are near the viewport.
 *
 * ── Why /strategies needed this ───────────────────────────────────────────
 *
 * recharts' `ResponsiveContainer` starts at width/height -1 and renders NOTHING
 * until its ResizeObserver reports a real size. So 626 payoff charts emitted
 * zero server HTML, then all 626 mounted in one commit after hydration — 626
 * ResizeObservers and 626 SVGs built at once, for a page showing about two
 * cards at a time. That storm was the whole of /strategies' 6.0 s.
 *
 * Nothing about the DATA changes: every strategy is still computed, grouped and
 * rendered. Only the SVG construction is deferred until you scroll to it.
 *
 * ── Two deliberate choices ────────────────────────────────────────────────
 *
 * `minHeight` is required, not optional. Without it the placeholder collapses,
 * every card below jumps up, the observer fires for all of them at once, and
 * the storm returns — with layout shift on top.
 *
 * If `IntersectionObserver` is unavailable (jsdom, a very old browser) the
 * children are mounted immediately. A chart that never appears is far worse
 * than a chart that costs something, and the failure would be silent.
 *
 * The state is set from an observer callback, and the fallback goes through a
 * microtask rather than a synchronous set inside the effect — the repo bans
 * `react-hooks/set-state-in-effect` outright, and `Promise.resolve().then`
 * is the accepted one-shot pattern here (see AGENTS.md).
 */
export function LazyMount({
  minHeight,
  children,
  rootMargin = "600px",
}: {
  minHeight: number;
  children: React.ReactNode;
  rootMargin?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === "undefined") {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) setShown(true);
      });
      return () => {
        cancelled = true;
      };
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rootMargin]);

  return (
    <div ref={ref} style={{ minHeight }}>
      {shown ? children : null}
    </div>
  );
}
