"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

/**
 * Popover on @radix-ui/react-popover — the third member of the overlay family,
 * after dialog.tsx and tooltip.tsx and written in exactly their shape (v3.9).
 *
 * The dependency has sat in package.json unused; this is its first call site.
 * It exists because a NON-MODAL anchored surface is a thing neither of the
 * others can be: a Dialog traps focus and locks the page's scroll (correct for
 * a modal, wrong for a panel the user works alongside), and a Tooltip is
 * hover-transient and cannot hold an input.
 *
 * Chrome tokens are the dialog's, so all three read as one surface family.
 *
 * `PopoverAnchor` is re-exported deliberately: a positioned anchor is how a
 * FREELY DRAGGED surface keeps Radix's positioning (and its dismissal and
 * focus semantics) instead of hand-rolling them — see search-panel.tsx.
 */

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;

function PopoverContent({
  className,
  align = "center",
  sideOffset = 6,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-[var(--radius-card)] border border-border bg-card text-foreground shadow-[var(--shadow-overlay)] animate-dialog-in focus:outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent, PopoverClose };
