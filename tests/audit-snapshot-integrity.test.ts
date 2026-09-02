import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { diffFields } from "@/lib/analytics/audit-diff";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * W2 — the recordAudit before/after KEY-SET asymmetry, on the paths where the
 * lie is unrecoverable.
 *
 * `lib/analytics/audit-diff.ts` diffs the UNION of the two key sets and
 * normalises a missing key to `null`; `app/audit/page.tsx` passes no field
 * allow-list, so the whole union reaches the screen. A key present on ONE side
 * therefore renders as a change that never happened — and a written column
 * absent from BOTH sides renders as nothing at all.
 *
 * The three sites fixed here:
 *
 *   W2-1  lib/queries/account-delete.ts — weekly-review merge collision.
 *         `after` was {weekStart, appendedFrom, appended}, two of which are not
 *         columns, against a full-row `before`: NINE false rows, including
 *         `note: "TARGET PROSE…" → —` and `completedAt: … → —`. The row had
 *         kept both. docs/DECISIONS.md 2026-09-02, on this exact path: "A
 *         sentence the user wrote is never dropped."
 *
 *   W2-2  lib/queries/account-delete.ts — b/f-loss lot merge collision, the
 *         same shape on a TAX CARRY-FORWARD record. `amount` legitimately does
 *         not move when the target's lot is the larger one, so the only real
 *         change is the row gaining the merge-provenance sentence — and that
 *         was the one thing the log did not carry.
 *
 *   W2-3  app/api/settings/route.ts — charge-rate edit. The write coalesces
 *         (`?? 0`, `?? 0.18`); the snapshot re-derived the same inputs WITHOUT
 *         the coalesce, passed no `before`, and covered 3 of the 12 written
 *         columns. Clearing the STT box stored `"sttPct": null` beside a row
 *         holding 0, and reported two rates that never moved.
 *
 * These assert the DIFF ITSELF as a whole array, so a PHANTOM row fails the
 * test just as loudly as a missing one, and every audit row is compared
 * against the row it claims to describe, read back out of SQLite.
 *
 * ONE temp database per FILE (tests/helpers/temp-db.ts) — the merge blocks run
 * first and use their own account ids; the charge block uses its own rate row.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let mod: typeof import("@/lib/queries/account-delete");
let route: typeof import("@/app/api/settings/route");

const SOURCE = 20;
const TARGET = 21;

/** Week both accounts reviewed, source carrying prose — the append path. */
const WEEK_BOTH = "2026-08-24";
/** Week both accounts reviewed, source note blank — the no-op path. */
const WEEK_BOTH_BLANK = "2026-08-31";
/** Week only the source reviewed — it just MOVES, and audits nothing. */
const WEEK_SOURCE_ONLY = "2026-09-07";

const TARGET_PROSE = "TARGET PROSE: I sized down after Tuesday.";
const SOURCE_PROSE = "SOURCE PROSE: cut the loser at the plan level.";

beforeAll(async () => {
  t = await openTempDb("audit-snap", { seed: true });
  mod = await import("@/lib/queries/account-delete");
  route = await import("@/app/api/settings/route");
});

afterAll(() => t?.cleanup());

const auditRows = () => t.db.select().from(t.schema.auditLog).all();
/** The one audit row for an entity + id, asserted unique so a stale row cannot pass. */
function auditFor(entity: string, entityId: number) {
  const rows = auditRows().filter((r) => r.entity === entity && r.entityId === entityId);
  expect(rows).toHaveLength(1);
  return rows[0];
}
const weeklyById = (id: number) => t.db.select().from(t.schema.weeklyReviews).all().find((r) => r.id === id)!;
const bfById = (id: number) => t.db.select().from(t.schema.bfLossLots).all().find((r) => r.id === id)!;

/** The rule itself: both sides describe the SAME columns, or the diff invents rows. */
function expectSameKeySets(row: { beforeJson: Record<string, unknown> | null; afterJson: Record<string, unknown> | null }) {
  expect(Object.keys(row.afterJson ?? {}).sort()).toEqual(Object.keys(row.beforeJson ?? {}).sort());
}

describe("W2-1/W2-2 — the merge audit describes the row that survived", () => {
  let weeklyBothId = 0;
  let weeklyBlankId = 0;
  let weeklySourceOnlyId = 0;
  let bfCollisionId = 0;
  let bfMovedId = 0;
  let weeklyBothBefore: ReturnType<typeof weeklyById>;
  let weeklyBlankBefore: ReturnType<typeof weeklyById>;
  let bfBefore: ReturnType<typeof bfById>;

  beforeAll(() => {
    t.db.insert(t.schema.accounts).values([
      { id: SOURCE, name: "Merge-Source" },
      { id: TARGET, name: "Merge-Target" },
    ]).run();

    const weekly = (v: Record<string, unknown>) =>
      t.db.insert(t.schema.weeklyReviews).values(v as never).returning({ id: t.schema.weeklyReviews.id }).get().id;

    // The collision the probe was run against: the TARGET's row is complete,
    // scored, and carries the user's own sentence.
    weeklyBothId = weekly({
      accountId: TARGET,
      weekStart: WEEK_BOTH,
      note: TARGET_PROSE,
      completedAt: "2026-08-31T05:00:00.000Z",
      scoreAtCompletion: 71,
    });
    weekly({ accountId: SOURCE, weekStart: WEEK_BOTH, note: SOURCE_PROSE });

    // Same collision, source note blank — the branch that writes NOTHING.
    weeklyBlankId = weekly({ accountId: TARGET, weekStart: WEEK_BOTH_BLANK, note: "kept as-is", completedAt: null });
    weekly({ accountId: SOURCE, weekStart: WEEK_BOTH_BLANK, note: "   " });

    // Non-collision: the source's own week, which simply moves.
    weeklySourceOnlyId = weekly({ accountId: SOURCE, weekStart: WEEK_SOURCE_ONLY, note: "only the source reviewed this week" });

    const bf = (v: Record<string, unknown>) =>
      t.db.insert(t.schema.bfLossLots).values(v as never).returning({ id: t.schema.bfLossLots.id }).get().id;

    // The tax record: the TARGET holds the larger lot, so `amount` will not
    // move — the merge-provenance sentence is the only thing that changes.
    bfCollisionId = bf({ accountId: TARGET, incurredFy: "2022-23", head: "stcl", amount: 50000, originalAmount: 90000, note: "as filed" });
    bf({ accountId: SOURCE, incurredFy: "2022-23", head: "stcl", amount: 40000, originalAmount: 60000, note: "source lot" });
    // Non-collision: moves untouched, and audits nothing.
    bfMovedId = bf({ accountId: SOURCE, incurredFy: "2021-22", head: "ltcl", amount: 12345, originalAmount: null, note: null });

    weeklyBothBefore = weeklyById(weeklyBothId);
    weeklyBlankBefore = weeklyById(weeklyBlankId);
    bfBefore = bfById(bfCollisionId);

    const res = mod.deleteAccount({ accountId: SOURCE, mode: "merge", targetId: TARGET, connections: "delete" });
    expect(res.ok).toBe(true);
  });

  it("W2-1 the appended week diffs to the note it gained (and its stamp) — nothing else", () => {
    const row = weeklyById(weeklyBothId);
    // What the DATABASE says happened: the sentence survived and was extended,
    // the completion and the score-THEN are untouched.
    expect(row.note).toContain(TARGET_PROSE);
    expect(row.note).toContain(SOURCE_PROSE);
    expect(row.completedAt).toBe("2026-08-31T05:00:00.000Z");
    expect(row.scoreAtCompletion).toBe(71);

    const a = auditFor("weekly_review", weeklyBothId);
    // THE assertion — whole-array equality. The shipped shape emitted NINE
    // rows here, four of them claiming the row's id, account, prose and
    // completion had been cleared.
    expect(diffFields(a.beforeJson, a.afterJson)).toEqual([
      { field: "note", from: TARGET_PROSE, to: row.note },
      { field: "updatedAt", from: weeklyBothBefore.updatedAt, to: row.updatedAt },
    ]);
    expectSameKeySets(a);
    // …and the snapshot is of the row that exists, not a re-derivation of it.
    expect(a.afterJson).toEqual({ ...weeklyBothBefore, note: row.note, updatedAt: row.updatedAt });
  });

  it("W2-1 a blank source note diffs to NOTHING, because nothing was written", () => {
    const row = weeklyById(weeklyBlankId);
    expect(row.note).toBe("kept as-is");
    expect(row.updatedAt).toBe(weeklyBlankBefore.updatedAt);

    const a = auditFor("weekly_review", weeklyBlankId);
    expect(diffFields(a.beforeJson, a.afterJson)).toEqual([]);
    expectSameKeySets(a);
  });

  it("W2-2 the shared b/f vintage diffs to the provenance sentence — the amount did not move", () => {
    const row = bfById(bfCollisionId);
    expect(row.amount).toBe(50000); // the larger lot survived, never the sum
    expect(row.originalAmount).toBe(90000);
    expect(row.note).toMatch(/verify against the filed return/);

    const a = auditFor("bf_loss", bfCollisionId);
    // The shipped shape reported `incurredFy`, `head` and `note` as CLEARED on
    // a tax carry-forward record, and carried no sign of the one real change.
    expect(diffFields(a.beforeJson, a.afterJson)).toEqual([
      { field: "note", from: "as filed", to: row.note },
      { field: "updatedAt", from: bfBefore.updatedAt, to: row.updatedAt },
    ]);
    expectSameKeySets(a);
    expect(a.afterJson).toEqual({ ...bfBefore, note: row.note, updatedAt: row.updatedAt });
  });

  it("the non-collision path moves the rows and audits nothing about them", () => {
    expect(weeklyById(weeklySourceOnlyId).accountId).toBe(TARGET);
    expect(bfById(bfMovedId)).toMatchObject({ accountId: TARGET, amount: 12345, note: null });
    expect(auditRows().filter((r) => r.entity === "weekly_review" && r.entityId === weeklySourceOnlyId)).toHaveLength(0);
    expect(auditRows().filter((r) => r.entity === "bf_loss" && r.entityId === bfMovedId)).toHaveLength(0);
  });

  it("no audit row this merge wrote carries a key the other side lacks", () => {
    // The class, not the three lines: any row with BOTH sides populated must
    // describe one key set. (Delete rows are before-only by design — an absent
    // `after` is the honest \"the row is gone\", not an asymmetry.)
    const paired = auditRows().filter((r) => r.beforeJson && r.afterJson);
    expect(paired.length).toBeGreaterThan(0);
    for (const r of paired) expectSameKeySets(r);
  });
});

describe("W2-3 — the charge-rate audit records what was persisted", () => {
  const RATE_ID = 9001;
  /** The row's starting rates; also the body's \"unchanged\" values. */
  const START = {
    brokerageFlat: 0,
    brokeragePct: 0.0003,
    brokerageCap: 20,
    brokerageFloor: 0,
    sttPct: 0.001,
    exchangeTxnPct: 0.0000297,
    sebiPct: 0.000001,
    stampPct: 0.000015,
    ipftPct: 0.000001,
    gstPct: 0.18,
    dpCharge: 13.5,
    mtfInterestAnnual: 0.12,
  };

  const body = (over: Record<string, unknown> = {}) => ({ type: "charge", id: RATE_ID, ...START, ...over });
  const req = (b: unknown) =>
    new Request("http://local/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const rateRow = () => t.db.select().from(t.schema.chargeConfig).all().find((r) => r.id === RATE_ID)!;
  const chargeAudits = () => auditRows().filter((r) => r.entity === "charge_config" && r.entityId === RATE_ID);

  beforeAll(() => {
    t.db.insert(t.schema.chargeConfig).values({ id: RATE_ID, broker: "test", segment: "eq_delivery", exchange: "NSE", ...START }).run();
  });

  it("clearing the STT box logs stt 0.001 → 0, and nothing else", async () => {
    const before = rateRow();
    expect((await route.POST(req(body({ sttPct: "" })))).status).toBe(200);

    // The write really repriced the segment.
    const after = rateRow();
    expect(after.sttPct).toBe(0);
    expect(after.userEdited).toBe(true);

    const a = chargeAudits().at(-1)!;
    // The shipped row said NOTHING about STT and reported `brokeragePct: — → 0`
    // and `gstPct: — → 0.18`, neither of which moved.
    expect(diffFields(a.beforeJson, a.afterJson)).toEqual([{ field: "sttPct", from: before.sttPct, to: 0 }]);
    expectSameKeySets(a);
    // …and the stored value is the COALESCED one that reached the column —
    // `after_json` used to literally hold `"sttPct": null` beside a row of 0.
    expect(a.afterJson!.sttPct).toBe(0);
    expect(a.afterJson!.sttPct).not.toBeNull();
    // Every written rate is snapshotted, not 3 of 12.
    expect(Object.keys(a.afterJson!).sort()).toEqual(Object.keys(START).sort());
  });

  it("an ordinary edit logs the rate that moved (and no unchanged ones)", async () => {
    const before = rateRow(); // sttPct is 0 now — the previous test cleared it
    expect((await route.POST(req(body({ sttPct: 0, brokerageFlat: 33 })))).status).toBe(200);

    const after = rateRow();
    expect(after.brokerageFlat).toBe(33);
    expect(after.gstPct).toBe(0.18);

    const a = chargeAudits().at(-1)!;
    // Shipped: two unchanged rates reported and the changed one omitted.
    expect(diffFields(a.beforeJson, a.afterJson)).toEqual([{ field: "brokerageFlat", from: before.brokerageFlat, to: 33 }]);
    expectSameKeySets(a);
    expect(a.beforeJson).toEqual({ ...START, sttPct: 0 });
    expect(a.afterJson).toEqual({ ...START, sttPct: 0, brokerageFlat: 33 });
  });
});
