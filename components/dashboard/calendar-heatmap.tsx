"use client";

import * as React from "react";
import { inr } from "@/lib/format";
import { Tip } from "@/components/ui/tooltip";
import { Flame, Snowflake, Trophy, TrendingDown } from "lucide-react";
import { streakReport } from "@/lib/analytics/daily-streaks";

const WD = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function colorFor(net: number, maxAbs: number): string {
  if (net === 0 || maxAbs === 0) return "var(--color-card-hover)";
  const intensity = Math.min(1, Math.abs(net) / maxAbs);
  const alpha = 0.18 + intensity * 0.72;
  return net > 0
    ? `color-mix(in oklab, var(--color-profit) ${Math.round(alpha * 100)}%, transparent)`
    : `color-mix(in oklab, var(--color-loss) ${Math.round(alpha * 100)}%, transparent)`;
}

/** A day cell is a BUTTON when it has P&L — the calendar is navigation. */
export function CalendarHeatmap({
  daily,
  onPickDay,
}: {
  daily: Record<string, number>;
  /** Drill-down: called with YYYY-MM-DD when a traded day is clicked. */
  onPickDay?: (date: string) => void;
}) {
  const dates = Object.keys(daily).sort();
  const streaks = React.useMemo(() => streakReport(daily), [daily]);

  if (dates.length === 0) {
    return <p className="text-sm text-muted-foreground">No closed trades yet.</p>;
  }
  const maxAbs = Math.max(...Object.values(daily).map((v) => Math.abs(v)), 1);
  // Local date, not toISOString() — that is UTC and mislabels "today" for the
  // first 5.5 hours of every IST day.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].sort();

  return (
    <div className="space-y-3">
      {/* ── Streaks & records ─────────────────────────────────────────────
          Consecutive TRADED days, not calendar days — a weekend or a day off
          neither extends nor breaks a run (lib/analytics/daily-streaks). */}
      <div className="flex flex-wrap gap-2 text-[0.6875rem]">
        {streaks.currentGreen > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-profit/10 px-2 py-0.5 text-profit">
            <Flame className="size-3" /> {streaks.currentGreen} green day{streaks.currentGreen === 1 ? "" : "s"} running
          </span>
        )}
        {streaks.currentRed > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-loss/10 px-2 py-0.5 text-loss">
            <Snowflake className="size-3" /> {streaks.currentRed} red day{streaks.currentRed === 1 ? "" : "s"} running
          </span>
        )}
        <span className="inline-flex items-center gap-1 rounded-full bg-card-hover px-2 py-0.5 text-muted-foreground">
          best run <b className="text-foreground">{streaks.bestGreen}</b> · worst <b className="text-foreground">{streaks.worstRed}</b>
        </span>
        {streaks.best && streaks.best.net > 0 && (
          <Tip label={`Best day — ${streaks.best.date}`}>
            <button
              type="button"
              onClick={() => onPickDay?.(streaks.best!.date)}
              className="inline-flex items-center gap-1 rounded-full bg-card-hover px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <Trophy className="size-3 text-profit" /> best <b className="text-profit">{inr(streaks.best.net, { decimals: 0 })}</b>
            </button>
          </Tip>
        )}
        {streaks.worst && streaks.worst.net < 0 && (
          <Tip label={`Worst day — ${streaks.worst.date}`}>
            <button
              type="button"
              onClick={() => onPickDay?.(streaks.worst!.date)}
              className="inline-flex items-center gap-1 rounded-full bg-card-hover px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <TrendingDown className="size-3 text-loss" /> worst <b className="text-loss">{inr(streaks.worst.net, { decimals: 0 })}</b>
            </button>
          </Tip>
        )}
        <span className="inline-flex items-center gap-1 rounded-full bg-card-hover px-2 py-0.5 text-muted-foreground">
          {streaks.greenDays}G / {streaks.redDays}R
          {streaks.flatDays > 0 && ` / ${streaks.flatDays} flat`} over {streaks.tradedDays} traded days
        </span>
      </div>

      <div className="flex flex-wrap gap-6">
        {months.map((ym) => {
          const [y, m] = ym.split("-").map(Number);
          const first = new Date(y, m - 1, 1);
          const daysInMonth = new Date(y, m, 0).getDate();
          const startWd = first.getDay();
          const cells: ({ day: number; net: number | null } | null)[] = [];
          for (let i = 0; i < startWd; i++) cells.push(null);
          for (let d = 1; d <= daysInMonth; d++) {
            const key = `${ym}-${String(d).padStart(2, "0")}`;
            cells.push({ day: d, net: key in daily ? daily[key] : null });
          }
          // Month total, so a glance answers "was this month green?"
          const monthNet = cells.reduce((s, c) => s + (c?.net ?? 0), 0);
          return (
            <div key={ym}>
              <div className="mb-1.5 flex items-baseline gap-1.5 text-xs">
                <span className="font-medium text-muted-foreground">{MONTHS[m - 1]} {y}</span>
                <span className={`tabular-nums ${monthNet > 0 ? "text-profit" : monthNet < 0 ? "text-loss" : "text-muted-foreground"}`}>
                  {inr(monthNet, { decimals: 0 })}
                </span>
              </div>
              <div className="grid grid-cols-7 gap-1">
                {WD.map((w, i) => (
                  <div key={i} className="text-center text-[9px] text-muted-foreground/60">{w}</div>
                ))}
                {cells.map((c, i) => {
                  if (c == null) return <div key={i} className="size-6" />;
                  const key = `${ym}-${String(c.day).padStart(2, "0")}`;
                  const isToday = key === today;
                  const traded = c.net != null;
                  const isBest = streaks.best?.date === key && streaks.best.net > 0;
                  const isWorst = streaks.worst?.date === key && streaks.worst.net < 0;
                  const dayBtn = (
                    <button
                      key={i}
                      type="button"
                      disabled={!traded}
                      onClick={() => traded && onPickDay?.(key)}
                      // Untraded cells are disabled — no pointer events, so a
                      // Radix tip would never open there; the native title stays.
                      title={traded ? undefined : `${key}: no trades`}
                      className={`relative flex size-6 items-center justify-center rounded-md text-[9px] tabular-nums text-foreground/70 transition-transform duration-100 ${
                        traded ? "cursor-pointer hover:scale-110 hover:text-foreground" : "cursor-default"
                      } ${isToday ? "ring-1 ring-primary ring-offset-1 ring-offset-card" : ""}`}
                      style={{
                        background: traded ? colorFor(c.net!, maxAbs) : "transparent",
                        border: traded ? "none" : "1px solid var(--color-border)",
                      }}
                    >
                      {c.day}
                      {/* Records get a corner dot rather than a colour change —
                          the colour already encodes magnitude. */}
                      {(isBest || isWorst) && (
                        <span
                          className={`absolute -right-0.5 -top-0.5 size-1.5 rounded-full ${isBest ? "bg-profit" : "bg-loss"}`}
                        />
                      )}
                    </button>
                  );
                  return traded ? (
                    <Tip key={i} label={`${key}: ${inr(c.net!)} — click for the trades`}>
                      {dayBtn}
                    </Tip>
                  ) : (
                    dayBtn
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
