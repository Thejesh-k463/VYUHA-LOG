import { describe, expect, it } from "vitest";
import {
  CONNECT_PROMPT_VERSION,
  connectPromptDismissal,
  connectPromptKey,
  isConnectPromptDismissed,
  showConnectPrompt,
} from "@/lib/live/connect-prompt";

/**
 * Owner answer Q24 — "Connect your feed — 20 seconds", ON THE DESK, once a day.
 *
 * The shipped v4.1 state honoured neither half: the sentence rendered only on
 * the Settings card, every time the feed was unhealthy, with no day-keyed state
 * anywhere. So the two properties under test are exactly those two: WHEN it may
 * show, and that a dismissal lasts one IST day and no longer.
 */

const DAY = "2026-09-04";

describe("the storage key is per IST day, so a dismissal expires by itself", () => {
  it("is `vyuha-` kebab-case with the day appended", () => {
    expect(connectPromptKey(DAY)).toBe("vyuha-live-connect-prompt:2026-09-04");
  });

  it("gives a DIFFERENT key tomorrow — no sweep, no expiry code", () => {
    expect(connectPromptKey("2026-09-05")).not.toBe(connectPromptKey(DAY));
  });

  it("stores the versioned envelope the project's stored JSON always wears", () => {
    expect(JSON.parse(connectPromptDismissal())).toEqual({ v: 1, dismissed: true });
    expect(CONNECT_PROMPT_VERSION).toBe(1);
  });
});

describe("reading the dismissal back", () => {
  it("reads its own write", () => {
    expect(isConnectPromptDismissed(connectPromptDismissal())).toBe(true);
  });

  it("reads absent, corrupt and wrong-version values as NOT dismissed", () => {
    // Showing a 20-second prompt once more is the cheap failure; suppressing it
    // for ever on a corrupt string is the expensive one.
    for (const raw of [null, undefined, "", "{", "true", '{"dismissed":true}', '{"v":2,"dismissed":true}']) {
      expect(isConnectPromptDismissed(raw), `${String(raw)} must not silence the prompt`).toBe(false);
    }
  });

  it("does not treat a stored `false` as a dismissal", () => {
    expect(isConnectPromptDismissed(JSON.stringify({ v: 1, dismissed: false }))).toBe(false);
  });
});

describe("showConnectPrompt — only the bridge, only the states a reconnect fixes", () => {
  const feed = (over: Partial<{ providerId: string; healthState: string | null }> = {}) => ({
    providerId: "openalgo",
    healthState: "no-key" as string | null,
    ...over,
  });

  it("shows for a saved-but-unconnected bridge", () => {
    expect(showConnectPrompt(feed(), null)).toBe(true);
  });

  it("shows when the bridge is saved but not answering", () => {
    expect(showConnectPrompt(feed({ healthState: "unreachable" }), null)).toBe(true);
  });

  it("stays silent once the day's dismissal is stored", () => {
    expect(showConnectPrompt(feed(), connectPromptDismissal())).toBe(false);
  });

  it("never shows for the end-of-day or typed-marks providers", () => {
    // Neither has a feed to connect, and the desk must not prompt for one.
    expect(showConnectPrompt(feed({ providerId: "eod", healthState: "unreachable" }), null)).toBe(false);
    expect(showConnectPrompt(feed({ providerId: "manual", healthState: "no-key" }), null)).toBe(false);
  });

  it("never shows for a healthy feed, or for an integration the user switched off", () => {
    expect(showConnectPrompt(feed({ healthState: "ok" }), null)).toBe(false);
    expect(showConnectPrompt(feed({ healthState: "disabled" }), null)).toBe(false);
    expect(showConnectPrompt(feed({ healthState: null }), null)).toBe(false);
  });
});
