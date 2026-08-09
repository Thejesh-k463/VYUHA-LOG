"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-checkbox";
import { cn } from "@/lib/utils";

/**
 * A simple toggle built on Radix Checkbox (avoids an extra dependency).
 * Visually a pill switch: 38 × 21 (v3 §3), on = the primary gradient with a
 * dark knob, off = rgba(148,163,184,.15).
 *
 * The knob is positioned from the ROOT's `data-state` via `group-data-*`, not
 * from its own attribute: Radix owns that attribute on the root, so the knob
 * tracks uncontrolled (`defaultChecked`) switches as well as controlled ones.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "group peer inline-flex h-[21px] w-[38px] shrink-0 cursor-pointer items-center rounded-[var(--radius-pill)] border border-border bg-[rgba(148,163,184,0.15)] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
      // The gradient is dropped in the light theme for the same reason the
      // primary button drops it: --color-primary-foreground is #ffffff there,
      // and a white knob on the bright teal fill is ~1.9:1. Light keeps the
      // flat #0b7a70 that passed the contrast check.
      "data-[state=checked]:grad-primary data-[state=checked]:bg-primary data-[state=checked]:border-primary/50 [html.theme-light_&]:bg-none",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Indicator className="pointer-events-none block" />
    <span
      className={cn(
        "pointer-events-none ml-[3px] block size-[15px] rounded-full bg-foreground shadow transition-transform duration-150 motion-reduce:transition-none",
        "group-data-[state=checked]:translate-x-[17px] group-data-[state=checked]:bg-primary-foreground",
      )}
      data-state={props.checked ? "checked" : "unchecked"}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export { Switch };
