import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

// `revalidatePath` needs a Next request scope that no test has.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * v4.6.0 W7 (D3) — POST /api/trades/fmv writes ONE per-share FMV onto every lot
 * of ONE scrip, and refuses — with no write at all — anything else: a second
 * scrip, a post-2018 lot, a lot outside the tax person's accounts.
 *
 * ONE temp database for the FILE (tests/helpers/temp-db.ts). Every case reads
 * the stored column straight out of SQLite.
 */

let t: TempDb;
let route: typeof import("@/app/api/trades/fmv/route");
const id: Record<string, number> = {};

const INFY_ISIN = "INE009A01021";

async function post(body: unknown): Promise<{ status: number; ok: boolean; message: string }> {
  const res = await route.POST(
    new Request("http://local/api/trades/fmv", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const j = (await res.json()) as { ok: boolean; message: string };
  return { status: res.status, ...j };
}

const fmvOf = (tradeId: number) =>
  (t.sqlite.prepare("SELECT fmv_31jan2018 AS f FROM trades WHERE id = ?").get(tradeId) as { f: number | null }).f;
const auditCount = () => (t.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;

beforeAll(async () => {
  t = await openTempDb("fmv-route", { seed: true });
  route = await import("@/app/api/trades/fmv/route");
  // Account 2 carries no tax identity, so it is a DIFFERENT tax person from
  // account 1 (each unassigned account is its own person).
  t.db.insert(t.schema.accounts).values({ id: 2, name: "Other person", isDefault: false }).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();

  const add = (name: string, over: Record<string, unknown>) => {
    id[name] = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: 1, broker: "zerodha", segment: "eq_delivery",
          symbol: "INFY", tradingsymbol: "INFY", isin: INFY_ISIN,
          buyQty: 10, avgBuyPrice: 950, buyValue: 9500, buyDate: "2017-05-10",
          sellQty: 10, avgSellPrice: 1500, sellValue: 15000, sellDate: "2021-03-01",
          isOpen: false,
          ...over,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
  };
  add("infy1", {});
  add("infy2", { buyDate: "2016-11-03" });
  add("tcs", { symbol: "TCS", tradingsymbol: "TCS", isin: "INE467B01029" });
  add("infy2020", { buyDate: "2020-06-01" });
  add("infyOther", { accountId: 2 });
  // A partly-sold pre-2018 STAGED parent: open, yet it has realised rows the
  // readers already apply its FMV to.
  add("ladder", { staged: true, isOpen: true, sellQty: 4, sellValue: 6000, buyDate: "2017-09-01" });
});

afterAll(() => t?.cleanup());

describe("POST /api/trades/fmv — one FMV, one scrip", () => {
  it("ids = [infy1, infy2] writes BOTH lots and one audit row per trade", async () => {
    const before = auditCount();
    const r = await post({ ids: [id.infy1, id.infy2], fmv: "1100" });
    expect(r, r.message).toMatchObject({ status: 200, ok: true });
    expect([fmvOf(id.infy1), fmvOf(id.infy2)]).toEqual([1100, 1100]);
    expect(auditCount() - before, "one audit row per TRADE, not per group").toBe(2);
    const rows = t.sqlite
      .prepare("SELECT entity_id AS e, summary AS s, before_json AS b, after_json AS a FROM audit_log ORDER BY id DESC LIMIT 2")
      .all() as { e: number; s: string; b: string; a: string }[];
    expect(rows.map((x) => x.e).sort()).toEqual([id.infy1, id.infy2].sort());
    expect(rows.map((x) => x.s).sort()).toEqual([
      "INFY FMV@31-Jan-2018 set to ₹1100 (grandfathering, lot 1 of 2)",
      "INFY FMV@31-Jan-2018 set to ₹1100 (grandfathering, lot 2 of 2)",
    ]);
    expect(rows.every((x) => JSON.parse(x.a).fmv31Jan2018 === 1100 && "fmv31Jan2018" in JSON.parse(x.b))).toBe(true);
  });

  it("two different scrips → 400, and NEITHER is written", async () => {
    const r = await post({ ids: [id.infy1, id.tcs], fmv: "2000" });
    expect(r.status).toBe(400);
    expect([fmvOf(id.infy1), fmvOf(id.tcs)]).toEqual([1100, null]);
  });

  it("a lot bought after 31-Jan-2018 → 400, and nothing is written", async () => {
    const r = await post({ ids: [id.infy1, id.infy2020], fmv: "2000" });
    expect(r.status).toBe(400);
    expect([fmvOf(id.infy1), fmvOf(id.infy2020)]).toEqual([1100, null]);
  });

  it("a lot in another tax person's account → 400, and nothing is written", async () => {
    const r = await post({ ids: [id.infy1, id.infyOther], fmv: "2000" });
    expect(r.status).toBe(400);
    expect([fmvOf(id.infy1), fmvOf(id.infyOther)]).toEqual([1100, null]);
  });

  it("bad ids → 400: empty, repeated, non-positive, unknown", async () => {
    for (const ids of [[], [id.infy1, id.infy1], [0], [-3], [999999]]) {
      expect((await post({ ids, fmv: "5" })).status, JSON.stringify(ids)).toBe(400);
    }
    expect((await post({ ids: [id.infy1], fmv: "-1" })).status, "a negative FMV").toBe(400);
    expect(fmvOf(id.infy1)).toBe(1100);
  });

  it("the legacy { id } body still works", async () => {
    const r = await post({ id: id.tcs, fmv: "1300" });
    expect(r, r.message).toMatchObject({ status: 200, ok: true });
    expect(fmvOf(id.tcs)).toBe(1300);
  });

  it("a blank FMV clears the whole group", async () => {
    const r = await post({ ids: [id.infy1, id.infy2], fmv: "" });
    expect(r, r.message).toMatchObject({ status: 200, ok: true });
    expect([fmvOf(id.infy1), fmvOf(id.infy2)]).toEqual([null, null]);
  });

  it("a partly-sold pre-2018 ladder parent (open) IS writable", async () => {
    const r = await post({ ids: [id.ladder, id.infy1], fmv: "1050" });
    expect(r, r.message).toMatchObject({ status: 200, ok: true });
    expect([fmvOf(id.ladder), fmvOf(id.infy1)]).toEqual([1050, 1050]);
  });
});
