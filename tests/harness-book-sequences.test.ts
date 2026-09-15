import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  OPS,
  QTY,
  SYM,
  IPO_NAME,
  checkInvariants,
  describeViolations,
  freshCtx,
  isIncompatible,
  loadBookMods,
  readEnvelope,
  seedSequenceBook,
  snapshotTemplate,
  statementOf,
  type BookCtx,
  type BookMods,
  type SeedIds,
  type Template,
} from "./helpers/book-ops";

/**
 * THE BOOK-SEQUENCE HARNESS (v4.3.0, builder G2).
 *
 * A bounded model-based sweep over the identity subsystem: one small two-account
 * book, fourteen REAL operations, every ordered pair of them, and a curated set
 * of triples taken from this release's own findings. After EVERY step the six
 * invariants in `tests/helpers/book-ops.ts` are checked and must come back
 * empty.
 *
 * WHAT IT GUARDS, and why it is not another seam test. Waves 2H → 2L each fixed
 * a value that one file wrote and another read (the counted-once split, the
 * stated MTF `funded 0`, the `dedup-alias:` identity). `tests/seams-v43-fixF`
 * pins those crossings one at a time, from a clean book. What NOTHING pinned
 * was the SEQUENCE: delete → restore → merge → un-merge, sync → exit edit,
 * close-with-the-recorded-sale → reopen → restore that sale. Each of those
 * steps is correct on its own; the release's re-checks kept finding that the
 * COMPOSITION was not. This file enumerates the compositions.
 *
 *   I1 RECOVERABLE          every fixture sale and purchase exists exactly once
 *                           across journal ∪ Trash, by identity hash and by the
 *                           alias a lot HOLDS — never by id
 *   I2 COUNTED-ONCE         capital, `getTaxBase` and the AIS sale side agree
 *                           with each other in every view, and the aggregate
 *                           view is the sum of its books
 *   I3 BOOK-EQUALS-STATEMENT per symbol, the net quantity is the statement plus
 *                           the deltas the ops declared; no book reads short
 *   I4 NO-ACCOUNT-0         0 is a view, not a place (invariant 9)
 *   I5 PARENT-EQUALS-LEGS   invariant 5, through `parentAggregate`
 *   I6 NO-NAN               no NULL / non-finite in a money column that must be
 *                           stated
 *
 * WHAT IT RUNS: 17 operations; every ordered pair of them — 289 less the 14 the
 * table marks incompatible = 275 — plus each op alone (17), 13 curated
 * sequences of three to five taken from this release's findings, 2 pinned
 * findings and 6 tests that PLANT each invariant's own violation so a green
 * sweep is known to be able to go red. 315 `it`s.
 *
 * ONE temp database for this FILE (AGENTS.md Testing); one migrate, one seed,
 * one fixture build, and a template FILE ATTACHed to the live connection so
 * every scenario starts from the same book (see the header of book-ops.ts for
 * why `new Database(buffer)` cannot be used when the code under test reads the
 * connection `lib/db` caches).
 *
 * A RED CASE IS A FINDING, NEVER A LOOSENED ASSERTION. A sequence that violates
 * an invariant on HEAD is pinned with `it.fails` and a `FINDING G-G2-n` comment
 * naming the violation code, so the pin has to be flipped the day the product is
 * fixed.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  redirect: () => {},
}));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let m: BookMods;
let ids: SeedIds;
let tpl: Template;

// Measured locally 2026-09-15 (vitest's own per-test times, 315 `it`s): this one
// hook — migrate + seed + sixteen product modules + the fixture, which itself
// runs two real imports and the Data Quality one-click — is ~1.8 s (32.4 s wall
// for the file, 30.6 s of it inside the `it`s). The slowest `it` is 211 ms
// ("delete → delete-ipo → restore → restore"), then 204, 181, 172; a pair
// scenario is 90-130 ms (a template copy at ~8 ms, two ops, two invariant
// sweeps at ~45 ms each). All inside the local budget of <= 300 ms per `it` and
// <= 3 s per hook; the raised timeout is for the Windows runner, measured
// > 15x slower on SQLite-file work (AGENTS.md Testing) — which is also why
// `snapshotTemplate` turns fsync off on this throwaway database.
beforeAll(async () => {
  t = await openTempDb("harness-book-sequences", { seed: true });
  m = await loadBookMods();
  ids = await seedSequenceBook(t.db, { t, m });
  tpl = snapshotTemplate(freshCtx(t, m, ids));
}, 180_000);

afterAll(() => t?.cleanup());

/**
 * The whole sequence, from the template, with every step checked.
 *
 * The ONE step that is not re-checked is a `skipped` one, and only after a
 * check has already passed in this scenario: `skipped` means the op found its
 * precondition absent and made no product call at all (see `OpStatus` in
 * book-ops.ts), so the state it leaves is the state the previous check just
 * passed. A `refused` step IS re-checked — a refusal that half-wrote is the
 * defect those refusals exist to prevent.
 */
async function runSequence(names: string[]): Promise<{ ctx: BookCtx; violations: string[] }> {
  tpl.reset();
  const ctx = freshCtx(t, m, ids);
  const violations: string[] = [];
  let checks = 0;
  let step = -1;
  for (const name of names) {
    step += 1;
    const op = OPS.find((o) => o.name === name);
    if (!op) throw new Error(`no such op: ${name}`);
    await op.run(t.db, ctx);
    // A PAIR's first step is exactly one of the single-op cases, asserted clean in its own it above, so the
    // sweep re-checks only after the second step (the orchestrator, 2026-09-15: halves the file's wall clock on the
    // >15x slower Windows runner and loses nothing). Singles and the curated longer sequences check every step.
    if (names.length === 2 && step === 0) continue;
    if (ctx.log.at(-1)?.status === "skipped" && checks > 0) continue;
    const bad = await checkInvariants(t.db, ctx);
    checks += 1;
    if (bad.length > 0) {
      const done = ctx.log.map((l) => `${l.op}[${l.status}]`).join(" → ");
      violations.push(...describeViolations(bad).map((s) => `after ${done}: ${s}`));
      break; // the first broken step IS the finding; anything after it is noise
    }
  }
  return { ctx, violations };
}

const expectClean = async (names: string[]) => {
  const { violations } = await runSequence(names);
  // Joined rather than deep-equalled: a violation's own sentence is what names
  // the finding, and the array form is elided by the reporter.
  expect(violations.join("\n")).toBe("");
};

// ── the fixture itself ───────────────────────────────────────────────────────

describe("the fixture is live", () => {
  it("states the four shapes this release's findings are about, and starts clean", async () => {
    tpl.reset();
    const ctx = freshCtx(t, m, ids);
    const rows = t.db.select().from(t.schema.trades).all();

    // 1 — one closed round trip in EACH book on the SAME dedup hash.
    const dup = rows.filter((r) => r.dedupHash === ids.dupHash);
    expect(dup.map((r) => [r.accountId, r.isOpen, r.buyQty, r.sellQty]).sort()).toEqual([
      [ids.acctA, false, QTY.dup, QTY.dup],
      [ids.acctB, false, QTY.dup, QTY.dup],
    ]);

    // 2 — the Data Quality close shape: the lot HOLDS the sale's identity and
    //     the sale itself is in Trash, recoverable.
    const lot = rows.find((r) => r.id === ids.dqLot)!;
    expect([lot.isOpen, lot.buyQty, lot.sellQty]).toEqual([false, QTY.dq, QTY.dq]);
    expect(m.lots.heldIdentityHashes(lot)).toContain(ids.dqSaleHash);
    expect(rows.some((r) => r.dedupHash === ids.dqSaleHash), "the sale row itself left the journal").toBe(false);
    const snaps = m.trash.listTrashSnapshots();
    expect(snaps.some((s) => readEnvelope(ctx, s.id).trades.some((r) => r.dedupHash === ids.dqSaleHash))).toBe(true);

    // 3 — the IPO record, filed in the holding's OWN book and linked to it.
    const ipo = t.db.select().from(t.schema.ipos).all();
    expect(ipo.map((r) => [r.id, r.accountId, r.tradeId, r.name])).toEqual([[ids.ipoId, ids.acctB, ids.ipoTrade, IPO_NAME]]);

    // 4 — the partly sold MTF row: 100 bought, 40 sold, 60 open, funded 8,000.
    const mtf = rows.find((r) => r.id === ids.mtfTrade)!;
    expect([mtf.isOpen, mtf.buyQty, mtf.sellQty, mtf.mtfFundedAmount]).toEqual([true, QTY.mtfBuy, QTY.mtfSold, 8000]);

    expect(ctx.expectedQty).toEqual(statementOf());
    expect(describeViolations(await checkInvariants(t.db, ctx)).join("\n")).toBe("");
  });

  it("the template really does reset: an op, then a reset, and the book is the fixture again", async () => {
    tpl.reset();
    const before = JSON.stringify(t.db.select().from(t.schema.trades).all());
    const ctx = freshCtx(t, m, ids);
    await OPS.find((o) => o.name === "deleteDupInA1")!.run(t.db, ctx);
    expect(ctx.log.at(-1)!.status, JSON.stringify(ctx.log)).toBe("applied");
    expect(JSON.stringify(t.db.select().from(t.schema.trades).all())).not.toBe(before);
    tpl.reset();
    expect(JSON.stringify(t.db.select().from(t.schema.trades).all())).toBe(before);
    expect(m.trash.listTrashSnapshots().length, "the Trash directory is reset too").toBe(1);
  });
});

// ── the guard falsifies itself ───────────────────────────────────────────────

/**
 * A green sweep is not evidence until each invariant is known to be able to go
 * RED. Every plant below is a RAW write — deliberately not a product path,
 * because the question here is only whether the CHECK fires, never whether the
 * app can reach the state. An invariant that cannot fire is a finding in this
 * file, not a clean bill of health for the product.
 */
describe("each invariant can fire", () => {
  const plant = async (sql: string, ...args: unknown[]) => {
    tpl.reset();
    const ctx = freshCtx(t, m, ids);
    t.sqlite.prepare(sql).run(...(args as never[]));
    return (await checkInvariants(t.db, ctx)).map((v) => v.code);
  };

  it("I1 — a second journal row stating an identity the joined lot already holds", async () => {
    const lot = t.db.select().from(t.schema.trades).all().find((r) => r.id === ids.dqLot)!;
    const codes = await plant(
      `INSERT INTO trades (account_id, broker, bucket, segment, instrument_type, exchange, symbol, tradingsymbol, dedup_hash, buy_qty, sell_qty, is_open)
       VALUES (?, 'zerodha', 'equity', 'eq_delivery', 'equity', 'NSE', ?, ?, ?, 0, 0, 0)`,
      lot.accountId,
      SYM.dq,
      SYM.dq,
      ids.dqSaleHash,
    );
    expect(codes).toContain("I1");
  });

  it("I2 — the IPO's link cut while its holding is still closed in the book", async () => {
    expect(await plant(`UPDATE ipos SET trade_id = NULL WHERE id = ?`, ids.ipoId)).toContain("I2");
  });

  it("I3 — a row removed behind the op table's back", async () => {
    expect(await plant(`DELETE FROM trades WHERE id = ?`, ids.mtfTrade)).toContain("I3");
  });

  it("I4 — a row filed in account 0, which is a view and not a place", async () => {
    expect(await plant(`UPDATE trades SET account_id = 0 WHERE id = ?`, ids.dupA)).toContain("I4");
  });

  it("I5 — a leg that does not collapse to its parent", async () => {
    expect(
      await plant(
        `INSERT INTO trade_legs (trade_id, kind, seq, trade_date, qty, price) VALUES (?, 'entry', 1, '2026-02-20', 1, 100)`,
        ids.dupA,
      ),
    ).toContain("I5");
  });

  it("I6 — a price column holding something that is not a number", async () => {
    expect(await plant(`UPDATE trades SET avg_buy_price = 'not a number' WHERE id = ?`, ids.dupA)).toContain("I6");
  });
});

// ── every single op, alone ───────────────────────────────────────────────────

describe("each operation alone leaves the book whole", () => {
  it.each(OPS.map((o) => [o.name] as const))("%s", async (name) => {
    await expectClean([name]);
  });
});

// ── every ordered PAIR ───────────────────────────────────────────────────────

const PAIRS: [string, string][] = [];
for (const a of OPS) {
  for (const b of OPS) {
    if (isIncompatible(a.name, b.name)) continue;
    PAIRS.push([a.name, b.name]);
  }
}

/**
 * Sequences that are RED ON HEAD (9f671dd). Each is pinned below with `it.fails`
 * and its own FINDING comment; they are excluded here so the sweep asserts the
 * rest is green.
 */
const KNOWN_RED = new Set<string>([]);

describe("every ordered pair of operations", () => {
  it.each(PAIRS.filter(([a, b]) => !KNOWN_RED.has(`${a}|${b}`)))("%s → %s", async (a, b) => {
    await expectClean([a, b]);
  });
});

// ── the triples this release's findings name ─────────────────────────────────

describe("the sequences the v4.3.0 re-checks were written about", () => {
  it("delete → restore → merge (the envelope a merge then has to carry)", async () => {
    await expectClean(["deleteIpoHolding", "restoreLatestSnapshot", "mergeAccountBIntoA"]);
  });

  it("merge → restore-source → runDataFixes (the un-merge, then the startup re-home)", async () => {
    await expectClean(["mergeAccountBIntoA", "restoreSourceAccount", "runDataFixes"]);
  });

  it("purge → restore-source → runDataFixes (the same, the other way a book leaves)", async () => {
    await expectClean(["purgeAccountB", "restoreSourceAccount", "runDataFixes"]);
  });

  it("sync → exit edit → notes-only save (the IPO write, twice over, then a save that writes nothing)", async () => {
    await expectClean(["ipoExitEdit", "ipoExitEdit", "ipoNotesOnlySave"]);
  });

  it("closeStaleLot → reopen → restore the sale (the alias that stops being held)", async () => {
    await expectClean(["reopenInEditor", "restoreLatestSnapshot", "closeStaleLot"]);
  });

  it("delete → delete-ipo → restore → restore (two envelopes, restored newest first)", async () => {
    await expectClean(["deleteJoinedLot", "deleteIpoHolding", "restoreLatestSnapshot", "restoreLatestSnapshot"]);
  });

  it("merge → un-merge → merge again (the same two books, twice)", async () => {
    await expectClean(["mergeAccountBIntoA", "restoreSourceAccount", "mergeAccountBIntoA"]);
  });

  it("reopen → re-import the same hash → close with the recorded sale", async () => {
    await expectClean(["reopenInEditor", "reimportSameHash", "closeStaleLot"]);
  });

  it("delete the IPO holding → merge → un-merge → runDataFixes", async () => {
    await expectClean(["deleteIpoHolding", "mergeAccountBIntoA", "restoreSourceAccount", "runDataFixes"]);
  });

  it("close the MTF remainder → reopen the joined lot → re-import that sale", async () => {
    await expectClean(["closePositionPartial", "reopenInEditor", "reimportSameHash"]);
  });

  it("sync → rate edit → exit edit (the IPO's charges, across a rate correction)", async () => {
    await expectClean(["ipoExitEdit", "editChargeRate", "ipoExitEdit"]);
  });

  it("rate edit → close the MTF remainder → exit edit (a stored bill beside a re-priced one)", async () => {
    await expectClean(["editChargeRate", "closePositionPartial", "ipoExitEdit"]);
  });

  it("merge → a 4.2.x envelope → un-merge → runDataFixes", async () => {
    await expectClean(["mergeAccountBIntoA", "legacifyLatestEnvelope", "restoreSourceAccount", "runDataFixes"]);
  });

  /**
   * FINDING G-G2-1: an IPO record named after the ISSUE (not the scrip), whose
   * holding is restored from a pre-4.3.0 Trash envelope, comes back UNLINKED and
   * the one sale is counted twice — in the capital summary, the tax pack, the
   * ITR export and both AIS sides — with no question raised about it.
   *
   * L6 (wave 2L) taught `lib/trash.ts` to re-link a restored `acquisition:'ipo'`
   * holding when an envelope carries no `ipoRefs`, and taught Data Quality to ASK
   * when more than one record could be its own. Both halves go through
   * `ipoRecordMatchesHolding` (lib/analytics/data-quality.ts:902), whose second
   * clause is `scripKey(record.name)` === the holding's symbol — true only for a
   * record `pushTradeToIpoAction` created FROM a holding (it writes the symbol
   * into `name`). A record entered on /ipos, where the field is literally
   * labelled the IPO's name, carries the ISSUE's name, matches nothing, and so
   * gets neither the re-link nor the question: `ipoOrphanPairs` returns none, so
   * no `ipo_record_link:<id>` issue is raised at all.
   *
   * Measured on HEAD (9f671dd) by this very sequence: `ipos.trade_id` stays null,
   * the holding is back with `acquisition:'ipo'`, and the Data Quality report for
   * that book holds `["instrument_master", "ipo_link"]` — the generic "IPO
   * holdings not linked to an IPO record" warning, whose detail says linking
   * "makes allotment basis, listing mark and exit flow from one source of truth"
   * and never says the exit is now counted twice.
   *
   * Reproduce: `npx vitest run tests/harness-book-sequences.test.ts -t "FINDING G-G2-1"`
   * — it.fails means this PASSES while the defect stands. The day the match is
   * widened (or the question is raised whenever an unlinked exited record sits in
   * the same book as an unlinked IPO holding), this pin goes red and must be
   * flipped back to `it`.
   */
  it.fails("FINDING G-G2-1 · delete the IPO holding → a 4.2.x envelope → restore: the allotment is counted twice", async () => {
    await expectClean(["deleteIpoHolding", "legacifyLatestEnvelope", "restoreLatestSnapshot"]);
  });

  /** The same defect, still standing after the book has been merged and un-merged. */
  it.fails("FINDING G-G2-1 · … and it survives merge → un-merge", async () => {
    await expectClean(["deleteIpoHolding", "legacifyLatestEnvelope", "restoreLatestSnapshot", "mergeAccountBIntoA", "restoreSourceAccount"]);
  });
});
