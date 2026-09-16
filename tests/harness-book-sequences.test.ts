import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  OPS,
  QTY,
  SYM,
  IPO_NAME,
  LOOKALIKE_IPO_NAME,
  STRAY_IPO_NAME,
  VARIANTS,
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
 * table marks incompatible = 275 — plus each op alone (17), 16 curated
 * sequences of three to five taken from this release's findings (four of them
 * the IPO-pairing cases waves 2M and 2N moved) and 6 tests that PLANT each
 * invariant's own violation so a green sweep is known to be able to go red.
 * 317 `it`s.
 *
 * `VARIANTS` (book-ops.ts) holds fixture shapes a named scenario needs, plus
 * the one step that is an ANSWER rather than an operation on the book, none of
 * which the pair sweep composes: the second look-alike IPO record, the stray
 * record of another scrip (wave 2N) and the /ipos link the user makes.
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

// Re-measured 2026-09-16 with the wave-2M case added: 316 `it`s, 23.9 s wall.
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
    const op = OPS.find((o) => o.name === name) ?? VARIANTS.find((o) => o.name === name);
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

/**
 * What the ambiguous G-G2-1 case leaves behind: the link column of every stored
 * record, and the question the holding's own book raises about it. Read in that
 * book (invariant 8 — the report is account-scoped, like every read it is
 * built from).
 */
function ipoAskState(ctx: BookCtx) {
  t.db.update(t.schema.settings).set({ selectedAccountId: ctx.ids.acctB }).run();
  const links = t.db.select().from(t.schema.ipos).all().map((r) => r.tradeId ?? null);
  const issue = m.dq.getDataQualityReport().issues.find((x) => x.code === `ipo_record_link:${ctx.ids.ipoTrade}`);
  return { links, issue };
}

const expectClean = async (names: string[]) => {
  const { violations } = await runSequence(names);
  // Joined rather than deep-equalled: a violation's own sentence is what names
  // the finding, and the array form is elided by the reporter.
  expect(violations.join("\n")).toBe("");
};

/**
 * More steps on a context a scenario already built — for the one shape
 * `runSequence` cannot express: a sequence that PASSES THROUGH a state the
 * invariants call violated (a sale stated twice while the user has not answered
 * the question yet) and is settled by a later step. `runSequence` stops at the
 * first violation on purpose, because anything after the broken step is noise.
 */
async function applyMore(ctx: BookCtx, names: string[]): Promise<string[]> {
  const violations: string[] = [];
  for (const name of names) {
    const op = OPS.find((o) => o.name === name) ?? VARIANTS.find((o) => o.name === name);
    if (!op) throw new Error(`no such op: ${name}`);
    await op.run(t.db, ctx);
    const bad = await checkInvariants(t.db, ctx);
    if (bad.length > 0) {
      const done = ctx.log.map((l) => `${l.op}[${l.status}]`).join(" → ");
      violations.push(...describeViolations(bad).map((s) => `after ${done}: ${s}`));
      break;
    }
  }
  return violations;
}

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
   * MOVED by D1 (v4.3.0 fix wave 2N, re-check finding counted-once#0).
   *
   * These two were `expectClean` after wave 2M taught the restore to write a
   * TIER-B pairing — the record's allotment quantity and its two days, with no
   * name clause. `ipos` carries no scrip fact at all, so those four facts are no
   * identity: two allotments of the same lot size on one day, both sold on
   * listing day, is an ordinary retail pattern, and the restore then linked the
   * WRONG issue's record to the holding. Its own, genuinely separate sale left
   * the capital summary, the tax pack, the ITR export and both AIS sides, and
   * the question that had named the pair disappeared with it — a silent wrong
   * number, worse than the double count it was settling.
   *
   * So tier B MARKS the candidate and the restore writes nothing. The state
   * below is the honest one, exactly as the ambiguous case at the end of this
   * file: the sale IS stated twice, Data Quality names the holding and the
   * record and says so, and the link the user makes on /ipos counts it once.
   */
  const g2Fixture = async () => {
    const { ctx, violations } = await runSequence(["deleteIpoHolding", "legacifyLatestEnvelope", "restoreLatestSnapshot"]);
    expect(violations).toEqual([
      `after deleteIpoHolding[applied] → legacifyLatestEnvelope[applied] → restoreLatestSnapshot[applied]: ` +
        `I2 the allotment is stated twice: holding #${ctx.ids.ipoTrade} is closed in the book and IPO #${ctx.ids.ipoId} realises its own exit`,
    ]);
    const { links, issue } = ipoAskState(ctx);
    expect(links, "nothing is guessed onto the holding").toEqual([null]);
    expect(issue?.title, "the pair is named").toBe("IPO record not linked to its holding");
    expect(issue!.detail).toContain(`${IPO_NAME} (matches this holding)`);
    expect(issue!.detail).toContain("counted once in IPOs and again as the holding's own sale");
    return ctx;
  };

  it("G-G2-1 · delete the IPO holding → a 4.2.x envelope → restore: the question is raised, and the user's link counts it once", async () => {
    const ctx = await g2Fixture();
    expect(await applyMore(ctx, ["linkIpoRecordOnIpos"]), "the link the question asked for settles the book").toEqual([]);
    expect(ipoAskState(ctx).links, "and the record names the holding again").toEqual([ctx.ids.ipoTrade]);
  });

  it("G-G2-1 · … and once linked it survives merge → un-merge", async () => {
    const ctx = await g2Fixture();
    expect(await applyMore(ctx, ["linkIpoRecordOnIpos", "mergeAccountBIntoA", "restoreSourceAccount"])).toEqual([]);
  });

  /**
   * D1 (fix wave 2N, re-check finding counted-once#0) — THE BEE SHAPE, the
   * guard case this wave owes the harness.
   *
   * A record of ANOTHER issue in the same book whose four allotment facts are
   * the holding's own. Tier B has no scrip fact to tell them apart, so the wave
   * 2M restore linked it — and the counted-once rule then excluded it, because
   * its now-linked trade was counted. Its own, genuinely separate sale left the
   * capital summary, the tax pack, the ITR export and both AIS sides, and the
   * question that had named the pair disappeared with it. I2 cannot see that on
   * its own (a record excluded because it is "counted through" a trade looks
   * exactly like a correctly linked one), so the record's OWN row is asserted
   * here: unlinked before, unlinked after, realised on its own row throughout.
   */
  it("D1 · a stray exited record of ANOTHER scrip is never written onto the restored holding, and its own sale is still counted", async () => {
    const { ctx, violations } = await runSequence([
      "addStrayExitedRecordOfAnotherScrip", "deleteIpoHolding", "legacifyLatestEnvelope", "restoreLatestSnapshot",
    ]);
    const strayState = () => {
      t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
      const row = t.db.select().from(t.schema.ipos).all().find((r) => r.name === STRAY_IPO_NAME)!;
      const base = m.taxItr.getTaxBase();
      return { link: row.tradeId ?? null, countedOnItsOwnRow: base.exitedIpos.some((r) => r.id === row.id) };
    };
    // THE assertion. Measured on the wave-2M module: `{link: <the holding>,
    // countedOnItsOwnRow: false}` — a ₹482.61 realised net, an ITR row and the
    // AIS consideration of a sale that has nothing to do with this holding.
    expect(strayState()).toEqual({ link: null, countedOnItsOwnRow: true });
    // The fixture's own allotment is the honest double count until the user
    // answers the question — and the stray record survives that answer intact.
    expect(violations).toEqual([
      `after addStrayExitedRecordOfAnotherScrip[applied] → deleteIpoHolding[applied] → legacifyLatestEnvelope[applied] → restoreLatestSnapshot[applied]: ` +
        `I2 the allotment is stated twice: holding #${ctx.ids.ipoTrade} is closed in the book and IPO #${ctx.ids.ipoId} realises its own exit`,
    ]);
    expect(await applyMore(ctx, ["linkIpoRecordOnIpos"])).toEqual([]);
    expect(strayState(), "the user's answer names ONE record, and the other keeps its own sale").toEqual({ link: null, countedOnItsOwnRow: true });
  });

  /**
   * G-G2-1 (v4.3.0 fix wave 2M): these two were `it.fails`.
   *
   * THE FINDING. An IPO record named after the ISSUE (not the scrip), whose
   * holding is restored from a pre-4.3.0 Trash envelope, came back UNLINKED and
   * the one sale was counted twice — in the capital summary, the tax pack, the
   * ITR export and both AIS sides — with no question raised about it. L6 (wave
   * 2L) taught `lib/trash.ts` to re-link a restored `acquisition:'ipo'` holding
   * when an envelope carries no `ipoRefs`, and taught Data Quality to ASK when
   * more than one record could be its own; both halves went through
   * `ipoRecordMatchesHolding`, whose only clause was
   * `scripKey(record.name)` === the holding's symbol — true just for a record
   * `pushTradeToIpoAction` created FROM a holding. The fixture's record is named
   * `G2-SEQ-IPO` beside a holding symbol of `GIPO`, exactly as a record typed on
   * /ipos is, so it matched nothing: no link, and no `ipo_record_link:<id>`
   * issue either. Measured on HEAD (9f671dd) by this very sequence:
   * `ipos.trade_id` stayed null and the book's report held only
   * `["instrument_master", "ipo_link"]`.
   *
   * THE FIX. `ipoRecordMatchesHolding` gained a second tier built only from
   * facts both rows already state — an exited allotment, the same quantity, the
   * same allotment day as the holding's acquisition and the same exit day as its
   * sale — so the fixture's record is now recognised and the restore re-links it
   * (unique in both directions, or nothing is written). `ipoAskPairs` raises the
   * question for every unlinked IPO holding that shares a book with an unlinked
   * exited record, matched or not.
   *
   * Reproduce: `npx vitest run tests/harness-book-sequences.test.ts -t "G-G2-1"`.
   *
   * The two `it`s that pinned the WRITE are above, moved by wave 2N: tier B
   * marks the candidate, the question is raised, and the user's own link on
   * /ipos is what counts the allotment once.
   */

  /**
   * G-G2-1, the ambiguous half — a RECORDED limitation, pinned as what the app
   * actually does rather than as a clean book.
   *
   * With a SECOND unlinked exited record stating the same allotment (the same
   * quantity and the same two days), nothing can tell the two apart, so the
   * restore writes NO link (invariant 6 — "whichever the loop met first" is not
   * an answer). The holding is then back and closed while its record still
   * realises its own exit, and I2 reports exactly that: the sale IS stated
   * twice, and no code can settle it without inventing a link. What the fix owes
   * this case is therefore the QUESTION, not a clean I2 — Data Quality names the
   * holding and BOTH candidates, and the moment the user links one on /ipos the
   * book is counted once again (pinned in `tests/trash-restore-ipo-legacy.test.ts`,
   * "stops asking once the user links one of them").
   */
  it("G-G2-1 · two look-alike records: nothing is written, the question names both, and the double count is stated", async () => {
    const { ctx, violations } = await runSequence(["addLookalikeIpoRecord", "deleteIpoHolding", "legacifyLatestEnvelope", "restoreLatestSnapshot"]);
    const { links, issue } = ipoAskState(ctx);
    expect(links, "neither record is guessed onto the holding").toEqual([null, null]);
    expect(issue?.title, "the pair is named").toBe("IPO record not linked to its holding");
    expect(issue!.detail).toContain("2 exited IPO records");
    expect(issue!.detail).toContain(`${IPO_NAME} (matches this holding)`);
    expect(issue!.detail).toContain(`${LOOKALIKE_IPO_NAME} (matches this holding)`);
    // The honest state, not a loosened assertion: one sale, stated twice, until
    // the user answers the question above.
    expect(violations).toEqual([
      `after addLookalikeIpoRecord[applied] → deleteIpoHolding[applied] → legacifyLatestEnvelope[applied] → restoreLatestSnapshot[applied]: ` +
        `I2 the allotment is stated twice: holding #${ctx.ids.ipoTrade} is closed in the book and IPO #${ctx.ids.ipoId} realises its own exit`,
    ]);
  });
});
