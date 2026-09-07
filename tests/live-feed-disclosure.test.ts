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
    expect(flat).toContain("Analytics token you saved under Import → Brokers");
    expect(flat).toContain("read-only");
    expect(flat).toContain("cannot place, change or cancel an order");
    expect(flat).toContain("Only equity positions are priced by this feed in this release");
    expect(flat).toContain("Futures and options rows keep their last stored mark");
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

  it("states the daily sign-in, the 5 AM flush and where the credentials came from", () => {
    expect(flat).toContain("signs in to apiconnect.angelone.in once each trading day");
    expect(flat).toContain("client code, PIN and TOTP secret you saved under Import → Brokers");
    expect(flat).toContain("Angel One clears every session at 5 AM IST");
  });

  it("states the batch size, the one-a-second ceiling and the 3/5/10 cadence", () => {
    expect(flat).toContain("in batches of 50, no more than once a second");
    expect(flat).toContain("every 3, 5 or 10 seconds depending on how many positions you hold");
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
    expect(flat).toContain("Futures and options rows keep their last stored mark");
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
