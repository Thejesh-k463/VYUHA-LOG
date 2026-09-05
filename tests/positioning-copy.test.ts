import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * v3.9.1 — positioning guard.
 *
 * Owner directive 2026-09-05: Vyuha is no longer sold as "100% local & offline".
 * The positioning is "Desktop or Web: the trader chooses" — one platform for a
 * trader, from trading to journaling. Vyuha Desktop keeps every technical
 * guarantee it had (serverless Ed25519 licence check, a 7-day trial with no
 * signup, one download-only launch check, the journal in a single SQLite file
 * on the user's PC) but they are stated as FACTS about the desktop app, never
 * as a brand promise about the product.
 *
 * This test guards the buyer-facing SOURCE files. It does not police the word
 * "offline" — that word is still true and still used for technical facts (a
 * licence that verifies with no server, a check that skips silently when the
 * machine has no network). It bans the nine SLOGANS that carried the retired
 * positioning, so a future edit cannot quietly restore it.
 *
 * History files (CHANGELOG.md, docs/DECISIONS.md, docs/prompts/**,
 * docs/V3x0_BUILD_PLAN.md) are deliberately NOT scanned: they record what was
 * once true and are never rewritten.
 *
 * docs/sales/landing-page.standalone.html is GENERATED from landing-page.html
 * by scripts/build-landing.mjs and is .gitignore(d) (:32), so a fresh clone does
 * not have it. When it IS present it is scanned, so a stale 5.7 MB file cannot
 * be emailed to a buyer carrying copy the source no longer says.
 */

const ROOT = path.resolve(__dirname, "..");

/** Every phrase that carried the retired positioning. Matched case-insensitively. */
const STRUCK = [
  "local-first",
  "100% local",
  "offline-first",
  "fully local",
  "never sends a single trade",
  "zero cloud",
  "offline by design",
  "LOCAL · OFFLINE",
  "local & offline",
] as const;

/** Buyer-facing surfaces. Every one of these is read by someone deciding whether to buy. */
const SURFACES = [
  "README.md",
  "docs/index.html",
  "docs/sales/landing-page.html",
  "docs/sales/brochure.html",
  "docs/client/README.md",
  "docs/client/INSTALLATION_GUIDE.md",
  "docs/client/PRIVACY.md",
  "docs/client/TERMS.md",
  "docs/client/REFUND_POLICY.md",
  "docs/client/GETTING_STARTED_DECK.html",
  "docs/client/OPENALGO_SETUP_GUIDE.html",
  "src-tauri/tauri.conf.json",
  "src-tauri/loading/index.html",
  "app/layout.tsx",
  "components/layout/sidebar.tsx",
  "lib/domain/help-content.ts",
  "lib/domain/pricing-comparison.ts",
];

/** `Local &amp; offline` in HTML is the same slogan as `Local & offline`. Decode the
 *  three entities that can hide one before matching. */
function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#183;|&middot;/g, "·");
}

/** Generated, .gitignore(d) at .gitignore:32 — scanned only when it has been built. */
const GENERATED = ["docs/sales/landing-page.standalone.html"];

function read(rel: string): string {
  return decode(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

/** All line numbers (1-based) on which `phrase` appears, case-insensitively. */
function hits(text: string, phrase: string): string[] {
  const needle = phrase.toLowerCase();
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.toLowerCase().includes(needle)) out.push(`:${i + 1}  ${line.trim().slice(0, 140)}`);
  });
  return out;
}

describe("positioning copy — 'local-first / 100% local & offline' is retired", () => {
  it.each([...SURFACES, ...GENERATED])("%s carries no struck positioning phrase", (rel) => {
    if (!fs.existsSync(path.join(ROOT, rel))) return; // generated artefact, not in a fresh clone
    const text = read(rel);
    const found: string[] = [];
    for (const phrase of STRUCK) {
      for (const line of hits(text, phrase)) found.push(`${phrase} -> ${rel}${line}`);
    }
    expect(found, `struck positioning phrase in ${rel}:\n${found.join("\n")}`).toEqual([]);
  });

  it("every scanned surface exists and is non-empty", () => {
    for (const rel of SURFACES) {
      expect(fs.existsSync(path.join(ROOT, rel)), `${rel} missing`).toBe(true);
      expect(read(rel).length, `${rel} empty`).toBeGreaterThan(0);
    }
  });

  it("the README anchor the badges point at exists", () => {
    const readme = read("README.md");
    // Renaming the section without renaming the three inbound links leaves dead
    // anchors on the first screen a buyer sees.
    expect(readme).toContain("## 🔒 Your data, your choice of home");
    expect(readme).not.toContain("#-local-first-by-design");
    expect(hits(readme, "#-your-data-your-choice-of-home")).toHaveLength(3);
  });

  it("the sidebar footer and the bump-version regex still agree", () => {
    // scripts/bump-version.mjs rewrites the footer on every release. If the
    // footer text and the regex's capture group drift apart, version bumping
    // silently stops touching the footer and the app shows a stale version.
    const sidebar = read("components/layout/sidebar.tsx");
    const bump = fs.readFileSync(path.join(ROOT, "scripts/bump-version.mjs"), "utf8");
    expect(sidebar).toContain("Vyuha Desktop · v");
    expect(bump).toContain("(Desktop · v)");
    const m = /\/\((Desktop · v)\)\\d\+\\\.\\d\+/.exec(bump);
    expect(m, "bump-version.mjs:79 regex prefix").not.toBeNull();
    expect(sidebar).toContain(m![1]);
  });

  it("the 'where your data lives' cell is word-identical everywhere it is published", () => {
    const CELL = "Your own PC with Vyuha Desktop; a web platform is in development";
    expect(read("lib/domain/pricing-comparison.ts")).toContain(CELL);
    expect(read("docs/sales/landing-page.html")).toContain(CELL);
    const gen = path.join(ROOT, "docs/sales/landing-page.standalone.html");
    if (fs.existsSync(gen)) expect(decode(fs.readFileSync(gen, "utf8"))).toContain(CELL);
  });

  it("PRIVACY keeps the four-kinds list, scoped to the desktop app", () => {
    // docs/DECISIONS.md :2318, :2560 and :2958 are anchored to this sentence.
    const privacy = read("docs/client/PRIVACY.md");
    expect(privacy).toContain("Exactly four kinds, and only one of them is automatic:");
    expect(privacy).toContain("There is no fifth thing.");
    expect(privacy).toContain("## The network requests Vyuha Desktop makes");
  });

  it("the web platform is only ever described as in development, never dated", () => {
    // Only lines that talk about OUR web platform are judged — the comparison
    // table quotes a competitor's own "coming soon" and that is reportage.
    const offenders: string[] = [];
    for (const rel of SURFACES) {
      read(rel)
        .split("\n")
        .forEach((line, i) => {
          if (!/web platform/i.test(line)) return;
          if (/coming soon|web platform is (now )?(available|live|here)|web platform launch|by Q[1-4]|in 20\d\d/i.test(line)) {
            offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 140)}`);
          }
        });
    }
    expect(offenders, `web platform promised rather than described:\n${offenders.join("\n")}`).toEqual([]);
  });
});
