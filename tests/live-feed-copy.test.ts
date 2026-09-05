import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_FEED_COPY, REFRESH_MAX, REFRESH_MIN } from "@/components/settings/live-feed-card";
import { REFRESH_SECONDS_MAX, REFRESH_SECONDS_MIN } from "@/lib/quotes/openalgo";

/**
 * The Live-feed copy guard (owner answers Q24, Q25, Q60).
 *
 * Three obligations, none of which a screenshot can prove:
 *
 *   1. NO PRESCRIPTIVE VOCABULARY. Same family as
 *      `tests/live-tracker-copy.test.ts` — quoted strings and JSX text of the
 *      Settings card and its route, comment-stripped, scanned for the words
 *      that would turn a settings screen into advice.
 *   2. THE DAILY RE-AUTH SENTENCE IS SAID, HIGHLIGHTED, AND NEUTRAL (Q24). It
 *      is also NOT YET VERIFIED against a named circular, and the file must
 *      keep saying so: a claim about what a regulator requires is a claim, and
 *      an unverified one that loses its marker ships as fact. The
 *      VERIFY-CIRCULAR marker is therefore asserted to still be there.
 *   3. OPENALGO IS NAMED IN SETTINGS AND IN THE CONSENT SHEET, AND NOWHERE
 *      MARKETING SPEAKS (Q60). The live feed is a bridge the user chooses to
 *      run, not a feature Vyuha sells.
 *
 * DEVIATION FROM THE LITERAL BRIEF, stated because the brief said "OpenAlgo
 * absent from docs/sales + README": it is already there, three times in
 * `docs/sales/landing-page.html` and five in `README.md`, and every one of
 * them is about IMPORTING trades through the bridge (shipped in v3.1). Those
 * files belong to other waves and predate this one, so deleting them here
 * would be both out of set and a false claim about what v3.1 does. What Q60
 * actually forbids is marketing the FEED — so the guard is the pairing:
 * marketing may say the bridge imports, and may not say it prices.
 */

const ROOT = path.resolve(__dirname, "..");
const SOURCES = ["components/settings/live-feed-card.tsx", "app/api/live/feed/route.ts"];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Quoted strings + JSX text, comment-free — identifiers are not copy. */
function copyOf(rel: string): string[] {
  const src = stripComments(read(rel));
  const out: string[] = [];
  for (const m of src.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\]*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of src.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  return out.map((s) => s.trim()).filter((s) => s.length > 2);
}

/** The same vocabulary the Live Desk guard bans, for the same reason. */
const BANNED =
  /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed)\b/i;

describe("the Live feed card never prompts a transaction", () => {
  it.each(SOURCES)("%s carries no banned vocabulary", (rel) => {
    const offenders = copyOf(rel).filter((s) => BANNED.test(s));
    expect(offenders, `${rel}: ${offenders.join(" | ")}`).toEqual([]);
  });

  it("the scan really can fire — a prescriptive sentence is caught", () => {
    for (const bad of [
      "You should switch to the live feed",
      "We recommend the OpenAlgo bridge",
      "Consider a faster refresh",
      "Our target price is 3,100",
    ]) {
      expect(BANNED.test(bad), bad).toBe(true);
    }
  });

  it("…and passes the card's own descriptive phrasing", () => {
    for (const ok of Object.values(LIVE_FEED_COPY)) expect(BANNED.test(ok), ok).toBe(false);
  });
});

describe("the daily re-authentication note (owner answer Q24)", () => {
  it("is pinned VERBATIM — a sentence about what a regulator requires cannot drift silently", () => {
    expect(LIVE_FEED_COPY.dailyReauth).toBe(
      "Exchanges and SEBI require broker sessions to be re-authenticated daily; Vyuha cannot extend a session.",
    );
  });

  it("states the rule and Vyuha's own limit, and blames nobody", () => {
    expect(LIVE_FEED_COPY.dailyReauth).toMatch(/SEBI/);
    expect(LIVE_FEED_COPY.dailyReauth).toMatch(/re-authenticated daily/);
    expect(LIVE_FEED_COPY.dailyReauth).toMatch(/Vyuha cannot extend a session/);
    // Not an accusation, and not a claim about one broker: every broker in
    // India is in the same position.
    expect(LIVE_FEED_COPY.dailyReauth).not.toMatch(/your broker (forces|makes|refuses)/i);
    expect(LIVE_FEED_COPY.dailyReauth).not.toMatch(/\b(Zerodha|Dhan|Groww|Angel One|Upstox|Kite)\b/);
  });

  it("carries the VERIFY-CIRCULAR marker, so an unverified claim cannot ship as fact", () => {
    // The exact circular is not cited anywhere in the tree. Until the release
    // claims audit attaches it (or softens the sentence), the obligation stays
    // visible in the file that renders the sentence.
    const src = read("components/settings/live-feed-card.tsx");
    expect(src).toContain("VERIFY-CIRCULAR");
    expect(src).toMatch(/circular[\s\S]{0,200}before this ships/i);
  });

  it("reaches the screen at all — the card is mounted in Settings", () => {
    // A consent-adjacent card that renders nowhere is copy nobody reads. The
    // mount is one import + one JSX line, and this is what keeps it there.
    const form = read("components/settings/settings-form.tsx");
    expect(form).toContain('from "@/components/settings/live-feed-card"');
    expect(form).toMatch(/<LiveFeedCard\s/);
  });

  it("is rendered in the highlighted block, not buried in a comment", () => {
    const src = read("components/settings/live-feed-card.tsx");
    expect(src).toContain('data-testid="live-feed-reauth"');
    expect(src).toMatch(/live-feed-reauth[\s\S]{0,400}LIVE_FEED_COPY\.dailyReauth/);
  });

  it("says the once-a-day connect prompt in the owner's words, and the 1–5 s ceiling twice over", () => {
    expect(LIVE_FEED_COPY.connect).toBe("Connect your feed — 20 seconds");
    // The card and the provider must not disagree about the refresh range: the
    // provider clamps, and the slider must not offer what the clamp refuses.
    expect(REFRESH_MIN).toBe(REFRESH_SECONDS_MIN);
    expect(REFRESH_MAX).toBe(REFRESH_SECONDS_MAX);
  });

  it("tells the truth about what is written: ticks are not, one mark a day is", () => {
    expect(LIVE_FEED_COPY.staleness).toMatch(/never written to your journal/i);
    expect(LIVE_FEED_COPY.staleness).toMatch(/one mark per position per day/i);
  });
});

describe("OpenAlgo is named where consent is given, and never in marketing (owner answer Q60)", () => {
  const MARKETING = ["README.md", "docs/sales/landing-page.html", "docs/sales/brochure.html"];
  /** A live-price claim. "pull live" (same-day IMPORT) is not one. */
  const FEED_CLAIM = /live (feed|price|prices|quote|quotes|tick|ticks)|real[- ]?time|streaming|tick stream/i;

  it("is named in the Settings card and in the consent sheet — that is where it belongs", () => {
    expect(read("components/settings/live-feed-card.tsx")).toContain("OpenAlgo");
    expect(read("lib/domain/openalgo-disclosure.ts")).toContain("OpenAlgo");
  });

  it.each(MARKETING)("%s never pairs OpenAlgo with a live-price claim", (rel) => {
    const offenders = read(rel)
      .split(/\r?\n/)
      .filter((line) => /openalgo/i.test(line) && FEED_CLAIM.test(line));
    expect(offenders, `${rel}: ${offenders.join(" | ")}`).toEqual([]);
  });

  it.each(MARKETING)("%s carries none of the feed card's copy", (rel) => {
    const text = read(rel);
    for (const line of Object.values(LIVE_FEED_COPY)) expect(text.includes(line), line).toBe(false);
  });

  it("the pairing scan really can fire, and does not fire on the import sentence that is already there", () => {
    expect(FEED_CLAIM.test("Live prices through OpenAlgo, free"), "a feed claim").toBe(true);
    expect(FEED_CLAIM.test("real-time OpenAlgo quotes"), "a feed claim").toBe(true);
    expect(
      FEED_CLAIM.test("Brokers with no API of their own can pull live through OpenAlgo"),
      "the shipped v3.1 IMPORT sentence, which stays",
    ).toBe(false);
  });
});
