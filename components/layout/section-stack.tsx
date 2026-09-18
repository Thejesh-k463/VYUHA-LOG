"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStoredValue, writeStored } from "./use-stored-value";
import { dropTarget, useListDrag } from "./use-list-drag";
import { PAGE_SECTIONS, sectionDef, type PageId } from "@/lib/domain/section-registry";
import {
  SECTION_ORDER_KEY,
  commitSectionMove,
  parseSectionOrder,
  resolveSectionOrder,
  serializeSectionOrder,
  stepSectionMove,
  type SectionStep,
} from "@/lib/domain/section-order";

/**
 * USER-MOVABLE PAGE SECTIONS — the sidebar's drag-to-reorder, for a page's cards.
 *
 *   <SectionArrangeProvider page="settings">          (client; no DOM of its own)
 *     <PageHeader actions={<RearrangeControls page="settings" />} />
 *     <SectionStack page="settings" className="space-y-6">
 *       <Section id="settings-capital-golive"><CapitalGoLiveCard /></Section>
 *       …
 *
 * Four things here are load-bearing (research pack §3–§4, §8):
 *
 * 1. **Sections cross as CHILDREN, never as imports.** The pages are server
 *    components; a section rendered there arrives here as an already-rendered
 *    element. Importing one would pull its DB reads into the client bundle —
 *    a failure only `next build` sees.
 * 2. **The order is DERIVED.** `useStoredValue` (useSyncExternalStore) +
 *    `useMemo`; no effect, no state copy (AGENTS.md: never setState in an
 *    effect keyed on other state).
 * 3. **Every frame is keyed by its section id.** React then MOVES the DOM node
 *    on a reorder instead of remounting it — a remount replays every chart's
 *    animation and can blank a canvas chart with no error.
 * 4. **A move commits through `moveWithinVisible` over the full registry**
 *    (lib/domain/section-order.ts), so a section absent right now keeps its
 *    place in the saved order.
 */

type ArrangeContext = {
  page: PageId;
  arranging: boolean;
  setArranging: (next: boolean) => void;
  /** Say something in the page's one polite live region. */
  announce: (message: string) => void;
};

const Arrange = React.createContext<ArrangeContext | null>(null);

/** The Rearrange mode and live region shared by a page's header controls and its stack. */
export function useSectionArrange(): ArrangeContext | null {
  return React.useContext(Arrange);
}

export function SectionArrangeProvider({ page, children }: { page: PageId; children: React.ReactNode }) {
  const [arranging, setArranging] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const value = React.useMemo<ArrangeContext>(
    () => ({ page, arranging, setArranging, announce: setMessage }),
    [page, arranging],
  );
  return (
    <Arrange.Provider value={value}>
      {children}
      {/* Position numbers, not "moved up": a screen-reader user has no insertion line. */}
      <div role="status" aria-live="polite" className="sr-only" data-testid="section-order-status">
        {message}
      </div>
    </Arrange.Provider>
  );
}

/** A page's saved order, parsed and resolved against its registry — derived, never synced. */
export function useSectionOrder(page: PageId) {
  const key = SECTION_ORDER_KEY(page);
  const raw = useStoredValue(key);
  const saved = React.useMemo(() => parseSectionOrder(raw)?.order ?? null, [raw]);
  const order = React.useMemo(() => resolveSectionOrder(PAGE_SECTIONS[page], saved), [page, saved]);
  const write = React.useCallback(
    (next: string[] | null) => writeStored(key, next === null ? null : serializeSectionOrder(next)),
    [key],
  );
  return { stored: raw !== null, saved, order, write };
}

/**
 * A marker: the stack reads its `id` and renders the children inside a keyed
 * frame. It renders nothing of its own so a page's markup is unchanged when
 * Rearrange mode is off.
 */
export function Section({ children }: { id: string; children: React.ReactNode }) {
  return <>{children}</>;
}

const DRAG_STYLE: React.CSSProperties = {
  zIndex: 30,
  position: "relative",
  boxShadow:
    "0 0 0 1px color-mix(in oklab, var(--color-primary) 55%, transparent), 0 8px 26px -6px color-mix(in oklab, var(--color-primary) 65%, transparent)",
  borderRadius: "var(--radius)",
};

/** The insertion line, drawn in the gap ABOVE (or below) a frame so it never shifts layout mid-drag. */
function DropLine({ edge }: { edge: "top" | "bottom" }) {
  return (
    <div
      aria-hidden
      data-drop-line
      className={cn("pointer-events-none absolute inset-x-0 h-0.5 rounded-full", edge === "top" ? "-top-3" : "-bottom-3")}
      style={{
        background: "var(--color-primary)",
        boxShadow: "0 0 10px 1px color-mix(in oklab, var(--color-primary) 80%, transparent)",
      }}
    />
  );
}

export function SectionStack({
  page,
  className,
  children,
}: {
  page: PageId;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = useSectionArrange();
  const arranging = ctx?.page === page && ctx.arranging;
  const announce = ctx?.announce;
  const defs = PAGE_SECTIONS[page];
  const { saved, order, write } = useSectionOrder(page);

  // Children by section id. A child whose id the registry does not know still
  // renders (at the end) — a typo must never make a card vanish — and says so
  // in development; tests/section-order.test.ts fails on it before that.
  const byId = new Map<string, React.ReactNode>();
  const extras: string[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const id = (child.props as { id?: unknown }).id;
    if (typeof id !== "string" || byId.has(id)) return;
    byId.set(id, child);
    if (!sectionDef(page, id)) {
      extras.push(id);
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[section-stack] <Section id="${id}"> is not in PAGE_SECTIONS.${page} — it cannot be moved.`);
      }
    }
  });
  const rendered = [...order.filter((id) => byId.has(id)), ...extras];
  const visibleMovable = rendered.filter((id) => sectionDef(page, id)?.movable !== false && !extras.includes(id));
  const labelOf = (id: string) => sectionDef(page, id)?.label ?? id;

  const frames = React.useRef(new Map<string, HTMLDivElement>());
  const grips = React.useRef(new Map<string, HTMLButtonElement>());

  /** "Appearance moved to position 17 of 17." — counted over what is on screen. */
  function announceMove(next: string[], id: string) {
    const after = [...resolveSectionOrder(defs, next).filter((x) => byId.has(x)), ...extras];
    announce?.(`${labelOf(id)} moved to position ${after.indexOf(id) + 1} of ${after.length}.`);
  }

  const { drag, begin } = useListDrag((_scope, from, to) => {
    const moved = visibleMovable[from];
    const next = commitSectionMove(defs, saved, visibleMovable, from, to);
    write(next);
    if (moved) announceMove(next, moved);
  }, "y");

  function step(id: string, s: SectionStep) {
    const next = stepSectionMove(defs, saved, visibleMovable, id, s);
    if (!next) {
      announce?.(`${labelOf(id)} is already at position ${rendered.indexOf(id) + 1} of ${rendered.length}.`);
      return;
    }
    // Commit synchronously so the grip can take focus back: React re-inserts a
    // moved DOM node, and a node that leaves the document drops its focus.
    flushSync(() => write(next));
    grips.current.get(id)?.focus();
    announceMove(next, id);
  }

  function onGripKey(id: string, e: React.KeyboardEvent) {
    const s: SectionStep | null =
      e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : e.key === "Home" ? "start" : e.key === "End" ? "end" : null;
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    step(id, s);
  }

  /** Alt+↑ / Alt+↓ from anywhere inside a section while Rearrange mode is on. */
  function onFrameKey(id: string, e: React.KeyboardEvent) {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    step(id, e.key === "ArrowUp" ? "up" : "down");
  }

  const helpId = `section-order-help-${page}`;
  const noOp = drag ? dropTarget(drag.fromIndex, drag.toIndex) === drag.fromIndex : true;

  return (
    <div className={className} data-section-stack={page}>
      {arranging && (
        <p id={helpId} className="rounded-md border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
          Drag a section by its grip, or focus the grip and press <kbd>↑</kbd>/<kbd>↓</kbd> (
          <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> from anywhere inside it); <kbd>Home</kbd>/<kbd>End</kbd> send it to
          the top or bottom. This arrangement is saved on this device.
        </p>
      )}
      {rendered.map((id) => {
        const movable = visibleMovable.includes(id);
        const vIndex = visibleMovable.indexOf(id);
        const label = labelOf(id);
        const isDragged = drag?.key === id;
        const lineAbove = !!drag && !noOp && vIndex >= 0 && drag.toIndex === vIndex;
        const lineBelow = !!drag && !noOp && vIndex === visibleMovable.length - 1 && drag.toIndex === visibleMovable.length;
        return (
          <div
            key={id}
            ref={(el) => {
              if (el) frames.current.set(id, el);
              else frames.current.delete(id);
            }}
            data-section={id}
            data-dragging={isDragged ? "true" : undefined}
            // Named explicitly in the mode, so the grip's own label never folds
            // into the card's accessible name (DECISIONS 2026-08-10, the <th> fix).
            role={arranging ? "group" : undefined}
            aria-label={arranging ? label : undefined}
            aria-roledescription={arranging && movable ? "sortable section" : undefined}
            onKeyDown={arranging && movable ? (e) => onFrameKey(id, e) : undefined}
            className={cn(
              "relative",
              arranging && "rounded-[var(--radius)] outline-dashed outline-1 outline-offset-4 outline-primary/40",
              arranging && !movable && "opacity-60",
              drag && "transition-none",
            )}
            style={isDragged ? { ...DRAG_STYLE, transform: `translateY(${drag.dy}px)` } : undefined}
          >
            {lineAbove && <DropLine edge="top" />}
            {arranging && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-dashed border-primary/40 bg-primary/5 px-2 py-1 text-xs">
                {movable ? (
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) grips.current.set(id, el);
                      else grips.current.delete(id);
                    }}
                    aria-label={`Move ${label}`}
                    aria-describedby={helpId}
                    onPointerDown={(e) =>
                      begin(e, page, id, vIndex, visibleMovable.map((v) => frames.current.get(v) ?? null))
                    }
                    onKeyDown={(e) => onGripKey(id, e)}
                    // A touch-drag reorders instead of scrolling the page.
                    style={{ touchAction: "none" }}
                    className="cursor-grab rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                  >
                    <GripVertical className="size-4" />
                  </button>
                ) : (
                  <span className="text-muted-foreground">Fixed</span>
                )}
                <span className="font-medium text-foreground">{label}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {rendered.indexOf(id) + 1} of {rendered.length}
                </span>
              </div>
            )}
            {byId.get(id)}
            {lineBelow && <DropLine edge="bottom" />}
          </div>
        );
      })}
    </div>
  );
}
