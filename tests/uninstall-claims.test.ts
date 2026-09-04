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
 *
 * The second version caught ONE grammar of the false promise ("does not
 * delete"). The second audit (2026-09-04) walked five other phrasings past it
 * — "keeps your journal where it is", "won't remove", "survives an uninstall",
 * "never removes", "is safe — untouched" — and "erases nothing that matters"
 * satisfied the "ticking erases" rule. The unconditional-claim rule is now a
 * list of grammars applied per SENTENCE, and a sentence is exempt only when it
 * carries the condition that makes it true (unticked / unless / Cancel).
 */

const root = process.cwd();
const clientDir = path.join(root, "docs/client");
const files = [
  "README.md",
  "CHANGELOG.md",
  ...readdirSync(clientDir)
    .filter((f) => /\.(md|html)$/i.test(f))
    .map((f) => `docs/client/${f}`),
];

/**
 * The text a buyer reads. CHANGELOG.md is pinned for its CURRENT release
 * section only (up to the second `## ` heading): older sections describe
 * older uninstallers truthfully, and rewriting history is not the point.
 */
export function readDoc(file: string): string {
  const text = readFileSync(path.join(root, file), "utf8");
  if (file !== "CHANGELOG.md") return text;
  const headings = [...text.matchAll(/^## /gm)].map((m) => m.index!);
  return headings.length >= 2 ? text.slice(0, headings[1]) : text;
}

/**
 * Blank-line-separated blocks, except that each row of a markdown table and
 * each item of a markdown list is its own paragraph — a feature table (or a
 * release-notes bullet) states the whole story in one cell, and the
 * neighbouring rows must not be allowed to vouch for it.
 */
export function paragraphs(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (lines.filter((l) => /^\s*\|/.test(l)).length >= 2) {
      out.push(...lines);
    } else if (lines.filter((l) => /^\s*[-*]\s/.test(l)).length >= 2) {
      let item = "";
      for (const l of lines) {
        if (/^\s*[-*]\s/.test(l) && item) out.push(item);
        item = /^\s*[-*]\s/.test(l) ? l : `${item}\n${l}`;
      }
      out.push(item);
    } else {
      out.push(block);
    }
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

export const uninstallParagraphs = (text: string) =>
  paragraphs(text).filter((p) => /uninstall/i.test(p));

/** A sentence is exempt from the unconditional-claim rule only if it states the condition. */
const HEDGE = /\buntick|\bunless\b|\bcancel\b|\bonly\s+(while|if|when|once)\b|\b(as|so)\s+long\s+as\b/i;

/** The grammars of "uninstalling is harmless", each of which was once true of nothing. */
const UNCONDITIONAL: RegExp[] = [
  /uninstall\w*\s+(does|will|would|can|should)\s*(not|n't|never)\s+(delete|remove|touch|erase|wipe)/i,
  /\b(won't|wont|never|not)\s+(delete|remove|erase|touch|wipe)s?\b/i,
  /\bleaves?\s+(your\s+)?(journal|data|everything)\s+in\s+place\b/i,
  /\bsurviv\w*\b/i,
  /\buntouched\b/i,
  /\bsafe\b/i,
  /\bwhere\s+(it|they)\s+(is|are|was|were)\b/i,
  /\bnothing\s+(is|gets|will\s+be|has\s+been)\s+(deleted|removed|erased|touched|wiped)\b/i,
];

/** "erases nothing (that matters)" is a denial dressed as the erase sentence. */
const ERASES_NOTHING = /\b(eras|delet|remov|wip|touch)\w*\s+nothing\b/i;

/** Sentence-ish units: end punctuation or an em-dash clause break. */
export const sentences = (p: string) => p.split(/[.;:!?]\s|\s—\s|\r?\n\s*[-*]\s/).map((s) => s.trim()).filter(Boolean);

/** Empty = the paragraph tells the truth. Otherwise, what it fails to say. */
export function uninstallFaults(p: string): string[] {
  const faults: string[] = [];

  const denial = sentences(p).find((s) => !HEDGE.test(s) && UNCONDITIONAL.some((re) => re.test(s)));
  if (denial) faults.push(`claims uninstalling never deletes data: "${denial.slice(0, 80)}"`);

  if (ERASES_NOTHING.test(p)) faults.push('says ticking "erases nothing"');

  if (!/["“*']?Delete the application data["”*']?/i.test(p)) {
    faults.push('does not name the "Delete the application data" checkbox');
  }

  // Naming the box is not enough: the paragraph must say what ticking it does
  // — and "erases nothing" is not it, so that phrase is blanked before the
  // erase verb is looked for. So is the checkbox's own name: the "Delete" in
  // "Delete the application data" must not vouch for a sentence about ticking.
  const honest = p
    .replace(new RegExp(ERASES_NOTHING.source, "gi"), " ")
    .replace(/Delete the application data/gi, " ");
  const ticksErase =
    /\btick\w*\b[^.]{0,240}?(eras|delet|remov|wipe)/i.test(honest) ||
    /(eras|delet|remov|wipe)[^.]{0,240}?\btick\w*\b/i.test(honest);
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

const mentionsUninstall = files.filter((f) => /uninstall/i.test(readDoc(f)));

describe("the never-deletes rule reads the grammar, not one phrasing", () => {
  // A paragraph that would otherwise pass every rule, so that the only fault
  // reported is the denial itself.
  const truthful =
    'The uninstaller offers a "Delete the application data" checkbox; ticking it erases the ' +
    "data folder. Before it runs, Vyuha copies the journal to `Documents\\Vyuha-backup-<date>`.";

  const evasions = [
    "Uninstalling keeps your journal where it is.",
    "The uninstaller won't remove your data.",
    "Your data survives an uninstall: nothing is deleted.",
    "The uninstaller never removes your journal.",
    "Uninstalling is safe — the journal is untouched.",
  ];
  for (const claim of evasions) {
    it(`catches: ${claim}`, () => {
      const faults = uninstallFaults(`${truthful} ${claim}`);
      expect(faults.some((f) => f.startsWith("claims uninstalling never deletes data")), faults.join("; ")).toBe(true);
    });
  }

  it('catches "if ticked, erases nothing that matters" as both a denial and a missing erase', () => {
    const p =
      'The uninstaller offers a "Delete the application data" checkbox which, if ticked, erases nothing ' +
      "that matters. Vyuha copies the journal to `Documents\\Vyuha-backup-<date>` first.";
    const faults = uninstallFaults(p);
    expect(faults).toContain('says ticking "erases nothing"');
    expect(faults).toContain("does not say that ticking it erases the data folder");
  });

  it("the conditional truths are not denials", () => {
    expect(uninstallFaults(truthful)).toEqual([]);
    for (const ok of [
      "Leave the box unticked to keep the data where it is.",
      "Cancel keeps everything in place.",
      "The uninstaller won't remove your data unless you tick the box.",
      "If the copy cannot be made the uninstall stops with nothing removed.",
    ]) {
      expect(uninstallFaults(`${truthful} ${ok}`), ok).toEqual([]);
    }
  });
});

describe("every buyer-facing doc that mentions uninstalling tells the truth", () => {
  it("at least the client README, the installation guide and the changelog mention it", () => {
    expect(mentionsUninstall).toContain("docs/client/README.md");
    expect(mentionsUninstall).toContain("docs/client/INSTALLATION_GUIDE.md");
    expect(mentionsUninstall).toContain("README.md");
    expect(mentionsUninstall).toContain("CHANGELOG.md");
  });

  for (const file of mentionsUninstall) {
    const text = readDoc(file);
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
