import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/client/README.md used to say "Uninstalling does not delete it" about
 * the journal database. It was false whenever the uninstaller's "Delete the
 * application data" box was ticked — which wiped the owner's own journal and
 * lifetime licence key (v3.8 WS6). The truth now is: the uninstaller warns and
 * copies the journal and licence to Documents\Vyuha-backup-<date> first, and
 * the data stays in place only while the box is unticked. Every buyer-facing
 * doc that mentions uninstalling must tell that story, and none may claim the
 * unconditional version again.
 *
 * The first version of this file pinned the story per FILE, which is why it
 * was hollow: "Uninstalling leaves your journal in place" in one paragraph
 * passed on the strength of a `Documents\Vyuha-backup` mention six paragraphs
 * away, and nothing required the checkbox to be named at all. Every rule below
 * is therefore scoped to the PARAGRAPH that mentions uninstalling, because a
 * buyer reads a paragraph, not a file.
 */

const root = process.cwd();
const clientDir = path.join(root, "docs/client");
const files = [
  "README.md",
  ...readdirSync(clientDir)
    .filter((f) => /\.(md|html)$/i.test(f))
    .map((f) => `docs/client/${f}`),
];

/**
 * Blank-line-separated blocks, except that each row of a markdown table is its
 * own paragraph — a feature table states the whole story in one cell, and the
 * neighbouring rows must not be allowed to vouch for it.
 */
export function paragraphs(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (lines.filter((l) => /^\s*\|/.test(l)).length >= 2) out.push(...lines);
    else out.push(block);
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

export const uninstallParagraphs = (text: string) =>
  paragraphs(text).filter((p) => /uninstall/i.test(p));

/** Empty = the paragraph tells the truth. Otherwise, what it fails to say. */
export function uninstallFaults(p: string): string[] {
  const faults: string[] = [];

  if (/uninstall\w*\s+(does|will|would|can)\s*(not|n't|never)\s+(delete|remove|touch|erase)|never\s+deletes|leaves\s+your\s+journal\s+in\s+place/i.test(p)) {
    faults.push("claims uninstalling never deletes data");
  }

  if (!/["“*']?Delete the application data["”*']?/i.test(p)) {
    faults.push('does not name the "Delete the application data" checkbox');
  }

  // Naming the box is not enough: the paragraph must say what ticking it does.
  const ticksErase =
    /\btick\w*\b[^.]{0,240}?(eras|delet|remov|wipe)/i.test(p) ||
    /(eras|delet|remov|wipe)[^.]{0,240}?\btick\w*\b/i.test(p);
  if (!ticksErase) faults.push("does not say that ticking it erases the data folder");

  // The v3.7.1 uninstaller has no guard, so a paragraph about that upgrade must
  // say so rather than promise the copy. Every other one must promise the copy.
  if (/v3\.7\.1/.test(p)) {
    if (!/no backup step|has no backup|unguarded/i.test(p)) {
      faults.push("describes the v3.7.1 uninstaller without saying it has no backup step");
    }
  } else if (!/Documents\\Vyuha-backup/.test(p)) {
    faults.push("does not name the Documents\\Vyuha-backup copy");
  }

  return faults;
}

/**
 * The in-app backup envelope BLANKS licenseKey (lib/backup-format.ts:83), so
 * telling a buyer to export one "before the uninstaller runs" hands them a
 * file that cannot restore the thing the uninstaller destroys.
 */
export function inAppBackupFaults(p: string): string[] {
  if (!/uninstall|upgrad/i.test(p)) return [];
  if (!/in-app backup|Backup & Restore|export a backup/i.test(p)) return [];
  const saysKeyIsMissing =
    /\b(not|never|no|without)\b[^.]{0,120}?licen[cs]e key/i.test(p) ||
    /licen[cs]e key[^.]{0,120}?\b(is |are )?(not|never)\b/i.test(p);
  return saysKeyIsMissing ? [] : ["mentions the in-app backup without saying the licence key is not in it"];
}

const mentionsUninstall = files.filter((f) => /uninstall/i.test(readFileSync(path.join(root, f), "utf8")));

/**
 * PARKED HERE, and it does not belong here: the v3.8 fix wave gave agent E1 no
 * doc-claims test file of its own, and an unpinned claim is exactly what this
 * wave exists to retire. W6b should move this into its own
 * `tests/broker-doc-claims.test.ts`.
 *
 * AGENTS.md and docs/BROKER_FORMATS.md called Upstox "schema-only — its three
 * real exports carried zero data rows" for a fortnight after
 * tests/golden-books.test.ts started pinning two POPULATED Upstox exports. The
 * banner is the thing a future agent reads before deciding whether it may trust
 * an Upstox number, so it must not outlive the fixtures.
 */
describe("the Upstox schema-only caveat is retired everywhere it was stated", () => {
  const golden = readFileSync(path.join(root, "tests/golden-books.test.ts"), "utf8");

  it("golden-books really does pin populated Upstox exports", () => {
    expect(golden, "the realised-P&L reference Upstox itself states").toContain(
      "reference: { gross: -1.05, net: -4.28, charges: 3.23",
    );
    expect(golden, "the trade report's committed net").toContain("commit: { net: -271.9,");
  });

  for (const file of ["AGENTS.md", "docs/BROKER_FORMATS.md"]) {
    it(`${file} no longer says Upstox exports carry zero rows`, () => {
      const text = readFileSync(path.join(root, file), "utf8");
      // Line-based would miss a claim wrapped across two lines, which is how
      // the docs/BROKER_FORMATS.md copy of it survived the first pass.
      const flat = text.replace(/\s+/g, " ");
      const bad = [
        /Upstox is (?!no longer)[^.]*schema-only/i,
        /still schema-only/i,
        /still INFERRED for Upstox/i,
        /value behaviour is INFERRED/i,
      ]
        .map((re) => flat.match(re)?.[0])
        .filter(Boolean);
      expect(bad, `${file} still states the retired Upstox caveat`).toEqual([]);
    });

    it(`${file} states what actually pins Upstox now`, () => {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text).toMatch(/golden-books\.test\.ts/);
      expect(text).toMatch(/−4\.28|-4\.28/);
      expect(text).toMatch(/−271\.90|-271\.90/);
    });
  }
});

describe("every buyer-facing doc that mentions uninstalling tells the truth", () => {
  it("at least the client README and the installation guide mention it", () => {
    expect(mentionsUninstall).toContain("docs/client/README.md");
    expect(mentionsUninstall).toContain("docs/client/INSTALLATION_GUIDE.md");
    expect(mentionsUninstall).toContain("README.md");
  });

  for (const file of mentionsUninstall) {
    const text = readFileSync(path.join(root, file), "utf8");
    const paras = uninstallParagraphs(text);

    it(`${file} has an uninstall paragraph at all`, () => {
      expect(paras.length).toBeGreaterThan(0);
    });

    it(`${file}: every uninstall paragraph names the checkbox and what ticking it does`, () => {
      const bad = paras
        .map((p) => ({ faults: uninstallFaults(p), p: p.slice(0, 140) }))
        .filter((r) => r.faults.length > 0);
      expect(bad, `${file} has uninstall paragraphs that do not tell the story`).toEqual([]);
    });

    it(`${file}: no paragraph offers the in-app backup without saying the licence key is not in it`, () => {
      const bad = paragraphs(text)
        .map((p) => ({ faults: inAppBackupFaults(p), p: p.slice(0, 140) }))
        .filter((r) => r.faults.length > 0);
      expect(bad).toEqual([]);
    });
  }
});
