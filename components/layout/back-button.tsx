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
        className="-ml-1 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => router.back()}
      >
        <ArrowLeft className="size-4" />
      </Button>
    </Tip>
  );
}
