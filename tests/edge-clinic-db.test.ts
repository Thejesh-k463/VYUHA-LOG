// v4.7.0 C2 — the Edge Clinic's data + server half against a REAL migrated
// database (tests/helpers/temp-db.ts; one temp DB for this whole file):
// migration 0079, getClinicTrades, the input digest (fresh / stale / missing)
// across edit / journal / delete / Trash restore / merge, experiments scoped to
// their own account, the All-view refusal, the free copy (403 / null / no
// report), the write-side validation of grade + typed range, the split scaling
// the typed range, the no-FK restore of a pre-4.7 backup, and a golden-report
// hash pinning ENGINE_VERSION.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { eq as await_eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { edgeClinic, ENGINE_VERSION, type ClinicTrade } from "@/lib/analytics/edge-clinic";
import { clinicStateFor } from "@/lib/analytics/edge-clinic-contract";
// v4.7.0 C2 (builder B): the validator moved out of the "use server" actions file into a pure module.
import { clinicFieldsFrom } from "@/lib/domain/clinic-fields";

let t: TempDb;
let q: typeof import("@/lib/queries/edge-clinic");
let tq: typeof import("@/lib/queries/trades");
let commit: typeof import("@/lib/import/commit");
let del: typeof import("@/lib/queries/delete");
let trash: typeof import("@/lib/trash");
let acctDel: typeof import("@/lib/queries/account-delete");
let backup: typeof import("@/lib/backup");
let riskCap: typeof import("@/lib/queries/risk-cap");
let routeExp: typeof import("@/app/api/edge-clinic/experiments/route");
let routeCell: typeof import("@/app/api/edge-clinic/cell/route");
let routeCompute: typeof import("@/app/api/edge-clinic/compute/route");
let today: string;

const A = 1; // the seeded Primary account
const B = 2;
const ALL = 0;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}
function setFree(free: boolean) {
  t.db.update(t.schema.settings).set({ licenseKey: null, trialStartedAt: free ? "2020-01-01T00:00:00.000Z" : new Date().toISOString() }).run();
}
const dayPlus = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
const dayAfter = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** A deterministic, non-degenerate R series (mean ≈ +0.3). */
const rAt = (i: number) => (((i * 37) % 23) - 9) / 7 + 0.3;

/** One closed eq_intraday round trip carrying an R. */
function closed(accountId: number, i: number, over: Record<string, unknown> = {}) {
  const r = rAt(i);
  return tradeRow({
    accountId, bucket: "active", segment: "eq_intraday", symbol: `SYM${i % 5}`, tradingsymbol: `SYM${i % 5}`,
    buyQty: 10, sellQty: 10, avgBuyPrice: 100, avgSellPrice: 100 + r * 10, side: "long",
    buyDate: dayPlus(i), sellDate: dayPlus(i), isOpen: false,
    grossPnl: r * 100 + 20, chargesTotal: 20, netPnl: r * 100, riskAmount: 100, rMultiple: r, riskSource: "set",
    setupTag: "S", ...over,
  });
}

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const post = (body: unknown) => new Request("http://x/api/edge-clinic/experiments", { method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => new Request("http://x/api/edge-clinic/experiments", { method: "PATCH", body: JSON.stringify(body) });

beforeAll(async () => {
  t = await openTempDb("edge-clinic", { seed: true });
  q = await import("@/lib/queries/edge-clinic");
  tq = await import("@/lib/queries/trades");
  commit = await import("@/lib/import/commit");
  del = await import("@/lib/queries/delete");
  trash = await import("@/lib/trash");
  acctDel = await import("@/lib/queries/account-delete");
  backup = await import("@/lib/backup");
  riskCap = await import("@/lib/queries/risk-cap");
  routeExp = await import("@/app/api/edge-clinic/experiments/route");
  routeCell = await import("@/app/api/edge-clinic/cell/route");
  routeCompute = await import("@/app/api/edge-clinic/compute/route");
  today = (await import("@/lib/domain/trading-day")).todayIstIso();

  t.db.insert(t.schema.accounts).values({ id: B, name: "Book B", isDefault: false }).run();
  t.db.insert(t.schema.trades).values(Array.from({ length: 30 }, (_, i) => closed(A, i))).run();
  t.db.insert(t.schema.trades).values(Array.from({ length: 25 }, (_, i) => closed(B, i + 100))).run();
  setFree(false);
  selectAccount(A);
}, 30_000);

afterAll(() => t?.cleanup());

describe("migration 0079", () => {
  it("adds trades.setup_grade (CHECK A+/A/B) and the two REAL range columns", () => {
    const cols = t.sqlite.prepare("SELECT name, type FROM pragma_table_info('trades')").all() as { name: string; type: string }[];
    const by = new Map(cols.map((c) => [c.name, c.type.toLowerCase()]));
    expect(by.get("setup_grade")).toBe("text");
    expect(by.get("intra_high")).toBe("real");
    expect(by.get("intra_low")).toBe("real");
    expect(() => t.db.insert(t.schema.trades).values(tradeRow({ setupGrade: "C" as never })).run()).toThrow(/CHECK/);
  });

  it("clinic_experiments has NO foreign key, and one OPEN experiment per (account, cell)", () => {
    expect(t.sqlite.prepare("SELECT * FROM pragma_foreign_key_list('clinic_experiments')").all()).toEqual([]);
    const row = { accountId: 99, cellKey: "k", cellLabel: "k", hypothesis: "h", startedAt: today, targetN: 20 };
    const first = t.db.insert(t.schema.clinicExperiments).values(row).returning().get();
    expect(() => t.db.insert(t.schema.clinicExperiments).values(row).run()).toThrow(/UNIQUE/);
    t.db.insert(t.schema.clinicExperiments).values({ ...row, status: "abandoned" }).run(); // a closed one may repeat
    t.db.delete(t.schema.clinicExperiments).where((await_eq(t.schema.clinicExperiments.accountId, 99))).run();
    expect(first.status).toBe("open");
  });

  it("clinic_cache is keyed by scope and carries no account_id", () => {
    const cols = (t.sqlite.prepare("SELECT name FROM pragma_table_info('clinic_cache')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["scope_key", "digest", "engine_version", "report_json", "computed_at"]);
  });
});


describe("getClinicTrades — the engine's input, scoped", () => {
  it("maps the row 1:1 (rupees, REAL prices, grade, json), ordered by id, in the selected scope", () => {
    selectAccount(A);
    const rows = tq.getClinicTrades();
    expect(rows).toHaveLength(30);
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));
    expect(rows[0]).toMatchObject({ segment: "eq_intraday", setupTag: "S", setupGrade: null, riskSource: "set", isOpen: false, rPlan: false });
    expect(rows[0].netPnl).toBeCloseTo(rAt(0) * 100, 2); // paise round trip
    selectAccount(ALL);
    expect(tq.getClinicTrades()).toHaveLength(55);
    expect(tq.getClinicTrades([B])).toHaveLength(25);
    selectAccount(A);
  });
});

describe("the digest — fresh / stale / missing, and never a stale report served as fresh", () => {
  it("missing before the first compute; the page read never runs the engine", async () => {
    selectAccount(A);
    const s = q.getClinicState();
    expect(s.status).toBe("missing");
    expect(s.report).toBeNull();
    expect(s.canStartExperiment).toBe(true);
    const r = await json(await routeCompute.POST());
    expect(r.body).toMatchObject({ ok: true, status: "computed", scopeKey: "acct:1" });
    expect("report" in r.body).toBe(false);
    const after = q.getClinicState();
    expect(after.status).toBe("fresh");
    expect(after.report!.closedTrades).toBe(30);
    expect(after.teaser!.closedTrades).toBe(30);
    // a second compute is a no-op
    expect((await q.computeClinic()).status).toBe("fresh");
  });

  it("an edit the engine cannot see (notes) stays fresh; one it can see (setup tag) is stale", async () => {
    selectAccount(A);
    const id = tq.getClinicTrades()[0].id;
    // The first save re-prices the row through the charges engine (the fixture's
    // hand-typed charges are not the engine's) — a change the Clinic CAN see.
    expect(commit.updateManualTrade(id, { notes: "a note" }).ok).toBe(true);
    expect(q.getClinicState().status).toBe("stale");
    await q.computeClinic();
    expect(commit.updateManualTrade(id, { notes: "another note" }).ok).toBe(true);
    expect(q.getClinicState().status).toBe("fresh");
    expect(commit.updateManualTrade(id, { setupTag: "S2" }).ok).toBe(true);
    const s = q.getClinicState();
    expect(s.status).toBe("stale");
    expect(s.report).not.toBeNull(); // the old report, shown with its age
    commit.updateManualTrade(id, { setupTag: "S" });
    expect(q.getClinicState().status).toBe("fresh"); // the input is back to what was computed
  });

  it("journal (insert), delete and Trash restore move the digest; restore brings the SAME input back", () => {
    selectAccount(A);
    const d0 = q.clinicInputs().digest;
    const ins = t.db.insert(t.schema.trades).values(closed(A, 77)).returning().get();
    const d1 = q.clinicInputs().digest;
    expect(d1).not.toBe(d0);
    expect(q.getClinicState().status).toBe("stale");
    const res = del.deleteTradesByIds([ins.id], "test");
    expect(res.ok).toBe(true);
    expect(q.clinicInputs().digest).toBe(d0);
    expect(trash.restoreTrashSnapshot(res.snapshotId!).ok).toBe(true);
    expect(q.clinicInputs().digest).toBe(d1);
    del.deleteTradesByIds([ins.id], "test again");
    expect(q.clinicInputs().digest).toBe(d0);
  });

  it("a cached row from another ENGINE_VERSION is never read (missing, not stale)", () => {
    selectAccount(A);
    const row = t.db.select().from(t.schema.clinicCache).where(await_eq(t.schema.clinicCache.scopeKey, "acct:1")).get()!;
    t.db.update(t.schema.clinicCache).set({ engineVersion: "c1" }).where(await_eq(t.schema.clinicCache.scopeKey, "acct:1")).run();
    expect(q.getClinicState().status).toBe("missing");
    // C3: a cached C2 report (no sizingSample, sizing at the old floor and sample) reads missing too — never stale.
    t.db.update(t.schema.clinicCache).set({ engineVersion: "c2.2" }).where(await_eq(t.schema.clinicCache.scopeKey, "acct:1")).run();
    expect(q.getClinicState().status).toBe("missing");
    t.db.update(t.schema.clinicCache).set({ engineVersion: row.engineVersion }).where(await_eq(t.schema.clinicCache.scopeKey, "acct:1")).run();
    expect(q.getClinicState().status).toBe("fresh");
  });

  it("measures the digest itself: a stable hex sha256 of the exact array, open rows as {id, isOpen} only", () => {
    const ins = q.clinicInputs();
    expect(ins.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(q.clinicDigest(ins.scopeKey, ins.opts, ins.trades)).toBe(ins.digest);
    const open = { ...ins.trades[0], isOpen: true };
    const openChanged = { ...open, netPnl: 12345, setupTag: "zzz" };
    expect(q.clinicDigest(ins.scopeKey, ins.opts, [open])).toBe(q.clinicDigest(ins.scopeKey, ins.opts, [openChanged]));
    expect(q.clinicDigest("acct:2", ins.opts, ins.trades)).not.toBe(ins.digest);
    expect(q.clinicDigest(ins.scopeKey, { ...ins.opts, today: "2099-01-01" }, ins.trades)).not.toBe(ins.digest);
  });
});

describe("experiments — Pro only, a REAL account, checked over ITS OWN account", () => {
  it("the All view refuses a start (400) and cannot start one in state", async () => {
    selectAccount(ALL);
    expect(q.getClinicState().canStartExperiment).toBe(false);
    const r = await json(await routeExp.POST(post({ cellKey: "eq_intraday|setup:S" })));
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(t.db.select().from(t.schema.clinicExperiments).all()).toHaveLength(0);
    // 557 ms locally (the first entitlement read and the route module's first use);
    // the Windows runner is >15x slower on SQLite-file work (AGENTS.md, Testing).
  }, 20_000);

  it("starts on a graded cell of the selected account; a second open one on the same cell is 409", async () => {
    selectAccount(A);
    await q.computeClinic();
    const r = await json(await routeExp.POST(post({ cellKey: "eq_intraday|setup:S" })));
    expect(r.status).toBe(200);
    const e = r.body.experiment as { accountId: number; startedAt: string; status: string; verb: string; progressN: number; baseline: { n: number } };
    expect(e).toMatchObject({ accountId: A, startedAt: today, status: "open", progressN: 0 });
    expect(e.verb).not.toBe("imperative");
    expect(e.baseline.n).toBe(30);
    expect((await routeExp.POST(post({ cellKey: "eq_intraday|setup:S" }))).status).toBe(409);
    expect((await routeExp.POST(post({ cellKey: "eq_intraday|setup:nope" }))).status).toBe(400);
    expect((await routeExp.POST(post({}))).status).toBe(400);
    expect(q.getClinicState().note!.findings.every((f) => f.key !== "eq_intraday|setup:S" || f.experiment === null)).toBe(true);
  });

  it("each experiment is checked over ITS OWN account's trades — never the view's", () => {
    // Trades exiting the day AFTER the start (seam D2: the start day is baseline) in the same cell: 3 in A, 5 in B.
    const next = dayAfter(today);
    t.db.insert(t.schema.trades).values([0, 1, 2].map((i) => closed(A, 200 + i, { buyDate: next, sellDate: next }))).run();
    t.db.insert(t.schema.trades).values([0, 1, 2, 3, 4].map((i) => closed(B, 300 + i, { buyDate: next, sellDate: next }))).run();
    selectAccount(ALL);
    const all = q.getClinicState().experiments;
    expect(all).toHaveLength(1);
    expect(all[0].progressN).toBe(3);
    expect(all[0].baseline!.n).toBe(30);
    selectAccount(A);
    expect(q.getClinicState().experiments[0].progressN).toBe(3);
    selectAccount(B);
    expect(q.getClinicState().experiments).toHaveLength(0);
  });

  it("PATCH abandon: 403 from another account and from the All view; 200 from its own", async () => {
    const id = t.db.select().from(t.schema.clinicExperiments).all()[0].id;
    selectAccount(B);
    expect((await routeExp.PATCH(patch({ id, status: "abandoned" }))).status).toBe(403);
    selectAccount(ALL);
    expect((await routeExp.PATCH(patch({ id, status: "abandoned" }))).status).toBe(403);
    selectAccount(A);
    expect((await routeExp.PATCH(patch({ id, status: "nope" }))).status).toBe(400);
    const r = await json(await routeExp.PATCH(patch({ id, status: "abandoned" })));
    expect(r.status).toBe(200);
    expect((r.body.experiment as { status: string; verb: string }).status).toBe("abandoned");
    expect((await routeExp.PATCH(patch({ id, status: "abandoned" }))).status).toBe(409);
    expect((await routeExp.PATCH(patch({ id: 999999, status: "abandoned" }))).status).toBe(404);
  });

  it("ONE unit: start → a risk-cap reprice → check moves baseline AND result together", async () => {
    selectAccount(A);
    // A 'cap' cell: 25 before today, 20 exiting today, every risk = the cap (₹100 → ₹200).
    const rows = (t.sqlite.prepare("SELECT id FROM risk_config").all() as { id: number }[]).length;
    expect(rows).toBeGreaterThan(0);
    t.sqlite.prepare("UPDATE risk_config SET per_trade_max_loss = 100, cap_scheme = 1").run();
    // R values on a 0.2 grid: R and R/2 are both exact at the two decimals repriceCapTrades rounds to.
    const capR = (i: number) => [1.2, -0.6, 0.8, -1, 0.4, 2, -0.8][i % 7];
    const capRow = (i: number, day: string) =>
      closed(A, 500 + i, { setupTag: "CAP", riskSource: "cap", riskAmount: 100, rMultiple: capR(i), netPnl: capR(i) * 100, grossPnl: capR(i) * 100 + 20, buyDate: day, sellDate: day });
    t.db.insert(t.schema.trades).values(Array.from({ length: 25 }, (_, i) => capRow(i, dayPlus(400 + i)))).run();
    riskCap.repriceCapTrades(t.sqlite);
    await q.computeClinic();
    const started = q.startExperiment("eq_intraday|setup:CAP");
    expect(started.ok).toBe(true);
    t.db.insert(t.schema.trades).values(Array.from({ length: 20 }, (_, i) => capRow(25 + i, dayAfter(today)))).run();
    riskCap.repriceCapTrades(t.sqlite);
    const before = q.getClinicState().experiments.find((e) => e.cellKey === "eq_intraday|setup:CAP")!;
    expect(before.status).toBe("checked");
    expect(before.result!.n).toBe(20);

    t.sqlite.prepare("UPDATE risk_config SET per_trade_max_loss = 200, cap_scheme = 1").run();
    expect(riskCap.repriceCapTrades(t.sqlite)).toBeGreaterThan(0);
    const after = q.getClinicState().experiments.find((e) => e.cellKey === "eq_intraday|setup:CAP")!;
    expect(after.baseline!.n).toBe(25);
    expect(after.baseline!.meanR!).toBeCloseTo(before.baseline!.meanR! / 2, 9);
    expect(after.result!.meanR!).toBeCloseTo(before.result!.meanR! / 2, 9);
    // the compute route persists `checked` once
    expect(t.db.select().from(t.schema.clinicExperiments).where(await_eq(t.schema.clinicExperiments.cellKey, "eq_intraday|setup:CAP")).get()!.status).toBe("open");
    await q.computeClinic();
    expect(t.db.select().from(t.schema.clinicExperiments).where(await_eq(t.schema.clinicExperiments.cellKey, "eq_intraday|setup:CAP")).get()!.status).toBe("checked");
  });
});

describe("the journal dialog's one line (GET /api/edge-clinic/cell)", () => {
  it("Pro, inside the scope: the trade's segment|setup cell from the CACHED report; outside the scope: null", async () => {
    selectAccount(A);
    await q.computeClinic();
    const aTrade = tq.getClinicTrades()[1];
    const r = await json(await routeCell.GET(new Request(`http://x/api/edge-clinic/cell?tradeId=${aTrade.id}`)));
    expect(r.status).toBe(200);
    expect(r.body.line).toMatchObject({ key: "eq_intraday|setup:S" });
    expect((r.body.line as { label: string }).label).toMatch(/ · S$/);
    selectAccount(B);
    const out = await json(await routeCell.GET(new Request(`http://x/api/edge-clinic/cell?tradeId=${aTrade.id}`)));
    expect(out.body.line).toBeNull();
    expect((await routeCell.GET(new Request("http://x/api/edge-clinic/cell?tradeId=abc"))).status).toBe(400);
    selectAccount(A);
  });
});

describe("a FREE copy — 403 on experiments, null on the cell line, no report in its state", () => {
  it("free → 403 / null / clinicStateFor strips the report", async () => {
    selectAccount(A);
    setFree(true);
    try {
      const lic = await import("@/lib/queries/license");
      expect(lic.getEntitlement().pro).toBe(false);
      expect((await routeExp.POST(post({ cellKey: "eq_intraday|setup:S" }))).status).toBe(403);
      expect((await routeExp.PATCH(patch({ id: 1, status: "abandoned" }))).status).toBe(403);
      const id = tq.getClinicTrades()[1].id;
      const cell = await json(await routeCell.GET(new Request(`http://x/api/edge-clinic/cell?tradeId=${id}`)));
      expect(cell.status).toBe(200);
      expect(cell.body.line).toBeNull();
      const free = clinicStateFor(q.getClinicState(), lic.getEntitlement().pro);
      const wire = JSON.stringify(free);
      expect(free.teaser).not.toBeNull();
      expect(wire).not.toContain('"cells"');
      expect(wire).not.toContain("hypothesis");
    } finally {
      setFree(false);
    }
  });
});

describe("the write side — grade + typed range validated, stored, and scaled by a split", () => {
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const closedFills = { closed: true, avgBuyPrice: 100, avgSellPrice: 110 };

  it("refuses one-of-two, a range that does not bracket a closed trade's fills, low > high, and an unknown grade", async () => {
    const r1 = clinicFieldsFrom(fd({ intraHigh: "112" }), closedFills, "create");
    expect(r1).toMatchObject({ ok: false });
    expect((r1 as { message: string }).message).toMatch(/both/);
    expect(clinicFieldsFrom(fd({ intraHigh: "112", intraLow: "101" }), closedFills, "create")).toMatchObject({ ok: false });
    expect(clinicFieldsFrom(fd({ intraHigh: "109", intraLow: "95" }), closedFills, "create")).toMatchObject({ ok: false });
    expect(clinicFieldsFrom(fd({ intraHigh: "90", intraLow: "95" }), { closed: false, avgBuyPrice: 100, avgSellPrice: 0 }, "create")).toMatchObject({ ok: false });
    expect(clinicFieldsFrom(fd({ setupGrade: "C" }), closedFills, "create")).toMatchObject({ ok: false });
    // accepted shapes
    expect(clinicFieldsFrom(fd({ intraHigh: "112", intraLow: "98", setupGrade: "A+" }), closedFills, "create"))
      .toEqual({ ok: true, setupGrade: "A+", intraHigh: 112, intraLow: 98 });
    expect(clinicFieldsFrom(fd({ intraHigh: "130", intraLow: "120" }), { closed: false, avgBuyPrice: 100, avgSellPrice: 0 }, "create"))
      .toMatchObject({ ok: true, intraHigh: 130, intraLow: 120 }); // open: only low ≤ high
    expect(clinicFieldsFrom(fd({}), closedFills, "create")).toEqual({ ok: true, setupGrade: null, intraHigh: null, intraLow: null });
    // update: an absent field is NOT MENTIONED (undefined) — the stored value is kept
    expect(clinicFieldsFrom(fd({}), closedFills, "update")).toEqual({ ok: true, setupGrade: undefined, intraHigh: undefined, intraLow: undefined });
  });

  it("the manual insert and the edit store the grade and the range (REAL, per unit); undefined keeps them", () => {
    selectAccount(A);
    const res = commit.commitManualTrade(
      { broker: "dhan", tradingsymbol: "RANGEX", isin: null, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, sellQty: 0, avgSellPrice: 0, sellValue: 0,
        closingPrice: null, grossPnl: 0, unrealisedPnl: 0, buyDate: "2026-09-01", sellDate: null, productHint: "delivery", exchangeHint: null, sourceFile: "manual" },
      { setupGrade: "A", intraHigh: 104.5, intraLow: 97.25 },
    );
    const id = res.id!;
    const row = () => t.db.select().from(t.schema.trades).where(await_eq(t.schema.trades.id, id)).get()!;
    expect(row()).toMatchObject({ setupGrade: "A", intraHigh: 104.5, intraLow: 97.25 });
    expect(commit.updateManualTrade(id, { buyQty: 10, avgBuyPrice: 100, sellQty: 0, avgSellPrice: 0, notes: "x" }).ok).toBe(true);
    expect(row()).toMatchObject({ setupGrade: "A", intraHigh: 104.5, intraLow: 97.25 });
    expect(commit.updateManualTrade(id, { buyQty: 10, avgBuyPrice: 100, sellQty: 0, avgSellPrice: 0, setupGrade: "B", intraHigh: null, intraLow: null }).ok).toBe(true);
    expect(row()).toMatchObject({ setupGrade: "B", intraHigh: null, intraLow: null });
  });

  it("a 1:5 split scales the typed intra-trade range exactly as it scales the stop", () => {
    const ins = t.db.insert(t.schema.trades).values(tradeRow({
      accountId: A, symbol: "SPLITX", tradingsymbol: "SPLITX", buyQty: 10, avgBuyPrice: 500, buyValue: 5000, isOpen: true, side: "long",
      buyDate: "2026-08-01", slPlanned: 450, intraHigh: 520, intraLow: 480,
    })).returning().get();
    const ca = t.db.insert(t.schema.corporateActions).values({ symbol: "SPLITX", type: "split", exDate: "2026-09-01", fromUnits: 1, toUnits: 5 }).returning().get();
    return import("@/lib/corporate-actions-apply").then(({ applyCorporateAction }) => {
      expect(applyCorporateAction(ca.id).ok).toBe(true);
      const r = t.db.select().from(t.schema.trades).where(await_eq(t.schema.trades.id, ins.id)).get()!;
      expect(r).toMatchObject({ buyQty: 50, avgBuyPrice: 100, slPlanned: 90, intraHigh: 104, intraLow: 96 });
    });
  });
});

describe("account delete / merge carry the experiments; restore of a pre-4.7 backup (no FK)", () => {
  it("merge: the source's experiments MOVE; one colliding with the target's open one is set aside; the source's cache row goes", async () => {
    // B gets an open experiment on the same cell A has an open one on (A's S one was abandoned above, so open one again).
    selectAccount(A);
    await q.computeClinic();
    expect(q.startExperiment("eq_intraday|setup:S").ok).toBe(true);
    selectAccount(B);
    await q.computeClinic();
    expect(q.startExperiment("eq_intraday|setup:S").ok).toBe(true);
    expect(t.db.select().from(t.schema.clinicCache).where(await_eq(t.schema.clinicCache.scopeKey, "acct:2")).get()).toBeDefined();
    const res = acctDel.deleteAccount({ accountId: B, mode: "merge", targetId: A, connections: "delete" });
    expect(res.ok, res.message).toBe(true);
    const exps = t.db.select().from(t.schema.clinicExperiments).all();
    expect(exps.every((e) => e.accountId === A)).toBe(true);
    const onS = exps.filter((e) => e.cellKey === "eq_intraday|setup:S");
    expect(onS.filter((e) => e.status === "open")).toHaveLength(1);
    expect(onS.filter((e) => e.status === "abandoned").length).toBeGreaterThanOrEqual(2); // A's earlier + B's set aside
    expect(t.db.select().from(t.schema.clinicCache).where(await_eq(t.schema.clinicCache.scopeKey, "acct:2")).get()).toBeUndefined();
    selectAccount(A);
    expect(q.getClinicState().status).toBe("stale"); // the target's book changed
  });

  it("purge snapshots the experiments and a Trash restore brings back exactly one copy", async () => {
    t.db.insert(t.schema.accounts).values({ id: 3, name: "Book C", isDefault: false }).run();
    t.db.insert(t.schema.trades).values(Array.from({ length: 22 }, (_, i) => closed(3, 700 + i))).run();
    selectAccount(3);
    await q.computeClinic();
    expect(q.startExperiment("eq_intraday|setup:S").ok).toBe(true);
    selectAccount(A);
    const res = acctDel.deleteAccount({ accountId: 3, mode: "purge", connections: "delete" });
    expect(res.ok, res.message).toBe(true);
    expect(t.db.select().from(t.schema.clinicExperiments).where(await_eq(t.schema.clinicExperiments.accountId, 3)).all()).toHaveLength(0);
    const rr = trash.restoreTrashSnapshot(res.snapshotId!);
    expect(rr.ok, rr.message).toBe(true);
    expect(t.db.select().from(t.schema.clinicExperiments).where(await_eq(t.schema.clinicExperiments.accountId, 3)).all()).toHaveLength(1);
  });

  it("a pre-4.7 backup (no clinic_experiments key) restores with experiments present — no FK to trip — and drops the cache", () => {
    const n = t.db.select().from(t.schema.clinicExperiments).all().length;
    expect(n).toBeGreaterThan(0);
    expect(t.db.select().from(t.schema.clinicCache).all().length).toBeGreaterThan(0);
    const dump = backup.dumpDatabase(false);
    expect(dump.tables.clinic_experiments).toHaveLength(n); // a 4.7 dump carries them
    const pre47 = { ...dump, tables: { ...dump.tables } };
    delete (pre47.tables as Record<string, unknown>).clinic_experiments;
    const r = backup.restoreDatabase(pre47);
    expect(r.ok, r.message).toBe(true);
    expect(t.db.select().from(t.schema.clinicExperiments).all()).toHaveLength(n); // left alone (per-key rule)
    expect(t.db.select().from(t.schema.clinicCache).all()).toHaveLength(0);
    // …and a 4.7 envelope round-trips them.
    const r2 = backup.restoreDatabase(dump);
    expect(r2.ok, r2.message).toBe(true);
    expect(t.db.select().from(t.schema.clinicExperiments).all()).toHaveLength(n);
    // Two full restores (each re-runs the data fixes and the rate-card refresh):
    // 1,440 ms locally, so a raised timeout for the >15x slower Windows runner.
  }, 40_000);
});

describe("ENGINE_VERSION is pinned to the engine's output (golden report)", () => {
  /** A fixed book across two segments, four setups, two grades and the F&O cuts. */
  function goldenBook(): ClinicTrade[] {
    const out: ClinicTrade[] = [];
    for (let i = 0; i < 120; i++) {
      const fno = i % 3 === 0;
      const r = rAt(i) * (fno ? 1.5 : 1);
      out.push({
        id: i + 1, segment: fno ? "index_option" : "eq_intraday", buyQty: fno ? 75 * (1 + (i % 4)) : 10, sellQty: fno ? 75 * (1 + (i % 4)) : 10,
        side: i % 5 === 0 ? "short" : "long", buyDate: dayPlus(i * 4), sellDate: dayPlus(i * 4 + (i % 3)), entryTime: "09:30", exitTime: i % 2 ? "11:15" : "14:05",
        isOpen: i % 17 === 0, grossPnl: r * 1000 + 20, chargesTotal: 20, netPnl: r * 1000, rMultiple: i % 11 === 0 ? null : r, riskAmount: 1000,
        riskSource: i % 7 === 0 ? "cap" : "set", rPlan: i % 4 === 0, slPlanned: null, trailingSl: null, avgBuyPrice: 100, avgSellPrice: 100 + r,
        setupTag: ["ORB", "PB", null, "BRK"][i % 4], setupGrade: i % 6 === 0 ? "A+" : i % 6 === 1 ? "B" : null,
        ruleViolations: i % 9 === 0 ? ["playbook:no-chase"] : i % 2 ? [] : null, entryDte: fno ? i % 9 : null, lotSize: fno ? 75 : null,
      });
    }
    return out;
  }
  /** Numbers to 10 significant digits: a last-bit libm difference across platforms cannot flip the pin. */
  const stable = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toPrecision(10)) : x));

  it(`report hash ⇔ ENGINE_VERSION "${ENGINE_VERSION}" — an output change needs a version bump (and this pin updated)`, () => {
    const report = edgeClinic(goldenBook(), { today: "2026-10-03", riskCapRupees: 1500, currentRiskPct: 1 });
    const hash = createHash("sha256").update(stable(report)).digest("hex");
    // c3.0 (v4.7.0 C3): sizing over kellySample() — no cap-unit R, no basis-less sale — at the floor 30, plus `sizingSample`.
    expect({ ENGINE_VERSION, hash }).toEqual({ ENGINE_VERSION: "c3.0", hash: "6b0acc4b8745f83951eb8aad1cf6b7575cb1022a4c73c2192539114c3c42c240" });
  });
});
