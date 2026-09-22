import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * TAX IS PER TAX PERSON (v4.5.0 wave TP, owner ruling T1) — against a real
 * database, through every reader the four tax surfaces and the two exports use.
 *
 * `tests/tax-person.test.ts` pins WHO IS WHO (the pure grouping). This file
 * pins WHAT EACH PERSON READS: the ONE deliberate widening of invariant 8
 * (`lib/queries/tax-scope.ts`, registered in prose in
 * tests/account-isolation.test.ts). Its two halves:
 *
 *   • a person-scoped read returns EVERY account of that person — archived ones
 *     included, because a closed account's realised sales are still taxable —
 *     and never a row of anybody else's;
 *   • an EMPTY scope (the All-accounts view over a book holding more than one
 *     person) filters to NO ROWS, never to "all". A total spanning two tax
 *     persons is a number nobody can file (invariant 6), so the pages show a
 *     person picker instead.
 *
 * ── THE BOOK ────────────────────────────────────────────────────────────────
 *
 *   #1 "Primary"      person A ("Aarav Sharma")   live
 *   #2 "A archived"   person A (typed "  aarav   SHARMA ")   ARCHIVED
 *   #3 "Spouse"       person B ("Meera Sharma")   live
 *   #4 "Dhan manual"  NO identity                 live  — its own person
 *
 * Account #4 is the account-#3 class (docs/DECISIONS.md): a manual, batchless
 * book. It states no identity, so it is its OWN person and no other person's
 * tax read may so much as touch it — asserted byte-for-byte at the end.
 *
 * Every money figure is STATED on the row it is inserted with, so every
 * expectation below is arithmetic on this file's own numbers.
 *
 * ONE temp database for the FILE (AGENTS.md Testing).
 */

let t: TempDb;
let q: {
  scope: typeof import("@/lib/queries/tax-scope");
  trades: typeof import("@/lib/queries/trades");
  taxItr: typeof import("@/lib/queries/tax-itr");
  ipos: typeof import("@/lib/queries/ipos");
  bf: typeof import("@/lib/queries/bf-losses");
  challans: typeof import("@/lib/queries/challans");
  ledger: typeof import("@/lib/queries/ledger");
  dq: typeof import("@/lib/queries/data-quality");
  accountDelete: typeof import("@/lib/queries/account-delete");
  ais: typeof import("@/app/api/ais/route");
  accountsRoute: typeof import("@/app/api/accounts/route");
  harvest: typeof import("@/lib/analytics/harvest");
};

const A1 = 1; //  person A, live
const A2 = 2; //  person A, ARCHIVED
const B3 = 3; //  person B
const M4 = 4; //  no identity — its own person (the account-#3 class)

const PERSON_A = "Aarav Sharma";
const PERSON_B = "Meera Sharma";
const FY = "2025-26"; // buy 2025-06-10, sell 2025-09-20 both fall in it
const BUY = "2025-06-10";
const SELL = "2025-09-20";
const LT_BUY = "2024-04-10"; // > 12 months before SELL — long term

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));

/** A closed equity-delivery round trip with every money figure stated. */
function closed(accountId: number, symbol: string, o: { qty: number; buy: number; sell: number; charges: number; buyDate?: string }) {
  const buyValue = o.qty * o.buy;
  const sellValue = o.qty * o.sell;
  return t.db
    .insert(t.schema.trades)
    .values(tradeRow({
      accountId, broker: "zerodha", segment: "eq_delivery", symbol, tradingsymbol: symbol,
      buyQty: o.qty, avgBuyPrice: o.buy, buyValue, buyDate: o.buyDate ?? BUY,
      sellQty: o.qty, avgSellPrice: o.sell, sellValue, sellDate: SELL,
      grossPnl: sellValue - buyValue, chargesTotal: o.charges, netPnl: r2(sellValue - buyValue - o.charges),
      isOpen: false,
    }))
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

/** POST /api/ais with nothing to parse: the journal's own FY totals surface. */
async function aisOf(accountId: number): Promise<{ totals: Record<string, number | null>; scope: string }> {
  select(accountId);
  const res = await q.ais.POST(
    new Request("http://local/api/ais", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "nothing to parse" }) }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] }; scope: string };
  return { totals: Object.fromEntries(body.recon.fyTotals.map((f) => [`${f.fy} ${f.kind}`, f.journal])), scope: body.scope };
}

// The raised hook timeout is for the Windows runner, > 15x slower than a dev
// machine on SQLite-file work (AGENTS.md Testing); locally this hook is
// migrate + seed + the inserts below, measured at ~1.1 s.
beforeAll(async () => {
  t = await openTempDb("tax-person-scope", { seed: true });
  q = {
    scope: await import("@/lib/queries/tax-scope"),
    trades: await import("@/lib/queries/trades"),
    taxItr: await import("@/lib/queries/tax-itr"),
    ipos: await import("@/lib/queries/ipos"),
    bf: await import("@/lib/queries/bf-losses"),
    challans: await import("@/lib/queries/challans"),
    ledger: await import("@/lib/queries/ledger"),
    dq: await import("@/lib/queries/data-quality"),
    accountDelete: await import("@/lib/queries/account-delete"),
    ais: await import("@/app/api/ais/route"),
    accountsRoute: await import("@/app/api/accounts/route"),
    harvest: await import("@/lib/analytics/harvest"),
  };

  t.sqlite.prepare("UPDATE accounts SET name = 'Primary', tax_identity = ? WHERE id = ?").run(PERSON_A, A1);
  t.db.insert(t.schema.accounts).values([
    // The SAME person, typed differently, and CLOSED — its realised sales are
    // still taxable, so the person's pack must include it.
    { id: A2, name: "A archived", isDefault: false, taxIdentity: "  aarav   SHARMA ", archived: true },
    { id: B3, name: "Spouse", isDefault: false, taxIdentity: PERSON_B },
    { id: M4, name: "Dhan manual", isDefault: false },
  ]).run();

  // ── trades ───────────────────────────────────────────────────────────────
  closed(A1, "A1SOLD", { qty: 10, buy: 100, sell: 150, charges: 9.75 }); //  net  490.25
  closed(A2, "A2SOLD", { qty: 20, buy: 50, sell: 60, charges: 8 }); //        net  192.00
  closed(A2, "A2LONG", { qty: 10, buy: 100, sell: 300, charges: 10, buyDate: LT_BUY }); // net 1990.00, LONG
  closed(B3, "B3SOLD", { qty: 10, buy: 100, sell: 200, charges: 10 }); //     net  990.00
  closed(M4, "M4SOLD", { qty: 5, buy: 200, sell: 260, charges: 5 }); //       net  295.00
  // One OPEN row per person, so the harvest reader has something to hold.
  for (const [acct, sym] of [[A1, "A1OPEN"], [B3, "B3OPEN"]] as [number, string][]) {
    t.db.insert(t.schema.trades).values(tradeRow({
      accountId: acct, broker: "zerodha", segment: "eq_delivery", symbol: sym, tradingsymbol: sym,
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: BUY, isOpen: true,
    })).run();
  }

  // ── IPOs: one exited record per person, none linked ───────────────────────
  t.db.insert(t.schema.ipos).values([
    { accountId: A2, name: "A-IPO", broker: "zerodha", exchange: "NSE", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, listingPrice: 130, exitPrice: 150, appliedDate: "2025-06-01", allotmentDate: BUY, listingDate: "2025-06-14", exitDate: SELL },
    { accountId: B3, name: "B-IPO", broker: "zerodha", exchange: "NSE", appliedPrice: 50, lotSize: 20, lotsApplied: 1, allotted: true, allottedQty: 20, listingPrice: 60, exitPrice: 70, appliedDate: "2025-06-01", allotmentDate: BUY, listingDate: "2025-06-14", exitDate: SELL },
  ]).run();

  // ── brought-forward lots: BOTH of person A's accounts, and one of B's ─────
  t.db.insert(t.schema.bfLossLots).values([
    { accountId: A1, incurredFy: "2023-24", head: "stcl", amount: 10_000 },
    { accountId: A2, incurredFy: "2023-24", head: "ltcl", amount: 25_000 },
    { accountId: B3, incurredFy: "2023-24", head: "stcl", amount: 77_000 },
  ]).run();

  // ── challans: one in each of A's books, one in B's ────────────────────────
  t.db.insert(t.schema.advanceTaxChallans).values([
    { accountId: A1, fy: FY, paidOn: "2025-06-14", amount: 15_000 },
    { accountId: A2, fy: FY, paidOn: "2025-09-14", amount: 5_000 },
    { accountId: B3, fy: FY, paidOn: "2025-06-14", amount: 40_000 },
  ]).run();

  // ── ledger: dividends in both of A's books, one in B's ────────────────────
  t.db.insert(t.schema.ledgerEntries).values([
    { accountId: A1, date: "2025-07-01", type: "dividend", symbol: "A1SOLD", amountPaise: 1_200_00, bucket: "equity" },
    { accountId: A2, date: "2025-07-02", type: "dividend", symbol: "A2SOLD", amountPaise: 800_00, bucket: "equity" },
    { accountId: B3, date: "2025-07-03", type: "dividend", symbol: "B3SOLD", amountPaise: 5_000_00, bucket: "equity" },
  ]).run();
}, 120_000);

afterAll(() => t?.cleanup());

// ═══ resolveTaxScope — the four rules ═══════════════════════════════════════

describe("resolveTaxScope", () => {
  it("rule 2 — a selected account names its PERSON, and the person's ARCHIVED account is in scope", () => {
    select(A1);
    const s = q.scope.resolveTaxScope();
    // A closed account's realised sales are still taxable, so #2 is here.
    expect([s.personKey, s.label, s.accountIds, s.unassigned]).toEqual(["AARAV SHARMA", PERSON_A, [A1, A2], false]);
    expect(q.scope.taxScopeHeader(s), "the line every tax page and export carries")
      .toBe(`Tax person: ${PERSON_A} — accounts: Primary, A archived`);
    // …and selecting the archived account itself resolves the same person.
    select(A2);
    expect(q.scope.resolveTaxScope().accountIds).toEqual([A1, A2]);
  });

  it("rule 4 — All accounts over more than one person yields NO figure and a picker", () => {
    select(0);
    const s = q.scope.resolveTaxScope();
    expect([s.accountIds, s.personKey, s.label]).toEqual([[], "", ""]);
    expect(q.scope.needsPersonChoice(s)).toBe(true);
    expect(s.candidates?.map((c) => [c.label, c.accountIds])).toEqual([
      [PERSON_A, [A1, A2]],
      [PERSON_B, [B3]],
      ["Dhan manual", [M4]],
    ]);
    expect(q.scope.taxScopeHeader(s)).toBe("Tax person: not chosen — no figure");
  });

  it("rule 3 — All accounts with exactly ONE person in the book IS that person", () => {
    // Stated by narrowing the book for the length of the read: with one person
    // there is nothing to choose between, so the picker would be noise.
    t.sqlite.prepare("UPDATE accounts SET tax_identity = ? WHERE id IN (?, ?, ?)").run(PERSON_A, A2, B3, M4);
    try {
      select(0);
      const s = q.scope.resolveTaxScope();
      expect([s.accountIds, s.label]).toEqual([[A1, A2, B3, M4], PERSON_A]);
      expect(q.scope.needsPersonChoice(s)).toBe(false);
    } finally {
      t.sqlite.prepare("UPDATE accounts SET tax_identity = ? WHERE id = ?").run("  aarav   SHARMA ", A2);
      t.sqlite.prepare("UPDATE accounts SET tax_identity = ? WHERE id = ?").run(PERSON_B, B3);
      t.sqlite.prepare("UPDATE accounts SET tax_identity = NULL WHERE id = ?").run(M4);
    }
  });

  it("rule 1 — ?person= wins, matches whatever case the link carries, and an UNKNOWN key falls through", () => {
    select(A1);
    for (const param of [PERSON_B, "meera sharma", "  MEERA   SHARMA  "]) {
      expect(q.scope.resolveTaxScope(param).accountIds, `?person=${param}`).toEqual([B3]);
    }
    // The unassigned key shape the picker puts in the link is lower-case.
    expect(q.scope.resolveTaxScope(`account:${M4}`).accountIds, "the account-#3 book, picked by key").toEqual([M4]);
    expect(q.scope.resolveTaxScope(`ACCOUNT:${M4}`).accountIds, "and case-insensitively").toEqual([M4]);
    // An unknown person is NOT a scope of its own: it falls through to the
    // selected account's person rather than inventing one (or reading nothing).
    expect(q.scope.resolveTaxScope("Nobody At All").accountIds, "unknown → the rules below it").toEqual([A1, A2]);
    select(0);
    expect(q.scope.resolveTaxScope("Nobody At All").accountIds, "…and from All accounts, still no figure").toEqual([]);
  });

  it("a book with NO identity is its own person, labelled by the account's name", () => {
    select(M4);
    const s = q.scope.resolveTaxScope();
    expect([s.personKey, s.label, s.accountIds, s.unassigned]).toEqual([`account:${M4}`, "Dhan manual", [M4], true]);
  });

  it("accountScopeWhere: an EMPTY person list reads NO rows — never every row", () => {
    select(0); // the All-accounts selection, where the legacy path reads everything
    const all = q.trades.getTrades().map((r) => r.symbol).sort();
    expect(all.length, "the legacy account scope still reads the whole journal here").toBe(7);
    expect(q.trades.getTrades([]), "an empty scope is `1 = 0`, not `no filter`").toEqual([]);
    expect(q.trades.getTaxTrades([]), "on the projected read too").toEqual([]);
    expect(q.bf.getBfLossRows([]), "and on every other table it filters").toEqual([]);
    expect(q.challans.getChallans(undefined, []), "challans").toEqual([]);
    expect(q.ledger.getLedgerEntries([]), "ledger").toEqual([]);
    expect(q.ipos.getIposComputed([]).rows, "IPOs").toEqual([]);
  });
});

// ═══ every threaded reader ══════════════════════════════════════════════════

describe("every threaded reader returns the person's rows and nobody else's", () => {
  const scopeOf = (accountId: number) => {
    select(accountId);
    return q.scope.resolveTaxScope().accountIds;
  };

  it("trades: getTrades, getTaxTrades and getHarvestTrades", () => {
    const a = scopeOf(A1);
    expect(q.trades.getTrades(a).map((r) => r.symbol).sort()).toEqual(["A1OPEN", "A1SOLD", "A2LONG", "A2SOLD"]);
    expect(q.trades.getTaxTrades(a).map((r) => r.symbol).sort()).toEqual(["A1OPEN", "A1SOLD", "A2LONG", "A2SOLD"]);
    expect(q.trades.getHarvestTrades(a).map((r) => r.symbol).sort()).toEqual(["A1OPEN", "A1SOLD", "A2LONG", "A2SOLD"]);
    const b = scopeOf(B3);
    expect(q.trades.getTrades(b).map((r) => r.symbol).sort(), "the other person's book, whole and alone")
      .toEqual(["B3OPEN", "B3SOLD"]);
    // Nothing of the manual book reaches either person.
    expect([...q.trades.getTrades(a), ...q.trades.getTrades(b)].some((r) => r.accountId === M4)).toBe(false);
  });

  it("the tax base: person A's four gains, person B's two, and neither holds the other's", () => {
    select(A1);
    const a = q.taxItr.getTaxBase();
    expect(a.scope.label).toBe(PERSON_A);
    // 490.25 (A1SOLD) + 192 (A2SOLD) + 1990 (A2LONG) + the A-IPO's own net.
    // `cgTrades` carries only what the gain classifier reads, so the rows are
    // named through the export they become.
    expect(a.closedTrades.map((r) => r.symbol).sort()).toEqual(["A1SOLD", "A2LONG", "A2SOLD"]);
    expect(a.exitedIpos.map((r) => r.name)).toEqual(["A-IPO"]);
    expect(sum(a.cgTrades.map((r) => r.netPnl)), "490.25 + 192 + 1990 + the record's own net")
      .toBe(r2(490.25 + 192 + 1990 + a.exitedIpos[0].netPnl));
    expect(q.taxItr.countItrRows()).toBe(4);
    expect(q.taxItr.getItrExportRows().map((r) => r.scrip).sort()).toEqual(["A-IPO (IPO)", "A1SOLD", "A2LONG", "A2SOLD"]);

    select(B3);
    const b = q.taxItr.getTaxBase();
    expect(b.closedTrades.map((r) => r.symbol)).toEqual(["B3SOLD"]);
    expect(b.exitedIpos.map((r) => r.name)).toEqual(["B-IPO"]);
    expect(q.taxItr.countItrRows()).toBe(2);
    // …and the sales that made person A's pack are counted ZERO times here.
    expect(q.taxItr.getItrExportRows().map((r) => r.scrip).sort()).toEqual(["B-IPO (IPO)", "B3SOLD"]);
  });

  it("the tax base takes the ?person= param, so an export from the picker is that person's", () => {
    select(A1);
    expect(q.taxItr.getTaxBase(PERSON_B).closedTrades.map((r) => r.symbol)).toEqual(["B3SOLD"]);
    expect(q.taxItr.countItrRows(PERSON_B)).toBe(2);
    expect(q.taxItr.getItrExportRows(PERSON_B).map((r) => r.scrip).sort()).toEqual(["B-IPO (IPO)", "B3SOLD"]);
  });

  it("the All-accounts view yields an EMPTY tax base — no figure, never a merged total", () => {
    select(0);
    const base = q.taxItr.getTaxBase();
    expect([base.cgTrades, base.exitedIpos, base.trades]).toEqual([[], [], []]);
    expect([q.taxItr.countItrRows(), q.taxItr.getItrExportRows()]).toEqual([0, []]);
  });

  it("IPOs: getIposComputed and ipoIdsCountedThroughTrades read one person's records", () => {
    const a = scopeOf(A1);
    expect(q.ipos.getIposComputed(a).rows.map((r) => r.name)).toEqual(["A-IPO"]);
    expect(q.ipos.getIposComputed(scopeOf(B3)).rows.map((r) => r.name)).toEqual(["B-IPO"]);
    // The "already counted" question is asked of the SAME view the consumer saw.
    const aIpoId = t.db.select().from(t.schema.ipos).all().find((r) => r.name === "A-IPO")!.id;
    t.sqlite.prepare("UPDATE ipos SET trade_id = (SELECT id FROM trades WHERE tradingsymbol = 'A2SOLD') WHERE id = ?").run(aIpoId);
    try {
      const counted = new Set(q.trades.getTrades(a).map((r) => r.id));
      expect([...q.ipos.ipoIdsCountedThroughTrades(counted, a)], "person A counts it through its holding").toEqual([aIpoId]);
      expect([...q.ipos.ipoIdsCountedThroughTrades(counted, scopeOf(B3))], "person B has no such record at all").toEqual([]);
    } finally {
      t.sqlite.prepare("UPDATE ipos SET trade_id = NULL WHERE id = ?").run(aIpoId);
    }
  });

  it("brought-forward lots are SUMMED across the person's accounts, each naming its source", () => {
    const a = scopeOf(A1);
    const rows = q.bf.getBfLossRows(a);
    // A loss carried in ONE of a person's accounts sets off gains in another —
    // that is what a single return does.
    expect(rows.map((r) => [r.accountId, r.incurredFy, r.head, r.amount])).toEqual([
      [A2, "2023-24", "ltcl", 25_000],
      [A1, "2023-24", "stcl", 10_000],
    ]);
    expect(sum(rows.map((r) => r.amount)), "the person's whole carry-forward").toBe(35_000);
    expect(q.bf.getBfLossRows(scopeOf(B3)).map((r) => [r.accountId, r.amount]), "and never the other person's")
      .toEqual([[B3, 77_000]]);
  });

  it("earliestJournalledFy asks its question over the SAME rows the timeline is built from", () => {
    // Person A's earliest closed sale is A2LONG's — in the ARCHIVED account.
    expect(q.bf.earliestJournalledFy(scopeOf(A1))).toBe(FY);
    expect(q.bf.earliestJournalledFy([])).toBeNull();
  });

  it("challans are SUMMED across the person's accounts, and a duplicate is caught across them", () => {
    const a = scopeOf(A1);
    expect(q.challans.getChallans(FY, a).map((r) => [r.accountId, r.amount])).toEqual([
      [A1, 15_000],
      [A2, 5_000],
    ]);
    expect(q.challans.challanTotalsByFy(FY, a).total, "one PAN, one liability, both books' payments").toBe(20_000);
    expect(q.challans.challanTotalsByFy(FY, scopeOf(B3)).total).toBe(40_000);
    // THE cross-account question: the same payment typed into the SECOND book of
    // the same person is the duplicate this warning exists for.
    const dup = q.challans.findDuplicateChallan(FY, "2025-09-14", 5_000 * 100, null, a);
    expect([dup?.accountId, dup?.amount], "found in the person's other account").toEqual([A2, 5_000]);
    expect(q.challans.findDuplicateChallan(FY, "2025-09-14", 5_000 * 100, null, scopeOf(B3)), "never across persons").toBeNull();
  });

  it("the ledger: both dividend readers are the person's", () => {
    const a = scopeOf(A1);
    expect(q.ledger.getLedgerEntries(a).map((r) => r.symbol).sort()).toEqual(["A1SOLD", "A2SOLD"]);
    expect(q.ledger.getDividendLedgerEntries(a).map((r) => [r.symbol, r.amountPaise]).sort()).toEqual([
      ["A1SOLD", 1_200_00],
      ["A2SOLD", 800_00],
    ]);
    expect(q.ledger.getDividendLedgerEntries(scopeOf(B3)).map((r) => r.symbol)).toEqual(["B3SOLD"]);
  });

  it("AIS is issued per PAN, so the route reconciles the PERSON's book and says whose it is", async () => {
    // Person A, FY 2025-26: purchases 1000 (A1SOLD) + 1000 (A2SOLD) + 1000
    // (A1OPEN) + the A-IPO allotment 1000 = 4000; sales 1500 + 1200 + 3000 +
    // the A-IPO exit 1500 = 7200. A2LONG was BOUGHT in FY 2024-25 and is
    // bucketed there — its 3000 sale is in this year's, once.
    const a = await aisOf(A1);
    expect([a.totals[`${FY} purchase`], a.totals[`${FY} sale`]]).toEqual([4000, 7200]);
    expect(a.totals["2024-25 purchase"], "the long-term buy, in the year it was made").toBe(1000);
    expect(a.scope).toBe(`Tax person: ${PERSON_A} — accounts: Primary, A archived`);
    // Person B: 1000 (B3SOLD) + 1000 (B3OPEN) + the B-IPO allotment 1000 = 3000;
    // sales 2000 + the B-IPO exit 1400 = 3400.
    const b = await aisOf(B3);
    expect([b.totals[`${FY} purchase`], b.totals[`${FY} sale`]]).toEqual([3000, 3400]);
    expect(b.scope).toBe(`Tax person: ${PERSON_B} — accounts: Spouse`);
    // And the All-accounts view reconciles NOTHING rather than merging persons.
    const none = await aisOf(0);
    expect([none.totals, none.scope]).toEqual([{}, "Tax person: not chosen — no figure"]);
  });

  it("the 112A exemption is consumed only by the person's OWN accounts", () => {
    const EXEMPTION = 125_000;
    const realisedLtcgFor = (accountId: number) => {
      const scope = scopeOf(accountId);
      const rows = q.trades.getHarvestTrades(scope).filter((r) => !r.isOpen && r.buyDate === LT_BUY);
      return sum(rows.map((r) => r.netPnl ?? 0));
    };
    // Person A's ONE long-term sale sits in the ARCHIVED account: it consumes
    // that person's exemption, and nobody else's.
    expect(realisedLtcgFor(A1), "read across both of A's books").toBe(1990);
    expect(q.harvest.ltcgExemptionHeadroom(realisedLtcgFor(A1), EXEMPTION)).toBe(EXEMPTION - 1990);
    // Person B realised no long-term gain, so their headroom is untouched by A's.
    expect(realisedLtcgFor(B3)).toBe(0);
    expect(q.harvest.ltcgExemptionHeadroom(realisedLtcgFor(B3), EXEMPTION), "a spouse's sale never spends this exemption")
      .toBe(EXEMPTION);
  });
});

// ═══ the surfaces that ASK about a person ═══════════════════════════════════

describe("the warnings a person boundary raises", () => {
  it("the bf_lot_dup Data Quality warning fires WITHIN one person and never across two", () => {
    // The same (incurredFy, head) lot in both of person A's books: the tax pages
    // seed the engine from both, so two transcriptions of one filed loss would
    // set off twice. It is a QUESTION, never an automatic de-duplication.
    const planted = t.db.insert(t.schema.bfLossLots)
      .values({ accountId: A2, incurredFy: "2023-24", head: "stcl", amount: 10_000 })
      .returning({ id: t.schema.bfLossLots.id }).get()!.id;
    try {
      select(A1);
      const issue = q.dq.getDataQualityReport().issues.find((x) => x.code.startsWith("bf_lot_dup:"));
      expect(issue?.title).toBe("Same brought-forward loss on two accounts of one tax person");
      expect(issue!.detail, "and it names both source accounts").toContain("Primary and A archived");
      expect(issue!.detail).toContain("Nothing is merged automatically");
      expect(issue!.severity).toBe("warning");
    } finally {
      t.sqlite.prepare("DELETE FROM bf_loss_lots WHERE id = ?").run(planted);
    }
    // B3 already holds a 2023-24 stcl lot of its own, and so does A1 — two
    // PERSONS holding the same vintage is not a duplicate at all.
    select(A1);
    expect(q.dq.getDataQualityReport().issues.some((x) => x.code.startsWith("bf_lot_dup:")), "never across persons").toBe(false);
  });

  it("a merge warns that the tax person CHANGES — and says nothing when it does not", () => {
    // Merging across two persons moves who files these gains. The dialog says so
    // BEFORE the press; the rows take the TARGET's person (owner ruling T1).
    const across = q.accountDelete.previewAccountDelete({ accountId: B3, mode: "merge", targetId: A1 });
    const warning = across.warnings?.find((w) => w.startsWith("Tax person changes:"));
    expect(warning, "the merge across two persons").toBeTruthy();
    expect(warning).toContain(PERSON_B);
    expect(warning).toContain(PERSON_A);
    // Two accounts of ONE person: nothing about who files anything changes.
    const within = q.accountDelete.previewAccountDelete({ accountId: A2, mode: "merge", targetId: A1 });
    expect(within.warnings?.some((w) => w.startsWith("Tax person changes:")), "one person, two books, no question")
      .toBe(false);
  });
});

// ═══ the accounts route ═════════════════════════════════════════════════════

describe("POST /api/accounts — saving a tax person leaves everything else alone", () => {
  const upsert = (body: Record<string, unknown>) =>
    q.accountsRoute.POST(new Request("http://local/api/accounts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "upsert", ...body }),
    }));

  it("a PARTIAL upsert of the tax person does NOT un-archive the account", async () => {
    const before = t.db.select().from(t.schema.accounts).all().find((a) => a.id === A2)!;
    expect(before.archived, "the fixture's archived book").toBe(true);
    const res = await upsert({ id: A2, name: before.name, taxIdentity: "Aarav Sharma" });
    expect(res.status, await res.text().catch(() => "")).toBe(200);
    const after = t.db.select().from(t.schema.accounts).all().find((a) => a.id === A2)!;
    // `archived` was `.default(false)` in the schema, so the partial body the
    // tax-person field sends carried a defaulted `false` into the UPDATE and
    // silently re-opened a closed book.
    expect(after.archived, "omitted means LEAVE IT ALONE").toBe(true);
    expect(after.taxIdentity, "and the field it was asked to save is saved").toBe("Aarav Sharma");
    // The person is unchanged by the re-typing — normalisation, not a new key.
    select(A1);
    expect(q.scope.resolveTaxScope().accountIds).toEqual([A1, A2]);
  });

  it("a NEW account still defaults to not-archived", async () => {
    const res = await upsert({ name: "TP new book" });
    expect(res.status).toBe(200);
    const created = t.db.select().from(t.schema.accounts).all().find((a) => a.name === "TP new book")!;
    expect(created.archived).toBe(false);
    t.sqlite.prepare("DELETE FROM accounts WHERE id = ?").run(created.id);
  });
});

// ═══ the account-#3 class ═══════════════════════════════════════════════════

describe("the account-#3 class — a manual book with no identity is its own person", () => {
  /** Every column of every row the manual book owns, as stored. */
  const snapshotOfM4 = () =>
    JSON.stringify({
      account: t.db.select().from(t.schema.accounts).all().filter((a) => a.id === M4),
      trades: t.db.select().from(t.schema.trades).all().filter((r) => r.accountId === M4),
      ipos: t.db.select().from(t.schema.ipos).all().filter((r) => r.accountId === M4),
      bf: t.db.select().from(t.schema.bfLossLots).all().filter((r) => r.accountId === M4),
      challans: t.db.select().from(t.schema.advanceTaxChallans).all().filter((r) => r.accountId === M4),
      ledger: t.db.select().from(t.schema.ledgerEntries).all().filter((r) => r.accountId === M4),
    });

  it("no other person's tax read or edit touches one byte of it", async () => {
    const before = snapshotOfM4();

    // Every tax surface, read for both of the OTHER persons…
    for (const accountId of [A1, B3]) {
      select(accountId);
      const scope = q.scope.resolveTaxScope();
      expect(scope.accountIds, "the manual book is in nobody else's scope").not.toContain(M4);
      q.taxItr.getTaxBase();
      q.taxItr.getItrExportRows();
      q.trades.getHarvestTrades(scope.accountIds);
      q.bf.getBfLossRows(scope.accountIds);
      q.challans.getChallans(FY, scope.accountIds);
      q.ledger.getDividendLedgerEntries(scope.accountIds);
      q.ipos.getIposComputed(scope.accountIds);
      await aisOf(accountId);
    }
    // …and an EDIT on another person's account, which is the write half.
    await q.accountsRoute.POST(new Request("http://local/api/accounts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "upsert", id: A1, name: "Primary", taxIdentity: PERSON_A }),
    }));

    expect(snapshotOfM4(), "byte-identical, column for column").toBe(before);
  });

  it("its own view reads its own book, and it is labelled as unassigned", () => {
    select(M4);
    const s = q.scope.resolveTaxScope();
    expect([s.accountIds, s.unassigned, s.label]).toEqual([[M4], true, "Dhan manual"]);
    expect(q.trades.getTaxTrades(s.accountIds).map((r) => r.symbol)).toEqual(["M4SOLD"]);
    expect(q.taxItr.getTaxBase().closedTrades.map((r) => r.symbol)).toEqual(["M4SOLD"]);
    expect(q.taxItr.getItrExportRows().map((r) => r.scrip)).toEqual(["M4SOLD"]);
  });
});
