// v4.7.0 wave C2 — the SEAM pass (vyuha-seam-tester). Builder A owns the server
// half (lib/queries/{trades,edge-clinic}.ts, app/api/edge-clinic/*, the engine
// and the note); builder B owns the UI half (app/reports/edge-clinic/_tabs/
// clinic.tsx, components/edge-clinic/*, Arjun's Eye, the journal dialog). Every
// case below runs BOTH real halves over ONE migrated temp database (the G2
// sequence book + three seam books) — nothing on either side is mocked; only
// next/cache and next/navigation are stubbed because a route calls
// revalidatePath and a client component calls useRouter outside a Next request.
//
// ── THE SEAM TABLE ──────────────────────────────────────────────────────────
// crossing value          | producer (A unless said)                              | consumer                                           | unit / null              | case
// ClinicTrade.netPnl etc. | lib/queries/trades.ts:200 getClinicTrades             | lib/analytics/edge-clinic.ts edgeClinic (cost)     | RUPEES (paise in DB)     | "1. maps a row … money in rupees"
// riskSource / rPlan      | trades.ts:118-131 rPlanRows                            | edgeClinic provenance + rUnit                      | 'cap'|'set'|'frozen'|null| "1. … provenance"
// ruleViolations          | trades.ts:206 (json column)                            | edge-clinic.ts:856 ruleAdherence                   | string[] | null         | "1." + DEFECT D1 (FIXED in C2, ENGINE_VERSION c2.2)
// buy/sellDate DD-MM-YYYY | trades row (4.2.x)                                     | edge-clinic.ts:355 dayOf → order / checkExperiment | ISO day                  | "1. … DD-MM-YYYY"
// setupGrade / side / dte | trades.ts:185 CLINIC_FIELDS                            | grade cells / F&O side + lots cuts                 | 'A+'|'A'|'B'|null        | "1. … grade cells, F&O"
// digest                  | lib/queries/edge-clinic.ts:71 clinicDigest            | getClinicState status → ClinicRunner POST          | sha256 hex               | "2. digest × book ops"
// ClinicState (free)      | lib/analytics/edge-clinic-contract.ts:100             | _tabs/clinic.tsx ClinicTab (RSC props)             | report/note/exps null    | "3."
// ClinicTeaser            | lib/analytics/edge-clinic-note.ts:160 teaser          | components/edge-clinic/teaser-card.tsx             | grade, trades still need | "4."
// WeeklyFinding.key       | edge-clinic-note.ts weeklyNote                        | experiment-actions.tsx:68 POST {cellKey}           | cell key string          | "5. every proposed finding …"
// ClinicExperiment        | lib/queries/edge-clinic.ts checkedExperiments          | components/edge-clinic/weekly-note.tsx             | R, one unit              | "5."
// startedAt (IST day)     | edge-clinic.ts:212 todayIstIso                         | edge-clinic-note.ts checkExperiment split          | IST date                 | "5. IST boundary"
// TradeCellLine           | lib/queries/edge-clinic.ts:341                         | app/api/edge-clinic/cell → journal dialog          | null outside scope       | "5. cell route"
// MaeTradeInput intraH/L  | trades.ts:615 ARJUN_FIELDS / getTrades                 | lib/analytics/mae-input.ts → computeMaeMfe         | per-unit PRICE (REAL)    | "6."
// note.findings (free)    | contract clinicStateFor                               | components/edge-clinic/arjun-clinic-card.tsx:30    | null for free            | DEFECT D3 (FIXED in C2)
//
// DEFECTS FOUND (pinned it.fails, each names its finding; ALL THREE FIXED in the C2 commit and flipped to `it` — LEDGER F-51):
//   D1 the journal route stores NULL for "journaled against a playbook, every rule kept"
//      (app/api/trades/journal/route.ts:61) and the engine reads NULL as "no rule data"
//      (lib/analytics/edge-clinic.ts:856) — a clean playbook trade never enters the
//      "kept every rule" arm; ClinicTrade carries no playbookId to tell the two apart.
//   D2 an experiment started on day D counts the cell's trades that exited EARLIER on D —
//      already in the graded report the user started it from — as experiment trades
//      (edge-clinic-note.ts:213 `d < startedAt`), and the proposal's "as the N before
//      them did" (edge-clinic-note.ts proposalFor, N = cell.nWithR) disagrees with the
//      Before line (baseline.n) rendered under it.
//   D3 a FREE copy whose book HAS been read is told "The Clinic has not read this book
//      yet" on Arjun's Eye (arjun-clinic-card.tsx:30) — clinicStateFor nulls `report`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import {
  CLINIC_CELL,
  OPS,
  VARIANTS,
  freshCtx,
  loadBookMods,
  seedSequenceBook,
  snapshotTemplate,
  type BookMods,
  type SeedIds,
  type Template,
} from "./helpers/book-ops";
// Pure modules (no DB in their graph) — safe as static imports.
import { cellTrades, edgeClinic } from "@/lib/analytics/edge-clinic";
import { clinicStateFor, EXPERIMENT_TARGET_N, type ClinicState } from "@/lib/analytics/edge-clinic-contract";
import { checkExperiment, teaser } from "@/lib/analytics/edge-clinic-note";
import { maeInputsOf } from "@/lib/analytics/mae-input";
import { computeMaeMfe } from "@/lib/analytics/mae-mfe";

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
let q: typeof import("@/lib/queries/edge-clinic");
let tq: typeof import("@/lib/queries/trades");
let lic: typeof import("@/lib/queries/license");
let routeExp: typeof import("@/app/api/edge-clinic/experiments/route");
let routeCell: typeof import("@/app/api/edge-clinic/cell/route");
let routeCompute: typeof import("@/app/api/edge-clinic/compute/route");
let routeJournal: typeof import("@/app/api/trades/journal/route");
let ui: {
  ClinicTab: typeof import("@/app/reports/edge-clinic/_tabs/clinic").ClinicTab;
  ClinicTeaserCard: typeof import("@/components/edge-clinic/teaser-card").ClinicTeaserCard;
  CellsGrid: typeof import("@/components/edge-clinic/clinic-report").CellsGrid;
  ExperimentsList: typeof import("@/components/edge-clinic/weekly-note").ExperimentsList;
  ArjunClinicCard: typeof import("@/components/edge-clinic/arjun-clinic-card").ArjunClinicCard;
};
let todayIst: string;

/** The seam books (ids well clear of the G2 fixture's 1 and 2). */
const EXP = 9; //  a graded 'cap' cell "SEAM" — the experiment flow
const MAP = 10; // one row per mapping shape — the DB → ClinicTrade crossing
const SAME = 11; // a graded cell with trades exiting TODAY before the start (D2)
const SEAM_CELL = "eq_intraday|setup:SEAM";
const SAME_CELL = "eq_intraday|setup:SAMEDAY";
const PB_RULE = "Waited for the close";
let playbookId: number;
const mapIds: Record<string, number> = {};

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const setFree = (free: boolean) =>
  t.db.update(t.schema.settings).set({ licenseKey: null, trialStartedAt: free ? "2020-01-01T00:00:00.000Z" : new Date().toISOString() }).run();
const accountExists = (id: number) => t.db.select().from(t.schema.accounts).all().some((a) => a.id === id);
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const jsonOf = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const day2025 = (i: number) => new Date(Date.UTC(2025, 0, 2 + i)).toISOString().slice(0, 10);
const SEAM_R = [1.4, 0.6, -0.4, 1.0, 1.8, -0.2, 0.8];

/** Closed 'cap' round trips the way the product stores them: net = R × today's resolved cap, then repriced by the product. */
function capRows(acct: number, tag: string, rs: readonly number[], dayOf: (i: number) => string): number[] {
  const cap = m.limits.resolvePerTradeCap(m.riskCap.readCapRows(t.sqlite), "active", "eq_intraday");
  if (cap == null || !(cap > 0)) throw new Error("the seeded risk_config states no per-trade cap");
  const out: number[] = [];
  rs.forEach((r, i) => {
    const day = dayOf(i);
    const row = t.db
      .insert(t.schema.trades)
      .values(tradeRow({
        accountId: acct, bucket: "active", segment: "eq_intraday", symbol: `SEAM${acct}`, tradingsymbol: `SEAM${acct}`,
        buyQty: 10, avgBuyPrice: 100, buyValue: 1000, sellQty: 10, avgSellPrice: 100 + (r * cap) / 10, sellValue: 1000 + r * cap,
        buyDate: day, sellDate: day, side: "long", isOpen: false, grossPnl: r * cap, chargesTotal: 0, netPnl: r * cap,
        riskAmount: cap, riskSource: "cap", rMultiple: r, setupTag: tag,
      }))
      .returning({ id: t.schema.trades.id })
      .get()!;
    out.push(row.id);
  });
  m.riskCap.repriceCapTrades(t.sqlite, { ids: out });
  return out;
}

/** The mapping book: one row per shape the DB can hand the engine. */
function seedMapBook() {
  const ins = (key: string, over: Record<string, unknown>) => {
    mapIds[key] = t.db.insert(t.schema.trades).values(tradeRow({ accountId: MAP, bucket: "active", ...over })).returning({ id: t.schema.trades.id }).get()!.id;
  };
  // A 4.2.x row: DD-MM-YYYY dates, a 'cap' R, two violations (one a playbook rule), graded A+.
  ins("cap", {
    segment: "eq_intraday", symbol: "MAPA", tradingsymbol: "MAPA", buyQty: 10, avgBuyPrice: 100, buyValue: 1000, sellQty: 10, avgSellPrice: 175.037, sellValue: 1750.37,
    buyDate: "05-03-2025", sellDate: "07-03-2025", side: "long", isOpen: false, grossPnl: 790.12, chargesTotal: 39.75, netPnl: 750.37,
    riskAmount: 500, riskSource: "cap", rMultiple: 1.5, setupTag: "MAP", setupGrade: "A+", ruleViolations: [`Playbook: ${PB_RULE}`, "Max trades/day"],
  });
  // A stated SHORT with a stop the risk ties to (rPlan), DD/MM/YYYY, graded B.
  ins("plan", {
    segment: "eq_intraday", symbol: "MAPB", tradingsymbol: "MAPB", buyQty: 10, avgBuyPrice: 208.05, buyValue: 2080.5, sellQty: 10, avgSellPrice: 200, sellValue: 2000,
    buyDate: "06/03/2025", sellDate: "06/03/2025", side: "short", isOpen: false, grossPnl: -80.5, chargesTotal: 0, netPnl: -80.5,
    slPlanned: 210, riskAmount: 100, riskSource: "set", rMultiple: -0.805, setupTag: "MAP", setupGrade: "B",
  });
  // R frozen at the first entry (a staged position's source), ISO date.
  ins("frozen", {
    segment: "eq_intraday", symbol: "MAPC", tradingsymbol: "MAPC", buyQty: 5, avgBuyPrice: 300, buyValue: 1500, sellQty: 5, avgSellPrice: 310, sellValue: 1550,
    buyDate: "2025-03-06", sellDate: "2025-03-06", side: "long", isOpen: false, grossPnl: 50, chargesTotal: 10, netPnl: 40,
    riskAmount: 80, riskSource: "frozen", rMultiple: 0.5, setupTag: "MAP", ruleViolations: ["Max loss/day"],
  });
  // No risk, no R.
  ins("noR", {
    segment: "eq_intraday", symbol: "MAPD", tradingsymbol: "MAPD", buyQty: 1, avgBuyPrice: 50, buyValue: 50, sellQty: 1, avgSellPrice: 49, sellValue: 49,
    buyDate: "2025-03-01", sellDate: "2025-03-01", side: "long", isOpen: false, grossPnl: -1, chargesTotal: 0.25, netPnl: -1.25, riskSource: null, rMultiple: null,
  });
  // An OPEN row graded A: never a grade cell, counted in openExcluded.
  ins("open", {
    segment: "eq_intraday", symbol: "MAPE", tradingsymbol: "MAPE", buyQty: 3, avgBuyPrice: 90, buyValue: 270, side: "long", isOpen: true,
    buyDate: "2025-03-08", setupGrade: "A", setupTag: "MAP",
  });
  // A SOLD index option, two lots, DTE 3 — the F&O cuts read side, lotSize and entryDte.
  ins("option", {
    segment: "index_option", instrumentType: "option", exchange: "NFO", symbol: "NIFTY", tradingsymbol: "NIFTY 13 Mar 2025 22000 CE",
    buyQty: 150, avgBuyPrice: 40, buyValue: 6000, sellQty: 150, avgSellPrice: 52, sellValue: 7800, buyDate: "2025-03-10", sellDate: "2025-03-10",
    side: "short", isOpen: false, grossPnl: 1800, chargesTotal: 120.4, netPnl: 1679.6, riskAmount: 1500, riskSource: "set", rMultiple: 1.12,
    entryDte: 3, lotSize: 75,
  });
  // Typed intra-trade ranges (item 6): a long and a short, ISO dates, closed.
  ins("typedLong", {
    segment: "eq_intraday", symbol: "MAPH", tradingsymbol: "MAPH", buyQty: 20, avgBuyPrice: 100, buyValue: 2000, sellQty: 20, avgSellPrice: 106, sellValue: 2120,
    buyDate: "2025-03-12", sellDate: "2025-03-12", side: "long", isOpen: false, grossPnl: 120, chargesTotal: 0, netPnl: 120, intraHigh: 108.5, intraLow: 97.25,
  });
  ins("typedShort", {
    segment: "eq_intraday", symbol: "MAPS", tradingsymbol: "MAPS", buyQty: 20, avgBuyPrice: 100, buyValue: 2000, sellQty: 20, avgSellPrice: 110, sellValue: 2200,
    buyDate: "2025-03-13", sellDate: "2025-03-13", side: "short", isOpen: false, grossPnl: 200, chargesTotal: 0, netPnl: 200, intraHigh: 112, intraLow: 95,
  });
}

// One migrate + seed + G2 fixture + the seam books, frozen as the template every
// mutating case resets to (book-ops.ts `snapshotTemplate`). Measured locally
// 2026-10-03: ~3.0 s (file 6.8 s of tests less 3.8 s inside the its) — the G2 hook
// is ~1.8 s of it, four engine runs the rest. The raised timeout is for the Windows
// runner, > 15x slower on SQLite-file work (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("seams-v47-c2", { seed: true });
  m = await loadBookMods();
  ids = await seedSequenceBook(t.db, { t, m });
  q = m.edgeClinic;
  tq = await import("@/lib/queries/trades");
  lic = await import("@/lib/queries/license");
  routeExp = await import("@/app/api/edge-clinic/experiments/route");
  routeCell = await import("@/app/api/edge-clinic/cell/route");
  routeCompute = await import("@/app/api/edge-clinic/compute/route");
  routeJournal = await import("@/app/api/trades/journal/route");
  ui = {
    ClinicTab: (await import("@/app/reports/edge-clinic/_tabs/clinic")).ClinicTab,
    ClinicTeaserCard: (await import("@/components/edge-clinic/teaser-card")).ClinicTeaserCard,
    CellsGrid: (await import("@/components/edge-clinic/clinic-report")).CellsGrid,
    ExperimentsList: (await import("@/components/edge-clinic/weekly-note")).ExperimentsList,
    ArjunClinicCard: (await import("@/components/edge-clinic/arjun-clinic-card")).ArjunClinicCard,
  };
  todayIst = (await import("@/lib/domain/trading-day")).todayIstIso();
  setFree(false);

  // The G2 Clinic cell in both fixture books (25 before today + 20 today, 'cap').
  const ctx = freshCtx(t, m, ids);
  await VARIANTS.find((o) => o.name === "seedClinicCell")!.run(t.db, ctx);
  for (const [id, name] of [[EXP, "Seam EXP"], [MAP, "Seam MAP"], [SAME, "Seam SAME"]] as const) {
    t.db.insert(t.schema.accounts).values({ id, name, isDefault: false }).run();
  }
  capRows(EXP, "SEAM", Array.from({ length: 25 }, (_, i) => SEAM_R[i % SEAM_R.length]), (i) => day2025(i));
  capRows(SAME, "SAMEDAY", Array.from({ length: 22 }, (_, i) => SEAM_R[i % SEAM_R.length]), (i) => day2025(i));
  capRows(SAME, "SAMEDAY", [1.0, 0.6, 1.4], () => todayIst);
  seedMapBook();
  playbookId = t.db.insert(t.schema.playbooks).values({ name: "Seam PB", rules: [PB_RULE] }).returning({ id: t.schema.playbooks.id }).get()!.id;

  // Every scope's cache computed ONCE, so every op case starts fresh.
  // (MAP and SAME are computed by the cases that read them — a route POST, as the client runner does.)
  for (const s of [ids.acctA, ids.acctB, 0, EXP]) {
    select(s);
    await q.computeClinic();
  }
  select(ids.acctA);
  tpl = snapshotTemplate(freshCtx(t, m, ids));
}, 180_000);

afterAll(() => t?.cleanup());

/** Numbers to 10 significant digits (the golden-report rule in tests/edge-clinic-db.test.ts). */
const stable = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toPrecision(10)) : x));

// ─────────────────────────────────────────────────────────────────────────────
// 1. DB row → ClinicTrade → the engine's OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

describe("1. the DB row crosses into the engine intact (getClinicTrades → edgeClinic)", () => {
  const byKey = () => {
    tpl.reset();
    select(MAP);
    const rows = tq.getClinicTrades();
    const of = (k: string) => rows.find((r) => r.id === mapIds[k])!;
    return { rows, of };
  };

  it("money in RUPEES at runtime (paise in the DB), and the engine's cost card reads rupees", () => {
    const { rows, of } = byKey();
    const raw = t.sqlite.prepare("SELECT net_pnl_paise AS n, gross_pnl_paise AS g, charges_total_paise AS c, risk_amount_paise AS r FROM trades WHERE id = ?").get(mapIds.cap) as Record<string, number>;
    expect(raw).toEqual({ n: 75037, g: 79012, c: 3975, r: 50000 });
    expect([of("cap").netPnl, of("cap").grossPnl, of("cap").chargesTotal, of("cap").riskAmount]).toEqual([750.37, 790.12, 39.75, 500]);
    const report = edgeClinic(rows, { today: todayIst });
    const closed = rows.filter((r) => !r.isOpen);
    const book = report.cells.find((c) => c.key === "all|all")!;
    // net 750.37 − 80.5 + 40 − 1.25 + 1679.6 + 120 + 200 over 7 closed rows, charges 39.75 + 0 + 10 + 0.25 + 120.4 + 0 + 0.
    expect(closed).toHaveLength(7);
    expect(book.cost.netMean!).toBeCloseTo((750.37 - 80.5 + 40 - 1.25 + 1679.6 + 120 + 200) / 7, 9);
    expect(book.cost.costPerTrade!).toBeCloseTo((39.75 + 10 + 0.25 + 120.4) / 7, 9);
  });

  it("riskSource 'cap' / 'set'+stop / 'frozen' / null → the report's provenance; rPlan folded from the stop", () => {
    const { rows, of } = byKey();
    expect([of("cap").riskSource, of("plan").riskSource, of("frozen").riskSource, of("noR").riskSource]).toEqual(["cap", "set", "frozen", null]);
    expect([of("cap").rPlan, of("plan").rPlan, of("frozen").rPlan]).toEqual([false, true, false]);
    const report = edgeClinic(rows, { today: todayIst });
    // cap 1 · plan 1 (the short's 210 stop × 10 = ₹100) · typed: frozen + option + nothing else with an R · noR: MAPD + both typed-range rows.
    expect(report.provenance).toEqual({ plan: 1, typed: 2, cap: 1, unknown: 0, noR: 3 });
    expect(report.provenanceLine).toBe("1 plan-derived · 2 typed · 1 default-cap · 3 no R");
  });

  it("ruleViolations JSON → string[] and the engine's rule-adherence coverage", () => {
    const { rows, of } = byKey();
    expect(of("cap").ruleViolations).toEqual([`Playbook: ${PB_RULE}`, "Max trades/day"]);
    expect(of("plan").ruleViolations).toBeNull();
    const book = edgeClinic(rows, { today: todayIst }).cells.find((c) => c.key === "all|all")!;
    // With an R AND rule data: MAPA, MAPC. nWithR = 4 (MAPA, MAPB, MAPC, the option).
    expect(book.ruleAdherence.coverage).toEqual({ withData: 2, of: 4 });
  });

  it("the 4.2.x DD-MM-YYYY / DD/MM/YYYY dates order the cell and split an experiment through dayOf", () => {
    const { rows, of } = byKey();
    expect([of("cap").sellDate, of("plan").buyDate]).toEqual(["07-03-2025", "06/03/2025"]); // stored as written — the engine reads them
    const order = cellTrades(rows, "eq_intraday|setup:MAP").map((r) => r.id);
    // 2025-03-06 (MAPB short, sellDate 06/03/2025; MAPC ISO — tie by id) then 2025-03-07 (MAPA).
    expect(order).toEqual([mapIds.plan, mapIds.frozen, mapIds.cap]);
    const exp = checkExperiment(rows, {
      id: 1, accountId: MAP, cellKey: "eq_intraday|setup:MAP", cellLabel: "MAP", hypothesis: "h", startedAt: "2025-03-06", targetN: 20, status: "open", checkedAt: null, // seam D2: the start day is baseline

    }, todayIst);
    expect({ before: exp.baseline!.n, after: exp.progressN }).toEqual({ before: 2, after: 1 });
  });

  it("setupGrade → grade cells for CLOSED grades only; side / entryDte / lotSize → the F&O cuts; open rows excluded but counted", () => {
    const { rows, of } = byKey();
    expect([of("cap").setupGrade, of("plan").setupGrade, of("open").setupGrade, of("noR").setupGrade]).toEqual(["A+", "B", "A", null]);
    expect([of("plan").side, of("option").side]).toEqual(["short", "short"]);
    const report = edgeClinic(rows, { today: todayIst });
    expect(report.cells.filter((c) => c.kind === "grade").map((c) => [c.key, c.n])).toEqual([["all|grade:A+", 1], ["all|grade:B", 1]]);
    expect(report.openExcluded).toBe(1);
    expect(report.closedTrades).toBe(7);
    const fno = report.fno.find((f) => f.segment === "index_option")!;
    expect(fno.side!.map((c) => [c.cut!.label, c.n])).toEqual([["buyer", 0], ["seller", 1]]);
    expect({ unknownDte: fno.unknownDte, unknownLots: fno.unknownLots }).toEqual({ unknownDte: 0, unknownLots: 0 });
    expect(fno.lots.find((c) => c.n === 1)!.cut!.label).toMatch(/2/);
  });

  it("the open row reaches the digest as {id, isOpen} only — an open-row field the engine ignores moves nothing", () => {
    tpl.reset();
    select(ids.acctA);
    expect(q.getClinicState().status).toBe("fresh");
    const d0 = q.clinicInputs().digest;
    const open = t.db.select().from(t.schema.trades).all().find((r) => r.id === ids.mtfTrade)!;
    expect(open.isOpen).toBe(true);
    const res = m.commit.updateManualTrade(open.id, { setupTag: "seam-open", setupGrade: "A", notes: "seam" });
    expect(res.ok, res.message).toBe(true);
    expect(q.clinicInputs().digest).toBe(d0);
    const st = q.getClinicState();
    expect(st.status).toBe("fresh");
    const ins = q.clinicInputs();
    expect(stable(st.report)).toBe(stable(edgeClinic(ins.trades, ins.opts)));
    // …and the same edit on a CLOSED row the engine reads is seen.
    const closed = t.db.select().from(t.schema.trades).all().find((r) => r.accountId === ids.acctA && r.setupTag === "g2-clinic")!;
    expect(m.commit.updateManualTrade(closed.id, { setupGrade: "A" }).ok).toBe(true);
    expect(q.getClinicState().status).toBe("stale");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The digest across every book operation — never a stale report served as fresh
// ─────────────────────────────────────────────────────────────────────────────

/** The engine-visible columns, read straight from SQLite (a second source, not getClinicTrades). Open rows: id only. */
function rawProjection(scope: number): string {
  const where = scope > 0 ? "WHERE account_id = ?" : "";
  const rows = t.sqlite
    .prepare(
      `SELECT id, is_open, segment, buy_qty, sell_qty, side, buy_date, sell_date, entry_time, exit_time, gross_pnl_paise, charges_total_paise,
              net_pnl_paise, r_multiple, risk_amount_paise, risk_source, sl_planned, trailing_sl, avg_buy_price, avg_sell_price, setup_tag,
              setup_grade, rule_violations, entry_dte, lot_size, import_notes FROM trades ${where} ORDER BY id`,
    )
    .all(...(scope > 0 ? [scope] : [])) as Record<string, unknown>[];
  return JSON.stringify(rows.map((r) => (r.is_open ? { id: r.id } : r)));
}

async function runOps(names: string[]) {
  tpl.reset();
  const ctx = freshCtx(t, m, ids);
  const scopes = [ids.acctA, ids.acctB, 0];
  const before = new Map<number, { raw: string; opts: string }>();
  for (const s of scopes) {
    select(s);
    expect(q.getClinicState().status, `template scope ${s}`).toBe("fresh");
    before.set(s, { raw: rawProjection(s), opts: JSON.stringify(q.clinicInputs().opts) });
  }
  for (const n of names) {
    const op = OPS.find((o) => o.name === n) ?? VARIANTS.find((o) => o.name === n);
    if (!op) throw new Error(`no such op ${n}`);
    await op.run(t.db, ctx);
  }
  const moved: Record<string, boolean | "gone"> = {};
  for (const s of scopes) {
    if (s > 0 && !accountExists(s)) {
      moved[`acct:${s}`] = "gone";
      continue;
    }
    select(s);
    const st = q.getClinicState();
    const ins = q.clinicInputs();
    const b = before.get(s)!;
    const sawChange = rawProjection(s) !== b.raw || JSON.stringify(ins.opts) !== b.opts;
    // The digest moves exactly when something the engine reads moved.
    expect(st.status !== "fresh", `${names.join(" → ")}: scope ${s} status ${st.status}, engine-visible change ${sawChange}`).toBe(sawChange);
    if (st.status === "fresh") {
      // A report served as fresh IS the engine's answer for the CURRENT input.
      expect(stable(st.report), `${names.join(" → ")}: scope ${s} served a stale report as fresh`).toBe(stable(edgeClinic(ins.trades, ins.opts)));
    } else {
      const r = await jsonOf(await routeCompute.POST());
      expect(r.body).toMatchObject({ ok: true, status: "computed", scopeKey: `acct:${s}` });
      expect(q.getClinicState().status).toBe("fresh");
    }
    moved[`acct:${s}`] = st.status !== "fresh";
  }
  return { ctx, moved };
}

// Timeouts: each case below is 108-221 ms locally (2026-10-03: a template reset, the op, three scope reads and
// at most three engine runs over ~250 rows); 30 s is for the Windows runner, > 15x slower on SQLite-file work.
describe("2. the digest moves on every book operation the engine can see — and only then", () => {
  it.each(OPS.map((o) => [o.name]))("%s", async (name) => {
    await runOps([name]);
  }, 30_000);

  // …and the named operations really move it, so the sweep above is not vacuously fresh.
  it.each([
    ["deleteDupInA1", { "acct:1": true, "acct:0": true }], // delete
    ["reopenInEditor", { "acct:0": true }], // edit (the editor clears a sell leg)
    ["reimportOtherHash", { "acct:1": true, "acct:0": true }], // re-import (a new open lot: its id)
    ["editPerTradeCap", { "acct:1": true, "acct:2": true, "acct:0": true }], // risk-cap reprice
    ["editChargeRate", { "acct:1": false, "acct:2": false, "acct:0": false }], // re-prices nothing stored
    ["mergeAccountBIntoA", { "acct:1": true, "acct:2": "gone" }], // merge: the target's book changed, the source is gone
  ] as const)("moves as stated: %s", async (name, want) => {
    expect((await runOps([name])).moved).toMatchObject(want);
  }, 30_000);

  // The G2 fixture's rows carry side NULL; a product write (an IPO save, a Trash restore) stamps the side the
  // row already reads ("long"). The digest hashes the raw field, so that costs ONE recompute — conservative,
  // never wrong — and the engine's answer is unchanged. Pinned so a reader knows why a restore reads stale.
  it("delete → Trash restore: the restored row's engine answer is the template's (a stamped side costs one recompute)", async () => {
    tpl.reset();
    select(ids.acctA);
    const before = stable(q.getClinicState().report);
    const { moved } = await runOps(["deleteDupInA1", "restoreLatestSnapshot"]);
    select(ids.acctA);
    expect(moved["acct:1"]).toBe(true);
    const restored = q.clinicInputs().trades.find((x) => x.id === ids.dupA)!;
    expect(restored.side).toBe("long");
    expect(stable(q.getClinicState().report)).toBe(before);
  }, 30_000);

  it("merge → un-merge: the source book comes back and every scope's served report is the engine's answer", async () => {
    const unmerged = await runOps(["mergeAccountBIntoA", "restoreSourceAccount"]);
    expect(unmerged.moved["acct:2"]).not.toBe("gone");
  }, 30_000);

  it("a journal save: notes only stays fresh; a broken playbook rule is seen", async () => {
    tpl.reset();
    select(ids.acctA);
    const row = t.db.select().from(t.schema.trades).all().find((r) => r.accountId === ids.acctA && r.setupTag === "g2-clinic" && !r.isOpen)!;
    const post = (body: Record<string, unknown>) => routeJournal.POST(req("POST", "/api/trades/journal", { id: row.id, ...body }));
    expect((await post({ notes: "seam note" })).status).toBe(200);
    expect(q.getClinicState().status).toBe("fresh");
    expect((await post({ notes: "seam note", playbookId, brokenRules: [PB_RULE] })).status).toBe(200);
    const st = q.getClinicState();
    expect(st.status).toBe("stale");
    expect(q.clinicInputs().trades.find((x) => x.id === row.id)!.ruleViolations).toEqual([`Playbook: ${PB_RULE}`]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 + 4. The page path: what a free copy receives, and the teaser it shows
// ─────────────────────────────────────────────────────────────────────────────

describe("3. the page path — clinicStateFor(getClinicState(), pro)", () => {
  it("FREE: only the teaser and the status cross; no cell key, no meanR, no hypothesis reaches the payload or the markup", async () => {
    tpl.reset();
    select(ids.acctA);
    // An open experiment in scope, so the Pro state carries one to withhold.
    expect((await jsonOf(await routeExp.POST(req("POST", "/api/edge-clinic/experiments", { cellKey: CLINIC_CELL })))).status).toBe(200);
    const pro = clinicStateFor(q.getClinicState(), lic.getEntitlement().pro);
    expect(pro.report).not.toBeNull();
    expect(pro.experiments.length).toBeGreaterThan(0);
    setFree(true);
    try {
      expect(lic.getEntitlement().pro).toBe(false);
      const free = clinicStateFor(q.getClinicState(), lic.getEntitlement().pro);
      const wire = JSON.stringify(free);
      expect({ report: free.report, note: free.note, experiments: free.experiments, canStart: free.canStartExperiment }).toEqual({ report: null, note: null, experiments: [], canStart: false });
      expect(free.teaser).toEqual(pro.teaser);
      expect(free.status).toBe("fresh");
      expect(wire).not.toContain('"meanR"');
      expect(wire).not.toContain("hypothesis");
      for (const c of pro.report!.cells) expect(wire, c.key).not.toContain(`"${c.key}"`);
      const markup = html(React.createElement(ui.ClinicTab, { state: free, now: Date.now() }));
      expect(markup).toContain("data-clinic-teaser");
      expect(markup).not.toContain("data-cell-key");
      expect(markup).not.toContain("data-clinic-experiments");
    } finally {
      setFree(false);
    }
    const proMarkup = html(React.createElement(ui.ClinicTab, { state: pro, now: Date.now() }));
    for (const c of pro.report!.cells) expect(proMarkup).toContain(`data-cell-key="${c.key}"`);
    // 335-401 ms locally: the file's first ProGate render and entitlement read (the edge-clinic-db test
    // records 557 ms for the same first use); raised for the >15x slower Windows runner.
  }, 20_000);

  it("PRO: the teaser on the state equals teaser(report) of the SAME cached report", async () => {
    tpl.reset();
    for (const s of [ids.acctA, 0, EXP, MAP]) {
      select(s);
      if (s === MAP) await routeCompute.POST();
      const st = clinicStateFor(q.getClinicState(), true);
      expect(st.teaser, `scope ${s}`).toEqual(teaser(st.report!));
    }
  });
});

describe("4. the free teaser card agrees with the engine's book cell on the same ClinicTrade[]", () => {
  it.each([
    ["a book past MOMENTS_MIN_N (G2 A)", () => ids.acctA],
    ["a 25-trade book (EXP)", () => EXP],
    ["a book below minN (MAP)", () => MAP],
  ])("%s", async (_label, scopeOf) => {
    tpl.reset();
    const s = scopeOf();
    select(s);
    if (s === MAP) await routeCompute.POST();
    const free = clinicStateFor(q.getClinicState(), false);
    const ins = q.clinicInputs();
    const report = edgeClinic(ins.trades, ins.opts);
    const book = report.cells.find((c) => c.key === "all|all")!;
    expect(free.teaser!.grade).toBe(book.grade);
    expect(free.teaser!.closedTrades).toBe(report.closedTrades);
    const want = book.nWithR < report.params.minN ? report.params.minN - book.nWithR : book.tradesStillNeeded && book.tradesStillNeeded > 0 ? book.tradesStillNeeded : null;
    expect(free.teaser!.tradesStillNeeded).toBe(want);
    // B renders both: the teaser badge and the Pro grid's book row carry the same grade.
    const card = html(React.createElement(ui.ClinicTeaserCard, { teaser: free.teaser }));
    expect(card).toContain(`data-grade="${book.grade}"`);
    if (want != null) expect(card).toContain(`About ${want} more trade`);
    else expect(card).not.toContain("more trade");
    const grid = html(React.createElement(ui.CellsGrid, { report }));
    const row = grid.slice(grid.indexOf('data-cell-key="all|all"'));
    expect(row.slice(0, row.indexOf("</tr>"))).toContain(`data-grade="${book.grade}"`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Experiments end to end through the real route handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("5. experiments through the routes — start, progress, check, one unit", () => {
  const rawMean = (sql: string, ...args: unknown[]) => {
    const rs = (t.sqlite.prepare(sql).all(...args) as { r: number }[]).map((x) => x.r);
    return { n: rs.length, mean: rs.reduce((a, b) => a + b, 0) / rs.length };
  };

  it("every finding the weekly note proposes is accepted by the start route with the SAME hypothesis and targetN", async () => {
    tpl.reset();
    select(EXP);
    const note = q.getClinicState().note!;
    const proposed = note.findings.filter((f) => f.experiment);
    expect(proposed.map((f) => f.key)).toContain(SEAM_CELL);
    for (const f of proposed) {
      const r = await jsonOf(await routeExp.POST(req("POST", "/api/edge-clinic/experiments", { cellKey: f.key })));
      expect(r.status, f.key).toBe(200);
      const e = r.body.experiment as { hypothesis: string; targetN: number; cellKey: string };
      expect({ key: e.cellKey, hypothesis: e.hypothesis, targetN: e.targetN }).toEqual({ key: f.key, hypothesis: f.experiment!.hypothesis, targetN: f.experiment!.targetN });
    }
    expect(note.findings.every((f) => !f.key.startsWith("gap:") || f.experiment === null)).toBe(true);
    // Once open, the note stops proposing them.
    expect(q.getClinicState().note!.findings.filter((f) => f.experiment)).toEqual([]);
  });

  it("start → progress → check at EXPERIMENT_TARGET_N: baseline and result from the DB rows, in ONE unit, rendered by the list", async () => {
    tpl.reset();
    select(EXP);
    const start = await jsonOf(await routeExp.POST(req("POST", "/api/edge-clinic/experiments", { cellKey: SEAM_CELL })));
    expect(start.status).toBe(200);
    const e0 = start.body.experiment as { startedAt: string; progressN: number; status: string; baseline: { n: number } };
    expect(e0).toMatchObject({ startedAt: todayIst, progressN: 0, status: "open", baseline: { n: 25 } });

    // Seam D2: an experiment counts trades exiting AFTER its start day — these close the next day.
    const dayAfter = new Date(Date.parse(`${todayIst}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    capRows(EXP, "SEAM", [0.6, -0.4, 1.2, 0.8, 0.2], () => dayAfter);
    let st = q.getClinicState();
    expect(st.status).toBe("stale");
    let e = st.experiments.find((x) => x.cellKey === SEAM_CELL)!;
    expect({ n: e.progressN, status: e.status, result: e.result }).toEqual({ n: 5, status: "open", result: null });

    capRows(EXP, "SEAM", Array.from({ length: EXPERIMENT_TARGET_N - 5 }, (_, i) => SEAM_R[(i + 3) % SEAM_R.length]), () => dayAfter);
    expect((await jsonOf(await routeCompute.POST())).body).toMatchObject({ ok: true, status: "computed", scopeKey: `acct:${EXP}` });
    st = q.getClinicState();
    expect(st.status).toBe("fresh");
    e = st.experiments.find((x) => x.cellKey === SEAM_CELL)!;
    expect(e.status).toBe("checked");
    const stored = t.sqlite.prepare("SELECT status FROM clinic_experiments WHERE account_id = ? AND cell_key = ?").get(EXP, SEAM_CELL) as { status: string };
    expect(stored.status).toBe("checked");

    const base = rawMean("SELECT r_multiple AS r FROM trades WHERE account_id = ? AND setup_tag = 'SEAM' AND sell_date <= ? ORDER BY id", EXP, e.startedAt);
    const res = rawMean("SELECT r_multiple AS r FROM trades WHERE account_id = ? AND setup_tag = 'SEAM' AND sell_date > ? ORDER BY sell_date, id LIMIT ?", EXP, e.startedAt, EXPERIMENT_TARGET_N);
    expect(e.baseline!.n).toBe(base.n);
    expect(e.baseline!.meanR!).toBeCloseTo(base.mean, 9);
    expect(e.result!.n).toBe(EXPERIMENT_TARGET_N);
    expect(e.result!.meanR!).toBeCloseTo(res.mean, 9);
    // ONE unit: every R on both sides is a default-cap R, and the cell the report graded says so.
    expect(e.baseline!.provenanceLine).toBe(`0 plan-derived · 0 typed · ${base.n} default-cap · 0 no R`);
    expect(e.result!.provenanceLine).toBe(`0 plan-derived · 0 typed · ${EXPERIMENT_TARGET_N} default-cap · 0 no R`);
    expect(st.report!.cells.find((c) => c.key === SEAM_CELL)!.rUnit).toBe("cap");

    const list = html(React.createElement(ui.ExperimentsList, { experiments: st.experiments, canStartExperiment: st.canStartExperiment }));
    const fmt = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
    expect(list).toContain(`${EXPERIMENT_TARGET_N} / ${EXPERIMENT_TARGET_N} trades`);
    expect(list).toContain(`mean ${fmt(base.mean)} R`);
    expect(list).toContain(`mean ${fmt(res.mean)} R`);

    // A per-trade cap edit (the risk editor's own save) re-prices BOTH sides together.
    await OPS.find((o) => o.name === "editPerTradeCap")!.run(t.db, freshCtx(t, m, ids));
    select(EXP);
    const after = q.getClinicState().experiments.find((x) => x.cellKey === SEAM_CELL)!;
    const base2 = rawMean("SELECT r_multiple AS r FROM trades WHERE account_id = ? AND setup_tag = 'SEAM' AND sell_date <= ? ORDER BY id", EXP, e.startedAt);
    const res2 = rawMean("SELECT r_multiple AS r FROM trades WHERE account_id = ? AND setup_tag = 'SEAM' AND sell_date > ? ORDER BY sell_date, id LIMIT ?", EXP, e.startedAt, EXPERIMENT_TARGET_N);
    expect(base2.mean).not.toBeCloseTo(base.mean, 3); // the edit really moved the unit
    expect(after.baseline!.meanR!).toBeCloseTo(base2.mean, 9);
    expect(after.result!.meanR!).toBeCloseTo(res2.mean, 9);
  });

  it("the All view (0) is refused 400 and writes nothing; a Pro-only route is 403 for a free copy", async () => {
    tpl.reset();
    select(0);
    const before = t.db.select().from(t.schema.clinicExperiments).all().length;
    const r = await jsonOf(await routeExp.POST(req("POST", "/api/edge-clinic/experiments", { cellKey: SEAM_CELL })));
    expect(r.status).toBe(400);
    expect(q.getClinicState().canStartExperiment).toBe(false);
    expect(t.db.select().from(t.schema.clinicExperiments).all()).toHaveLength(before);
    select(EXP);
    setFree(true);
    try {
      expect((await routeExp.POST(req("POST", "/api/edge-clinic/experiments", { cellKey: SEAM_CELL }))).status).toBe(403);
    } finally {
      setFree(false);
    }
  });

  it("the cell route: the trade's cell from the cached report inside the scope; null for a trade of another account", async () => {
    tpl.reset();
    select(EXP);
    const own = t.db.select().from(t.schema.trades).all().find((r) => r.accountId === EXP)!;
    const other = t.db.select().from(t.schema.trades).all().find((r) => r.accountId === ids.acctA && r.setupTag === "g2-clinic")!;
    const get = async (id: number) => (await jsonOf(await routeCell.GET(req("GET", `/api/edge-clinic/cell?tradeId=${id}`)))).body.line as Record<string, unknown> | null;
    const cell = q.getClinicState().report!.cells.find((c) => c.key === SEAM_CELL)!;
    expect(await get(own.id)).toMatchObject({ key: SEAM_CELL, grade: cell.grade, nWithR: cell.nWithR, headline: cell.copy.headline });
    expect(await get(other.id)).toBeNull();
    select(0); // the All view holds both, from ITS OWN cached report
    const all = q.getClinicState().report!.cells.find((c) => c.key === CLINIC_CELL)!;
    expect(await get(other.id)).toMatchObject({ key: CLINIC_CELL, nWithR: all.nWithR });
  });

  it("IST boundary: started at 01:30 IST (20:00 UTC the day before) — startedAt is the IST day; a trade that exited the UTC day is baseline", async () => {
    tpl.reset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T20:00:00.000Z"));
    try {
      const ist = (await import("@/lib/domain/trading-day")).todayIstIso();
      expect(ist).toBe("2026-10-06");
      capRows(EXP, "SEAM", [0.8], () => "2026-10-05");
      select(EXP);
      await routeCompute.POST();
      const r = await jsonOf(await routeExp.POST(req("POST", "/api/edge-clinic/experiments", { cellKey: SEAM_CELL })));
      expect(r.status).toBe(200);
      expect(r.body.experiment).toMatchObject({ startedAt: "2026-10-06", progressN: 0, baseline: { n: 26 } });
    } finally {
      vi.useRealTimers();
    }
  });

  // FINDING D2 (seam: edge-clinic-note.ts proposalFor N = cell.nWithR vs checkExperiment `d < startedAt`,
  // edge-clinic-note.ts:213). The SAMEDAY cell holds 22 trades before today and 3 that exited EARLIER TODAY —
  // all 25 are in the report the user reads and starts the experiment from ("as the 25 before them did"). On
  // HEAD the experiment starts with progressN 3 and a 22-trade baseline: three already-seen trades are counted
  // as pre-registered experiment trades, and the hypothesis's N disagrees with the Before line under it.
  it("FINDING D2 (fixed): an experiment started today does not count the cell's trades that already exited today", async () => {
    tpl.reset();
    select(SAME);
    await routeCompute.POST();
    const cell = q.getClinicState().report!.cells.find((c) => c.key === SAME_CELL)!;
    expect(cell.nWithR).toBe(25);
    const r = await jsonOf(await routeExp.POST(req("POST", "/api/edge-clinic/experiments", { cellKey: SAME_CELL })));
    expect(r.status).toBe(200);
    const e = r.body.experiment as { progressN: number; baseline: { n: number }; hypothesis: string };
    expect(e.hypothesis).toContain(`as the ${cell.nWithR} before them did`);
    expect({ progressN: e.progressN, baselineN: e.baseline.n }).toEqual({ progressN: 0, baselineN: cell.nWithR });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The typed intra-trade range reaches BOTH MAE/MFE readers
// ─────────────────────────────────────────────────────────────────────────────

describe("6. maeInputsOf — Setups (getTrades) and Arjun's Eye (getArjunTrades) build the same input from the DB row", () => {
  it("long and short rows with typed H/L: same MaeTradeInput, source 'typed', no bars needed", () => {
    tpl.reset();
    select(MAP);
    const setups = maeInputsOf(tq.getTrades(), (s) => s);
    const arjun = maeInputsOf(tq.getArjunTrades(), (s) => s);
    for (const k of ["typedLong", "typedShort"] as const) {
      const a = setups.find((x) => x.id === mapIds[k])!;
      const b = arjun.find((x) => x.id === mapIds[k])!;
      expect(b, k).toEqual(a);
    }
    const long = setups.find((x) => x.id === mapIds.typedLong)!;
    const short = setups.find((x) => x.id === mapIds.typedShort)!;
    expect([long.intraHigh, long.intraLow, long.side, long.entry, long.exit]).toEqual([108.5, 97.25, "long", 100, 106]);
    expect([short.intraHigh, short.intraLow, short.side, short.entry, short.exit]).toEqual([112, 95, "short", 110, 100]);
    const viaSetups = computeMaeMfe(setups.filter((x) => x.id === mapIds.typedLong || x.id === mapIds.typedShort), new Map());
    const viaArjun = computeMaeMfe(arjun.filter((x) => x.id === mapIds.typedLong || x.id === mapIds.typedShort), new Map());
    expect(viaArjun.rows).toEqual(viaSetups.rows);
    expect(viaSetups.rows.map((r) => r.source)).toEqual(["typed", "typed"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Recorded seam defects — fixed in the C2 commit; flipped from it.fails to `it` (LEDGER F-51)
// ─────────────────────────────────────────────────────────────────────────────

describe("recorded seam defects", () => {
  // FINDING D1 (writer app/api/trades/journal/route.ts:61 stores NULL for "no broken rule"; reader
  // lib/analytics/edge-clinic.ts:856 takes NULL as "no rule data"; lib/queries/trades.ts:185 CLINIC_FIELDS
  // carries no playbookId to tell them apart). A trade journaled against a playbook with every rule kept
  // never enters the "kept every rule" arm, so that arm holds only rows with a NON-playbook limit breach.
  it("FINDING D1 (fixed): a trade journaled against a playbook with every rule kept counts as rule data", async () => {
    tpl.reset();
    select(MAP);
    const res = await routeJournal.POST(req("POST", "/api/trades/journal", { id: mapIds.option, playbookId, brokenRules: [] }));
    expect(res.status).toBe(200);
    const book = edgeClinic(tq.getClinicTrades(), { today: todayIst }).cells.find((c) => c.key === "all|all")!;
    // Before the save: MAPA + MAPC carry rule data (2 of 4). The journaled option is the third.
    expect(book.ruleAdherence.coverage).toEqual({ withData: 3, of: 4 });
  });

  // FINDING D3 (components/edge-clinic/arjun-clinic-card.tsx:30 reads `state.report` to decide the Clinic
  // "has not read this book"; clinicStateFor nulls `report` for every FREE copy). A free user whose book the
  // Clinic HAS read (status fresh, teaser present) is told it has not.
  it("FINDING D3 (fixed): a free copy's Arjun's Eye card does not claim the Clinic has not read a book it has read", () => {
    tpl.reset();
    select(ids.acctA);
    const free = clinicStateFor(q.getClinicState(), false) as ClinicState;
    expect(free.status).toBe("fresh");
    expect(free.teaser).not.toBeNull();
    expect(html(React.createElement(ui.ArjunClinicCard, { state: free }))).not.toContain("has not read this book");
  });
});


