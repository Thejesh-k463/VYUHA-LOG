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
 */

const root = process.cwd();
const clientDir = path.join(root, "docs/client");
const files = [
  "README.md",
  ...readdirSync(clientDir)
    .filter((f) => /\.(md|html)$/i.test(f))
    .map((f) => `docs/client/${f}`),
];

const mentionsUninstall = files.filter((f) => /uninstall/i.test(readFileSync(path.join(root, f), "utf8")));

describe("every buyer-facing doc that mentions uninstalling tells the truth", () => {
  it("at least the client README and the installation guide mention it", () => {
    expect(mentionsUninstall).toContain("docs/client/README.md");
    expect(mentionsUninstall).toContain("docs/client/INSTALLATION_GUIDE.md");
    expect(mentionsUninstall).toContain("README.md");
  });

  for (const file of mentionsUninstall) {
    const text = readFileSync(path.join(root, file), "utf8");

    it(`${file} names the Documents\\Vyuha-backup copy`, () => {
      expect(text).toMatch(/Documents\\Vyuha-backup/);
    });

    it(`${file} does not claim uninstalling never deletes data`, () => {
      const bad = text
        .split(/\r?\n/)
        .filter((l) => /uninstall\w*\s+(does|will|would|can)\s*(not|n't|never)\s+(delete|remove|touch|erase)|never\s+deletes/i.test(l));
      expect(bad, `${file} still carries the unconditional claim`).toEqual([]);
    });
  }
});
