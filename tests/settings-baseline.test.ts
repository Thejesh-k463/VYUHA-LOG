import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { BASELINE_SETTINGS_FIELDS, pickBaselineSettings, diffAgainstBaseline, buildBaseline } from "@/lib/domain/settings-baseline";

/**
 * "My Default Settings". The property that matters most: a restore returns
 * CHOICES and never rewrites FACTS or STATE — licence, trial, the clock
 * ratchet, rolled-in P&L, the selected account and the go-live date must
 * survive any restore byte-for-byte.
 */

let t: TempDb;
let q: typeof import("@/lib/queries/settings-baseline");

beforeAll(async () => {
  t = await openTempDb("baseline", { seed: true });
  q = await import("@/lib/queries/settings-baseline");
});

afterAll(() => t?.cleanup());

describe("the preference/state split (pure)", () => {
  it("never includes state or fact fields", () => {
    const fields = BASELINE_SETTINGS_FIELDS as readonly string[];
    for (const forbidden of ["pnlRolledIn", "licenseKey", "trialStartedAt", "clockHighWaterMark", "lastAutoMtmDate", "selectedAccountId", "goLiveDate", "updatedAt", "id"]) {
      expect(fields, `${forbidden} is state, not a preference`).not.toContain(forbidden);
    }
  });

  it("picks only baseline fields from a full row", () => {
    const picked = pickBaselineSettings({ theme: "dark", licenseKey: "SECRET", pnlRolledIn: 999, equityCapital: 100 });
    expect(picked.theme).toBe("dark");
    expect(picked.equityCapital).toBe(100);
    expect("licenseKey" in picked).toBe(false);
    expect("pnlRolledIn" in picked).toBe(false);
  });

  it("diff reports exactly the changed preference fields", () => {
    const b = buildBaseline({ theme: "dark", accentSkin: "terminal", equityCapital: 100 }, [], [], []);
    expect(diffAgainstBaseline({ theme: "light", accentSkin: "terminal", equityCapital: 100 }, b)).toEqual(["theme"]);
    expect(diffAgainstBaseline({ theme: "dark", accentSkin: "terminal", equityCapital: 100 }, b)).toEqual([]);
  });
});

describe("capture and restore (integration)", () => {
  it("captures lazily on first read, from whatever the app is running with", () => {
    t.db.update(t.schema.settings).set({ theme: "dark", accentSkin: "tape" }).run();
    const b = q.getBaseline();
    expect(b).not.toBeNull();
    expect(b!.settings.accentSkin).toBe("tape");
    expect(b!.chargeConfig.length).toBeGreaterThan(0); // seeded rate table came along
  });

  it("restore returns changed preferences to the baseline", () => {
    t.db.update(t.schema.settings).set({ theme: "light", accentSkin: "ice", colorblindSafe: true }).run();
    const res = q.restoreBaseline();
    expect(res.ok).toBe(true);
    const row = t.db.select().from(t.schema.settings).get()!;
    expect(row.theme).toBe("dark");
    expect(row.accentSkin).toBe("tape");
    expect(row.colorblindSafe).toBe(false);
  });

  it("restore NEVER touches state: licence, trial, ratchet, P&L, account, go-live", () => {
    const before = t.db.select().from(t.schema.settings).get()!;
    t.db.update(t.schema.settings).set({
      licenseKey: "VYUHA-keep.me",
      trialStartedAt: "2026-01-01T00:00:00Z",
      clockHighWaterMark: "2026-08-06T00:00:00Z",
      pnlRolledIn: 12345.67,
      selectedAccountId: 1,
      theme: "light", // a real preference change, so the restore does something
    }).run();

    const res = q.restoreBaseline();
    expect(res.ok).toBe(true);

    const after = t.db.select().from(t.schema.settings).get()!;
    expect(after.theme).toBe("dark");                                  // preference restored
    expect(after.licenseKey).toBe("VYUHA-keep.me");                    // state untouched
    expect(after.trialStartedAt).toBe("2026-01-01T00:00:00Z");
    expect(after.clockHighWaterMark).toBe("2026-08-06T00:00:00Z");
    expect(after.pnlRolledIn).toBe(12345.67);
    expect(after.selectedAccountId).toBe(1);
    expect(after.goLiveDate).toBe(before.goLiveDate);
  });

  it("restore returns edited rate tables to the snapshot, atomically", () => {
    const first = t.db.select().from(t.schema.chargeConfig).all()[0];
    t.db.update(t.schema.chargeConfig).set({ brokerageFlat: 999 }).run();
    expect(t.db.select().from(t.schema.chargeConfig).all()[0].brokerageFlat).toBe(999);

    const res = q.restoreBaseline();
    expect(res.ok).toBe(true);

    const rows = t.db.select().from(t.schema.chargeConfig).all();
    expect(rows.length).toBeGreaterThan(0);
    const restored = rows.find((r) => r.broker === first.broker && r.segment === first.segment && r.exchange === first.exchange);
    expect(restored?.brokerageFlat).toBe(first.brokerageFlat);
  });

  it("saving current as the default replaces the baseline", () => {
    t.db.update(t.schema.settings).set({ theme: "light" }).run();
    const res = q.saveCurrentAsBaseline();
    expect(res.ok).toBe(true);

    // Change again, restore — it should come back to the NEW baseline.
    t.db.update(t.schema.settings).set({ theme: "dark" }).run();
    q.restoreBaseline();
    expect(t.db.select().from(t.schema.settings).get()!.theme).toBe("light");
  });

  it("diff names what a restore would change, and the snapshot date", () => {
    q.saveCurrentAsBaseline();
    t.db.update(t.schema.settings).set({ accentSkin: "terminal", fyStartMonth: 1 }).run();
    const d = q.baselineDiff();
    expect(d.fields.sort()).toEqual(["accentSkin", "fyStartMonth"]);
    expect(d.capturedAt).toBeTruthy();
    expect(d.rateRows).toBeGreaterThan(0);
  });
});
