import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allProviderCapabilities } from "@/lib/quotes/registry";

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
  "nsearchives.nseindia.com":
    "**End-of-day market data — only if you switch it on.** Downloads the free NSE/BSE bhavcopy to value open positions. Off by default.",
};

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

describe("v4.0 adds no host at all", () => {
  it("the only host any provider names is the bhavcopy archive the app already downloads", () => {
    const named = new Set(allProviderCapabilities().flatMap((c) => hostsIn(c.egressDescription)));
    expect([...named]).toEqual(["nsearchives.nseindia.com"]);
  });

  it("leaves 'there is no fifth thing' literally true", () => {
    expect(flat).toContain("That is the complete list. There is no fifth thing.");
  });
});
