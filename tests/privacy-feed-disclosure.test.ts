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

  it("both say the /funds probe is not a one-off", () => {
    expect(privacy).toMatch(/each time the desk opens or its price stream reconnects/);
    expect(sheet).toMatch(/each time it opens and each time its price stream reconnects/);
  });

  it("the disclosure version the privacy copy describes is the one on file", () => {
    // A privacy sheet describing a poll, beside a consent version that never
    // mentioned one, is how an install ends up polling on an acceptance of a
    // different statement. "2" is what re-prompted every v1 install; "3" is
    // what re-prompts every v2 install after item 6 stopped being true (v4.2:
    // the bundled NSE holiday list makes the close mark refuse a holiday, so
    // the accepted "weekend only" sentence no longer described what the app
    // writes — docs/DECISIONS.md 2026-09-07, v4.2 wave).
    expect(OPENALGO_DISCLOSURE_VERSION).toBe("3");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   "/funds ONCE" IS A CLAIM ABOUT A COUNT, AND IT WAS WRONG (fix wave 2)
   ══════════════════════════════════════════════════════════════════════════

   Every surface said some version of "one /funds request when the connection
   is checked". `health()` does post `/funds` exactly once per call — that part
   was true — but it has TWO callers, not one: `provider.health()` in
   app/api/live/feed/route.ts (the connection check the user presses) and
   `provider.health()` in app/api/live/stream/route.ts, which runs on every
   desk open and every stream reconnect. A user who reads "once when the
   connection is checked" and then watches their bridge's access log sees a
   request they were told would not happen, and a privacy sheet that is wrong
   about a request is worse than one that never mentioned it.

   Nothing new is SENT — same host, same key, nothing kept but that it replied
   and how long it took — so `OPENALGO_DISCLOSURE_VERSION` stayed "2" through
   that fix (the rule at lib/domain/openalgo-disclosure.ts:25-28: bump on a
   material RISK change). It moved to "3" in v4.2 for a different reason — an
   accepted sentence (item 6, "weekend only") stopped being TRUE about what the
   app writes — which widened the rule, not this one.
   The fix is therefore entirely a copy fix, and a copy fix needs a guard or it
   reverts the first time someone tightens a sentence.

   The rule: wherever a surface puts a COUNT WORD beside `/funds`, the same
   paragraph must also say that the desk connecting is one of the times it is
   sent. A window is used rather than a sentence because the count word and the
   path routinely sit in different clauses of a hard-wrapped line.
*/

/** The path, in every form the surfaces write it (`/funds`, `/api/v1/funds`). */
const FUNDS_PATH = /\/funds\b/gi;

/** A claim about HOW MANY. "one", "once", "a single" — the words that were wrong. */
const COUNT_WORD = /\b(?:once|one|single)\b/i;

/**
 * …and the fact that makes a count claim honest: the desk's own connect is one
 * of the times. Any of these phrasings satisfies it; what may not happen is a
 * count claim with none of them anywhere near it.
 */
const ALSO_ON_CONNECT = /\breconnect(?:s|ed|ing)?\b|\bdesk opens?\b|\bdesk connects?\b|\bdesk\/stream connect\b/i;

/** Characters either side of `/funds` that count as "beside" it. */
const WINDOW = 90;

/**
 * How far the correction may sit from the count claim. Deliberately NOT the
 * whole paragraph: the two TypeScript copy modules carry no blank lines, so a
 * paragraph there is the ENTIRE item list — and `OPENALGO_FEED_ITEMS`' cadence
 * item already says "when the Live Desk opens" about the POLL, which would
 * have excused the `/funds` sentence four items away. Measured: with a
 * paragraph-wide check, reverting the disclosure fix left this guard green.
 */
const QUALIFIER_WINDOW = 200;

/**
 * Every place a surface claims a COUNT beside `/funds` without saying that the
 * desk connecting is one of the occasions. Returned as quotable strings.
 */
function overstatedFundsClaims(text: string): string[] {
  const out: string[] = [];
  for (const para of paragraphs(text)) {
    for (const m of [...para.matchAll(FUNDS_PATH)]) {
      const at = m.index ?? 0;
      const near = para.slice(Math.max(0, at - WINDOW), at + WINDOW);
      if (!COUNT_WORD.test(near)) continue;
      const wide = para.slice(Math.max(0, at - QUALIFIER_WINDOW), at + QUALIFIER_WINDOW);
      if (ALSO_ON_CONNECT.test(wide)) continue;
      out.push(`«${near.trim()}»`);
    }
  }
  return out;
}

/** The v4.1.0 block of a release-notes file, so history is never judged by today's code. */
function currentSection(rel: string, heading: string): string {
  const all = read(rel);
  const start = all.indexOf(heading);
  expect(start, `${rel} no longer has a section starting «${heading}»`).toBeGreaterThan(-1);
  const next = all.indexOf("\n## ", start + 1);
  return next === -1 ? all.slice(start) : all.slice(start, next);
}

describe("no surface says /funds is sent once, because the desk sends it on every connect", () => {
  it.each(SURFACES)("%s", (rel) => {
    const hits = overstatedFundsClaims(read(rel));
    expect(hits, `${rel} states a /funds count without the desk's connect:\n${hits.join("\n")}`).toEqual([]);
  });

  it("CHANGELOG.md — the v4.1.0 section only (older releases are history and are not rewritten)", () => {
    const hits = overstatedFundsClaims(currentSection("CHANGELOG.md", "## v4.1.0"));
    expect(hits, `the v4.1.0 changelog states a /funds count without the desk's connect:\n${hits.join("\n")}`).toEqual([]);
  });

  it("VYUHA-STATE.md — the v4.1.0 state block only", () => {
    const hits = overstatedFundsClaims(currentSection("VYUHA-STATE.md", "## 2-hist. v4.1.0"));
    expect(hits, `VYUHA-STATE §2 states a /funds count without the desk's connect:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the guard really can fire — the sentence every surface shipped before this wave", () => {
    // VERBATIM the copy this block exists to stop coming back.
    const PLANTED = "Checking the connection calls OpenAlgo's /funds endpoint once. It is the cheapest call that proves both the address and the API key are right.";
    const caught = overstatedFundsClaims(PLANTED);
    expect(caught, "the planted 'once' must be caught").toHaveLength(1);
    expect(caught[0]).toContain("/funds endpoint once");

    // The three other shapes it shipped in, each of them equally wrong.
    expect(overstatedFundsClaims("plus one `/funds` request when the connection is checked.")).toHaveLength(1);
    expect(overstatedFundsClaims("covering the cadence, the single `/funds` probe, and the address.")).toHaveLength(1);
    expect(overstatedFundsClaims("`/funds` once when the connection is checked; interval clamped 1–5 s.")).toHaveLength(1);

    // …and the way v4.1 is allowed to say it.
    expect(
      overstatedFundsClaims(
        "Checking the connection calls OpenAlgo's /funds endpoint once, and the desk does the same each time it opens and each time its price stream reconnects.",
      ),
      "the qualified sentence is what the release is allowed to say",
    ).toEqual([]);

    // A surface that never names the path is not obliged to explain it.
    expect(overstatedFundsClaims("Vyuha reads your broker's tradebook from a file you export.")).toEqual([]);
  });

  it("…and fires INSIDE a real surface — the plant lands as its own paragraph, as a copy edit would", () => {
    const PLANTED = "Checking the connection calls OpenAlgo's /funds endpoint once.";
    const privacy = read("docs/client/PRIVACY.md");
    expect(overstatedFundsClaims(privacy), "the shipped privacy sheet is clean").toEqual([]);

    const caught = overstatedFundsClaims(`${privacy}\n\n${PLANTED}\n`);
    expect(caught, "a naked /funds count appended to PRIVACY.md must be caught").toHaveLength(1);
    expect(caught[0]).toContain("once");
  });

  it("at least one shipped surface still names /funds — an empty net proves nothing", () => {
    // Deliberately NOT `FUNDS_PATH` — it carries /g, and `.test()` on a global
    // regex advances `lastIndex`, so the second file would be scanned from an
    // offset and the filter would silently lie.
    const naming = SURFACES.filter((rel) => /\/funds\b/i.test(read(rel)));
    expect(naming, "the privacy sheet must still disclose the probe").toContain("docs/client/PRIVACY.md");
    expect(naming, "the consent sheet must still disclose the probe").toContain("lib/domain/openalgo-disclosure.ts");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   G7 — THE HEURISTIC ABOVE IS A NET, NOT A PIN (fix wave 3)
   ══════════════════════════════════════════════════════════════════════════

   `overstatedFundsClaims()` is a window scan, and both of its windows are
   guesses about how far apart two clauses sit. Two shapes walk through it:

     1. A QUALIFIER ABOUT SOMETHING ELSE, WITHIN 200 CHARACTERS, EXCUSES A
        "ONCE". `ALSO_ON_CONNECT` matches "desk opens" / "reconnects" anywhere
        in the ±200-character window, and it cannot tell what those words are
        ABOUT. The poll, the mark write and the stream all legitimately say
        "the desk opens" — so a sentence that says `/funds` is sent once,
        sitting beside a sentence about when the POLL starts, is waved through.
        That is not hypothetical: the window is 200 characters precisely
        because a paragraph-wide check let item 2's "when the Live Desk opens"
        excuse the `/funds` sentence four items away (the header at :312-319).
        Narrowing the window moved the hole, it did not close it.
     2. A COUNT WORD MORE THAN 90 CHARACTERS FROM `/funds` IS NEVER EXAMINED.
        `WINDOW` is ±90 around the path, so "Vyuha asks your bridge for your
        balance exactly once …" plus 90 characters of true prose, then the path,
        is a count claim the scan never sees.

   Both are the same weakness: a heuristic decides whether copy is honest by
   measuring distance. What the copy actually has to be is ONE known sentence,
   so this block pins that sentence per surface — verbatim, flattened for the
   hard wrap and the markup — and the scan above stays as the wide net that
   catches a surface nobody thought to add to the table.

   Six of the eight surfaces had no pin of any kind before this wave. Four of
   those six do not name `/funds` at all, and their entry is `null`: the rule
   for them is that they may not GAIN a count claim without gaining the
   qualified sentence with it, and a `null` that starts naming the path is a red
   here rather than a green nobody notices.
*/

/** How a reader sees these files: wrap joined, blockquote leaders and markup out. */
function flatten(text: string): string {
  return text
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * The corrected sentence each surface ships, verbatim.
 *
 * `null` means "this surface names no `/funds` path at all", which is also
 * pinned — a surface that starts talking about the probe has to say it the
 * qualified way, and this table is where that gets noticed.
 */
const FUNDS_PIN: Record<string, string | null> = {
  "docs/client/PRIVACY.md":
    "plus one `/funds` request each time you check the connection and each time the desk opens or its price stream reconnects",
  "docs/client/OPENALGO_SETUP_GUIDE.html":
    "Checking the connection calls /api/v1/funds once, and the desk calls it again each time it opens and each time its price stream reconnects",
  "docs/client/README.md":
    "Checking the connection calls OpenAlgo's `/funds` endpoint once, and the desk does the same each time it opens and each time its price stream reconnects",
  "docs/client/GETTING_STARTED_DECK.html": null,
  "docs/client/INSTALLATION_GUIDE.md": null,
  "lib/domain/help-content.ts": null,
  "lib/domain/openalgo-disclosure.ts":
    "Checking the connection calls OpenAlgo's /funds endpoint once, and the desk does the same each time it opens and each time its price stream reconnects.",
  "README.md": null,
};

describe("the corrected /funds sentence is pinned per surface, not merely un-caught (G7)", () => {
  it("the table covers every surface the net covers — a surface added there is not exempt here", () => {
    expect(Object.keys(FUNDS_PIN).sort()).toEqual([...SURFACES].sort());
  });

  it.each(SURFACES)("%s", (rel) => {
    const pin = FUNDS_PIN[rel];
    const flat = flatten(read(rel));
    if (pin === null) {
      expect(
        flat,
        `${rel} has started naming /funds. It may only do so in the qualified form — add its sentence to FUNDS_PIN.`,
      ).not.toMatch(/\/(?:api\/v1\/)?funds\b/i);
      return;
    }
    expect(flat, `${rel} no longer carries the corrected /funds sentence verbatim:\n  ${pin}`).toContain(pin);
  });

  it("every pin actually contains the path and the qualifier — a pin on prose that says neither proves nothing", () => {
    for (const [rel, pin] of Object.entries(FUNDS_PIN)) {
      if (pin === null) continue;
      expect(pin, `${rel}'s pin does not name the path`).toMatch(/\/(?:api\/v1\/)?funds\b/i);
      expect(pin, `${rel}'s pin does not say the desk's connect is one of the times`).toMatch(ALSO_ON_CONNECT);
    }
  });

  it("the pins are what catch the two shapes the window scan lets through", () => {
    // SHAPE 1 — a qualifier about the POLL, 200 characters from a `/funds`
    // count claim, excuses it. Verbatim the structure the surfaces are written
    // in: the cadence sentence and the probe sentence are neighbours.
    const shape1 =
      "While the Live Desk is open Vyuha asks your bridge every 1 to 5 seconds, and the polling starts when the desk opens and stops when it closes. " +
      "Checking the connection calls OpenAlgo's `/funds` endpoint once.";
    // As of this wave the window scan is fooled here ('the desk opens' is about
    // the poll, not about /funds). That is NOT asserted: a sharper scan that
    // catches this shape is an improvement, not a regression.
    // The pin is not: this is not the sentence any surface is allowed to ship.
    expect(flatten(shape1)).not.toContain(FUNDS_PIN["docs/client/README.md"]);

    // SHAPE 2 — the count word sits further than WINDOW (90) from the path.
    const filler = "the cheapest call there is, proving both the address you typed and the API key behind it are right";
    expect(filler.length).toBeGreaterThan(WINDOW);
    const shape2 = `Vyuha asks your bridge for your balance exactly once — ${filler} — by posting /funds.`;
    // Likewise not asserted: the scan is blind when the count word sits more
    // than WINDOW characters from the path; only the pin must catch it.
    expect(flatten(shape2)).not.toContain(FUNDS_PIN["docs/client/README.md"]);
  });

  it("the pin really can fire — the pre-fix sentence, planted into a real surface", () => {
    // VERBATIM the copy fix wave 2 removed, put back the way a copy edit would
    // put it back: the qualifier deleted, the rest of the sentence intact.
    const shipped = read("docs/client/README.md");
    const reverted = shipped.replace(
      "Checking the connection calls OpenAlgo's `/funds` endpoint once, and the desk does the same each time it opens and each time its price stream reconnects — the cheapest call that proves the address and the key are both right.",
      "Checking the connection calls OpenAlgo's `/funds` endpoint once — the cheapest call that proves the address and the key are both right.",
    );
    expect(reverted, "the sentence this test reverts is no longer in the file").not.toBe(shipped);
    expect(flatten(reverted)).not.toContain(FUNDS_PIN["docs/client/README.md"]);
  });
});
