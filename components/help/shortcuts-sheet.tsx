"use client";

import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SHORTCUTS, SHORTCUT_SCOPES, SHORTCUTS_EVENT, isShortcutsSheetKey } from "@/lib/domain/shortcuts";

/** True while focus sits in something the user types into. */
function typingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  if (node.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName);
}

/**
 * The keyboard-shortcuts sheet (v4.6.0 W4), mounted ONCE in app/layout.tsx
 * beside the command palette. It opens on "?" (never while typing, never over
 * another dialog — `isShortcutsSheetKey`), on the `vyuha:shortcuts` window
 * event (the help desk's button and the palette's action), and Esc closes it
 * (Radix). The list is `SHORTCUTS`, grouped by scope — written from the code
 * and pinned against it in tests/shortcuts.test.ts.
 */
export function ShortcutsSheet() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const dialogOpen = document.querySelector('[role="dialog"]') != null;
      if (!isShortcutsSheetKey(e, typingTarget(e.target), dialogOpen)) return;
      e.preventDefault();
      setOpen(true);
    }
    function onOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHORTCUTS_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHORTCUTS_EVENT, onOpenEvent);
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open && (
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-lg">Keyboard shortcuts</DialogTitle>
            <DialogDescription>Ctrl/⌘ means Ctrl on Windows and Cmd on a Mac keyboard. A key typed into a field stays in the field.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {SHORTCUT_SCOPES.map((scope) => {
              const rows = SHORTCUTS.filter((s) => s.scope === scope);
              if (rows.length === 0) return null;
              return (
                <section key={scope}>
                  <h3 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{scope}</h3>
                  <dl className="divide-y divide-border rounded-md border border-border">
                    {rows.map((s) => (
                      <div key={s.binding} className="flex items-center justify-between gap-4 px-3 py-1.5 text-sm">
                        <dt className="text-foreground/90">{s.does}</dt>
                        <dd className="flex shrink-0 items-center gap-1">
                          {s.keys.map((k, i) => (
                            <kbd key={i} className="rounded border border-border bg-card-hover px-1.5 py-0.5 font-mono text-xs">
                              {k}
                            </kbd>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              );
            })}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
