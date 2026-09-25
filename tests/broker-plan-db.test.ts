import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * WAVE U (v4.5.0) — WHICH PLAN PRICES A TRADE, the DB half.
 *
 * The pure rule is swept in tests/broker-plan.test.ts. This file is about the
 * READ and the WRITE: the account row a plan comes from, the accrual that is
 * the one job allowed to restate a stored figure, the audit trail that makes
 * that legal (DECISIONS 2026-08-30 decision 6), the account editor's door, and
 * the two things that must NOT happen — another account's rows moving, and a
 * plan surviving a change of broker.
 *
 * ONE temp database for the whole FILE (AGENTS.md Testing): lib/db caches its
 * connection on globalThis, so a second openTempDb() here would silently reuse
 * the first. Every case gets its own ACCOUNT and its own rows instead.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let stagedQ: typeof import("@/lib/queries/staged");
let brokerPlan: typeof import("@/lib/queries/broker-plan");
let accrual: typeof import("@/lib/jobs/mtf-accrual");
let dq: typeof import("@/lib/queries/data-quality");
let rates: typeof import("@/lib/engine/rates");
let ratesDb: typeof import("@/lib/engine/rates-db");
let accountsPOST: (req: Request) => Promise<Response>;

/** Upstox on Plus from this date; every case that needs a cut uses this one. */
const CUT = "2026-08-01";
const PRE = "2026-07-20";
const POST = "2026-08-10";

let A_PLUS = 0; // upstox, plan "plus" from CUT
let A_BASIC = 0; // upstox, no plan stated
let A_DHAN = 0; // dhan — a broker with ONE plan, so never a plan question
let A_ZERODHA = 0;

const mkAccount = (name: string, broker: string | null, brokerPlan: string | null = null, brokerPlanFrom: string | null = null) =>
  t.db
    .insert(t.schema.accounts)
    .values({ name, broker, brokerPlan, brokerPlanFrom })
    .returning({ id: t.schema.accounts.id })
    .get()!.id;

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

// Measured locally: migrate + seed + the five dynamic imports ~1.4 s, inside the
// 3 s local hook budget. The raised timeout is for the Windows runner (> 15x
// slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("broker-plan-db", { seed: true });
  stagedQ = await import("@/lib/queries/staged");
  brokerPlan = await import("@/lib/queries/broker-plan");
  accrual = await import("@/lib/jobs/mtf-accrual");
  dq = await import("@/lib/queries/data-quality");
  rates = await import("@/lib/engine/rates");
  ratesDb = await import("@/lib/engine/rates-db");
  ({ POST: accountsPOST } = await import("@/app/api/accounts/route"));

  A_PLUS = mkAccount("Upstox Plus", "upstox", "plus", CUT);
  A_BASIC = mkAccount("Upstox Basic", "upstox");
  A_DHAN = mkAccount("Dhan", "dhan");
  A_ZERODHA = mkAccount("Zerodha", "zerodha");
}, 120_000);
afterAll(() => t?.cleanup());

let seq = 0;
const openMtf = (accountId: number, buyDate: string, funded: number, broker = "upstox") =>
  t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        accountId,
        broker,
        segment: "eq_mtf",
        symbol: `MTF${++seq}`,
        tradingsymbol: `MTF${seq}`,
        buyQty: 100,
        avgBuyPrice: 500,
        buyValue: 50_000,
        buyDate,
        buyOrderCount: 1,
        sellQty: 0,
        sellValue: 0,
        isOpen: true,
        mtfFundedAmount: funded,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;

const tradeById = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;

// ---------------------------------------------------------------------------
// 7 — a staged ladder that straddles the plan start
// ---------------------------------------------------------------------------

describe("7 · a staged ladder straddling broker_plan_from: each leg prices at its OWN date's plan", () => {
  /**
   * `priceLegs` used to make ONE `findRates` call for the whole ladder at
   * `ctx.asOf`. That is still true of the rate EPOCH (this module's stated
   * approximation), but the PLAN is now resolved per leg on the leg's own
   * `tradeDate` — a tranche filled before the account went Plus was billed at
   * ₹20, not ₹30, and a rebuild must not restate it.
   *
   * index_option is the clean instrument for this: Upstox bills a FLAT ₹20
   * (Basic) / ₹30 (Plus) per order there, so the difference between two legs is
   * the plan premium and nothing else.
   */
  const ladder = (accountId: number) => {
    select(accountId);
    const id = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId,
          broker: "upstox",
          bucket: "active",
          segment: "index_option",
          instrumentType: "option",
          exchange: "NSE",
          symbol: `NIFTY${++seq}`,
          tradingsymbol: `OPT NIFTY${seq} 25 Sep 2026 24000 CE`,
          optionType: "CE",
          strike: 24000,
          expiry: "2026-09-25",
          buyQty: 50,
          avgBuyPrice: 40,
          buyValue: 2000,
          buyDate: PRE,
          buyOrderCount: 1,
          sellQty: 0,
          sellValue: 0,
          isOpen: true,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    const conv = stagedQ.convertToStaged(id);
    expect(conv.ok, conv.message).toBe(true);
    // The first leg is the conversion's own (dated PRE, before the cut); this
    // one is filled AFTER the account moved to Plus.
    const add = stagedQ.addLeg({ tradeId: id, kind: "entry", tradeDate: POST, qty: 50, price: 40 });
    expect(add.ok, add.message).toBe(true);
    const rebuilt = stagedQ.rebuildStagedTrade(id);
    expect(rebuilt.ok, JSON.stringify(rebuilt)).toBe(true);
    return t.db
      .select()
      .from(t.schema.tradeLegs)
      .where(eq(t.schema.tradeLegs.tradeId, id))
      .all()
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  };

  it("the pre-cut leg bills Basic and the post-cut leg bills Plus, on the SAME ladder", () => {
    const onPlan = ladder(A_PLUS);
    const noPlan = ladder(A_BASIC);
    expect(onPlan.map((l) => l.tradeDate)).toEqual([PRE, POST]);
    expect(noPlan.map((l) => l.tradeDate)).toEqual([PRE, POST]);

    // Control: with no plan, both legs of the identical ladder cost the same.
    expect(noPlan[0].chargesTotal).toBe(noPlan[1].chargesTotal);

    // The pre-cut leg is byte-identical to its no-plan twin — a rebuild after
    // the plan started did NOT restate what accrued before it.
    expect(onPlan[0].chargesTotal, "the pre-cut leg is untouched by the plan").toBe(noPlan[0].chargesTotal);

    // …and the post-cut leg costs exactly the flat premium more, GST included.
    const map = ratesDb.loadRatesMap();
    const basic = rates.findRates(map, "upstox", "index_option", "NSE", POST);
    const plus = rates.findRates(map, "upstox", "index_option", "NSE", POST, "plus");
    const premium = Math.round((plus.brokerageFlat! - basic.brokerageFlat!) * (1 + plus.gstPct) * 100) / 100;
    expect(premium).toBe(11.8);
    expect(Math.round((onPlan[1].chargesTotal - noPlan[1].chargesTotal) * 100) / 100).toBe(premium);
  });
});

// ---------------------------------------------------------------------------
// 8 — the accrual, the preview and the audit trail
// ---------------------------------------------------------------------------

describe("8 · the MTF accrual, the plan-change preview and its audit rows", () => {
  it("the accrual does not restate interest that accrued before the plan started", () => {
    const today = "2026-09-01";
    const map = ratesDb.loadRatesMap();
    const id = openMtf(A_PLUS, PRE, 40_000);
    const res = accrual.accrueMtfInterest(today);
    expect(res.updated).toBeGreaterThan(0);

    const stored = tradeById(id).mtfInterest;
    const acct = { broker: "upstox", brokerPlan: "plus", brokerPlanFrom: CUT };
    const split = rates.mtfInterestOver(map, { broker: "upstox", exchange: "NSE" }, 40_000, acct, PRE, today);
    expect(stored).toBe(split);
    // …and it is NEITHER single-plan figure, so pricing the whole period at
    // today's plan (or at Basic) reddens here.
    expect(stored).not.toBe(rates.mtfInterestOver(map, { broker: "upstox", exchange: "NSE" }, 40_000, null, PRE, today));
    expect(stored).not.toBe(
      rates.mtfInterestOver(map, { broker: "upstox", exchange: "NSE" }, 40_000, { ...acct, brokerPlanFrom: null }, PRE, today),
    );
  });

  it("previewPlanChange names the rows, the two totals and the sentence, BEFORE anything is written", () => {
    const acct = mkAccount("Upstox preview", "upstox");
    const a = openMtf(acct, "2026-06-01", 60_000);
    const b = openMtf(acct, "2026-06-15", 30_000);
    // An open row the journal never priced accrues nothing either way (Q-A), so
    // it must not appear: an unpriced row is not a row the plan moves.
    const unpriced = openMtf(acct, "2026-06-01", 0);
    t.db.update(t.schema.trades).set({ mtfFundedAmount: null }).where(eq(t.schema.trades.id, unpriced)).run();

    const before = [a, b].map((id) => tradeById(id).mtfInterest);
    const prev = brokerPlan.previewPlanChange(acct, { brokerPlan: "plus", brokerPlanFrom: null }, "2026-09-01");
    expect(prev.count).toBe(2);
    expect(prev.rows.map((r) => r.id).sort((x, y) => x - y)).toEqual([a, b]);
    expect(prev.willTotal).toBeLessThan(prev.wasTotal); // Plus's 14.60% < Basic's 18.25%
    expect(prev.message).toContain("2 open MTF rows re-accrue");
    expect(prev.message).toContain("audit trail");
    // A PREVIEW writes nothing.
    expect([a, b].map((id) => tradeById(id).mtfInterest)).toEqual(before);
    expect(tradeById(unpriced).mtfInterest).toBe(0);
  });

  it("applyPlanChange writes the previewed figure and ONE audit row per row it moves", () => {
    const acct = mkAccount("Upstox apply", "upstox");
    const a = openMtf(acct, "2026-06-01", 60_000);
    accrual.accrueMtfInterest("2026-09-01"); // give it something to move
    const gross = tradeById(a).grossPnl;

    const prev = brokerPlan.previewPlanChange(acct, { brokerPlan: "plus", brokerPlanFrom: null }, "2026-09-01");
    expect(prev.count).toBe(1);
    const moved = brokerPlan.applyPlanChange(acct, prev, "Upstox Plus");
    expect(moved).toBe(1);

    const after = tradeById(a);
    expect(after.mtfInterest).toBe(prev.rows[0].will);
    // chargesTotal and netPnl follow, so the stored P&L stays internally true.
    expect(Math.round((after.grossPnl - after.chargesTotal) * 100) / 100).toBe(after.netPnl);
    expect(after.grossPnl).toBe(gross);

    const audit = t.db
      .select()
      .from(t.schema.auditLog)
      .where(and(eq(t.schema.auditLog.entity, "trade"), eq(t.schema.auditLog.entityId, a)))
      .all()
      .filter((r) => r.source === "account-plan");
    expect(audit, "one audit row per moved trade").toHaveLength(1);
    expect(audit[0].summary).toContain("Upstox Plus");
    expect(audit[0].beforeJson?.mtfInterest).toBe(prev.rows[0].was);
    expect(audit[0].afterJson?.mtfInterest).toBe(prev.rows[0].will);
  });
});

// ---------------------------------------------------------------------------
// 9 — a plan belongs to a BROKER relationship
// ---------------------------------------------------------------------------

describe("9 · changing an account's broker ends its plan", () => {
  const post = (body: unknown) =>
    accountsPOST(new Request("http://localhost:3011/api/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("the upsert nulls broker_plan AND broker_plan_from when the broker moves", async () => {
    const id = mkAccount("Moves broker", "upstox", "plus", CUT);
    const res = await post({ action: "upsert", id, name: "Moves broker", broker: "zerodha" });
    expect(res.status).toBe(200);
    expect((await res.json()).planCleared).toBe(true);
    const a = t.db.select().from(t.schema.accounts).where(eq(t.schema.accounts.id, id)).get()!;
    expect([a.broker, a.brokerPlan, a.brokerPlanFrom]).toEqual(["zerodha", null, null]);
  });

  it("a save that does NOT move the broker leaves the plan exactly where it was", async () => {
    const id = mkAccount("Keeps plan", "upstox", "plus", CUT);
    const res = await post({ action: "upsert", id, name: "Keeps plan renamed", broker: "upstox" });
    expect(res.status).toBe(200);
    const a = t.db.select().from(t.schema.accounts).where(eq(t.schema.accounts.id, id)).get()!;
    expect([a.name, a.broker, a.brokerPlan, a.brokerPlanFrom]).toEqual(["Keeps plan renamed", "upstox", "plus", CUT]);
  });

  it("the planPreview action answers with the same figures applyPlanChange would write", async () => {
    const id = mkAccount("Preview via route", "upstox");
    openMtf(id, "2026-06-01", 60_000);
    accrual.accrueMtfInterest("2026-09-01");
    const res = await post({ action: "planPreview", id, brokerPlan: "plus", brokerPlanFrom: null });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; count: number; wasTotal: number; willTotal: number };
    const direct = brokerPlan.previewPlanChange(id, { brokerPlan: "plus", brokerPlanFrom: null });
    expect([j.ok, j.count]).toEqual([true, direct.count]);
    expect(j.count).toBeGreaterThan(0);
    expect([j.wasTotal, j.willTotal]).toEqual([direct.wasTotal, direct.willTotal]);
  });
});

// ---------------------------------------------------------------------------
// 10 — the plan picker's own derivation
// ---------------------------------------------------------------------------

describe("10 · the account editor is offered a plan control only where there is a choice", () => {
  it("brokerPlanOptions lists only brokers with MORE THAN ONE plan, derived from charge_config", () => {
    const opts = brokerPlan.brokerPlanOptions();
    // v4.6.0 W9: Fyers (Standard / Prime) and Nuvama (Lite Plus / Elite) joined the two-plan brokers.
    expect(Object.keys(opts).sort()).toEqual(["fyers", "kotakneo", "nuvama", "upstox"]);
    // "default" first, then the paid tiers — the order the picker renders in.
    expect(opts.upstox.map((o) => o.plan)).toEqual(["default", "plus"]);
    expect(opts.upstox.map((o) => o.subscriptionMonthly)).toEqual([0, 0]); // owner ruling U3
    expect(opts.upstox[1].label).toBe("Upstox Plus");
    expect(opts.upstox[0].label).toBeTruthy(); // the free tier is named, never blank
    // A single-plan broker has no question to ask, so it is absent entirely.
    expect(opts.dhan).toBeUndefined();
    expect(opts.zerodha).toBeUndefined();
    expect(brokerPlan.plansForBroker("dhan")).toEqual(["default"]);
    expect(brokerPlan.plansForBroker(null)).toEqual([]);
  });

  it("D4 — the comparison badge calls a plan 'paid' only when it carries a subscription", () => {
    // `/reports/broker-compare` renders "· paid" when subscription > 0 and
    // "· opt-in" when it does not. Kotak Neo's plan really is billed; Upstox
    // Plus is not (U3), and calling it paid beside a ₹0 fee would be a false
    // claim in the report that exists to compare cost.
    const opts = brokerPlan.brokerPlanOptions();
    const paid = opts.kotakneo.filter((o) => o.plan !== "default");
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((o) => o.subscriptionMonthly > 0), "Kotak Neo's tier really is billed monthly").toBe(true);
    expect(opts.upstox.find((o) => o.plan === "plus")!.subscriptionMonthly).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 12 — the data-quality INFO
// ---------------------------------------------------------------------------

describe("12 · the data-quality report asks, once, about an account with no plan stated", () => {
  it("fires for a multi-plan-broker account with NULL plan and for nobody else", () => {
    const issues = dq.getDataQualityReport(new Date("2026-09-01T00:00:00Z")).issues.filter((i) => i.code.startsWith("broker_plan:"));
    const ids = issues.map((i) => Number(i.code.split(":")[1]));
    // Every Upstox account in this database that states no plan, and no other.
    const expected = t.db
      .select()
      .from(t.schema.accounts)
      .all()
      .filter((a) => !a.archived && !a.brokerPlan && (a.broker ?? "").toLowerCase() === "upstox")
      .map((a) => a.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(ids.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
    expect(ids).toContain(A_BASIC);
    expect(ids).not.toContain(A_PLUS); // states one
    expect(ids).not.toContain(A_DHAN); // single-plan broker: no question to ask
    expect(ids).not.toContain(A_ZERODHA);
    // INFO, never a warning: nothing is WRONG — the account prices on the free
    // tier, which is what an account that has not opted in is on.
    expect(issues.every((i) => i.severity === "info")).toBe(true);
    expect(issues[0].href).toBe("/settings#settings-accounts");
    expect(issues[0].count).toBe(1);
  });

  it("an archived account is not nagged about", () => {
    const id = mkAccount("Archived upstox", "upstox");
    t.db.update(t.schema.accounts).set({ archived: true }).where(eq(t.schema.accounts.id, id)).run();
    const codes = dq.getDataQualityReport(new Date("2026-09-01T00:00:00Z")).issues.map((i) => i.code);
    expect(codes).not.toContain(`broker_plan:${id}`);
  });
});

// ---------------------------------------------------------------------------
// 13 — the "account #3" class: another account's book never moves
// ---------------------------------------------------------------------------

describe("13 · setting a plan on one account leaves every other account's rows byte-identical", () => {
  it("a Dhan book of closed option rows is untouched by an Upstox plan change and the accrual it triggers", async () => {
    const dhan = mkAccount("Dhan untouched", "dhan");
    const upstox = mkAccount("Upstox changes plan", "upstox");
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        t.db
          .insert(t.schema.trades)
          .values(
            tradeRow({
              accountId: dhan,
              broker: "dhan",
              bucket: "active",
              segment: "index_option",
              instrumentType: "option",
              exchange: "NSE",
              symbol: `DOPT${++seq}`,
              tradingsymbol: `OPT DOPT${seq} 25 Sep 2026 24000 CE`,
              optionType: "CE",
              strike: 24000,
              expiry: "2026-09-25",
              buyQty: 50,
              avgBuyPrice: 40,
              buyValue: 2000,
              buyDate: PRE,
              buyOrderCount: 1,
              sellQty: 50,
              avgSellPrice: 44,
              sellValue: 2200,
              sellDate: POST,
              sellOrderCount: 1,
              isOpen: false,
            }),
          )
          .returning({ id: t.schema.trades.id })
          .get()!.id,
      );
    }
    // …and an open Upstox MTF row, so the plan change really does move something.
    const moves = openMtf(upstox, "2026-06-01", 60_000);
    accrual.accrueMtfInterest("2026-09-01");

    const snapshot = () => ids.map((id) => JSON.stringify(tradeById(id)));
    const before = snapshot();
    const movedBefore = tradeById(moves).mtfInterest;

    const res = await accountsPOST(
      new Request("http://localhost:3011/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "upsert", id: upstox, name: "Upstox changes plan", broker: "upstox", brokerPlan: "plus", brokerPlanFrom: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).reaccrued).toBe(1);
    accrual.accrueMtfInterest("2026-09-01"); // the daily job, re-saving nothing

    // The premise: the Upstox row really did move.
    expect(tradeById(moves).mtfInterest).not.toBe(movedBefore);
    // The assertion: EVERY stored column of the Dhan rows, byte for byte.
    expect(snapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 14 — planForView
// ---------------------------------------------------------------------------

describe("14 · planForView — the read-only estimate surfaces", () => {
  const ON = "2026-08-28";
  const map = () => ratesDb.loadRatesMap();

  it("a single-account view prices at THAT account's plan", () => {
    select(A_PLUS);
    expect(brokerPlan.planForView("upstox", ON, map())).toBe("plus");
    select(A_BASIC);
    expect(brokerPlan.planForView("upstox", ON, map())).toBe("default");
  });

  it("a single-account view never lends its plan to another broker's figures", () => {
    select(A_PLUS);
    expect(brokerPlan.planForView("zerodha", ON, map())).toBe("default");
    expect(brokerPlan.planForView(null, ON, map())).toBe("default");
  });

  it("the All-accounts view with accounts that DISAGREE on one broker prices at default", () => {
    // A_PLUS says plus, A_BASIC says none — two accounts under two plans have
    // no single honest answer, so the view states the free tier (invariant 6).
    select(0);
    expect(brokerPlan.planForView("upstox", ON, map())).toBe("default");
  });

  it("the All-accounts view with unanimous accounts prices at the plan they agree on", () => {
    // Archive every disagreeing Upstox account but one, then agree.
    const ids = t.db
      .select()
      .from(t.schema.accounts)
      .all()
      .filter((a) => (a.broker ?? "") === "upstox")
      .map((a) => a.id);
    const restore = ids.map((id) => [id, t.db.select().from(t.schema.accounts).where(eq(t.schema.accounts.id, id)).get()!] as const);
    try {
      for (const id of ids) t.db.update(t.schema.accounts).set({ brokerPlan: "plus", brokerPlanFrom: null }).where(eq(t.schema.accounts.id, id)).run();
      select(0);
      expect(brokerPlan.planForView("upstox", ON, map())).toBe("plus");
      // A date before one account's start breaks unanimity again.
      t.db.update(t.schema.accounts).set({ brokerPlanFrom: "2026-09-01" }).where(eq(t.schema.accounts.id, ids[0])).run();
      expect(brokerPlan.planForView("upstox", ON, map())).toBe("default");
    } finally {
      for (const [id, a] of restore) t.db.update(t.schema.accounts).set({ brokerPlan: a.brokerPlan, brokerPlanFrom: a.brokerPlanFrom }).where(eq(t.schema.accounts.id, id)).run();
      select(1);
    }
  });
});
