"use client";

import { inr } from "@/lib/format";

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

export function CalendarHeatmap({ daily }: { daily: Record<string, number> }) {
  const dates = Object.keys(daily).sort();
  if (dates.length === 0) {
    return <p className="text-sm text-muted-foreground">No closed trades yet.</p>;
  }
  const maxAbs = Math.max(...Object.values(daily).map((v) => Math.abs(v)), 1);

  // months present (YYYY-MM)
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].sort();

  return (
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
        return (
          <div key={ym}>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{MONTHS[m - 1]} {y}</div>
            <div className="grid grid-cols-7 gap-1">
              {WD.map((w, i) => (
                <div key={i} className="text-center text-[9px] text-muted-foreground/60">{w}</div>
              ))}
              {cells.map((c, i) =>
                c == null ? (
                  <div key={i} className="size-6" />
                ) : (
                  <div
                    key={i}
                    title={c.net != null ? `${ym}-${String(c.day).padStart(2, "0")}: ${inr(c.net)}` : `${ym}-${String(c.day).padStart(2, "0")}: no trades`}
                    className="flex size-6 items-center justify-center rounded text-[9px] tabular-nums text-foreground/70"
                    style={{ background: c.net == null ? "transparent" : colorFor(c.net, maxAbs), border: c.net == null ? "1px solid var(--color-border)" : "none" }}
                  >
                    {c.day}
                  </div>
                ),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
