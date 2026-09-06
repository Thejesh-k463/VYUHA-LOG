import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPENALGO_DEFAULT_HOST } from "@/lib/domain/openalgo-disclosure";
import { createOpenAlgoProvider, type FeedGateState } from "@/lib/quotes/openalgo";
import { SHIPPED_PROVIDER_IDS, allProviderCapabilities } from "@/lib/quotes/registry";
import { OPENALGO_FEED_ENABLED, type QuoteKey } from "@/lib/quotes/types";

/**
 * THE REGISTRY RULE, MECHANISED (03D §1.2, spec §4.1).
 *
 * "A provider is selectable only if `capabilities.egressDescription` has a
 * matching line in `docs/client/PRIVACY.md`." That sentence is worth nothing
 * unless something reads the file, so this test does — the same trick
 * `tests/intelligence-contract.test.ts` uses on banned phrases, and
 * `tests/egress-guard.test.ts` uses on call sites.
 *
 * The two guards are complementary: `egress-guard` catches a `fetch()` to a
 * host nobody declared; this one catches the opposite failure — a provider
 * that DECLARES a host the privacy sheet never told the user about. v4.0 adds
 * neither, which is why "There is no fifth thing." still stands.
 *
 * Adding a provider that names a new host fails this test until PRIVACY.md
 * covers it, and PRIVACY.md is owned by the docs wave — so the host, the
 * sentence and the consent land together or not at all.
 */

const PRIVACY_PATH = path.join(process.cwd(), "docs/client/PRIVACY.md");
const privacy = readFileSync(PRIVACY_PATH, "utf8");
const flat = privacy.replace(/\s+/g, " ");

/**
 * host → the sentence in PRIVACY.md that already discloses it. The excerpt is
 * asserted verbatim (whitespace-normalised): deleting the disclosure fails this
 * test even though the host list did not change.
 */
const PRIVACY_COVERED: Record<string, string> = {
  // Pinned to the HEAD of the disclosure, not the whole paragraph: the Atlas
  // wave extended the same sentence ("…and to compute the Market Atlas from
  // bars kept on this machine"), which is a widening of the same disclosure,
  // not a new host. A pin that breaks when the sentence is legitimately
  // extended teaches the next wave to edit the pin without reading it. The
  // "off by default" half is asserted separately below, because THAT is the
  // part a marketing edit could quietly drop.
  "nsearchives.nseindia.com":
    "**End-of-day market data — only if you switch it on.** Downloads the free NSE/BSE bhavcopy to value open positions",
};

/** The OpenAlgo bridge is the user's own machine, and PRIVACY.md says so. */
const OPENALGO_DISCLOSED = "OpenAlgo bridge you run on your own machine";

/** Loopback is the machine talking to itself, and is never remote egress. */
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[?::1\]?|0\.0\.0\.0)$/;

/** Every dotted host-looking token in a sentence ("…from nsearchives.nseindia.com you…"). */
function hostsIn(sentence: string): string[] {
  const found = sentence.match(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi) ?? [];
  return [...new Set(found.map((h) => h.toLowerCase()))].filter((h) => !LOOPBACK.test(h));
}

describe("every provider's declared egress is already in the privacy sheet", () => {
  it("names no host PRIVACY.md does not disclose", () => {
    const offenders: string[] = [];
    for (const cap of allProviderCapabilities()) {
      for (const host of hostsIn(cap.egressDescription)) {
        if (!(host in PRIVACY_COVERED)) offenders.push(`${cap.id} → ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the disclosure that authorises each named host in the file, verbatim", () => {
    for (const [host, excerpt] of Object.entries(PRIVACY_COVERED)) {
      expect(flat, `PRIVACY.md no longer carries the line that covers ${host}`).toContain(
        excerpt.replace(/\s+/g, " "),
      );
    }
    // The consent half of the same sentence: a download the user did not
    // switch on is a different product from the one this file describes.
    expect(flat, "the bhavcopy download must still be off by default").toContain("Off by default.");
  });

  it("declares 'None' when it names no host, so silence is never the reason", () => {
    for (const cap of allProviderCapabilities()) {
      if (hostsIn(cap.egressDescription).length === 0) {
        expect(cap.egressDescription, `${cap.id} must say it makes no request`).toMatch(/^none\b/i);
      }
    }
  });

  it("every provider says something, and says it as a sentence", () => {
    for (const cap of allProviderCapabilities()) {
      expect(cap.egressDescription.length, cap.id).toBeGreaterThan(10);
      expect(cap.egressDescription.trim().endsWith("."), cap.id).toBe(true);
    }
  });
});

describe("the feed adds no host at all", () => {
  it("the only host any provider names is the bhavcopy archive the app already downloads", () => {
    const named = new Set(allProviderCapabilities().flatMap((c) => hostsIn(c.egressDescription)));
    expect([...named]).toEqual(["nsearchives.nseindia.com"]);
  });

  it("leaves 'there is no fifth thing' literally true", () => {
    // Pinned to the sentence PRIVACY.md actually carries (owner ruling Q6; the
    // file scopes the claim to the desktop app, 892b9ab). The pin is verbatim
    // rather than a /no fifth thing/ regex because the SCOPE is the load-
    // bearing half: "for Vyuha Desktop" is what keeps the sentence true when
    // the hosted product exists.
    expect(flat).toContain("That is the complete list for Vyuha Desktop. There is no fifth thing.");
  });
});

/**
 * v4.1 SHIPS the OpenAlgo live feed. It is the FIRST provider that makes a
 * request while the app is open, and it still adds no host: the bridge is a
 * server the user installed on their own machine, reached over loopback (or a
 * machine on their own network, which the card says out loud). This block is
 * what stops "the feed is local" from being a claim in a comment.
 *
 * The adapter was BUILT in v4.0 and merely not selectable
 * (`OPENALGO_FEED_ENABLED`, owner ruling), and every assertion below ran then
 * too — a capability block that stopped being policed the moment the feature
 * flag went false would be a guard that sleeps exactly while the code is
 * easiest to change. Now that the flag is true they police a feed that runs.
 */
describe("v4.1's live feed adds no remote host either", () => {
  const openalgo = () => allProviderCapabilities().find((c) => c.id === "openalgo")!;

  it("is built, described AND selectable in this release", () => {
    expect(OPENALGO_FEED_ENABLED, "v4.1 ships the OpenAlgo feed").toBe(true);
    expect(SHIPPED_PROVIDER_IDS as readonly string[]).toContain("openalgo");
    // …and it is NOT one of the "planned" placeholders: the adapter is real,
    // which is why its declared egress has to hold up.
    expect(openalgo().label).not.toMatch(/not enabled/i);
  });

  it("names no remote host at all — loopback is the machine talking to itself", () => {
    expect(hostsIn(openalgo().egressDescription)).toEqual([]);
    expect(openalgo().egressDescription).toMatch(/^none\b/i);
    expect(openalgo().egressDescription).toMatch(/127\.0\.0\.1/);
  });

  it("says the OTHER case too — a bridge on another machine is egress the user chose", () => {
    // Silence about the non-loopback host would make the "None" above a lie
    // for anyone who typed a LAN address into Import → OpenAlgo.
    expect(openalgo().egressDescription).toMatch(/host you configured/i);
  });

  it("is covered by the privacy sheet's own words about the bridge", () => {
    expect(flat, "PRIVACY.md no longer describes the bridge as the user's own machine").toContain(
      OPENALGO_DISCLOSED,
    );
  });

  it("is truthful about staleness: a 3-second poll of an LTP is not a tick stream", () => {
    expect(openalgo().staleness).toBe("delayed");
    // …and about the one thing no engineering removes.
    expect(openalgo().requiresDailyAuth).toBe(true);
  });
});

/**
 * THE DECLARED EGRESS, MEASURED AGAINST THE CODE THAT MAKES THE REQUESTS.
 *
 * Everything above reads `capabilities.egressDescription` — a sentence. This
 * block runs the provider with an injected gate and an injected `fetch`, and
 * asserts the URLs it actually produces, because v4.1 is the release where
 * that sentence stops being a promise about code nobody calls.
 *
 * TWO ENDPOINTS EXIST, and no third: `/api/v1/multiquotes` (every snapshot,
 * and therefore every poll of `subscribe()`) and `/api/v1/funds` (the health
 * probe — the cheapest call that proves both the host and the key). Both are
 * built from ONE template in ONE place, on the host the user configured, whose
 * default is loopback.
 */
describe("the OpenAlgo provider's egress, as the code actually makes it", () => {
  const SOURCE = readFileSync(path.join(process.cwd(), "lib/quotes/openalgo.ts"), "utf8");
  const TCS: QuoteKey = { symbol: "TCS", exchange: "NSE" };

  /** Every request the provider makes for one snapshot and one health probe. */
  async function callsFor(host: string): Promise<{ url: string; init: RequestInit }[]> {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "success", results: [] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const readGate = async (): Promise<FeedGateState> => ({
      state: "ready",
      creds: { apiKey: "k-egress", host },
    });
    const provider = createOpenAlgoProvider({ readGate, fetchImpl });
    await provider.snapshot([TCS]);
    await provider.health();
    return seen;
  }

  it("reaches the loopback default and nowhere else — two endpoints, in that order", async () => {
    const urls = (await callsFor(OPENALGO_DEFAULT_HOST)).map((c) => c.url);
    expect(urls).toEqual([
      `${OPENALGO_DEFAULT_HOST}/api/v1/multiquotes`,
      `${OPENALGO_DEFAULT_HOST}/api/v1/funds`,
    ]);
  });

  it("follows the host the USER configured in Import → OpenAlgo, and adds none of its own", async () => {
    // The non-loopback case the capability sentence says out loud: a bridge on
    // another machine on the user's own network. It is still the ONLY host.
    const urls = (await callsFor("http://192.168.1.9:5000")).map((c) => c.url);
    expect(urls.map((u) => new URL(u).host)).toEqual(["192.168.1.9:5000", "192.168.1.9:5000"]);
    expect(urls.map((u) => new URL(u).pathname).sort()).toEqual(["/api/v1/funds", "/api/v1/multiquotes"]);
  });

  it("sends the scrip and the exchange and NOTHING ELSE — no quantity, no P&L, no account id", async () => {
    const [poll] = await callsFor(OPENALGO_DEFAULT_HOST);
    const body = JSON.parse(String(poll.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["apikey", "symbols"]);
    expect(body.symbols).toEqual([{ symbol: "TCS", exchange: "NSE" }]);
    // The open book carries quantities, average prices, stops and an account
    // id; a poll carries the name of the scrip and the exchange it trades on.
    expect(JSON.stringify(body)).not.toMatch(/qty|quantity|pnl|account|avg|price|stop|target/i);
  });

  it("names no host of its own anywhere in the source — every literal is loopback", () => {
    const urls = [...SOURCE.matchAll(/https?:\/\/[^\s"'`)\]]+/g)].map((m) => m[0]);
    for (const u of urls) expect(new URL(u).hostname, u).toBe("127.0.0.1");
    const ips = [...new Set([...SOURCE.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map((m) => m[0]))];
    expect(ips, "an address that is not loopback appears in the adapter").toEqual(["127.0.0.1"]);
    // A vendor hostname in a comment is how a "just for testing" endpoint gets
    // written; NSE and Yahoo are the two this provider exists to refuse (Q22).
    expect(SOURCE).not.toMatch(/\b[a-z0-9-]+\.(?:com|in|io|net|org|co|dev|app|ai)\b/i);
  });

  it("builds every request from ONE call site and ONE template", () => {
    // A second `fetch` call site is how a second host arrives without anyone
    // editing the capability sentence.
    expect((SOURCE.match(/doFetch\(/g) ?? []).length, "more than one fetch call site").toBe(1);
    expect(SOURCE).toContain("`${base}/api/v1/${path}`");
    expect(SOURCE).toMatch(/const base = normalizeHost\(creds\.host\)/);
    // …and the only two paths that template is ever given.
    const paths = [...SOURCE.matchAll(/post\(gate\.creds, "([a-z]+)"/g)].map((m) => m[1]);
    expect([...new Set(paths)].sort()).toEqual(["funds", "multiquotes"]);
  });
});
