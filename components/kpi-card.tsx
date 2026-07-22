"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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
  sub,
  valueClassName,
  icon,
  spark,
  delta,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClassName?: string;
  icon?: React.ReactNode;
  /** Optional trend series — rendered as a small area sparkline on the right. */
  spark?: number[];
  /** Optional ▲/▼ change chip under the value. */
  delta?: KpiDelta;
  /** Optional drill-down — makes the card clickable and glow on hover. */
  detail?: KpiDetail;
}) {
  const sparkPositive = spark && spark.length >= 2 ? spark[spark.length - 1] >= spark[0] : true;
  const [open, setOpen] = React.useState(false);
  const clickable = !!detail;

  const card = (
    <Card
      className={cn(
        "p-4",
        clickable &&
          "cursor-pointer transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-[var(--shadow-card-hover),0_0_26px_-8px_color-mix(in_oklab,var(--color-primary)_55%,transparent)] focus-visible:outline-none focus-visible:border-primary/60",
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
        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </div>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
        <div className={cn("mt-2 whitespace-nowrap font-mono text-[1.65rem] font-light leading-none tracking-tight tabular-nums", valueClassName)}>
          {value}
        </div>
        {spark && <Sparkline points={spark} positive={sparkPositive} />}
      </div>
      {delta && (
        <div className="mt-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
              delta.value > 0 && "bg-profit/10 text-profit",
              delta.value < 0 && "bg-loss/10 text-loss",
              delta.value === 0 && "bg-card-hover text-muted-foreground",
            )}
          >
            {delta.value > 0 ? "▲" : delta.value < 0 ? "▼" : "—"} {delta.formatted}
            <span className="font-normal text-muted-foreground">{delta.label}</span>
          </span>
        </div>
      )}
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
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
          {detail.note && <p className="text-[11px] text-muted-foreground">{detail.note}</p>}
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
