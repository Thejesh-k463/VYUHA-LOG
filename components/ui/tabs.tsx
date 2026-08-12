"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

/**
 * A horizontal tab strip, in the notebook-section idiom: the active tab is
 * joined to the panel below it, the inactive ones sit behind.
 *
 * ── Why Radix rather than a row of buttons ──────────────────────────────────
 *
 * The keyboard contract is the whole reason. A tab strip owes the user arrow-key
 * movement between tabs, Home/End to the ends, one tab stop for the whole strip
 * rather than one per tab, and `role="tablist"`/`aria-selected` so a screen
 * reader announces "3 of 6". Hand-rolled strips get the ARIA attributes and skip
 * the roving focus, which is the part that actually matters. `@radix-ui/react-
 * tabs` was already a dependency of this project and imported nowhere; this is
 * the first use of it.
 *
 * ── Colour ──────────────────────────────────────────────────────────────────
 *
 * Every value here is an existing token. The active tab reads as the primary
 * accent, which each of the seven skins re-points as part of its coordinated
 * triple (lib/domain/skin.ts) — so this strip follows the skin without knowing
 * anything about it. Nothing is spelled as a literal colour, which is also what
 * keeps the print stylesheet and the colourblind palette working.
 */

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        // Scrolls sideways rather than wrapping: a strip that reflows to two
        // rows stops reading as one row of tabs, and the count here is
        // user-data-dependent.
        "flex items-end gap-1 overflow-x-auto border-b border-border",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "relative shrink-0 whitespace-nowrap rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
        // Inactive: recedes, and the bottom border of the list reads as its
        // edge. Active: joined to the panel — the -mb-px pulls it over the
        // list's border so the tab and the content below share one surface,
        // which is what makes it look like a notebook section rather than a
        // pill.
        "border-transparent text-muted-foreground hover:bg-card-hover hover:text-foreground",
        "data-[state=active]:-mb-px data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:pb-2 data-[state=active]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn("focus-visible:outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
