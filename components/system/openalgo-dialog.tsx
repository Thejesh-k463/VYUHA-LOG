"use client";

import * as React from "react";
import { ExternalLink, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  OPENALGO_DISCLOSURE_VERSION,
  OPENALGO_DOCS,
  OPENALGO_REFUSALS,
  OPENALGO_RISKS,
  OPENALGO_SITE,
  OPENALGO_WHAT_IT_DOES,
  OPENALGO_WHAT_IT_IS,
  type DisclosureItem,
} from "@/lib/domain/openalgo-disclosure";

/**
 * The OpenAlgo disclosure, as a dialog the user must read before the switch
 * in Settings → Integrations can go on.
 *
 * EVERY sentence here comes from `lib/domain/openalgo-disclosure.ts`. This file
 * contributes section headings and button labels and nothing else — the copy is
 * versioned in the pure module precisely so the Settings card, this dialog and
 * the server-side gate can never drift apart, and so consent can be recorded
 * against a version (`OPENALGO_DISCLOSURE_VERSION`) rather than against "they
 * clicked something once".
 *
 * Risks are the loudest block on purpose: this is the first thing in Vyuha that
 * asks the user to run a second program and give IT their broker credentials.
 *
 * The two addresses are shown as plain, selectable text with the anchor only as
 * a secondary path — same reasoning as buy-dialog.tsx: in the Tauri desktop
 * webview an external `target="_blank"` anchor does nothing at all, so the text
 * on screen has to be the primary way to get the address.
 *
 * `onAccept` is the ONLY way out that means yes; Escape, the X and Cancel all
 * close without accepting.
 */
export function OpenAlgoDialog({
  open,
  onOpenChange,
  onAccept,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* DialogContent is already max-h-[90vh] overflow-y-auto with a sticky
          header and footer, so a short window scrolls the body and leaves both
          the title and the buttons reachable. */}
      <DialogContent className="max-w-2xl" data-testid="openalgo-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-warning" />
            Before you turn on OpenAlgo
          </DialogTitle>
          <DialogDescription>
            Read this in full. Disclosure v{OPENALGO_DISCLOSURE_VERSION} — if it materially changes, Vyuha asks
            again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          <Section title="What this is">
            <ItemList items={OPENALGO_WHAT_IT_IS} />
          </Section>

          <Section title="What it does">
            <ItemList items={OPENALGO_WHAT_IT_DOES} />
          </Section>

          {/* The prominent block — same `text-warning` token the auto-MTM
              overwrite line uses in settings-form.tsx. */}
          <section className="rounded-md border border-warning/40 bg-warning/5 p-3" data-testid="openalgo-risks">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-warning">
              <TriangleAlert className="size-4 shrink-0" />
              What it costs you
            </h3>
            <ul className="mt-2 space-y-2.5">
              {OPENALGO_RISKS.map((risk) => (
                <li key={risk.title}>
                  <div className="font-medium text-warning">{risk.title}</div>
                  <p className="mt-0.5 text-muted-foreground">{risk.body}</p>
                </li>
              ))}
            </ul>
          </section>

          <Section title="What Vyuha will not do">
            <ul className="space-y-1 text-muted-foreground">
              {OPENALGO_REFUSALS.map((line) => (
                <li key={line} className="flex gap-1.5">
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Where to get it">
            <div className="grid gap-2 sm:grid-cols-2">
              <AddressBlock label="Website" url={OPENALGO_SITE} />
              <AddressBlock label="Documentation" url={OPENALGO_DOCS} />
            </div>
          </Section>
        </div>

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
            data-testid="openalgo-accept"
          >
            I understand — enable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function ItemList({ items }: { items: DisclosureItem[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.title}>
          <div className="font-medium text-foreground">{item.title}</div>
          <p className="mt-0.5 text-muted-foreground">{item.body}</p>
        </li>
      ))}
    </ul>
  );
}

function AddressBlock({ label, url }: { label: string; url: string }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {/* Selectable text first — the anchor below is inert in the desktop
          webview, so the address itself has to be readable and copyable. */}
      <div className="mt-1 select-all break-all font-mono text-xs text-foreground">{url}</div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="size-3" /> Open in a browser
      </a>
    </div>
  );
}
