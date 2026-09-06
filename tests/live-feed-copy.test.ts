import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BROKER_FEED_OFFERED, LIVE_FEED_COPY, REFRESH_MAX, REFRESH_MIN } from "@/components/settings/live-feed-card";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
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
  const FEED_CLAIM =
    /live (feed|price|prices|quote|quotes|tick|ticks)|price poll|prices the desk|priced by|real[- ]?time|streaming|tick stream/i;

  /**
   * BY SENTENCE, NOT BY LINE (fix wave, 2026-09-06).
   *
   * The pairing scan used to filter `read(rel).split(/\r?\n/)`, and README.md is
   * hard-wrapped at ~78 columns: the 4.1 block said "**Settings → Live feed**
   * now offers three sources:" on one line and "or **your own OpenAlgo
   * instance**" two lines later, so the name and the claim never shared a line
   * and the guard passed on exactly the pairing Q60 forbids. Joining the wrap
   * and splitting on sentence terminators is what makes the unit the unit a
   * reader actually reads.
   *
   * Markup is stripped first for the same reason — `<b>OpenAlgo</b>` in the
   * sales HTML must not hide the name from the scan.
   */
  const sentencesOf = (text: string): string[] =>
    text
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/);

  it("is named in the Settings card and in the consent sheet — that is where it belongs", () => {
    expect(read("components/settings/live-feed-card.tsx")).toContain("OpenAlgo");
    expect(read("lib/domain/openalgo-disclosure.ts")).toContain("OpenAlgo");
  });

  it.each(MARKETING)("%s never pairs OpenAlgo with a live-price claim", (rel) => {
    const offenders = sentencesOf(read(rel)).filter((s) => /openalgo/i.test(s) && FEED_CLAIM.test(s));
    expect(offenders, `${rel}: ${offenders.map((s) => s.slice(0, 200)).join(" | ")}`).toEqual([]);
  });

  it.each(MARKETING)("%s carries none of the feed card's copy", (rel) => {
    const text = read(rel);
    for (const line of Object.values(LIVE_FEED_COPY)) expect(text.includes(line), line).toBe(false);
  });

  it("the pairing scan really can fire, and does not fire on the import sentence that is already there", () => {
    expect(FEED_CLAIM.test("Live prices through OpenAlgo, free"), "a feed claim").toBe(true);
    expect(FEED_CLAIM.test("real-time OpenAlgo quotes"), "a feed claim").toBe(true);
    // Widened in the fix wave: every shape the 4.1 copy actually used to say it.
    expect(FEED_CLAIM.test("the Live Desk's price poll to the OpenAlgo bridge you run"), "a feed claim").toBe(true);
    expect(FEED_CLAIM.test("which source prices the desk"), "a feed claim").toBe(true);
    expect(FEED_CLAIM.test("The Live Desk can be priced by a bridge you already run"), "a feed claim").toBe(true);
    expect(FEED_CLAIM.test("streaming quotes from OpenAlgo"), "a feed claim").toBe(true);
    expect(
      FEED_CLAIM.test("Brokers with no API of their own can pull live through OpenAlgo"),
      "the shipped v3.1 IMPORT sentence, which stays",
    ).toBe(false);
  });

  it("the SENTENCE unit is what catches a hard-wrapped pairing a line scan misses", () => {
    // Verbatim the shape README.md shipped: the claim and the name are three
    // wrapped lines apart inside one sentence.
    const wrapped =
      "> **Settings → Live feed** now offers three sources:\n> the end-of-day bhavcopy already on this machine (still the default), a mark\n> you type, or **your own OpenAlgo instance**.";
    const byLine = wrapped.split(/\r?\n/).filter((l) => /openalgo/i.test(l) && FEED_CLAIM.test(l));
    const bySentence = sentencesOf(wrapped).filter((s) => /openalgo/i.test(s) && FEED_CLAIM.test(s));
    expect(byLine, "the old per-line scan saw nothing — that is the hole").toEqual([]);
    expect(bySentence, "the sentence scan sees the pairing").toHaveLength(1);
  });
});

/**
 * K-1 — the breach surfaces describe the mark THIS release can produce.
 *
 * `components/risk/breach-banner.tsx` and the header of `lib/risk/alerts.ts`
 * both said the marks are "EOD or manually entered — not live quotes". That was
 * exhaustive until v4.1: with the bridge selected, `lib/quotes/persist-mark.ts`
 * writes one feed-derived, day-stamped row per position per IST day into
 * `mtm_prices`, so a bridge user's mark is neither end-of-day nor typed — and
 * the caveat they need is not "not live quotes" but "never a live TICK", which
 * is the property that survives the feed. A breach shown against a mark whose
 * provenance the copy denies is a wrong description of the number on screen.
 *
 * No test pinned that sentence before this wave, which is why it drifted for a
 * whole release; it is pinned here because the third kind of mark is a fact
 * about the live feed. The scan is scoped to those two files by name — the
 * sibling summaries in `components/risk/risk-cockpit-client.tsx` and
 * `components/trackers/tracker-client.tsx` say the same thing about the same
 * marks and belong to another owner's set; see this wave's report.
 */
describe("the breach surfaces name the third kind of mark (K-1)", () => {
  const BREACH_SURFACES = [
    "components/risk/breach-banner.tsx",
    "lib/risk/alerts.ts",
    // The two sibling summaries were reworded in the same fix wave (2026-09-06).
    "components/risk/risk-cockpit-client.tsx",
    "components/trackers/tracker-client.tsx",
  ];

  /**
   * Comment leaders dropped and the wrap joined: the sentence lives in a `//`
   * block in one file and in JSX text in the other, and in both it is hard
   * wrapped. A raw source scan would miss "one\n// dated mark a day…" and pass
   * on copy that says nothing of the sort.
   */
  const flat = (rel: string) =>
    read(rel)
      .replace(/^[ \t]*(?:\/\/|\*)[ \t]?/gm, "")
      .replace(/\s+/g, " ");

  it.each(BREACH_SURFACES)("%s no longer claims the marks are only EOD or manual", (rel) => {
    const src = flat(rel);
    expect(src, `${rel} still says the marks are EOD or manual`).not.toMatch(
      /EOD[ /]?(?:or|\/)[ ]?manual|end-of-day or manual(?:ly)?/i,
    );
    expect(src, `${rel} still says "not live quotes"`).not.toMatch(/not live quotes/i);
  });

  it.each(BREACH_SURFACES)("%s names all three, and refuses the tick rather than the quote", (rel) => {
    const src = flat(rel);
    expect(src, `${rel} does not name the feed-derived dated mark`).toMatch(
      /one dated mark a day from your own feed/i,
    );
    expect(src, `${rel} no longer says the mark is never a live tick`).toMatch(/never a live tick/i);
  });

  it("the banner still tells the reader to check a live quote before acting — on screen AND in the notification", () => {
    const src = flat("components/risk/breach-banner.tsx");
    const occurrences = src.split(/check a live quote before acting/gi).length - 1;
    expect(occurrences, "the instruction is missing from the banner or from the OS notification").toBe(2);
    // …and it is still not advice about a trade.
    expect(src).toMatch(/never places or closes anything/);
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

/**
 * G2 — WHAT HAPPENS WHEN A TYPED MARK AND THE AUTOMATIC MARK MEET.
 *
 * Fix wave 2 gave the close-of-session write a trigger (the 15:31 reconnect),
 * and that made the automatic row exist on every day the desk was open. The
 * typed writers — the risk dialog's "Current price (MTM)" and the equity page —
 * INSERTED beside it with no delete, and every reader takes the first row it
 * finds for that symbol on that date, so a correction typed after the close was
 * silently discarded. Fix wave 3 makes the typed writers replace the day's row:
 * a price you type is ALWAYS that day's mark.
 *
 * No user surface said anything about the collision — all seven promised
 * "whichever comes first" and never mentioned a typed mark at all. One sentence
 * now says it, and the point of the sentence is that it is the SAME sentence:
 * seven documents each inventing their own phrasing for one write rule is how
 * `/funds` ended up stated four different ways, three of them wrong.
 *
 * Pinned VERBATIM, per surface, because a paraphrase is exactly the failure —
 * a guard that accepted "your typed price wins" would let the seven drift back
 * apart while staying green. Deleting the sentence from any one of them reds
 * this block and names the surface.
 *
 * NOT its own `LIVE_FEED_COPY` key: the Q60 guard above forbids README.md and
 * the sales pages from carrying any WHOLE card string, and this sentence has to
 * be in README.md. As a clause inside `staleness` it is said identically
 * everywhere without any marketing surface reproducing a card string — the two
 * rules hold at once, which is why the assertion below is `toContain`.
 */
describe("the typed-mark rule is said, in the same words, on every surface that describes the mark (G2)", () => {
  const SENTENCE =
    "A price you type yourself is that day's mark: the app does not overwrite it at the close, " +
    "and typing after the close replaces the automatic one.";

  /**
   * What a READER sees, with the wrapping and the markup taken out.
   *
   * These files are hard-wrapped at ~78 columns, three of them under a `>`
   * blockquote leader and one of them HTML, so the sentence never survives as a
   * contiguous byte range in the source. Flattening is what lets the pin be
   * verbatim rather than a bag of loose fragments. HTML comments go first: the
   * setup guide carries a long owner-facing citation block a browser never
   * renders, and a pin satisfied by a comment is a pin on nothing.
   */
  const flatten = (text: string) =>
    text
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");

  const flatFile = (rel: string) => flatten(read(rel));

  /** The seven surfaces, and how each one is read. */
  const SURFACES: [name: string, text: () => string][] = [
    ["README.md", () => flatFile("README.md")],
    ["docs/client/README.md", () => flatFile("docs/client/README.md")],
    ["docs/client/PRIVACY.md", () => flatFile("docs/client/PRIVACY.md")],
    ["docs/client/OPENALGO_SETUP_GUIDE.html", () => flatFile("docs/client/OPENALGO_SETUP_GUIDE.html")],
    // The two copy modules are read as DATA, not as source: a sentence sitting
    // in a `//` comment would satisfy a file scan and reach no screen.
    ["lib/domain/help-content.ts (HELP_ENTRIES /live)", () =>
      flatten(HELP_ENTRIES.find((e) => e.href === "/live")!.body.join(" ")),
    ],
    ["lib/domain/openalgo-disclosure.ts (OPENALGO_FEED_ITEMS)", () =>
      flatten(OPENALGO_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ")),
    ],
    ["components/settings/live-feed-card.tsx (LIVE_FEED_COPY.staleness)", () =>
      flatten(LIVE_FEED_COPY.staleness),
    ],
  ];

  it("the flattener really reads a wrapped, quoted, marked-up copy of the sentence", () => {
    // Every shape the seven surfaces actually store it in, and the shape that
    // must NOT pass: a paraphrase.
    const wrapped = "> yourself is that day's mark: the app does not\n> overwrite it at the close, and typing";
    expect(flatten(`> A price you type\n${wrapped} after the close replaces the automatic one.`)).toContain(SENTENCE);
    expect(
      flatten("<li>A price you type yourself is that day's mark: the app does not\n    overwrite it at the close, and typing after the close replaces the automatic one.</li>"),
    ).toContain(SENTENCE);
    expect(flatten("<!-- A price you type yourself is that day's mark: the app does not overwrite it at the close, and typing after the close replaces the automatic one. -->"))
      .not.toContain(SENTENCE);
    expect(flatten("Your typed price wins over the automatic one.")).not.toContain(SENTENCE);
  });

  it.each(SURFACES)("%s says it, verbatim", (_name, text) => {
    expect(text(), `the typed-mark rule is missing or reworded here — it must read exactly:\n  ${SENTENCE}`).toContain(
      SENTENCE,
    );
  });

  it("all seven say the identical string — one write rule, one sentence", () => {
    const saying = SURFACES.filter(([, text]) => text().includes(SENTENCE)).map(([name]) => name);
    expect(saying, "a surface dropped the shared sentence").toHaveLength(SURFACES.length);
  });

  it("it is a description of a write, not an instruction — the card's own ban applies to it", () => {
    expect(BANNED.test(SENTENCE), SENTENCE).toBe(false);
    // …and it names no regulator and no broker, like every other sentence here.
    expect(SENTENCE).not.toMatch(/\b(SEBI|circular|regulat\w*)\b/i);
  });

  it("the sentence describes a LOCAL write rule, so the disclosure version does not move", () => {
    // The rule at lib/domain/openalgo-disclosure.ts:25-28 bumps the version for
    // a materially different RISK. Which row of the user's own table wins is
    // not one: no new host is contacted, nothing new is sent to the bridge and
    // nothing new is kept from it. Bumping here would re-prompt every install
    // to re-read a statement that has not changed in any way that concerns
    // them, which is how a consent dialog becomes something people click past.
    expect(SENTENCE).not.toMatch(/\b(send|sends|sent|upload|uploads|host|server|internet)\b/i);
  });
});

/**
 * N1 — EVERY BREADCRUMB NAMES A ROUTE THE APP ACTUALLY HAS.
 *
 * `OPENALGO_CAPABILITIES.egressDescription` was corrected in fix wave 2 and
 * pinned by `tests/seams-v41-fix2.test.ts` S7b; two sibling strings were missed
 * and still sent the reader to "Import → OpenAlgo" as the FIRST step. It is not
 * the first step and it is not reachable as one: the Import screen grows its
 * OpenAlgo section only after the integration is switched on in
 * Settings → Integrations (advanced) — `lib/domain/import-help-content.ts`'s own
 * preceding step says so, and `readGateFromDb()` refuses regardless of the UI.
 *
 * The arrow notation is what is banned, not the Import screen: the API key form
 * really does live there (`components/import/broker-connect.tsx`, tab "OpenAlgo
 * (self-hosted)", rendered by `app/import/page.tsx`), so both strings still
 * send the user there — for the key, after the switch, in that order.
 */
describe("the OpenAlgo breadcrumbs name the two steps in the order they happen (N1)", () => {
  it("the no-key feed reason sends the reader to Settings → Integrations first", () => {
    const adapter = read("lib/quotes/openalgo.ts");
    const reason = adapter.match(/"No OpenAlgo connection is saved yet\.[^"]*"/)?.[0];
    expect(reason, "the no-key reason string is gone from the adapter").toBeDefined();
    expect(reason, "the no-key reason still points at a screen that does not exist yet").not.toContain(
      "Import → OpenAlgo",
    );
    expect(reason).toContain("Settings → Integrations");
    // …and it still says where the key itself goes, which is the Import screen.
    expect(reason).toMatch(/Import screen/);
    // The desk's own sentence is reused, not restated — it is the one the user
    // has already seen on the Settings card.
    expect(reason).toContain(LIVE_FEED_COPY.connect);
  });

  it("the import help step names the Import screen without the stale arrow", () => {
    const src = read("lib/domain/import-help-content.ts");
    expect(src, "import help still writes the breadcrumb as Import → OpenAlgo").not.toContain("Import → OpenAlgo");
    expect(src, "import help no longer says where the key is pasted").toContain("OpenAlgo (self-hosted) tab");
    // The step BEFORE it is the one that makes that tab exist, and it stays.
    expect(src).toContain("First: Settings → Integrations (advanced)");
  });

  it("no live-feed surface in this guard's set carries the stale arrow in COPY", () => {
    // Comment-stripped: the citation comment beside the corrected string quotes
    // the wording it replaced, which is how the next reader knows what changed
    // and why. A ban that swallowed its own explanation would delete the record.
    for (const rel of [...SOURCES, "lib/quotes/openalgo.ts", "lib/domain/openalgo-disclosure.ts"]) {
      expect(stripComments(read(rel)), `${rel} still writes "Import → OpenAlgo"`).not.toContain("Import → OpenAlgo");
    }
  });
});
