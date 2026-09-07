import { describe, expect, it } from "vitest";
import {
  CONNECTABLE_PROVIDER_IDS,
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

  it("shows for UPSTOX in the same two states (v4.2)", () => {
    // The Analytics token is a connection the user makes and can remake, so the
    // prompt has somewhere to send them — which is the whole test for whether a
    // provider belongs here.
    expect(showConnectPrompt(feed({ providerId: "upstox" }), null)).toBe(true);
    expect(showConnectPrompt(feed({ providerId: "upstox", healthState: "unreachable" }), null)).toBe(true);
    // …and the same three silences apply to it.
    expect(showConnectPrompt(feed({ providerId: "upstox" }), connectPromptDismissal())).toBe(false);
    expect(showConnectPrompt(feed({ providerId: "upstox", healthState: "ok" }), null)).toBe(false);
    expect(showConnectPrompt(feed({ providerId: "upstox", healthState: "disabled" }), null)).toBe(false);
  });

  it("shows for ANGEL ONE in the same two states (v4.2)", () => {
    // Its daily sign-in is unattended, but the two states that open this prompt
    // are not fixed by waiting for tomorrow: `no-key` means nothing is saved
    // for this account and `unreachable` means what is saved is not answering.
    // Both send the user to Import → Brokers, which is somewhere to go.
    expect(showConnectPrompt(feed({ providerId: "angelone" }), null)).toBe(true);
    expect(showConnectPrompt(feed({ providerId: "angelone", healthState: "unreachable" }), null)).toBe(true);
    expect(showConnectPrompt(feed({ providerId: "angelone" }), connectPromptDismissal())).toBe(false);
    expect(showConnectPrompt(feed({ providerId: "angelone", healthState: "ok" }), null)).toBe(false);
    expect(showConnectPrompt(feed({ providerId: "angelone", healthState: "disabled" }), null)).toBe(false);
  });

  it("names the connectable providers as a value, not as a chain of !==", () => {
    expect([...CONNECTABLE_PROVIDER_IDS].sort()).toEqual(["angelone", "openalgo", "upstox"]);
  });

  it("never shows for the end-of-day or typed-marks providers", () => {
    // Neither has a feed to connect, and the desk must not prompt for one.
    expect(showConnectPrompt(feed({ providerId: "eod", healthState: "unreachable" }), null)).toBe(false);
    expect(showConnectPrompt(feed({ providerId: "manual", healthState: "no-key" }), null)).toBe(false);
  });

  it("never shows for a provider that is only PLANNED — there is nothing to connect yet", () => {
    // `lib/quotes/registry.ts` PLANNED_PROVIDER_IDS. Prompting for a feed the
    // release does not ship is a promise, not a prompt.
    // `angelone` LEFT this list in v4.2 — it ships, so it is connectable.
    for (const id of ["kite", "dhan"]) {
      expect(showConnectPrompt(feed({ providerId: id }), null), id).toBe(false);
    }
  });

  it("never shows for a healthy feed, or for an integration the user switched off", () => {
    expect(showConnectPrompt(feed({ healthState: "ok" }), null)).toBe(false);
    expect(showConnectPrompt(feed({ healthState: "disabled" }), null)).toBe(false);
    expect(showConnectPrompt(feed({ healthState: null }), null)).toBe(false);
  });
});
