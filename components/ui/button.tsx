import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* v3 §3. The radius (9px) lives on the BASE, not on `default`: cva emits
   variant classes before size classes, so a `rounded-*` on the variant would
   lose to the size's every time. Hairline-scale value, so px not rem. */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[9px] text-sm font-medium transition-[background-color,border-color,box-shadow,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // grad-primary is the 135deg teal fill; bg-primary stays underneath as
        // the fallback colour. The light theme keeps the flat #0b7a70 —
        // --color-primary-foreground is #ffffff there, and white ink on the
        // bright gradient measures ~1.9:1. Dropping the image is what preserves
        // the WCAG pass that picked #0b7a70 in the first place.
        default:
          "grad-primary bg-primary text-primary-foreground font-semibold shadow-[var(--shadow-primary-glow)] hover:-translate-y-px motion-reduce:hover:translate-y-0 [html.theme-light_&]:bg-none",
        secondary:
          "panel-luxe bg-card border border-border text-foreground hover:border-primary/50 hover:bg-card-hover",
        outline:
          "border border-border bg-transparent hover:border-primary/50 hover:bg-card-hover text-foreground",
        ghost: "hover:bg-card-hover text-foreground",
        destructive: "bg-loss text-white hover:bg-loss/90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
