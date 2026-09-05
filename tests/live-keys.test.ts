import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { deskAction, isTypingTarget, nextIndex } from "@/components/live/desk-keys";
import { isPanelToggleChord } from "@/components/system/search-panel-keys";

/**
 * The Live Desk keyboard map, and the two app-wide chords it must never eat.
 *
 * A bare-letter map on `window` is the cheapest way to break a shortcut that
 * lives somewhere else entirely: `k` is the desk's "row up" AND the second half
 * of Ctrl+K (the modal command palette, `command-palette.tsx:143`) and of
 * Ctrl+Shift+K (the search panel, `search-panel-keys.ts`). Nothing throws when
 * both fire — the palette opens and the desk scrolls a row underneath it — so
 * only a test can hold the line.
 *
 * The chord predicate is IMPORTED from `search-panel-keys.ts` on both sides, so
 * this file cannot drift from the panel's own definition: if AltGr handling
 * changes there, this test changes with it rather than silently disagreeing.
 */

const ROOT = path.resolve(__dirname, "..");
const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** A keydown's fields, defaulting to "no modifier held". */
const chord = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>> = {}) => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
  key,
});

/** The modal palette's predicate, mirrored from `command-palette.tsx:143`. */
const isPaletteChord = (e: { ctrlKey: boolean; metaKey: boolean; key: string }) =>
  (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";

describe("the desk's bare-letter map", () => {
  it("moves, expands, routes and filters on the keys the help line advertises", () => {
    expect(deskAction(chord("j"))).toBe("row-down");
    expect(deskAction(chord("k"))).toBe("row-up");
    expect(deskAction(chord("Enter"))).toBe("expand");
    expect(deskAction(chord("l"))).toBe("sizing-lab");
    expect(deskAction(chord("L"))).toBe("sizing-lab");
    expect(deskAction(chord("/"))).toBe("focus-filter");
    expect(deskAction(chord("Escape"))).toBe("escape");
  });

  it("ignores every key it does not own", () => {
    for (const k of ["a", "K", "J", "Tab", "ArrowDown", "?", "1"]) {
      expect(deskAction(chord(k)), k).toBe(null);
    }
  });

  it("clamps the focused row at both ends, and reports -1 for an empty list", () => {
    expect(nextIndex(-1, 5, 1)).toBe(0);
    expect(nextIndex(-1, 5, -1)).toBe(4);
    expect(nextIndex(0, 5, -1)).toBe(0);
    expect(nextIndex(4, 5, 1)).toBe(4);
    expect(nextIndex(2, 0, 1)).toBe(-1);
  });
});

describe("Ctrl/Cmd+K still belongs to the command palette", () => {
  it("the desk answers null to the palette chord on both platforms", () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      const e = chord("k", mods);
      // The palette WOULD fire on this exact event — which is precisely why the
      // desk answering anything but null would double-handle it.
      expect(isPaletteChord(e), JSON.stringify(mods)).toBe(true);
      expect(deskAction(e), JSON.stringify(mods)).toBe(null);
    }
  });

  it("…and to the search panel's Ctrl/Cmd+Shift+K, using the panel's own predicate", () => {
    for (const mods of [{ ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }]) {
      const e = chord("K", mods);
      expect(isPanelToggleChord(e), JSON.stringify(mods)).toBe(true);
      expect(deskAction(e), JSON.stringify(mods)).toBe(null);
    }
  });

  it("no chord at all reaches the desk — Alt and Ctrl+Alt (AltGr) included", () => {
    for (const e of [chord("j", { ctrlKey: true }), chord("k", { altKey: true }), chord("k", { ctrlKey: true, altKey: true }), chord("Enter", { metaKey: true })]) {
      expect(deskAction(e), e.key).toBe(null);
    }
  });

  it("imports the panel chord rather than re-implementing it", () => {
    // A second copy of a chord is how two shortcuts drift apart: the AltGr fix
    // in `search-panel-keys.ts` must apply here without being retyped.
    const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/desk-keys.ts"), "utf8"));
    expect(src).toContain('from "@/components/system/search-panel-keys"');
    expect(src).toContain("isPanelToggleChord(e)");
    expect(src).not.toMatch(/shiftKey\s*&&/);
  });
});

describe("typing is not navigation", () => {
  it("recognises the fields a keystroke belongs to", () => {
    for (const tag of ["INPUT", "input", "TEXTAREA", "SELECT"]) expect(isTypingTarget(tag, false), tag).toBe(true);
    expect(isTypingTarget("DIV", true), "contenteditable").toBe(true);
    expect(isTypingTarget("DIV", false)).toBe(false);
    expect(isTypingTarget(null, false)).toBe(false);
  });

  it("hands every bare letter to the filter box while it has focus", () => {
    for (const k of ["j", "k", "l", "/", "Enter"]) expect(deskAction(chord(k), true), k).toBe(null);
  });

  it("…except Escape, whose whole job is to hand focus back to the table", () => {
    expect(deskAction(chord("Escape"), true)).toBe("escape");
  });
});

describe("the tracker routes its window listener through the map", () => {
  it("calls deskAction with the typing flag, and never tests e.key itself", () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, "components/live/tracker-client.tsx"), "utf8"));
    expect(src).toContain("deskAction(e, typing)");
    expect(src).toContain("isTypingTarget(");
    expect(src).toContain('window.addEventListener("keydown", onKey)');
    // A second, hand-rolled key test in the component is the drift this guards.
    expect(src).not.toMatch(/e\.key\s*===/);
  });
});
