import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  OPS,
  QTY,
  SYM,
  SIGNAL_SYMBOL,
  SEEDED_SIGNAL_NOTES,
  IPO_NAME,
  CROSS_BOOK_IPO_NAME,
  EDITED_PER_TRADE_CAPS,
  FOREIGN_IPO_NAME,
  LOOKALIKE_IPO_NAME,
  STRAY_IPO_NAME,
  SURVIVOR_IPO_NAME,
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
import { parseSignal } from "@/lib/domain/signal";

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
 *   I7 CAP-ROWS-FOLLOW-THE-CAP  every `risk_source='cap'` row holds
 *                           `resolvePerTradeCap(bucket, segment)` and
 *                           `r2(net ÷ risk)`; staged and `'frozen'` rows come
 *                           back byte-identical (v4.4.0 D1, ruling OQ1)
 *
 * WHAT IT RUNS: the operations of the table (21 with v4.4.0's `editPerTradeCap`);
 * every ordered pair of them less the ones the table marks incompatible, plus
 * each op alone, the two D1 review pairs S1 and S2 asserted by name, 19 curated
 * sequences of three to five taken from this release's findings (four of them
 * the IPO-pairing cases waves 2M and 2N moved, two of them wave 2O's CROSS-BOOK
 * pair, D4) and 9 tests that PLANT each invariant's own violation so a green
 * sweep is known to be able to go red. 360 `it`s, 35.5 s wall (measured
 * 2026-09-21 with I7 and `editPerTradeCap` added; 319 / 34.0 s before).
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

// Re-measured 2026-09-16 with wave 2O's two D4 cases added: 319 `it`s, 34.0 s
// wall, the two new ones 187 ms and 185 ms (inside the <= 300 ms budget).
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

  it("I7 — a cap row holding a risk the resolver does not state", async () => {
    expect(await plant(`UPDATE trades SET risk_amount_paise = 12345 WHERE id = ?`, ids.mtfTrade)).toContain("I7");
  });

  it("I7 — a cap row whose R is not its own net ÷ its own risk", async () => {
    expect(await plant(`UPDATE trades SET r_multiple = -9.9 WHERE id = ?`, ids.mtfTrade)).toContain("I7");
  });

  it("I7 — a 'frozen' row re-priced behind the invariant's back", async () => {
    tpl.reset();
    const ctx = freshCtx(t, m, ids);
    // A frozen row is a staged position's, whose R is fixed at its first entry
    // (invariant 4); planted RAW, because the question is only whether the
    // check fires.
    t.sqlite.prepare(`UPDATE trades SET risk_source = 'frozen', risk_amount_paise = 333300, r_multiple = -0.3 WHERE id = ?`).run(ids.dupA);
    expect((await checkInvariants(t.db, ctx)).map((v) => v.code), "the first sight of a frozen row is what pins it").not.toContain("I7");
    t.sqlite.prepare(`UPDATE trades SET risk_amount_paise = 400000 WHERE id = ?`).run(ids.dupA);
    expect((await checkInvariants(t.db, ctx)).map((v) => v.code)).toContain("I7");
  });
});

/**
 * S1 and S2 of the D1 design review — the two writers a cap edit must not leave
 * behind. Both are pairs, and both are about the SOURCE a save stamps: a writer
 * that reads "the request carried a risk" as "the user chose this risk" freezes
 * that one row in yesterday's cap while every other cap row moves, and the two
 * live side by side in one Avg R. The row's own figures are asserted here
 * because I7 cannot: a row wrongly stamped `'set'` is a row I7 no longer checks.
 */
describe("a cap edit reaches the rows the other writers touched (D1 S1, S2)", () => {
  const capOf = (bucket: string, segment: string) =>
    m.limits.resolvePerTradeCap(m.riskCap.readCapRows(t.sqlite), bucket, segment);

  const expectFollowsCap = (id: number, what: string) => {
    const row = t.db.select().from(t.schema.trades).all().find((r) => r.id === id)!;
    const cap = capOf(row.bucket, row.segment);
    expect(cap, "the op must have moved the cap off the seeded default").toBe(EDITED_PER_TRADE_CAPS[0]);
    expect(
      [row.riskSource, row.riskAmount, row.rMultiple],
      `${what}: the row must still follow the cap after the edit, not sit frozen in the old one`,
    ).toEqual(["cap", cap, m.riskCap.capR(row.netPnl, cap)]);
  };

  it("S1 — a mark-only save with NO stop, then the cap edit", async () => {
    const { violations } = await runSequence(["markPriceNoStop", "editPerTradeCap"]);
    expect(violations.join("\n")).toBe("");
    expectFollowsCap(ids.mtfTrade, "the marked MTF row");
  });

  it("S2 — the edit dialog re-posting the cap it prefilled, then the cap edit", async () => {
    const { violations } = await runSequence(["saveEditDialogRepostingTheCap", "editPerTradeCap"]);
    expect(violations.join("\n")).toBe("");
    expectFollowsCap(ids.dqLot, "the re-saved lot");
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

// ── v4.6.0 W6 — trades.side and the overnight F&O short ─────────────────────

describe("v4.6.0 W6 — the overnight short and the pre-W6 pair (contract §2)", () => {
  it("legacy pair → per-leg refusal → join → re-import: the ops really ran, and the sale is stated once", async () => {
    const { ctx, violations } = await runSequence(["legacyShortJoinReimport"]);
    expect(violations.join("\n")).toBe("");
    // Not vacuous: both pre-W6 rows landed, the W6 re-import was refused per leg,
    // the pair was listed and joined, and the re-import after the join deduped.
    expect(ctx.log.at(-1)!.note).toMatch(/^pre-W6 rows \+1\/\+1; W6 re-import \+0; joined #\d+ into #\d+; again \+0$/);
    const joined = t.db.select().from(t.schema.trades).all().filter((r) => r.tradingsymbol === SYM.legacy);
    expect(joined.map((r) => [r.buyQty, r.sellQty, r.side, r.acquisition, r.isOpen])).toEqual([[75, 75, "short", null, false]]);
  });

  it("overnight short → a Trash restore → merge → un-merge: the closed short keeps its side through every hop", async () => {
    const { ctx, violations } = await runSequence(["importOvernightShort", "restoreLatestSnapshot", "mergeAccountBIntoA", "restoreSourceAccount"]);
    expect(violations.join("\n")).toBe("");
    expect(ctx.log[0].note).toBe("added 1, deduped 0");
    const r = t.db.select().from(t.schema.trades).all().find((x) => x.tradingsymbol === SYM.ovn)!;
    expect([r.side, r.buyQty, r.sellQty]).toEqual(["short", 75, 75]);
  });

  it("legacy pair joined, then the purchase restored from Trash: still stated once, still clean", async () => {
    await expectClean(["legacyShortJoinReimport", "restoreLatestSnapshot", "legacyShortJoinReimport"]);
  });

  // Fix wave (finding 1): the two shapes the per-leg check missed. Counted-once
  // is I1's quantity statement (LEGACY_GROUP_STATEMENT) plus I3's net.
  it("partial cover (sold 100, bought back 60) → the post-W6 file: the whole contract refused, the sale stated once", async () => {
    const { ctx, violations } = await runSequence(["legacyPartialReimport"]);
    expect(violations.join("\n")).toBe("");
    expect(ctx.log.at(-1)!.note).toBe("pre-W6 rows +1/+1; W6 preview dup 2/2; W6 re-import +0, refused 2");
    const rows = t.db.select().from(t.schema.trades).all().filter((r) => r.tradingsymbol === SYM.legacyPartial);
    expect(rows.map((r) => [r.buyQty, r.sellQty]).sort()).toEqual([[0, 100], [60, 0]]);
  });

  it("two sells, one buy (50 + 50, then 130) → the post-W6 file: the whole contract refused, the sale stated once", async () => {
    const { ctx, violations } = await runSequence(["legacyTwoSellsReimport"]);
    expect(violations.join("\n")).toBe("");
    expect(ctx.log.at(-1)!.note).toBe("pre-W6 rows +1/+1/+1; W6 preview dup 2/2; W6 re-import +0, refused 2");
    const rows = t.db.select().from(t.schema.trades).all().filter((r) => r.tradingsymbol === SYM.legacyTwoSells);
    expect(rows.map((r) => [r.buyQty, r.sellQty]).sort()).toEqual([[0, 50], [0, 50], [130, 0]]);
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
   * v4.3.0 SIGNAL BOOK — record → clear → backup → restore.
   *
   * The one stateful sequence the Signal book adds, and the reason
   * `trades.signal_json` stores a TOMBSTONE rather than SQL NULL on an explicit
   * clear: `restoreDatabase` calls `rerunDataFixesAfterRestore`, which forgets
   * every marker and replays `signal-notes-backfill-v1` — and the seeded notes
   * this row carries are precisely what that fix reads. With NULL as the
   * cleared state the restore would hand back a signal the user deleted, on the
   * path that is also how you move to a new machine.
   *
   * Composed from VARIANTS, so the 275-scenario pair sweep is unchanged: a
   * whole-database restore crossed with seventeen operations asks nothing these
   * four steps do not, at ~15x the cost on the Windows runner.
   *
   * MEASURED LOCALLY 2026-09-18: 622 ms — over this file's <= 300 ms per-`it`
   * budget, and the only case here that is, because `restoreDatabase` rewrites
   * every table (~300 ms of it) where every other step touches one row. The
   * Windows runner is measured >15x slower on SQLite-file work, which puts it
   * past vitest's 5 s default, so THIS `it` carries an explicit 30 s — the same
   * ceiling `hookTimeout` already uses for a seeded temp database. A genuinely
   * hung restore still fails.
   */
  it("v4.3.0 · record a signal → clear it → backup → restore: the tombstone survives and nothing resurrects", async () => {
    tpl.reset();
    const ctx = freshCtx(t, m, ids);
    expect(await applyMore(ctx, ["recordSignalTrade"])).toEqual([]);
    const signalRow = () => t.db.select().from(t.schema.trades).all().find((r) => r.tradingsymbol === SIGNAL_SYMBOL)!;
    expect(signalRow().signalJson).toBe('{"v":1,"model":"S1","t1":13,"t2":16,"sl":7.5}');
    expect(signalRow().notes, "the notes the backfill reads are on the row").toBe(SEEDED_SIGNAL_NOTES);

    expect(await applyMore(ctx, ["clearRecordedSignal", "backupDumpAndRestore"])).toEqual([]);
    const after = signalRow();
    expect(after.signalJson, "a cleared signal must not come back from its own notes").toBe('{"v":1}');
    expect(parseSignal(after.signalJson), "and it reads as NO signal everywhere").toBeNull();
    expect(after.notes, "the fix never rewrites what the user typed").toBe(SEEDED_SIGNAL_NOTES);
  }, 30_000);

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
   * D4 (v4.3.0 fix wave 2O, re-check finding identity#0) — the two sequences
   * this wave owes the harness, both about a CROSS-BOOK IPO link.
   *
   * Both fixtures pass through a state the invariants legitimately call an
   * imbalance, so neither can use `expectClean`: a record in one book naming a
   * holding in another is counted in ITS OWN book (the holding is not in view)
   * and left out of All accounts (the holding is counted there) — the rule
   * lib/queries/ipos.ts:154-177 states deliberately, which makes All accounts
   * NOT the sum of its books for that one record. So these drive the ops
   * directly and assert the SEQUENCE introduces no violation the fixture did not
   * already have, plus the facts I2 cannot see (the link column itself, the
   * /trades badge, and which row the record's sale is stated on).
   */
  const drive = async (ctx: BookCtx, names: string[]): Promise<string[]> => {
    for (const name of names) {
      const op = OPS.find((o) => o.name === name) ?? VARIANTS.find((o) => o.name === name);
      if (!op) throw new Error(`no such op: ${name}`);
      await op.run(t.db, ctx);
    }
    return describeViolations(await checkInvariants(t.db, ctx));
  };
  const ipoRowNamed = (name: string) => t.db.select().from(t.schema.ipos).all().find((r) => r.name === name);
  const inView = <T,>(accountId: number, read: () => T): T => {
    t.db.update(t.schema.settings).set({ selectedAccountId: accountId }).run();
    return read();
  };

  it("D4 · purge → un-purge: a record naming ANOTHER book's holding keeps its link, and no view's ipoRealised moves", async () => {
    tpl.reset();
    const ctx = freshCtx(t, m, ids);
    const ipoRealisedPerView = () =>
      [ids.acctA, ids.acctB, 0].map((v) => inView(v, () => m.capital.getCapitalSummary().ipoRealised));

    const before = await drive(ctx, ["addCrossBookIpoRecordInB"]);
    const realisedBefore = ipoRealisedPerView();
    expect(ipoRowNamed(CROSS_BOOK_IPO_NAME)!.tradeId, "the fixture: B's record names A's holding").toBe(ids.dupA);

    const after = await drive(ctx, ["purgeAccountB", "restoreSourceAccount"]);
    // THE assertion: the reference was never part of this delete, so the replay
    // keeps it. Under a `landed`-only gate the link is cut and All accounts gains
    // the record's own realised net — one sale, counted twice.
    expect(ipoRowNamed(CROSS_BOOK_IPO_NAME)!.tradeId, "replayed verbatim").toBe(ids.dupA);
    expect(ipoRealisedPerView(), "every view reads what it read before the purge").toEqual(realisedBefore);
    expect(after, "and the sequence introduces no violation the fixture did not have").toEqual(before);
  });

  it("D4 · merge → un-merge whose duplicate CANNOT land: the foreign record comes back UNLINKED and its sale is counted once", async () => {
    tpl.reset();
    const ctx = freshCtx(t, m, ids);
    const fixture = await drive(ctx, ["addDuplicateIpoRecordsInA"]);
    expect(fixture.length, "the cross-book fixture's own recorded imbalance").toBeGreaterThan(0);

    // The merge drops B's copy and SKIPS the record naming it, because the
    // survivor already carries one (L7) — so it is deleted into the envelope (D5).
    await drive(ctx, ["mergeAccountBIntoA"]);
    expect(ipoRowNamed(FOREIGN_IPO_NAME), "removed with the duplicate it names").toBeUndefined();

    // …and the id it named is taken before the un-merge, so the duplicate cannot
    // come back at all.
    const after = await drive(ctx, ["takeTheDroppedDuplicatesId", "restoreSourceAccount"]);
    const foreign = ipoRowNamed(FOREIGN_IPO_NAME)!;
    // THE assertion. On HEAD the replay is verbatim: `tradeId` is the id of
    // GTAKEN — an unrelated closed trade — so /trades badges that row and the
    // record's own sale leaves capital, the tax pack, the ITR export and both AIS
    // sides (it is "counted through" a trade that is not its holding).
    expect([foreign.accountId, foreign.tradeId], "its own book, and no holding").toEqual([ids.acctA, null]);
    expect(inView(0, () => m.ipoQ.getIpoTradeLinks().get(ids.dupB)), "nothing badges the trade that took the id").toBeUndefined();
    expect(
      inView(0, () => m.taxItr.getTaxBase().exitedIpos.some((r) => r.id === foreign.id)),
      "its exit is stated on its own row, once",
    ).toBe(true);
    // The survivor's own record still names the survivor, and with B's copy gone
    // for good every invariant is clean again — the imbalance was the cross-book
    // link, and the link is now honestly absent.
    expect(ipoRowNamed(SURVIVOR_IPO_NAME)!.tradeId).toBe(ids.dupA);
    expect(after.join("\n")).toBe("");
  });

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
