"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { pushRoute, useNavHistory } from "./nav-history";

/**
 * Records every in-app navigation, and binds the two gestures people already
 * expect to mean "back".
 *
 * ── Why the handlers call preventDefault ────────────────────────────────────
 *
 * In a browser, Alt+← and the mouse's fourth button ALREADY navigate back. In
 * the Tauri desktop webview they may not. Binding them naively therefore risks
 * the worst outcome: on the web the browser goes back and so do we, and the
 * user lands two screens away with no idea why.
 *
 * `preventDefault()` on the keydown / mousedown suppresses the browser's own
 * navigation, so exactly one back happens in both environments — the one this
 * component performs. That is the entire reason these handlers are here rather
 * than left to the platform.
 *
 * ── One writer ──────────────────────────────────────────────────────────────
 *
 * This is mounted once, in the root layout, so a route is recorded once per
 * navigation. `PageHeader`'s back button only READS the store. Two components
 * both pushing would double-count every visit and offer to go "back" to the
 * page you are already on.
 */
export function NavHistoryTracker() {
  const pathname = usePathname();
  const router = useRouter();
  const { depth } = useNavHistory();

  // Writing to an external store, not React state — so this is not the
  // `set-state-in-effect` shape the project forbids, and nothing re-renders
  // except the components that subscribed.
  React.useEffect(() => {
    if (pathname) pushRoute(pathname);
  }, [pathname]);

  React.useEffect(() => {
    if (depth <= 1) return; // nowhere to go; leave the gestures to the platform

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.key !== "ArrowLeft" || e.ctrlKey || e.metaKey || e.shiftKey) return;
      // Never steal the gesture from a field the user is editing: Alt+← is a
      // word-motion in some input contexts.
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      router.back();
    };

    // `button === 3` is the mouse's back button. Bound on mousedown because
    // that is the event whose default the browser acts on.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 3) return;
      e.preventDefault();
      router.back();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [depth, router]);

  return null;
}
