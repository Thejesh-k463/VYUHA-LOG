import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * L6 (v4.3.0 wave 2L) — a Trash envelope written BEFORE the IPO links were
 * snapshotted still comes back linked, or Data Quality names it.
 *
 * Wave 2K taught the delete to carry `ipoRefs` (the IPO records it unlinked)
 * so a restore re-points them. A snapshot written on 4.2.x carries NO such
 * field — the delete nulled `ipos.trade_id` and stored nothing about it — so
 * restoring it on 4.3.0 put the holding back UNLINKED: the IPO section counted
 * its own exit and the restored holding counted the same sale again, in the
 * capital summary, the tax pack, the ITR export and both AIS sides. Nothing on
 * screen said so.
 *
 * The rule pinned here:
 *   - an envelope WITHOUT `ipoRefs` re-links a restored `acquisition: 'ipo'`
 *     holding to the ONE unlinked IPO record of the same account and scrip
 *     (and, where both state it, the same allotted quantity);
 *   - G-G2-1 (wave 2M): or to the ONE unlinked record of that account whose
 *     ALLOTMENT is the holding's own — allotted, exited, the same quantity, the
 *     same allotment and exit days — which is how a record entered on /ipos
 *     under the ISSUE's name ("Tata Technologies Limited" beside TATATECH) is
 *     recognised without resolving a name to a symbol through any list;
 *   - and the question is raised for every unlinked IPO holding that shares a
 *     book with an unlinked exited record, matched or not;
 *   - with more than one candidate NOTHING is written and Data Quality raises
 *     the `ipo_record_link` warning naming the holding and the candidates
 *     (invariant 6 — a question, never an invented link);
 *   - an envelope WITH `ipoRefs` — including the empty list a 4.3 delete writes
 *     when it found no link — keeps today's path exactly.
 *
 * ONE temp database per FILE (AGENTS.md); one account per case, so every
 * account-scoped read (capital, tax, AIS, Data Quality) sees that case alone.
 */

let t: TempDb;
let trash: typeof import("@/lib/trash");
let del: typeof import("@/lib/queries/delete");
let accDel: typeof import("@/lib/queries/account-delete");
let capital: typeof import("@/lib/queries/capital");
let taxItr: typeof import("@/lib/queries/tax-itr");
let dq: typeof import("@/lib/queries/data-quality");
let ais: typeof import("@/app/api/ais/route");
let trashDir = "";

const ACC_ONE = 941; // one candidate record — the re-link
const ACC_TWO = 942; // two candidate records — no link, a question instead
const ACC_REF = 943; // envelopes that DO carry ipoRefs
const ACC_ISSUE = 944; // G-G2-1: the record is named after the ISSUE, not the scrip
const ACC_LOOK = 945; //  G-G2-1: two issue-named records stating the same allotment
const ACC_APPLY = 946; // D1: the APPLICATION row the user kept beside the allotment
const ACC_OPEN = 947; //  D1: an allotted record with no exit stated, beside an exited one
const ACC_BEE = 948; //   rc7 counted-once#0: a stray exited record of ANOTHER scrip
const ACC_HELD = 949; //  rc7 counted-once#1: an exited record beside an OPEN holding
const ACC_BOOK = 950; //  rc7 counted-once#1: a second unlinked holding already in the book
const ACC_NOLINK = 951; // D1 (2N): a 4.3 delete that broke NO link states `ipoRefs: []`
const ACC_XLINK = 952; //  D4 (2O): the purged book whose record names ANOTHER book's holding
const ACC_XHOLD = 953; //  D4 (2O): the book that holds it
const ACC_XLEDGER = 954; // D4 (2O): the ledger half of the same gate

const TRADE_NET = 490.25; // 10 × (150 − 100) − 9.75 of charges, as the row states them

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

/** A closed eq_delivery holding flagged as an IPO allotment: 10 @100 → 150. */
function holding(accountId: number, symbol: string, over: Record<string, unknown> = {}) {
  return t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        accountId,
        broker: "zerodha",
        segment: "eq_delivery",
        symbol,
        tradingsymbol: symbol,
        buyQty: 10,
        avgBuyPrice: 100,
        buyValue: 1000,
        buyDate: "2025-06-10",
        sellQty: 10,
        avgSellPrice: 150,
        sellValue: 1500,
        sellDate: "2025-09-20",
        grossPnl: 500,
        chargesTotal: 500 - TRADE_NET,
        netPnl: TRADE_NET,
        isOpen: false,
        acquisition: "ipo",
        acquisitionPrice: 100,
        acquisitionDate: "2025-06-10",
        ...over,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

/** The same holding, still HELD: bought 10 @100 and never sold. */
const openHolding = (accountId: number, symbol: string) =>
  holding(accountId, symbol, {
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    sellDate: null,
    grossPnl: 0,
    chargesTotal: 0,
    netPnl: 0,
    isOpen: true,
  });

/** The IPO record that holding became: allotted 10 @100, exited at 150. */
function ipoRecord(
  accountId: number,
  name: string,
  tradeId: number | null,
  allottedQty = 10,
  over: Partial<{ allotmentDate: string | null; exitDate: string | null; exitPrice: number | null; allotted: boolean; listingPrice: number | null }> = {},
) {
  return t.db
    .insert(t.schema.ipos)
    .values({
      accountId,
      name,
      broker: "zerodha",
      exchange: "NSE",
      appliedPrice: 100,
      lotSize: allottedQty,
      lotsApplied: 1,
      allotted: true,
      allottedQty,
      listingPrice: 130,
      exitPrice: 150,
      appliedDate: "2025-06-01",
      allotmentDate: "2025-06-10",
      listingDate: "2025-06-14",
      exitDate: "2025-09-20",
      tradeId,
      ...over,
    })
    .returning({ id: t.schema.ipos.id })
    .get()!.id;
}

const linkOf = (ipoId: number) => t.db.select().from(t.schema.ipos).where(eq(t.schema.ipos.id, ipoId)).get()!.tradeId;
const tradeExists = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get() != null;

/**
 * Turn a 4.3 snapshot into the shape 4.2.x wrote: the field is DELETED, not
 * emptied — that is exactly what `JSON.stringify` did when the writer had no
 * `ipoRefs` to carry, and the two are read differently on purpose.
 */
function makeLegacy(id: string) {
  const p = path.join(trashDir, id, "snapshot.json");
  const env = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  expect(Array.isArray(env.ipoRefs) ? (env.ipoRefs as unknown[]).length : 0, "the 4.3 delete stored the link it broke").toBe(1);
  delete env.ipoRefs;
  fs.writeFileSync(p, JSON.stringify(env));
}

/**
 * The same 4.2.x shape for an envelope whose delete broke NO link. Since D1
 * (wave 2N) a 4.3 delete states `ipoRefs: []` there, which SKIPS the fallback;
 * stripping the field is the only way left to reach the legacy path, which is
 * exactly what the field now means.
 */
function stripIpoRefs(id: string) {
  const p = path.join(trashDir, id, "snapshot.json");
  const env = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  delete env.ipoRefs;
  fs.writeFileSync(p, JSON.stringify(env));
}

const capitalOf = () => {
  const s = capital.getCapitalSummary();
  return { equityRealised: s.equityRealised, ipoRealised: s.ipoRealised, totalRealised: s.totalRealised };
};

/** POST /api/ais with nothing to parse: every journal FY total surfaces as missing_in_ais. */
async function aisOf(): Promise<Record<string, number | null>> {
  const res = await ais.POST(
    new Request("http://local/api/ais", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "nothing to parse" }) }),
  );
  expect(res.status).toBe(200);
  const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
  return Object.fromEntries(recon.fyTotals.map((f) => [`${f.fy} ${f.kind}`, f.journal]));
}

const issueOf = (code: string) => dq.getDataQualityReport().issues.find((x) => x.code === code);

// Measured locally (2026-09-15): the hook is ~1.2 s (migrate + seed + three accounts).
// The raised timeout is for the Windows runner, >15x slower on SQLite-file work (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("trash-restore-ipo-legacy", { seed: true });
  trash = await import("@/lib/trash");
  del = await import("@/lib/queries/delete");
  accDel = await import("@/lib/queries/account-delete");
  capital = await import("@/lib/queries/capital");
  taxItr = await import("@/lib/queries/tax-itr");
  dq = await import("@/lib/queries/data-quality");
  ais = await import("@/app/api/ais/route");
  trashDir = (await import("@/lib/db")).trashDir;
  t.db
    .insert(t.schema.accounts)
    .values([
      { id: ACC_ONE, name: "legacy-ipo one", isDefault: false },
      { id: ACC_TWO, name: "legacy-ipo two", isDefault: false },
      { id: ACC_REF, name: "legacy-ipo refs", isDefault: false },
      { id: ACC_ISSUE, name: "legacy-ipo issue name", isDefault: false },
      { id: ACC_LOOK, name: "legacy-ipo look-alikes", isDefault: false },
      { id: ACC_APPLY, name: "legacy-ipo application row", isDefault: false },
      { id: ACC_OPEN, name: "legacy-ipo unexited record", isDefault: false },
      { id: ACC_BEE, name: "legacy-ipo another scrip", isDefault: false },
      { id: ACC_HELD, name: "legacy-ipo still held", isDefault: false },
      { id: ACC_BOOK, name: "legacy-ipo twin in the book", isDefault: false },
      { id: ACC_NOLINK, name: "legacy-ipo no link broken", isDefault: false },
      { id: ACC_XLINK, name: "legacy-ipo cross-book record", isDefault: false },
      { id: ACC_XHOLD, name: "legacy-ipo cross-book holding", isDefault: false },
      { id: ACC_XLEDGER, name: "legacy-ipo ledger refs", isDefault: false },
    ])
    .run();
}, 120_000);

afterAll(() => t?.cleanup());

describe("a pre-4.3.0 envelope (no ipoRefs) — one candidate record", () => {
  it("re-links the restored holding to its IPO record, and the sale is counted once again", async () => {
    selectAccount(ACC_ONE);
    const tradeId = holding(ACC_ONE, "LEGIPO");
    const ipoId = ipoRecord(ACC_ONE, "LEGIPO", tradeId);
    const before = { capital: capitalOf(), itr: taxItr.countItrRows(), ais: await aisOf() };
    expect([before.capital.totalRealised, before.capital.ipoRealised, before.itr], "the linked book counts one sale").toEqual([TRADE_NET, 0, 1]);
    expect(before.ais).toEqual({ "2025-26 purchase": 1000, "2025-26 sale": 1500 });

    const d = del.deleteTradesByIds([tradeId], "L6: deleted the way 4.2.x deleted", "test");
    expect([d.ok, d.snapshotId != null], d.message).toEqual([true, true]);
    makeLegacy(d.snapshotId!);
    expect([tradeExists(tradeId), linkOf(ipoId)], "the delete unlinked the record and kept it").toEqual([false, null]);

    const res = trash.restoreTrashSnapshot(d.snapshotId!);
    expect([res.ok, res.restored], res.message).toEqual([true, 1]);
    // On revert: the link stays null, the IPO counts its own exit beside the
    // restored holding, and every consumer states the one sale twice.
    expect(linkOf(ipoId), "the holding's own record points at it again").toBe(tradeId);
    expect({ capital: capitalOf(), itr: taxItr.countItrRows(), ais: await aisOf() }).toEqual(before);
    expect(issueOf(`ipo_record_link:${tradeId}`), "nothing left to ask about").toBeUndefined();
  });
});

describe("a pre-4.3.0 envelope (no ipoRefs) — two candidate records", () => {
  it("writes no link and Data Quality names the holding and both candidates", () => {
    selectAccount(ACC_TWO);
    const tradeId = holding(ACC_TWO, "TWINIPO");
    const mine = ipoRecord(ACC_TWO, "TWINIPO", tradeId);
    const twin = ipoRecord(ACC_TWO, "TWINIPO", null);

    const d = del.deleteTradesByIds([tradeId], "L6: two records could be its own", "test");
    expect(d.ok, d.message).toBe(true);
    makeLegacy(d.snapshotId!);
    expect([linkOf(mine), linkOf(twin)]).toEqual([null, null]);

    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);
    expect([linkOf(mine), linkOf(twin)], "neither record is guessed at (invariant 6)").toEqual([null, null]);

    // On revert: no issue with this code exists at all, and nothing anywhere
    // says the restored holding and the two records are the same allotment.
    const issue = issueOf(`ipo_record_link:${tradeId}`);
    expect([issue?.severity, issue?.title]).toEqual(["warning", "IPO record not linked to its holding"]);
    expect(issue?.ids).toEqual([tradeId]);
    expect(issue!.detail).toContain(`#${tradeId}`);
    expect(issue!.detail).toContain(`#${mine}`);
    expect(issue!.detail).toContain(`#${twin}`);
    expect(issue!.detail).toContain("TWINIPO");
  });

  it("stops asking once the user links one of them", () => {
    selectAccount(ACC_TWO);
    const tradeId = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.tradingsymbol, "TWINIPO")).get()!.id;
    const mine = t.db.select().from(t.schema.ipos).where(eq(t.schema.ipos.accountId, ACC_TWO)).all()[0].id;
    t.db.update(t.schema.ipos).set({ tradeId }).where(eq(t.schema.ipos.id, mine)).run();
    expect(issueOf(`ipo_record_link:${tradeId}`)).toBeUndefined();
  });
});

describe("an envelope that DOES carry ipoRefs is untouched by the fallback", () => {
  it("re-points the record its own ref names", () => {
    selectAccount(ACC_REF);
    const tradeId = holding(ACC_REF, "REFIPO");
    const ipoId = ipoRecord(ACC_REF, "REFIPO", tradeId);
    const d = del.deleteTradesByIds([tradeId], "L6: a 4.3 envelope", "test");
    expect(d.ok, d.message).toBe(true);
    expect(linkOf(ipoId)).toBeNull();
    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);
    expect(linkOf(ipoId)).toBe(tradeId);
  });

  /**
   * MOVED by D1 (fix wave 2N, re-check findings counted-once#0 and #1). It read
   * "a delete that broke NO link writes no ipoRefs at all, so an unlinked
   * holding with one candidate comes back linked", and pinned the omission as a
   * decision: `ipoRefRows.length ? ipoRefRows : undefined` made a 4.3 envelope
   * for an unlinked holding byte-identical to a 4.2.x one, so it took the legacy
   * path and came back LINKED.
   *
   * That was the TRIGGER of both findings: no 4.2.x envelope was ever needed to
   * reach the fallback, so an ordinary delete + restore of a holding the user
   * had never linked invented a link — and through tier B, a link to another
   * ISSUE's record, whose own sale then left every consumer. Every delete writer
   * now STATES `ipoRefs`, `[]` included, and `== null` means a pre-4.3.0
   * envelope and nothing else.
   */
  it("a delete that broke NO link states an EMPTY ipoRefs, so the holding comes back exactly as it was — unlinked, and asked about", () => {
    selectAccount(ACC_NOLINK);
    const tradeId = holding(ACC_NOLINK, "GUARD");
    const guard = ipoRecord(ACC_NOLINK, "GUARD", null);
    const d = del.deleteTradesByIds([tradeId], "L6: no link to carry", "test");
    expect(d.ok, d.message).toBe(true);
    const env = JSON.parse(fs.readFileSync(path.join(trashDir, d.snapshotId!, "snapshot.json"), "utf8")) as Record<string, unknown>;
    expect([("ipoRefs" in env), env.ipoRefs], "the writer states the empty list rather than dropping the field").toEqual([true, []]);

    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);
    expect(linkOf(guard), "a link the user never made is not this restore's to make").toBeNull();
    const issue = issueOf(`ipo_record_link:${tradeId}`);
    expect(issue?.title, "and Data Quality asks").toBe("IPO record not linked to its holding");
    expect(issue!.detail).toContain(`#${guard} GUARD (matches this holding)`);
  });

  it("writes nothing, and throws nothing, when no record could be the restored holding's", () => {
    selectAccount(ACC_REF);
    const tradeId = holding(ACC_REF, "NOIPO");
    // Another scrip's record: a different name AND a different allotment — so
    // neither tier can see it. (G-G2-1, wave 2M: identical dates and quantity
    // ARE now a match whatever the name, which is the whole point of tier B, so
    // a record meant to be unmatchable has to differ in its facts too.)
    const other = ipoRecord(ACC_REF, "SOMETHINGELSE", null, 25, { allotmentDate: "2025-07-01", exitDate: "2025-08-04" });
    const d = del.deleteTradesByIds([tradeId], "L6: nothing to pair", "test");
    expect(d.ok, d.message).toBe(true);
    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);
    expect(linkOf(other), "a record for another scrip is never claimed").toBeNull();
    // …and it is still ASKED about (G-G2-1): the record's exit and the holding's
    // sale are two statements of a sale in one book until the user settles it.
    //
    // MOVED by D1 (fix wave 2N, counted-once#3): a holding NO record's facts
    // match no longer raises its own issue — six such holdings beside one stray
    // record raised six identical warnings and floored the score at 22. They are
    // ONE issue per account, which says the same thing once and still names
    // every holding and every record.
    expect(issueOf(`ipo_record_link:${tradeId}`), "no per-holding issue: nothing matched it").toBeUndefined();
    const issue = issueOf(`ipo_record_link:account:${ACC_REF}`);
    expect(issue?.title, "the pair is named, never guessed").toBe("IPO records not linked to their holdings");
    expect(issue!.ids, "and the holding is named by id").toContain(tradeId);
    expect(issue!.detail).toContain(`#${other} SOMETHINGELSE`);
    expect(issue!.detail, "and nothing claims the facts agree").not.toContain("matches this holding");
  });
});

/**
 * G-G2-1 (wave 2M) — the shape the harness found: a record entered on /ipos
 * under the ISSUE's name, whose holding is restored from a pre-4.3.0 envelope.
 *
 * Before wave 2M the name clause matched nothing, so no link was written AND no
 * question was raised: the holding came back closed, the record went on
 * realising its own exit, and the one sale was counted twice in the capital
 * summary, the tax pack, the ITR export and both AIS sides.
 *
 * MOVED by D1 (fix wave 2N, re-check finding counted-once#0): tier B is what
 * MARKS the pair, never what a restore WRITES. `ipos` carries no scrip fact, so
 * two allotments of the same lot size on one day, both sold on listing day —
 * an ordinary retail pattern — are indistinguishable to it, and the wave 2M
 * restore attached the wrong issue's record, whose own sale then vanished from
 * every consumer. So the question is raised and the user settles it, and the
 * moment they do the book counts the sale once.
 */
describe("a record named after the ISSUE, not the scrip", () => {
  it("is named in the question, not written onto the holding — and the link the user makes counts the sale once", async () => {
    selectAccount(ACC_ISSUE);
    const tradeId = holding(ACC_ISSUE, "TATATECH");
    const ipoId = ipoRecord(ACC_ISSUE, "Tata Technologies Limited", tradeId);
    const before = { capital: capitalOf(), itr: taxItr.countItrRows(), ais: await aisOf() };
    expect([before.capital.totalRealised, before.capital.ipoRealised, before.itr], "the linked book counts one sale").toEqual([TRADE_NET, 0, 1]);

    const d = del.deleteTradesByIds([tradeId], "G-G2-1: deleted the way 4.2.x deleted", "test");
    expect(d.ok, d.message).toBe(true);
    makeLegacy(d.snapshotId!);
    expect([tradeExists(tradeId), linkOf(ipoId)]).toEqual([false, null]);

    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);
    // THE pin: nothing is written, and the question names the record as matching
    // by its own allotment facts and states the double count it would settle.
    expect(linkOf(ipoId), "nothing on this row proves it is THIS scrip's allotment").toBeNull();
    const issue = issueOf(`ipo_record_link:${tradeId}`);
    expect(issue?.title, "the pair is named").toBe("IPO record not linked to its holding");
    expect(issue!.detail).toContain(`#${ipoId} Tata Technologies Limited (matches this holding)`);
    expect(issue!.detail).toContain("counted once in IPOs and again as the holding's own sale");

    // …and the user's own answer settles it: the sale is counted once again,
    // exactly as it was before the delete.
    t.db.update(t.schema.ipos).set({ tradeId }).where(eq(t.schema.ipos.id, ipoId)).run();
    expect({ capital: capitalOf(), itr: taxItr.countItrRows(), ais: await aisOf() }).toEqual(before);
    expect(issueOf(`ipo_record_link:${tradeId}`), "nothing left to ask about").toBeUndefined();
  });

  it("writes nothing when two issue-named records state the same allotment, and the question names both", () => {
    selectAccount(ACC_LOOK);
    const tradeId = holding(ACC_LOOK, "GOLOOK");
    const mine = ipoRecord(ACC_LOOK, "Go Look Industries Limited", tradeId);
    const twin = ipoRecord(ACC_LOOK, "Go Look Industries Ltd", null);

    const d = del.deleteTradesByIds([tradeId], "G-G2-1: two look-alike records", "test");
    expect(d.ok, d.message).toBe(true);
    makeLegacy(d.snapshotId!);
    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);

    expect([linkOf(mine), linkOf(twin)], "neither is guessed onto the holding (invariant 6)").toEqual([null, null]);
    const issue = issueOf(`ipo_record_link:${tradeId}`);
    expect([issue?.severity, issue?.title]).toEqual(["warning", "IPO record not linked to its holding"]);
    expect(issue!.detail).toContain("2 exited IPO records");
    expect(issue!.detail).toContain(`#${mine} Go Look Industries Limited (matches this holding)`);
    expect(issue!.detail).toContain(`#${twin} Go Look Industries Ltd (matches this holding)`);
    expect(issue!.detail).toContain("counted once in IPOs and again as the holding's own sale");
  });
});

/**
 * D1 (v4.3.0 wave 2M, seam finding F28) — the restore and the report read ONE
 * candidate set: the account's unlinked records that state an ALLOTMENT.
 *
 * `lib/trash.ts` read every unlinked record; the report read only the allotted,
 * exited ones. The row that split them is the one a user records when they
 * APPLY — under the TICKER, never allotted, never exited. It matched the name
 * tier (an unstated quantity is not evidence either way), so the restore saw
 * two candidates and wrote nothing, while the report saw one and said it
 * matched this holding: a pairing its own report called unambiguous, with the
 * one sale still counted twice in capital, the tax pack, the ITR export and
 * both AIS sides.
 */
describe("the application row a user keeps beside the allotment", () => {
  it("is a candidate nowhere, so the question names the allotment alone", async () => {
    selectAccount(ACC_APPLY);
    const tradeId = holding(ACC_APPLY, "F28IND");
    const allotment = ipoRecord(ACC_APPLY, "F28 Industries Limited", tradeId);
    // Recorded when they applied: the ticker's name, no allotment, no exit.
    const application = t.db
      .insert(t.schema.ipos)
      .values({
        accountId: ACC_APPLY, name: "F28IND", broker: "zerodha", exchange: "NSE",
        appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: false, allottedQty: 0,
        listingPrice: null, exitPrice: null, appliedDate: "2025-06-01", allotmentDate: null,
        listingDate: null, exitDate: null, tradeId: null,
      })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;
    const before = { capital: capitalOf(), itr: taxItr.countItrRows(), ais: await aisOf() };
    expect([before.capital.totalRealised, before.capital.ipoRealised, before.itr], "the linked book counts one sale").toEqual([TRADE_NET, 0, 1]);

    const d = del.deleteTradesByIds([tradeId], "D1: deleted the way 4.2.x deleted", "test");
    expect(d.ok, d.message).toBe(true);
    makeLegacy(d.snapshotId!);
    expect([tradeExists(tradeId), linkOf(allotment)]).toEqual([false, null]);

    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);
    // MOVED by D1 (fix wave 2N): this allotment carries the ISSUE's name, so
    // tier B is what recognises it — and tier B is never what a restore writes
    // (counted-once#0). The pin F28 exists for is unchanged and is the one
    // below: the application row is a candidate NOWHERE, so the report names
    // exactly ONE record and the restore weighed exactly one.
    expect(linkOf(application), "nothing is ever written onto an application row").toBeNull();
    expect(linkOf(allotment), "and a record named after the issue is asked about, not written").toBeNull();
    const issue = issueOf(`ipo_record_link:${tradeId}`);
    expect(issue!.detail).toContain(`#${allotment} F28 Industries Limited (matches this holding)`);
    // On revert of either half of the candidate rule: the application row is a
    // second candidate and the note names it too.
    expect(issue!.detail, "the application row is in no candidate set").not.toContain(`#${application}`);

    // The user's own answer, and the sale is counted once again.
    t.db.update(t.schema.ipos).set({ tradeId }).where(eq(t.schema.ipos.id, allotment)).run();
    expect({ capital: capitalOf(), itr: taxItr.countItrRows(), ais: await aisOf() }).toEqual(before);
    expect(issueOf(`ipo_record_link:${tradeId}`), "nothing left to ask about").toBeUndefined();
  });
});

/**
 * D1, the other direction: an allotted record with NO exit stated. The restore
 * has always been able to link it on its name, and the report could not see it
 * at all — so an ambiguous restore (two candidates, nothing written) was
 * reported as one candidate that matched. The two now read the same set, and
 * the note says which of them states an exit.
 */
describe("an allotted record with no exit stated, beside an exited one", () => {
  it("makes the pairing ambiguous, and the question names both", () => {
    selectAccount(ACC_OPEN);
    const tradeId = holding(ACC_OPEN, "GOMIX");
    const exited = ipoRecord(ACC_OPEN, "Go Mix Industries Limited", tradeId);
    const openRecord = ipoRecord(ACC_OPEN, "GOMIX", null, 10, { exitPrice: null, exitDate: null, listingPrice: null });

    const d = del.deleteTradesByIds([tradeId], "D1: an un-exited allotted record in the book", "test");
    expect(d.ok, d.message).toBe(true);
    makeLegacy(d.snapshotId!);
    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);

    expect([linkOf(exited), linkOf(openRecord)], "two candidates — neither is guessed (invariant 6)").toEqual([null, null]);
    const issue = issueOf(`ipo_record_link:${tradeId}`);
    expect([issue?.severity, issue?.title]).toEqual(["warning", "IPO record not linked to its holding"]);
    // On revert of the query's candidate set: the un-exited record is invisible
    // to the report, which then names one candidate and calls it a match — the
    // restore having written nothing.
    expect(issue!.detail).toContain(`an exited IPO record in the same account states an exit with no holding attached (#${exited} Go Mix Industries Limited (matches this holding))`);
    expect(issue!.detail).toContain(`The same account also holds an allotted IPO record with no holding attached and no exit stated (#${openRecord} GOMIX (matches this holding)), which a restore reads as a candidate for this holding too.`);
  });
});

/**
 * D1 (v4.3.0 fix wave 2N, re-check finding "counted-once#0", silent wrong
 * number) — TIER B IS NEVER WHAT A RESTORE WRITES.
 *
 * `matchesByExit` carries no scrip fact: `ipos` has no symbol or ISIN column,
 * so a record named after ANOTHER issue whose four allotment facts coincide
 * with the holding's (allotted, the same quantity, the same allotment day, the
 * same exit day — two listing-day exits of the same lot size is an ordinary
 * retail pattern) claimed the holding. The counted-once rule then excluded that
 * record because its now-linked trade was counted, and the record's OWN,
 * genuinely separate sale left the capital summary, the tax pack, the ITR
 * export and both AIS sides with nothing on screen saying so.
 *
 * Tier B stays what MARKS a candidate in the question. What a restore may WRITE
 * is the NAME tier (`ipoRecordNamesHolding`), which is the only clause that
 * carries the scrip.
 */
describe("a stray exited record of ANOTHER scrip, stating the same allotment facts", () => {
  it("is never written onto the restored holding, and its own sale is still counted", async () => {
    selectAccount(ACC_BEE);
    const tradeId = holding(ACC_BEE, "AAAIPO", {
      buyQty: 15, buyValue: 1500, sellQty: 15, avgSellPrice: 140, sellValue: 2100,
      sellDate: "2025-06-14", grossPnl: 600, chargesTotal: 9.75, netPnl: 590.25,
    });
    // The user's own record of a DIFFERENT issue, never entered as a trade.
    const bee = ipoRecord(ACC_BEE, "Bee Industries Limited", null, 15, { exitPrice: 160, exitDate: "2025-06-14" });
    const before = { capital: capitalOf(), itr: taxItr.countItrRows(), ais: await aisOf() };
    expect([before.itr, before.capital.ipoRealised > 0], "two sales, two rows: the holding's and the record's").toEqual([2, true]);

    const d = del.deleteTradesByIds([tradeId], "rc7 counted-once#0: a routine delete of a never-linked holding", "test");
    expect(d.ok, d.message).toBe(true);
    stripIpoRefs(d.snapshotId!);
    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);

    // On revert: `link` is the Bee record on AAAIPO, `ipoRealised` falls to 0,
    // `itr` to 1 and both AIS sides lose the record's own consideration.
    expect(linkOf(bee), "a record that names another issue is never written onto this holding").toBeNull();
    expect({ capital: capitalOf(), itr: taxItr.countItrRows(), ais: await aisOf() }).toEqual(before);
    // …and it is ASKED about, marked as matching, because the two rows' own
    // facts DO agree — which is exactly why no code may settle it.
    const issue = issueOf(`ipo_record_link:${tradeId}`);
    expect(issue?.title).toBe("IPO record not linked to its holding");
    expect(issue!.detail).toContain(`#${bee} Bee Industries Limited (matches this holding)`);
  });
});

/**
 * D1 (re-check finding "counted-once#1", medium) — an EXITED record is no
 * candidate for a holding that records no sale.
 *
 * Tier A compares the name and the quantity and never asked whether the holding
 * sold, so a restore attached an exited record to a position that is still
 * held: the double count the pairing exists to settle survived untouched, both
 * questions that named it were silenced, and the next save of that record on
 * /ipos would have closed the position with a sale it never had
 * (`tradePatchFromIpo` writes sellQty / sellDate / isOpen:false).
 */
describe("an exited record beside a holding that is still HELD", () => {
  it("is not written onto it, and the question says the record's exit is the only sale stated", () => {
    selectAccount(ACC_HELD);
    const tradeId = openHolding(ACC_HELD, "HELDIPO");
    const rec = ipoRecord(ACC_HELD, "HELDIPO", null);

    const d = del.deleteTradesByIds([tradeId], "rc7 counted-once#1: the holding never sold", "test");
    expect(d.ok, d.message).toBe(true);
    stripIpoRefs(d.snapshotId!);
    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);

    // On revert: the name tier matches and the record is written onto a
    // position that never sold.
    expect(linkOf(rec), "an exit is no allotment's record until that allotment sold").toBeNull();
    const issue = issueOf(`ipo_record_link:${tradeId}`);
    expect(issue?.title).toBe("IPO record not linked to its holding");
    expect(issue!.detail).toContain("this holding records no sale, so the record's exit is the only one stated");
    expect(issue!.detail, "and nothing claims a sale is counted twice").not.toContain("counted twice");
  });
});

/**
 * D1 (re-check finding "counted-once#1", the other half) — "unique in both
 * directions" is evaluated over the BOOK's unlinked IPO holdings, not just the
 * restored ones.
 *
 * `lib/trash.ts` built the holdings side from the envelope alone, so a holding
 * already in the book that claims the same record was invisible: the record was
 * written onto whichever holding happened to be in the envelope.
 */
describe("a second unlinked IPO holding of the same scrip, already in the book", () => {
  it("makes the pairing ambiguous, so the restore writes nothing", () => {
    selectAccount(ACC_BOOK);
    const staying = holding(ACC_BOOK, "BOOKIPO");
    const going = holding(ACC_BOOK, "BOOKIPO");
    const rec = ipoRecord(ACC_BOOK, "BOOKIPO", null);
    const before = capitalOf();

    const d = del.deleteTradesByIds([going], "rc7 counted-once#1: a twin holding stays in the book", "test");
    expect(d.ok, d.message).toBe(true);
    stripIpoRefs(d.snapshotId!);
    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);

    // On revert: the record is written onto `going` — the only holding the
    // envelope carried — while `staying` claims it just as well.
    expect(linkOf(rec), "two holdings reach for it: 'whichever the envelope carried' is not an answer").toBeNull();
    expect(capitalOf()).toEqual(before);
    expect([issueOf(`ipo_record_link:${staying}`) != null, issueOf(`ipo_record_link:${going}`) != null]).toEqual([true, true]);
  });
});

/**
 * D4 (v4.3.0 fix wave 2O, re-check finding "identity#0") — THE HALF THAT SAYS
 * WHY THE GATE KEYS ON THE ENVELOPE AND NOT ON `landed`.
 *
 * A PURGE snapshots every `ipos` row of the book (`account-delete.ts:859`),
 * including one whose `trade_id` names a holding in ANOTHER account — the
 * cross-book shape `lib/queries/ipos.ts:163-177` describes and a Trash restore
 * or an earlier merge can leave behind. That trade was never part of this
 * delete, so it is not in `landed` and never will be: gating the replay on
 * `landed` alone would CUT a live link, and an unlinked exited record beside the
 * holding it actually names is the sale counted twice — ₹482.61 in the
 * All-accounts view (probed by the design reviewer).
 *
 * So the gate is `envTradeIds.has(ref) && !landed.has(ref)`: only a reference
 * THIS delete removed and this restore could not bring back is cleared. This
 * case is green on HEAD (the replay is verbatim) and green after the fix; it goes
 * RED the moment the gate is `!landed.has(ref)`.
 */
describe("D4 · a purged book's record naming ANOTHER book's holding comes back with its link intact", () => {
  it("keeps the cross-account link verbatim, so no view counts that sale twice", () => {
    const foreignTrade = holding(ACC_XHOLD, "XLINK");
    const ownTrade = holding(ACC_XLINK, "XOWN", { acquisition: null, acquisitionPrice: null, acquisitionDate: null });
    // The record is filed in the book about to be purged; the holding it names
    // is not (invariant 8 — the two reads are deliberately different scopes).
    const record = ipoRecord(ACC_XLINK, "XLINK", foreignTrade);
    const views = [ACC_XLINK, ACC_XHOLD, 0];
    // The ITR export, narrowed to the three scrips THIS case owns: the
    // All-accounts view reads every book in this file's single temp database
    // (AGENTS.md: one temp database per FILE), so an absolute total there would
    // be every case's. A scrip filter is absolute about the one thing under test.
    const MINE = ["XLINK", "XOWN", "XLINK (IPO)"];
    const perView = () =>
      views.map((v) => {
        selectAccount(v);
        return {
          capital: capitalOf(),
          itr: taxItr.getItrExportRows().map((r) => r.scrip).filter((s) => MINE.includes(s)).sort(),
        };
      });
    const before = perView();
    // The shape is only interesting because the record's own sale is NOT stated
    // twice today: All accounts counts the holding and leaves the record out,
    // while the record's own book counts the record (its holding is not in view).
    expect(before[2].itr, "All accounts: the holding is counted, the record is not").toEqual(["XLINK", "XOWN"]);
    expect(before[0].itr, "its own book: the record states its own exit").toEqual(["XLINK (IPO)", "XOWN"]);

    selectAccount(1);
    const res = accDel.deleteAccount({ accountId: ACC_XLINK, mode: "purge", connections: "delete" });
    expect(res.ok, res.message).toBe(true);
    expect(t.db.select().from(t.schema.ipos).all().some((r) => r.id === record), "the purge took its own IPO rows").toBe(false);
    expect(tradeExists(foreignTrade), "and left the other book alone").toBe(true);

    const back = trash.restoreTrashSnapshot(res.snapshotId!, "D4 probe");
    expect([back.ok, back.restored], back.message).toEqual([true, 1]);
    expect(tradeExists(ownTrade)).toBe(true);
    // THE assertion: a reference this delete never touched is replayed verbatim.
    expect(linkOf(record), "the holding it names is still in the journal").toBe(foreignTrade);
    expect(back.message, "and nothing was cleared, so nothing is claimed to have been").not.toContain("unlinked");
    // Under a `landed`-only gate: All accounts reads ["XLINK", "XLINK (IPO)",
    // "XOWN"] and its `ipoRealised` gains the record's ₹482.61 — one sale, twice.
    expect(perView(), "every view reads exactly what it read before the purge").toEqual(before);
  });

  /**
   * The ledger half of the SAME gate — one rule for every replayed row that names
   * a trade. `ledger_entries.ref_trade_id` is the dividend/TDS provenance link
   * (`lib/corporate-actions-apply.ts:162`/`:188` write it; `lib/queries/ledger.ts`
   * carries it through), and only a PURGE snapshots ledger rows today.
   */
  it("clears a replayed ledger entry's reference when its trade cannot come back, and keeps a foreign one", () => {
    const own = holding(ACC_XLEDGER, "XLEDG", { acquisition: null, acquisitionPrice: null, acquisitionDate: null });
    const foreign = holding(ACC_XHOLD, "XFOR", { acquisition: null, acquisitionPrice: null, acquisitionDate: null });
    const entry = (refTradeId: number, note: string) =>
      t.db
        .insert(t.schema.ledgerEntries)
        .values({
          accountId: ACC_XLEDGER, date: "2025-09-20", bucket: "equity", type: "dividend",
          amountPaise: 12_500, refTradeId, symbol: "XLEDG", note, source: "corporate_action",
        })
        .returning({ id: t.schema.ledgerEntries.id })
        .get()!.id;
    const mine = entry(own, "this book's own holding");
    const theirs = entry(foreign, "another book's holding");
    const refOf = (id: number) => t.db.select().from(t.schema.ledgerEntries).all().find((r) => r.id === id)!.refTradeId;

    selectAccount(1);
    const res = accDel.deleteAccount({ accountId: ACC_XLEDGER, mode: "purge", connections: "delete" });
    expect(res.ok, res.message).toBe(true);
    // The freed id, taken by another trade — the shape a restore against a
    // database whose rowids came from elsewhere meets.
    holding(ACC_XHOLD, "XTAKEN", { id: own, acquisition: null, acquisitionPrice: null, acquisitionDate: null });

    const back = trash.restoreTrashSnapshot(res.snapshotId!, "D4 probe");
    expect([back.ok, back.restored], back.message).toEqual([true, 0]);
    expect(refOf(mine), "its trade did not come back, so it names nothing").toBeNull();
    expect(refOf(theirs), "a reference this delete never touched is replayed verbatim").toBe(foreign);
    expect(back.message).toContain("1 ledger entry came back without its trade reference");
  });
});
