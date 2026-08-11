import * as React from "react";
import { cn } from "@/lib/utils";

// break-avoid: the print block's `break-inside: avoid` rule targeted
// `section, table, .break-avoid` — and nothing carried the class, so every
// multi-row report card split across page breaks (2026-08-10 audit). Putting
// it on Card fixes pagination on all 16 report screens in one line.
function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // v3: panels are never flat fills. `panel-luxe` paints the 165deg
        // card-top → card gradient as a background IMAGE, so `bg-card` stays as
        // the opaque fallback underneath (and light theme, where both stops are
        // #ffffff, is unaffected).
        // radius-card (14px), not the base radius: the v3 spec gives panels a
        // softer corner than controls, and `rounded-lg` was still resolving to
        // the 8px scale while the gradient above had already landed.
        "break-avoid panel-luxe rounded-[var(--radius-card)] border border-[color:var(--card-border,var(--color-border))] bg-card text-foreground shadow-[var(--shadow-card)] transition-shadow duration-200 hover:shadow-[var(--shadow-card-hover)]",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-4", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("text-sm font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("text-xs text-muted-foreground", className)} {...props} />
  );
}

function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex items-center p-4 pt-0", className)} {...props} />
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
