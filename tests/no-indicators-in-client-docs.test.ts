import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The TradingView / Pine Script indicators are invite-only and NOT part of
 * what a Vyuha buyer is sold (docs/owner/PINE_SCRIPT_INVITE_ONLY.md). Nothing
 * that ships in the client ZIP, and not the public landing page, may mention
 * them — a buyer who reads "indicators" in the paperwork will ask where they
 * are. Checked at 2026-08-15: the word "indicator" appears in none of these
 * files' visible text, so the match is deliberately broad (the bare word, not
 * just "indicator bundle/pack"). If a legitimate, unrelated use ever appears
 * (e.g. "a data-quality indicator"), narrow the regex to
 * /tradingview|pine ?script|indicators? (bundle|pack|included)/i — do not
 * delete the test.
 *
 * HTML comments are stripped first: docs/sales/landing-page.html carries an
 * owner-facing source note ("TradingView profile link: REMOVED ...") that a
 * browser never renders.
 */

const root = process.cwd();
const FORBIDDEN = /tradingview|pine ?script|\bindicators?\b/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = [
  ...walk(path.join(root, "docs", "client")),
  path.join(root, "docs", "sales", "landing-page.html"),
];

const stripHtmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

describe("client-facing docs never mention the invite-only indicators", () => {
  it("covers the files that ship to buyers", () => {
    const names = files.map((f) => path.basename(f));
    for (const must of ["README.md", "TERMS.md", "PRIVACY.md", "REFUND_POLICY.md", "INSTALLATION_GUIDE.md", "GETTING_STARTED_DECK.html", "landing-page.html"]) {
      expect(names, `${must} missing from the checked set`).toContain(must);
    }
  });

  for (const file of files) {
    it(`${path.relative(root, file)} has no TradingView / Pine Script / indicator wording`, () => {
      const visible = stripHtmlComments(readFileSync(file, "utf8"));
      const lines = visible.split("\n");
      const hits = lines
        .map((line, i) => (FORBIDDEN.test(line) ? `${i + 1}: ${line.trim().slice(0, 120)}` : null))
        .filter((x): x is string => x !== null);
      expect(hits, `forbidden wording in ${path.relative(root, file)}:\n${hits.join("\n")}`).toEqual([]);
    });
  }
});
