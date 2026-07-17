"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-checkbox";
import { cn } from "@/lib/utils";

/**
 * A simple toggle built on Radix Checkbox (avoids an extra dependency).
 * Visually a pill switch.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-input transition-colors data-[state=checked]:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Indicator className="pointer-events-none block" />
    <span
      className={cn(
        "pointer-events-none ml-0.5 block h-4 w-4 rounded-full bg-foreground shadow transition-transform data-[state=checked]:translate-x-4",
      )}
      data-state={props.checked ? "checked" : "unchecked"}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export { Switch };
