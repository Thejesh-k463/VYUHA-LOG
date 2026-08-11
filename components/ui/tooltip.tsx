"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/**
 * Tooltip on @radix-ui/react-tooltip — replaces bare `title=` attributes on
 * hot surfaces (v2.99.70). `title` tooltips take ~1s to appear, render in the
 * OS style, and are invisible to keyboard users; these appear in 300ms, match
 * the app's chrome, and show on focus too.
 *
 * ONE provider, mounted in app/layout.tsx — that is what makes moving the
 * pointer between adjacent icons show the next tip instantly (skipDelay).
 * Never nest another provider around individual tips.
 *
 * Rollout rule: a tooltip REPLACES a `title` — carrying both would show two.
 * Keep `title` (or aria-label) only on triggers whose visible content is not
 * text, and prefer aria-label there.
 */

const TooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={150}>
    {children}
  </TooltipPrimitive.Provider>
);

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          // Same surface family as the dialogs: card chrome, token shadow,
          // the dialog entrance animation. 0.6875rem so density scales it.
          "z-50 max-w-xs rounded-md border border-border bg-card px-2.5 py-1.5 text-[0.6875rem] leading-snug text-foreground shadow-[var(--shadow-overlay)] animate-dialog-in",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/**
 * The one-liner for the common case:
 *
 *   <Tip label="Remove screenshot"><button …>×</button></Tip>
 *
 * The child becomes the trigger via asChild, so it must accept a ref —
 * native elements and the app's primitives all do. `side` when the default
 * top placement would cover something (sidebar items tip to the right).
 */
function Tip({
  label,
  side,
  children,
}: {
  label: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent, Tip };
