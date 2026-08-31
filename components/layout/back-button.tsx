"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNavHistory } from "./nav-history";
import { ArrowLeft } from "lucide-react";

/**
 * The app-level back control, in the page header.
 *
 * It renders NOTHING until there is somewhere to go — a back button on the
 * first screen of a session either does nothing or throws the user out of the
 * app, and a permanently-disabled control is just clutter. The server snapshot
 * is empty by construction, so this is absent in the SSR markup and appears
 * after the first in-app navigation.
 *
 * The label names the destination when the previous route is a sidebar screen.
 * "Back" alone is a promise the user has to test; "Back to Trades" is one they
 * can read.
 *
 * Visibility (owner feature 8, v3.5.0): whenever it renders at all, it CAN
 * act — so it wears the skin's primary glow (--shadow-primary-glow, `none` on
 * skins that mean no glow) and pulses twice on mount. PageHeader remounts per
 * navigation, so the pulse fires on each screen where going back is possible,
 * then settles into the steady glow. `animate-back-pulse` is zeroed in the
 * prefers-reduced-motion block in globals.css; the motion-reduce variant here
 * is belt-and-braces. Printing is already handled by PageHeader's
 * `print:hidden` span around this component — keep rendering plainly here.
 */
export function BackButton() {
  const router = useRouter();
  const { depth, previousLabel } = useNavHistory();

  if (depth <= 1) return null;

  const label = previousLabel ? `Back to ${previousLabel}` : "Back";

  return (
    <Tip label={`${label} · Alt+←`}>
      <Button
        size="sm"
        variant="ghost"
        aria-label={label}
        className="-ml-1 shrink-0 animate-back-pulse text-primary/80 shadow-[var(--shadow-primary-glow)] hover:bg-primary/10 hover:text-primary motion-reduce:animate-none"
        onClick={() => router.back()}
      >
        <ArrowLeft className="size-4" />
      </Button>
    </Tip>
  );
}
