"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { CountUp, quietCurrency } from "@/components/ui/count-up";
import { inr, inrCompact, num, pct } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Named formatters for `format` — a STRING key, not a function, because most
 *  KpiCard call sites are server components and a function prop cannot cross
 *  the RSC serialization boundary. Add a key here rather than passing a
 *  lambda from a page. */
const KPI_FORMATTERS = {
  /** inr()'s own default — 2 decimals. Matches a bare `inr(x)` call site. */
  inr: (n: number) => inr(n),
  /** Whole rupees — matches `inr(x, { decimals: 0 })`, the most common money
   *  pattern on KPI cards. */
  inr0: (n: number) => inr(n, { decimals: 0 }),
  /** Rupees with paise, spelled explicitly. */
  inr2: (n: number) => inr(n, { decimals: 2 }),
  /** "₹39.7K" / "₹1.2Cr". */
  inrCompact: (n: number) => inrCompact(n),
  /** "12.34%". */
  pct: (n: number) => pct(n),
  /** "12.3%". */
  pct1: (n: number) => pct(n, 1),
  /** "63%" — whole-point percentage. */
  pct0: (n: number) => pct(n, 0),
  /** Plain number, 2 decimals (R multiples, ratios). */
  num: (n: number) => num(n),
  /** Plain integer (counts). */
  int: (n: number) => num(n, 0),
} as const;
export type KpiFormat = keyof typeof KPI_FORMATTERS;

// Re-exported so existing `import { quietCurrency } from "@/components/kpi-card"`
// call sites keep working; the implementation moved to count-up.tsx to break
// the kpi-card ↔ count-up module cycle.
export { quietCurrency };

/** Tiny dependency-free sparkline — pure SVG so it renders in server components. */
function Sparkline({ points, positive }: { points: number[]; positive: boolean }) {
  if (points.length < 2) return null;
  const w = 72;
  const h = 26;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const xy = points.map((p, i) => `${(i * step).toFixed(1)},${(h - 2 - ((p - min) / span) * (h - 4)).toFixed(1)}`);
  const color = positive ? "var(--color-profit)" : "var(--color-loss)";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <defs>
        <linearGradient id={`spark-${positive ? "p" : "n"}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${xy.join(" ")} ${w},${h}`} fill={`url(#spark-${positive ? "p" : "n"})`} />
      <polyline points={xy.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** One line inside a KPI drill-down. Plain strings so the whole detail object
 *  stays serializable from server components. */
export interface KpiDetailRow {
  label: string;
  value: string;
  tone?: "profit" | "loss" | "neutral";
  hint?: string;
  /** Makes the row clickable — e.g. a "worst day" row linking to that day's
   *  trades. Turns the popup from an explanation into a place to go next. */
  href?: string;
}

/** Attach to a KpiCard to make it clickable — the card then opens a popup that
 *  explains what the number is actually made of. */
export interface KpiDetail {
  title: string;
  summary?: string;
  rows: KpiDetailRow[];
  note?: string;
  /** Optional call-to-action at the foot of the popup. */
  footerHref?: string;
  footerLabel?: string;
}

export interface KpiDelta {
  value: number; // signed change (display sign comes from this)
  label: string; // e.g. "vs last week"
  /** Formatted magnitude, e.g. "₹12.4K" — sign/arrow are added automatically. */
  formatted: string;
}

export function KpiCard({
  label,
  value,
  valueNum,
  format,
  sub,
  valueClassName,
  icon,
  spark,
  delta,
  detail,
  hero = false,
}: {
  label: string;
  /** Pre-formatted value. Ignored when `valueNum` is given. */
  value?: React.ReactNode;
  /** C10 rollout — pass the RAW number instead of a formatted string and the
   *  card animates it with CountUp (reduced-motion renders it instantly).
   *  Pair with `format` for anything that isn't whole-rupee INR. */
  valueNum?: number;
  /** Named formatter for `valueNum` (see KPI_FORMATTERS). A string key so
   *  server components can use it. Defaults to whole-rupee "inr". */
  format?: KpiFormat;
  sub?: React.ReactNode;
  valueClassName?: string;
  icon?: React.ReactNode;
  /** Optional trend series — rendered as a small area sparkline on the right. */
  spark?: number[];
  /** Optional ▲/▼ change chip under the value. */
  delta?: KpiDelta;
  /** Optional drill-down — makes the card clickable and glow on hover. */
  detail?: KpiDetail;
  /** v3 hero treatment — teal wash, teal border, glow. **One per screen at
   *  most** (§3): the point is that a single number outranks the band, and two
   *  heroes rank nothing. Off by default, so every existing call site is
   *  unchanged. */
  hero?: boolean;
}) {
  const sparkPositive = spark && spark.length >= 2 ? spark[spark.length - 1] >= spark[0] : true;
  const [open, setOpen] = React.useState(false);
  const clickable = !!detail;

  const card = (
    <Card
      className={cn(
        "p-4",
        // `card-hero` supplies the teal wash (via --panel-wash, the only layer
        // that survives panel-luxe — see globals.css). Its border-color and
        // box-shadow do NOT survive: Card's own `border-border` /
        // `shadow-[var(--shadow-card)]` are generated utilities and outrank a
        // custom @utility, so the border and glow are restated here where
        // tailwind-merge can drop Card's versions.
        hero && "card-hero border-primary/35 shadow-[var(--shadow-hero)]",
        clickable &&
          "cursor-pointer transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-[var(--shadow-card-hover),0_0_26px_-8px_color-mix(in_oklab,var(--color-primary)_55%,transparent)] focus-visible:outline-none focus-visible:border-primary/60 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
      )}
      {...(clickable
        ? {
            role: "button" as const,
            tabIndex: 0,
            title: `${label} — click for the breakdown`,
            onClick: () => setOpen(true),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpen(true);
              }
            },
          }
        : {})}
    >
      <div className="flex items-center justify-between">
        {/* 10px caps at .16em (v3 §3). px, not rem: below ~11px a tracked-out
            label is a graphic element, and letting density scale it to 10.6px
            only blurs the cap height. */}
        <div className="text-[10.5px] font-medium uppercase tracking-[0.13em] text-muted-foreground">
          {label}
        </div>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
        {/* 1.65rem = 26.4px, inside the 23–28px band, and it tracks the
            comfortable-density root. `whitespace-nowrap` is MANDATORY: without
            it a long value breaks between the sign and the first digit. */}
        <div className={cn("mt-2 whitespace-nowrap font-mono text-[1.65rem] font-light leading-none tracking-tight tabular-nums", valueClassName)}>
          {valueNum !== undefined ? (
            // CountUp applies quietCurrency itself, per frame.
            <CountUp value={valueNum} format={KPI_FORMATTERS[format ?? "inr"]} />
          ) : (
            quietCurrency(value)
          )}
        </div>
        {spark && <Sparkline points={spark} positive={sparkPositive} />}
      </div>
      {delta && (
        <div className="mt-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--radius-pill)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
              delta.value > 0 && "bg-profit/10 text-profit",
              delta.value < 0 && "bg-loss/10 text-loss",
              delta.value === 0 && "bg-card-hover text-muted-foreground",
            )}
          >
            {delta.value > 0 ? "▲" : delta.value < 0 ? "▼" : "—"} {delta.formatted}
            <span className="whitespace-nowrap font-normal text-muted-foreground">{delta.label}</span>
          </span>
        </div>
      )}
      {/* 11px sub-line (v3 §3) — rem so both densities scale it. */}
      {sub && <div className="mt-1 text-[0.6875rem] leading-snug text-muted-foreground">{sub}</div>}
      {clickable && (
        <div className="mt-2 text-[10px] text-muted-foreground/70 transition-colors group-hover:text-primary">
          click for breakdown →
        </div>
      )}
    </Card>
  );

  if (!clickable) return card;
  return (
    <>
      {card}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{detail.title}</DialogTitle>
            {detail.summary && <DialogDescription>{detail.summary}</DialogDescription>}
          </DialogHeader>
          <div className="divide-y divide-border/50">
            {detail.rows.map((r, i) => {
              const body = (
                <>
                  <div>
                    <div className={cn("text-xs", r.href && "text-accent underline-offset-2 group-hover/row:underline")}>
                      {r.label}
                      {r.href && <span className="ml-1 text-[10px]">→</span>}
                    </div>
                    {r.hint && <div className="text-[10px] text-muted-foreground">{r.hint}</div>}
                  </div>
                  <div
                    className={cn(
                      "shrink-0 font-mono text-sm tabular-nums",
                      r.tone === "profit" && "text-profit",
                      r.tone === "loss" && "text-loss",
                    )}
                  >
                    {r.value}
                  </div>
                </>
              );
              return r.href ? (
                <Link
                  key={i}
                  href={r.href}
                  className="group/row flex items-baseline justify-between gap-4 py-2 transition-colors hover:bg-card-hover/60"
                  onClick={() => setOpen(false)}
                >
                  {body}
                </Link>
              ) : (
                <div key={i} className="flex items-baseline justify-between gap-4 py-2">{body}</div>
              );
            })}
          </div>
          {detail.note && <p className="text-[0.6875rem] text-muted-foreground">{detail.note}</p>}
          {detail.footerHref && (
            <Link
              href={detail.footerHref}
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:border-primary/50 hover:text-primary"
            >
              {detail.footerLabel ?? "Show me the trades"} →
            </Link>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
