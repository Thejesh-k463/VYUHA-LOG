"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { GlossaryTerm as Term } from "@/lib/domain/glossary-split";

/**
 * One glossary word, dotted-underlined, with its meaning on hover AND on focus.
 *
 * The spec's "hovercard" is delivered with the app's existing Radix Tooltip
 * (components/ui/tooltip) — the W4 ruling allows ONE new dependency and that
 * is the accordion. The trigger is a <button> so a keyboard reaches it; it is
 * phrasing content, so it is valid inside the <p> and <li> it sits in.
 */
export function GlossaryTerm({ text, term }: { text: string; term: Term }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="cursor-help underline decoration-dotted decoration-foreground/50 underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {text}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm text-sm">
        <span className="font-semibold">{term.term}</span> — {term.meaning}
      </TooltipContent>
    </Tooltip>
  );
}
