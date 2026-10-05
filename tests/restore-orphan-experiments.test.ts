// v4.7.0 release audit S-B1 (design review R7): restoring a PRE-4.7 backup — an
// envelope with no `clinic_experiments` key — leaves the table exactly as it was
// (the per-key rule in lib/backup.ts). Its accounts table, though, IS replaced,
// so an OPEN Edge Clinic experiment whose book the backup does not carry was left
// open on an account that no longer exists: counted in no account's view, never
// checkable, and holding the (account, cell) open slot of the partial unique
// index. The restore now abandons it — the C2 rule (`abandoned`, never deleted:
// the hypothesis is the user's own text) — in the same transaction, keeping its
// account_id; the All view still lists it.
//
// One temp database for this file (tests/helpers/temp-db.ts): lib/db caches its
// connection on globalThis, so a second file is a second database.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, type TempDb } from "./helpers/temp-db";

let t: TempDb;
let backup: typeof import("@/lib/backup");
let q: typeof import("@/lib/queries/edge-clinic");

beforeAll(async () => {
  t = await openTempDb("restore-orphan-experiments", { seed: true });
  backup = await import("@/lib/backup");
  q = await import("@/lib/queries/edge-clinic");
});
afterAll(() => t?.cleanup());

type Status = "open" | "checked" | "abandoned";
function experiment(accountId: number, cellKey: string, status: Status = "open"): number {
  return t.db
    .insert(t.schema.clinicExperiments)
    .values({
      accountId,
      cellKey,
      cellLabel: cellKey,
      hypothesis: `my own words about ${cellKey}`,
      startedAt: "2026-09-01",
      targetN: 20,
      status,
      checkedAt: status === "checked" ? "2026-09-20" : null,
    })
    .returning({ id: t.schema.clinicExperiments.id })
    .get().id;
}
const rowOf = (id: number) =>
  t.db.select().from(t.schema.clinicExperiments).where(eq(t.schema.clinicExperiments.id, id)).get();
/** The envelope a pre-4.7 build wrote: everything it knew, and no clinic_experiments key. */
function pre47(dump: ReturnType<typeof backup.dumpDatabase>) {
  const env = { ...dump, tables: { ...dump.tables } };
  delete (env.tables as Record<string, unknown>).clinic_experiments;
  return env;
}
function reset() {
  t.db.delete(t.schema.clinicExperiments).run();
  t.sqlite.prepare("DELETE FROM accounts WHERE id > 1").run();
}

describe("restore of a pre-4.7 envelope abandons the open experiments of accounts it does not carry (S-B1)", () => {
  it("cross-book: the orphan is abandoned (account_id kept), its own book's experiments and closed rows untouched", () => {
    reset();
    // The backup: a journal with only Primary.
    const envelope = pre47(backup.dumpDatabase(false));
    expect((envelope.tables as Record<string, unknown[]>).accounts.map((a) => (a as { id: number }).id)).toEqual([1]);
    // This machine, since: a second book with an experiment open on it, and one on Primary.
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Book B", isDefault: false }).run();
    const orphan = experiment(2, "eq_intraday|setup:S");
    const orphanChecked = experiment(2, "eq_intraday|setup:T", "checked");
    const own = experiment(1, "eq_intraday|setup:S");
    const before = t.db.select().from(t.schema.clinicExperiments).all().length;

    const r = backup.restoreDatabase(envelope);
    expect(r.ok, r.message).toBe(true);

    expect(t.db.select().from(t.schema.accounts).all().map((a) => a.id)).toEqual([1]);
    expect(rowOf(orphan)).toMatchObject({ status: "abandoned", accountId: 2, hypothesis: "my own words about eq_intraday|setup:S" });
    expect(rowOf(orphanChecked)).toMatchObject({ status: "checked", accountId: 2, checkedAt: "2026-09-20" });
    expect(rowOf(own)).toMatchObject({ status: "open", accountId: 1 });
    // Abandoned, never deleted.
    expect(t.db.select().from(t.schema.clinicExperiments).all()).toHaveLength(before);
    // The All view still lists it, as abandoned. (The All view exists only with
    // two live accounts — with one, getSelectedAccountId() resolves 0 to it —
    // so the user's next book is opened first.)
    t.db.insert(t.schema.accounts).values({ id: 3, name: "Book C", isDefault: false }).run();
    t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
    const listed = q.listExperiments().find((e) => e.id === orphan);
    expect(listed, "the All view no longer lists the orphan").toBeDefined();
    expect(listed!.status).toBe("abandoned");
    // Every `it` here is one full restore (data fixes + rate-card refresh):
    // measured 622-851 ms locally (2026-10-05), over the 300 ms budget by the
    // nature of a restore, so 30 s for the >15x slower Windows runner (AGENTS.md
    // Testing) — the same allowance tests/edge-clinic-db.test.ts gives its restore.
  }, 30_000);

  it("same-book: an envelope that carries the experiment's account changes nothing", () => {
    reset();
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Book B", isDefault: false }).run();
    const envelope = pre47(backup.dumpDatabase(false));
    const onB = experiment(2, "eq_intraday|setup:S");
    const onA = experiment(1, "eq_intraday|setup:S");

    const r = backup.restoreDatabase(envelope);
    expect(r.ok, r.message).toBe(true);

    expect(t.db.select().from(t.schema.accounts).all().map((a) => a.id).sort()).toEqual([1, 2]);
    expect(rowOf(onB)).toMatchObject({ status: "open", accountId: 2 });
    expect(rowOf(onA)).toMatchObject({ status: "open", accountId: 1 });
  }, 30_000);

  it("a 4.7 envelope (the key present) is the envelope's truth: its rows are restored as they were", () => {
    reset();
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Book B", isDefault: false }).run();
    const id = experiment(2, "eq_intraday|setup:S");
    const dump = backup.dumpDatabase(false);
    expect(dump.tables.clinic_experiments).toHaveLength(1);
    const r = backup.restoreDatabase(dump);
    expect(r.ok, r.message).toBe(true);
    expect(rowOf(id)).toMatchObject({ status: "open", accountId: 2 });
  }, 30_000);
});
