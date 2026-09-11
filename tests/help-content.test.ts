import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ENTRIES, searchHelp } from "@/lib/domain/help-content";
import { OPENALGO_FEED_ENABLED } from "@/lib/quotes/types";
import { SHIPPED_PROVIDER_IDS, allProviderCapabilities } from "@/lib/quotes/registry";
import { CONNECTABLE_PROVIDER_IDS } from "@/lib/live/connect-prompt";
import { NAV_ITEMS } from "@/components/layout/nav-config";
// READ-ONLY import (v4.3 audit round 3, D-1): the shipped catalogue, so the
// /strategies entry's free/Pro sentence is derived from `legacyFree` rather
// than typed out beside it. `lib/analytics/strategy-catalogue.ts` is another
// builder's file this wave and is not edited here.
import { CATALOGUE } from "@/lib/analytics/strategy-catalogue";
// READ-ONLY import (v4.2 fix wave, B-13): the label the Settings card renders.
// Help that describes a control by a paraphrase cannot be found by its words,
// so the two are pinned to ONE constant rather than to two strings that agree
// today. `components/settings/live-feed-card.tsx` is owned by another builder
// this wave and is not edited here.
import { FEED_BLOCKED_HEALTH, REVIEW_CONSENT_CTA, feedBlockState } from "@/components/settings/live-feed-card";

/**
 * The help desk's one hard promise: it describes the app that exists. This
 * joins the registry against the sidebar in both directions, so adding a screen
 * without help — or help for a screen that is gone — fails the build.
 */

describe("help covers the app, exactly", () => {
  it("every sidebar destination has a help entry", () => {
    const helpHrefs = new Set(HELP_ENTRIES.map((e) => e.href));
    const missing = NAV_ITEMS.filter((n) => !helpHrefs.has(n.href)).map((n) => n.href);
    expect(missing, `screens with no help entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("no help entry describes a screen that does not exist", () => {
    const navHrefs = new Set(NAV_ITEMS.map((n) => n.href));
    const ghosts = HELP_ENTRIES.filter((e) => !navHrefs.has(e.href)).map((e) => e.href);
    expect(ghosts, `help for non-existent screens: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("entries are unique per href", () => {
    const hrefs = HELP_ENTRIES.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("every entry has a one-line answer, body and keywords", () => {
    for (const e of HELP_ENTRIES) {
      expect(e.answers.length, e.href).toBeGreaterThan(10);
      expect(e.body.length, e.href).toBeGreaterThan(0);
      expect(e.keywords.length, e.href).toBeGreaterThan(0);
    }
  });

  it("keeps the house voice — no marketing superlatives", () => {
    for (const e of HELP_ENTRIES) {
      const text = [e.answers, ...e.body].join(" ").toLowerCase();
      expect(text, e.href).not.toMatch(/world[- ]class|revolutionary|best[- ]in[- ]class|amazing/);
    }
  });
});

/**
 * The help desk describes v4.0 AS SHIPPED. Three entries had drifted from the
 * code they describe, and every one of them reads as a feature the buyer does
 * not have:
 *   - /sizing-lab listed a "heat ceiling" among the write-back fields; the
 *     dialog writes five fields and that is not one of them;
 *   - /atlas described the owner's widgets as "a separate, opt-in feed", in the
 *     present tense — v4.0 has no such feed (Q-12);
 *   - /live advertised "alerts" as Pro; no alert code exists in lib/live or
 *     components/live (Telegram alerts are after v4.2 — Q18, 2026-09-06).
 */
describe("help describes the app that shipped, not the one that is planned", () => {
  const body = (href: string) => HELP_ENTRIES.find((e) => e.href === href)!.body.join(" ");

  /** The five fields, in the words the help uses for them. */
  const WRITE_BACK_PROSE: Record<string, string> = {
    riskPctPpm: "risk percentage",
    deployCapPpm: "deploy cap",
    stopMethod: "stop method",
    stopAtrLen: "ATR length",
    stopAtrMultPermille: "ATR multiple",
  };

  it("/sizing-lab names exactly the fields the write-back dialog writes", () => {
    // The dialog's own payload type is the source of truth: a sixth field added
    // there without a word here reddens this immediately.
    const dialog = fs.readFileSync(
      path.join(process.cwd(), "components/sizing/write-back-dialog.tsx"),
      "utf8",
    );
    const block = /export interface WriteBackValues \{([\s\S]*?)\n\}/.exec(dialog);
    expect(block, "WriteBackValues is no longer declared as an interface").not.toBeNull();
    const fields = [...block![1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(Object.keys(WRITE_BACK_PROSE).sort());

    const text = body("/sizing-lab");
    for (const [field, prose] of Object.entries(WRITE_BACK_PROSE)) {
      expect(text.toLowerCase(), `${field} is written but the help does not name it`).toContain(
        prose.toLowerCase(),
      );
    }
    expect(text.toLowerCase(), "the write-back does not touch the heat ceiling").not.toContain("heat ceiling");
  });

  it("/atlas does not describe a widget feed that does not exist", () => {
    const text = body("/atlas");
    expect(text).not.toMatch(/opt-in feed/i);
    expect(text).toContain("are not computed in Vyuha");
  });

  it("/live advertises no alerts — there is no alert code in v4.0", () => {
    expect(body("/live")).not.toMatch(/\balerts?\b/i);
  });

  /**
   * D-2, rewritten for v4.1 — the same rule as the "alerts" guard above, for
   * the feed.
   *
   * In 4.0 `OPENALGO_FEED_ENABLED` (lib/quotes/types.ts) was false and the two
   * cases below were `it.skipIf(OPENALGO_FEED_ENABLED)`: help that named a
   * broker-priced mark was help for a release that did not ship. 4.1 flips the
   * constant, which would have made both cases SKIP — a guard that stops
   * running the moment its subject becomes real. So they assert the 4.1 truth
   * instead, and neither reads the flag: the feed SHIPS, and the obligation
   * moves from "never say it" to "never say it without its consent".
   *
   * It is still a PAIRING scan, not a word ban: OpenAlgo the IMPORT path
   * shipped in v3.1 and is described on /import, /import-help and /settings.
   */
  const PRICE_CLAIM =
    /\bfeed\b|live (price|prices|quote|quotes|tick|ticks)|real[- ]?time|streaming|prices the desk|marks? (are|from)/i;

  /**
   * The consent path, in the words help is allowed to use for it. A price
   * claim about the bridge that names none of these is a claim that the desk
   * is priced by a broker with no mention that the user has to switch it on —
   * exactly what `openAlgoGate()` refuses to do (lib/quotes/openalgo.ts:161,
   * `const gate = openAlgoGate({…})` inside `readGateFromDb()`), so it would
   * also be false.
   *
   * THE BARE WORD `Settings` IS NOT CONSENT (fix wave, 2026-09-06). Every help
   * string that describes any screen names Settings sooner or later — "chosen
   * in Settings → Live feed" says WHERE the control lives, not that the user
   * had to accept anything to be offered it, and it let the /live sentence
   * pair the bridge with a price while naming no consent at all. What is left
   * is the vocabulary that actually asserts consent: opt-in, the disclosure,
   * or the user doing the switching/picking.
   */
  const CONSENT_NAMED = /opt-in|disclosure|you (?:switch|turn|pick|chose|choose)/i;

  it("every help sentence that pairs OpenAlgo or a broker with a price also names the consent path", () => {
    const strings = HELP_ENTRIES.flatMap((e) => [e.title, e.answers, ...e.body, ...(e.refusals ?? [])]);
    const paired = strings.filter((s) => /openalgo|broker(?:'s)? feed/i.test(s) && PRICE_CLAIM.test(s));
    // v4.1 SHIPS the feed, so the help desk must describe it: a scan with
    // nothing to scan would pass on a registry that never mentions it.
    expect(paired.length, "no help entry describes the feed at all").toBeGreaterThan(0);
    const naked = paired.filter((s) => !CONSENT_NAMED.test(s));
    expect(naked, `help prices the desk from a bridge without naming the consent: ${naked.join(" | ")}`).toEqual([]);
  });

  it("/live names all five sources, and says the bridge is opt-in and on-screen only", () => {
    // P-5 (fix wave 4): the title and the body said THREE while
    // lib/domain/help-content.ts had named five since v4.2 shipped the Upstox
    // and Angel One feeds. A test that checks three of five passes a help desk
    // that has silently dropped two — so all five are asserted here.
    // The one place the flag is still read: help may name the bridge as a
    // price source only while the release actually offers it. If v4.1 were
    // rolled back, this is the case that says the help desk went with it.
    expect(OPENALGO_FEED_ENABLED, "help names a feed the release does not offer").toBe(true);
    const text = [HELP_ENTRIES.find((e) => e.href === "/live")!.answers, body("/live")].join(" ");
    expect(text).toMatch(/end-of-day bhavcopy/i);
    expect(text).toMatch(/a mark you type/i);
    expect(text).toMatch(/openalgo/i);
    expect(text, "/live no longer names Upstox as a source").toMatch(/upstox/i);
    expect(text, "/live no longer names Angel One as a source").toMatch(/angel one/i);
    // The three properties that make naming it honest: it is chosen, it is
    // gated on the disclosure, and it writes no tick (lib/quotes/persist-mark.ts).
    expect(text).toMatch(/opt-in/i);
    expect(text).toMatch(/disclosure/i);
    expect(text).toMatch(/refresh on screen only/i);
    // …and the loopback default, so "prices from a broker" never reads as an
    // upload (lib/domain/openalgo-disclosure.ts OPENALGO_DEFAULT_HOST).
    expect(text).toMatch(/127\.0\.0\.1/);
  });

  it("/settings names all FIVE sources too, with the conditions in the bridge's own sentence", () => {
    // CHANGELOG and VYUHA-STATE both said "Help for /live and for Settings
    // names the three sources"; the Settings entry named only the bridge, so
    // the claim was true of one screen out of two. The conditions have to sit
    // in the SAME sentence as the bridge — a reader who stops at the first full
    // stop must not have read a price claim with no consent attached to it.
    // P-5: five since v4.2, and the title said three until fix wave 4.
    const text = body("/settings");
    expect(text).toMatch(/end-of-day bhavcopy/i);
    expect(text).toMatch(/a mark you type/i);
    expect(text).toMatch(/openalgo/i);
    expect(text, "/settings no longer names Upstox as a source").toMatch(/upstox/i);
    expect(text, "/settings no longer names Angel One as a source").toMatch(/angel one/i);
    // The count is stated in prose too, so it must be the count of the list.
    expect(text, "/settings states a source count that is not five").toMatch(/one of its five sources/);

    const bridgeSentence = text
      .split(/(?<=[.!?])\s+/)
      .find((s) => /openalgo bridge/i.test(s) && /price/i.test(s));
    expect(bridgeSentence, "no /settings sentence pairs the bridge with pricing the desk").toBeDefined();
    expect(bridgeSentence!).toMatch(/opt-in/i);
    expect(bridgeSentence!).toMatch(/disclosure/i);
    expect(bridgeSentence!).toMatch(/127\.0\.0\.1/);
  });

  it("the pairing scan really can fire, and spares the shipped v3.1 import sentences", () => {
    expect(PRICE_CLAIM.test("or an OpenAlgo feed — is chosen in Settings"), "the sentence D-2 removed").toBe(true);
    expect(PRICE_CLAIM.test("Live prices through OpenAlgo"), "a price claim").toBe(true);
    expect(
      PRICE_CLAIM.test("A fifth path — OpenAlgo — gives Groww, Upstox and Kotak a same-day pull"),
      "the v3.1 IMPORT sentence on /import, which stays",
    ).toBe(false);
  });
});

/**
 * v4.2 — THE FOURTH PRICE SOURCE, AND THE CREDENTIAL IT SHARES.
 *
 * Upstox prices the Live Desk from the Analytics token the trade import
 * already uses. Two things follow, and both are things help either says or
 * gets wrong silently:
 *
 *   1. THE HOST AND THE SHAPE OF THE REQUEST. `api.upstox.com`, the open
 *      positions of the SELECTED account, capped, at the same clamped
 *      interval as the bridge — the same facts `docs/client/PRIVACY.md`
 *      item 3 discloses. Help that describes a broker-priced desk without
 *      them describes a different feature.
 *   2. ONE TOKEN, TWO JOBS. Regenerating it at Upstox revokes the old one,
 *      so the import and the desk source stop in the same moment. A user who
 *      has not been told that reads one cause as two faults, and the two
 *      screens that could have told them are the Live Desk's help and
 *      Settings'.
 *
 * The equities-only line is here for the same reason as every other refusal in
 * this registry: what the release does NOT do is part of the description.
 */
describe("help describes the v4.2 Upstox price source (D)", () => {
  const body = (href: string) => HELP_ENTRIES.find((e) => e.href === href)!.body.join(" ");

  it("/live names Upstox as a source, with the host, the cap and the cadence", () => {
    const text = body("/live");
    expect(text, "the fourth source is not described at all").toMatch(/\bUpstox\b/);
    expect(text, "the host the poll actually reaches").toContain("api.upstox.com");
    expect(text, "the cap on the keys sent").toMatch(/at most 500 of them/);
    expect(text, "the interval, clamped the same way as the bridge").toMatch(/every 1 to 5 seconds/);
    expect(text, "what the poll does NOT carry").toMatch(/no quantity, no entry price, no P&L, no account/);
    // v4.2 fix wave, B-5. "keep the mark already stored" was false: no writer
    // in this tree produces the contract-keyed mark a derivative row reads, so
    // the row falls back to the position's recorded close (or its entry price)
    // under an "End of day" pill. The literal is shared with the consent sheets
    // and the Settings card, byte for byte.
    // C-11 (owner ruling, 2026-09-07): the second half of the fallback is a
    // DASH. The row prints "—" when it has no close; an entry price is the
    // trader's own cost and was never what that row shows.
    expect(text, "equities only in this release").toContain(
      "Futures and options rows are not priced by this feed: each shows the position's recorded close, or a dash when no close is recorded, and says so on the row.",
    );
    expect(text, "help still offers the entry price as the fallback").not.toContain("its entry price");
    expect(text, "the prices are not sent on anywhere").toMatch(/never uploaded, never resold/);
  });

  it("/live says the source is opt-in and reuses the saved token rather than a new credential", () => {
    const sentence = body("/live")
      .split(/(?<=[.!?])\s+/)
      .find((s) => /\bUpstox is the fourth source\b/.test(s));
    expect(sentence, "no /live sentence introduces Upstox as a source").toBeDefined();
    expect(sentence!, "consent is not named in the same sentence as the source").toMatch(/opt-in/i);
    expect(sentence!).toMatch(/Settings → Live feed/);
    expect(sentence!, "the token it reuses").toMatch(/Analytics token/);
  });

  it("both /live and /settings say that regenerating the token breaks the import AND the source", () => {
    // The whole point of saying it: one action, two consequences, one
    // afternoon. Neither screen may state the reuse and omit the revocation.
    for (const href of ["/live", "/settings"]) {
      const text = body(href);
      expect(text, `${href} does not say the token is reused`).toMatch(/reuses (that|the Analytics) token/i);
      // Not `[^.]*` between the two halves: the sentence names
      // `account.upstox.com`, whose dots would end the class — the shape of
      // this claim is a verb and a consequence, so both are asserted.
      expect(text, `${href} does not say a regeneration revokes the old token`).toMatch(
        /Regenerating (it|the Analytics token)\b/i,
      );
      expect(text, `${href} does not say what the regeneration does to the old token`).toMatch(
        /revokes the old one/i,
      );
      expect(text, `${href} does not say both stop together`).toMatch(
        /at the same moment|breaks the trade import and the Live Desk source/i,
      );
    }
  });

  it("/settings says where the token is generated — in the user's own browser, at Upstox", () => {
    const text = body("/settings");
    expect(text).toContain("account.upstox.com → Apps → Analytics");
    expect(text, "the generation step is the user's, in their own browser").toMatch(/in your own browser/i);
    // The privacy bullet names the QUOTE host only; the account screen is a
    // help-only fact (owner ruling, v4.2) and must not leak into it.
    expect(text, "/settings must not claim the app talks to the account screen").not.toMatch(
      /Vyuha (asks|calls|contacts) account\.upstox\.com/i,
    );
  });

  it("the close-of-session mark no longer says holidays are unmodelled — v4.2 knows them", () => {
    const text = body("/live");
    expect(text, "help still says exchange holidays are not modelled").not.toMatch(
      /exchange holidays are not modelled/i,
    );
    expect(text, "help does not say the holiday is a day the mark is refused").toMatch(
      /At the weekend or on an exchange holiday nothing is written/,
    );
  });

  it("the new sentences carry none of the prescriptive vocabulary (SEBI copy rule)", () => {
    // The same list `tests/live-feed-copy.test.ts` holds the Settings card to.
    //
    // SCOPED TO THE SENTENCES THAT NAME UPSTOX, deliberately. Run over the
    // whole registry it reports three sentences that are the OPPOSITE of
    // prescriptive — "names no trade to take", "not filing advice", "no
    // invented session" — i.e. the ban's own vocabulary used to refuse. A
    // whole-registry form would therefore have to be loosened until it caught
    // nothing, which is the failure mode this wave is trying to avoid; the
    // sentences this wave adds are held to the strict form instead.
    const BANNED =
      /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed)\b/i;
    const strings = HELP_ENTRIES.flatMap((e) => [e.answers, ...e.body, ...(e.refusals ?? [])]).filter((s) =>
      /upstox/i.test(s),
    );
    expect(strings.length, "no help sentence names Upstox — the scan has nothing to read").toBeGreaterThan(2);
    const offenders = strings.filter((s) => BANNED.test(s)).map((s) => s.slice(0, 100));
    expect(offenders, `prescriptive vocabulary in the Upstox copy:\n${offenders.join("\n")}`).toEqual([]);
    // …and the scan can fire, on a sentence shaped exactly like the ones above.
    expect(BANNED.test("You should pick the Upstox source for a faster mark."), "the scan is dead").toBe(true);
    // The word this product never prints, on any surface (owner ruling).
    for (const s of strings) expect(s, "the Upstox copy names an alert").not.toMatch(/\balerts?\b/i);
  });
});

/**
 * Keyword drift guard (v3.8 Wave 3). The command palette used to carry its
 * own hand-written keyword map, which duplicated this registry and drifted
 * from it (27 entries against 43, several stale). Palette keywords are now
 * DERIVED from HELP_ENTRIES by href — so every sidebar destination needs a
 * help entry with at least one keyword, and the palette may not grow a
 * second map.
 */
/**
 * v4.2 — THE FIFTH PRICE SOURCE, AND THE CREDENTIAL IT SHARES.
 *
 * Angel One prices the Live Desk from the client code, PIN and TOTP secret the
 * SmartAPI trade pull already uses. Three things follow, and help either says
 * them or gets them wrong silently:
 *
 *   1. THE HOST AND THE SHAPE OF THE REQUEST. `apiconnect.angelone.in` — the
 *      host the trade pull ALREADY uses, so no new one is added — the open
 *      positions of the SELECTED account, capped, in batches of 50 at about a
 *      request a second. The same facts `docs/client/PRIVACY.md` item 3
 *      discloses.
 *   2. THE SIGN-IN IS PERFORMED BY THE APP. Angel One clears every session at
 *      5 AM IST and Vyuha opens the next one itself. "Signs in for you" is a
 *      sentence a reader is entitled to see stated rather than discover.
 *   3. THE INTERVAL IS NOT A SETTING. It is tiered on the size of the book, so
 *      help that described "the interval you set" would send the reader looking
 *      for a slider that is deliberately not there.
 *
 * And the same negative the Upstox block carries: the TOTP secret's ORIGIN is
 * Import Help's Angel One card, and /live points at it rather than teaching it
 * twice.
 */
describe("help describes the v4.2 Angel One price source", () => {
  const body = (href: string) => HELP_ENTRIES.find((e) => e.href === href)!.body.join(" ");

  it("/live names Angel One as a source, with the host, the cap and the batching", () => {
    const text = body("/live");
    expect(text, "the fifth source is not described at all").toMatch(/\bAngel One\b/);
    expect(text, "the host the poll actually reaches").toContain("apiconnect.angelone.in");
    expect(text, "the fact that it is not a new host").toMatch(/no new host is added/);
    expect(text, "the cap on the keys sent").toMatch(/at most 500 of them/);
    expect(text, "the batching and the rate").toMatch(/batches of 50 symbols at about one request a second/);
    expect(text, "what the poll leaves out").toMatch(/no quantity, no entry price, no P&L, no account/);
  });

  it("/live introduces it as opt-in, in the same sentence that calls it a source", () => {
    const sentence = body("/live")
      .split(/(?<=[.!?])\s+/)
      .find((s) => /\bAngel One is the fifth source\b/.test(s));
    expect(sentence, "no /live sentence introduces Angel One as a source").toBeDefined();
    expect(sentence!, "consent is not named in the same sentence as the source").toMatch(/opt-in/i);
    expect(sentence!).toMatch(/Settings → Live feed/);
  });

  it("/live states the tiers, and never promises an interval the user can set", () => {
    const text = body("/live");
    // v4.2 fix wave, B-6. The tiers count DEDUPED SCRIPS, not positions —
    // `angelOneCadenceSeconds()` is fed the distinct instrument keys, so two
    // positions in one symbol are one price to ask for. Help said "open
    // positions", which over-states the interval for any book that doubles up.
    expect(text, "the tiers are not stated").toMatch(
      /3 seconds up to 50 scrips, 5 seconds from 51 to 200, 10 seconds from 201 to 500/,
    );
    expect(text, "the tiers no longer say what they count").toMatch(/distinct scrips/i);
    const angelTierSentence = text
      .split(/(?<=[.!?])\s+/)
      .find((s) => /3 seconds up to 50/.test(s));
    expect(angelTierSentence, "no sentence states the tiers").toBeDefined();
    expect(angelTierSentence!, "the tier line still counts positions").not.toMatch(
      /up to 50 open positions/,
    );
    // Scoped to the sentences that name Angel One, because the bridge and
    // Upstox really do have a 1–5 s slider and must go on saying so.
    const angel = text.split(/(?<=[.!?])\s+/).filter((s) => /angel one/i.test(s));
    expect(angel.length, "no /live sentence names Angel One").toBeGreaterThan(0);
    for (const s of angel) {
      expect(s, `an Angel One sentence promises an interval the user sets: ${s}`).not.toMatch(
        /interval you set|1 to 5 seconds/i,
      );
    }
  });

  it("says the unattended sign-in is Vyuha's to do, on BOTH surfaces", () => {
    for (const href of ["/live", "/settings"]) {
      const text = body(href);
      expect(text, `${href} does not say who signs in`).toMatch(/Vyuha opens each API session/);
      expect(text, `${href} does not say the user is not asked`).toMatch(/without asking you|nothing to click/i);
      // C-2 + C-3 (owner rulings, 2026-09-07). "each morning" was the calendar
      // promise B-7 removed from the sheet, in softer words: a machine left
      // shut opens no session that morning, and one relaunched at noon opens
      // one then. Help states the same five triggers the sheet does — the
      // fifth added by owner ruling D-1 (2026-09-08), because
      // `liveFeedInstanceKey()` in lib/quotes/registry.ts keys the adapter
      // instance on the selected account (invariant 8), so switching account
      // rebuilds it and signs in again on the next poll.
      for (const trigger of [
        "at most once a day while Vyuha stays open",
        "again after a relaunch",
        "after Angel One's 5 AM IST session flush",
        "when you re-save the credentials",
        "and again when you switch the selected account, including to or from All accounts",
      ]) {
        expect(text, `${href} does not name the trigger: ${trigger}`).toContain(trigger);
      }
      expect(text, `${href} still promises a sign-in on a calendar schedule`).not.toMatch(/each morning/i);
      // D-1 (owner ruling, 2026-09-08 round 5): the refused-sign-in ceiling
      // names the RELAUNCH too. `consecutiveLoginFailures` is an instance local
      // of the Angel One adapter, so a relaunch clears it exactly as a re-save
      // does — which is what the session-invalid ceiling below already said.
      expect(text, `${href} does not state the refused-sign-in ceiling`).toContain(
        "If a sign-in is refused, Vyuha tries at most three times and then stops until you re-save the credentials or relaunch Vyuha.",
      );
      // C-1 (owner ruling, round 4): the SECOND ceiling. A login that was
      // accepted and later reported invalid is a different failure, and help
      // that names only the first under-states what is sent.
      expect(text, `${href} does not state the session-invalid ceiling`).toContain(
        "If Angel One reports an accepted session invalid, Vyuha signs in at most three times in a row without a priced answer in between, and then stops until you re-save the credentials or relaunch Vyuha.",
      );
      // C-4: the SECRET is not what travels — a one-time code derived from it is.
      expect(text, `${href} implies the TOTP secret itself is sent`).toMatch(
        /one-time code it derives from that (TOTP )?secret/,
      );
    }
  });

  it("/live POINTS at where the TOTP secret comes from instead of teaching it again", () => {
    // The enrollment step lives on Import Help's Angel One card
    // (lib/domain/import-help-content.ts). Two cards teaching one enrollment is
    // how they drift; the /live entry references it and stops.
    const text = body("/live");
    expect(text, "/live does not point at the import help card").toMatch(/Import Help/);
    expect(text, "/live re-teaches the enrollment instead of pointing at it").not.toMatch(
      /smartapi\.angelone\.in|behind the enrollment QR/i,
    );
  });

  it("the Angel One copy is descriptive, never prescriptive, and names no alert", () => {
    const BANNED =
      /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed)\b/i;
    const strings = HELP_ENTRIES.flatMap((e) => [e.answers, ...e.body, ...(e.refusals ?? [])]).filter((s) =>
      /angel one/i.test(s),
    );
    expect(strings.length, "no help sentence names Angel One — the scan has nothing to read").toBeGreaterThan(2);
    const offenders = strings.filter((s) => BANNED.test(s)).map((s) => s.slice(0, 100));
    expect(offenders, `prescriptive vocabulary in the Angel One copy:\n${offenders.join("\n")}`).toEqual([]);
    expect(BANNED.test("You should pick the Angel One source for a faster mark."), "the scan is dead").toBe(true);
    for (const s of strings) expect(s, "the Angel One copy names an alert").not.toMatch(/\balerts?\b/i);
  });
});

/**
 * v4.2 fix wave, B-13 — THE BLOCKED FEED IS A STATE THE PRODUCT HAS AND NO
 * WRITTEN SURFACE HAD.
 *
 * `feedBlockState()` fires whenever the STORED pick and the EFFECTIVE provider
 * disagree — which is what a re-versioned disclosure or a backup restored on a
 * machine that never accepted one produces. The card then prints
 * `FEED_BLOCKED_HEALTH` and offers `REVIEW_CONSENT_CTA`. Until this wave, help,
 * `docs/client/PRIVACY.md` and the client README described none of it: a user
 * whose desk silently fell back to end-of-day prices had nothing to read.
 *
 * The CTA is asserted against the CARD'S OWN CONSTANT, not against a copy of
 * its text. Two strings that agree today are how help ends up naming a button
 * that has since been relabelled — and a control described by a paraphrase
 * cannot be found by searching for its words.
 */
describe("help names the blocked-feed state and the control that clears it", () => {
  const settings = HELP_ENTRIES.find((e) => e.href === "/settings")!;

  const blockedSentence = () =>
    settings.body
      .flatMap((b) => b.split(/(?<=[.!?])\s+/))
      .find((s) => /feed is blocked|feed you picked can no longer run/i.test(s));

  it("Settings help says the feed can be blocked, and names the exact control", () => {
    const sentence = blockedSentence();
    expect(sentence, "no Settings help sentence describes the blocked feed").toBeDefined();
    expect(sentence!, "help does not name the control the card renders").toContain(REVIEW_CONSENT_CTA);
    expect(REVIEW_CONSENT_CTA, "the card's label moved without help moving with it").toBe(
      "Review and accept",
    );
  });

  it("…and says the two things that cause it", () => {
    const sentence = blockedSentence()!;
    expect(sentence, "help does not name the re-versioned disclosure").toMatch(
      /disclosure changed since you accepted it/i,
    );
    expect(sentence, "help does not name the restored backup").toMatch(
      /backup was restored on a machine that never accepted it/i,
    );
    expect(sentence, "help does not say consent is asked for again").toMatch(/consent is asked for again/i);
  });

  /**
   * C-5 (owner ruling, 2026-09-07) — "Review and accept" IS NOT OFFERED FOR
   * EVERY BLOCKED FEED.
   *
   * `feedBlockState()` returns `reviewProvider: null` for OpenAlgo, whose
   * consent lives on the Integrations screen: its block renders as TEXT ONLY.
   * Help and the client README promised the button for every block, which sends
   * an OpenAlgo user looking for a control that is deliberately not rendered.
   * The sentence now scopes the button to the two feeds whose sheets this card
   * owns and names the other route for the third.
   */
  it("scopes Review and accept to the feeds whose sheet the card can reopen", () => {
    const sentence = blockedSentence()!;
    expect(sentence, "help still promises the button for every blocked feed").toMatch(
      /for the Upstox and Angel One feeds/i,
    );
    expect(sentence, "help does not say how an OpenAlgo block is cleared").toMatch(
      /Settings → Integrations/,
    );
    // …and the card really does withhold the control for OpenAlgo, which is
    // the fact the sentence is describing. `stored !== effective` is the block.
    const block = feedBlockState({
      stored: "openalgo",
      effective: "eod",
      blockedReason: "The OpenAlgo integration is switched off.",
    } as never);
    expect(block, "an OpenAlgo pick that cannot run is no longer a block").not.toBeNull();
    expect(
      block!.reviewProvider,
      "the card now owns OpenAlgo's sheet, so help may promise the button for it again",
    ).toBeNull();
    // …while the two the card does own still get it.
    for (const id of ["upstox", "angelone"]) {
      const b = feedBlockState({ stored: id, effective: "eod", blockedReason: "blocked" } as never);
      expect(b!.reviewProvider, `${id} no longer reaches its sheet from the card`).toBe(id);
    }
  });

  it("…and describes the same fallback the card's health line states", () => {
    const sentence = blockedSentence()!.toLowerCase();
    for (const word of ["blocked", "end-of-day prices"]) {
      expect(FEED_BLOCKED_HEALTH.toLowerCase(), `the card's health line no longer says "${word}"`).toContain(
        word,
      );
      expect(sentence, `help does not say "${word}"`).toContain(word);
    }
  });

  it("the client README carries the same state, and the same control label", () => {
    const clientReadme = fs.readFileSync(path.join(process.cwd(), "docs/client/README.md"), "utf8");
    const row = clientReadme
      .split("\n")
      .find((l) => /feed you picked/i.test(l) && /blocked/i.test(l));
    expect(row, "the client README's live-feed section never mentions a blocked feed").toBeDefined();
    expect(row!, "the client README does not name the control").toContain(REVIEW_CONSENT_CTA);
    expect(row!, "the client README does not say why the block appears").toMatch(
      /disclosure changed since you accepted it/i,
    );
    expect(row!, "the client README does not name the restored backup").toMatch(
      /backup was restored on a machine that never accepted it/i,
    );
    // C-5: the button is not offered for OpenAlgo, whose consent lives on the
    // Integrations screen — so the row scopes it and names the other route.
    expect(row!, "the client README still promises the button for every blocked feed").toMatch(
      /For the Upstox and Angel One feeds/i,
    );
    expect(row!, "the client README does not say how an OpenAlgo block is cleared").toMatch(
      /Settings → Integrations/,
    );
  });
});

describe("palette keywords derive from the help registry", () => {
  it("every NAV_ITEMS href has a help entry with at least one keyword", () => {
    const byHref = new Map(HELP_ENTRIES.map((e) => [e.href, e]));
    const bare = NAV_ITEMS.filter((n) => !(byHref.get(n.href)?.keywords.length ?? 0)).map((n) => n.href);
    expect(bare, `screens with no help keywords: ${bare.join(", ")}`).toEqual([]);
  });

  it("the palette module carries no KEYWORDS literal and reads HELP_ENTRIES", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/system/command-palette.tsx"), "utf8");
    // Both halves were hollow. `\bKEYWORDS\b` is evaded by any prefixed name
    // (`SCREEN_KEYWORDS`, `NAV_KEYWORDS`): there is no word boundary between
    // `_` and `K`. And `toContain("HELP_ENTRIES")` was satisfied by the JSDoc
    // paragraph above this describe, which names the registry in prose — the
    // palette could drop the derivation entirely and still pass. Pin the
    // DECLARATION shape and the CALL instead.
    expect(src, "a second keyword map has grown back").not.toMatch(/KEYWORDS\s*[:=]/);
    expect(src, "the palette no longer derives keywords from the registry").toContain("deriveKeywords(m.HELP_ENTRIES");
  });
});

describe("search", () => {
  it("finds screens by task words a trader would type", () => {
    expect(searchHelp(HELP_ENTRIES, "delete").map((e) => e.href)).toContain("/trades");
    expect(searchHelp(HELP_ENTRIES, "backup").map((e) => e.href)).toContain("/backup");
    expect(searchHelp(HELP_ENTRIES, "grandfathering").map((e) => e.href)).toContain("/reports/tax");
    expect(searchHelp(HELP_ENTRIES, "theta").map((e) => e.href)).toContain("/options-journal");
  });

  it("is case-insensitive", () => {
    expect(searchHelp(HELP_ENTRIES, "VAR").map((e) => e.href)).toContain("/risk");
  });

  it("an empty query returns everything", () => {
    expect(searchHelp(HELP_ENTRIES, "  ")).toHaveLength(HELP_ENTRIES.length);
  });

  it("a nonsense query returns nothing rather than everything", () => {
    expect(searchHelp(HELP_ENTRIES, "zzzznotaword")).toEqual([]);
  });
});

/**
 * A-4 — THE PRIVACY INVENTORY IS COMPLETE, NOT MERELY TRUE.
 *
 * "WHAT LEAVES THE MACHINE" listed "the Live Desk price poll to your own
 * OpenAlgo bridge or to Upstox if you chose one of them as the desk's source"
 * while a THIRD desk feed shipped in the same release — Angel One, which polls
 * apiconnect.angelone.in and signs itself in once a trading day, unattended.
 * Nothing was undisclosed (the /settings entry describes that sign-in three
 * sentences earlier); the paragraph that a reader treats as the INVENTORY was
 * two feeds out of three, which is the kind of incompleteness that reads as a
 * hidden one.
 *
 * The existing v4.2 scans could not see it: they filter for sentences matching
 * /angel one/i, and the omission was precisely a sentence that did not.
 * This one goes the other way — it derives the feeds from the REGISTRY and
 * demands the sentence name each. A fourth feed cannot ship without the
 * paragraph changing, because `NAME` below must gain an entry to stay exact.
 */
describe("the WHAT-LEAVES inventory names every feed that can leave the machine (A-4)", () => {
  const whatLeaves = (): string => {
    const s = HELP_ENTRIES.find((e) => e.href === "/settings")!.body.find((b) =>
      b.startsWith("WHAT LEAVES THE MACHINE"),
    );
    expect(s, "the /settings entry no longer carries a WHAT LEAVES THE MACHINE paragraph").toBeDefined();
    return s!;
  };

  /**
   * The desk sources that reach a host at all: SHIPPED in this release, and a
   * connection the user makes (`CONNECTABLE_PROVIDER_IDS`, lib/live/connect-prompt.ts).
   * `eod`/`manual` read what is already here; `mock` generates prices in-process.
   */
  const deskFeeds = () => {
    const caps = new Map(allProviderCapabilities().map((c) => [c.id, c]));
    return SHIPPED_PROVIDER_IDS.filter((id) => CONNECTABLE_PROVIDER_IDS.includes(id)).map((id) => caps.get(id)!);
  };

  /** What each feed is CALLED in prose. The sentence is held to these. */
  const NAME: Record<string, RegExp> = {
    openalgo: /OpenAlgo/,
    upstox: /Upstox/,
    angelone: /Angel One/,
  };

  it("the scan has real feeds to read, and each one really does reach out", () => {
    const feeds = deskFeeds();
    expect(feeds.length, "no shipped feed is a connection the user makes — the scan is dead").toBeGreaterThan(2);
    for (const c of feeds) {
      expect(c.streaming, `${c.id} is listed as a desk feed but pushes nothing`).toBe(true);
      expect(c.egressDescription.length, `${c.id} declares no egress at all`).toBeGreaterThan(0);
    }
  });

  it("the name map covers exactly the shipped feeds — a fourth one fails here first", () => {
    expect(
      Object.keys(NAME).sort(),
      "a desk feed was added or withdrawn without revisiting the WHAT-LEAVES sentence",
    ).toEqual(deskFeeds().map((c) => c.id).sort());
  });

  it("names every one of them", () => {
    const text = whatLeaves();
    for (const c of deskFeeds()) {
      expect(text, `the inventory omits the ${c.id} poll`).toMatch(NAME[c.id]);
    }
  });

  it("says out loud that Vyuha performs the daily sign-in the one feed that needs it", () => {
    // A daily session AND a remote host: the bridge also reports
    // `requiresDailyAuth`, but its egress is "None beyond your own machine",
    // and the sign-in it means is the user's own, into their own bridge.
    const daily = deskFeeds().filter((c) => c.requiresDailyAuth && !/^none/i.test(c.egressDescription));
    expect(
      daily.map((c) => c.id),
      "no shipped desk feed signs itself in to a remote host — this claim has nothing to guard",
    ).toEqual(["angelone"]);
    expect(whatLeaves(), "the inventory does not say who does the unattended sign-in").toMatch(
      /(sign-in|signs in)[^.]*Vyuha|Vyuha[^.]*(sign-in|signs in)/i,
    );
  });
});

/**
 * A-12 — THE ROW IS GREYED, NOT ABSENT.
 *
 * Three surfaces said the broker feed "appears only after" / "is offered only
 * after" the credential is saved. The Settings card renders a row for EVERY id
 * in `PROVIDERS` (components/settings/live-feed-card.tsx) whatever is saved:
 * with no connection it renders greyed, carrying "Add Upstox under
 * Import → Connect broker first." A user who has not connected goes looking for
 * a row that is on the screen in front of them, disabled.
 *
 * The correction is "greyed until" / "can be picked only once", so this bans
 * the APPEARANCE verbs and leaves the picking verbs alone.
 */
describe("no surface says the feed row appears only after a credential (A-12)", () => {
  const ABSENT_CLAIM = /\b(appears|appear|is offered|offered|shows up|is shown)\b[^.|]{0,60}?\bonly\s+(?:after|once)\b/i;

  /**
   * SCOPED TO THE PASSAGES ABOUT THE LIVE-FEED ROW, and deliberately not to
   * every sentence naming a broker. The /import entry says "A fifth path —
   * OpenAlgo — appears here only after you switch it on in Settings →
   * Integrations", which is TRUE of the Import screen: `broker-connect.tsx`
   * renders the OpenAlgo tab only when the integration is on. The falsehood
   * this bans is about the SETTINGS ROW, so the passage has to be about the
   * Live feed for its sentences to be read at all.
   */
  const ABOUT_THE_FEED_ROW = /Live feed|desk'?s source|prices? (?:the|your) (?:Live )?[Dd]esk/;

  /** Passages, then sentences inside them: a help body string, or a markdown
   *  paragraph (README's release note wraps over a dozen quoted lines). */
  const passages = (text: string) => text.split(/\n\s*\n/);

  const offendingSentences = (units: string[]) =>
    units
      .filter((u) => ABOUT_THE_FEED_ROW.test(u))
      .flatMap((u) => u.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/))
      .filter((s) => ABSENT_CLAIM.test(s));

  const SURFACES: [string, () => string[]][] = [
    [
      "lib/domain/help-content.ts",
      () => HELP_ENTRIES.flatMap((e) => [e.title, e.answers, ...e.body, ...(e.refusals ?? [])]),
    ],
    [
      "docs/client/README.md",
      () => passages(fs.readFileSync(path.join(process.cwd(), "docs/client/README.md"), "utf8")),
    ],
    ["README.md", () => passages(fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8"))],
  ];

  it("the ban fires on the wording it replaced and spares the wording that replaced it", () => {
    expect(
      ABSENT_CLAIM.test("It is opt-in exactly like the others — it appears only after you have saved your token"),
      "the ban is dead",
    ).toBe(true);
    expect(ABSENT_CLAIM.test("it is offered only after you have saved your Upstox Analytics token")).toBe(true);
    expect(ABSENT_CLAIM.test("it appears as a source only after you switch the integration on")).toBe(true);
    expect(ABSENT_CLAIM.test("its row there stays greyed until you have saved your Upstox Analytics token")).toBe(
      false,
    );
    expect(ABSENT_CLAIM.test("it can be picked only once you have accepted its disclosure")).toBe(false);
  });

  it.each(SURFACES)("%s describes the row as greyed, not missing", (rel, units) => {
    const read = units();
    expect(
      read.filter((u) => ABOUT_THE_FEED_ROW.test(u)).length,
      `${rel} has no passage about the Live feed row — the scan is reading the wrong file`,
    ).toBeGreaterThan(0);
    const offenders = offendingSentences(read).map((s) => s.slice(0, 140));
    expect(offenders, `${rel} says the row is absent until connected:\n${offenders.join("\n")}`).toEqual([]);
  });
});

/**
 * v4.3 wave 2 — THE /strategies ENTRY DESCRIBES THE WAVE-2 SCREEN.
 *
 * The old sentence said the screen "groups open legs by underlying and expiry".
 * Wave 2 groups per SYMBOL and carries expiry as a leg attribute, precisely so
 * a calendar or a diagonal stays one position instead of splitting into two —
 * a help entry still describing the old grouping would send a reader looking
 * for two cards that no longer exist. Three more facts the entry either states
 * or gets wrong silently: the catalogue is 40 shapes, the user shelf is Pro,
 * and the Options help is free.
 */
describe("help describes the v4.3 Option Strategies screen", () => {
  const strategies = () => HELP_ENTRIES.find((e) => e.href === "/strategies")!;
  const text = () => strategies().body.join(" ");

  it("no longer claims expiry is a grouping key", () => {
    expect(text(), "the entry still describes the pre-wave-2 grouping").not.toMatch(
      /by underlying and expiry/i,
    );
    expect(text(), "the per-symbol grouping is not stated").toMatch(/per underlying symbol/i);
    expect(text(), "expiry-as-a-leg-attribute is not stated").toMatch(/expiry as an attribute of each leg/i);
    expect(text(), "the reason the grouping changed is not stated").toMatch(/calendar or a diagonal stays one position/i);
    // …and the other half of the grouping rule: an unmatchable symbol falls
    // back to per-expiry sub-groups (the wave-2 ruling's "split on match
    // failure"), which the entry did not state at all.
    expect(text(), "the split-on-match-failure fallback is not stated").toMatch(/split per expiry/i);
  });

  it("names the size of the catalogue and where the write-ups live", () => {
    expect(text(), "the catalogue size is not stated").toMatch(/catalogue of 40 named shapes/i);
    expect(text(), "the Options help section is not pointed at").toMatch(/Options section of the Help Desk/i);
  });

  /**
   * v4.3 audit round 3, D-1 + D-2 — THE TIER SPLIT IS DERIVED, NOT TYPED.
   *
   * The two sentences this block used to pin BY VALUE were both false about the
   * app that shipped, and pinning them by value is precisely why they passed a
   * green gate:
   *   - "the grouping, the recognition and the payoff are free" — `withholdForFree`
   *     (components/strategies/strategy-copy.ts) renames every non-`legacyFree`
   *     match to "Custom (n legs)" server-side for a free user, so 24 of the 40
   *     names are withheld, not free;
   *   - "a shelf of your own saved shapes … named the way you name it" — no
   *     user-naming exists anywhere; the shelf is a `{v:1, selected: string[]}`
   *     SELECTION of catalogue ids.
   * The pins below read the boundary out of the catalogue itself, so moving a
   * row's `legacyFree` flag reddens the copy instead of silently outdating it.
   */
  const NUMBER_WORDS: Record<number, string> = {
    8: "eight",
    11: "eleven",
    16: "sixteen",
    24: "twenty-four",
    29: "twenty-nine",
    32: "thirty-two",
    40: "forty",
  };
  const spell = (n: number): string => {
    const w = NUMBER_WORDS[n];
    // A count with no word is a test that would quietly stop asserting.
    if (!w) throw new Error(`no number word for ${n} — extend NUMBER_WORDS in this test`);
    return w;
  };

  it("states the tier split in the catalogue's OWN counts, spelled out", () => {
    const free = CATALOGUE.filter((d) => d.legacyFree).length;
    const withheld = CATALOGUE.length - free;
    expect(free, "no row is legacyFree — the free-tier boundary moved").toBeGreaterThan(0);
    expect(withheld, "nothing is withheld — the Pro boundary moved").toBeGreaterThan(0);
    expect(
      text(),
      `${free} names stay free but the entry does not say "${spell(free)}"`,
    ).toMatch(new RegExp(`\\b${spell(free)}\\b`, "i"));
    expect(
      text(),
      `${withheld} names are withheld on the free tier but the entry does not say "${spell(withheld)}"`,
    ).toMatch(new RegExp(`\\b${spell(withheld)}\\b`, "i"));
    expect(text(), "the shelf's tier is not stated").toMatch(/The shelf is Pro/);
    expect(text(), "the Options help's tier is not stated").toMatch(/free on every tier/i);
    expect(text(), "the figures are gross — 'before charges' is not stated").toMatch(/before charges/i);
  });

  it("claims no shape-naming the app does not have", () => {
    expect(text(), "the entry still advertises user-named shapes").not.toMatch(
      /named the way you name it/i,
    );
    expect(text(), "the shelf is a pick of catalogue tiles, not saved shapes of your own").not.toMatch(
      /your own saved shapes/i,
    );
    expect(text(), "the shelf must be described as a selection of catalogue tiles").toMatch(
      /selection of catalogue tiles/i,
    );
  });

  it("never calls the recognition free in the same breath — most of the names are withheld", () => {
    // recognis|recogniz|recognit — "recognised", "recognizes" AND "recognition".
    const both = (s: string) => /recogni[szt]/i.test(s) && /\bfree\b/i.test(s);
    const offenders = text().split(/(?<=\.)\s+/).filter(both);
    expect(offenders, `the entry claims recognition is free:\n${offenders.join("\n")}`).toEqual([]);
    // The scan is not dead: this is the sentence that was there.
    expect(both("The shelf is Pro; the grouping, the recognition and the payoff are free."), "the scan is dead").toBe(true);
  });

  it("R50 — says where a Custom card's link lands, not that every card links to an entry", () => {
    expect(text(), "the entry still says EVERY card links straight to its entry").not.toMatch(
      /each card here links straight to its entry/,
    );
    expect(text()).toMatch(/A named card here links straight to its entry/);
    expect(text()).toMatch(/Custom card[^.]*top of the Options section/);
  });

  it("carries no href for an options structure — the NAV join above would fail on one", () => {
    // Options entries live in lib/domain/options-help.ts and deliberately have
    // no href; this pins that none leaked into HELP_ENTRIES as a ghost screen.
    const ghosts = HELP_ENTRIES.filter((e) => e.href.includes("#"));
    expect(ghosts.map((e) => e.href)).toEqual([]);
  });
});

/**
 * R21 (v4.3.0 fix wave 1). The /import-help entry said Upstox "value behaviour
 * is inferred until a populated export is seen" — a caveat AGENTS.md and
 * docs/BROKER_FORMATS.md discharged on 2026-09-04 (tests/golden-books.test.ts
 * pins a populated realised-P&L export against Upstox's own figures).
 */
describe("the /import-help entry states the Upstox verification as it stands (R21)", () => {
  const body = (href: string) => HELP_ENTRIES.find((e) => e.href === href)!.body.join(" ");

  it("no longer says value behaviour is inferred, and says what is verified and what is our arithmetic", () => {
    const text = body("/import-help");
    expect(text, "the discharged Upstox caveat is still printed").not.toMatch(/inferred until/);
    expect(text).toMatch(/value behaviour is verified for the realised-P&L export/);
    expect(text).toMatch(/pinned against Vyuha's own arithmetic for the trade report/);
  });
});
