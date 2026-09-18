"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PAGE_SECTIONS, sectionDef, type PageId } from "@/lib/domain/section-registry";
import { resolveSectionOrder, stepSectionMove } from "@/lib/domain/section-order";
import { useSectionArrange, useSectionOrder } from "./section-stack";

/**
 * The PageHeader half of Rearrange mode — a client island in the header's
 * `actions` slot, the way BackButton and PaletteSearchButton already are.
 *
 * - **Rearrange** enters the mode (grips, dashed outlines); **Done** leaves it.
 *   The order persists on every move, not on Done, so nothing is lost mid-way.
 * - **Reset layout** shows only while a stored order exists — the sidebar's
 *   own `rawNavOrder !== null` rule — and clears the key, so the next
 *   release's default is never frozen out by a stale array.
 * - **Reorder list** opens the button path (Move up / Move down): the one that
 *   works on touch, where a drag fights page scroll, and without a pointer.
 */
export function RearrangeControls({ page }: { page: PageId }) {
  const ctx = useSectionArrange();
  const { stored, write } = useSectionOrder(page);
  const [listOpen, setListOpen] = React.useState(false);
  if (!ctx || ctx.page !== page) return null;
  const { arranging, setArranging, announce } = ctx;

  function reset() {
    write(null);
    announce("Layout reset to the default order.");
  }

  return (
    <div className="flex items-center gap-2 print:hidden">
      {arranging && (
        <Button type="button" variant="outline" size="sm" onClick={() => setListOpen(true)}>
          Reorder list
        </Button>
      )}
      {arranging && stored && (
        <Button type="button" variant="ghost" size="sm" onClick={reset}>
          Reset layout
        </Button>
      )}
      <Button
        type="button"
        variant={arranging ? "default" : "outline"}
        size="sm"
        onClick={() => setArranging(!arranging)}
        title={arranging ? "Leave Rearrange mode" : "Move this page's sections — saved on this device"}
      >
        <ArrowUpDown className="size-3.5" aria-hidden />
        {arranging ? "Done" : "Rearrange"}
      </Button>
      <RearrangeDialog page={page} open={listOpen} onOpenChange={setListOpen} onReset={reset} />
    </div>
  );
}

function RearrangeDialog({
  page,
  open,
  onOpenChange,
  onReset,
}: {
  page: PageId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: () => void;
}) {
  const ctx = useSectionArrange();
  const { stored, saved, order, write } = useSectionOrder(page);
  const defs = PAGE_SECTIONS[page];
  const movable = order.filter((id) => sectionDef(page, id)?.movable !== false);
  const buttons = React.useRef(new Map<string, HTMLButtonElement>());

  function step(id: string, dir: "up" | "down") {
    const next = stepSectionMove(defs, saved, movable, id, dir);
    if (!next) return;
    flushSync(() => write(next));
    // Keep focus on the control that was pressed; at an end it is now
    // disabled, so hand focus to its twin.
    const self = buttons.current.get(`${id}:${dir}`);
    const twin = buttons.current.get(`${id}:${dir === "up" ? "down" : "up"}`);
    (self && !self.disabled ? self : twin)?.focus();
    const label = sectionDef(page, id)?.label ?? id;
    const full = resolveSectionOrder(defs, next);
    ctx?.announce(`${label} moved to position ${full.indexOf(id) + 1} of ${full.length}.`);
  }

  const setRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) buttons.current.set(key, el);
    else buttons.current.delete(key);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rearrange sections</DialogTitle>
          <DialogDescription>
            Move a section up or down. This arrangement is saved on this device.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-1" data-testid="rearrange-list">
          {order.map((id, i) => {
            const def = sectionDef(page, id);
            const label = def?.label ?? id;
            const fixed = def?.movable === false;
            const mi = movable.indexOf(id);
            return (
              <li
                key={id}
                data-section-item={id}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm"
              >
                <span className="w-6 shrink-0 tabular-nums text-xs text-muted-foreground">{i + 1}</span>
                <span className="flex-1">{label}</span>
                {fixed ? (
                  <span className="text-xs text-muted-foreground">Fixed</span>
                ) : (
                  <>
                    <Button
                      ref={setRef(`${id}:up`)}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      aria-label={`Move ${label} up`}
                      disabled={mi <= 0}
                      onClick={() => step(id, "up")}
                    >
                      <ChevronUp className="size-4" aria-hidden />
                    </Button>
                    <Button
                      ref={setRef(`${id}:down`)}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      aria-label={`Move ${label} down`}
                      disabled={mi < 0 || mi >= movable.length - 1}
                      onClick={() => step(id, "down")}
                    >
                      <ChevronDown className="size-4" aria-hidden />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ol>
        <DialogFooter>
          {stored && (
            <Button type="button" variant="outline" size="sm" onClick={onReset}>
              Reset layout
            </Button>
          )}
          <DialogClose asChild>
            <Button type="button" size="sm">
              Done
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
