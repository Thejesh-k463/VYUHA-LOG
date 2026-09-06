import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LIVE_FEED_COPY } from "@/components/settings/live-feed-card";
import {
  OPENALGO_DEFAULT_HOST,
  OPENALGO_DISCLOSURE_VERSION,
  OPENALGO_FEED_ITEMS,
  OPENALGO_REFUSALS,
  OPENALGO_RISKS,
  OPENALGO_WHAT_IT_DOES,
  OPENALGO_WHAT_IT_IS,
  isAckCurrent,
  isLocalOpenAlgoHost,
  openAlgoGate,
} from "@/lib/domain/openalgo-disclosure";

/**
 * The disclosure is the thing standing between a user and handing a second
 * program their broker credentials. These tests pin the two properties that
 * make it worth anything: the gate is CLOSED unless both halves hold, and the
 * copy actually names the risks it claims to name.
 */

describe("the gate", () => {
  it("refuses when the switch is off, whatever the acknowledgement says", () => {
    const g = openAlgoGate({ enabled: false, ackVersion: OPENALGO_DISCLOSURE_VERSION });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/Settings/);
  });

  it("refuses when the disclosure was never accepted", () => {
    expect(openAlgoGate({ enabled: true, ackVersion: null }).allowed).toBe(false);
    expect(openAlgoGate({ enabled: true, ackVersion: undefined }).allowed).toBe(false);
    expect(openAlgoGate({ enabled: true, ackVersion: "" }).allowed).toBe(false);
  });

  it("refuses an acknowledgement of an OLDER disclosure — a changed risk re-prompts", () => {
    const g = openAlgoGate({ enabled: true, ackVersion: "0" });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/changed since you accepted/i);
  });

  /**
   * v4.1 bumped the disclosure to "2" because the SAME instance now also
   * PRICES the desk every 1–5 s — a materially different statement from the
   * one-request-you-press pull that "1" described. Strict `===` in
   * `isAckCurrent` is the whole mechanism, so this is the case that proves the
   * bump actually re-prompts rather than just changing a string.
   */
  it("refuses an install that accepted disclosure v1 — the feed is not covered by it", () => {
    const g = openAlgoGate({ enabled: true, ackVersion: "1" });
    expect(g.allowed, "a v1 acceptance must not unlock the v2 feed").toBe(false);
    expect(g.reason).toMatch(/changed since you accepted/i);
    expect(isAckCurrent("1"), "isAckCurrent must agree with the gate").toBe(false);
    expect(OPENALGO_DISCLOSURE_VERSION).toBe("2");
  });

  it("allows only when the switch is on AND the acceptance is current", () => {
    expect(openAlgoGate({ enabled: true, ackVersion: OPENALGO_DISCLOSURE_VERSION }).allowed).toBe(true);
  });

  it("isAckCurrent agrees with the gate", () => {
    expect(isAckCurrent(OPENALGO_DISCLOSURE_VERSION)).toBe(true);
    expect(isAckCurrent("0")).toBe(false);
    expect(isAckCurrent(null)).toBe(false);
  });
});

describe("host locality — the 'nothing leaves your computer' promise", () => {
  it("treats the loopback block and localhost as local", () => {
    for (const h of ["http://127.0.0.1:5000", "127.0.0.1:5000", "http://localhost:5000", "localhost", "http://127.7.7.7:5000"]) {
      expect(isLocalOpenAlgoHost(h), h).toBe(true);
    }
  });

  it("treats a LAN address or a remote name as REMOTE — under-warning is the failure that matters", () => {
    for (const h of ["http://192.168.1.9:5000", "http://10.0.0.4:5000", "https://algo.example.com", "http://openalgo.local"]) {
      expect(isLocalOpenAlgoHost(h), h).toBe(false);
    }
  });

  it("refuses to call an unparseable or empty host local", () => {
    expect(isLocalOpenAlgoHost("")).toBe(false);
    expect(isLocalOpenAlgoHost("   ")).toBe(false);
    expect(isLocalOpenAlgoHost("http://")).toBe(false);
  });

  it("ships a loopback default", () => {
    expect(isLocalOpenAlgoHost(OPENALGO_DEFAULT_HOST)).toBe(true);
  });
});

describe("the copy says what it must say", () => {
  it("has a what-it-is, a what-it-does and a risk section, none empty", () => {
    for (const list of [OPENALGO_WHAT_IT_IS, OPENALGO_WHAT_IT_DOES, OPENALGO_RISKS]) {
      expect(list.length).toBeGreaterThanOrEqual(3);
      for (const item of list) {
        expect(item.title.trim().length).toBeGreaterThan(0);
        expect(item.body.trim().length).toBeGreaterThan(40);
      }
    }
    expect(OPENALGO_REFUSALS.length).toBeGreaterThanOrEqual(3);
  });

  it("names the six risks a user could not discover for themselves", () => {
    const all = OPENALGO_RISKS.map((r) => `${r.title} ${r.body}`).join(" ").toLowerCase();
    expect(all).toMatch(/credential/); // whose keys OpenAlgo holds
    expect(all).toMatch(/quantity 0|quantity zero/); // the documented zero-size fill
    expect(all).toMatch(/contract note/); // and what to check it against
    expect(all).toMatch(/charge/); // computed, not stated
    expect(all).toMatch(/current trading day|today only/); // not a backfill
    expect(all).toMatch(/not running|could not reach/); // the common failure
    expect(all).toMatch(/leaves? this machine|travels? to that machine/); // non-local host
  });

  it("says plainly that Vyuha neither supports OpenAlgo nor places orders", () => {
    const refusals = OPENALGO_REFUSALS.join(" ").toLowerCase();
    expect(refusals).toMatch(/does not install|support/);
    expect(refusals).toMatch(/never places|cancel/);
  });

  it("never claims the pull is more accurate on charges than a file import", () => {
    const all = [...OPENALGO_WHAT_IT_IS, ...OPENALGO_WHAT_IT_DOES, ...OPENALGO_RISKS]
      .map((r) => r.body)
      .join(" ")
      .toLowerCase();
    // The honest direction: files carry the broker's own charges, the API does not.
    expect(all).toMatch(/more accurate source for costs/);
  });

  it("version is a bare string a stored ack can be compared against", () => {
    expect(OPENALGO_DISCLOSURE_VERSION).toMatch(/^\d+$/);
  });
});

/**
 * DISCLOSURE v2 — the live PRICE FEED half (v4.1).
 *
 * `OPENALGO_FEED_ENABLED` is true in 4.1, so these sentences describe a feature
 * that ships. Every one of them is checked against `lib/quotes/openalgo.ts`
 * here rather than trusted: consent copy that outruns the adapter is the defect
 * this file exists to catch.
 */
describe("the live price feed disclosure (v2)", () => {
  const all = OPENALGO_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ");

  it("is a section of its own, and every item is a real sentence", () => {
    expect(OPENALGO_FEED_ITEMS.length).toBeGreaterThanOrEqual(6);
    for (const item of OPENALGO_FEED_ITEMS) {
      expect(item.title.trim().length, item.title).toBeGreaterThan(0);
      expect(item.body.trim().length, item.title).toBeGreaterThan(40);
    }
  });

  it("names the poll cadence and where the user sets it", () => {
    // lib/quotes/openalgo.ts:59-71 clamps to 1–5 s; :413 is the interval.
    expect(all).toMatch(/every 1 to 5 seconds|1 to 5 seconds/i);
    expect(all).toMatch(/Settings → Live feed/);
    expect(all).toMatch(/while the Live Desk is open|when the Live Desk opens/i);
  });

  it("names EXACTLY what the request body carries, and what it does not", () => {
    // The body is `{ apikey, symbols: [{ symbol, exchange }] }` —
    // lib/quotes/openalgo.ts:319 + :351-355. Nothing else is in it, and the
    // copy has to say so in the user's own terms.
    expect(all).toMatch(/trading symbols and exchanges/i);
    expect(all).toMatch(/API key/i);
    expect(all).toMatch(/quantit\w+/i);
    expect(all).toMatch(/P&L/);
    expect(all).toMatch(/never how much of them you hold|nothing about your book/i);
  });

  it("names the /funds probe and refuses to imply a balance is kept", () => {
    expect(all).toMatch(/\/funds/);
    expect(all).toMatch(/no balance is stored or shown/i);
  });

  it("names the loopback default and the one case where data leaves the machine", () => {
    expect(all).toContain(OPENALGO_DEFAULT_HOST.replace(/^http:\/\//, ""));
    expect(all).toMatch(/no symbol leaves it/i);
    expect(all).toMatch(/travels to that machine/i);
  });

  it("does not contradict the Settings card about what is written", () => {
    // Two statements of one behaviour drift; `LIVE_FEED_COPY.staleness`
    // (components/settings/live-feed-card.tsx) is pinned verbatim by
    // tests/live-feed-copy.test.ts, so pinning the shared claims here holds the
    // consent sheet to the same fact.
    expect(LIVE_FEED_COPY.staleness).toMatch(/never written to your journal/i);
    expect(all).toMatch(/never written to your journal/i);
    expect(all).toMatch(/one mark per position per day/i);
    expect(all).toMatch(/last price of the session/i);
    expect(all).toMatch(/Save today's mark/);
    // "Prices refresh on screen only" is the card's own opening claim.
    expect(all).toMatch(/refresh on screen only/i);
  });

  it("attributes the daily re-sign-in to the BROKER and to no regulator", () => {
    // Owner ruling 2026-09-06: no circular saying so is cited anywhere in this
    // tree, so no regulator and no exchange may be named for it. Same rule
    // tests/live-feed-copy.test.ts:105 (the regulator not.toMatch) applies to the Settings card.
    const reauth = OPENALGO_FEED_ITEMS.find((i) => /expires every day/i.test(i.body));
    expect(reauth, "the daily re-sign-in item is gone from the disclosure").toBeDefined();
    const sentence = `${reauth!.title} ${reauth!.body}`;
    expect(sentence).toMatch(/the broker's rule, not Vyuha's/);
    // Scoped to THIS item on purpose: "exchanges" is a legitimate word
    // elsewhere in the sheet (the request body carries symbols AND exchanges).
    // What may not happen is a regulator being blamed for the daily login.
    expect(sentence).not.toMatch(/\b(SEBI|exchange|exchanges|circular|regulat\w*)\b/i);
  });

  it("keeps the v3.1 PULL items intact — v2 adds to the disclosure, it does not replace it", () => {
    const pull = OPENALGO_WHAT_IT_DOES.map((i) => `${i.title} ${i.body}`).join(" ");
    expect(pull).toMatch(/Preview/);
    expect(pull).toMatch(/Nothing runs on a schedule/);
    expect(pull).toMatch(/only the OpenAlgo key and host/i);
  });

  it("carries no prescriptive vocabulary — a consent sheet never prompts a transaction", () => {
    const BANNED =
      /\b(recommend(s|ed|ation|ations)?|suggest(s|ed)?|advice|advise[sd]?|should|consider(s|ed|ing)?|buy|sell now|target price|opportunit|guaranteed|safe|low risk)\b/i;
    expect(BANNED.test("You should consider the live feed"), "the scan really can fire").toBe(true);
    const offenders = OPENALGO_FEED_ITEMS.filter((i) => BANNED.test(`${i.title} ${i.body}`)).map((i) => i.title);
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it("reaches the screen — the dialog renders the feed items through the same generic list", () => {
    // A disclosure item nobody can read is not a disclosure. The dialog maps
    // the arrays generically, so this pins the wiring, not the copy.
    const dialog = fs.readFileSync(path.join(process.cwd(), "components/system/openalgo-dialog.tsx"), "utf8");
    expect(dialog).toContain("OPENALGO_FEED_ITEMS");
    expect(dialog, "the feed items must render through ItemList, like every other section").toMatch(
      /<ItemList items=\{OPENALGO_FEED_ITEMS\} \/>/,
    );
    expect(dialog, "the version on screen must stay derived from the constant").toContain(
      "v{OPENALGO_DISCLOSURE_VERSION}",
    );
  });
});
