import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import {
  ANGELONE_FEED_COPY,
  FEED_BLOCKED_HEALTH,
  FEED_CHECKING,
  KEEP_EOD_CTA,
  PROVIDERS,
  REVIEW_CONSENT_CTA,
  angelOneCadenceText,
  angelOneRowState,
  feedBlockControl,
  feedBlockState,
  feedHealthText,
  foldFeedResponse,
  foldWriteResult,
  offeredProviders,
} from "@/components/settings/live-feed-card";
import {
  ANGELONE_BATCH_SIZE,
  ANGELONE_MAX_PRICED_POSITIONS,
  angelOneCadenceLine,
  angelOneRefreshCalls,
  deskAngelOneCadence,
} from "@/components/live/desk-copy";
import {
  ANGELONE_FEED_ITEMS,
  LIVE_FEED_DISCLOSURE_VERSIONS,
  UPSTOX_FEED_ITEMS,
  isFeedAckCurrent,
  parseFeedAcks,
} from "@/lib/domain/live-feed-disclosure";
import { OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";
import { ANGELONE_FEED_ENABLED, angelOneCadenceSeconds } from "@/lib/quotes/types";

/**
 * THE ANGEL ONE LIVE FEED IN SETTINGS (v4.2) — the row, the cadence line, the
 * sheet and the gate.
 *
 * The Upstox sibling (`tests/live-feed-upstox-settings.test.ts`) holds five
 * properties; every one of them applies here, and Angel One adds two more that
 * no other provider has:
 *
 *   6. THERE IS NO SLIDER UNDER THIS FEED (ruling 4.2-4). Angel One allows
 *      about one request a second and takes 50 symbols to a batch, so the
 *      interval is arithmetic over the user's own book, not a preference. A
 *      1–5 s control here would offer a setting the poll overrides — which is
 *      worse than no setting, because it reads as a promise. The control is
 *      replaced by ONE line stating the interval and the calls behind it.
 *   7. THE DAILY RE-AUTHENTICATION IS SAID, AND SAID FACTUALLY. Angel One
 *      really does clear every session at 5 AM IST, so the highlighted block
 *      stays — but the generic sentence ("has to be signed in again") is true
 *      of the SESSION and false of the READER: Vyuha signs in from the enrolled
 *      TOTP secret with nothing for the user to click. It therefore gets its own
 *      sentence, and that sentence NAMES NO REGULATOR — the same ruling that
 *      softened `LIVE_FEED_COPY.dailyReauth`, asserted here as a ban.
 *
 * ONE temp database for the FILE (lib/db caches its connection on globalThis),
 * and the route is imported DYNAMICALLY after `openTempDb()`.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CARD = "components/settings/live-feed-card.tsx";
const ROUTE = "app/api/live/feed/route.ts";
const DESK_COPY_FILE = "components/live/desk-copy.ts";

/** The same vocabulary the Upstox wave banned, and for the same reason. */
const BANNED =
  /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed|alert(s|ed|ing)?)\b/i;

/** Every string this wave puts on a user's screen from the files it owns. */
const NEW_STRINGS: [where: string, text: string][] = [
  ...Object.entries(ANGELONE_FEED_COPY).map(([k, v]) => [`ANGELONE_FEED_COPY.${k}`, v] as [string, string]),
  ["cadence line, 30 open", angelOneCadenceLine(30)],
  ["cadence line, 120 open", angelOneCadenceLine(120)],
  ["cadence line, 300 open", angelOneCadenceLine(300)],
  ["dialog title", "Before Angel One prices your desk"],
  [
    "route refusal (no connection)",
    "No Angel One connection is saved for this account. Add Angel One under Import → Connect broker first.",
  ],
  [
    "route refusal (no acknowledgement)",
    "Read what the Angel One feed does and accept it first — until then the desk stays on end-of-day prices.",
  ],
];

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

describe("the Angel One radio is offered only behind the one release flag", () => {
  const ids = PROVIDERS.map((p) => p.id);

  it("renders the row when the flag is on, and would drop it with no other edit", () => {
    expect(ANGELONE_FEED_ENABLED, "v4.2 ships the Angel One feed").toBe(true);
    expect(ids).toContain("angelone");
    expect(ids).toEqual(["manual", "eod", "openalgo", "upstox", "angelone"]);
  });

  it("the row is filtered by the FLAG, not by a hand-kept list", () => {
    // v4.2 seam fix: the filter took the three flags as an ARGUMENT so the
    // broker-feed gate could be proved for combinations this build does not
    // ship (tests/live-feed-copy.test.ts). The property pinned here is
    // unchanged and now needs both halves — the clause that reads the injected
    // flag, and the call that injects the REAL constant into it.
    const src = stripComments(read(CARD));
    expect(src, "the Angel One row no longer derives from a flag").toMatch(/\(p\.id !== "angelone" \|\| flags\.angelone\)/);
    expect(src, "the Angel One row no longer derives from ANGELONE_FEED_ENABLED").toMatch(
      /angelone: ANGELONE_FEED_ENABLED,/,
    );
  });

  it("says Angel One, in the owner's words", () => {
    expect(ANGELONE_FEED_COPY.label).toBe("Angel One");
    // C-3 (fix wave 3): the blurb used to say Vyuha "signs in again each
    // morning", which is neither the cadence nor the trigger the adapter has —
    // it signs in when the process needs a session, and again after a relaunch,
    // after the 5 AM flush and whenever the credentials are re-saved.
    expect(ANGELONE_FEED_COPY.blurb).toBe(
      "Uses the client code, PIN and TOTP secret saved under Import → Connect broker. Angel One clears every session at 5 AM IST; Vyuha signs in at most once a day while it stays open — again after a relaunch, after Angel One's 5 AM IST session flush, or when you re-save the credentials, and again when you switch the selected account, including to or from All accounts — without asking you.",
    );
    // C-11 (owner ruling "or a dash"): byte-identical to the Upstox scope
    // sentence — one release-scope rule, one sentence, so the two rows cannot
    // drift into two different promises — and the fallback is the DASH the row
    // really renders, never the entry price, which is a cost and not a mark.
    expect(ANGELONE_FEED_COPY.equityOnly).toBe(
      "Futures and options rows are not priced by this feed: each shows the position's recorded close, or a dash when no close is recorded, and says so on the row.",
    );
    expect(ANGELONE_FEED_COPY.equityOnly, "the withdrawn entry-price promise").not.toMatch(/entry price/i);
  });

  /**
   * C-3 — NO STRING ON THIS CARD MAY STATE A SIGN-IN CADENCE THE CODE HAS NOT.
   *
   * Two phrasings shipped for one behaviour: the blurb said "each morning" and
   * the consent sheet said "once each trading day" (B-7, fix wave 2, corrected
   * there and not here). Both describe a clock; the adapter follows a process —
   * at most one sign-in a day WHILE THE APP STAYS OPEN, and another after a
   * relaunch, after Angel One's 5 AM flush or a re-saved credential. A user who
   * leaves the desk open across two days, or restarts it twice in an afternoon,
   * sees sign-ins the copy denied.
   *
   * Scanned over EVERY string this module exports rather than over the two
   * values that carried it, because the next such sentence will be written in a
   * third place. `dailyReauth` lost the same two words with it: what is true
   * there is that there is nothing for the reader to do, which is true of every
   * hour and not of the morning.
   */
  it("states no morning and no trading-day cadence, in ANY string the card exports (C-3)", async () => {
    const card = await import("@/components/settings/live-feed-card");
    const strings: [string, string][] = [];
    const walk = (where: string, value: unknown, depth = 0) => {
      if (typeof value === "string") strings.push([where, value]);
      else if (value && typeof value === "object" && depth < 3) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(`${where}.${k}`, v, depth + 1);
      }
    };
    // Every exported value, one level into the arrays too: the picker's own
    // labels and blurbs live inside `PROVIDERS`, not in a named constant.
    for (const [name, value] of Object.entries(card)) walk(name, value);
    // The scan is reading the copy it thinks it is.
    expect(strings.map(([n]) => n)).toEqual(
      expect.arrayContaining([
        "ANGELONE_FEED_COPY.blurb",
        "ANGELONE_FEED_COPY.dailyReauth",
        "LIVE_FEED_COPY.dailyReauth",
        "UPSTOX_FEED_COPY.blurb",
      ]),
    );
    expect(strings.length, "the export scan found almost nothing — it is not reading the card").toBeGreaterThan(10);

    const BANNED_CADENCE = /each morning|once each trading day/i;
    for (const [where, text] of strings) {
      expect(BANNED_CADENCE.test(text), `${where}: ${text}`).toBe(false);
    }
    // …and it really can fire on both shapes that shipped.
    expect(BANNED_CADENCE.test("Vyuha signs in again each morning without asking you.")).toBe(true);
    expect(BANNED_CADENCE.test("signed in once each trading day with the client code")).toBe(true);
  });
});

describe("the row's state is DERIVED from what the route said about this account", () => {
  it("no connection saved → the radio is dead and says what to do about it", () => {
    const s = angelOneRowState({ connected: false, ackCurrent: false, openCount: 0 });
    expect(s.disabled).toBe(true);
    expect(s.line).toBe("Add Angel One under Import → Connect broker first.");
  });

  it("connection saved → the radio takes a click and the line describes the credential", () => {
    const s = angelOneRowState({ connected: true, ackCurrent: false, openCount: 12 });
    expect(s.disabled).toBe(false);
    expect(s.line).toBe(ANGELONE_FEED_COPY.blurb);
  });

  it("nothing known yet → enabled, because a request that never answered is not a refusal", () => {
    const s = angelOneRowState(undefined);
    expect(s.disabled).toBe(false);
    expect(s.line).toBe(ANGELONE_FEED_COPY.blurb);
  });

  it("both derived values reach the JSX — the helper is not decoration", () => {
    const src = stripComments(read(CARD));
    expect(src).toMatch(/angelOneRowState\(status\?\.angelone\)/);
    expect(src, "the radio ignores the derived disabled state").toMatch(
      /disabled=\{pending \|\| \(row\?\.disabled \?\? false\)\}/,
    );
    expect(src, "the derived line is not what the row renders").toMatch(/\{row \? row\.line : p\.blurb\}/);
  });

  it("the scope sentence is rendered ALWAYS, exactly once, connected or not", () => {
    const src = stripComments(read(CARD));
    expect(src.split("ANGELONE_FEED_COPY.equityOnly").length - 1, "a second copy of the scope sentence").toBe(1);
    expect(src).toMatch(/\{p\.id === "angelone" && \(\s*<span[\s\S]*?ANGELONE_FEED_COPY\.equityOnly/);
  });
});

// ---------------------------------------------------------------------------
// The tiered cadence line (ruling 4.2-4)
// ---------------------------------------------------------------------------

describe("the cadence line states the tier and the arithmetic behind it", () => {
  /** The three worked cases, one per tier, with the calls each implies. */
  it.each([
    [30, 3, 1],
    [120, 5, 3],
    [300, 10, 6],
  ])("%i open scrips → every %i s, %i calls per refresh", (count, seconds, calls) => {
    expect(angelOneCadenceSeconds(count), "the tier itself").toBe(seconds);
    expect(angelOneRefreshCalls(count), "50 symbols to a batch").toBe(calls);
    expect(angelOneCadenceLine(count)).toBe(
      `Refreshes every ${seconds} seconds — Angel One allows about one request a second, ` +
        `and your ${count} open scrips take ${calls} ${calls === 1 ? "call" : "calls"} per refresh.`,
    );
  });

  it("names the tier boundaries exactly where the contract puts them", () => {
    // The edges, not the middles: an off-by-one in a tier table is invisible at
    // 30 / 120 / 300 and changes the sentence at 50 / 51 / 200 / 201.
    expect(angelOneCadenceSeconds(50)).toBe(3);
    expect(angelOneCadenceSeconds(51)).toBe(5);
    expect(angelOneCadenceSeconds(200)).toBe(5);
    expect(angelOneCadenceSeconds(201)).toBe(10);
    expect(angelOneCadenceSeconds(500)).toBe(10);
  });

  it("caps the book at 500 — the same ceiling the poll itself applies", () => {
    expect(ANGELONE_MAX_PRICED_POSITIONS).toBe(500);
    expect(ANGELONE_BATCH_SIZE).toBe(50);
    // A larger book does not produce a bigger number on screen than the poll
    // will ever carry: 900 positions are 500 keys and 10 calls, not 18.
    expect(angelOneCadenceLine(900)).toBe(angelOneCadenceLine(500));
    expect(angelOneRefreshCalls(900)).toBe(10);
  });

  it("never says 'take 1 calls' — the sentence is grammatical at every count", () => {
    expect(angelOneCadenceLine(1)).toContain("your 1 open scrip takes 1 call per refresh");
    expect(angelOneCadenceLine(2)).toContain("your 2 open scrips take 1 call per refresh");
    expect(angelOneCadenceLine(51)).toContain("your 51 open scrips take 2 calls per refresh");
  });

  /**
   * ONE SENTENCE, TWO SURFACES — asserted as BEHAVIOUR (A-5 / A-7).
   *
   * This used to pin the two call sites as SOURCE TEXT
   * (`angelOneCadenceLine(status?.angelone?.openCount ?? 0)` and
   * `angelOneCadenceLine(rows.length)`), and both defects this wave fixes were
   * live underneath those green pins: the desk counted ROWS where the poll
   * counts deduped KEYS, and the card defaulted an unknown count to 0. A pin on
   * the expression that is wrong can only ever report that it is still there.
   */
  it("is ONE sentence, shared by both surfaces rather than restated", () => {
    // Still the G2 rule: the sentence is DEFINED once, and both surfaces import
    // it rather than writing their own.
    const defs = stripComments(read(DESK_COPY_FILE)).match(/Refreshes every \$\{seconds\} seconds/g) ?? [];
    expect(defs.length, "the cadence sentence is written in more than one place").toBe(1);
    expect(stripComments(read(CARD)), "the card restates the sentence instead of importing it").not.toMatch(
      /Refreshes every/,
    );
    expect(
      stripComments(read("components/live/tracker-client.tsx")),
      "the desk restates the sentence instead of importing it",
    ).not.toMatch(/Refreshes every/);
  });

  it("BOTH surfaces say the same thing for the same book — 50 keys is 3 seconds and 1 call", () => {
    // The Settings card counts `openPositionKeys().length` (deduped) and the
    // desk now counts the stream's own `symbols` (that same deduped set), so
    // one book produces one sentence. It did not: the desk counted the 51 ROWS
    // behind those 50 keys and printed 5 seconds and 2 calls beside a card
    // saying 3 seconds and 1 call.
    const card = angelOneCadenceText({ connected: true, ackCurrent: true, openCount: 50 });
    const desk = deskAngelOneCadence({ providerId: "angelone", linkSymbolCount: 50, feedSymbolCount: null });
    expect(card).toBe(desk);
    expect(card).toContain("Refreshes every 3 seconds");
    expect(card).toContain("your 50 open scrips take 1 call per refresh");
  });
});

/**
 * A-7 — THE CARD STATED A BOOK NOBODY HAD TOLD IT ABOUT.
 *
 * The cadence block rendered `angelOneCadenceLine(status?.angelone?.openCount ??
 * 0)`, so between mount and the fetch answering — and FOR EVER if that fetch
 * failed, because the catch swallows — the card told a user with a full book
 * "your 0 open positions take 1 call per refresh". A 0 where the number is
 * simply unknown is a claim about the user's positions (invariant 6), and this
 * same card already had the honest treatment for exactly this case: the health
 * line says "Checking the feed…" until the server answers.
 */
describe("the cadence line says nothing about a book it has not been told about (A-7)", () => {
  const src = stripComments(read(CARD));

  it("before the fetch answers, it says it is checking — it does not claim 0 positions", () => {
    expect(angelOneCadenceText(undefined)).toBe(FEED_CHECKING);
    expect(angelOneCadenceText(undefined), "a book the card has not been told about").not.toMatch(/0 open/);
    // The sentence that used to print, so this test can tell the two apart.
    expect(angelOneCadenceLine(0)).toContain("your 0 open scrips take 1 call per refresh");
  });

  it("once the server has answered, it states that account's own count", () => {
    expect(angelOneCadenceText({ connected: true, ackCurrent: true, openCount: 0 })).toBe(angelOneCadenceLine(0));
    expect(angelOneCadenceText({ connected: true, ackCurrent: true, openCount: 51 })).toContain(
      "Refreshes every 5 seconds",
    );
  });

  it("the JSX renders the derived text, and no defaulted count survives in the card", () => {
    expect(src).toContain("angelOneCadenceText(status?.angelone)");
    expect(src, "the card still defaults an unknown count to 0").not.toContain("openCount ?? 0");
  });

  it("it is the SAME treatment the health line uses — one sentence, not two", () => {
    expect(feedHealthText({ health: null, blocked: false })).toBe(FEED_CHECKING);
    expect(src.split('"' + FEED_CHECKING + '"').length - 1, "the checking sentence is written twice").toBe(1);
  });
});

describe("the 1–5 s slider is HIDDEN under the Angel One pick, and only under it", () => {
  const src = stripComments(read(CARD));

  it("the swap is a ternary on the provider, inside the one release gate", () => {
    // The gate itself is untouched — `tests/live-feed-copy.test.ts` requires
    // the slider to sit inside exactly one `{BROKER_FEED_OFFERED && (…)}`
    // subtree, and a second gate would satisfy neither test.
    expect(src).toContain("{BROKER_FEED_OFFERED && (");
    expect(src).toMatch(/\{BROKER_FEED_OFFERED && \(\s*provider === "angelone" \? \(/);
    expect(src.split('data-testid="live-feed-seconds"').length - 1, "a second copy of the slider").toBe(1);
  });

  it("the cadence line takes the slider's place, in the same block", () => {
    const block = src.slice(src.indexOf("{BROKER_FEED_OFFERED && ("));
    const cadenceAt = block.indexOf('data-testid="live-feed-angelone-cadence"');
    const sliderAt = block.indexOf('data-testid="live-feed-seconds"');
    expect(cadenceAt, "the cadence line is not rendered at all").toBeGreaterThan(-1);
    expect(sliderAt, "the slider is gone entirely — the other providers still need it").toBeGreaterThan(-1);
    expect(cadenceAt, "the cadence line is not the Angel One branch of the swap").toBeLessThan(sliderAt);
  });
});

describe("the daily re-authentication block is SHOWN for Angel One, with the factual sentence", () => {
  it("says what Angel One's system does, and what Vyuha does about it", () => {
    // C-3: "…nothing for you to do each morning" lost its last two words. The
    // CLAIM is about the reader and it survives — there is nothing for them to
    // do — but the words tied it to a clock the code does not keep, and the
    // export scan above bans that phrasing in every string on this card.
    expect(ANGELONE_FEED_COPY.dailyReauth).toBe(
      "Angel One ends every API session at 5 AM IST. Vyuha opens the next one by itself from the client code, PIN and TOTP secret you saved — there is nothing for you to do.",
    );
    expect(ANGELONE_FEED_COPY.dailyReauth).toMatch(/5 AM IST/);
    // UNATTENDED is the whole point: the generic sentence says the session
    // "has to be signed in again", which is true of the session and false of
    // the reader. Neither Angel One string may put the work back on them.
    for (const [where, text] of Object.entries(ANGELONE_FEED_COPY)) {
      expect(/you (?:have to|must|need to) (?:sign|log) in/i.test(text), `${where}: ${text}`).toBe(false);
    }
  });

  it("NAMES NO REGULATOR — no circular saying so is cited anywhere in this tree", () => {
    // The same ban `tests/live-feed-copy.test.ts` puts on LIVE_FEED_COPY.
    // An unverified claim about what a regulator requires is exactly the kind
    // of sentence that ships as fact and cannot be defended.
    for (const [where, text] of Object.entries(ANGELONE_FEED_COPY)) {
      expect(text, `${where} names a regulator`).not.toMatch(/\b(SEBI|exchange|exchanges|circular|regulat\w*)\b/i);
    }
    // …and the scan can fire on the shape the sentence could have taken.
    expect(/\b(SEBI|exchange|exchanges|circular|regulat\w*)\b/i.test("SEBI requires a daily sign-in")).toBe(true);
  });

  it("is the block the OTHER providers already use — one block, one testid", () => {
    const src = stripComments(read(CARD));
    expect(src.split('data-testid="live-feed-reauth"').length - 1, "a second re-auth block").toBe(1);
    expect(src).toMatch(
      /provider === "angelone" \? ANGELONE_FEED_COPY\.dailyReauth : LIVE_FEED_COPY\.dailyReauth/,
    );
    // Upstox is still the one provider the block is suppressed for.
    expect(src).toContain('provider === "upstox" ? null :');
  });
});

// ---------------------------------------------------------------------------
// The consent sheet
// ---------------------------------------------------------------------------

describe("the consent sheet shows ANGEL ONE's items, and never another provider's", () => {
  it("the card hands it Angel One's items and Angel One's version", () => {
    const src = stripComments(read(CARD));
    expect(src).toContain("items={ANGELONE_FEED_ITEMS}");
    expect(src).toContain("version={LIVE_FEED_DISCLOSURE_VERSIONS.angelone}");
    expect(src).toContain('testId="angelone-feed-dialog"');
    expect(src, "OpenAlgo's items are reachable from the card").not.toContain("OPENALGO_FEED_ITEMS");
  });

  it("the two sheets cannot both be open, because the state is WHICH and not WHETHER", () => {
    const src = stripComments(read(CARD));
    expect(src).toContain('open={consentOpen === "angelone"}');
    expect(src).toContain('open={consentOpen === "upstox"}');
    expect(src, "a boolean would open both sheets at once").toMatch(
      /React\.useState<null \| "upstox" \| "angelone">\(null\)/,
    );
  });

  it("names no OTHER provider, and carries none of another sheet's body verbatim", () => {
    // NOT a title-disjointness check: two of the seven headings are shared on
    // purpose ("Equity positions only in this release", "The prices stay on
    // this machine") because they state ONE release-scope rule and ONE storage
    // rule, and re-phrasing them per provider is how two promises drift apart.
    // What must be disjoint is the CLAIM: no Angel One item may name another
    // broker, and every risk peculiar to this provider must be here and here
    // only.
    expect(ANGELONE_FEED_ITEMS.length).toBeGreaterThan(0);
    const angelText = ANGELONE_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ");
    expect(angelText, "the Angel One sheet names Upstox").not.toMatch(/upstox/i);
    expect(angelText, "the Angel One sheet names OpenAlgo").not.toMatch(/openalgo/i);
    expect(angelText, "the Angel One sheet does not name Angel One").toMatch(/angel one/i);

    // THE FOUR CLAIMS THAT ARE ANGEL ONE'S ALONE, each named by the thing it
    // asserts. Two headings on this sheet restate a rule the Upstox sheet also
    // states (equities only; the prices stay here) and that is deliberate —
    // one release-scope rule, one storage rule, re-phrased per provider is how
    // two promises drift. What must be UNIQUE is the risk each provider
    // carries, and a sheet handed to the wrong dialog loses exactly these.
    const angelBodies = ANGELONE_FEED_ITEMS.map((i) => i.body).join(" ");
    const otherText = [...UPSTOX_FEED_ITEMS, ...OPENALGO_FEED_ITEMS]
      .map((i) => `${i.title} ${i.body}`)
      .join(" ");
    for (const [what, pattern] of [
      // B-7 (fix wave 2): the sheet used to say "once each trading day", which
      // is true per PROCESS and not per day — a relaunch, a re-saved credential
      // or the launch-time trade pull each sign in again on the same disclosed
      // host. The claim pinned here is the reworded one, which is what the code
      // does; it is still Angel One's alone.
      // C-3 (fix wave 3): the sheet's own owner restated the triggers in the
      // same wave that reworded the card's blurb, so the two halves of the
      // claim are pinned separately — the cadence, and the fact that the
      // triggers are events and not a clock. A byte pin here would red on the
      // sheet owner's wording rather than on the property.
      ["the once-a-day sign-in", /signs in to apiconnect\.angelone\.in at most once a day/i],
      ["the triggers that are not a clock", /again after a relaunch[^.]*re-save the credentials/i],
      ["the 5 AM flush, unattended", /5 AM IST session flush|clears every session at 5 AM IST/i],
      ["the batching and the tiers", /in batches of 50, no more than once a second/i],
      ["the token look-up kept locally", /keeps that mapping on this machine/i],
    ] as [string, RegExp][]) {
      expect(angelBodies, `the Angel One sheet no longer states ${what}`).toMatch(pattern);
      expect(otherText, `${what} is not unique to the Angel One sheet`).not.toMatch(pattern);
    }
  });

  it("the accept hook the sheet renders is Angel One's own", () => {
    // `FeedConsentDialog` derives its testids from `testId`, so this is the
    // pair an e2e or a support screenshot can name.
    const src = read("components/system/feed-consent-dialog.tsx");
    expect(src).toContain('data-testid={`${testId}-items`}');
    expect(src).toContain('data-testid={`${testId}-accept`}');
  });
});

describe("nothing this wave adds to the screen prompts a transaction", () => {
  it.each(NEW_STRINGS)("%s carries no banned vocabulary", (_where, text) => {
    expect(BANNED.test(text), text).toBe(false);
    expect(PRESCRIPTIVE_LANGUAGE.test(text), text).toBe(false);
  });

  it("the scan really can fire on the shapes this copy could have taken", () => {
    expect(BANNED.test("You should connect Angel One for live alerts")).toBe(true);
    expect(BANNED.test("We recommend the Angel One feed")).toBe(true);
    expect(BANNED.test("Consider a shorter refresh for Angel One")).toBe(true);
    expect(PRESCRIPTIVE_LANGUAGE.test("You must add Angel One first")).toBe(true);
  });

  it("the word alert appears nowhere in the card, the route or the desk's copy", () => {
    for (const rel of [CARD, ROUTE, DESK_COPY_FILE]) {
      expect(stripComments(read(rel)), `${rel} mentions alerts`).not.toMatch(/\balert/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

let t: TempDb;
let route: typeof import("@/app/api/live/feed/route");

const SWING = 2;
const OTHER = 3;

function get(): Promise<Response> {
  return route.GET(
    new Request("http://127.0.0.1:3011/api/live/feed", { headers: { host: "127.0.0.1:3011" } }),
  );
}

function post(body: unknown): Promise<Response> {
  return route.POST(
    new Request("http://127.0.0.1:3011/api/live/feed", {
      method: "POST",
      headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function settingsRow() {
  return t.db.select().from(t.schema.settings).limit(1).all()[0];
}

/** The seed the whole file's egress claims rest on: this must never appear. */
const SECRET = "ANGELONE-TOTP-SECRET-BASE32-DO-NOT-LEAK";

function connect(accountId: number) {
  t.db
    .insert(t.schema.brokerConnections)
    .values({
      accountId,
      broker: "angelone",
      apiKey: "smartapi-key",
      accessToken: "angelone-jwt-do-not-leak",
      authJson: JSON.stringify({ totp: SECRET }),
    })
    .run();
}

beforeAll(async () => {
  t = await openTempDb("live-feed-angelone-settings", { seed: true });
  route = await import("@/app/api/live/feed/route");
  await import("@/lib/queries/trades");

  t.db.insert(t.schema.accounts).values([{ id: SWING, name: "Swing" }, { id: OTHER, name: "Long term" }]).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: SWING }).run();
});

afterAll(() => {
  t?.cleanup();
});

describe("GET — the facts the card renders the Angel One radio from", () => {
  it("says neither half holds on a fresh install, and reports the open count", async () => {
    const body = await (await get()).json();
    expect(body.ok).toBe(true);
    expect(body.angelone).toEqual({ connected: false, ackCurrent: false, disclosureVersion: "1", openCount: 0 });
    expect(body.angelone.disclosureVersion).toBe(LIVE_FEED_DISCLOSURE_VERSIONS.angelone);
  });

  it("offers angelone in the pickable set the card reads", async () => {
    const body = await (await get()).json();
    expect(body.providers.map((p: { id: string }) => p.id)).toContain("angelone");
  });

  it("counts the OPEN positions of the SELECTED account, and nobody else's (invariant 8)", async () => {
    // Three rows: two open on the selected account, one open on the other, one
    // closed on the selected. The count the cadence line is computed from must
    // be 2 — an account leak here would silently change the interval on screen.
    t.db
      .insert(t.schema.trades)
      .values([
        tradeRow({ accountId: SWING, symbol: "TCS", tradingsymbol: "TCS", isOpen: true, buyQty: 10, avgBuyPrice: 3000 }),
        tradeRow({ accountId: SWING, symbol: "INFY", tradingsymbol: "INFY", isOpen: true, buyQty: 10, avgBuyPrice: 1500 }),
        tradeRow({ accountId: SWING, symbol: "WIPRO", tradingsymbol: "WIPRO", isOpen: false, buyQty: 10, avgBuyPrice: 400 }),
        tradeRow({ accountId: OTHER, symbol: "HDFCBANK", tradingsymbol: "HDFCBANK", isOpen: true, buyQty: 10, avgBuyPrice: 1600 }),
      ])
      .run();
    const body = await (await get()).json();
    expect(body.angelone.openCount, "another account's open positions were counted").toBe(2);
  });
});

describe("POST provider angelone — 409 until BOTH halves hold, storing nothing", () => {
  it("refuses when no connection is saved, and names the next step", async () => {
    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("Add Angel One under Import → Connect broker first.");
    expect(settingsRow()?.liveFeedProvider, "a refused pick was stored anyway").toBe("eod");
  });

  it("a connection on ANOTHER account is not this account's connection (invariant 8)", async () => {
    connect(OTHER);
    const body = await (await get()).json();
    expect(body.angelone.connected, "another account's credential counted as this one's").toBe(false);
    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(409);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });

  it("refuses with the disclosure reason once the connection exists but nothing was accepted", async () => {
    connect(SWING);
    const body = await (await get()).json();
    expect(body.angelone).toMatchObject({ connected: true, ackCurrent: false });
    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain("Read what the Angel One feed does");
    expect(settingsRow()?.liveFeedProvider).toBe("eod");
  });
});

describe("POST ack — the acknowledgement round-trips, per provider", () => {
  it("stores the version this build ships, under Angel One's own id", async () => {
    const res = await post({ action: "ack", provider: "angelone" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.angelone).toMatchObject({ connected: true, ackCurrent: true });

    const stored = settingsRow()?.liveFeedAckJson;
    expect(parseFeedAcks(stored)).toEqual({ angelone: LIVE_FEED_DISCLOSURE_VERSIONS.angelone });
    expect(isFeedAckCurrent(stored, "angelone")).toBe(true);
    // Accepting Angel One is NOT accepting Upstox — one column, two keys.
    expect(isFeedAckCurrent(stored, "upstox")).toBe(false);
  });

  it("…and the pick is accepted once both halves hold", async () => {
    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(200);
    expect(settingsRow()?.liveFeedProvider).toBe("angelone");
  });

  it("accepting the OTHER sheet does not withdraw this one", async () => {
    await post({ action: "ack", provider: "upstox" });
    const stored = settingsRow()?.liveFeedAckJson;
    expect(parseFeedAcks(stored)).toEqual({ angelone: "1", upstox: "1" });
  });

  it("a version bump re-asks: a stored older version is refused, and the pick with it", async () => {
    t.db.update(t.schema.settings).set({ liveFeedAckJson: '{"angelone":"0"}', liveFeedProvider: "eod" }).run();
    const body = await (await get()).json();
    expect(body.angelone.ackCurrent, "an older acknowledgement was accepted as current").toBe(false);

    const res = await post({ action: "provider", provider: "angelone" });
    expect(res.status).toBe(409);
    expect(settingsRow()?.liveFeedProvider).toBe("eod");

    await post({ action: "ack", provider: "angelone" });
    expect(parseFeedAcks(settingsRow()?.liveFeedAckJson)).toEqual({ angelone: "1" });
  });
});

describe("the route reads the row's existence and never the credential", () => {
  it("no credential of any kind is in the answer — least of all the TOTP seed", async () => {
    const text = await (await get()).text();
    expect(text).toContain('"connected":true');
    expect(text, "the TOTP secret reached the client").not.toContain(SECRET);
    expect(text).not.toContain("smartapi-key");
    expect(text, "the session token reached the client").not.toContain("angelone-jwt-do-not-leak");
  });

  it("the select list is the id alone — proved in the source, since a wider select would still pass above", () => {
    const src = stripComments(read(ROUTE));
    const fn = src.slice(src.indexOf("function angelOneConnected()"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/\.select\(\{ id: brokerConnections\.id \}\)/);
    expect(src, "the route reads a credential column").not.toMatch(/brokerConnections\.(apiKey|accessToken|authJson)/);
  });
});

/**
 * A-6 — A BLOCKED FEED WAS INVISIBLE FOR EVERY PROVIDER BUT OpenAlgo.
 *
 * `resolveLiveFeed()` falls back to `eod` and publishes `blockedReason`
 * whenever the STORED provider's acknowledgement is not current — a disclosure
 * version bump, or a backup restored on another machine (`liveFeedProvider`
 * travels in the envelope; `liveFeedAckJson` is machine state and does not).
 * The card rendered that reason only inside `provider === "openalgo" && …`, so
 * with Angel One stored and blocked: the radio showed CHECKED (the card's state
 * is initialised from the stored value), the health line said "Feed OK" (it
 * describes the EFFECTIVE provider, which is end-of-day and genuinely healthy),
 * nothing said blocked — and because a checked radio fires no `onChange`, the
 * one path to the consent sheet was unreachable without switching away first.
 *
 * Driven through the REAL route, so the fixture cannot drift from what the
 * server sends.
 */
describe("a blocked Angel One feed is stated, and the sheet is reachable again (A-6)", () => {
  const src = stripComments(read(CARD));

  it("the restore case: the pick travels, the acknowledgement does not", async () => {
    t.db.update(t.schema.settings).set({ liveFeedProvider: "angelone", liveFeedAckJson: null }).run();
    const body = await (await get()).json();
    expect(body.feed.stored, "the pick is what the user chose").toBe("angelone");
    expect(body.feed.effective, "…and it is not what runs").toBe("eod");
    expect(body.feed.blockedReason).toBeTruthy();

    const block = feedBlockState(body.feed);
    expect(block, "the card renders nothing at all for a blocked Angel One feed").not.toBeNull();
    expect(block?.reason).toBe(body.feed.blockedReason);
    expect(block?.reviewProvider, "there is no way back to the consent sheet").toBe("angelone");
  });

  it("the health line stops reporting the FALLBACK feed as fine", async () => {
    const body = await (await get()).json();
    const blocked = feedBlockState(body.feed) !== null;
    // The trap: `health` describes the EFFECTIVE provider, so the card said
    // whatever end-of-day had to say about itself over a feed the user picked
    // and is not getting. Whatever that is, the blocked fact comes first.
    expect(body.health.provider, "the health line describes the fallback").toBe("eod");
    expect(feedHealthText({ health: body.health, blocked })).toBe(FEED_BLOCKED_HEALTH);
    // The exact shape that used to print "Feed OK" over a blocked feed.
    expect(feedHealthText({ health: { ok: true, latencyMs: null, reason: "" }, blocked: true })).toBe(
      FEED_BLOCKED_HEALTH,
    );
    expect(feedHealthText({ health: body.health, blocked }), "a blocked feed still reads OK").not.toContain("Feed OK");
    // …and with nothing blocked it is unchanged from v4.1.
    expect(feedHealthText({ health: { ok: true, latencyMs: 12, reason: "" }, blocked: false })).toBe("Feed OK · 12 ms");
  });

  it("accepting the sheet clears the block — the same GET, one write later", async () => {
    await post({ action: "ack", provider: "angelone" });
    const body = await (await get()).json();
    expect(body.feed.stored).toBe("angelone");
    expect(body.feed.effective).toBe("angelone");
    expect(body.feed.blockedReason).toBeUndefined();
    expect(feedBlockState(body.feed)).toBeNull();
  });

  it("the block and its control reach the JSX, for the STORED provider", () => {
    expect(src).toContain("const blocked = feedBlockState(status?.feed);");
    expect(src).toContain('data-testid="live-feed-blocked"');
    expect(src).toContain('data-testid="live-feed-review-consent"');
    // The control opens the sheet for the provider that is BLOCKED, which is
    // the STORED one — `pick()` cannot be reached from a radio already checked.
    // C-6 renamed the derived value: the block carries at most ONE control, and
    // which one it is is now a discriminated union (`review` | `keep-eod`).
    expect(src).toMatch(/onClick=\{\(\) => setConsentOpen\(control\.provider\)\}/);
    expect(src).toContain("{REVIEW_CONSENT_CTA}");
    expect(REVIEW_CONSENT_CTA).toBe("Review and accept");
    expect(PRESCRIPTIVE_LANGUAGE.test(REVIEW_CONSENT_CTA), REVIEW_CONSENT_CTA).toBe(false);
  });
});

/**
 * B-4 — THE CARD ASKED, WAS ANSWERED, AND WENT ON SHOWING THE OLD ANSWER.
 *
 * `status` is filled by the card's mount fetch and by nothing else. `store()`
 * threw away the POST's body except for `ok`/`message`, even though the route
 * has answered the provider action with `feed: await resolveLiveFeed()` since
 * v4.1 — and `settings-form.tsx` mounts this card UNKEYED, so `router.refresh()`
 * re-renders it with the state it already had (DECISIONS: an initialiser does
 * not re-run after `router.refresh()`). Everything derived from `status.feed`
 * therefore kept describing the world as it was BEFORE the write:
 *
 *   • Review and accept → ack ok → store ok → "Saved.", and the blocked block,
 *     its button and the "Not live — blocked" health line all stayed until the
 *     user reloaded the page;
 *   • the v4.1 switch-away path regressed with it — a blocked OpenAlgo pick,
 *     switch to end-of-day, and the eod radio was checked while a block beside
 *     it said the picked feed was blocked.
 *
 * Driven through the REAL route and through the card's OWN fold, so what is
 * asserted is the card's derivation from the POST BODY — no second GET is made
 * anywhere in this block, because the card does not make one either.
 */
describe("the card folds the POST's own verdict into its state (B-4)", () => {
  it("Review and accept clears the block without a second GET", async () => {
    // The restore case again: the pick travelled, the acknowledgement did not.
    t.db.update(t.schema.settings).set({ liveFeedProvider: "angelone", liveFeedAckJson: null }).run();
    const mounted = await (await get()).json(); // what the mount fetch put in `status`
    expect(feedBlockState(mounted.feed)?.reviewProvider, "the button is not even offered").toBe("angelone");

    // The two POSTs the button really sends, in order, and nothing else.
    const ack = await (await post({ action: "ack", provider: "angelone" })).json();
    let status = foldFeedResponse(mounted, ack);
    const stored = await (await post({ action: "provider", provider: "angelone" })).json();
    expect(stored.feed, "the route already answers the write with its own verdict").toBeTruthy();
    status = foldFeedResponse(status, stored);

    expect(feedBlockState(status?.feed), "the blocked block survives an accepted sheet").toBeNull();
    expect(status?.feed?.stored).toBe("angelone");
    expect(status?.feed?.effective, "the accepted feed is what runs now").toBe("angelone");
    expect(status?.angelone?.ackCurrent, "the ack the server just recorded").toBe(true);
    expect(
      feedHealthText({ health: status?.health, blocked: feedBlockState(status?.feed) !== null }),
      "the health line still reads blocked after the block cleared",
    ).not.toBe(FEED_BLOCKED_HEALTH);
  });

  it("the v4.1 switch-away path: picking end-of-day drops a blocked OpenAlgo block", async () => {
    t.db
      .update(t.schema.settings)
      .set({ liveFeedProvider: "openalgo", openalgoEnabled: false, openalgoAckVersion: null })
      .run();
    const mounted = await (await get()).json();
    expect(mounted.feed.stored).toBe("openalgo");
    expect(feedBlockState(mounted.feed), "the fixture is not blocked, so this proves nothing").not.toBeNull();

    const switched = await (await post({ action: "provider", provider: "eod" })).json();
    const status = foldFeedResponse(mounted, switched);
    expect(status?.feed?.stored).toBe("eod");
    expect(
      feedBlockState(status?.feed),
      "end-of-day is checked AND a block says the feed you picked is blocked",
    ).toBeNull();
  });

  it("folds only what the response carried — a missing key is not 'no longer true'", () => {
    const prev = {
      ok: true,
      feed: { stored: "angelone", effective: "eod", refreshSeconds: 3, blockedReason: "x" },
      angelone: { connected: true, ackCurrent: false, openCount: 7 },
    };
    // `refresh-seconds` answers with neither half; the card must not forget.
    expect(foldFeedResponse(prev, { ok: true, message: "Refreshing every 3s." })).toEqual(prev);
    // …and with no mount answer at all there is nothing to fold into.
    expect(foldFeedResponse(null, { ok: true, feed: prev.feed })).toBeNull();
  });

  it("all three write paths fold, in the card itself", () => {
    const card = stripComments(read(CARD));
    // C-7 wraps the fold: `foldWriteResult` IS `foldFeedResponse` plus the
    // dropped health (asserted below), so the B-4 property is unchanged — all
    // three write paths keep the server's verdict.
    expect(
      card.match(/setStatus\(\(prev\) => foldWriteResult\(prev, r\)\)/g)?.length,
      "store() or one of the two accept paths still discards the answer",
    ).toBe(3);
    // …and it is not a fetch effect wearing a different hat: the only effect on
    // this card is still the mount-only one.
    expect(card.match(/React\.useEffect\(/g)?.length, "a second effect appeared").toBe(1);
  });
});

/**
 * B-8 — A WITHHELD BROKER'S SHEET WAS ONE STORED STRING AWAY.
 *
 * Three things were ungated while the picker itself was flag-gated: the route's
 * `ack` action took `z.enum(["upstox", "angelone"])` unconditionally,
 * `feedBlockState` offered `reviewProvider` for any id that HAS a sheet rather
 * than any id this build OFFERS, and both dialogs mounted unconditionally. With
 * a flag off and the withheld id sitting in `liveFeedProvider` — it travels in
 * a backup envelope, the acknowledgement does not — the card grew a
 * "Review and accept" button for a feed with no radio, opened that broker's
 * disclosure and recorded an acknowledgement for it.
 *
 * The flags are INJECTED through the card's own `offeredProviders()` filter and
 * MOCKED for the route, because all three are true in this build and the broken
 * spelling and the correct one agree while they are.
 */
describe("a provider this build withholds gets no button, no sheet and no ack (B-8)", () => {
  const offered = (openalgo: boolean, upstox: boolean, angelone: boolean) =>
    offeredProviders({ openalgo, upstox, angelone }).map((p) => p.id);

  it("the block is still STATED for a withheld provider, but its button is not", async () => {
    t.db.update(t.schema.settings).set({ liveFeedProvider: "angelone", liveFeedAckJson: null }).run();
    const body = await (await get()).json();
    expect(body.feed.stored).toBe("angelone");

    // As this build ships: the sheet is this card's, so the button is offered.
    expect(feedBlockState(body.feed, offered(true, true, true))?.reviewProvider).toBe("angelone");
    // Angel One withheld: the user is still told the pick is not running…
    const withheld = feedBlockState(body.feed, offered(true, true, false));
    expect(withheld?.reason, "the blocked fact was withheld with the button").toBe(body.feed.blockedReason);
    // …and there is no control to open a disclosure for a feed that cannot run.
    expect(withheld?.reviewProvider, "the card opens a withheld broker's sheet").toBeNull();
    // The same property for the sibling provider, so this is not an Angel One
    // special case.
    t.db.update(t.schema.settings).set({ liveFeedProvider: "upstox", liveFeedAckJson: null }).run();
    const upstoxBody = await (await get()).json();
    expect(feedBlockState(upstoxBody.feed, offered(true, true, true))?.reviewProvider).toBe("upstox");
    expect(feedBlockState(upstoxBody.feed, offered(true, false, true))?.reviewProvider).toBeNull();
    // Unchanged for OpenAlgo, whose consent lives on the Integrations screen.
    expect(
      feedBlockState({ stored: "openalgo", effective: "eod" }, offered(true, true, true))?.reviewProvider,
    ).toBeNull();
  });

  it("both consent sheets mount only behind the release flag that offers them", () => {
    const card = stripComments(read(CARD));
    expect(card).toMatch(/\{OFFERS_UPSTOX && \(\s*<FeedConsentDialog/);
    expect(card).toMatch(/\{OFFERS_ANGELONE && \(\s*<FeedConsentDialog/);
    // Derived from the resolved list, never restated as a second flag read.
    expect(card).toMatch(/OFFERS_UPSTOX = PROVIDERS\.some\(\(p\) => p\.id === "upstox"\)/);
    expect(card).toMatch(/OFFERS_ANGELONE = PROVIDERS\.some\(\(p\) => p\.id === "angelone"\)/);
    expect(card.match(/<FeedConsentDialog/g)?.length, "a third, ungated sheet").toBe(2);
  });

  it("the ack action is gated by the SAME release flag as the picker", async () => {
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod", liveFeedAckJson: null }).run();
    vi.resetModules();
    vi.doMock("@/lib/quotes/types", async () => ({
      ...(await vi.importActual<typeof import("@/lib/quotes/types")>("@/lib/quotes/types")),
      ANGELONE_FEED_ENABLED: false,
    }));
    try {
      // The SAME temp database — lib/db caches its connection on globalThis, so
      // a re-imported route writes through the connection this file opened.
      const gated = await import("@/app/api/live/feed/route");
      const send = (body: unknown) =>
        gated.POST(
          new Request("http://127.0.0.1:3011/api/live/feed", {
            method: "POST",
            headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );

      const refused = await send({ action: "ack", provider: "angelone" });
      expect(refused.status, "an ack was accepted for a provider this build withholds").toBe(400);
      expect(
        parseFeedAcks(settingsRow()?.liveFeedAckJson).angelone,
        "a withheld provider's acknowledgement was written anyway",
      ).toBeUndefined();
      // The picker refuses the same id, which is the behaviour being matched.
      expect((await send({ action: "provider", provider: "angelone" })).status).toBe(400);
      // …and the provider this build DOES ship is untouched by the gate.
      expect((await send({ action: "ack", provider: "upstox" })).status).toBe(200);
      expect(parseFeedAcks(settingsRow()?.liveFeedAckJson)).toEqual({
        upstox: LIVE_FEED_DISCLOSURE_VERSIONS.upstox,
      });
    } finally {
      vi.doUnmock("@/lib/quotes/types");
      vi.resetModules();
    }
  });
});

/**
 * C-7 — THE HEALTH LINE DESCRIBED THE FEED THAT USED TO RUN.
 *
 * `health` is fetched ONCE, at mount, and it describes the EFFECTIVE provider.
 * The POST bodies carry none: the provider action answers with `feed`, the ack
 * action with the two radio states. So after a switch from end-of-day to a
 * broker feed the card kept printing end-of-day's mount-time "Feed OK · N ms"
 * over a feed it had never probed — until the user reloaded the page, since
 * `settings-form.tsx` mounts this card UNKEYED and `router.refresh()` does not
 * remount it. `needsConnect` reads the same stale value.
 *
 * Driven through the REAL route and the card's OWN fold: the mount answer, the
 * write's answer, what the card is left holding, and the re-ask it now makes.
 */
describe("the health line describes the feed that runs NOW, not the one that ran at mount (C-7)", () => {
  it("switching eod → angelone drops the stale line, and the re-ask names the new provider", async () => {
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
    await post({ action: "ack", provider: "angelone" }); // both halves hold: SWING is connected

    const mounted = await (await get()).json(); // what the mount fetch put in `status`
    expect(mounted.feed.effective).toBe("eod");
    expect(mounted.health.provider, "the mount fetch describes the effective provider").toBe("eod");
    const atMount = feedHealthText({ health: mounted.health, blocked: false });
    expect(atMount, "the fixture says nothing at mount, so this would prove nothing").not.toBe(FEED_CHECKING);

    const r = await (await post({ action: "provider", provider: "angelone" })).json();
    expect(r.feed.effective, "the write did not change what runs").toBe("angelone");
    expect(r.health, "the POST carries no health — that is the whole defect").toBeUndefined();

    const written = foldWriteResult(mounted, r);
    expect(written?.health ?? null, "the card kept the PREVIOUS provider's health").toBeNull();
    const afterWrite = feedHealthText({ health: written?.health, blocked: false });
    expect(afterWrite).toBe(FEED_CHECKING);
    expect(afterWrite, "end-of-day's mount-time line survived the switch to Angel One").not.toBe(atMount);
    expect(afterWrite, "a feed that has never been probed reported OK").not.toContain("Feed OK");

    // The re-ask the card now makes answers for the provider that RUNS.
    const refreshed = await (await get()).json();
    expect(refreshed.feed.effective).toBe("angelone");
    expect(refreshed.health.provider, "the fresh GET still describes the old feed").toBe("angelone");
  });

  it("the fold is the B-4 fold plus the dropped health — nothing else changed", () => {
    const prev = {
      ok: true,
      feed: { stored: "eod", effective: "eod", refreshSeconds: 3 },
      angelone: { connected: true, ackCurrent: true, openCount: 7 },
      health: { ok: true, state: "ok", latencyMs: 4, reason: "" },
    };
    const r = { ok: true, feed: { stored: "angelone", effective: "angelone", refreshSeconds: 3 } };
    expect(foldWriteResult(prev, r)).toEqual({ ...foldFeedResponse(prev, r), health: null });
    expect(foldWriteResult(null, r), "with no mount answer there is nothing to fold into").toBeNull();
  });

  it("the fetch is extracted, re-asked after the write, and is still not an effect", () => {
    const card = stripComments(read(CARD));
    // ONE fetch, outside the component, called by the mount effect AND by the
    // write paths. It sits outside so the effect can keep calling `setStatus`
    // from the promise callback — `react-hooks/set-state-in-effect` fires on
    // `void refreshStatus(ac.signal)` in the effect body, and AGENTS.md forbids
    // silencing it.
    expect(card, "the mount fetch was not extracted").toMatch(
      /async function fetchStatus\(signal\?: AbortSignal\)/,
    );
    expect(card, "the mount effect no longer uses the extracted fetch").toMatch(
      /void fetchStatus\(ac\.signal\)\.then\(\(j\) => \{/,
    );
    expect(card, "the write paths do not share the mount fetch").toMatch(
      /async function refreshStatus\(\) \{\s*const j = await fetchStatus\(\);/,
    );
    // U-1: the re-ask is made AFTER the write it describes, by `store()`, and
    // by nothing that runs before one. The count this line used to assert
    // (three re-asks, one per write path) is what codified the defect: it was
    // satisfied by the two accept paths asking BEFORE their own store. The
    // ordering itself is pinned in the U-1 block below.
    expect(card, "store() no longer re-asks after its own write").toMatch(
      // `\r?\n`: the Windows CI runner checks the card out with CRLF (autocrlf),
      // and a literal `\n` here reddened run 34159744036 on that job alone.
      /const r = await post\(\{ action: "provider", provider: next \}\);[\s\S]*?await refreshStatus\(\);\r?\n {2}\}/,
    );
    // A plain fetch in an event handler — NOT a second effect, and never a
    // state-derived one (AGENTS.md).
    expect(card.match(/React\.useEffect\(/g)?.length, "a second effect appeared").toBe(1);
  });
});

/**
 * U-1 — THE ACCEPT PATHS ASKED THE ROUTE ABOUT THE FEED THEY WERE ABOUT TO
 * REPLACE, WITH THE DIALOG ALREADY CLOSED AND `pending` ALREADY FALSE.
 *
 * C-7 is not in question — after a successful write the card re-asks. Only the
 * ORDER was wrong. Both accept paths ran: ack POST → `setPending(false)` →
 * `await refreshStatus()` → `await store(provider)`. The GET in the middle is
 * answered by `healthLine()`, which probes the STILL-EFFECTIVE provider — for
 * OpenAlgo an untimed network POST to `/funds`. So with an unreachable
 * OpenAlgo host the sheet closed, the radio had not moved, no toast had shown
 * and nothing was disabled until that probe timed out, and a second click in
 * that window started a CONCURRENT `store()`. The answer it waited for was
 * then discarded anyway: `foldWriteResult` nulls `health` on the very next
 * write.
 *
 * The card cannot be driven here — vitest runs `environment: "node"`, the repo
 * ships no jsdom/happy-dom and no @testing-library/react, and `include` is
 * `tests/**` `/*.test.ts`, so a .tsx harness would not even be collected;
 * adding a dependency is not this wave's business. So the ORDER is pinned in
 * the source, the smallest honest means, and the COST of the old order is
 * driven through the real route in the last case.
 */
describe("the accept paths store first and let the write's own re-ask describe the new feed (U-1)", () => {
  /** The body of one `async function name()` declared at the component's own indent. */
  const bodyOf = (src: string, name: string) => {
    const start = src.indexOf(`async function ${name}()`);
    expect(start, `${name}() is gone from the card`).toBeGreaterThan(-1);
    const end = src.indexOf("\n  }", start);
    expect(end, `${name}() has no closing brace at the component's indent`).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it("neither accept path asks the route between the ack and the store", () => {
    const card = stripComments(read(CARD));
    for (const [name, provider] of [
      ["acceptUpstox", "upstox"],
      ["acceptAngelOne", "angelone"],
    ] as const) {
      const body = bodyOf(card, name);
      expect(body, `${name}() does not store the pick it just took consent for`).toMatch(
        new RegExp(`await store\\("${provider}"\\)`),
      );
      expect(
        body,
        `${name}() re-asks the route BEFORE the write it is about to make — that GET describes the provider being replaced (U-1)`,
      ).not.toMatch(/refreshStatus\(\)/);
    }
  });

  it("`pending` covers the whole accept → store span, so a second click cannot start a second write", () => {
    const card = stripComments(read(CARD));
    for (const name of ["acceptUpstox", "acceptAngelOne"] as const) {
      const body = bodyOf(card, name);
      expect(body, `${name}() does not disable the radios while it writes`).toMatch(/setPending\(true\)/);
      // Lowered ONCE, and only where the ack was refused; on the accepted path
      // `store()` owns it from its own `setPending(true)` onwards.
      expect(
        body.match(/setPending\(false\)/g)?.length ?? 0,
        `${name}() lowers pending outside the refusal branch, leaving a window for a concurrent store()`,
      ).toBe(1);
      expect(
        body,
        `${name}() does not lower pending as the first thing it does when the ack is refused`,
      ).toMatch(/if \(!r\.ok\) \{\s*setPending\(false\);/);
    }
  });

  it("a refused ack still stops there: it says so and stores nothing (unchanged)", () => {
    const card = stripComments(read(CARD));
    for (const name of ["acceptUpstox", "acceptAngelOne"] as const) {
      const body = bodyOf(card, name);
      const at = body.indexOf("if (!r.ok)");
      const refusal = body.slice(at, body.indexOf("}", at));
      expect(refusal, `${name}() no longer says the ack was refused`).toMatch(
        /toast\.error\(r\.message \?\? "Could not record that you read it\."\)/,
      );
      expect(refusal, `${name}() writes a provider after a refused ack`).not.toMatch(/store\(/);
      expect(refusal, `${name}() does not return after a refused ack`).toMatch(/return;/);
    }
  });

  it("the GET the accept path used to make can only describe the feed being replaced — and the write discards it", async () => {
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
    const acked = await (await post({ action: "ack", provider: "angelone" })).json();
    expect(acked.ok).toBe(true);

    // THIS is the ask that sat between the ack and the store.
    const mid = await (await get()).json();
    expect(mid.feed.effective, "the store has not happened yet").toBe("eod");
    expect(
      mid.health.provider,
      "the route's health line probes the EFFECTIVE provider, which is still the old one",
    ).toBe("eod");

    const stored = await (await post({ action: "provider", provider: "angelone" })).json();
    expect(stored.feed.effective).toBe("angelone");
    expect(
      foldWriteResult(mid, stored)?.health,
      "the answer the accept path waited for survived the write it was waiting on",
    ).toBeNull();

    // Which is why one GET is enough, and why it belongs after the write.
    const after = await (await get()).json();
    expect(after.health.provider, "store()'s own trailing re-ask describes the feed that RUNS").toBe("angelone");
  });
});

/**
 * C-6 — A WITHHELD STORED PROVIDER LEFT THE BLOCK WITH NO WAY OUT.
 *
 * `liveFeedProvider` travels in a backup envelope, so a build with the release
 * flag OFF can find the withheld broker's id in that column. B-8 correctly
 * withdrew the "Review and accept" button there — a disclosure must not be
 * accepted for a feed that cannot run — and that left the block TEXT ONLY. With
 * `provider` initialised to `"eod"` (the withheld id is not in `PROVIDERS`), the
 * end-of-day radio is already checked, and a checked radio fires no `onChange`:
 * `pick()` was unreachable, the column kept the withheld id, and the block and
 * its "not running" health line stayed for ever unless the user happened to
 * select another provider and then end-of-day again.
 *
 * The flags are MOCKED for the route and INJECTED into the card's own filter,
 * because all three are true in this build and the stuck state cannot occur
 * while they are.
 */
describe("a withheld stored provider can be cleared from the block itself (C-6)", () => {
  const offered = (openalgo: boolean, upstox: boolean, angelone: boolean) =>
    offeredProviders({ openalgo, upstox, angelone }).map((p) => p.id);

  it("the block grows ONE control, and it stores end-of-day through the ordinary write path", async () => {
    t.db.update(t.schema.settings).set({ liveFeedProvider: "angelone" }).run();
    vi.resetModules();
    vi.doMock("@/lib/quotes/types", async () => ({
      ...(await vi.importActual<typeof import("@/lib/quotes/types")>("@/lib/quotes/types")),
      ANGELONE_FEED_ENABLED: false,
    }));
    try {
      // The SAME temp database — lib/db caches its connection on globalThis.
      const gated = await import("@/app/api/live/feed/route");
      const ask = () =>
        gated.GET(new Request("http://127.0.0.1:3011/api/live/feed", { headers: { host: "127.0.0.1:3011" } }));
      const send = (body: unknown) =>
        gated.POST(
          new Request("http://127.0.0.1:3011/api/live/feed", {
            method: "POST",
            headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );

      const mounted = await (await ask()).json();
      expect(mounted.feed.stored, "the withheld pick travelled in the backup").toBe("angelone");
      expect(mounted.feed.effective, "a feed this build withholds ran anyway").toBe("eod");
      expect(mounted.feed.blockedReason).toContain("This build does not offer the Angel One feed");

      const ids = offered(true, true, false);
      const block = feedBlockState(mounted.feed, ids);
      expect(block, "the block is not stated at all").not.toBeNull();
      expect(block?.reviewProvider, "B-8: a withheld broker's sheet must stay unreachable").toBeNull();

      // THE DEFECT: a stated block, an already-checked eod radio that fires no
      // onChange, and no control anywhere that stores what is already effective.
      const control = feedBlockControl(mounted.feed, block, ids);
      expect(control, "the block carries no control, so the state cannot be cleared").toEqual({ kind: "keep-eod" });
      expect(KEEP_EOD_CTA).toBe("Keep end-of-day prices");

      // …and the line under it says WHY, in the route's own words, instead of
      // the generic sentence that points at a fix this build has not got.
      const line = feedHealthText({ health: mounted.health, blocked: true, blockedReason: block?.reason });
      expect(line, "the withheld block reported the generic blocked sentence").toBe(mounted.feed.blockedReason);
      expect(line).not.toBe(FEED_BLOCKED_HEALTH);

      // The control's own write — `pick("eod")` is the ordinary provider action.
      const r = await (await send({ action: "provider", provider: "eod" })).json();
      expect(r.ok).toBe(true);
      const status = foldWriteResult(mounted, r);
      expect(settingsRow()?.liveFeedProvider, "the withheld id is still what is stored").toBe("eod");
      expect(feedBlockState(status?.feed, ids), "the block survived the one control that clears it").toBeNull();
      expect(feedBlockControl(status?.feed, feedBlockState(status?.feed, ids), ids)).toBeNull();
    } finally {
      vi.doUnmock("@/lib/quotes/types");
      vi.resetModules();
    }
  });

  it("an OFFERED provider's block is unchanged — the sheet for the two brokers, text for OpenAlgo", () => {
    const ids = offered(true, true, true);
    const upstox = { stored: "upstox", effective: "eod", blockedReason: "…" };
    expect(feedBlockControl(upstox, feedBlockState(upstox, ids), ids)).toEqual({ kind: "review", provider: "upstox" });
    // OpenAlgo's radio IS on screen and its consent is given on the Integrations
    // screen, so its block stays text-only exactly as it was in v4.1.
    const openalgo = { stored: "openalgo", effective: "eod", blockedReason: "…" };
    expect(feedBlockControl(openalgo, feedBlockState(openalgo, ids), ids)).toBeNull();
    // Nothing blocked, nothing to clear.
    expect(feedBlockControl({ stored: "eod", effective: "eod" }, null, ids)).toBeNull();
    expect(feedBlockControl(undefined, null, ids)).toBeNull();
  });

  it("both controls reach the JSX, and at most one of them can render", () => {
    const src = stripComments(read(CARD));
    expect(src).toContain("const control = feedBlockControl(status?.feed, blocked);");
    expect(src).toMatch(/\{control\?\.kind === "review" && \(/);
    expect(src).toMatch(/\{control\?\.kind === "keep-eod" && \(/);
    expect(src).toContain('data-testid="live-feed-keep-eod"');
    expect(src, "the control does not take the ordinary write path").toMatch(/onClick=\{\(\) => void pick\("eod"\)\}/);
    expect(src).toContain("{KEEP_EOD_CTA}");
    // The health line carries the withheld reason, and only for that case.
    expect(src).toMatch(/blockedReason: control\?\.kind === "keep-eod" \? blocked\?\.reason : null,/);
    // One more sentence on a settings screen, held to the same bar as the rest.
    expect(BANNED.test(KEEP_EOD_CTA), KEEP_EOD_CTA).toBe(false);
    expect(PRESCRIPTIVE_LANGUAGE.test(KEEP_EOD_CTA), KEEP_EOD_CTA).toBe(false);
  });
});

/**
 * U-1 (round 5) — A REFUSED PROVIDER WRITE LEFT THE BLOCK SAYING WHAT IT SAID
 * AT MOUNT.
 *
 * Wave 4 removed the pre-store GET (the ordering defect above), which was also
 * the only thing that ever refreshed `status` on the path that ends in a
 * refusal: accept the sheet → the ack POST answers with the two radio states
 * and NO `feed` → `store()` POSTs the provider → the route answers 409 (no
 * connection saved for THIS account) → `store()` reverted the radio, toasted,
 * and returned. `status.feed.blockedReason` was still the mount-time "accept
 * it first" sentence, so `feedBlockControl` went on offering "Review and
 * accept" for an acknowledgement that is already current, and the fold's
 * nulled `health` was never replaced — the health line stayed at "Checking the
 * feed…" for ever. Clicking again looped: ack ok → 409 → the same stale
 * sentence.
 *
 * THE RULE, C-7 applied to the other outcome: after EVERY write the card
 * re-asks the route. The refusal branch therefore re-asks too, AFTER the
 * revert, so the block states the route's CURRENT reason and the health line
 * resolves. Two call sites, one per outcome, and still no GET before a write.
 *
 * Source-shape, for the reason the block above gives: vitest runs
 * `environment: "node"` and the repo ships no DOM harness, so `store()` cannot
 * be driven. `\r?\n` in every multi-line pattern — the Windows CI job checks
 * the card out with CRLF.
 */
describe("a refused provider write re-asks the route, so the block stops quoting the mount (U-1)", () => {
  /** The body of `store(next)` — the one declaration that takes a parameter. */
  const storeBody = (src: string) => {
    const start = src.indexOf("async function store(next: ProviderId)");
    expect(start, "store() is gone from the card").toBeGreaterThan(-1);
    const end = src.indexOf("\n  }", start);
    expect(end, "store() has no closing brace at the component's indent").toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it("the refusal branch reverts, says so, and THEN re-asks the route", () => {
    const body = storeBody(stripComments(read(CARD)));
    const at = body.indexOf("if (!r.ok) {");
    expect(at, "store() no longer has a refusal branch").toBeGreaterThan(-1);
    const refusal = body.slice(at, body.indexOf("\n    }", at));

    expect(refusal, "the refused write does not put the radio back").toMatch(/setProvider\(previous\);/);
    expect(
      refusal,
      "the refused write never re-asks the route, so the block keeps the reason it was given at mount (U-1)",
    ).toMatch(/await refreshStatus\(\);/);
    // Order: revert → say it → re-ask → return. The re-ask must not come
    // before the revert (the card would paint the old pick over a fresh
    // answer) and must not come after `return` (dead code).
    expect(refusal, "the re-ask does not follow the revert and the toast").toMatch(
      // `[ \t]*` before each break: `stripComments` leaves the trailing space
      // where a `//` comment stood, and blank lines where a block of them did.
      /setProvider\(previous\);[ \t]*\r?\n\s*toast\.error\(r\.message \?\? "Could not switch the feed\."\);[ \t]*\r?\n\s*await refreshStatus\(\);[ \t]*\r?\n\s*return;/,
    );
  });

  it("exactly two re-asks in the card: one per write outcome, and neither before a write", () => {
    const card = stripComments(read(CARD));
    // Call sites only — the declaration reads `async function refreshStatus() {`.
    expect(
      card.match(/await refreshStatus\(\);/g)?.length ?? 0,
      "the card re-asks the route somewhere other than the two outcomes of its one write",
    ).toBe(2);
    // Both of them are inside store(), after its POST.
    const body = storeBody(card);
    expect(body.match(/await refreshStatus\(\);/g)?.length ?? 0).toBe(2);
    expect(
      body.indexOf("await refreshStatus();"),
      "a re-ask sits before the write it is supposed to describe (U-1)",
    ).toBeGreaterThan(body.indexOf('const r = await post({ action: "provider", provider: next });'));
  });
});
