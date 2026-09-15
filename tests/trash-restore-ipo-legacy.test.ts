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
let capital: typeof import("@/lib/queries/capital");
let taxItr: typeof import("@/lib/queries/tax-itr");
let dq: typeof import("@/lib/queries/data-quality");
let ais: typeof import("@/app/api/ais/route");
let trashDir = "";

const ACC_ONE = 941; // one candidate record — the re-link
const ACC_TWO = 942; // two candidate records — no link, a question instead
const ACC_REF = 943; // envelopes that DO carry ipoRefs

const TRADE_NET = 490.25; // 10 × (150 − 100) − 9.75 of charges, as the row states them

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

/** A closed eq_delivery holding flagged as an IPO allotment: 10 @100 → 150. */
function holding(accountId: number, symbol: string) {
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
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

/** The IPO record that holding became: allotted 10 @100, exited at 150. */
function ipoRecord(accountId: number, name: string, tradeId: number | null, allottedQty = 10) {
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
   * The deliberate consequence, pinned so it is a decision and not a surprise:
   * BOTH delete writers omit `ipoRefs` when the delete broke no link
   * (`ipoRefRows.length ? ipoRefRows : undefined`), so a 4.3 envelope for an
   * unlinked holding is byte-identical to a 4.2.x one and takes the same path.
   * With one candidate it comes back linked — which is what the Data Quality
   * question would have asked for anyway. Writing `ipoRefs: []` from the two
   * writers is the one-line edit that would confine the fallback to genuinely
   * legacy envelopes; `lib/trash.ts` already keys on the field being ABSENT.
   */
  it("a delete that broke NO link writes no ipoRefs at all, so an unlinked holding with one candidate comes back linked", () => {
    selectAccount(ACC_REF);
    const tradeId = holding(ACC_REF, "GUARD");
    const guard = ipoRecord(ACC_REF, "GUARD", null);
    const d = del.deleteTradesByIds([tradeId], "L6: no link to carry", "test");
    expect(d.ok, d.message).toBe(true);
    const env = JSON.parse(fs.readFileSync(path.join(trashDir, d.snapshotId!, "snapshot.json"), "utf8")) as Record<string, unknown>;
    expect("ipoRefs" in env, "the writer drops the field rather than stating an empty list").toBe(false);

    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);
    expect(linkOf(guard)).toBe(tradeId);
    expect(issueOf(`ipo_record_link:${tradeId}`), "linked, so nothing left to ask").toBeUndefined();
  });

  it("writes nothing, and throws nothing, when no record could be the restored holding's", () => {
    selectAccount(ACC_REF);
    const tradeId = holding(ACC_REF, "NOIPO");
    const other = ipoRecord(ACC_REF, "SOMETHINGELSE", null);
    const d = del.deleteTradesByIds([tradeId], "L6: nothing to pair", "test");
    expect(d.ok, d.message).toBe(true);
    expect(trash.restoreTrashSnapshot(d.snapshotId!).restored).toBe(1);
    expect(linkOf(other), "a record for another scrip is never claimed").toBeNull();
    expect(issueOf(`ipo_record_link:${tradeId}`), "and no pair is invented to ask about").toBeUndefined();
  });
});
