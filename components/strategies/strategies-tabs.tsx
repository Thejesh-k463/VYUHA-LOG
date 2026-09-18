"use client";

import type * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * /strategies' two sections (v4.3.0), as a thin client wrapper over the Radix
 * strip — the same shape `components/lenses/lenses-client.tsx` uses.
 *
 * BOTH PANELS ARE BUILT ON THE SERVER and handed in as nodes. This component
 * knows nothing about a strategy, a signal or an entitlement: the withholding
 * has already happened, above, before the payload (invariant 7 and
 * `withholdForFree` / `withholdSignalAnalytics`). A tab wrapper that took the
 * entitlement as a prop would ship every Pro figure to a free build and hide it
 * with CSS.
 *
 * THE CATALOGUE TAB IS `forceMount`ed and hidden with CSS rather than unmounted.
 * Radix drops an inactive panel's tree, and the shelf picker below holds UNSAVED
 * state (the tick list, and its undo/redo history) in that tree — switching to
 * the Signal book and back would silently throw it away, which is the same class
 * of bug as the server-action remount AGENTS.md bans. The Signal book has no
 * unsaved state, so it keeps the default mount behaviour.
 *
 * NO URL PARAMETER, deliberately: /strategies is linked from the sidebar and
 * from /help, and a `?tab=` would make those links mean different screens
 * depending on when they were copied.
 */
export function StrategiesTabs({
  signalBook,
  children: catalogue,
}: {
  signalBook: React.ReactNode;
  /**
   * The catalogue panel, as CHILDREN rather than a second named prop. Ten test
   * files walk the page's rendered tree through `props.children` to find the
   * `groups`/`charts` the client is handed (strategies-ul-join, seams-v43-fixE /
   * fixF / wave2 …); a named prop puts that subtree where the walk cannot reach
   * it, and every one of them reads "the page no longer hands the client a
   * groups prop" — a false alarm about the RSC payload, which is the one thing
   * those files exist to watch.
   */
  children: React.ReactNode;
}) {
  return (
    <Tabs defaultValue="signals">
      <TabsList aria-label="Option strategies">
        <TabsTrigger value="signals">Signal book</TabsTrigger>
        <TabsTrigger value="catalogue">Structures you hold</TabsTrigger>
      </TabsList>
      <TabsContent value="signals" className="pt-4">
        {signalBook}
      </TabsContent>
      <TabsContent value="catalogue" forceMount className="pt-4 data-[state=inactive]:hidden">
        {catalogue}
      </TabsContent>
    </Tabs>
  );
}
