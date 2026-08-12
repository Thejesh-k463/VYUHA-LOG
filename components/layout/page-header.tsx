import * as React from "react";
import { BackButton } from "./back-button";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/80 px-6 py-3 backdrop-blur print:static print:bg-transparent print:backdrop-blur-none">
      {/* The back control is a client island that renders null until there is
          an earlier in-app screen, so every page gets it without changing its
          call site, and the first screen of a session shows nothing. Only the
          BUTTON is print:hidden — the title and description are the heading of
          every printed report and must survive. */}
      <div className="flex min-w-0 items-center gap-1">
        <span className="print:hidden"><BackButton /></span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 print:hidden">{actions}</div>}
    </div>
  );
}
