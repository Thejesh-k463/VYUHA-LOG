"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CUSTOM_THEME_FIELDS,
  CUSTOM_THEME_FIELD_META,
  DEFAULT_CUSTOM_THEME,
  NEUTRAL_CHROME,
  contrastRatio,
  customThemeWarnings,
  normalizeHex,
  type CustomTheme,
  type CustomThemeField,
  type Theme,
} from "@/lib/domain/appearance";
import { SKIN_META, type Skin } from "@/lib/domain/skin";
import { sampleSkinSide } from "./live-preview";

/**
 * Two columns (Dark / Light) × seven rows, each a native colour picker plus a
 * hex box. The parent owns the CustomTheme value and the live preview; this
 * only edits it. Contrast is ADVICE (amber badge), never a gate — the user
 * owns a custom theme, but the picker should say when a pair falls under the
 * WCAG floor customThemeWarnings uses (4.5 for accents on canvas, 7 for text).
 */
export function CustomThemeBuilder({
  value,
  onChange,
  activeTheme,
  sourceSkin,
  intensity,
}: {
  value: CustomTheme;
  onChange: (next: CustomTheme) => void;
  /** Which side is on screen right now — the column marked "previewing". */
  activeTheme: Theme;
  /** The last built-in skin picked, the seed for "Start from …". */
  sourceSkin: Skin;
  intensity: number;
}) {
  const warnings = customThemeWarnings(value);
  const warned = (side: Theme, field: CustomThemeField | "foreground") =>
    warnings.find((w) => w.side === side && w.field === field);

  function set(side: Theme, field: CustomThemeField, hex: string) {
    onChange({ ...value, [side]: { ...value[side], [field]: hex } });
  }

  function startFrom() {
    // Sample BOTH sides so the light column is not left holding whatever it had.
    const dark = sampleSkinSide(sourceSkin, "dark", intensity, value.dark);
    const light = sampleSkinSide(sourceSkin, "light", intensity, value.light);
    onChange({ dark, light });
  }

  const sourceLabel = SKIN_META[sourceSkin].label;

  return (
    <div className="space-y-3 rounded-md border border-border bg-card-hover/40 p-3" data-testid="custom-theme-builder">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Custom theme</div>
          <div className="text-xs text-muted-foreground">
            Seven colours per theme. Changes preview at once on the{" "}
            <span className="text-foreground">{activeTheme}</span> side; nothing is kept until you save.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={startFrom} title={`Seed every field from ${sourceLabel}'s current colours`}>
            Start from {sourceLabel}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(DEFAULT_CUSTOM_THEME)}>
            Reset to default
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {(["dark", "light"] as const).map((side) => (
          <div key={side} className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="capitalize">{side}</Label>
              {side === activeTheme && (
                <span className="rounded-[var(--radius-pill)] border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                  previewing
                </span>
              )}
            </div>
            {CUSTOM_THEME_FIELDS.map((field) => (
              <ColorRow
                key={field}
                side={side}
                field={field}
                hex={value[side][field]}
                onChange={(hex) => set(side, field, hex)}
                badge={badgeFor(value, side, field, warned)}
              />
            ))}
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <p className="text-xs text-warning">
          {warnings.length} pair{warnings.length === 1 ? "" : "s"} under the contrast floor — saved anyway, but expect
          hard-to-read text or buttons there.
        </p>
      )}
    </div>
  );
}

interface Badge {
  ratio: number;
  floor: number;
  under: boolean;
  what: string;
}

/**
 * The badge per row: accent/analytics/money are measured against the canvas
 * (floor 4.5); canvas / sidebar / card are measured with the theme's body
 * text on them (floor 7). Border has no meaningful pair, so no badge.
 */
function badgeFor(
  value: CustomTheme,
  side: Theme,
  field: CustomThemeField,
  warned: (side: Theme, field: CustomThemeField | "foreground") => { ratio: number; floor: number } | undefined,
): Badge | null {
  const s = value[side];
  if (field === "accent" || field === "analytics" || field === "money") {
    const ratio = contrastRatio(s[field], s.background);
    return { ratio, floor: 4.5, under: Boolean(warned(side, field)), what: "on canvas" };
  }
  if (field === "background") {
    const ratio = contrastRatio(NEUTRAL_CHROME[side].foreground, s.background);
    return { ratio, floor: 7, under: Boolean(warned(side, "foreground")), what: "body text" };
  }
  if (field === "surface" || field === "card") {
    const ratio = contrastRatio(NEUTRAL_CHROME[side].foreground, s[field]);
    return { ratio, floor: 7, under: ratio < 7, what: "body text" };
  }
  return null;
}

function ColorRow({
  side,
  field,
  hex,
  onChange,
  badge,
}: {
  side: Theme;
  field: CustomThemeField;
  hex: string;
  onChange: (hex: string) => void;
  badge: Badge | null;
}) {
  const meta = CUSTOM_THEME_FIELD_META[field];
  // The text box holds whatever the user is typing; the committed hex only
  // moves once it parses (see HexBox for how an external change reaches it).
  const id = `custom-${side}-${field}`;
  return (
    <div className="flex items-center gap-2" data-testid={id}>
      <input
        id={id}
        type="color"
        value={hex}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${meta.label} (${side})`}
        title={meta.hint}
        className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-border bg-input p-0.5"
      />
      <label htmlFor={id} className="w-20 shrink-0 text-xs" title={meta.hint}>
        {meta.label}
      </label>
      <HexBox value={hex} onCommit={onChange} label={`${meta.label} hex (${side})`} />
      {badge && (
        <span
          title={`${badge.what}: ${badge.ratio.toFixed(2)}:1, floor ${badge.floor}:1`}
          className={cn(
            "ml-auto shrink-0 rounded-[var(--radius-pill)] border px-1.5 py-0.5 text-[10px] tabular-nums",
            badge.under ? "border-warning/40 bg-warning/10 text-warning" : "border-border text-muted-foreground",
          )}
        >
          {badge.ratio.toFixed(1)}:1
        </span>
      )}
    </div>
  );
}

function HexBox({ value, onCommit, label }: { value: string; onCommit: (hex: string) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // The committed hex moved underneath us (Start from…, Reset, colour picker):
  // adopt it. This is the render-time "derive from props" form, not an effect,
  // so the input keeps focus and no state-sync effect is needed (AGENTS.md).
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const valid = normalizeHex(draft) !== null;
  return (
    <input
      type="text"
      inputMode="text"
      spellCheck={false}
      maxLength={7}
      value={draft}
      aria-label={label}
      aria-invalid={!valid}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        const hex = normalizeHex(v);
        if (hex) onCommit(hex);
      }}
      onBlur={() => {
        if (!valid) setDraft(value);
      }}
      className={cn(
        "h-8 w-[5.5rem] rounded-md border bg-input px-2 font-mono text-xs tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        valid ? "border-border" : "border-warning",
      )}
    />
  );
}
