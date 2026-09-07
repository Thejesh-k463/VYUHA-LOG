import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ENTRIES } from "@/lib/domain/help-content";

/**
 * THE v4.2 ANGEL ONE PRIVACY PARAGRAPH, HELD TO ONE HOST — AND TO A HOST THAT
 * WAS ALREADY THERE.
 *
 * `tests/client-docs-upstox-feed.test.ts` is the sibling of this file and holds
 * the same three properties for `api.upstox.com`. Angel One differs in exactly
 * one way, and it is the ruling that matters (4.2-3): **this release adds no
 * network host at all.** `apiconnect.angelone.in` is already the host the Angel
 * One trade pull signs in to and reads from, so the Live Desk poll adds VOLUME
 * to a disclosed host rather than a host — which is why "exactly four kinds"
 * and "there is no fifth thing" both survive it untouched.
 *
 * What this file guards:
 *
 *   1. THE HOST IS NAMED ONCE, AND IN ITEM 3. A second mention elsewhere in the
 *      sheet is how a host acquires a second, looser justification; a mention
 *      outside the four-kinds list is a disclosure that sentence no longer
 *      covers.
 *   2. THE TWO ANGEL ONE HOSTS VYUHA DOES NOT CONTACT ARE NAMED NOWHERE. The
 *      websocket feed and the margin API are real, documented endpoints of the
 *      same broker. Prose written ahead of the code would pre-authorise them:
 *      the egress guard's rule is "the sentence is in PRIVACY.md".
 *   3. THE CLAIMS THAT MAKE THE POLL HARMLESS ARE ALL PRESENT — the unattended
 *      once-a-day sign-in, the token look-up kept locally, the batching and the
 *      rate, the tiers, the 500-key cap on the selected account, equities only,
 *      and the prices staying here. Any one of them dropped by a copy edit
 *      leaves a paragraph that is true about the host and wrong about the
 *      request.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** What a buyer SEES: the citation comments are for the next maintainer. */
const visible = (src: string) => src.replace(/<!--[\s\S]*?-->/g, " ");

const PRIVACY = "docs/client/PRIVACY.md";
const privacyVisible = visible(read(PRIVACY));

/** Every markdown file in the client pack — the ZIP a buyer downloads. */
const CLIENT_MD = readdirSync(path.join(ROOT, "docs", "client"))
  .filter((f) => f.toLowerCase().endsWith(".md"))
  .map((f) => `docs/client/${f}`);

/** The disclosed host — one, and the one the trade pull already uses. */
const QUOTE_HOST = "apiconnect.angelone.in";

/** Angel One endpoints Vyuha does NOT contact: the socket and the margin API. */
const NEVER_CONTACTED = ["smartapisocket.angelone.in", "margincalculator.angelbroking.com"];

/** Item 3 of the four-kinds list, from its own marker to item 4's. */
function itemThree(text: string): string {
  const start = text.indexOf("3. **Broker API pulls");
  const end = text.indexOf("4. **The Telegram", start + 1);
  expect(start, "PRIVACY.md no longer has an item 3 that starts with the broker pulls").toBeGreaterThan(-1);
  expect(end, "PRIVACY.md no longer has an item 4").toBeGreaterThan(start);
  return text.slice(start, end);
}

/** The Angel One paragraph of item 3 — from its first word to the end of it. */
function angelOneParagraph(): string {
  const item = itemThree(privacyVisible);
  const at = item.indexOf("Angel One can price the desk instead");
  expect(at, "PRIVACY item 3 no longer carries the Angel One paragraph").toBeGreaterThan(-1);
  return item.slice(at);
}

describe("PRIVACY.md discloses exactly one Angel One host, in item 3", () => {
  it(`names ${QUOTE_HOST} exactly once in the copy a buyer reads`, () => {
    const hits = privacyVisible.split(QUOTE_HOST).length - 1;
    expect(hits, `${PRIVACY} names ${QUOTE_HOST} ${hits} times; it is disclosed once, in item 3`).toBe(1);
  });

  it("and that occurrence is inside item 3, which the four-kinds sentence covers", () => {
    expect(itemThree(privacyVisible), "the host is disclosed outside the four-kinds list").toContain(QUOTE_HOST);
    expect(privacyVisible).toContain("Exactly four kinds, and only one of them is automatic:");
    expect(privacyVisible).toContain("That is the complete list for Vyuha Desktop. There is no fifth thing.");
  });

  it("says out loud that this is not a NEW host (ruling 4.2-3)", () => {
    // The whole justification for leaving "four kinds" alone. If the sentence
    // that carries it is ever dropped, the paragraph reads as a fifth thing.
    expect(angelOneParagraph().replace(/\s+/g, " ")).toMatch(
      /the host the Angel One trade pull already\s*uses, so this adds no new one/,
    );
  });

  it("states the poll in full: the sign-in, the look-up, the batching, the cap and the scope", () => {
    const para = angelOneParagraph().replace(/\s+/g, " ");
    expect(para, "the disclosure does not say the session is cleared daily").toMatch(
      /clears every API session at 5 AM IST/,
    );
    // v4.2 fix wave, B-7. "signs in once a day" was true PER PROCESS only: the
    // jwt is cached in memory by the adapter, so a relaunch or a credential
    // re-save opens another session the same day, and a day the app never
    // opens produces none. The disclosure states the mechanism instead.
    expect(para, "the disclosure no longer states when a SECOND sign-in happens").toMatch(
      /at most once a day while it stays open, and again after a relaunch or when you re-save the credentials/,
    );
    expect(para, "the disclosure still claims a calendar-daily sign-in").not.toMatch(/signs in once a day/);
    expect(para, "the disclosure does not say the sign-in is unattended").toMatch(/nothing for you to click/);
    expect(para, "the disclosure does not mention the token look-up").toMatch(
      /looks up, once per symbol, the token Angel One prices by/,
    );
    expect(para, "the disclosure does not say the look-up stays here").toMatch(/keeps that mapping on this machine/);
    expect(para, "the disclosure does not state the batch size").toMatch(/batches of at most 50 symbols/);
    expect(para, "the disclosure does not state the rate").toMatch(/at most one request a second/);
    expect(para, "the disclosure does not state the tiers").toMatch(/every 3, 5 or 10 seconds/);
    // v4.2 fix wave 2, B-6 — what the TIER is a function of. The ladder is fed
    // the deduped instrument keys the poll will ask for, so two positions in
    // one scrip are one price and one tier step; "how many positions you hold"
    // states a slower interval than the code will actually run (invariant 6).
    expect(para, "the tier is still said to come from the position count").toMatch(
      /depending on how many scrips you hold open/,
    );
    expect(para, "the tier is still said to come from the position count").not.toMatch(
      /how many positions you hold/,
    );
    expect(para, "the disclosure does not scope the poll to the selected account").toMatch(
      /only for the open positions of the selected account/,
    );
    expect(para, "the disclosure does not cap the keys").toMatch(/at most 500 of them/);
    expect(para, "the disclosure does not say what the poll leaves out").toMatch(
      /no quantity, no entry price, no P&L, no account/,
    );
    expect(para, "the disclosure does not scope the release to equities").toMatch(/Equities only in this release/);
    expect(para, "the disclosure does not say the prices stay here").toMatch(/never uploaded, never resold/);
    // v4.2 fix wave, B-5 — and what a derivative row shows INSTEAD.
    expect(para, "the disclosure does not say what an unpriced derivative row shows").toContain(
      "Futures and options rows are not priced by this feed: each shows the position's recorded close, or its entry price when no close is recorded, and says so on the row.",
    );
  });
});

/**
 * v4.2 fix wave, B-6 — THE CADENCE COUNTS SCRIPS, NOT POSITIONS.
 *
 * `angelOneCadenceSeconds()` is fed the DEDUPED instrument keys the poll will
 * actually ask for, so two positions in one symbol are one price. Every written
 * surface said "open positions", which states a slower interval than the code
 * runs for any book that doubles up — and it is the kind of error a reader can
 * only find by timing the desk with a stopwatch.
 */
describe("the Angel One cadence is stated in scrips on every client surface", () => {
  const clientReadme = visible(read("docs/client/README.md"));

  it("the client README's tier row counts scrips", () => {
    const row = clientReadme.split("\n").find((l) => /3 seconds\*{0,2} up to 50/.test(l));
    expect(row, "the client README no longer states the Angel One tiers").toBeDefined();
    expect(row!, "the tier row still counts positions").not.toMatch(/up to 50 open positions/);
    expect(row!, "the tier row does not count scrips").toMatch(/up to 50 scrips/);
    expect(row!, "the row never says what a scrip is here").toMatch(/distinct symbols/i);
  });

  it("the scan can fire — the row exactly as it shipped is caught", () => {
    const shipped =
      "| **Angel One's refresh is set by the size of your book, not by a slider** | Angel One allows about one request a second, so the interval is arithmetic rather than a preference: **3 seconds** up to 50 open positions, **5 seconds** from 51 to 200, **10 seconds** from 201 to 500. |";
    expect(/3 seconds\*{0,2} up to 50/.test(shipped), "the finder cannot see the shipped row").toBe(true);
    expect(/up to 50 open positions/.test(shipped)).toBe(true);
    expect(/up to 50 scrips/.test(shipped)).toBe(false);
  });
});

describe("no shipped doc names an Angel One host Vyuha does not contact", () => {
  const surfaces: [string, string][] = [
    ...CLIENT_MD.map((rel): [string, string] => [rel, visible(read(rel))]),
    ["README.md", visible(read("README.md"))],
    ["lib/domain/help-content.ts", HELP_ENTRIES.flatMap((e) => [e.answers, ...e.body, ...(e.refusals ?? [])]).join(" ")],
  ];

  it("the scan reads the files that actually ship", () => {
    const names = surfaces.map(([rel]) => rel);
    for (const must of [PRIVACY, "docs/client/README.md", "README.md", "lib/domain/help-content.ts"]) {
      expect(names, `${must} is not in the scanned set`).toContain(must);
    }
  });

  it.each(NEVER_CONTACTED)("%s appears in none of them", (host) => {
    const hits = surfaces.filter(([, text]) => text.toLowerCase().includes(host)).map(([rel]) => rel);
    expect(hits, `${host} is named in ${hits.join(", ")} — Vyuha never contacts it`).toEqual([]);
  });

  it("the scan can fire — the same check over a planted line catches it", () => {
    const planted = "Vyuha subscribes to smartapisocket.angelone.in while the desk is open.";
    expect(NEVER_CONTACTED.filter((h) => planted.toLowerCase().includes(h))).toEqual([
      "smartapisocket.angelone.in",
    ]);
  });

  it("never names the SmartAPI registration screen in the bullet — the user's browser goes there", () => {
    // smartapi.angelone.in is where the user registers the app themselves. It
    // is a HELP fact; in a list of the requests Vyuha makes it would be false.
    expect(privacyVisible, "PRIVACY.md names a host Vyuha does not request").not.toContain("smartapi.angelone.in");
  });
});

describe("the new Angel One copy is descriptive, never prescriptive (SEBI copy rule)", () => {
  /** The same vocabulary tests/live-feed-copy.test.ts bans on the Settings card. */
  const BANNED =
    /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed)\b/i;

  function sentencesOf(text: string): string[] {
    return text
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** The v4.2.0 section of the client README — everything above the 4.1 heading. */
  function v42Section(): string {
    const text = visible(read("docs/client/README.md"));
    const at = text.indexOf("## New in v4.2.0");
    const end = text.indexOf("## New in v4.1.0", at + 1);
    expect(at, "the client README has no v4.2.0 section").toBeGreaterThan(-1);
    expect(end, "the client README has no v4.1.0 section after it").toBeGreaterThan(at);
    return text.slice(at, end);
  }

  const scanned: [string, () => string][] = [
    [PRIVACY, angelOneParagraph],
    ["docs/client/README.md", v42Section],
  ];

  it.each(scanned)("%s carries no prescriptive vocabulary in its Angel One copy", (rel, text) => {
    const sentences = sentencesOf(text());
    expect(sentences.length, `${rel} says nothing about the Angel One source`).toBeGreaterThan(3);
    expect(
      sentences.filter((s) => /angel one/i.test(s)).length,
      `${rel}'s scanned block never names Angel One`,
    ).toBeGreaterThan(0);
    const offenders = sentences.filter((s) => BANNED.test(s)).map((s) => s.slice(0, 120));
    expect(offenders, `prescriptive vocabulary in ${rel}:\n${offenders.join("\n")}`).toEqual([]);
    // The word this product prints on no surface at all (owner ruling).
    const alerts = sentences.filter((s) => /\balerts?\b/i.test(s));
    expect(alerts, `${rel} calls something an alert`).toEqual([]);
  });

  it("the client README no longer says the Angel One feed is withheld", () => {
    // It said "Angel One's feed is **not** enabled in this release." while the
    // Upstox row was the only broker source. A stale withholding note is a
    // claim about the product a buyer can disprove on the first screen.
    expect(v42Section(), "the client README still withholds the Angel One feed").not.toMatch(
      /Angel One'?s feed is \*\*not\*\* enabled/i,
    );
    expect(visible(read("README.md")), "the root README still withholds the Angel One feed").not.toMatch(
      /and Angel One'?s feed is \*\*not\*\* enabled/i,
    );
  });

  it("the scan can fire on a sentence of exactly this shape", () => {
    expect(BANNED.test("Consider the Angel One feed for a faster mark on the desk.")).toBe(true);
    const planted = sentencesOf("You should pick the Angel One source to price the desk.");
    expect(planted).toHaveLength(1);
    expect(planted.filter((s) => BANNED.test(s))).toHaveLength(1);
  });
});
