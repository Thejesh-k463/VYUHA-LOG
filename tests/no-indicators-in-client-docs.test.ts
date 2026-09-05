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

// Binary formats (the generated Word guide) cannot be line-scanned as UTF-8 —
// their deflated bytes could match anything. Their TEXT source is what gets
// checked: the .docx is rendered from scripts/build-openalgo-docx.mjs, whose
// content strings this test cannot miss because the HTML twin in docs/client
// carries the same copy and IS scanned.
const BINARY_EXTENSIONS = new Set([".docx", ".pdf", ".png", ".zip"]);

/**
 * ONE exemption, by exact basename (v4.0). `THIRD-PARTY-NOTICES.txt` is the
 * Apache-2.0 attribution for `lightweight-charts`: §4(d) of that licence
 * REQUIRES the notices file to carry the licensor's own attribution notices,
 * and that text names TradingView as the creator ("Copyright 2023 TradingView,
 * Inc.", "TradingView Lightweight Charts(TM)"). Removing those words to
 * satisfy this ban would be a licence breach, and the file names a charting
 * LIBRARY that ships inside the app — not the invite-only Pine indicators a
 * buyer is not sold. The exemption is basename-exact and covers nothing else:
 * every other file under docs/client, and the landing page, is still scanned
 * with the full regex. The dedicated case at the end of this describe re-checks
 * the half of the ban that still applies to the exempted file, so the exemption
 * cannot become a hiding place for real indicator marketing.
 */
const ATTRIBUTION_EXEMPT = new Set(["THIRD-PARTY-NOTICES.txt"]);

/** The part of the ban that applies even to a licence-attribution file. */
const FORBIDDEN_IN_EXEMPT = /pine ?script|\bindicators?\b|\binvite\b/i;

const scanned = [
  ...walk(path.join(root, "docs", "client")),
  path.join(root, "docs", "sales", "landing-page.html"),
].filter((f) => !BINARY_EXTENSIONS.has(path.extname(f).toLowerCase()));

const files = scanned.filter((f) => !ATTRIBUTION_EXEMPT.has(path.basename(f)));

const stripHtmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

describe("client-facing docs never mention the invite-only indicators", () => {
  it("covers the files that ship to buyers", () => {
    const names = scanned.map((f) => path.basename(f));
    for (const must of ["README.md", "TERMS.md", "PRIVACY.md", "REFUND_POLICY.md", "INSTALLATION_GUIDE.md", "GETTING_STARTED_DECK.html", "OPENALGO_SETUP_GUIDE.html", "landing-page.html"]) {
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

  it("the exempted notices file still carries no Pine / indicator / invite wording", () => {
    const exempt = scanned.filter((f) => ATTRIBUTION_EXEMPT.has(path.basename(f)));
    // An exemption for a file that does not ship is dead copy — and would
    // silently stop checking the moment the file is renamed.
    expect(exempt.map((f) => path.basename(f)), "the exemption names a file that does not ship").toEqual([
      ...ATTRIBUTION_EXEMPT,
    ]);
    for (const file of exempt) {
      const lines = stripHtmlComments(readFileSync(file, "utf8")).split("\n");
      const hits = lines
        .map((line, i) => (FORBIDDEN_IN_EXEMPT.test(line) ? `${i + 1}: ${line.trim().slice(0, 120)}` : null))
        .filter((x): x is string => x !== null);
      expect(hits, `indicator wording in the exempted ${path.relative(root, file)}:\n${hits.join("\n")}`).toEqual([]);
    }
  });
});
