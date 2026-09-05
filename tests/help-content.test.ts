import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ENTRIES, searchHelp } from "@/lib/domain/help-content";
import { NAV_ITEMS } from "@/components/layout/nav-config";

/**
 * The help desk's one hard promise: it describes the app that exists. This
 * joins the registry against the sidebar in both directions, so adding a screen
 * without help — or help for a screen that is gone — fails the build.
 */

describe("help covers the app, exactly", () => {
  it("every sidebar destination has a help entry", () => {
    const helpHrefs = new Set(HELP_ENTRIES.map((e) => e.href));
    const missing = NAV_ITEMS.filter((n) => !helpHrefs.has(n.href)).map((n) => n.href);
    expect(missing, `screens with no help entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("no help entry describes a screen that does not exist", () => {
    const navHrefs = new Set(NAV_ITEMS.map((n) => n.href));
    const ghosts = HELP_ENTRIES.filter((e) => !navHrefs.has(e.href)).map((e) => e.href);
    expect(ghosts, `help for non-existent screens: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("entries are unique per href", () => {
    const hrefs = HELP_ENTRIES.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("every entry has a one-line answer, body and keywords", () => {
    for (const e of HELP_ENTRIES) {
      expect(e.answers.length, e.href).toBeGreaterThan(10);
      expect(e.body.length, e.href).toBeGreaterThan(0);
      expect(e.keywords.length, e.href).toBeGreaterThan(0);
    }
  });

  it("keeps the house voice — no marketing superlatives", () => {
    for (const e of HELP_ENTRIES) {
      const text = [e.answers, ...e.body].join(" ").toLowerCase();
      expect(text, e.href).not.toMatch(/world[- ]class|revolutionary|best[- ]in[- ]class|amazing/);
    }
  });
});

/**
 * The help desk describes v4.0 AS SHIPPED. Three entries had drifted from the
 * code they describe, and every one of them reads as a feature the buyer does
 * not have:
 *   - /sizing-lab listed a "heat ceiling" among the write-back fields; the
 *     dialog writes five fields and that is not one of them;
 *   - /atlas described the owner's widgets as "a separate, opt-in feed", in the
 *     present tense — v4.0 has no such feed (Q-12);
 *   - /live advertised "alerts" as Pro; no alert code exists in lib/live or
 *     components/live (Telegram alerts are v4.1).
 */
describe("help describes the app that shipped, not the one that is planned", () => {
  const body = (href: string) => HELP_ENTRIES.find((e) => e.href === href)!.body.join(" ");

  /** The five fields, in the words the help uses for them. */
  const WRITE_BACK_PROSE: Record<string, string> = {
    riskPctPpm: "risk percentage",
    deployCapPpm: "deploy cap",
    stopMethod: "stop method",
    stopAtrLen: "ATR length",
    stopAtrMultPermille: "ATR multiple",
  };

  it("/sizing-lab names exactly the fields the write-back dialog writes", () => {
    // The dialog's own payload type is the source of truth: a sixth field added
    // there without a word here reddens this immediately.
    const dialog = fs.readFileSync(
      path.join(process.cwd(), "components/sizing/write-back-dialog.tsx"),
      "utf8",
    );
    const block = /export interface WriteBackValues \{([\s\S]*?)\n\}/.exec(dialog);
    expect(block, "WriteBackValues is no longer declared as an interface").not.toBeNull();
    const fields = [...block![1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(Object.keys(WRITE_BACK_PROSE).sort());

    const text = body("/sizing-lab");
    for (const [field, prose] of Object.entries(WRITE_BACK_PROSE)) {
      expect(text.toLowerCase(), `${field} is written but the help does not name it`).toContain(
        prose.toLowerCase(),
      );
    }
    expect(text.toLowerCase(), "the write-back does not touch the heat ceiling").not.toContain("heat ceiling");
  });

  it("/atlas does not describe a widget feed that does not exist", () => {
    const text = body("/atlas");
    expect(text).not.toMatch(/opt-in feed/i);
    expect(text).toContain("are not computed in Vyuha");
  });

  it("/live advertises no alerts — there is no alert code in v4.0", () => {
    expect(body("/live")).not.toMatch(/\balerts?\b/i);
  });
});

/**
 * Keyword drift guard (v3.8 Wave 3). The command palette used to carry its
 * own hand-written keyword map, which duplicated this registry and drifted
 * from it (27 entries against 43, several stale). Palette keywords are now
 * DERIVED from HELP_ENTRIES by href — so every sidebar destination needs a
 * help entry with at least one keyword, and the palette may not grow a
 * second map.
 */
describe("palette keywords derive from the help registry", () => {
  it("every NAV_ITEMS href has a help entry with at least one keyword", () => {
    const byHref = new Map(HELP_ENTRIES.map((e) => [e.href, e]));
    const bare = NAV_ITEMS.filter((n) => !(byHref.get(n.href)?.keywords.length ?? 0)).map((n) => n.href);
    expect(bare, `screens with no help keywords: ${bare.join(", ")}`).toEqual([]);
  });

  it("the palette module carries no KEYWORDS literal and reads HELP_ENTRIES", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/system/command-palette.tsx"), "utf8");
    // Both halves were hollow. `\bKEYWORDS\b` is evaded by any prefixed name
    // (`SCREEN_KEYWORDS`, `NAV_KEYWORDS`): there is no word boundary between
    // `_` and `K`. And `toContain("HELP_ENTRIES")` was satisfied by the JSDoc
    // paragraph above this describe, which names the registry in prose — the
    // palette could drop the derivation entirely and still pass. Pin the
    // DECLARATION shape and the CALL instead.
    expect(src, "a second keyword map has grown back").not.toMatch(/KEYWORDS\s*[:=]/);
    expect(src, "the palette no longer derives keywords from the registry").toContain("deriveKeywords(m.HELP_ENTRIES");
  });
});

describe("search", () => {
  it("finds screens by task words a trader would type", () => {
    expect(searchHelp(HELP_ENTRIES, "delete").map((e) => e.href)).toContain("/trades");
    expect(searchHelp(HELP_ENTRIES, "backup").map((e) => e.href)).toContain("/backup");
    expect(searchHelp(HELP_ENTRIES, "grandfathering").map((e) => e.href)).toContain("/reports/tax");
    expect(searchHelp(HELP_ENTRIES, "theta").map((e) => e.href)).toContain("/options-journal");
  });

  it("is case-insensitive", () => {
    expect(searchHelp(HELP_ENTRIES, "VAR").map((e) => e.href)).toContain("/risk");
  });

  it("an empty query returns everything", () => {
    expect(searchHelp(HELP_ENTRIES, "  ")).toHaveLength(HELP_ENTRIES.length);
  });

  it("a nonsense query returns nothing rather than everything", () => {
    expect(searchHelp(HELP_ENTRIES, "zzzznotaword")).toEqual([]);
  });
});
