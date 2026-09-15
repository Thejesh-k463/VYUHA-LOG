import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
// Both the action and the route revalidate pages after a write; there is no Next runtime here.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * IPO-ACCOUNT (v4.3.0 wave 2I) — an IPO record and the holding it became belong
 * to ONE account's book (invariant 8).
 *
 * "This holding came from an IPO" created the record with no accountId at all,
 * so the column took its schema default of 1 whatever account the holding was
 * in. After that the second account's /ipos could not see the record it had
 * just made; account 1's /ipos showed it joined to the other book's holding;
 * and saving an exit there closed that holding across the account boundary —
 * every `trades` read and the UPDATE in /api/ipos took no account filter, and
 * `getIposComputed`'s LEFT JOIN was on `ipos.trade_id` alone. The realised sale
 * then landed in BOTH single-account books.
 *
 * Also pinned here (wave 2I): the action could not be exercised by any test at
 * all, because its `recordAudit` before/after key sets differed and
 * `AuditShapeError` throws outside production (lib/audit.ts) — after the INSERT
 * and the UPDATE had already run. And a trade that carries `trade_legs` is
 * refused: rewriting the parent aggregate from an IPO leaves the legs unsummed
 * (invariant 5).
 *
 * ONE temp database for this file (AGENTS.md Testing).
 */

let t: TempDb;
let actions: typeof import("@/app/trades/actions");
let route: typeof import("@/app/api/ipos/route");
let q: typeof import("@/lib/queries/ipos");

const A1 = 1;
const A2 = 2;

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const iposAll = () => t.db.select().from(t.schema.ipos).all();
const named = (name: string) => iposAll().filter((r) => r.name === name);
const tradeOf = (id: number) => t.db.select().from(t.schema.trades).all().find((r) => r.id === id)!;

function holding(accountId: number, symbol: string, over: Record<string, unknown> = {}): number {
  return t.db
    .insert(t.schema.trades)
    .values(tradeRow({
      accountId, broker: "zerodha", segment: "eq_delivery", symbol, tradingsymbol: symbol,
      buyQty: 10, avgBuyPrice: 0, buyValue: 0, buyDate: "2026-02-20", isOpen: true, ...over,
    }))
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

const push = (tradeId: number) => {
  const fd = new FormData();
  fd.set("tradeId", String(tradeId));
  return actions.pushTradeToIpoAction({ ok: false, message: "" }, fd);
};

const post = (body: unknown) =>
  route.POST(new Request("http://local/api/ipos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

/** IpoForm's payload for an IPO row as stored. */
const payload = (over: Record<string, unknown> = {}) => ({
  name: "SCOPE-IPO", broker: "", exchange: "NSE", board: "mainboard", category: "", discountPerShare: "",
  appliedPrice: "100", lotSize: "10", lotsApplied: "1", allotted: true, allottedQty: 10, listingPrice: "130",
  exitPrice: "", appliedDate: "", allotmentDate: "2026-02-20", listingDate: "", exitDate: "", notes: "", ...over,
});

let a2Trade = 0;
let a1Trade = 0;
let a2Ipo = 0;

beforeAll(async () => {
  t = await openTempDb("ipo-account-scope", { seed: true });
  actions = await import("@/app/trades/actions");
  route = await import("@/app/api/ipos/route");
  q = await import("@/lib/queries/ipos");
  t.db.insert(t.schema.accounts).values({ id: A2, name: "second book", isDefault: false }).run();
  a2Trade = holding(A2, "SCOPEA2");
  a1Trade = holding(A1, "SCOPEA1");
}, 30_000);

afterAll(() => t?.cleanup());

describe("pushTradeToIpoAction files the IPO in the HOLDING's account", () => {
  it("marking a holding in account 2 creates the ipos row in account 2, linked to it", async () => {
    selectAccount(A2);
    const res = await push(a2Trade);
    // THE assertions. Before: the action rejected with AuditShapeError (asymmetric
    // before/after), and the row it had already written carried account_id 1.
    expect(res.ok).toBe(true);
    const [row] = named("SCOPEA2");
    expect([row.accountId, row.tradeId]).toEqual([A2, a2Trade]);
    expect(tradeOf(a2Trade).acquisition).toBe("ipo");
    a2Ipo = row.id;
  });

  it("the audit entry is written with a symmetric before/after (the row is in the log, not lost to the throw)", () => {
    const entries = t.db.select().from(t.schema.auditLog).all().filter((r) => (r.summary ?? "").includes("pushed to IPOs"));
    expect(entries).toHaveLength(1);
    const before = entries[0].beforeJson as Record<string, unknown>;
    const after = entries[0].afterJson as Record<string, unknown>;
    expect(Object.keys(before).sort()).toEqual(Object.keys(after).sort());
    expect([before.acquisition ?? null, before.ipoId, after.acquisition, after.ipoId]).toEqual([null, null, "ipo", a2Ipo]);
  });

  it("account 1's /ipos does not show it; account 2's does, linked", () => {
    selectAccount(A1);
    expect(q.getIposComputed().rows.map((r) => r.name)).not.toContain("SCOPEA2");
    selectAccount(A2);
    const row = q.getIposComputed().rows.find((r) => r.name === "SCOPEA2")!;
    expect([row.id, row.linked]).toEqual([a2Ipo, true]);
  });

  it("the action refuses a holding in another account (invariant 8) and writes nothing", async () => {
    selectAccount(A2);
    const res = await push(a1Trade);
    expect(res.ok).toBe(false);
    expect(named("SCOPEA1")).toHaveLength(0);
    expect(tradeOf(a1Trade).acquisition).toBeNull();
  });
});

describe("saving an exit on /ipos never reaches another account's book", () => {
  it("an exit saved from account 2 closes only that holding", async () => {
    selectAccount(A2);
    const a1Before = tradeOf(a1Trade);
    const res = await post(payload({ id: a2Ipo, name: "SCOPEA2", exitPrice: "150", exitDate: "2026-03-02", tradeId: a2Trade }));
    expect(res.status).toBe(200);
    const sold = tradeOf(a2Trade);
    expect([sold.isOpen, sold.sellQty, sold.avgSellPrice, sold.sellDate]).toEqual([false, 10, 150, "2026-03-02"]);
    expect(tradeOf(a1Trade)).toEqual(a1Before);
  });

  it("a create that links a holding in ANOTHER account is refused 409, naming both, and saves nothing", async () => {
    selectAccount(A2);
    const a1Before = tradeOf(a1Trade);
    const res = await post(payload({ name: "SCOPE-XACCT", tradeId: a1Trade }));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; message: string };
    expect(json.ok).toBe(false);
    expect(json.message).toContain("second book");
    expect(json.message).toContain("Nothing was saved.");
    expect(named("SCOPE-XACCT")).toHaveLength(0);
    expect(tradeOf(a1Trade)).toEqual(a1Before);
  });

  it("an EDIT that re-links to a holding in another account is refused 409 and leaves the IPO as stored", async () => {
    selectAccount(A2);
    const before = named("SCOPEA2")[0];
    const a1Before = tradeOf(a1Trade);
    const res = await post(payload({ id: a2Ipo, name: "SCOPEA2", exitPrice: "150", exitDate: "2026-03-02", tradeId: a1Trade }));
    expect(res.status).toBe(409);
    expect(named("SCOPEA2")[0]).toEqual(before);
    expect(tradeOf(a1Trade)).toEqual(a1Before);
  });

  it("a stored cross-account link is inert: the join refuses it, so /ipos neither shows nor writes the other book's holding", async () => {
    // Written straight to the table — a row from before this fix, or from a restore.
    const id = t.db.insert(t.schema.ipos).values({
      accountId: A2, name: "SCOPE-LEGACY", appliedPrice: 100, lotSize: 10, lotsApplied: 1,
      allotted: true, allottedQty: 10, allotmentDate: "2026-02-20", tradeId: a1Trade,
    }).returning({ id: t.schema.ipos.id }).get()!.id;
    selectAccount(A2);
    const row = q.getIposComputed().rows.find((r) => r.name === "SCOPE-LEGACY")!;
    expect([row.linked, row.linkedSellDate, row.linkedSellQty, row.linkedSellPrice]).toEqual([false, null, null, null]);
    const a1Before = tradeOf(a1Trade);
    const res = await post(payload({ id, name: "SCOPE-LEGACY", exitPrice: "150", exitDate: "2026-03-02" }));
    expect(res.status).toBe(200);
    expect(tradeOf(a1Trade)).toEqual(a1Before);
  });
});

describe("a holding that carries trade_legs is refused for an IPO link (invariant 5)", () => {
  it("the action refuses a staged holding, creating no IPO record and changing no column", async () => {
    selectAccount(A1);
    const id = holding(A1, "SCOPELEG", { buyQty: 30, avgBuyPrice: 110, buyValue: 3300 });
    t.db.insert(t.schema.tradeLegs).values([
      { tradeId: id, kind: "entry", seq: 1, tradeDate: "2026-02-20", qty: 10, price: 100 },
      { tradeId: id, kind: "entry", seq: 2, tradeDate: "2026-02-21", qty: 20, price: 115 },
    ]).run();
    const before = tradeOf(id);
    const res = await push(id);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Trades");
    expect(named("SCOPELEG")).toHaveLength(0);
    expect(tradeOf(id)).toEqual(before);
  });

  it("the route refuses to link or sync one: 409, and the parent still equals the sum of its legs", async () => {
    selectAccount(A1);
    const id = holding(A1, "SCOPELEG2", { buyQty: 30, avgBuyPrice: 110, buyValue: 3300 });
    t.db.insert(t.schema.tradeLegs).values([
      { tradeId: id, kind: "entry", seq: 1, tradeDate: "2026-02-20", qty: 10, price: 100 },
      { tradeId: id, kind: "entry", seq: 2, tradeDate: "2026-02-21", qty: 20, price: 115 },
    ]).run();
    const before = tradeOf(id);
    const res = await post(payload({ name: "SCOPE-LEGS", tradeId: id }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("Trades");
    expect(named("SCOPE-LEGS")).toHaveLength(0);
    // THE assertion: the parent aggregate was not rewritten from the IPO's allotment.
    const after = tradeOf(id);
    expect([after.buyQty, after.buyValue]).toEqual([30, 3300]);
    expect(after).toEqual(before);
    expect(t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === id).reduce((s, l) => s + l.qty, 0)).toBe(30);
  });

  it("a staged flag alone is refused too", async () => {
    selectAccount(A1);
    const id = holding(A1, "SCOPESTG", { staged: true });
    const res = await push(id);
    expect(res.ok).toBe(false);
    expect(named("SCOPESTG")).toHaveLength(0);
  });
});

/**
 * L3 (v4.3.0 wave 2L) — the staged refusal fires only where a save would actually
 * WRITE to the ladder.
 *
 * Wave 2I put the guard BEFORE the sync decision, so it refused every save of an IPO
 * linked to a holding carrying `trade_legs` — a notes-only save included — and the
 * remedy the refusal named ("unlink the holding here") re-creates the double count
 * wave 2H's counted-once rule exists to prevent: measured on one 10-share allotment,
 * total realised went 497.94 → 995.88 and cgTrades 1 → 2 the moment the user followed
 * the app's own instruction. The form sends no `tradeId` at all, so unlinking is not
 * even reachable from it (the escape hatch existed only in the route).
 *
 * The rule now mirrors X1's rule for a holding with a sale recorded in Trades: the
 * ladder is where that holding is booked (invariant 5), so a save that changes NOTHING
 * the sync would write is saved and the holding is left exactly as it is, and any save
 * that would rewrite the parent from the allotment is refused — naming the ladder, and
 * never naming unlinking as the way out.
 */
describe("L3 · an IPO linked to a laddered holding: a save that writes nothing to it is saved", () => {
  /** The pre-2I shape: the row written with a link the route would refuse to make today. */
  const linkedIpo = (name: string, tradeId: number, over: Record<string, unknown> = {}) =>
    t.db.insert(t.schema.ipos).values({
      accountId: A1, name, appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true,
      allottedQty: 10, allotmentDate: "2026-02-20", listingPrice: 130, tradeId, ...over,
    }).returning({ id: t.schema.ipos.id }).get()!.id;

  const legs = (tradeId: number) =>
    t.db.insert(t.schema.tradeLegs).values([
      { tradeId, kind: "entry", seq: 1, tradeDate: "2026-02-20", qty: 10, price: 100 },
      { tradeId, kind: "entry", seq: 2, tradeDate: "2026-02-21", qty: 20, price: 115 },
    ]).run();

  it("a notes-only save of an IPO whose holding GAINED a ladder after the link: 200, the note stored, the parent untouched", async () => {
    selectAccount(A1);
    const trade = holding(A1, "SCOPELATE", { buyQty: 30, avgBuyPrice: 110, buyValue: 3300 });
    legs(trade);
    const id = linkedIpo("SCOPE-LATE", trade);
    const before = tradeOf(trade);
    const res = await post(payload({ id, name: "SCOPE-LATE", notes: "a note the user typed" }));
    // THE assertions (before: 409 STAGED, the note lost, and the message told the
    // user to unlink — which counts the sale twice).
    expect(res.status).toBe(200);
    expect(named("SCOPE-LATE").map((r) => [r.notes, r.tradeId])).toEqual([["a note the user typed", trade]]);
    expect(tradeOf(trade)).toEqual(before);
    expect([before.buyQty, before.buyValue]).toEqual([30, 3300]);
  });

  it("the same for a STAGED holding already closed on the IPO's own exit: 200 and not one column written", async () => {
    selectAccount(A1);
    const trade = holding(A1, "SCOPESTGX", {
      staged: true, isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500,
      sellDate: "2026-03-02", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, grossPnl: 500, netPnl: 497.94, chargesTotal: 2.06,
    });
    const id = linkedIpo("SCOPE-STGX", trade, { exitPrice: 150, exitDate: "2026-03-02" });
    const before = tradeOf(trade);
    const res = await post(payload({ id, name: "SCOPE-STGX", exitPrice: "150", exitDate: "2026-03-02", notes: "staged, noted" }));
    expect(res.status).toBe(200);
    expect(named("SCOPE-STGX").map((r) => r.notes)).toEqual(["staged, noted"]);
    expect(tradeOf(trade)).toEqual(before);
  });

  it("a save that WOULD rewrite the parent from the allotment is refused 409, naming Trades and never naming unlinking", async () => {
    selectAccount(A1);
    const trade = holding(A1, "SCOPELEG3", { buyQty: 30, avgBuyPrice: 110, buyValue: 3300 });
    legs(trade);
    const id = linkedIpo("SCOPE-LEG3", trade);
    const before = tradeOf(trade);
    const ipoBefore = named("SCOPE-LEG3")[0];
    const res = await post(payload({ id, name: "SCOPE-LEG3", exitPrice: "160", exitDate: "2026-03-02", notes: "sold?" }));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; message: string };
    expect(json.code).toBe("STAGED");
    expect(json.message).toContain("Trades");
    // THE assertion: the remedy that doubles the sale is not what the app suggests.
    expect(json.message.toLowerCase()).not.toContain("unlink");
    expect(named("SCOPE-LEG3")[0]).toEqual(ipoBefore);
    expect(tradeOf(trade)).toEqual(before);
  });
});
