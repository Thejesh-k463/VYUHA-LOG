import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPENALGO_FEED_ENABLED } from "@/lib/quotes/types";

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

/**
 * The client README may not sell what 4.0.0 withholds (D-1/D-3/D-4 of the
 * 2026-09-06 re-audit).
 *
 * 1. NO BROKER-PRICED MARKS WHILE THE FLAG IS OFF. `OPENALGO_FEED_ENABLED` in
 *    `lib/quotes/types.ts` is `false` in 4.0.0: the provider is out of the
 *    registry, the Settings radios do not offer it, and a POST asking for it
 *    is a 400. A buyer reading "live prices from your broker" in the ZIP would
 *    be reading about 4.1. The check is the PAIRING, exactly as
 *    `tests/live-feed-copy.test.ts` frames it — OpenAlgo has been in this file
 *    since v3.1 as the IMPORT bridge, and that is true and stays: marketing
 *    may say the bridge imports trades, and may not say it prices them. When
 *    the constant flips to `true` in 4.1 this case skips itself, because the
 *    claim stops being false.
 *
 * 2. THE SIZING LAB WRITE-BACK IS NOT PER POSITION, EVER. It POSTs to
 *    `/api/risk/live-desk`, which writes the `scope:'global'` `risk_config`
 *    row (that table has no `account_id` at all); no position row is touched.
 *    "Written back to the position" was in the v4.0.0 section for one wave and
 *    described a feature that does not exist. Unconditional: no flag makes it
 *    true.
 */
const CLIENT_README = path.join(root, "docs", "client", "README.md");

/** A line is only suspect if it is ABOUT the bridge or a broker. */
const BRIDGE_MENTION = /\bopenalgo\b|\bbrokers?(?:'s|s')?\b/i;

/** …and claims that thing prices your book. */
const PRICING_CLAIM =
  /\b(?:live|real[\s-]?time|streaming|delayed|intraday)\b[^.]{0,40}?\b(?:price|prices|pricing|quote|quotes|feed|feeds|mark|marks|tick|ticks)\b|\bbroker[\s-]?(?:feed|feeds|quote|quotes|tick|ticks|priced)\b|\b(?:price|prices|quote|quotes|mark|marks)\b[^.]{0,30}?\bfrom your broker\b/i;

/** The write-back claim, in any tense. */
const PER_POSITION_WRITEBACK = /\bwrit(?:e|es|ten|ing)\s+back\s+to\s+(?:the\s+|a\s+|your\s+|any\s+)?position/i;

function offendingLines(re: RegExp, extra?: RegExp): string[] {
  return readFileSync(CLIENT_README, "utf8")
    .split("\n")
    .map((line, i) => (re.test(line) && (!extra || extra.test(line)) ? `${i + 1}: ${line.trim().slice(0, 160)}` : null))
    .filter((x): x is string => x !== null);
}

describe("the client README does not sell what v4.0.0 withholds", () => {
  it.skipIf(OPENALGO_FEED_ENABLED)("advertises no OpenAlgo / broker price feed while OPENALGO_FEED_ENABLED is false", () => {
    const hits = offendingLines(BRIDGE_MENTION, PRICING_CLAIM);
    expect(hits, `docs/client/README.md sells a broker feed that 4.0.0 withholds:\n${hits.join("\n")}`).toEqual([]);
  });

  it("never says a size is written back to the position (the write-back is the global risk_config row)", () => {
    const hits = offendingLines(PER_POSITION_WRITEBACK);
    expect(hits, `docs/client/README.md claims a per-position write-back:\n${hits.join("\n")}`).toEqual([]);
  });
});
