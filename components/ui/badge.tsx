import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/* v3 §3 status pills and chips. One formula, applied per colour:
 *   border 1px <colour>/.4 · background <colour>/.07 · text <colour>
 * `shrink-0` and `whitespace-nowrap` are on the base because the failure they
 * guard against is universal — inside a flex instrument cell a badge that can
 * shrink or wrap lays itself over the next column instead of pushing it right.
 */
const badgeVariants = cva(
  "inline-flex shrink-0 items-center whitespace-nowrap rounded-[var(--radius-pill)] border font-medium leading-tight",
  {
    variants: {
      variant: {
        default: "border-primary/40 bg-primary/[0.07] text-primary",
        secondary: "border-muted/40 bg-muted/[0.07] text-muted-foreground",
        outline: "border-border bg-transparent text-foreground",
        profit: "border-profit/40 bg-profit/[0.07] text-profit",
        loss: "border-loss/40 bg-loss/[0.07] text-loss",
        warning: "border-warning/40 bg-warning/[0.07] text-warning",
        gold: "border-gold/40 bg-gold/[0.07] text-gold",
        accent: "border-accent/40 bg-accent/[0.07] text-accent",
      },
      size: {
        // The long-standing badge size — every existing call site keeps it.
        default: "px-2.5 py-0.5 text-[0.6875rem]",
        // Filter/summary chip: 7px 14px (v3 §3). rem so both densities scale.
        chip: "px-[0.875rem] py-[0.4375rem] text-[0.6875rem]",
        // MTF / ELM / drift markers: 9px caps. px, not rem — at this size the
        // label is a graphic mark and a fractional cap height only blurs it.
        xs: "px-1.5 py-px text-[9px] uppercase tracking-[0.08em]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
