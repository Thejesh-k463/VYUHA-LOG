import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPENALGO_DEFAULT_HOST,
  OPENALGO_DISCLOSURE_VERSION,
  OPENALGO_FEED_ITEMS,
} from "@/lib/domain/openalgo-disclosure";

/**
 * THE FEED IS NEVER NAMED WITHOUT ITS TWO CONDITIONS (v4.1).
 *
 * v4.1 turns the OpenAlgo bridge into a PRICE source, and the two facts that
 * make that harmless are exactly the two a copy edit drops first:
 *
 *   1. it is OPT-IN, behind a disclosure the user accepts — `openAlgoGate()`
 *      plus `isAckCurrent()` refuse every request until then
 *      (lib/quotes/openalgo.ts:156-162, inside `readGateFromDb()`: the settings
 *      select through `if (!gate.allowed) return { state: "disabled", … }`), so
 *      a surface that omits it is not
 *      merely quiet, it is wrong about what the app does;
 *   2. it goes to the user's OWN machine by default — `OPENALGO_DEFAULT_HOST`
 *      is loopback, and the poll's only host is `normalizeHost(creds.host)`
 *      (lib/quotes/openalgo.ts:317, `const base = normalizeHost(creds.host)` in
 *      `post()`). "Live prices from your broker" with
 *      no loopback beside it reads as an upload of the book.
 *
 * The check is per PARAGRAPH (fix wave, 2026-09-06), not per line and no longer
 * per file. Not per line because these files are hard-wrapped at ~78 columns and
 * marked up, so the clause carrying a condition routinely sits on a different
 * line from the claim. No longer per file because a whole-file scan is satisfied
 * by any occurrence of "disclosure" or "127.0.0.1" anywhere in a nine-hundred
 * line document: appending
 *
 *   "Live prices from your broker stream into the Live Desk through the
 *    OpenAlgo bridge."
 *
 * to `docs/client/PRIVACY.md` passed the per-file form, because item 1 of that
 * file says "opt-in" and item 3 says "127.0.0.1" — a condition forty screens
 * away is not beside the claim. The paragraph is the unit a reader reads at
 * once: a blank-line-separated block of prose, a `<p>`, a `<ul>`, or — in the
 * two TypeScript copy modules, whose string literals carry no blank lines — the
 * whole entry/item list, which is precisely what one help card and one consent
 * sheet render together.
 *
 * `tests/no-indicators-in-client-docs.test.ts` holds the tighter, per-line
 * version of the same rule over the client README; this one is the wide net
 * across every surface that describes the feed at all.
 */

const ROOT = path.resolve(__dirname, "..");

/**
 * Only VISIBLE copy is judged. Every claim in these files is required to cite
 * the code line that performs it, and those citations live in `<!-- -->` and
 * `//` comments that name `lib/quotes/openalgo.ts` and the word "prices" — a
 * scan that reads them would find a feed claim in a file whose reader can see
 * none, which is how a guard passes on a document that says nothing. The `:` in
 * `https://` is guarded the same way `tests/live-feed-copy.test.ts` guards it.
 */
function visible(src: string): string {
  return (
    src
      .replace(/<!--[\s\S]*?-->/g, "")
      // A COMMENT-ONLY LINE IS DELETED WHOLE, newline included. Blanking it in
      // place leaves a whitespace-only line, and the paragraph splitter below
      // would read that as a paragraph break — fragmenting `OPENALGO_FEED_ITEMS`
      // and `HELP_ENTRIES`, whose items are separated by nothing but the
      // citation comments above each string, into "paragraphs" no reader sees.
      .replace(/^[ \t]*\/\/[^\n]*\r?\n/gm, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      // An in-page anchor is NAVIGATION, not a claim. The setup guide's table of
      // contents lists "The OpenAlgo API key" and "Live prices on the Live Desk"
      // as two `<li>`s of one `<ol>`; judged as a paragraph that is a bridge and
      // a feed claim with no conditions, which is a guard reading a menu. Each
      // heading is judged where the section it names actually lives.
      .replace(/<a href="#[^"]*">[\s\S]*?<\/a>/g, " ")
  );
}

const read = (rel: string) => visible(fs.readFileSync(path.join(ROOT, rel), "utf8"));

/** Every surface that describes, or could describe, the live price feed. */
const SURFACES = [
  "docs/client/PRIVACY.md",
  "docs/client/OPENALGO_SETUP_GUIDE.html",
  "docs/client/README.md",
  "docs/client/GETTING_STARTED_DECK.html",
  "docs/client/INSTALLATION_GUIDE.md",
  "lib/domain/help-content.ts",
  "lib/domain/openalgo-disclosure.ts",
  // Added in the fix wave. The repository README is the first thing a buyer
  // reads and it describes the feed in its "New in 4.1" block; it was outside
  // this net purely because the net was built from the client pack.
  "README.md",
] as const;

/** The document is about the bridge at all. */
const BRIDGE = /\bopenalgo\b|\bbridge\b/i;

/**
 * …and somewhere in it, claims something is priced LIVE. Deliberately not the
 * bare word "price": these documents talk about entry prices, a repaired
 * quantity recovered from "value ÷ price" and a broker's paid market-data
 * tiers, none of which is this feature. The four alternates are the shapes the
 * feed is actually described in.
 */
const FEED_CLAIM =
  /\b(?:live|real[\s-]?time|streaming)\b[^.]{0,60}?\b(?:price|prices|pricing|quote|quotes|feed)\b|\bprices? your (?:open )?positions\b|\bprices the desk\b|\bprice source\b/i;

/** Condition 1 — the user chose it, after reading the disclosure. */
const OPT_IN = /opt-in|disclosure|until you (?:pick|turn|switch)|only after you|you switch the integration on|off until you/i;

/** Condition 2 — the default address is this computer. */
const LOOPBACK = /127\.0\.0\.1|loopback/i;

/**
 * The paragraphs of a surface: blank-line-separated blocks, markup flattened.
 *
 * This is the unit both halves of the guard now work in — the claim is found in
 * a paragraph and the conditions are required in THAT paragraph.
 */
function paragraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Every SENTENCE that says the bridge produces a live price.
 *
 * By sentence, not by line and not by document. Not by line because these files
 * are hard-wrapped at ~78 columns and marked up, so "the Live Desk price poll"
 * and "prices your open positions" routinely straddle two source lines and a
 * `<b>` tag. Not by document because a whole-file scan pairs any two words that
 * happen to share a file: it read `docs/client/README.md`'s refusal sentence
 * ("Breach alerts say 'check a live quote and review your plan'") as a feed
 * claim, and that sentence is the opposite of one.
 */
function namesTheFeed(text: string): string[] {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => BRIDGE.test(sentence) && FEED_CLAIM.test(sentence))
    .map((sentence) => sentence.trim().slice(0, 160));
}

/**
 * The conditions this text is missing — checked PER PARAGRAPH.
 *
 * Each returned string names the paragraph and what it left out, so the failure
 * message points at the copy to edit rather than at the file.
 */
function missingConditions(text: string): string[] {
  const out: string[] = [];
  for (const para of paragraphs(text)) {
    if (namesTheFeed(para).length === 0) continue;
    const missing: string[] = [];
    if (!OPT_IN.test(para)) missing.push("opt-in / behind the disclosure");
    if (!LOOPBACK.test(para)) missing.push("the loopback default");
    if (missing.length > 0) out.push(`${missing.join(" + ")} — «${para.slice(0, 140)}»`);
  }
  return out;
}

describe("every surface that names the live price feed also states its conditions", () => {
  it.each(SURFACES)("%s", (rel) => {
    const text = read(rel);
    const missing = missingConditions(text);
    expect(
      missing,
      `${rel} prices the book from the bridge but never states: ${missing.join(", ")}\n` +
        `  first claim → ${namesTheFeed(text)[0] ?? ""}`,
    ).toEqual([]);
  });

  it("the guard really can fire — a planted claim with no conditions is caught", () => {
    // Verbatim the sentence this whole file exists to stop shipping:
    const PLANTED = "Live prices from your broker stream into the Live Desk through the OpenAlgo bridge.";
    expect(namesTheFeed(PLANTED), "the planted claim must be recognised as a feed claim").toHaveLength(1);
    expect(missingConditions(PLANTED)).toHaveLength(1);
    expect(missingConditions(PLANTED)[0]).toContain("opt-in / behind the disclosure + the loopback default");

    // The same claim, said the way v4.1 is allowed to say it.
    const ALLOWED =
      "Live prices from your own OpenAlgo bridge are opt-in, behind the disclosure in Settings, and answer on 127.0.0.1 by default.";
    expect(namesTheFeed(ALLOWED)).toHaveLength(1);
    expect(missingConditions(ALLOWED)).toEqual([]);

    // A surface that never mentions the feed is not obliged to explain it.
    expect(missingConditions("Vyuha reads your broker's tradebook from a file you export.")).toEqual([]);
  });

  it("…and fires INSIDE a real surface, which the per-file form could not", () => {
    // The regression this change exists for. `docs/client/PRIVACY.md` says
    // "opt-in" in item 1 and "127.0.0.1" in item 3, so the per-file scan was
    // satisfied no matter what was appended to it. Dropped in as its own
    // paragraph — exactly how a copy edit would land — the plant must be caught.
    const PLANTED = "Live prices from your broker stream into the Live Desk through the OpenAlgo bridge.";
    const privacy = read("docs/client/PRIVACY.md");
    expect(missingConditions(privacy), "the shipped file is clean").toEqual([]);

    const doped = `${privacy}\n\n${PLANTED}\n`;
    const caught = missingConditions(doped);
    expect(caught, "a naked claim appended to PRIVACY.md must be caught").toHaveLength(1);
    expect(caught[0]).toBe(
      `opt-in / behind the disclosure + the loopback default — «${PLANTED}»`,
    );

    // …and the per-FILE form it replaces would have passed the same text, which
    // is what makes this change a fix rather than a rewording.
    const perFile = OPT_IN.test(doped) && LOOPBACK.test(doped);
    expect(perFile, "the old whole-file check passed the doped document").toBe(true);
  });

  it("at least one shipped surface actually describes the feed — an empty net proves nothing", () => {
    const describing = SURFACES.filter((rel) => namesTheFeed(read(rel)).length > 0);
    expect(describing.length, "no client surface describes the v4.1 feed at all").toBeGreaterThan(0);
    expect(describing, "the privacy sheet must be one of them").toContain("docs/client/PRIVACY.md");
    // The setup guide is the document a buyer reads WHILE wiring the bridge up;
    // a guide that walks them through connecting it and never mentions that it
    // can also price the desk sends them to the disclosure cold.
    expect(describing, "the OpenAlgo setup guide must describe the feed too").toContain(
      "docs/client/OPENALGO_SETUP_GUIDE.html",
    );
  });
});

describe("the consent sheet and the privacy sheet agree about the feed", () => {
  const privacy = read("docs/client/PRIVACY.md").replace(/\s+/g, " ");
  const sheet = OPENALGO_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ");

  it("both state the 1–5 second cadence", () => {
    expect(privacy).toMatch(/every 1–5 seconds/);
    expect(sheet).toMatch(/every 1 to 5 seconds|1 to 5 seconds/i);
  });

  it("both state the /funds probe", () => {
    expect(privacy).toMatch(/\/funds/);
    expect(sheet).toMatch(/\/funds/);
  });

  it("both state the loopback default, and it is the constant the code ships", () => {
    expect(OPENALGO_DEFAULT_HOST).toBe("http://127.0.0.1:5000");
    expect(privacy).toContain(OPENALGO_DEFAULT_HOST);
    expect(sheet).toContain(OPENALGO_DEFAULT_HOST);
  });

  it("both say the on-screen prices are not written as ticks", () => {
    expect(privacy).toMatch(/never written to your journal as ticks/i);
    expect(privacy).toMatch(/one mark per position per day/i);
    expect(sheet).toMatch(/one mark per position per day/i);
  });

  it("the disclosure version the privacy copy describes is the one on file", () => {
    // A privacy sheet describing a poll, beside a consent version that never
    // mentioned one, is how an install ends up polling on an acceptance of a
    // different statement. "2" is what re-prompts every v1 install.
    expect(OPENALGO_DISCLOSURE_VERSION).toBe("2");
  });
});
