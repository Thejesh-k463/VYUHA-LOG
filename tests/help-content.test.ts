import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ENTRIES, searchHelp } from "@/lib/domain/help-content";
import { OPENALGO_FEED_ENABLED } from "@/lib/quotes/types";
import { SHIPPED_PROVIDER_IDS, allProviderCapabilities } from "@/lib/quotes/registry";
import { CONNECTABLE_PROVIDER_IDS } from "@/lib/live/connect-prompt";
import { NAV_ITEMS } from "@/components/layout/nav-config";

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

  it("/live names all three sources, and says the third is opt-in and on-screen only", () => {
    // The one place the flag is still read: help may name the bridge as a
    // price source only while the release actually offers it. If v4.1 were
    // rolled back, this is the case that says the help desk went with it.
    expect(OPENALGO_FEED_ENABLED, "help names a feed the release does not offer").toBe(true);
    const text = [HELP_ENTRIES.find((e) => e.href === "/live")!.answers, body("/live")].join(" ");
    expect(text).toMatch(/end-of-day bhavcopy/i);
    expect(text).toMatch(/a mark you type/i);
    expect(text).toMatch(/openalgo/i);
    // The three properties that make naming it honest: it is chosen, it is
    // gated on the disclosure, and it writes no tick (lib/quotes/persist-mark.ts).
    expect(text).toMatch(/opt-in/i);
    expect(text).toMatch(/disclosure/i);
    expect(text).toMatch(/refresh on screen only/i);
    // …and the loopback default, so "prices from a broker" never reads as an
    // upload (lib/domain/openalgo-disclosure.ts OPENALGO_DEFAULT_HOST).
    expect(text).toMatch(/127\.0\.0\.1/);
  });

  it("/settings names all THREE sources too, with the conditions in the bridge's own sentence", () => {
    // CHANGELOG and VYUHA-STATE both said "Help for /live and for Settings
    // names the three sources"; the Settings entry named only the bridge, so
    // the claim was true of one screen out of two. The conditions have to sit
    // in the SAME sentence as the bridge — a reader who stops at the first full
    // stop must not have read a price claim with no consent attached to it.
    const text = body("/settings");
    expect(text).toMatch(/end-of-day bhavcopy/i);
    expect(text).toMatch(/a mark you type/i);
    expect(text).toMatch(/openalgo/i);

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
    expect(text, "equities only in this release").toMatch(/futures and options rows keep the mark already stored/i);
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
    expect(text, "the tiers are not stated").toMatch(
      /3 seconds up to 50 open positions, 5 seconds from 51 to 200, 10 seconds from 201 to 500/,
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

  it("says the daily sign-in is Vyuha's to do, on BOTH surfaces", () => {
    for (const href of ["/live", "/settings"]) {
      const text = body(href);
      expect(text, `${href} does not say the session is cleared daily`).toMatch(
        /clears every API session at 5 AM IST/,
      );
      expect(text, `${href} does not say who signs in`).toMatch(/Vyuha opens the next one/);
      expect(text, `${href} does not say the user is not asked`).toMatch(/without asking you|nothing to click/i);
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
