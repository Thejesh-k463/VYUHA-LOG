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
 *      (lib/quotes/openalgo.ts:150-156), so a surface that omits it is not
 *      merely quiet, it is wrong about what the app does;
 *   2. it goes to the user's OWN machine by default — `OPENALGO_DEFAULT_HOST`
 *      is loopback, and the poll's only host is `normalizeHost(creds.host)`
 *      (lib/quotes/openalgo.ts:311-314). "Live prices from your broker" with
 *      no loopback beside it reads as an upload of the book.
 *
 * The check is per SURFACE, not per line: these files are hard-wrapped, so the
 * clause that carries the condition routinely sits on a different line from the
 * claim. Naming the feed anywhere in a file therefore obliges the file to state
 * both conditions somewhere in it.
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
  return src.replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
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

/** The conditions this text is missing, given that it names the feed. */
function missingConditions(text: string): string[] {
  if (namesTheFeed(text).length === 0) return [];
  const missing: string[] = [];
  if (!OPT_IN.test(text)) missing.push("opt-in / behind the disclosure");
  if (!LOOPBACK.test(text)) missing.push("the loopback default");
  return missing;
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
    expect(missingConditions(PLANTED)).toEqual(["opt-in / behind the disclosure", "the loopback default"]);

    // The same claim, said the way v4.1 is allowed to say it.
    const ALLOWED =
      "Live prices from your own OpenAlgo bridge are opt-in, behind the disclosure in Settings, and answer on 127.0.0.1 by default.";
    expect(namesTheFeed(ALLOWED)).toHaveLength(1);
    expect(missingConditions(ALLOWED)).toEqual([]);

    // A surface that never mentions the feed is not obliged to explain it.
    expect(missingConditions("Vyuha reads your broker's tradebook from a file you export.")).toEqual([]);
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
