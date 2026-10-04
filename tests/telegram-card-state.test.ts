import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { telegramAlertsCardView, telegramCardView } from "@/lib/telegram/card-state";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import { SETTINGS_REFUSALS, type AlertRefusal } from "@/lib/telegram/alert-gate";
import { ALERT_FEED_SCOPE, ALERT_STATUS_COPY, alertStatusLine, alertWindowError } from "@/components/settings/telegram-card";

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

  it("is titled for both Telegram paths, not the digest alone (v4.7.0 C5)", () => {
    expect(cardSrc).toContain("Alerts — Telegram\n");
    expect(cardSrc).not.toContain("Alerts — Telegram EOD digest");
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

// ---------------------------------------------------------------------------
// v4.7.0 C5 — the "Stop / target alerts" section (design D11, review R4/R8).
// The view is A1's (lib/telegram/card-state.ts); the copy and the wiring are
// the card's. The status line is keyed on the server's reason CODE, so the
// card and the gate cannot drift into two vocabularies — every code the gate
// (and the job's own `feed-error`) can answer has exactly one line.
// ---------------------------------------------------------------------------

const gateSrc = readFileSync(path.join(root, "lib/telegram/alert-gate.ts"), "utf8");
const jobSrc = readFileSync(path.join(root, "lib/jobs/telegram-alerts.ts"), "utf8");

/** The AlertRefusal union, read out of the gate's SOURCE — not a hand-typed copy. */
function refusalCodes(): string[] {
  const block = /export type AlertRefusal =([\s\S]*?);/.exec(gateSrc);
  expect(block, "AlertRefusal is no longer a union type in alert-gate.ts").not.toBeNull();
  return [...block![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

const base = { enabled: true, ackVersion: CURRENT, connected: true, pro: true, alertsEnabled: true, windowFrom: null, windowTo: null };

describe("telegramAlertsCardView — the section's matrix", () => {
  it("renders only beside the digest's status block (Telegram on, ack current, connected)", () => {
    expect(telegramAlertsCardView(base).showAlertsSection).toBe(true);
    expect(telegramAlertsCardView({ ...base, enabled: false }).showAlertsSection).toBe(false);
    expect(telegramAlertsCardView({ ...base, ackVersion: CURRENT - 1 }).showAlertsSection).toBe(false);
    expect(telegramAlertsCardView({ ...base, connected: false }).showAlertsSection).toBe(false);
  });

  it("a free licence: locked, cannot switch ON, and the status is the Pro line whatever the runner said", () => {
    const v = telegramAlertsCardView({ ...base, pro: false, alertsEnabled: false, lastRefusal: "market-closed" });
    expect(v).toMatchObject({ proLocked: true, canEnable: false, status: "not-pro" });
    expect(alertStatusLine(v.status)).toBe(ALERT_STATUS_COPY["not-pro"]);
    expect(ALERT_STATUS_COPY["not-pro"]).toMatch(/\bPro\b/);
  });

  it("Pro: armed reads no status; a refusal reads its code; alerts OFF reads none", () => {
    expect(telegramAlertsCardView({ ...base, lastRefusal: null }).status).toBeNull();
    expect(telegramAlertsCardView({ ...base, lastRefusal: "end-of-day-feed" }).status).toBe("end-of-day-feed");
    expect(telegramAlertsCardView({ ...base, alertsEnabled: false, lastRefusal: "market-closed" }).status).toBeNull();
  });

  it("the window is both ends or nothing", () => {
    expect(telegramAlertsCardView({ ...base, windowFrom: "10:00", windowTo: "14:00" }).window).toEqual({ from: "10:00", to: "14:00" });
    expect(telegramAlertsCardView({ ...base, windowFrom: "10:00", windowTo: null }).window).toBeNull();
  });
});

describe("the ONE status line — every reason code has its own sentence", () => {
  it("covers every AlertRefusal in the gate's source, plus the job's feed-error, and nothing else", () => {
    expect(jobSrc).toMatch(/AlertRunRefusal = AlertRefusal \| "feed-error"/);
    const expected = [...refusalCodes(), "feed-error"].sort();
    expect(Object.keys(ALERT_STATUS_COPY).sort()).toEqual(expected);
    for (const code of expected) expect(alertStatusLine(code), code).toBeTruthy();
    // The settings refusals are a subset — the card can render each.
    for (const code of SETTINGS_REFUSALS) expect(ALERT_STATUS_COPY[code as AlertRefusal]).toBeTruthy();
  });

  it.each([
    ["end-of-day-feed", /Settings → Live feed/],
    ["end-of-day-feed", /live feed/i],
    // The GENERIC line (no detail held) names BOTH screens and asserts no cause (D-C5-1).
    ["feed-reaccept", /Settings → Integrations/],
    ["feed-reaccept", /Settings → Live feed/],
    ["ack-stale", /accept the updated Telegram disclosure above/i],
    ["calendar-unverified", /market calendar has run out/i],
    ["not-pro", /part of Vyuha Pro/],
  ] as const)("%s says %s", (code, re) => {
    expect(ALERT_STATUS_COPY[code]).toMatch(re);
  });

  it("feed-reaccept never blames the user's pick as end-of-day (R4)", () => {
    expect(ALERT_STATUS_COPY["feed-reaccept"]).not.toMatch(/end-of-day/i);
  });

  it("feed-reaccept: the generic line asserts no cause; the door's detail replaces it; other codes ignore a detail (D-C5-1)", () => {
    expect(ALERT_STATUS_COPY["feed-reaccept"]).not.toMatch(/disclosure changed/i);
    const detail = "The OpenAlgo integration is off. Turn it on in Settings → Integrations after reading what it does.";
    expect(alertStatusLine("feed-reaccept", detail)).toBe(`Paused — ${detail}`);
    expect(alertStatusLine("feed-reaccept", null)).toBe(ALERT_STATUS_COPY["feed-reaccept"]);
    expect(alertStatusLine("feed-reaccept", "")).toBe(ALERT_STATUS_COPY["feed-reaccept"]);
    expect(alertStatusLine("market-closed", detail)).toBe(ALERT_STATUS_COPY["market-closed"]);
  });

  it("an unknown code reads as nothing rather than a raw code", () => {
    expect(alertStatusLine("some-future-code")).toBeNull();
    expect(alertStatusLine(null)).toBeNull();
  });

  it("carries no prescriptive language", async () => {
    const { PRESCRIPTIVE_LANGUAGE } = await import("@/lib/intelligence/insight");
    for (const line of [...Object.values(ALERT_STATUS_COPY), ALERT_FEED_SCOPE]) {
      expect(line, line).not.toMatch(PRESCRIPTIVE_LANGUAGE);
    }
  });
});

describe("the window form mirrors the route's checks", () => {
  it.each([
    ["", "", null],
    ["10:00", "14:00", null],
    ["14:00", "10:00", "not before"],
    ["10:00", "10:00", "not before"],
    ["10:00", "", "HH:MM"],
    ["9.15", "14:00", "HH:MM"],
  ])("%s → %s", (from, to, err) => {
    const got = alertWindowError(from, to);
    if (err === null) expect(got).toBeNull();
    else expect(got).toContain(err);
  });
});

describe("telegram-card.tsx — the alerts wiring", () => {
  it("renders the section from telegramAlertsCardView and the runner's stored status — derived, never mirrored", () => {
    expect(cardSrc).toContain("telegramAlertsCardView");
    expect(cardSrc).toContain("alertsView?.showAlertsSection");
    expect(cardSrc).toMatch(/parseTelegramAlertStatus\(useStoredValue\(TELEGRAM_ALERT_STATUS_KEY\)\)/);
    expect(cardSrc).not.toMatch(/useEffect/);
  });

  it("writes through the route — alerts-toggle and alerts-window — never a server action", () => {
    expect(cardSrc).toMatch(/action: "alerts-toggle", enabled: Boolean\(v\)/);
    expect(cardSrc).toMatch(/action: "alerts-window"/);
    expect(cardSrc).toContain("router.refresh()");
    expect(cardSrc).not.toMatch(/["']use server["']/);
  });

  it("a free licence cannot switch the toggle ON from the card (the server 403s anyway)", () => {
    expect(cardSrc).toMatch(/disabled=\{pending \|\| \(!alertsView\.alertsOn && !alertsView\.canEnable\)\}/);
    expect(cardSrc).toContain('data-testid="telegram-alerts-pro"');
  });

  it("carries R8's equities-only fact on the CARD, verbatim", () => {
    expect(ALERT_FEED_SCOPE).toBe(
      "Upstox and Angel One price equities only, so alerts on futures and options need the OpenAlgo bridge; commodity and currency positions never alert.",
    );
    expect(cardSrc).toContain("{ALERT_FEED_SCOPE}");
  });

  it("new alerts copy is ≥ 13 px — no text-xs or smaller inside the section", () => {
    const start = cardSrc.indexOf('data-testid="telegram-alerts"');
    const end = cardSrc.indexOf("Deleting a stored credential must NEVER");
    expect(start).toBeGreaterThan(-1);
    const section = cardSrc.slice(start, end);
    expect(section).not.toMatch(/text-xs|text-\[(?:0\.6|0\.7|1[0-2]px)/);
  });
});
