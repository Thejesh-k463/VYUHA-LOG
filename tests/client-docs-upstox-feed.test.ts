import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ENTRIES } from "@/lib/domain/help-content";

/**
 * THE v4.2 PRIVACY BULLET, HELD TO ONE HOST (builder D).
 *
 * v4.2 adds the first remote price source Vyuha itself talks to:
 * `api.upstox.com`, the quote endpoint, reached only while the Live Desk is
 * open and only when the user has picked Upstox as its source. One host, and
 * the disclosure that authorises it is `docs/client/PRIVACY.md` item 3 —
 * `tests/quotes-egress-guard.test.ts` reads that sentence out of this file and
 * refuses any provider naming a host it does not carry.
 *
 * This file guards the other three ways the same paperwork goes wrong:
 *
 *   1. THE HOST IS NAMED ONCE, AND IN ITEM 3. A second mention somewhere else
 *      in the sheet is how a host quietly acquires a second, looser
 *      justification; a mention outside the four-kinds list is a disclosure the
 *      "exactly four kinds" sentence no longer covers.
 *   2. THE HOSTS VYUHA DOES NOT CONTACT ARE NAMED NOWHERE. Upstox and Angel
 *      One publish an instrument-master host, two websocket feeds and a margin
 *      API. Vyuha reaches none of them in this release, and a doc that names
 *      one describes a product the code is not. It also pre-authorises it: the
 *      egress guard's rule is "the sentence is in PRIVACY.md", so prose written
 *      ahead of the code would make the next host look already disclosed.
 *   3. THE CLAIMS THAT MAKE THE POLL HARMLESS ARE ALL PRESENT. The token is
 *      reused rather than new, the keys are capped, the cadence is the clamped
 *      one, equities only, and the prices stay here. Any one of them dropped by
 *      a copy edit leaves a bullet that is true about the host and wrong about
 *      the request.
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

/** The disclosed quote host — one, and the one the trade pull already uses. */
const QUOTE_HOST = "api.upstox.com";

/**
 * Real, documented endpoints of the same two brokers that Vyuha does NOT
 * contact: the instrument master, the two websocket feeds, and the margin API.
 * Kept identical to `NEVER_CONTACTED` in tests/quotes-egress-guard.test.ts —
 * that file refuses a PROVIDER that names one, this one refuses a DOCUMENT.
 */
const NEVER_CONTACTED = [
  "assets.upstox.com",
  "wsfeeder-api.upstox.com",
  "margincalculator.angelbroking.com",
  "smartapisocket.angelone.in",
];

/** Item 3 of the four-kinds list, from its own marker to item 4's. */
function itemThree(text: string): string {
  const start = text.indexOf("3. **Broker API pulls");
  const end = text.indexOf("4. **The Telegram", start + 1);
  expect(start, "PRIVACY.md no longer has an item 3 that starts with the broker pulls").toBeGreaterThan(-1);
  expect(end, "PRIVACY.md no longer has an item 4").toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("PRIVACY.md discloses exactly one Upstox host, in item 3", () => {
  it(`names ${QUOTE_HOST} exactly once in the copy a buyer reads`, () => {
    const hits = privacyVisible.split(QUOTE_HOST).length - 1;
    expect(hits, `${PRIVACY} names ${QUOTE_HOST} ${hits} times; it is disclosed once, in item 3`).toBe(1);
  });

  it("and that occurrence is inside item 3, which the four-kinds sentence covers", () => {
    expect(itemThree(privacyVisible), "the host is disclosed outside the four-kinds list").toContain(QUOTE_HOST);
    // The claim item 3 has to keep making for the poll to belong in it.
    expect(privacyVisible).toContain("Exactly four kinds, and only one of them is automatic:");
    expect(privacyVisible).toContain("That is the complete list for Vyuha Desktop. There is no fifth thing.");
  });

  it("states the poll in full: the token it reuses, the cap, the cadence, and where the prices stay", () => {
    const item = itemThree(privacyVisible).replace(/\s+/g, " ");
    expect(item, "the disclosure does not say the token is one the user already saved").toMatch(
      /reuses the read-only Analytics token you already saved/,
    );
    expect(item, "the disclosure does not say what is sent").toMatch(
      /instrument keys of the open positions of the selected account/,
    );
    expect(item, "the disclosure does not cap the keys").toMatch(/at most 500 of them/);
    expect(item, "the disclosure does not state the cadence").toMatch(/once every 1–5 seconds while the desk is open/);
    expect(item, "the disclosure does not say what the poll leaves out").toMatch(
      /no quantity, no entry price, no P&L, no account/,
    );
    expect(item, "the disclosure does not scope the release to equities").toMatch(/Equities only in this release/);
    expect(item, "the disclosure does not say the prices stay here").toMatch(/never uploaded, never resold/);
    // v4.2 fix wave, B-5. "Equities only" is only half the fact: the reader
    // still has to know what the OTHER rows show. The sentence is the same
    // literal on both consent sheets, in help and in the client README, and
    // it replaces a claim ("keeps the mark already stored") about a
    // contract-keyed mark that no writer in this tree produces.
    //
    // C-11 (owner ruling, 2026-09-07): the second half of that fallback is a
    // DASH, not the position's entry price — the row prints "—" when it has no
    // close, and an entry price is the trader's own cost, never a mark.
    expect(item, "the disclosure does not say what an unpriced derivative row shows").toContain(
      "Futures and options rows are not priced by this feed: each shows the position's recorded close, or a dash when no close is recorded, and says so on the row.",
    );
    expect(item, "the disclosure still offers the entry price as the fallback").not.toContain("its entry price");
  });

  it("never names the account screen in the bullet — the user's browser goes there, not Vyuha", () => {
    // account.upstox.com is where the user generates the token themselves. It
    // is a HELP fact; in a list of the requests Vyuha makes it would be false.
    expect(privacyVisible, "PRIVACY.md names a host Vyuha does not request").not.toContain("account.upstox.com");
    // …and help does name it, so the fact is not simply missing.
    expect(HELP_ENTRIES.flatMap((e) => e.body).join(" ")).toContain("account.upstox.com");
  });
});

describe("no shipped doc names a host Vyuha does not contact", () => {
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
    const planted = "Vyuha downloads the instrument master from assets.upstox.com every morning.";
    expect(NEVER_CONTACTED.filter((h) => planted.toLowerCase().includes(h))).toEqual(["assets.upstox.com"]);
  });
});

describe("the new Upstox copy is descriptive, never prescriptive (SEBI copy rule)", () => {
  /** The same vocabulary tests/live-feed-copy.test.ts bans on the Settings card. */
  const BANNED =
    /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed)\b/i;

  /** Sentences of the block this wave added — every one of them, not a filter. */
  function sentencesOf(text: string): string[] {
    return text
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** The Upstox paragraph of PRIVACY item 3 — from its first word to item 4. */
  function upstoxParagraph(): string {
    const item = itemThree(privacyVisible);
    const at = item.indexOf("Upstox can price the desk instead");
    expect(at, "PRIVACY item 3 no longer carries the Upstox paragraph").toBeGreaterThan(-1);
    return item.slice(at);
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
    [PRIVACY, upstoxParagraph],
    ["docs/client/README.md", v42Section],
  ];

  it.each(scanned)("%s carries no prescriptive vocabulary in its Upstox copy", (rel, text) => {
    const sentences = sentencesOf(text());
    expect(sentences.length, `${rel} says nothing about the Upstox source — the scan has nothing to read`).toBeGreaterThan(3);
    expect(
      sentences.filter((s) => /upstox/i.test(s)).length,
      `${rel}'s scanned block never names Upstox`,
    ).toBeGreaterThan(0);
    const offenders = sentences.filter((s) => BANNED.test(s)).map((s) => s.slice(0, 120));
    expect(offenders, `prescriptive vocabulary in ${rel}:\n${offenders.join("\n")}`).toEqual([]);
    // The word this product prints on no surface at all (owner ruling).
    const alerts = sentences.filter((s) => /\balerts?\b/i.test(s));
    expect(alerts, `${rel} calls something an alert`).toEqual([]);
  });

  it("the scan can fire on a sentence of exactly this shape", () => {
    expect(BANNED.test("Consider the Upstox feed for a faster mark on the desk.")).toBe(true);
    const planted = sentencesOf("You should pick the Upstox source to price the desk.");
    expect(planted).toHaveLength(1);
    expect(planted.filter((s) => BANNED.test(s))).toHaveLength(1);
  });
});
