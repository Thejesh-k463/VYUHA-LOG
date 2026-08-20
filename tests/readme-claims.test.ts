import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * README.md is the GitHub landing page, and it has drifted from the product
 * more than once: it rendered a screenshot of a skin that had been retired
 * and deleted (skin-royal.png), advertised "PDF" beside the six real broker
 * importers when the PDF path reads text and imports nothing (see the header
 * of lib/import/registry-meta.ts), and carried three different test counts on
 * the same page. None of that is caught by typecheck, lint or the suite,
 * because none of it is code. These assertions are anchored to the exact
 * sentences the README now uses; if you rewrite one, move the anchor with it
 * rather than loosening the regex.
 */

const root = process.cwd();
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const lines = readme.split(/\r?\n/);

describe("README screenshots exist on disk", () => {
  const refs = [...readme.matchAll(/docs\/screenshots\/([\w.-]+\.(?:png|jpg|jpeg|webp|gif))/g)].map(
    (m) => m[1],
  );

  it("references at least the hero and the retaken skin set", () => {
    expect(refs).toContain("dashboard.png");
    for (const skin of ["lime", "rose", "ember", "sapphire", "aurora"]) {
      expect(refs).toContain(`skin-${skin}.png`);
    }
  });

  it("every referenced file exists (a deleted screenshot renders as a broken image on GitHub)", () => {
    const missing = [...new Set(refs)].filter(
      (f) => !existsSync(path.join(root, "docs", "screenshots", f)),
    );
    expect(missing).toEqual([]);
  });
});

describe("README skin roster says nine", () => {
  // Historical changelog quotes ("v2.99.70 — seven skins", "v2.99.96 — eight
  // skins") are allowed ONLY on a blockquote line that names that release.
  it("no 'seven skins' / 'eight skins' outside a dated release-note quote", () => {
    const offenders = lines.filter(
      (l) => /\b(seven|eight)\s+skins\b/i.test(l) && !/^>\s*\*\*v2\.99\.(7\d|96)\b/.test(l),
    );
    expect(offenders).toEqual([]);
  });

  it("the current-roster statement says nine skins", () => {
    expect(readme).toMatch(/### 🎨 Appearance — nine skins, tint, panels, custom, wallpaper/);
    expect(readme).toMatch(/\*\*Nine skins\*\*: eight built-in — Luxe, Terminal, Tape, Sapphire, Aurora, Lime, Rose, Ember — plus \*\*Custom\*\*/);
  });
});

describe("README importers line", () => {
  const importLine = lines.find((l) => l.startsWith("- **Import from ANY broker.**"));

  it("exists", () => {
    expect(importLine).toBeDefined();
  });

  it("does not list PDF as an importer (the PDF path reads text and imports no trades)", () => {
    // The six parsers end the sentence at "charge breakdown)." — anything
    // like "— plus PDF" appended there is the drift this guards against.
    expect(importLine).not.toMatch(/charge breakdown\)\s*[—-]\s*plus\s+PDF/i);
    expect(importLine).not.toMatch(/\bplus PDF\b/i);
    expect(importLine).toMatch(/A broker PDF is read for its text only/);
  });

  it("the hero line separates auto-detected formats, the column mapper and API pulls", () => {
    expect(readme).toMatch(
      /\*6 auto-detected broker formats \(Zerodha, Dhan, Groww, Angel One, Upstox, Paytm Money\) \+ any CSV via the column mapper \+ 3 broker-API pulls \(Kite, Dhan, Angel One SmartAPI\)/,
    );
  });
});

describe("README test counts agree with each other", () => {
  const badgeTests = Number(readme.match(/badge\/tests-(\d+)%20passing/)?.[1]);
  const badgeE2e = Number(readme.match(/badge\/e2e-(\d+)%20flows/)?.[1]);
  const glance = readme.match(/\| \*\*([\d,]+)\*\* \| \*\*\d+\*\* \| \*\*0\*\* \|\r?\n\| tests, (\d+) end-to-end flows/);
  const tree = readme.match(/tests\/\s+(\d+) unit \+ integration tests across (\d+) files/);
  const e2eTree = readme.match(/e2e\/\s+(\d+) Playwright flows through the real app, in (\d+) specs/);
  const engineering = readme.match(/- \*\*([\d,]+) tests\.\*\* Most run over pure/);
  const npmTest = readme.match(/Vitest unit \+ integration suite \(([\d,]+) tests\)/);
  const npmE2e = readme.match(/Playwright e2e — (\d+) flows incl\./);
  const layout = readme.match(/tests\/\s+# (\d+) Vitest unit \+ integration tests/);
  const num = (s: string | undefined) => Number((s ?? "").replace(/,/g, ""));

  it("all six unit-test figures equal the badge", () => {
    expect(badgeTests).toBeGreaterThan(0);
    expect(num(glance?.[1])).toBe(badgeTests);
    expect(num(tree?.[1])).toBe(badgeTests);
    expect(num(engineering?.[1])).toBe(badgeTests);
    expect(num(npmTest?.[1])).toBe(badgeTests);
    expect(num(layout?.[1])).toBe(badgeTests);
  });

  it("all four e2e figures equal the badge", () => {
    expect(badgeE2e).toBeGreaterThan(0);
    expect(num(glance?.[2])).toBe(badgeE2e);
    expect(num(e2eTree?.[1])).toBe(badgeE2e);
    expect(num(npmE2e?.[1])).toBe(badgeE2e);
  });

  it("the unit-test FILE count matches tests/*.test.ts on disk", () => {
    // The six figures above agree with each other and with nothing else, so
    // they stayed green at 1,858/128 while the suite had moved to 1,918/131
    // (found by an audit on 2026-08-20, not by this file). The TEST count
    // cannot be checked without running vitest, but the FILE count can be
    // read off disk — and in practice they move together, so this catches a
    // stale README the next time the suite grows.
    const files = readdirSync(path.join(root, "tests")).filter((f) => f.endsWith(".test.ts"));
    const stated = readme.match(/unit \+ integration tests across (\d+) files/);
    expect(num(stated?.[1]), "README states a tests/ file count that is not on disk").toBe(files.length);
  });

  it("the screenshot count matches docs/screenshots/*.png on disk", () => {
    const shots = readdirSync(path.join(root, "docs", "screenshots")).filter((f) => f.endsWith(".png"));
    const stated = readme.match(/screenshots\/\s+(\d+) shots retaken/);
    expect(num(stated?.[1])).toBe(shots.length);
  });

  it("the e2e spec count matches e2e/*.spec.ts on disk", () => {
    const specs = readdirSpecs();
    expect(num(e2eTree?.[2])).toBe(specs.length);
  });
});

describe("README release notes read newest first", () => {
  // The "Why Vyuha?" blockquote once ran v2.99.92 … v2.99.75, THEN v2.99.97,
  // v2.99.96, then v2.99.70 — so GitHub opened on a five-release-old note and
  // three releases had no note at all. Order is not something a reader
  // notices; only the assertion does.
  const versions = [...readme.matchAll(/^> \*\*v(2\.99\.\d+)/gm)].map((m) => m[1]);
  const key = (v: string) => v.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0);

  it("the first version quote is the highest version present", () => {
    expect(versions.length).toBeGreaterThan(3);
    const highest = versions.reduce((a, b) => (key(b) > key(a) ? b : a));
    expect(versions[0]).toBe(highest);
  });

  it("the 'Now:' line names the same version as the first quote", () => {
    const now = readme.match(/^> \*\*Now: v(2\.99\.\d+)\*\*/m)?.[1];
    expect(now).toBe(versions[0]);
  });

  it("every quote is in descending order", () => {
    for (let i = 1; i < versions.length; i++) {
      expect(key(versions[i]), `${versions[i]} after ${versions[i - 1]}`).toBeLessThan(key(versions[i - 1]));
    }
  });
});

function readdirSpecs(): string[] {
  return readdirSync(path.join(root, "e2e")).filter((f) => f.endsWith(".spec.ts"));
}
