"use client";

import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clampIntensity } from "@/lib/domain/appearance";

/** Owner decision: two named presets AND ±10 steps on a 0–100 slider. */
export const TINT_PRESETS = [
  { label: "Subtle", value: 25 },
  { label: "Balanced", value: 50 },
  { label: "Vivid", value: 75 },
] as const;
const STEP = 10;

/**
 * Tint intensity — how far the chosen skin's hue soaks into the chrome
 * (canvas, cards, borders). Purely presentational: the parent owns the value
 * and applies the live preview, because the preview REPLACES the whole inline
 * var set and must therefore know about the wallpaper and custom theme too.
 */
export function TintControl({
  value,
  onChange,
  disabledReason,
}: {
  value: number;
  onChange: (next: number) => void;
  /** When set, the control is inert and this line explains why. */
  disabledReason?: string | null;
}) {
  const disabled = Boolean(disabledReason);
  const set = (n: number) => onChange(clampIntensity(n));
  return (
    <div className="space-y-2" data-testid="tint-control">
      <div className="flex items-center justify-between">
        <Label htmlFor="tint-intensity">Tint intensity</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Less tint"
          disabled={disabled || value <= 0}
          onClick={() => set(value - STEP)}
        >
          −
        </Button>
        <input
          id="tint-intensity"
          type="range"
          min={0}
          max={100}
          step={STEP}
          value={value}
          disabled={disabled}
          onChange={(e) => set(Number(e.target.value))}
          className="h-2 w-full flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="More tint"
          disabled={disabled || value >= 100}
          onClick={() => set(value + STEP)}
        >
          +
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {TINT_PRESETS.map((p) => {
          const active = value === p.value;
          return (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => set(p.value)}
              className={cn(
                "rounded-[var(--radius-pill)] border px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                active
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {disabledReason ??
          "How much of the skin's hue soaks into the canvas, cards and borders. Text and P&L colours never move."}
      </p>
    </div>
  );
}
