import { Lock } from "lucide-react";

/**
 * The "computed, but not yours yet" chip — visually distinct from BOTH a
 * number and the "—" that means "cannot be computed from your data"
 * (invariant 6). A locked value must never read as zero or as missing data.
 * Used by the Lenses edge cells and the locked action buttons on /trades.
 */
export function ProLock({ label = "Pro" }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-accent/30 bg-accent/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
      title="Pro — unlock with a licence key"
    >
      <Lock className="size-2.5" />
      {label}
    </span>
  );
}
