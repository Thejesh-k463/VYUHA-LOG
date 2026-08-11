import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The textarea primitive ten components were copy-pasting (2026-08-10 audit):
 * the literal className string existed in journal-dialog, playbook-manager,
 * ais-reconcile, benchmark-panel, restriction-form, license-card,
 * alias-manager, corporate-action-manager, instrument-manager, bhavcopy-mtm
 * and mtm-form — half with `font-mono`, half without, `p-2` against the
 * Input's `px-3`. One definition, one drift surface.
 *
 * `mono` is for machine text (pasted CSVs, licence keys, restriction lists);
 * prose (journal notes, playbook rules) stays on the sans face.
 */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }
>(function Textarea({ className, mono, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-md border border-border bg-input p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        mono && "font-mono",
        className,
      )}
      {...props}
    />
  );
});
