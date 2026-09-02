import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DIGEST_NOTIFY_COPY,
  DIGEST_NOTIFY_LAST_KEY,
  DIGEST_NOTIFY_OPTIN_KEY,
  TELEGRAM_FAILURE_KEY,
  TELEGRAM_FAILURE_REASSURANCE,
  digestFailureSignature,
  parseTelegramFailure,
  serializeTelegramFailure,
  shouldRaiseDigestNotification,
  telegramFailureHeadline,
} from "@/lib/domain/telegram-failure";

/**
 * v3.7 §5.3a/b — the durable Telegram-digest failure note, and the strictly
 * opt-in device notification about it.
 *
 * Why this file exists at all: tests/egress-guard.test.ts scans NETWORK
 * constructs, so a local notification does not trip it — and nothing else in
 * the suite looks at this surface. This is its review.
 *
 * The behaviour under guard is easy to regress and invisible when it does:
 * lib/jobs/telegram-digest.ts REVERTS its `last_telegram_sent_date` claim on a
 * failed send (so the next launch retries), which means the database keeps no
 * record that a send ever failed. If the note stops being durable, or stops
 * being mounted in the root layout, the failure silently becomes invisible
 * again on every route but the dashboard — exactly the v3.6 defect.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const NOTE = read("components/system/telegram-failure-note.tsx");
const RUNNER = read("components/system/telegram-runner.tsx");
const LAYOUT = read("app/layout.tsx");

const rec = { date: "2026-09-01", reason: "Telegram returned 401 (unauthorized).", at: "2026-09-01T10:05:00.000Z" };

describe("the stored record", () => {
  it("uses versioned, `vyuha-` prefixed keys (AGENTS.md)", () => {
    expect(TELEGRAM_FAILURE_KEY).toBe("vyuha-telegram-last-failure");
    expect(DIGEST_NOTIFY_OPTIN_KEY).toBe("vyuha-digest-notify");
    expect(DIGEST_NOTIFY_LAST_KEY).toBe("vyuha-digest-last-notified");
    expect(JSON.parse(serializeTelegramFailure(rec)).v).toBe(1);
  });

  it("round-trips, dismissal included", () => {
    expect(parseTelegramFailure(serializeTelegramFailure(rec))).toEqual(rec);
    expect(parseTelegramFailure(serializeTelegramFailure({ ...rec, dismissed: true }))?.dismissed).toBe(true);
    expect(parseTelegramFailure(serializeTelegramFailure(rec))?.dismissed).toBeUndefined();
  });

  it("keeps a null date — a job that never reached a trading day still failed", () => {
    const undated = { date: null, reason: "The digest could not be sent.", at: rec.at };
    expect(parseTelegramFailure(serializeTelegramFailure(undated))).toEqual(undated);
    expect(telegramFailureHeadline(undated)).not.toMatch(/null|undefined/);
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["not JSON", "{"],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a future version", JSON.stringify({ v: 2, ...rec })],
    ["unversioned", JSON.stringify(rec)],
    ["missing its reason", JSON.stringify({ v: 1, date: "2026-09-01", at: rec.at })],
    ["an empty reason", JSON.stringify({ v: 1, date: null, reason: "   ", at: rec.at })],
  ])("reads as NO record when the stored value is %s", (_label, raw) => {
    expect(parseTelegramFailure(raw)).toBeNull();
  });

  it("quotes the job's own reason rather than rewording it", () => {
    expect(telegramFailureHeadline(rec)).toContain(rec.reason);
    expect(telegramFailureHeadline(rec)).toContain("2026-09-01");
  });
});

describe("the device notification is a probe, and strictly opt-in", () => {
  const base = { supported: true, optIn: true, permission: "granted", signature: "a", lastSignature: null };

  it("fires for a new failure once the user has opted in and granted permission", () => {
    expect(shouldRaiseDigestNotification(base)).toBe(true);
  });

  it.each([
    ["the shell exposes no Notification API", { supported: false }],
    ["the user never opted in on this device", { optIn: false }],
    ["permission was never asked for", { permission: "default" }],
    ["permission was denied", { permission: "denied" }],
    ["there is no failure to announce", { signature: "" }],
    ["this exact failure was already announced", { lastSignature: "a" }],
  ])("stays silent when %s", (_label, over) => {
    expect(shouldRaiseDigestNotification({ ...base, ...over })).toBe(false);
  });

  it("re-announces a DIFFERENT failure", () => {
    expect(shouldRaiseDigestNotification({ ...base, signature: "b", lastSignature: "a" })).toBe(true);
  });

  it("identifies a failure by date AND reason", () => {
    expect(digestFailureSignature(rec)).toBe(`${rec.date}|${rec.reason}`);
    expect(digestFailureSignature(null)).toBe("");
    expect(digestFailureSignature({ ...rec, reason: "other" })).not.toBe(digestFailureSignature(rec));
  });

  it("asks for permission ONLY from the button, never from an effect", () => {
    expect(NOTE.match(/requestPermission/g)?.length).toBe(1);
    const fn = NOTE.slice(NOTE.indexOf("async function enableNotifications"));
    expect(fn).toMatch(/requestPermission/);
    expect(fn.slice(0, fn.indexOf("requestPermission"))).not.toMatch(/useEffect/);
    // The opt-in flag is only ever written after a granted permission.
    expect(NOTE).toMatch(/if \(perm === "granted"\)/);
  });

  it("adds no dependency for it — the plugin route is deferred to v3.8", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).filter((d) => /tauri/i.test(d) && d !== "@tauri-apps/cli")).toEqual([]);
    expect(all["tauri-plugin-notification"]).toBeUndefined();
    expect(all["@tauri-apps/api"]).toBeUndefined();
  });

  it("claims nothing about the OS — the capability is INFERRED, not verified", () => {
    for (const s of Object.values(DIGEST_NOTIFY_COPY)) {
      expect(s, s).not.toMatch(/will (?:show|appear|pop|alert)|you will (?:get|see)|always notif/i);
    }
    // It says what Vyuha ASKS for, and what remains true if the ask fails.
    expect(DIGEST_NOTIFY_COPY.note).toMatch(/ask your system for permission/i);
    expect(DIGEST_NOTIFY_COPY.note).toMatch(/this strip stays the record/i);
  });
});

describe("the note is durable and route-independent", () => {
  it("is mounted in the ROOT LAYOUT, not on a page", () => {
    expect(LAYOUT).toMatch(/<TelegramFailureNote \/>/);
    // The v3.6 defect: the outcome rendered only where the runner was mounted.
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === "page.tsx") pages.push(full);
      }
    };
    walk(path.join(ROOT, "app"));
    const leaked = pages.filter((p) => fs.readFileSync(p, "utf8").includes("TelegramFailureNote"));
    expect(leaked, "the failure strip must not be page-mounted").toEqual([]);
  });

  it("reads its record from storage rather than holding it in React state", () => {
    expect(NOTE).toMatch(/useStoredValue\(TELEGRAM_FAILURE_KEY\)/);
    expect(NOTE).not.toMatch(/useState<\s*\{[^}]*reason/);
  });

  it("is written by the digest runner on failure and CLEARED on the next success", () => {
    expect(RUNNER).toMatch(/serializeTelegramFailure\(/);
    expect(RUNNER).toMatch(/writeStored\(TELEGRAM_FAILURE_KEY, null\)/);
    // The failure branch no longer lives in the runner's own state.
    expect(RUNNER).not.toMatch(/failed: (?:true|false)/);
  });

  it("survives a dismissal as a RECORD — dismissing is not resolving", () => {
    const dismissed = parseTelegramFailure(serializeTelegramFailure({ ...rec, dismissed: true }));
    expect(dismissed).not.toBeNull();
    expect(dismissed?.reason).toBe(rec.reason);
    expect(NOTE).toMatch(/dismissed: true/);
  });

  it("keeps the reassurance the v3.6 note carried", () => {
    expect(TELEGRAM_FAILURE_REASSURANCE).toMatch(/Your journal is unaffected/);
    expect(TELEGRAM_FAILURE_REASSURANCE).toMatch(/already on your dashboard/);
    expect(NOTE).toMatch(/TELEGRAM_FAILURE_REASSURANCE/);
  });
});
