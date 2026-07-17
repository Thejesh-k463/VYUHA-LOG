"use client";

// C6 — tiny dependency-free toast stack (offline-first app: no sonner).
// Usage anywhere client-side:  toast.success("Saved.") / toast.error("Failed.")
// <Toaster /> mounts once in the root layout.

import * as React from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

// Window CustomEvent bus — NOT a module-level singleton: client chunks can
// duplicate a module (one copy per chunk), silently splitting shared state.
// window is one object per page, so this works from any chunk by construction.
const EVENT = "vyuha:toast";
let nextId = 1;

function push(kind: ToastKind, text: string) {
  window.dispatchEvent(new CustomEvent<ToastItem>(EVENT, { detail: { id: nextId++, kind, text } }));
}

export const toast = {
  success: (text: string) => push("success", text),
  error: (text: string) => push("error", text),
  info: (text: string) => push("info", text),
};

const ICONS: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 className="size-4 shrink-0 text-profit" />,
  error: <AlertCircle className="size-4 shrink-0 text-loss" />,
  info: <Info className="size-4 shrink-0 text-accent" />,
};

const EDGE: Record<ToastKind, string> = {
  success: "border-l-2 border-l-profit",
  error: "border-l-2 border-l-loss",
  info: "border-l-2 border-l-accent",
};

export function Toaster() {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  React.useEffect(() => {
    function onToast(e: Event) {
      const t = (e as CustomEvent<ToastItem>).detail;
      setItems((prev) => [...prev.slice(-3), t]); // max 4 on screen
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 3800);
    }
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2 print:hidden">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`animate-fade-up pointer-events-auto flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-xs shadow-[var(--shadow-overlay)] ${EDGE[t.kind]}`}
        >
          {ICONS[t.kind]}
          <span className="flex-1">{t.text}</span>
          <button
            type="button"
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            className="text-muted-foreground hover:text-foreground"
            title="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
