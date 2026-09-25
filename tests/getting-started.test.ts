import { describe, expect, it } from "vitest";
import {
  BACKUP_TAKEN_KEY,
  GETTING_STARTED_DISMISSED_KEY,
  GETTING_STARTED_STEPS,
  deriveGettingStarted,
  markerJson,
  parseMarker,
  type GettingStartedFacts,
} from "@/lib/domain/getting-started";

/** v4.6.0 W4, row 9.5 — the dashboard's getting-started strip, the pure half. */

const NONE: GettingStartedFacts = { accounts: 0, trades: 0, planSet: false, stopRecorded: false, backupTaken: false };
const ALL: GettingStartedFacts = { accounts: 1, trades: 3, planSet: true, stopRecorded: true, backupTaken: true };

describe("GETTING_STARTED_STEPS", () => {
  it("five steps in order, unique ids, each linking to a real screen path", () => {
    expect(GETTING_STARTED_STEPS.map((s) => s.id)).toEqual(["account", "trades", "plan", "stop", "backup"]);
    for (const s of GETTING_STARTED_STEPS) {
      expect(s.href).toMatch(/^\/[a-z-]*$/);
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.hint, s.id).not.toMatch(/\b(should|must|best|just|simply)\b/i);
    }
  });
});

describe("deriveGettingStarted", () => {
  it("nothing done", () => {
    const v = deriveGettingStarted(NONE);
    expect(v.doneCount).toBe(0);
    expect(v.allDone).toBe(false);
    expect(v.steps.every((s) => !s.done)).toBe(true);
  });

  it("everything done", () => {
    const v = deriveGettingStarted(ALL);
    expect(v.doneCount).toBe(5);
    expect(v.allDone).toBe(true);
  });

  it.each([
    ["account", { accounts: 1 }],
    ["trades", { trades: 1 }],
    ["plan", { planSet: true }],
    ["stop", { stopRecorded: true }],
    ["backup", { backupTaken: true }],
  ] as const)("%s is ticked by its own fact and by nothing else", (id, fact) => {
    const v = deriveGettingStarted({ ...NONE, ...fact });
    expect(v.steps.filter((s) => s.done).map((s) => s.id)).toEqual([id]);
    expect(v.doneCount).toBe(1);
  });

  it("four of five is not all done — the strip stays", () => {
    const v = deriveGettingStarted({ ...ALL, backupTaken: false });
    expect(v.doneCount).toBe(4);
    expect(v.allDone).toBe(false);
    expect(v.steps.find((s) => s.id === "backup")?.done).toBe(false);
  });

  it("zero trades and zero accounts count as not done, never as done", () => {
    expect(deriveGettingStarted({ ...ALL, trades: 0 }).steps.find((s) => s.id === "trades")?.done).toBe(false);
    expect(deriveGettingStarted({ ...ALL, accounts: 0 }).steps.find((s) => s.id === "account")?.done).toBe(false);
  });
});

describe("the localStorage markers ({v:1, at} envelope)", () => {
  it("keys are vyuha- kebab-case", () => {
    expect(BACKUP_TAKEN_KEY).toBe("vyuha-backup-taken");
    expect(GETTING_STARTED_DISMISSED_KEY).toBe("vyuha-getting-started-dismissed");
  });

  it("round-trips", () => {
    expect(JSON.parse(markerJson("2026-09-25T10:00:00.000Z"))).toEqual({ v: 1, at: "2026-09-25T10:00:00.000Z" });
    expect(parseMarker(markerJson("2026-09-25T10:00:00.000Z"))).toEqual({ at: "2026-09-25T10:00:00.000Z" });
  });

  it("any other shape is NO marker — a future version is discarded, not mis-read", () => {
    for (const raw of [null, "", "yes", "1", "{}", '{"v":2,"at":"x"}', '{"v":1}', '{"v":1,"at":""}', '{"v":1,"at":5}', "[1]", "{bad"]) {
      expect(parseMarker(raw), String(raw)).toBeNull();
    }
  });
});
