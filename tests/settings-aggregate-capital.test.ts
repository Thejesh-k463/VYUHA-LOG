import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * D-1 — saving Settings from the All-accounts view must not rewrite another
 * account's capital snapshot (invariant 9: 0 is a view, not a place).
 *
 * The shipped bug: `syncOpeningSnapshot()` in app/api/settings/route.ts asked
 * `getWriteAccountId()` for its account. That resolver's no-selection fallback
 * is `orderBy(asc(accounts.id)).limit(1)` — the LOWEST account id. So with
 * `selected_account_id = 0` and two live accounts, POSTing
 * `{type:"settings", equityCapital:777777, activeCapital:333333}` returned
 * 200 "Settings saved." and moved account #1's capital_snapshots rows from
 * 13,00,000 / 4,00,000 to 7,77,777 / 3,33,333. `lib/queries/capital.ts` reads
 * snapshots account-scoped, so account #1 afterwards showed a /cash opening
 * capital that had come from the GLOBAL settings row.
 *
 * The per-account `accounts` write three lines above was already guarded by
 * `selectedForCapital > 0`; these two calls were not.
 *
 * THE JUDGEMENT CALL, pinned here so nobody "fixes" it back: Settings is NOT a
 * per-account screen, so the aggregate view is NOT refused outright the way a
 * challan or a review is. The global row — including its capital columns,
 * which are exactly what `getBucketCapital()` reads back in the aggregate view
 * — saves normally. Only the per-account half (the dated checkpoint) is
 * withheld, and the response says so instead of claiming a checkpoint that was
 * never written.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/settings/route");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

/** Seed defaults (lib/db/seed-core.ts), i.e. what account #1's snapshot holds. */
const SEEDED_EQUITY = 1_300_000;
const SEEDED_ACTIVE = 400_000;
const GO_LIVE = "2026-06-19";

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

/** A complete, valid settings body — every field the zod schema requires. */
function settingsBody(over: Record<string, unknown> = {}) {
  return {
    type: "settings",
    goLiveDate: GO_LIVE,
    equityCapital: SEEDED_EQUITY,
    activeCapital: SEEDED_ACTIVE,
    theme: "dark",
    fyStartMonth: 4,
    defaultBuyOrders: 1,
    defaultSellOrders: 1,
    colorblindSafe: false,
    autoMtmEnabled: false,
    ...over,
  };
}

function req(body: unknown): Request {
  return new Request("http://local/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** capital_snapshots straight out of SQLite, per account + bucket. */
function snapshot(accountId: number, bucket: "equity" | "active") {
  return t.sqlite
    .prepare("select as_of_date as asOfDate, opening_capital as opening, available from capital_snapshots where account_id = ? and bucket = ?")
    .get(accountId, bucket) as { asOfDate: string; opening: number; available: number } | undefined;
}

const settingsRow = () => t.db.select().from(t.schema.settings).all()[0];
const accountRow = (id: number) => t.db.select().from(t.schema.accounts).all().find((a) => a.id === id)!;

beforeAll(async () => {
  t = await openTempDb("settings-aggregate", { seed: true });
  route = await import("@/app/api/settings/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
});

afterAll(() => t?.cleanup());

describe("D-1: the All-accounts view may not move an account's capital snapshot", () => {
  it("the seed put account #1's snapshot where the probe found it", () => {
    expect(snapshot(PRIMARY, "equity")).toMatchObject({ opening: SEEDED_EQUITY, asOfDate: GO_LIVE });
    expect(snapshot(PRIMARY, "active")).toMatchObject({ opening: SEEDED_ACTIVE, asOfDate: GO_LIVE });
  });

  it("saving from the aggregate view leaves account #1's snapshot exactly as it was", async () => {
    selectAccount(ALL);
    const res = await route.POST(req(settingsBody({ equityCapital: 777777, activeCapital: 333333, goLiveDate: "2026-07-01" })));
    expect(res.status).toBe(200);

    // THE assertion. Reverting the `selectedForCapital > 0` guard around the
    // two syncOpeningSnapshot() calls turns both of these into 777777/333333.
    expect(snapshot(PRIMARY, "equity")!.opening).toBe(SEEDED_EQUITY);
    expect(snapshot(PRIMARY, "active")!.opening).toBe(SEEDED_ACTIVE);
    // …and the date is a write too: the guard has to stop that as well.
    expect(snapshot(PRIMARY, "equity")!.asOfDate).toBe(GO_LIVE);

    // Nothing was invented for anyone else either — no snapshot row appeared
    // for the account that was never chosen.
    expect(snapshot(SWING, "equity")).toBeUndefined();
    expect(t.db.select().from(t.schema.capitalSnapshots).all()).toHaveLength(2);
  });

  it("…and says so, instead of a bare success toast for a write that did not happen", async () => {
    selectAccount(ALL);
    const res = await route.POST(req(settingsBody({ equityCapital: 888888, goLiveDate: "2026-07-02" })));
    const json = await res.json();
    expect(json.ok).toBe(true); // the rest of Settings genuinely saved
    expect(json.capitalSnapshotSkipped).toBe(true);
    expect(json.message).toMatch(/All accounts/);
    expect(json.message).toMatch(/pick one in the sidebar/i);
    expect(json.message).not.toBe("Settings saved.");
  });

  it("the rest of the save is untouched — refusing all of Settings would be user-hostile", async () => {
    selectAccount(ALL);
    const res = await route.POST(req(settingsBody({ theme: "light", density: "comfortable", equityCapital: 999999, activeCapital: 111111 })));
    expect(res.status).toBe(200);
    const s = settingsRow();
    expect(s.theme).toBe("light");
    expect(s.density).toBe("comfortable");
    // The GLOBAL capital columns are the aggregate view's own capital source
    // (lib/queries/bucket-capital.ts: `account ?? settings ?? 0`), so these
    // must still move. Only the per-account checkpoint is withheld.
    expect(s.equityCapital).toBe(999999);
    expect(s.activeCapital).toBe(111111);
    // The pre-existing guard on the accounts write still holds: no account
    // took the aggregate view's figure.
    expect(accountRow(PRIMARY).equityCapital).toBeNull();
    expect(accountRow(SWING).equityCapital).toBeNull();
  });

  it("a plain save with no capital or go-live change carries no caveat", async () => {
    selectAccount(ALL);
    const s = settingsRow();
    const res = await route.POST(
      req(settingsBody({ theme: "dark", equityCapital: s.equityCapital, activeCapital: s.activeCapital, goLiveDate: s.goLiveDate })),
    );
    const json = await res.json();
    expect(json.capitalSnapshotSkipped).toBe(false);
    expect(json.message).toBe("Settings saved.");
  });
});

describe("the per-account path still works — the guard must not over-refuse", () => {
  it("a selected account gets its OWN snapshot, and only its own", async () => {
    selectAccount(SWING);
    const res = await route.POST(req(settingsBody({ equityCapital: 555555, activeCapital: 222222, goLiveDate: "2026-08-01" })));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.message).toBe("Settings saved."); // no caveat: the write landed
    expect(json.capitalSnapshotSkipped).toBe(false);

    expect(snapshot(SWING, "equity")).toMatchObject({ opening: 555555, asOfDate: "2026-08-01" });
    expect(snapshot(SWING, "active")).toMatchObject({ opening: 222222, asOfDate: "2026-08-01" });
    expect(accountRow(SWING).equityCapital).toBe(555555);

    // Account #1, the one the broken fallback kept hitting, is still untouched.
    expect(snapshot(PRIMARY, "equity")!.opening).toBe(SEEDED_EQUITY);
    expect(accountRow(PRIMARY).equityCapital).toBeNull();
  });

  it("selecting account #1 and saving moves ITS snapshot — the account is resolved, not guessed", async () => {
    selectAccount(PRIMARY);
    expect((await route.POST(req(settingsBody({ equityCapital: 1_400_000, activeCapital: 450_000, goLiveDate: "2026-09-01" })))).status).toBe(200);
    expect(snapshot(PRIMARY, "equity")).toMatchObject({ opening: 1_400_000, asOfDate: "2026-09-01" });
    expect(snapshot(SWING, "equity")!.opening).toBe(555555); // the neighbour is untouched
  });

  it("an existing snapshot's deployed amount is preserved when the opening moves", () => {
    // Guards the arithmetic the guard now wraps: available = opening - deployed.
    t.db.update(t.schema.capitalSnapshots).set({ deployed: 100_000 }).run();
    selectAccount(PRIMARY);
    return route.POST(req(settingsBody({ equityCapital: 1_500_000, activeCapital: 450_000, goLiveDate: "2026-09-01" }))).then(() => {
      expect(snapshot(PRIMARY, "equity")).toMatchObject({ opening: 1_500_000, available: 1_400_000 });
    });
  });
});

describe("the resolver is no longer reachable from this route at all", () => {
  it("app/api/settings/route.ts does not import getWriteAccountId", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("app/api/settings/route.ts", "utf8"));
    // A source check, because the bug class is "a helper quietly asks the
    // resolver": no call site can regress if the symbol is not imported.
    expect(src).not.toMatch(/^import .*getWriteAccountId/m);
    expect(src).toMatch(/function syncOpeningSnapshot\(accountId: number/);
  });

  it("the stale server-action copy of this logic carries no lowest-id fallback either", async () => {
    // app/settings/actions.ts is an UNREFERENCED duplicate of this route's
    // settings save (verified twice: a tree-wide grep finds no importer, and
    // each of its five exported symbols appears only inside it). It carried
    // D-1 in full — worse, in fact: it has no per-account `accounts` write at
    // all. Deleting it is the correct fix and needs an operator's hand; until
    // then it must not be able to misfile capital if someone wires it up.
    //
    // The test passes once the file is GONE, which is the intended end state.
    const fs = await import("node:fs");
    if (!fs.existsSync("app/settings/actions.ts")) return;
    const src = fs.readFileSync("app/settings/actions.ts", "utf8");
    expect(src).not.toMatch(/^import .*getWriteAccountId/m);
    expect(src).toMatch(/if \(selectedForCapital > 0\)/);
  });
});
