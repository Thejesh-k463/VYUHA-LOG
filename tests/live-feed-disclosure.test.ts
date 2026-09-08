import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANGELONE_FEED_ITEMS,
  LIVE_FEED_DISCLOSURE_IDS,
  LIVE_FEED_DISCLOSURE_VERSIONS,
  UPSTOX_FEED_ITEMS,
  isFeedAckCurrent,
  parseFeedAcks,
  withFeedAck,
} from "@/lib/domain/live-feed-disclosure";
import { OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { UPSTOX_CAPABILITIES } from "@/lib/quotes/upstox";
import { ANGELONE_CAPABILITIES } from "@/lib/quotes/angelone";

/**
 * THE BROKER FEED DISCLOSURE (v4.2) — the sentences the dialog renders and the
 * three rules the stored acknowledgement obeys.
 *
 * Two properties this file exists to defend:
 *   1. an unreadable or older acknowledgement is NO acknowledgement (strict
 *      `===`), because the gate that opens a feed reads nothing else;
 *   2. the sheet names api.upstox.com and no other host — the sheet and the
 *      capability block are two statements of one fact and must not drift.
 */

/**
 * B-5 (v4.2 fix wave, owner ruling B-7 sheet). The derivative sentence, byte
 * for byte, on BOTH sheets and on the Settings card.
 *
 * The sentence it replaces ("Futures and options rows keep their last stored
 * mark") was FALSE from 8ae5dea: a derivative reads only a contract-keyed mark
 * that no writer in this tree produces, so the row falls back to the position's
 * recorded close — or, when no close was ever recorded, to a DASH — under an
 * "End of day" pill labelled "Not priced by this feed". One literal, shared
 * by every surface, is what stops the two halves drifting into two promises;
 * `tests/seams-v42-fix.test.ts` compares this sheet with the card byte for byte.
 *
 * C-11 (owner ruling, 2026-09-07: "or a dash"). The fallback named "its entry
 * price" for a row that never shows one: an unmarked derivative row prints a
 * dash, and an entry price is not a mark at all — quoting it as the fallback
 * invites a reader to treat the position's own cost as a price the market
 * agreed to. `ENTRY_PRICE_BANNED` below is what keeps the correction from
 * surviving in one file only.
 */
const NOT_PRICED_SENTENCE =
  "Futures and options rows are not priced by this feed: each shows the position's recorded close, or a dash when no close is recorded, and says so on the row.";

/**
 * B-7 (owner ruling: reword), C-2 (owner ruling, 2026-09-07: name every
 * trigger) and D-1 (owner ruling, 2026-09-08: name the FIFTH one). The sign-in
 * sentence, byte for byte.
 *
 * "once each trading day" was true PER PROCESS and nowhere else: the session
 * lives in the adapter instance, so a relaunch or a credential re-save opens
 * another one the same day, and a machine left closed all day opens none. The
 * replacement states the mechanism instead of the calendar — and states every
 * one of the things that open a session, the 5 AM IST flush included, because
 * a short list reads as an exhaustive one.
 *
 * THE SOURCE OF TRUTH FOR THAT LIST IS `liveFeedInstanceKey()` in
 * lib/quotes/registry.ts — the memo key the adapter instance is built against.
 * Anything in that key that a user can change is a sign-in trigger, and the
 * SELECTED ACCOUNT is one of its fields (invariant 8: the connection row this
 * feed reads is the selected account's own, and id 0 is the aggregate view).
 * The function is module-private, so the list below is a literal; if it ever
 * becomes exported, derive this from it instead of restating it.
 */
const ANGEL_SIGNIN_SENTENCE =
  "Vyuha signs in to apiconnect.angelone.in at most once a day while Vyuha stays open, again after a relaunch, after Angel One's 5 AM IST session flush, or when you re-save the credentials, and again when you switch the selected account, including to or from All accounts.";

/** D-1. The fifth trigger's own clause, as every surface must word it. */
const ACCOUNT_SWITCH_TRIGGER =
  "and again when you switch the selected account, including to or from All accounts";

/**
 * C-2. The refused-login ceiling, byte for byte. Before it, a wrong PIN was one
 * refusal PER POLL against the broker's own auth endpoint.
 *
 * D-1 (owner ruling, 2026-09-08 round 5): it names the RELAUNCH too. The
 * counter is an instance local of the adapter (`lib/quotes/angelone.ts`), so a
 * relaunch clears it exactly as a re-save does — and the sibling ceiling two
 * sentences later already said so. A clause that names only the re-save tells a
 * capped user the one thing they must do is the one thing they need not do.
 */
const ANGEL_RETRY_SENTENCE =
  "If a sign-in is refused, Vyuha tries at most three times and then stops until you re-save the credentials or relaunch Vyuha.";

/**
 * C-1 (owner ruling, round 4). The SECOND ceiling, byte for byte, and a
 * different failure from the one above: the login was ACCEPTED and the broker
 * later answers AG8001/401 on the quote call. Before it, that nulled the jwt
 * and the next poll signed in again with no ceiling at all — credentials at
 * poll cadence, 1,200 an hour at the 3-second tier. A priced answer resets the
 * count; the 05:00 IST flush re-login never counts toward it.
 */
const ANGEL_SESSION_INVALID_SENTENCE =
  "If Angel One reports an accepted session invalid, Vyuha signs in at most three times in a row without a priced answer in between, and then stops until you re-save the credentials or relaunch Vyuha.";

describe("the stored acknowledgement", () => {
  it("reads a provider-id → version map out of the column", () => {
    expect(parseFeedAcks('{"upstox":"1"}')).toEqual({ upstox: "1" });
    expect(parseFeedAcks('{"upstox":"1","angelone":"1"}')).toEqual({ upstox: "1", angelone: "1" });
  });

  it("treats anything it cannot read as NO consent rather than throwing", () => {
    for (const bad of [null, undefined, "", "   ", "not json", "[]", '"1"', "42", '{"upstox":true}', '{"upstox":1}']) {
      expect(parseFeedAcks(bad as string | null), String(bad)).toEqual({});
      expect(isFeedAckCurrent(bad as string | null, "upstox"), String(bad)).toBe(false);
    }
  });

  it("compares with strict === : '1' passes, '0' and an absent key do not", () => {
    expect(LIVE_FEED_DISCLOSURE_VERSIONS.upstox).toBe("1");
    expect(isFeedAckCurrent('{"upstox":"1"}', "upstox")).toBe(true);
    expect(isFeedAckCurrent('{"upstox":"0"}', "upstox")).toBe(false);
    expect(isFeedAckCurrent('{"upstox":"2"}', "upstox")).toBe(false);
    expect(isFeedAckCurrent('{"angelone":"1"}', "upstox"), "one broker's consent is not another's").toBe(false);
    expect(isFeedAckCurrent(null, "upstox")).toBe(false);
  });

  it("merges an acceptance instead of withdrawing the other provider's", () => {
    expect(withFeedAck(null, "upstox")).toBe('{"upstox":"1"}');
    const both = withFeedAck('{"angelone":"1"}', "upstox");
    expect(parseFeedAcks(both)).toEqual({ angelone: "1", upstox: "1" });
    expect(isFeedAckCurrent(both, "upstox")).toBe(true);
    expect(isFeedAckCurrent(both, "angelone")).toBe(true);
    // Writing over garbage yields a readable column, not preserved garbage.
    expect(parseFeedAcks(withFeedAck("not json", "upstox"))).toEqual({ upstox: "1" });
  });

  it("versions every id it knows, so no provider can be acknowledged as a boolean", () => {
    expect([...LIVE_FEED_DISCLOSURE_IDS].sort()).toEqual(["angelone", "upstox"]);
    for (const id of LIVE_FEED_DISCLOSURE_IDS) {
      expect(typeof LIVE_FEED_DISCLOSURE_VERSIONS[id]).toBe("string");
      expect(isFeedAckCurrent(withFeedAck(null, id), id)).toBe(true);
    }
  });
});

describe("the Upstox consent sheet", () => {
  it("carries the five statements the ruling requires, in the dialog's shape", () => {
    expect(UPSTOX_FEED_ITEMS).toHaveLength(5);
    for (const item of UPSTOX_FEED_ITEMS) {
      expect(typeof item.title).toBe("string");
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.body.length).toBeGreaterThan(40);
      expect(item.body.trim().endsWith("."), item.title).toBe(true);
    }
    // Same shape as the sheet the dialog already renders for OpenAlgo.
    expect(Object.keys(UPSTOX_FEED_ITEMS[0]).sort()).toEqual(Object.keys(OPENALGO_FEED_ITEMS[0]).sort());
  });

  const flat = UPSTOX_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ");

  it("states the host, the cadence, the token and the equity-only limit", () => {
    expect(flat).toContain("api.upstox.com");
    expect(flat).toContain("every 1 to 5 seconds while the Live Desk is open");
    expect(flat).toContain("Analytics token you saved under Import → Connect broker");
    expect(flat).toContain("read-only");
    expect(flat).toContain("cannot place, change or cancel an order");
    expect(flat).toContain("Only equity positions are priced by this feed in this release");
    expect(flat).toContain(NOT_PRICED_SENTENCE);
    expect(flat).toContain("never uploads them");
    expect(flat).toContain("never resells market data");
  });

  it("says a poll is not a tick stream, and that a price can be an interval old", () => {
    expect(flat).toMatch(/instead of receiving a live stream of ticks/);
    expect(flat).toMatch(/up to one interval old/);
    expect(flat).toMatch(/labelled delayed/);
    // …and the capability block says the same thing in machine terms.
    expect(UPSTOX_CAPABILITIES.staleness).toBe("delayed");
  });

  it("names ONE host, and it is the one the adapter can reach", () => {
    const hosts = new Set(flat.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)?.map((h) => h.toLowerCase()) ?? []);
    expect([...hosts]).toEqual(["api.upstox.com"]);
    // assets.upstox.com, the login host and the docs host are all absent by
    // construction; the sheet and the capability block state one host each.
    expect(UPSTOX_CAPABILITIES.egressDescription).toContain("api.upstox.com");
  });

  it("keeps the SEBI-safe voice: no recommendation, no advice, no order verbs", () => {
    for (const banned of [
      /\brecommend/i,
      /\bsuggest/i,
      /\bshould\b/i,
      /\badvice\b|\badvise\b/i,
      /\bbuy\b/i,
      /\bsell\b/i,
      /\bprofit\b/i,
      /\bguarantee/i,
    ]) {
      expect(flat, `banned ${banned}`).not.toMatch(banned);
    }
  });
});

describe("the Angel One consent sheet", () => {
  /**
   * The sheet that has to say the hard thing. Upstox could offer a read-only
   * token; Angel One offers nothing of the kind, so the disclosure is not
   * "your credentials are safe" but "the same session could place an order,
   * and here is the mechanical reason ours never will".
   */
  it("carries the seven statements the ruling requires, in the dialog's shape", () => {
    expect(ANGELONE_FEED_ITEMS).toHaveLength(7);
    for (const item of ANGELONE_FEED_ITEMS) {
      expect(typeof item.title).toBe("string");
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.body.length).toBeGreaterThan(40);
      expect(item.body.trim().endsWith("."), item.title).toBe(true);
    }
    // Same shape as every other sheet the dialog renders.
    expect(Object.keys(ANGELONE_FEED_ITEMS[0]).sort()).toEqual(Object.keys(OPENALGO_FEED_ITEMS[0]).sort());
  });

  const flat = ANGELONE_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ");

  it("states the sign-in as the process rule it is, with all five triggers named", () => {
    expect(flat).toContain(ANGEL_SIGNIN_SENTENCE);
    expect(flat).toContain("what you saved under Import → Connect broker");
    // The five things the old sentence promised or omitted: a relaunch, a
    // credential re-save, the 5 AM IST flush and an account switch each open
    // another session, and the ceiling holds only while this process stays up.
    // Re-save and account switch are fields of `liveFeedInstanceKey()` in
    // lib/quotes/registry.ts (D-1); the other three are the memo's process
    // lifetime and the adapter's session clock, not key fields (round 6 F-2).
    for (const trigger of [
      "at most once a day while Vyuha stays open",
      "again after a relaunch",
      "after Angel One's 5 AM IST session flush",
      "when you re-save the credentials",
      ACCOUNT_SWITCH_TRIGGER,
    ]) {
      expect(flat, `the sheet no longer names the trigger: ${trigger}`).toContain(trigger);
    }
  });

  /**
   * D-1 — THE ACCOUNT IS IN THE MEMO KEY, SO IT IS A TRIGGER.
   *
   * This is the derivation the literal above stands in for: read the key
   * builder's own body and assert the account field is still one of its
   * inputs. If a later wave re-keys the memo so a same-credential switch
   * reuses the session, THIS is the test that says the sheet must lose the
   * fifth trigger — rather than the sheet quietly over-stating the egress.
   */
  it("names the account switch because the memo key still carries the account", () => {
    const registry = fs.readFileSync(path.join(process.cwd(), "lib/quotes/registry.ts"), "utf8");
    const at = registry.indexOf("async function liveFeedInstanceKey(");
    expect(at, "liveFeedInstanceKey() is gone — the trigger list has nothing to stand on").toBeGreaterThan(-1);
    const body = registry.slice(at, registry.indexOf("\n}", at));
    expect(body, "the key no longer reads the selected account").toContain("getSelectedAccountId()");
    expect(body, "the key no longer mixes the account into the instance identity").toMatch(
      /return \[[^\]]*\baccountId\b/,
    );
    expect(flat).toContain(ACCOUNT_SWITCH_TRIGGER);
  });

  /**
   * C-4 — THE SHEET NAMES EVERY CREDENTIAL THE SIGN-IN SENDS, AND THE LIST IS
   * DERIVED FROM THE CODE THAT SENDS THEM.
   *
   * The sheet said "the client code, PIN and TOTP secret". `angelOneLogin()`
   * sends FOUR things and the TOTP SECRET IS NOT ONE OF THEM: `clientcode`,
   * `password` (the PIN) and `totp` — a code minted at call time — in the body,
   * and the SmartAPI app key in the `X-PrivateKey` header
   * (`smartApiHeaders(creds.apiKey)`). Naming three understates the egress by a
   * credential and overstates it by a secret that never leaves this machine.
   *
   * The FIELD LIST is read out of the login function rather than typed here, so
   * a fifth thing added to that request fails this test before it can ship
   * undisclosed; only the noun each field is called in prose is a literal.
   */
  const ANGEL_API_SRC = fs.readFileSync(path.join(process.cwd(), "lib/import/api/angelone.ts"), "utf8");

  const loginCredentialFields = (): string[] => {
    const at = ANGEL_API_SRC.indexOf("export async function angelOneLogin(");
    expect(at, "angelOneLogin() is gone — the derivation has nothing to read").toBeGreaterThan(-1);
    const body = ANGEL_API_SRC.slice(at, ANGEL_API_SRC.indexOf("\n}", at));
    return [...new Set([...body.matchAll(/creds\.(\w+)/g)].map((m) => m[1]))].sort();
  };

  /** Credential field on `AngelOneCredentials` → the noun the sheet must use. */
  const CREDENTIAL_NOUN: Record<string, string> = {
    apiKey: "the SmartAPI app key",
    clientCode: "the client code",
    pin: "the PIN",
    totpSecret: "the one-time code derived from the TOTP secret",
  };

  it("names all four credentials the login request actually carries", () => {
    const fields = loginCredentialFields();
    expect(fields, "the login request no longer sends the four disclosed credentials").toEqual([
      "apiKey",
      "clientCode",
      "pin",
      "totpSecret",
    ]);
    for (const f of fields) {
      const noun = CREDENTIAL_NOUN[f];
      expect(noun, `angelOneLogin() sends creds.${f} and the sheet has no noun for it`).toBeDefined();
      expect(flat, `the sheet does not name what it sends for creds.${f}`).toContain(noun);
    }
  });

  it("says the TOTP SECRET is not what is sent, and never claims it signs in with it", () => {
    expect(flat).toContain("the secret itself is never sent");
    // The banned shape: it reads as though the base32 secret travelled to the
    // broker on every sign-in. `totp(creds.totpSecret)` mints a 6-digit code.
    expect(flat, "the sheet claims the secret itself is the credential sent").not.toContain(
      "signs in with the TOTP secret",
    );
  });

  it("states the refused-login ceiling, so a wrong PIN is not one refusal per poll", () => {
    expect(flat).toContain(ANGEL_RETRY_SENTENCE);
  });

  it("states the SECOND ceiling too — a session invalidated after it was accepted (C-1)", () => {
    // Two different failures, two different ceilings, and the sheet that named
    // only the first under-stated the egress by a re-login per poll.
    expect(flat).toContain(ANGEL_SESSION_INVALID_SENTENCE);
    // The reset condition is part of the promise: without it the sentence
    // reads as "three sign-ins ever", which is not what the code does.
    expect(flat).toContain("without a priced answer in between");
  });

  it("states the batch size, the one-a-second ceiling and the 3/5/10 cadence", () => {
    expect(flat).toContain("in batches of 50, no more than once a second");
    expect(flat).toContain("every 3, 5 or 10 seconds depending on how many scrips you hold open");
    expect(flat).not.toContain("how many positions you hold");
    expect(flat, "the desk must say which tier is in force").toContain("the desk says which");
  });

  it("SAYS THERE IS NO READ-ONLY KEY, and what the code does about it instead", () => {
    // The single most important sentence in this file: a claim about the
    // credential would be false, so the claim is about the code, and
    // tests/angelone-api.test.ts is the test the sentence promises.
    expect(flat).toContain("Angel One offers no read-only key");
    expect(flat).toContain("could in principle place an order");
    expect(flat).toContain("contains no order call at all and a test refuses to let one be added");
  });

  it("states the token lookup, the equity-only limit and that nothing leaves the machine", () => {
    expect(flat).toContain("looks up each symbol's Angel One token once, on the same host");
    expect(flat).toContain("keeps that mapping on this machine");
    expect(flat).toContain("Only equity positions are priced by this feed in this release");
    expect(flat).toContain(NOT_PRICED_SENTENCE);
    expect(flat).toContain("never uploads them");
    expect(flat).toContain("never resells market data");
  });

  it("says a poll is not a tick stream, and the capability block agrees", () => {
    expect(flat).toMatch(/instead of receiving a live stream of ticks/);
    expect(flat).toMatch(/up to one interval old/);
    expect(flat).toMatch(/labelled delayed/);
    expect(ANGELONE_CAPABILITIES.staleness).toBe("delayed");
    expect(ANGELONE_CAPABILITIES.requiresDailyAuth, "the 5 AM flush, in machine terms").toBe(true);
  });

  it("names ONE host, and it is the one the adapter can reach", () => {
    const hosts = new Set(flat.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)?.map((h) => h.toLowerCase()) ?? []);
    expect([...hosts]).toEqual(["apiconnect.angelone.in"]);
    // smartapisocket.angelone.in and margincalculator.angelbroking.com are
    // real Angel One hosts this release never contacts, and therefore never
    // names — tests/quotes-egress-guard.test.ts refuses them by construction.
    expect(ANGELONE_CAPABILITIES.egressDescription).toContain("apiconnect.angelone.in");
  });

  it("keeps the SEBI-safe voice: no recommendation, no advice, no order verbs", () => {
    for (const banned of [
      /\brecommend/i,
      /\bsuggest/i,
      /\bshould\b/i,
      /\badvice\b|\badvise\b/i,
      /\bbuy\b/i,
      /\bsell\b/i,
      /\bprofit\b/i,
      /\bguarantee/i,
    ]) {
      expect(flat, `banned ${banned}`).not.toMatch(banned);
    }
  });
});

describe("the two sheets are two statements, not one", () => {
  it("neither sheet names the other's host", () => {
    const upstox = UPSTOX_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ");
    const angel = ANGELONE_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ");
    expect(upstox).not.toContain("angelone");
    expect(angel).not.toContain("upstox");
  });

  it("versions them independently, so one can change without re-prompting the other", () => {
    expect(LIVE_FEED_DISCLOSURE_VERSIONS.upstox).toBe("1");
    expect(LIVE_FEED_DISCLOSURE_VERSIONS.angelone).toBe("1");
    const both = withFeedAck(withFeedAck(null, "upstox"), "angelone");
    expect(isFeedAckCurrent(both, "upstox")).toBe(true);
    expect(isFeedAckCurrent(both, "angelone")).toBe(true);
    // …and accepting only one leaves the other closed.
    expect(isFeedAckCurrent(withFeedAck(null, "angelone"), "upstox")).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * B-5 / B-7 — THE TWO FALSE SENTENCES, BANNED ACROSS EVERY SURFACE THAT SAID
 * THEM.
 *
 * Fixing the consent sheet alone would leave the same false claim in help, in
 * `docs/client/PRIVACY.md`, in the client README and on the GitHub landing
 * page — four places a buyer reads BEFORE the dialog. This scan is the one
 * that makes the fix a fact about the product rather than about one module:
 * it reads the shipped files off disk, whitespace-normalised because they are
 * hard-wrapped at ~78 columns and a banned phrase routinely straddles two
 * source lines.
 *
 * "once a day" alone is NOT banned — `docs/client/README.md` truthfully says
 * Zerodha's own page is signed in to once a day, and the OpenAlgo reconnect
 * reminder is once a day. What is banned is the SIGN-IN CLAIM this wave
 * disproved, in the exact forms it shipped in.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("the phrases the v4.2 fix wave disproved appear on no surface", () => {
  const ROOT = process.cwd();

  /** The five files that carried one or both sentences at 8ae5dea. */
  const SURFACES = [
    "lib/domain/live-feed-disclosure.ts",
    "lib/domain/help-content.ts",
    "docs/client/PRIVACY.md",
    "docs/client/README.md",
    "README.md",
  ] as const;

  /**
   * Whitespace-collapsed, with the leading `>` of a blockquote line dropped
   * first. README.md states the v4.2 notes INSIDE a blockquote, so a sentence
   * hard-wrapped across two lines reads "…by this > feed:" once the newline is
   * collapsed — a normaliser that misses that reports a correct file as having
   * dropped the sentence, which is how a guard gets loosened for the wrong
   * reason.
   */
  const flatten = (rel: string) =>
    fs
      .readFileSync(path.join(ROOT, rel), "utf8")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/\s+/g, " ");

  /** B-5: the derivative row never held a "stored mark" of its own. */
  const B5_BANNED = [
    "keep their last stored mark",
    "keeps their last stored mark",
    "keep the mark already stored",
    "keeps the mark already stored",
    "last stored mark",
  ];

  /**
   * B-7 + C-3: the sign-in is a process rule, never a calendar one — and "each
   * morning" is the same calendar promise in softer words. A machine left shut
   * opens no session that morning; one relaunched at noon opens one then.
   */
  const B7_BANNED = [
    "once each trading day",
    "signs in once a day",
    "sign-in each trading day",
    "each morning",
  ];

  /**
   * C-11: the fallback for an unpriced derivative row is a DASH, not the
   * position's own entry price. Banned as a phrase rather than as a whole
   * sentence because the wrong fallback survives any amount of rewrapping.
   */
  const ENTRY_PRICE_BANNED = ["its entry price"];

  const ALL_BANNED = [...B5_BANNED, ...B7_BANNED, ...ENTRY_PRICE_BANNED];

  it.each(SURFACES)("%s carries none of the disproved phrases", (rel) => {
    const text = flatten(rel).toLowerCase();
    const hits = ALL_BANNED.filter((p) => text.includes(p));
    expect(hits, `${rel} still says: ${hits.join(" / ")}`).toEqual([]);
  });

  it("…and every one of those surfaces states the replacement instead", () => {
    // A ban with nothing to replace it is satisfied by deleting the passage.
    for (const rel of SURFACES) {
      const text = flatten(rel);
      expect(text, `${rel} dropped the derivative sentence instead of correcting it`).toContain(
        "are not priced by this feed: each shows the position's recorded close, or a dash when no close is recorded",
      );
    }
    for (const rel of SURFACES) {
      expect(flatten(rel), `${rel} dropped the sign-in correction`).toContain(
        "at most once a day while Vyuha stays open, again after a relaunch, after Angel One's 5 AM IST session flush, or when you re-save the credentials",
      );
    }
  });

  /**
   * D-1 + C-1 (owner rulings, 2026-09-08). The five surfaces that list the
   * sign-in triggers list the SAME five, and state BOTH ceilings.
   *
   * A trigger named on the consent sheet and missing from PRIVACY.md is the
   * drift this describe block exists to catch: the buyer-facing document is
   * the one an outside reader audits us against. One canonical clause per
   * fact, asserted on every surface, so a rewrite of one file cannot leave
   * four saying something else.
   */
  it("every surface names the FIFTH trigger and the second ceiling", () => {
    for (const rel of SURFACES) {
      const text = flatten(rel);
      expect(text, `${rel} does not name the account-switch trigger (D-1)`).toContain(ACCOUNT_SWITCH_TRIGGER);
      expect(text, `${rel} does not state the session-invalid ceiling (C-1)`).toContain(
        ANGEL_SESSION_INVALID_SENTENCE,
      );
    }
  });

  /**
   * D-1 (owner ruling, 2026-09-08 round 5). BOTH CEILINGS RESUME THE SAME TWO
   * WAYS.
   *
   * `consecutiveLoginFailures` and `consecutiveSessionInvalidations` are both
   * instance locals of the Angel One adapter, so a relaunch clears either one
   * exactly as a re-save does. The sheet said so of the second ceiling and not
   * of the first, and the other four surfaces copied the sheet — a user capped
   * on a refused sign-in was told to re-save credentials that are not wrong.
   *
   * The pair is read OUT OF THE SHEET rather than restated, so a test that
   * agreed with itself cannot pass while the two clauses disagree.
   */
  it("every surface states the refused-sign-in ceiling, and BOTH ceilings on the sheet name the relaunch", () => {
    for (const rel of SURFACES) {
      expect(flatten(rel), `${rel} does not state the refused-sign-in ceiling (D-1)`).toContain(
        ANGEL_RETRY_SENTENCE,
      );
    }
    const sheet = ANGELONE_FEED_ITEMS.map((i) => i.body).join(" ");
    const ceilings = sheet.match(/[^.]*at most three times[^.]*\./g) ?? [];
    expect(ceilings.length, "the sheet no longer states exactly two three-attempt ceilings").toBe(2);
    for (const clause of ceilings) {
      expect(clause.trim(), `a ceiling clause names only the re-save: ${clause.trim()}`).toContain(
        "re-save the credentials or relaunch Vyuha",
      );
    }
  });

  it("the scan can fire — the exact lines that shipped are caught", () => {
    const shipped = [
      "Only equity positions are priced by this feed in this release. Futures and options rows keep their last stored mark and say so.",
      "Equities only in this release: futures and options\n   rows keep the mark already stored and say so.",
      "Vyuha signs in to apiconnect.angelone.in once each trading day with the client code, PIN and TOTP secret you saved.",
      "the Live Desk price poll … whose one sign-in each trading day Vyuha performs for you",
      // C-3: the softer form of the same calendar promise.
      "Angel One clears every API session at 5 AM IST; Vyuha opens the next one\n   itself each morning from that secret, without asking you.",
      // C-11: the fallback that names a price the row never shows.
      "Futures and options rows are not priced by this feed: each shows the position's recorded close, or its entry price when no close is recorded, and says so on the row.",
    ];
    for (const line of shipped) {
      const text = line.replace(/\s+/g, " ").toLowerCase();
      expect(
        ALL_BANNED.filter((p) => text.includes(p)).length,
        `a shipped line the ban must catch: ${line.slice(0, 70)}`,
      ).toBeGreaterThan(0);
    }
    // …and a sentence that says "once a day" about something else is allowed,
    // as is the poll's own "no entry price" negative, which is not the fallback.
    const allowed = "Log in via Zerodha's own page once a day, paste the request token.";
    expect(ALL_BANNED.filter((p) => allowed.toLowerCase().includes(p))).toEqual([]);
    const alsoAllowed = "and sends nothing else about them: no quantity, no entry price, no P&L, no account.";
    expect(ALL_BANNED.filter((p) => alsoAllowed.toLowerCase().includes(p))).toEqual([]);
  });
});
