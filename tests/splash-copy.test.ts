import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * v4.2.1 — splash copy guard.
 *
 * The Tauri splash (`src-tauri/loading/index.html`) is the first thing a buyer
 * sees, before the Node sidecar is even up. Two rules it now carries:
 *
 *  1. The retired "DESKTOP · WEB · YOUR CHOICE" strap is GONE. It said nothing
 *     a trader wanted at boot and it re-stated a positioning line that already
 *     lives on the landing page.
 *  2. In its place, one sentence of brand voice, shimmering, between the
 *     "Trade Journal" tag and the progress track — never below the fold, never
 *     after the bar.
 *
 * The shimmer must be a HIGHLIGHT over a readable base colour, so the line is
 * legible with animation off, and `prefers-reduced-motion: reduce` must stop
 * it like every other animation in this file.
 *
 * All source-shape regexes use `\r?\n`: Windows CI checks the file out CRLF.
 */

const ROOT = path.resolve(__dirname, "..");
const SPLASH = "src-tauri/loading/index.html";

const TAGLINE = "Every warrior had a charioteer. Yours keeps count.";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("splash copy — the charioteer line replaces the DESKTOP · WEB strap", () => {
  it("carries the tagline verbatim", () => {
    expect(read(SPLASH)).toContain(TAGLINE);
  });

  it("no longer carries the 'YOUR CHOICE' strap", () => {
    expect(/YOUR\s+CHOICE/i.test(read(SPLASH)), "the retired splash strap is back").toBe(false);
  });

  it("places the tagline after 'Trade Journal' and before the progress track", () => {
    const src = read(SPLASH);
    const tag = src.indexOf(">Trade Journal<");
    const line = src.indexOf(TAGLINE);
    const track = src.indexOf('class="track"');
    expect(tag, "the .tag element is gone").toBeGreaterThan(-1);
    expect(track, "the .track element is gone").toBeGreaterThan(-1);
    expect(line, "tagline must come after the Trade Journal tag").toBeGreaterThan(tag);
    expect(line, "tagline must come before the progress track").toBeLessThan(track);
  });

  it("animates the tagline with a local @keyframes shimmer over a gradient clipped to the text", () => {
    const src = read(SPLASH);
    expect(src).toMatch(/@keyframes shimmer/);
    expect(src, "shimmer must sweep the background position, like app/globals.css:783").toMatch(
      /@keyframes shimmer\s*\{[\s\S]{0,240}?background-position:\s*200% 0[\s\S]{0,240}?background-position:\s*-200% 0/,
    );
    expect(src, "the sweep needs a clipped gradient and an oversized background").toMatch(
      /-webkit-background-clip:\s*text/,
    );
    expect(src).toMatch(/background-size:\s*200% 100%/);
  });

  it("stops the shimmer under prefers-reduced-motion", () => {
    const src = read(SPLASH);
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\r?\n\s*\}/.exec(src);
    expect(block, "the reduced-motion block is gone").not.toBeNull();
    expect(block![1], "the tagline is not in the reduced-motion block").toMatch(/\.tagline/);
  });
});
