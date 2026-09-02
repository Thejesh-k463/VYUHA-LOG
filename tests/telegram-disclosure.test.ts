import { describe, expect, it } from "vitest";
import {
  TELEGRAM_DISCLOSURE,
  TELEGRAM_TEST_MESSAGE,
  isTelegramAckCurrent,
  telegramGate,
} from "@/lib/domain/telegram-disclosure";
import { DEFAULT_SEND_TIME, parseSendTime, shouldSendDigest, type DigestGateState } from "@/lib/telegram/digest-gate";

/**
 * The disclosure is a RECORD, not decoration: consent is stored against its
 * version, the server gate quotes its sentences, and every digest carries its
 * footer. So the const is pinned — a drive-by edit that softens a risk or
 * changes the version semantics must redden here, deliberately.
 */

describe("TELEGRAM_DISCLOSURE is pinned", () => {
  it("is version 1 (an integer — bump ONLY for a materially changed risk)", () => {
    expect(TELEGRAM_DISCLOSURE.version).toBe(1);
    expect(Number.isInteger(TELEGRAM_DISCLOSURE.version)).toBe(true);
  });

  it("names the three load-bearing risks: Telegram's servers, the India block, own-risk delivery", () => {
    const all = TELEGRAM_DISCLOSURE.risks.map((r) => `${r.title} ${r.body}`).join(" ");
    expect(all).toMatch(/Telegram's (own )?servers|transits Telegram/i);
    expect(all).toMatch(/blocked .* India|India .* blocked/i);
    expect(all).toMatch(/at your own risk/i);
    expect(all).toMatch(/in-app notice|degrades to an in-app/i);
    expect(all).toMatch(/no proxies/i);
  });

  it("risk #4 tells the retry truth: a failed send retries at the NEXT LAUNCH, not tomorrow", () => {
    // The code deliberately does not stamp on a failed send, so the next
    // launch the same day retries — "stops until tomorrow" contradicted it.
    const all = TELEGRAM_DISCLOSURE.risks.map((r) => r.body).join(" ");
    expect(all).toMatch(/until the next launch/i);
    expect(all).not.toMatch(/until tomorrow/i);
  });

  it("points at the card's real home — Settings → Alerts, not Integrations", () => {
    // The Telegram card renders under its own "Alerts — Telegram EOD digest"
    // card on /settings; OpenAlgo is the thing under Integrations.
    expect(telegramGate({ enabled: false, ackVersion: null }).reason).toContain("Settings → Alerts");
    expect(telegramGate({ enabled: true, ackVersion: null }).reason).toContain("Settings → Alerts");
    const noCreds = shouldSendDigest({ ...OPEN, hasCredentials: false }, WED_1600_IST);
    expect(noCreds.reason).toContain("Settings → Alerts");
    for (const text of [
      telegramGate({ enabled: false, ackVersion: null }).reason,
      telegramGate({ enabled: true, ackVersion: null }).reason,
      noCreds.reason,
    ]) {
      expect(text).not.toContain("Integrations");
    }
  });

  it("pins the footer and the test message verbatim", () => {
    expect(TELEGRAM_DISCLOSURE.footer).toBe("Your own recorded data. Not investment advice.");
    expect(TELEGRAM_TEST_MESSAGE).toBe("✅ Vyuha connected — test alert");
  });
});

describe("telegramGate — enabling without a current ack is refused (the openAlgoGate rule)", () => {
  it("refuses while off, whatever the ack says", () => {
    expect(telegramGate({ enabled: false, ackVersion: null }).allowed).toBe(false);
    expect(telegramGate({ enabled: false, ackVersion: TELEGRAM_DISCLOSURE.version }).allowed).toBe(false);
  });
  it("refuses on with NO ack — this is the 403 the toggle route returns", () => {
    const g = telegramGate({ enabled: true, ackVersion: null });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/read it again|disclosure/i);
  });
  it("refuses on with a STALE ack (an older version's acceptance does not carry)", () => {
    expect(telegramGate({ enabled: true, ackVersion: 0 }).allowed).toBe(false);
    expect(isTelegramAckCurrent(TELEGRAM_DISCLOSURE.version + 1)).toBe(false);
  });
  it("allows only enabled AND current ack", () => {
    expect(telegramGate({ enabled: true, ackVersion: TELEGRAM_DISCLOSURE.version })).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Digest gate — every precondition blocks alone. 2026-09-02 is a Wednesday;
// 16:00 IST = 10:30 UTC.
// ---------------------------------------------------------------------------

const OPEN: DigestGateState = {
  enabled: true,
  ackVersion: TELEGRAM_DISCLOSURE.version,
  hasCredentials: true,
  sendTime: "15:35",
  lastSentDate: null,
};
const WED_1600_IST = new Date("2026-09-02T10:30:00Z");

describe("shouldSendDigest — each precondition blocks on its own", () => {
  it("sends when everything holds, stamping the IST date", () => {
    const r = shouldSendDigest(OPEN, WED_1600_IST);
    expect(r.send).toBe(true);
    expect(r.today).toBe("2026-09-02");
  });

  it("blocks when disabled", () => {
    const r = shouldSendDigest({ ...OPEN, enabled: false }, WED_1600_IST);
    expect(r.send).toBe(false);
    expect(r.reason).toMatch(/off/i);
  });

  it("blocks on a missing or stale ack — consent is checked at SEND time, not only at enable", () => {
    expect(shouldSendDigest({ ...OPEN, ackVersion: null }, WED_1600_IST).send).toBe(false);
    expect(shouldSendDigest({ ...OPEN, ackVersion: 0 }, WED_1600_IST).send).toBe(false);
  });

  it("blocks without credentials", () => {
    const r = shouldSendDigest({ ...OPEN, hasCredentials: false }, WED_1600_IST);
    expect(r.send).toBe(false);
    expect(r.reason).toMatch(/token|setup/i);
  });

  it("blocks on a weekend, in IST terms", () => {
    // Saturday 2026-09-05 16:00 IST.
    const sat = shouldSendDigest(OPEN, new Date("2026-09-05T10:30:00Z"));
    expect(sat.send).toBe(false);
    expect(sat.reason).toMatch(/weekend/i);
    // 20:00 UTC Friday is already 01:30 IST Saturday — the IST day decides.
    expect(shouldSendDigest(OPEN, new Date("2026-09-04T20:00:00Z")).send).toBe(false);
  });

  it("blocks before the configured send time and opens at it", () => {
    // 15:00 IST = 09:30 UTC.
    expect(shouldSendDigest(OPEN, new Date("2026-09-02T09:30:00Z")).send).toBe(false);
    // 15:35 IST exactly = 10:05 UTC.
    expect(shouldSendDigest(OPEN, new Date("2026-09-02T10:05:00Z")).send).toBe(true);
    // A custom later time is honoured.
    expect(shouldSendDigest({ ...OPEN, sendTime: "20:00" }, WED_1600_IST).send).toBe(false);
    expect(shouldSendDigest({ ...OPEN, sendTime: "20:00" }, new Date("2026-09-02T14:35:00Z")).send).toBe(true);
  });

  it("blocks when today's digest was already sent — the once-per-day guard", () => {
    const r = shouldSendDigest({ ...OPEN, lastSentDate: "2026-09-02" }, WED_1600_IST);
    expect(r.send).toBe(false);
    expect(r.reason).toMatch(/already sent/i);
    // Yesterday's stamp does NOT block — this is the catch-up-on-next-launch.
    expect(shouldSendDigest({ ...OPEN, lastSentDate: "2026-09-01" }, WED_1600_IST).send).toBe(true);
  });

  it("falls back to the 15:35 default on an unparseable send time instead of never sending", () => {
    expect(parseSendTime("banana")).toBeNull();
    expect(parseSendTime("25:00")).toBeNull();
    expect(parseSendTime(DEFAULT_SEND_TIME)).toBe(15 * 60 + 35);
    expect(shouldSendDigest({ ...OPEN, sendTime: "banana" }, WED_1600_IST).send).toBe(true);
    expect(shouldSendDigest({ ...OPEN, sendTime: "banana" }, new Date("2026-09-02T09:30:00Z")).send).toBe(false);
  });
});
