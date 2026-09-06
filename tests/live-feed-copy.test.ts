import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BROKER_FEED_OFFERED, LIVE_FEED_COPY, REFRESH_MAX, REFRESH_MIN } from "@/components/settings/live-feed-card";
import { REFRESH_SECONDS_MAX, REFRESH_SECONDS_MIN } from "@/lib/quotes/openalgo";
import { OPENALGO_FEED_ENABLED } from "@/lib/quotes/types";

/**
 * The Live-feed copy guard (owner answers Q24, Q25, Q60).
 *
 * Three obligations, none of which a screenshot can prove:
 *
 *   1. NO PRESCRIPTIVE VOCABULARY. Same family as
 *      `tests/live-tracker-copy.test.ts` — quoted strings and JSX text of the
 *      Settings card and its route, comment-stripped, scanned for the words
 *      that would turn a settings screen into advice.
 *   2. THE DAILY RE-AUTH SENTENCE IS SAID, HIGHLIGHTED, AND NEUTRAL (Q24), and
 *      it NAMES NO REGULATOR (owner ruling). The earlier wording said exchanges
 *      and SEBI require the daily re-authentication and carried a
 *      VERIFY-CIRCULAR marker; no circular saying so is cited anywhere in this
 *      tree, so the claim was softened to what the user's own broker does and
 *      the marker was removed with it. Both halves are asserted below — the
 *      sentence verbatim, and the absence of the marker it no longer needs.
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

/** The same vocabulary the Live Desk guard bans, for the same reason. */
const BANNED =
  /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed)\b/i;

/**
 * The scan runs over the WHOLE comment-stripped source, exactly as
 * `tests/sizing-lab-copy.test.ts` and `tests/position-chart-copy.test.ts` do.
 *
 * It used to extract quoted strings plus JSX text matched by `>([^<>{}]+)<`,
 * and that character class is a hole big enough to drive the failure through:
 * ANY text node containing an interpolation — the shape most real JSX copy has
 * ("…OpenAlgo does. {health?.reason}") — was invisible to the guard, so a
 * banned verb sitting beside an expression was never seen. Scanning the source
 * costs a little precision (an identifier could in principle trip it) and buys
 * the property that actually matters: no copy on this screen is exempt.
 */
const offendersIn = (rel: string): string[] => [
  ...new Set(
    [...stripComments(read(rel)).matchAll(new RegExp(BANNED.source, "gi"))].map((m) => m[0]),
  ),
];

describe("the Live feed card never prompts a transaction", () => {
  it.each(SOURCES)("%s carries no banned vocabulary", (rel) => {
    const offenders = offendersIn(rel);
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
  it("is pinned VERBATIM — the sentence a user reads about their broker cannot drift silently", () => {
    expect(LIVE_FEED_COPY.dailyReauth).toBe(
      "Your broker's API session expires every day and has to be signed in again; that is the broker's rule, not Vyuha's.",
    );
  });

  it("states an ATTRIBUTABLE fact and attributes it to nobody it cannot", () => {
    expect(LIVE_FEED_COPY.dailyReauth).toMatch(/expires every day/);
    expect(LIVE_FEED_COPY.dailyReauth).toMatch(/signed in again/);
    expect(LIVE_FEED_COPY.dailyReauth).toMatch(/the broker's rule, not Vyuha's/);
    // No regulator is invoked. The earlier wording said exchanges and SEBI
    // REQUIRE the daily re-authentication, and no circular saying so is cited
    // anywhere in this tree — an unverified claim about a regulator is exactly
    // the kind of sentence that ships as fact and cannot be defended.
    expect(LIVE_FEED_COPY.dailyReauth).not.toMatch(/\b(SEBI|exchange|exchanges|circular|regulat\w*)\b/i);
    // Still not an accusation, and still not about one broker: every broker in
    // India is in the same position.
    expect(LIVE_FEED_COPY.dailyReauth).not.toMatch(/your broker (forces|makes|refuses)/i);
    expect(LIVE_FEED_COPY.dailyReauth).not.toMatch(/\b(Zerodha|Dhan|Groww|Angel One|Upstox|Kite)\b/);
  });

  it("names no regulator in the ADAPTER's comments either — an auditor greps comments too", () => {
    // The capability block that sets `requiresDailyAuth` used to explain it as
    // "an exchange/SEBI rule". A comment is not on screen, but a docs-claims
    // audit reads the tree, and a claim about a regulator sitting one file away
    // from the softened copy is the same unverifiable claim in a quieter place.
    const adapter = read("lib/quotes/openalgo.ts");
    expect(adapter, "the adapter still names a regulator").not.toMatch(/\bSEBI\b/);
    expect(adapter).toMatch(/requiresDailyAuth: true/);
    expect(adapter, "the adapter no longer attributes the daily expiry to the broker").toMatch(
      /the BROKER's rule, not Vyuha's and not OpenAlgo's/,
    );
  });

  it("has NO VERIFY-CIRCULAR marker left, because there is no longer a claim to verify", () => {
    // The marker existed to stop an unverified regulatory claim shipping as
    // fact. The claim is gone, so the marker must be gone too — a marker kept
    // beside a sentence it no longer describes is worse than none.
    const src = read("components/settings/live-feed-card.tsx");
    expect(src).not.toContain("VERIFY-CIRCULAR");
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

  it("describes the mark the code actually writes — the button's price counts as the day's mark", () => {
    // `persistDailyMarks()` waives the 15:30 clock for "Save today's mark" but
    // never the once-a-day rule, so a mid-session press IS that day's mark and
    // the close is then not written. Copy that promised "the last price of the
    // session" described a write that never happens on such a day.
    expect(LIVE_FEED_COPY.staleness).toMatch(/last price of the session/i);
    expect(LIVE_FEED_COPY.staleness).toMatch(/Save today's mark/);
    expect(LIVE_FEED_COPY.staleness).toMatch(/whichever comes first/i);
  });
});

describe("the card's CSS custom properties are tokens that exist", () => {
  /** Every `--name:` declared in the stylesheet, layered or not. */
  const declared = new Set(
    [...read("app/globals.css").matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1].toLowerCase()),
  );

  it.each(SOURCES.filter((s) => s.endsWith(".tsx")))("%s names only tokens app/globals.css defines", (rel) => {
    // `accent-[var(--primary)]` rendered a browser-default slider: an
    // unresolved custom property is not an error anywhere — no console
    // warning, no build failure, just the wrong colour on one control. Only
    // `--color-primary` was ever defined.
    const used = [...new Set([...read(rel).matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase()))];
    const missing = used.filter((token) => !declared.has(token));
    expect(missing, `${rel} names undefined token(s): ${missing.join(", ")}`).toEqual([]);
    expect(declared.size, "app/globals.css declared no custom properties — the scan is not reading it").toBeGreaterThan(
      20,
    );
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

/**
 * D-7 — the card may not render a control that belongs to a feed this release
 * does not ship.
 *
 * v4.0 offered two providers: the stored end-of-day bhavcopy and marks the user
 * types (`OPENALGO_FEED_ENABLED` false, `lib/quotes/types.ts`). Two blocks in
 * the card were rendered unconditionally anyway — the 1–5 s on-screen refresh
 * slider and the daily re-authentication note — and both describe a broker API
 * session. Together they told the user a live feed exists here.
 *
 * v4.1 flipped the flag and both blocks now render, WITH NO EDIT TO THE JSX:
 * that is the property this block still exists to hold. The gate must stay a
 * gate — `BROKER_FEED_OFFERED` derived from the provider list, each block
 * inside exactly one `{BROKER_FEED_OFFERED && (…)}` subtree — so that flipping
 * the constant back withdraws them just as completely.
 *
 * The environment is `node` (vitest.config.ts) with no DOM, so the proof is
 * structural rather than a render: both blocks must sit inside a
 * `{BROKER_FEED_OFFERED && (…)}` subtree and appear nowhere else, and
 * `BROKER_FEED_OFFERED` must equal the release flag. Deleting either gate — or
 * restating the flag as a literal — reddens this.
 */
describe("the broker-feed controls are gated on the release flag (D-7)", () => {
  const CARD = "components/settings/live-feed-card.tsx";
  const src = stripComments(read(CARD));

  /** Every `{FLAG && ( … )}` subtree in a source, matched by paren balance. */
  function gatedRegions(text: string, flag: string): string[] {
    const open = `{${flag} && (`;
    const out: string[] = [];
    for (let from = 0; ; ) {
      const start = text.indexOf(open, from);
      if (start < 0) return out;
      let depth = 0;
      let i = start + open.length - 1; // sits on the "("
      for (; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) break;
      }
      out.push(text.slice(start, i + 1));
      from = i + 1;
    }
  }

  const regions = gatedRegions(src, "BROKER_FEED_OFFERED");
  const occurrences = (needle: string) => src.split(needle).length - 1;

  it("the extractor really can fire — it finds a gate and stops at its own close", () => {
    const sample = "<a/>\n{FLAG && (\n  <b onClick={() => f(1)} />\n)}\n<c/>";
    // Balanced to the gate's OWN closing paren — the nested `()` of the arrow
    // and the `f(1)` call are counted through, not stopped at.
    expect(gatedRegions(sample, "FLAG")).toEqual(["{FLAG && (\n  <b onClick={() => f(1)} />\n)"]);
    expect(gatedRegions(sample, "OTHER")).toEqual([]);
  });

  it("BROKER_FEED_OFFERED is DERIVED from the one release flag, not restated", () => {
    expect(BROKER_FEED_OFFERED).toBe(OPENALGO_FEED_ENABLED);
    expect(src, "the card no longer derives the gate from the provider list").toMatch(
      /BROKER_FEED_OFFERED = PROVIDERS\.some\(\(p\) => p\.id === "openalgo"\)/,
    );
  });

  it("the 1–5 s refresh slider renders ONLY behind the gate", () => {
    const holders = regions.filter((r) => r.includes('data-testid="live-feed-seconds"'));
    expect(holders.length, "the refresh-seconds control is not inside a BROKER_FEED_OFFERED gate").toBe(1);
    expect(occurrences('data-testid="live-feed-seconds"'), "a second, ungated copy of the control").toBe(1);
  });

  it("the daily re-authentication note renders ONLY behind the gate", () => {
    const holders = regions.filter((r) => r.includes("LIVE_FEED_COPY.dailyReauth"));
    expect(holders.length, "the re-auth sentence is not inside a BROKER_FEED_OFFERED gate").toBe(1);
    expect(holders[0]).toContain('data-testid="live-feed-reauth"');
    expect(occurrences("LIVE_FEED_COPY.dailyReauth"), "a second, ungated copy of the sentence").toBe(1);
  });

  /**
   * v4.1: THE GATE IS OPEN, AND BOTH BLOCKS REACH THE SCREEN.
   *
   * This used to be `it.skipIf(OPENALGO_FEED_ENABLED)(…)` asserting the v4.0
   * truth (`BROKER_FEED_OFFERED === false`). A guard that relaxes ITSELF the
   * moment the flag flips is a guard that silently stops running exactly when
   * the behaviour it describes changes — so it is replaced, not skipped, by
   * the assertion for the release that actually ships.
   */
  it("with the flag TRUE both blocks reach the screen, and the sentence is the softened one", () => {
    expect(BROKER_FEED_OFFERED, "v4.1 offers a broker-backed feed").toBe(true);

    // Both gated regions exist and are non-empty — the same two subtrees the
    // two tests above located, now on the rendering side of the gate.
    const slider = regions.filter((r) => r.includes('data-testid="live-feed-seconds"'));
    const reauth = regions.filter((r) => r.includes("LIVE_FEED_COPY.dailyReauth"));
    expect(slider, "the refresh-seconds control").toHaveLength(1);
    expect(reauth, "the re-auth sentence").toHaveLength(1);
    expect(slider[0]).toMatch(/type="range"[\s\S]*min=\{1\}[\s\S]*max=\{5\}/);
    expect(reauth[0]).toContain('data-testid="live-feed-reauth"');

    // The sentence itself is EXACTLY the softened copy (owner ruling, this
    // wave): no SEBI circular exists to cite, so no regulatory attribution
    // ships. Pinned verbatim here as well as above, because this is the test
    // that proves it is on screen rather than merely defined.
    expect(LIVE_FEED_COPY.dailyReauth).toBe(
      "Your broker's API session expires every day and has to be signed in again; that is the broker's rule, not Vyuha's.",
    );
    expect(LIVE_FEED_COPY.dailyReauth).not.toMatch(/\b(SEBI|exchange|exchanges|circular|regulat\w*)\b/i);
  });
});
