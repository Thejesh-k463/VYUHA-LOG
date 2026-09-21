import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { BASELINE_SETTINGS_FIELDS, pickBaselineSettings, diffAgainstBaseline, buildBaseline } from "@/lib/domain/settings-baseline";
// PURE (no DB) — safe to import statically beside openTempDb; see its header.
import { SETTINGS_MACHINE_COLUMNS } from "@/lib/backup-format";
import { DEFAULT_SHELF, defaultShelf, serializeShelf } from "@/lib/domain/strategy-shelf";

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
    // onboardingCompletedAt (v3.7): whether THIS install has been through its
    // first run. "Back to my defaults" must not re-run a wizard the user
    // finished, nor mark one finished that they never saw.
    for (const forbidden of ["pnlRolledIn", "licenseKey", "trialStartedAt", "clockHighWaterMark", "lastAutoMtmDate", "selectedAccountId", "goLiveDate", "onboardingCompletedAt", "updatedAt", "id"]) {
      expect(fields, `${forbidden} is state, not a preference`).not.toContain(forbidden);
    }
  });

  it("the option strategy shelf (v4.3, migration 0071) is a preference on BOTH lists", () => {
    // One choice, two lists, and they have to agree: a shelf is a CHOICE about
    // the workspace (like theme and density), so "back to my defaults" returns
    // it AND a backup carries it. Putting it in SETTINGS_MACHINE_COLUMNS would
    // blank it on every dump and reset the user's shelf on every restore, with
    // nothing on screen to say so — which is why the exclusion is pinned here
    // rather than left to the reader of two separate files.
    expect(BASELINE_SETTINGS_FIELDS as readonly string[]).toContain("strategyShelfJson");
    expect(SETTINGS_MACHINE_COLUMNS as readonly string[]).not.toContain("strategyShelfJson");
  });

  it("the dated risk-free pair (v4.4.0 D5, migration 0073) is a preference on BOTH lists", () => {
    // A rate the user chose and the day it was true on: "back to my defaults"
    // returns it and a backup carries it. In SETTINGS_MACHINE_COLUMNS it would
    // be blanked on every dump, and Sharpe would silently fall back to 7%.
    for (const f of ["riskFreeRatePpm", "riskFreeAsOf"]) {
      expect(BASELINE_SETTINGS_FIELDS as readonly string[], f).toContain(f);
      expect(SETTINGS_MACHINE_COLUMNS as readonly string[], f).not.toContain(f);
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
      onboardingCompletedAt: "2026-02-02T00:00:00Z",
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
    // v3.7: a "back to my defaults" must not re-open the first-run wizard.
    expect(after.onboardingCompletedAt).toBe("2026-02-02T00:00:00Z");
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

describe("the shelf field does not manufacture a phantom difference (S-1)", () => {
  // `strategy_shelf_json` has two encodings of the same shelf: null (untouched)
  // and the explicit eight that the shelf route's `restore` writes. Compared by
  // JSON.stringify they differ, so a baseline saved on a fresh install listed
  // `strategyShelfJson` under "Restoring would change:" while a restore would
  // have changed nothing a user can see.
  const base = (shelf: unknown) =>
    buildBaseline({ theme: "dark", strategyShelfJson: shelf }, [], [], []);

  it("null in the baseline vs the explicit default envelope is NOT a change", () => {
    const b = base(null);
    expect(diffAgainstBaseline({ theme: "dark", strategyShelfJson: serializeShelf(defaultShelf()) }, b)).toEqual([]);
    // ...and the other way round, which is what a Restore-defaults leaves behind.
    const b2 = base(serializeShelf(defaultShelf()));
    expect(diffAgainstBaseline({ theme: "dark", strategyShelfJson: null }, b2)).toEqual([]);
  });

  it("a shelf the user really changed IS listed", () => {
    const b = base(null);
    const nine = serializeShelf({ selected: [...DEFAULT_SHELF, "short-strangle"] });
    expect(diffAgainstBaseline({ theme: "dark", strategyShelfJson: nine }, b)).toEqual(["strategyShelfJson"]);
    expect(diffAgainstBaseline({ theme: "dark", strategyShelfJson: serializeShelf({ selected: [] }) }, b)).toEqual([
      "strategyShelfJson",
    ]);
  });

  it("every other field still compares by value", () => {
    const b = base(null);
    expect(diffAgainstBaseline({ theme: "light", strategyShelfJson: null }, b)).toEqual(["theme"]);
  });

  it("names the field in English -- no raw column name reaches the user", () => {
    // FIELD_LABELS is module-local in a client component; the pin reads the
    // source rather than pulling React into a temp-db test file.
    const src = fs.readFileSync(
      path.join(process.cwd(), "components", "settings", "default-settings-card.tsx"),
      "utf8",
    );
    expect(src).toContain('strategyShelfJson: "strategy shelf"');
    for (const f of BASELINE_SETTINGS_FIELDS) {
      expect(src, `${f} would print as a raw column name`).toContain(`${f}:`);
    }
  });
});

/**
 * P12 (v4.3.0 wave-1 re-check): since R7, restoreBaseline re-inserts the
 * snapshot's charge rows and then runs refreshChargeConfig, so charge rows the
 * user never edited follow this build's rate card, not the snapshot. Only the
 * post-restore toast said so; the pre-action copy still promised "all three
 * rate tables back to the snapshot" and "one click brings it all back" — a
 * promise confirmed by the user and not kept by the code.
 */
describe("the restore copy promises only what restoreBaseline does (P12)", () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
  const CLAUSE = "follow this version's rate card";

  it("the card states the rate-card rule before the click, in the toast's words", () => {
    const card = read("components", "settings", "default-settings-card.tsx");
    expect(card).not.toContain("all three rate tables back to the snapshot");
    expect(card).not.toContain("brings it all back");
    expect(card).toContain(CLAUSE);
    // The same clause the restore's own toast carries (settings-baseline.ts).
    expect(read("lib", "queries", "settings-baseline.ts")).toContain(CLAUSE);
  });

  /**
   * N25 (wave-2 re-check): restoreBaseline re-inserts each snapshot row WITH
   * its user_edited flag, and refreshChargeConfig keys on that flag — so
   * "edited" means edited WHEN THE DEFAULTS WERE SAVED. A row edited since then
   * comes back unedited and follows this version's card. The copy said "the
   * charge rows you edited" (now) and "you never edited" (ever).
   *
   * The pin reads the RENDERED constant: the P12 pin matched the clause
   * anywhere in the file, so a comment kept it green while the constant made a
   * different promise. The declaration is matched at the start of a line (a
   * `//` line cannot match) and both JSX surfaces must render it.
   */
  it("the rendered charge-row rule says edited WHEN THE DEFAULTS WERE SAVED, not edited now (N25)", () => {
    const card = read("components", "settings", "default-settings-card.tsx");
    const decl = card.match(/^const CHARGE_ROWS_RULE =\s*"([^"]+)";\s*$/m);
    expect(decl, "the rule is one top-level string constant").not.toBeNull();
    expect(decl![1]).toBe(
      "Charge rows you had edited when these defaults were saved return to those values; rows unedited then follow this version's rate card.",
    );
    // Both pre-action surfaces render it: the header and the confirm line.
    expect(card.match(/\{CHARGE_ROWS_RULE\}/g)?.length).toBe(2);
    // No surface keeps the edited-now wording beside it.
    for (const stale of ["charge rows you edited", "your edited charge rows", "you never edited", "UNEDITED_CHARGE_ROWS"]) {
      expect(card, stale).not.toContain(stale);
    }
  });

  /**
   * Seam D2 (wave 2R): the toast AFTER the click is restoreBaseline's own
   * message, printed verbatim by the card. It still promised "all three rate
   * tables" back and said "Rate rows you never edited follow this version's
   * rate card" — while a row edited only SINCE the save comes back unedited and
   * follows the card. The toast now carries the card's rule word for word, read
   * from the rendered constant, so the two sentences cannot drift apart again.
   */
  it("the restore toast states the card's charge-row rule, with no 'all three rate tables' promise (D2)", () => {
    const card = read("components", "settings", "default-settings-card.tsx");
    const rule = card.match(/^const CHARGE_ROWS_RULE =\s*"([^"]+)";\s*$/m)![1];
    const res = q.restoreBaseline();
    expect(res.ok).toBe(true);
    expect(res.message).toContain(rule);
    for (const stale of ["all three rate tables", "you never edited"]) {
      expect(res.message, stale).not.toContain(stale);
    }
  });
});

/**
 * v4.4.0 — the two things "back to my defaults" gained with migration 0073.
 *
 * D1, review S3: a baseline captured BEFORE 0073 holds the v1 seed's eight
 * risk rows and no `capScheme`. The restore deletes every `risk_config` row and
 * re-inserts the snapshot's, so without a re-seed the three rows 0073 added
 * (eq_delivery, eq_mtf, future) vanished until the next seed run. The restore
 * now re-seeds them (INSERT OR IGNORE) and re-prices every cap-derived R
 * against the caps it just restored — inside its one transaction.
 *
 * D5: the rate pair returns with a post-0073 baseline, and a pre-0073 one
 * (which never recorded it) leaves the current pair alone.
 */
describe("back to my defaults, after migration 0073", () => {
  const riskKeys = () => t.db.select().from(t.schema.riskConfig).all().map((r) => `${r.scope}:${r.key}`).sort();
  const storeBaseline = (mutate: (b: Record<string, unknown>) => void) => {
    q.saveCurrentAsBaseline();
    const row = t.db.select().from(t.schema.settingsBaseline).get()!;
    const payload = JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>;
    mutate(payload);
    t.db.update(t.schema.settingsBaseline).set({ payload }).run();
  };

  it("S3 — a pre-0073 baseline brings back its caps, re-seeds the three 0073 rows, and re-prices cap-R in the same restore", () => {
    const acct = t.db.select().from(t.schema.accounts).all()[0]!.id;
    const id = t.db
      .insert(t.schema.trades)
      .values({ ...tradeRowFor(acct), segment: "index_option", bucket: "active", netPnl: -2800, riskAmount: 9500, rMultiple: -0.29, riskSource: "cap" })
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const all = riskKeys();
    expect(all).toEqual(expect.arrayContaining(["segment:eq_delivery", "segment:eq_mtf", "segment:future"]));

    // The v4.3 shape: the v1 eight, no capScheme key at all, index_option at 7,000.
    storeBaseline((b) => {
      const rows = (b.riskConfig as Record<string, unknown>[]).filter((r) => !["eq_delivery", "eq_mtf", "future"].includes(String(r.key)));
      for (const r of rows) {
        delete r.capScheme;
        if (r.scope !== "global") r.perTradeMaxLoss = r.key === "index_option" ? 7000 : 9500;
      }
      b.riskConfig = rows;
    });

    expect(q.restoreBaseline().ok).toBe(true);
    expect(riskKeys(), "every row 0073 added is back").toEqual(all);
    const future = t.db.select().from(t.schema.riskConfig).all().find((r) => r.key === "future")!;
    expect([future.perTradeMaxLoss, future.capScheme], "re-seeded as INHERIT").toEqual([null, 1]);
    const legacy = t.db.select().from(t.schema.riskConfig).all().find((r) => r.key === "stock_option")!;
    expect([legacy.perTradeMaxLoss, legacy.capScheme], "the snapshot's own row, legacy reading kept").toEqual([9500, null]);
    const tr = t.db.select().from(t.schema.trades).all().find((r) => r.id === id)!;
    expect([tr.riskAmount, tr.rMultiple, tr.riskSource], "re-priced against the RESTORED index_option cap").toEqual([7000, -0.4, "cap"]);
    t.db.delete(t.schema.trades).run();
  });

  // One restore per `it` (~250 ms each locally, the cost every restore case in this file pays).
  it("the risk-free pair comes back with a post-0073 baseline", () => {
    t.db.update(t.schema.settings).set({ riskFreeRatePpm: 65000, riskFreeAsOf: "2026-09-01" }).run();
    storeBaseline(() => {});
    t.db.update(t.schema.settings).set({ riskFreeRatePpm: 80000, riskFreeAsOf: "2026-09-10" }).run();
    expect(q.baselineDiff().fields).toEqual(expect.arrayContaining(["riskFreeRatePpm", "riskFreeAsOf"]));
    expect(q.restoreBaseline().ok).toBe(true);
    const row = t.db.select().from(t.schema.settings).get()!;
    expect([row.riskFreeRatePpm, row.riskFreeAsOf]).toEqual([65000, "2026-09-01"]);
  });

  it("a pre-0073 baseline (which never recorded the pair) leaves the current pair alone", () => {
    storeBaseline((b) => {
      const s = b.settings as Record<string, unknown>;
      delete s.riskFreeRatePpm;
      delete s.riskFreeAsOf;
    });
    t.db.update(t.schema.settings).set({ riskFreeRatePpm: 80000, riskFreeAsOf: "2026-09-10" }).run();
    expect(q.baselineDiff().fields, "a field the baseline predates is never a difference").not.toContain("riskFreeRatePpm");
    expect(q.restoreBaseline().ok).toBe(true);
    const row = t.db.select().from(t.schema.settings).get()!;
    expect([row.riskFreeRatePpm, row.riskFreeAsOf]).toEqual([80000, "2026-09-10"]);
    t.db.update(t.schema.settings).set({ riskFreeRatePpm: 70000, riskFreeAsOf: null }).run();
  });
});

function tradeRowFor(accountId: number) {
  return {
    accountId, broker: "dhan", bucket: "equity", segment: "eq_delivery", instrumentType: "option", exchange: "NSE",
    symbol: "NIFTY", tradingsymbol: "OPT NIFTY 29 Oct 2026 25000 CE", dedupHash: `baseline-s3-${accountId}`, isOpen: false,
  };
}
