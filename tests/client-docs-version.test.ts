import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The client docs ship inside the ZIP a buyer downloads, so a stale "Applies
 * to" line or a missing "New in" section is a paperwork defect the buyer sees.
 * These docs are edited BEFORE the version bump lands (the docs pass and the
 * bump are separate steps in the release flow), so the assertion is
 * "docs >= package.json", never strict equality: a doc that is one release
 * AHEAD is fine, one BEHIND is the bug. docs/owner/DOC_AUDIT.md is the
 * per-release checklist this test guards a slice of.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const pkgVersion: string = JSON.parse(read("package.json")).version;

/** Compare dotted numeric versions: negative if a < b, 0 if equal, positive if a > b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

describe("client docs are not behind package.json", () => {
  it("cmpVersion orders dotted versions numerically, not lexically", () => {
    expect(cmpVersion("2.99.96", "2.99.95")).toBeGreaterThan(0);
    expect(cmpVersion("2.99.9", "2.99.10")).toBeLessThan(0);
    expect(cmpVersion("2.100.0", "2.99.96")).toBeGreaterThan(0);
    expect(cmpVersion("2.99.96", "2.99.96")).toBe(0);
  });

  // REFUND_POLICY.md was NOT in this list until v3.7.0, and drifted exactly the
  // way an unguarded doc does: TERMS and PRIVACY were carried forward at every
  // release while the refund policy sat at v3.4.0 for three of them — in the
  // same ZIP, on the same "Applies to" line, describing the same product
  // (owner decision Q8, 2026-09-02). It is the one of the three a buyer reads
  // when they are already unhappy, so a stale version on it costs the most.
  for (const file of ["docs/client/TERMS.md", "docs/client/PRIVACY.md", "docs/client/REFUND_POLICY.md"]) {
    it(`${file} "Applies to" version is >= ${pkgVersion}`, () => {
      const m = read(file).match(/\*\*Applies to:\*\* Vyuha v(\d+\.\d+\.\d+)/);
      expect(m, `${file} has no "**Applies to:** Vyuha vX.Y.Z" line`).not.toBeNull();
      const docVersion = m![1];
      expect(
        cmpVersion(docVersion, pkgVersion),
        `${file} applies to v${docVersion} but package.json is ${pkgVersion}`,
      ).toBeGreaterThanOrEqual(0);
    });
  }

  it(`docs/client/README.md has a "New in v<version>" section for ${pkgVersion} or newer`, () => {
    const headings = [...read("docs/client/README.md").matchAll(/^## New in v(\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]);
    expect(headings.length, "no '## New in vX.Y.Z' headings found").toBeGreaterThan(0);
    const newest = headings.reduce((a, b) => (cmpVersion(a, b) >= 0 ? a : b));
    expect(
      cmpVersion(newest, pkgVersion),
      `newest "New in" section is v${newest}; package.json is ${pkgVersion}`,
    ).toBeGreaterThanOrEqual(0);
  });

  it("the getting-started deck's version chips are not behind package.json", () => {
    const deck = read("docs/client/GETTING_STARTED_DECK.html");
    const versions = [...deck.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]);
    expect(versions.length, "deck carries no vX.Y.Z chip").toBeGreaterThan(0);
    const behind = versions.filter((v) => cmpVersion(v, pkgVersion) < 0);
    expect(behind, `deck still says ${behind.join(", ")}`).toEqual([]);
  });
});
