import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHORTCUTS, SHORTCUT_SCOPES, SHORTCUTS_EVENT, isShortcutsSheetKey, type Shortcut } from "@/lib/domain/shortcuts";
import { isPaletteChord, isPanelToggleChord, type Chord } from "@/components/system/search-panel-keys";
import { deskAction, type DeskAction } from "@/components/live/desk-keys";
import { methodByKey } from "@/components/sizing/lab-config";

/**
 * v4.6.0 W4 — the shortcuts sheet describes the keyboard that EXISTS. Every
 * registry row names its binding, and each binding is checked here against
 * the code that handles the key. A rebound key reddens this file.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const chord = (over: Partial<Chord>): Chord => ({ key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });

const deskRow = (action: DeskAction, key: string) => () => {
  expect(deskAction(chord({ key }))).toBe(action);
  // …and only as a bare key: any chord belongs to someone else.
  if (action !== "escape") expect(deskAction(chord({ key, ctrlKey: true }))).toBeNull();
};

const labRow = (key: string) => (row: Shortcut) => {
  const m = methodByKey(key);
  expect(m, `no Sizing Lab method answers ${key}`).not.toBeNull();
  expect(row.does).toContain(m!.label);
};

/** binding id → the check against the handler. Every row must have one, and every check a row. */
const CHECKS: Record<string, (row: Shortcut) => void> = {
  palette: () => {
    expect(isPaletteChord(chord({ key: "k", ctrlKey: true }))).toBe(true);
    expect(isPaletteChord(chord({ key: "k", metaKey: true }))).toBe(true);
    expect(isPaletteChord(chord({ key: "k", ctrlKey: true, shiftKey: true }))).toBe(false);
  },
  "search-panel": () => {
    expect(isPanelToggleChord(chord({ key: "K", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isPanelToggleChord(chord({ key: "k", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isPanelToggleChord(chord({ key: "k", ctrlKey: true }))).toBe(false);
  },
  back: () => {
    const src = read("components/layout/nav-history-tracker.tsx");
    expect(src, "Alt+← is no longer the back gesture").toContain('if (!e.altKey || e.key !== "ArrowLeft"');
    expect(src).toContain("router.back()");
  },
  "shortcuts-sheet": () => {
    expect(isShortcutsSheetKey({ key: "?", ctrlKey: false, metaKey: false, altKey: false }, false, false)).toBe(true);
    const sheet = read("components/help/shortcuts-sheet.tsx");
    expect(sheet, "the sheet no longer reads the shared predicate").toContain("isShortcutsSheetKey(e,");
    expect(sheet).toContain("SHORTCUTS_EVENT");
  },
  "dialog-escape": () => {
    // Radix Dialog owns Esc for every dialog built on the shared primitive.
    expect(read("components/ui/dialog.tsx")).toContain('from "@radix-ui/react-dialog"');
  },
  "desk-row-down": deskRow("row-down", "j"),
  "desk-row-up": deskRow("row-up", "k"),
  "desk-expand": deskRow("expand", "Enter"),
  "desk-sizing-lab": deskRow("sizing-lab", "l"),
  "desk-filter": deskRow("focus-filter", "/"),
  "desk-escape": () => {
    expect(deskAction(chord({ key: "Escape" }), true), "Esc must work while typing in the filter").toBe("escape");
  },
  "lab-1": labRow("1"),
  "lab-2": labRow("2"),
  "lab-3": labRow("3"),
  "lab-4": labRow("4"),
  "lab-5": labRow("5"),
  "lab-6": labRow("6"),
  "lab-7": labRow("7"),
  "help-topic-escape": () => {
    // The topic dialog is the shared Radix Dialog, and closing it clears the fragment.
    const src = read("components/help/help-topic-dialog.tsx");
    expect(src).toContain('from "@/components/ui/dialog"');
    expect(read("components/system/help-desk.tsx")).toContain("writeHelpHash(null)");
  },
};

describe("SHORTCUTS — every row is pinned to the binding it names", () => {
  it("binding ids are unique, and every row has a check and every check a row", () => {
    const ids = SHORTCUTS.map((s) => s.binding);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(CHECKS).sort());
  });

  it.each(SHORTCUTS.map((s) => [s.binding, s] as const))("%s", (_id, row) => {
    CHECKS[row.binding](row);
  });

  it("every scope used is a declared scope, and every row states keys and what they do", () => {
    for (const s of SHORTCUTS) {
      expect(SHORTCUT_SCOPES).toContain(s.scope);
      expect(s.keys.length, s.binding).toBeGreaterThan(0);
      expect(s.does.length, s.binding).toBeGreaterThan(5);
    }
  });

  it("the Sizing Lab keys cover exactly the methods the lab binds (1–7)", () => {
    const labKeys = SHORTCUTS.filter((s) => s.scope === "Sizing Lab").map((s) => s.keys[0]);
    const bound = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].filter((k) => methodByKey(k));
    expect(labKeys).toEqual(bound);
  });
});

describe("isShortcutsSheetKey — '?' opens the sheet, and nothing else does", () => {
  const e = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
    key: "?",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...over,
  });
  it("opens on a bare '?'", () => expect(isShortcutsSheetKey(e(), false, false)).toBe(true));
  it("never while typing", () => expect(isShortcutsSheetKey(e(), true, false)).toBe(false));
  it("never over an open dialog", () => expect(isShortcutsSheetKey(e(), false, true)).toBe(false));
  it("never with Ctrl, Cmd or Alt held", () => {
    expect(isShortcutsSheetKey(e({ ctrlKey: true }), false, false)).toBe(false);
    expect(isShortcutsSheetKey(e({ metaKey: true }), false, false)).toBe(false);
    expect(isShortcutsSheetKey(e({ altKey: true }), false, false)).toBe(false);
  });
  it("not on '/' (the Live Desk filter key)", () => expect(isShortcutsSheetKey(e({ key: "/" }), false, false)).toBe(false));
  it("the window event is namespaced", () => expect(SHORTCUTS_EVENT).toBe("vyuha:shortcuts"));
});
