import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { telegramCardView } from "@/lib/telegram/card-state";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";

/**
 * The settings Telegram card's render matrix, pinned as a pure state machine
 * (lib/telegram/card-state.ts) plus source guards on the JSX wiring — the
 * render-windowing.test.ts tool, because the suite runs in a node environment
 * and mounting the component is not the house style.
 *
 * The load-bearing rule: DELETING A STORED CREDENTIAL MUST NEVER REQUIRE
 * ACCEPTING A DISCLOSURE. The card once rendered "Disconnect & delete token"
 * only inside the enabled+acked status block, so disabled-but-connected (and
 * stale-ack-but-connected) installs kept the bot token stored with no path to
 * delete it short of re-consenting.
 */

const CURRENT = TELEGRAM_DISCLOSURE.version;

describe("telegramCardView — the full matrix", () => {
  const cases: {
    name: string;
    enabled: boolean;
    ackVersion: number | null;
    connected: boolean;
    expect: { ackStale: boolean; showSetup: boolean; showStatus: boolean; showDisconnect: boolean; showDisconnectStandalone: boolean };
  }[] = [
    {
      name: "off, never acked, not connected — bare switch only",
      enabled: false, ackVersion: null, connected: false,
      expect: { ackStale: false, showSetup: false, showStatus: false, showDisconnect: false, showDisconnectStandalone: false },
    },
    {
      name: "on + current ack, not connected — setup block",
      enabled: true, ackVersion: CURRENT, connected: false,
      expect: { ackStale: false, showSetup: true, showStatus: false, showDisconnect: false, showDisconnectStandalone: false },
    },
    {
      name: "on + current ack + connected — full status block (its disconnect suffices)",
      enabled: true, ackVersion: CURRENT, connected: true,
      expect: { ackStale: false, showSetup: false, showStatus: true, showDisconnect: true, showDisconnectStandalone: false },
    },
    {
      name: "DISABLED but connected — the token must still be deletable",
      enabled: false, ackVersion: CURRENT, connected: true,
      expect: { ackStale: false, showSetup: false, showStatus: false, showDisconnect: true, showDisconnectStandalone: true },
    },
    {
      name: "on with a STALE ack + connected — deleting must not require re-consent",
      enabled: true, ackVersion: CURRENT + 1, connected: true,
      expect: { ackStale: true, showSetup: false, showStatus: false, showDisconnect: true, showDisconnectStandalone: true },
    },
    {
      name: "on with NO ack + connected — same rule",
      enabled: true, ackVersion: null, connected: true,
      expect: { ackStale: true, showSetup: false, showStatus: false, showDisconnect: true, showDisconnectStandalone: true },
    },
    {
      name: "off, acked earlier, not connected — nothing extra",
      enabled: false, ackVersion: CURRENT, connected: false,
      expect: { ackStale: false, showSetup: false, showStatus: false, showDisconnect: false, showDisconnectStandalone: false },
    },
    {
      name: "on with a stale ack, not connected — warning only, no setup while unread",
      enabled: true, ackVersion: CURRENT + 1, connected: false,
      expect: { ackStale: true, showSetup: false, showStatus: false, showDisconnect: false, showDisconnectStandalone: false },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(telegramCardView({ enabled: c.enabled, ackVersion: c.ackVersion, connected: c.connected })).toEqual(c.expect);
    });
  }

  it("showDisconnect is keyed on `connected` ALONE — every enabled/ack combination", () => {
    for (const enabled of [true, false]) {
      for (const ackVersion of [null, 0, CURRENT, CURRENT + 1]) {
        for (const connected of [true, false]) {
          const v = telegramCardView({ enabled, ackVersion, connected });
          expect(v.showDisconnect, `enabled=${enabled} ack=${ackVersion} connected=${connected}`).toBe(connected);
          // And the affordance is actually ON SCREEN: standalone exactly when
          // the status block (which carries its own disconnect) is not.
          expect(v.showDisconnectStandalone).toBe(connected && !v.showStatus);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Source guards: the machine must be what the JSX renders from, and the card
// copy must stay truthful about WHEN a digest goes out (the runner fires at
// launch only — there is no in-app scheduler).
// ---------------------------------------------------------------------------

const root = path.resolve(__dirname, "..");
const cardSrc = readFileSync(path.join(root, "components/settings/telegram-card.tsx"), "utf8");

describe("telegram-card.tsx wiring and copy", () => {
  it("renders its sections from telegramCardView, not from re-derived JSX conditions", () => {
    expect(cardSrc).toContain("telegramCardView");
    expect(cardSrc).toContain("view.showSetup");
    expect(cardSrc).toContain("view.showStatus");
    expect(cardSrc).toContain("view.showDisconnectStandalone");
  });

  it("carries the standalone disconnect affordance", () => {
    expect(cardSrc).toContain("telegram-disconnect-standalone");
  });

  it("states the launch-time truth — no 'while the app is open' scheduler claim", () => {
    // The runner fires ONLY at launch; a day the app never runs after the send
    // time gets no digest. The old copy claimed a digest 'at your chosen time
    // while the app is open', which the code has never done.
    expect(cardSrc).toContain("at the first launch of the app after your chosen time");
    expect(cardSrc).toContain("A day the app never");
    expect(cardSrc).not.toContain("while the app is open");
  });
});
