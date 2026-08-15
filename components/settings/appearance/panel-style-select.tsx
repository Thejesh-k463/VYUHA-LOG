"use client";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PANEL_STYLES, PANEL_STYLE_META, type PanelStyle } from "@/lib/domain/appearance";

/** Four radio pills; the parent toggles html.panel-* for the live preview. */
export function PanelStyleSelect({
  value,
  onChange,
}: {
  value: PanelStyle;
  onChange: (next: PanelStyle) => void;
}) {
  return (
    <div className="space-y-2" data-testid="panel-style">
      <Label>Panel style</Label>
      <div role="radiogroup" aria-label="Panel style" className="flex flex-wrap gap-2">
        {PANEL_STYLES.map((id) => {
          const m = PANEL_STYLE_META[id];
          const active = value === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              title={m.hint}
              data-panel-style={id}
              onClick={() => onChange(id)}
              className={cn(
                "rounded-[var(--radius-pill)] border px-3 py-1.5 text-xs transition-colors",
                active
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{PANEL_STYLE_META[value].hint}</p>
    </div>
  );
}
