import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * v4.2.1 — reading-size guard for the two surfaces that were set too small.
 *
 * `components/system/import-help.tsx` is the precedent scale (:61 CardTitle
 * `text-base`, :62 summary `text-sm`, :92 DialogDescription `text-sm`): a card
 * whose body is prose gets prose sizes. The Help Desk was still on the
 * chrome scale — `text-xs` bodies in `text-muted-foreground` — which reads as
 * a caption rather than as the answer to the question the card asks.
 *
 * `components/ui/dialog.tsx` is the SHARED primitive: `DialogDescription` was
 * `text-xs text-muted-foreground`, so every dialog in the app whispered its
 * one explanatory sentence. Raising it here raises all of them.
 *
 * These are source-string assertions on purpose — a class name is not
 * observable from a rendered DOM without a CSS pipeline, and the regression
 * being guarded is literally "somebody set it back to text-xs".
 *
 * Source-shape regexes use `\r?\n`: Windows CI checks the files out CRLF.
 */

const ROOT = path.resolve(__dirname, "..");
const HELP_DESK = "components/system/help-desk.tsx";
const DIALOG = "components/ui/dialog.tsx";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("Help Desk sits on the Import Help reading scale", () => {
  it("the card title is text-base, not text-sm", () => {
    const src = read(HELP_DESK);
    expect(src, "CardTitle dropped back to the chrome scale").toMatch(
      /<CardTitle className="text-base">/,
    );
    expect(src).not.toMatch(/<CardTitle className="text-sm">/);
  });

  it("the card body is text-sm and no longer muted", () => {
    const src = read(HELP_DESK);
    const m = /<CardContent className="([^"]*)"/.exec(src);
    expect(m, "CardContent lost its className").not.toBeNull();
    expect(m![1], "help body must be text-sm").toContain("text-sm");
    expect(m![1], "help body must not be text-xs").not.toContain("text-xs");
    expect(m![1], "help body must not be muted — it IS the content").not.toContain("text-muted-foreground");
  });

  it("the section header and the italic question line move up one step", () => {
    const src = read(HELP_DESK);
    // `mb-2 …` header: uppercase/tracking/muted stay, only the size moves.
    expect(src).toMatch(/<h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">/);
    expect(src).toMatch(/<p className="mt-0\.5 text-sm italic text-muted-foreground">/);
  });

  it("the Open link is text-sm", () => {
    const src = read(HELP_DESK);
    expect(src).toMatch(/rounded-md border border-border px-2 py-1 text-sm hover:bg-card-hover/);
  });

  it("no text-xs body class survives on the help cards", () => {
    // The badge chip and icon sizes are chrome and may keep their own sizing;
    // what must not survive is a text-xs on a prose element.
    const src = read(HELP_DESK);
    expect(src).not.toMatch(/text-xs italic/);
    expect(src).not.toMatch(/text-xs text-muted-foreground/);
  });
});

describe("DialogDescription is readable in every dialog", () => {
  it("the shared primitive is text-sm and brighter than muted", () => {
    const src = read(DIALOG);
    const m = /DialogPrimitive\.Description className=\{cn\("([^"]*)"/.exec(src);
    expect(m, "DialogDescription no longer composes a base className").not.toBeNull();
    expect(m![1]).toMatch(/text-sm/);
    expect(m![1]).not.toMatch(/text-xs/);
    expect(m![1], "muted-foreground is what made it whisper").not.toContain("text-muted-foreground");
  });

  it("DialogTitle is untouched", () => {
    expect(read(DIALOG)).toMatch(/DialogPrimitive\.Title className=\{cn\("text-base font-semibold", className\)\}/);
  });
});
