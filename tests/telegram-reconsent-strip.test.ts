import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import {
  TELEGRAM_CARD_HREF,
  TELEGRAM_RECONSENT_COPY,
  TELEGRAM_RECONSENT_DISMISS_KEY,
  TelegramReconsentStrip,
  dismissReconsent,
  dismissedVersion,
  serializeReconsentDismissal,
  shouldShowReconsent,
} from "@/components/system/telegram-reconsent-strip";

/**
 * v4.7.0 C5 — the Telegram re-consent strip (owner answer TG6, design D13,
 * review R5). TELEGRAM_DISCLOSURE 1 → 2 closes the gate for the DIGEST too on
 * every install that accepted v1, so without this strip the digest just stops.
 * Pinned: when it shows, that a dismissal is per VERSION (an older dismissal
 * never hides a newer disclosure), the `{v:1, version}` envelope, the server
 * render emitting nothing (no hydration mismatch), and where it points.
 */

const CURRENT = TELEGRAM_DISCLOSURE.version;

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
const g = globalThis as unknown as { localStorage?: MemoryStorage };
let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  g.localStorage = store;
});
afterEach(() => {
  delete g.localStorage;
});

describe("shouldShowReconsent — the version compare", () => {
  const base = { telegramEnabled: true, ackVersion: 1, currentVersion: CURRENT, dismissed: null };

  it("the disclosure is the NUMBER 2 in this release — the compare is numeric", () => {
    expect(CURRENT).toBe(2);
  });

  it("shows for Telegram ON with an older accepted version", () => {
    expect(shouldShowReconsent(base)).toBe(true);
  });

  it("shows for Telegram ON with no accepted version at all", () => {
    expect(shouldShowReconsent({ ...base, ackVersion: null })).toBe(true);
  });

  it("hides once the current version is accepted (re-accept)", () => {
    expect(shouldShowReconsent({ ...base, ackVersion: CURRENT })).toBe(false);
  });

  it("hides while Telegram is off — nothing is paused that the user had on", () => {
    expect(shouldShowReconsent({ ...base, telegramEnabled: false })).toBe(false);
  });

  it("hides once THIS version was dismissed", () => {
    expect(shouldShowReconsent({ ...base, dismissed: CURRENT })).toBe(false);
  });

  it("a dismissal for an OLDER version does not hide a newer one", () => {
    expect(shouldShowReconsent({ ...base, ackVersion: 1, currentVersion: 3, dismissed: 2 })).toBe(true);
    expect(shouldShowReconsent({ ...base, dismissed: CURRENT - 1 })).toBe(true);
  });
});

describe("the dismissal envelope", () => {
  it("uses a `vyuha-` kebab key and a {v:1, version} envelope (AGENTS.md)", () => {
    expect(TELEGRAM_RECONSENT_DISMISS_KEY).toBe("vyuha-telegram-reconsent-dismissed");
    expect(JSON.parse(serializeReconsentDismissal(2))).toEqual({ v: 1, version: 2 });
  });

  it("dismissReconsent() stores the CURRENT version through writeStored", () => {
    dismissReconsent();
    expect(dismissedVersion(store.getItem(TELEGRAM_RECONSENT_DISMISS_KEY))).toBe(CURRENT);
  });

  it.each([
    ["absent", null],
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a future envelope", JSON.stringify({ v: 2, version: 2 })],
    ["unversioned", JSON.stringify({ version: 2 })],
    ["a string version", JSON.stringify({ v: 1, version: "2" })],
  ])("reads %s as NO dismissal", (_label, raw) => {
    expect(dismissedVersion(raw)).toBeNull();
  });
});

describe("the strip — hydration-safe and pointing at the card", () => {
  it("renders NOTHING on the server, even when it would show — the hydration render agrees", () => {
    const html = renderToString(React.createElement(TelegramReconsentStrip, { telegramEnabled: true, ackVersion: 1 }));
    expect(html).toBe("");
  });

  it("carries the design's sentence word for word and links the real Settings anchor", () => {
    expect(`${TELEGRAM_RECONSENT_COPY.lead} ${TELEGRAM_RECONSENT_COPY.link}`).toBe(
      "Telegram digest paused — the disclosure changed. Review it in Settings.",
    );
    expect(TELEGRAM_CARD_HREF).toBe("/settings#settings-telegram");
    const registry = fs.readFileSync(path.join(process.cwd(), "lib/domain/section-registry.ts"), "utf8");
    expect(registry).toMatch(/id: "settings-telegram"/);
    const page = fs.readFileSync(path.join(process.cwd(), "app/settings/page.tsx"), "utf8");
    expect(page).toMatch(/<Section id="settings-telegram">/);
  });

  it("is mounted in the ROOT layout from the existing settings read, beside the failure note", () => {
    const layout = fs.readFileSync(path.join(process.cwd(), "app/layout.tsx"), "utf8");
    expect(layout).toMatch(/<TelegramReconsentStrip telegramEnabled=\{telegram\.enabled\} ackVersion=\{telegram\.ackVersion\} \/>/);
    // The runner only when both switches are on.
    expect(layout).toMatch(/\{telegram\.enabled && telegram\.alertsEnabled && <TelegramAlertRunner /);
    // No second settings query was added for them.
    expect(layout.match(/getSettings\(\)/g)?.length).toBe(1);
  });

  it("uses text of at least 13 px", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/system/telegram-reconsent-strip.tsx"), "utf8");
    expect(src).not.toMatch(/text-xs|text-\[(?:0\.6|0\.7|1[0-2]px)/);
  });
});
