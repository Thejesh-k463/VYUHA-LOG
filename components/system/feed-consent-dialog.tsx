"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * THE PROVIDER-AGNOSTIC live-feed consent sheet (v4.2).
 *
 * `components/system/openalgo-dialog.tsx` stays exactly as it is — it carries
 * OpenAlgo's own sections (what it is, what it costs you, where to get it) and
 * its `data-testid="openalgo-dialog"` is pinned by the tests that already ship.
 * This file is its SIBLING, not its replacement: a broker feed's sheet is one
 * versioned list of items plus an accept, and every provider that gains a feed
 * from here on gets the same component with its own items.
 *
 * IT KNOWS NO PROVIDER. Nothing in this file names OpenAlgo or Upstox and
 * nothing imports a provider's disclosure module — the caller passes the items
 * and the version it recorded consent against. That is what makes "the dialog
 * must never show OpenAlgo's items for Upstox" a property of the code rather
 * than of a reviewer's attention: there is no provider-specific sentence here
 * to show by accident. `tests/live-feed-upstox-settings.test.ts` scans this
 * file for a provider name and fails on one.
 *
 * CONSENT IS RECORDED AGAINST A VERSION, never against "they clicked something
 * once" — the same rule the OpenAlgo sheet is built on. The version is shown so
 * the sentence in the header is the sentence the server stores.
 *
 * `onAccept` is the ONLY way out that means yes; Escape, the X and Not now all
 * close without accepting.
 */
export interface FeedConsentItem {
  title: string;
  body: string;
}

export function FeedConsentDialog({
  open,
  onOpenChange,
  onAccept,
  title,
  version,
  items,
  testId,
  acceptLabel = "I understand — use this feed",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: () => void;
  /** e.g. "Before Upstox prices your desk". Named by the caller, never here. */
  title: string;
  /** The disclosure version this acceptance will be stored as. */
  version: string;
  items: readonly FeedConsentItem[];
  /** Stable hook for the tests of whichever surface opens it. */
  testId: string;
  acceptLabel?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* DialogContent is already max-h-[90vh] overflow-y-auto with a sticky
          header and footer, so a short window scrolls the body and leaves both
          the title and the buttons reachable. */}
      <DialogContent className="max-w-2xl" data-testid={testId}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-warning" />
            {title}
          </DialogTitle>
          <DialogDescription>
            Read this in full. Disclosure v{version} — if it materially changes, Vyuha asks again.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2.5 text-xs" data-testid={`${testId}-items`}>
          {items.map((item) => (
            <li key={item.title}>
              <div className="font-medium text-foreground">{item.title}</div>
              <p className="mt-0.5 text-muted-foreground">{item.body}</p>
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button
            type="button"
            onClick={() => {
              onAccept();
              onOpenChange(false);
            }}
            data-testid={`${testId}-accept`}
          >
            {acceptLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
