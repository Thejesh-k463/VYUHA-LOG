"use client";

import {
  Banknote,
  Percent,
  Activity,
  Waves,
  Dices,
  Layers,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react";
import { LAB_METHODS } from "./lab-config";
import type { SizingMethodId } from "@/lib/risk/sizing";

/**
 * The vertical method rail (03 §6.2 / spec §3.4).
 *
 * Name AND icon, never colour alone (WCAG 1.4.1) — and no colour ranks one
 * rulebook above another, because the catalogue order is a catalogue, not a
 * ranking. The keyboard hint on each tab is the digit that switches to it
 * (03 §6.8); `lab-client.tsx` owns the listener, this rail only prints the key
 * so the shortcut is discoverable rather than folklore.
 */

const ICONS: Record<SizingMethodId, LucideIcon> = {
  "fixed-rupee": Banknote,
  "fixed-fractional": Percent,
  "volatility-unit": Activity,
  "pct-volatility": Waves,
  kelly: Dices,
  "fixed-ratio": Layers,
  "equal-weight": LayoutGrid,
};

export function MethodRail({
  active,
  onSelect,
}: {
  active: SizingMethodId;
  onSelect: (id: SizingMethodId) => void;
}) {
  return (
    <div role="tablist" aria-orientation="vertical" aria-label="Position sizing methods" className="space-y-1">
      {LAB_METHODS.map((m) => {
        const Icon = ICONS[m.id];
        const on = m.id === active;
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(m.id)}
            className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
              on
                ? "border-primary/50 bg-primary/[0.08] text-foreground"
                : "border-border bg-transparent text-muted-foreground hover:bg-card-hover"
            }`}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 leading-tight">{m.label}</span>
            <kbd className="rounded border border-border px-1 text-[0.625rem] text-muted-foreground">{m.keyHint}</kbd>
          </button>
        );
      })}
    </div>
  );
}
