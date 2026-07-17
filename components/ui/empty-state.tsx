import * as React from "react";
import { cn } from "@/lib/utils";

/** C9 — illustrated empty states. Inline line-art SVGs (stroke = accent token,
 *  so they follow every theme/skin automatically). Server-component-safe. */

type Variant = "chart" | "journal" | "playbook";

function Art({ variant }: { variant: Variant }) {
  const stroke = "var(--color-primary)";
  const dim = "var(--color-border)";
  if (variant === "journal") {
    return (
      <svg width="120" height="72" viewBox="0 0 120 72" fill="none" aria-hidden>
        <rect x="28" y="8" width="64" height="56" rx="5" stroke={dim} strokeWidth="1.5" />
        <path d="M40 22h40M40 32h40M40 42h24" stroke={dim} strokeWidth="1.5" strokeLinecap="round" />
        <path d="M76 46l14 14M90 46l-14 14" stroke="none" />
        <path d="M78 50c4-7 12-7 16 0" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        <circle cx="86" cy="56" r="10" stroke={stroke} strokeWidth="2" />
        <path d="M93 63l7 7" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (variant === "playbook") {
    return (
      <svg width="120" height="72" viewBox="0 0 120 72" fill="none" aria-hidden>
        <path d="M36 12h36a8 8 0 0 1 8 8v40H44a8 8 0 0 1-8-8V12z" stroke={dim} strokeWidth="1.5" />
        <path d="M36 12c10 0 14 4 14 10v38" stroke={dim} strokeWidth="1.5" />
        <path d="M56 26h16M56 34h16M56 42h10" stroke={dim} strokeWidth="1.5" strokeLinecap="round" />
        <path d="M84 44l4 4 8-9" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="89" cy="43" r="13" stroke={stroke} strokeWidth="2" />
      </svg>
    );
  }
  // chart
  return (
    <svg width="120" height="72" viewBox="0 0 120 72" fill="none" aria-hidden>
      <path d="M24 60h72" stroke={dim} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M24 60V16" stroke={dim} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M30 50l16-12 12 7 16-16 14 6" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="88" cy="35" r="3" fill={stroke} />
      <path d="M96 24c3-3 8-3 10 0" stroke={dim} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyState({
  variant = "chart",
  title,
  hint,
  action,
  className,
}: {
  variant?: Variant;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 py-8 text-center", className)}>
      <Art variant={variant} />
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="max-w-sm text-xs text-muted-foreground">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
