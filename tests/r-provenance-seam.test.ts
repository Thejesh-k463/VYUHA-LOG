import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// PURE (no DB, no React) — safe to import statically beside openTempDb.
import { computeKpis } from "@/lib/analytics/metrics";
import { rProvenance, rProvenanceFromKpis, rProvenanceLine } from "@/lib/analytics/win-loss";
import { toLensRow } from "@/lib/domain/lens-edge";

/**
 * v4.4.0 D2 — R PROVENANCE ACROSS THE SEAM.
 *
 * The defect this file exists for: provenance was TWO-way, so a risk the user
 * TYPED (risk_source 'set', no stop recorded) was labelled "default-cap" beside
 * an imported row that really is priced in cap units. The book below is exactly
 * the review's counter-example — typed rows plus imported cap rows — and the
 * guard is the one thing the old labelling could never satisfy:
 *
 *   after a per-trade cap edit, the number of rows whose r_multiple MOVED
 *   equals `rCapCount` — on the dashboard projection, on the /lenses wire and
 *   on the share card's own stats — never `defaultCapCount`.
 *
 * ONE temp database for the whole file (AGENTS.md Testing).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

let t: TempDb;
let q: typeof import("@/lib/queries/trades");
let riskCap: typeof import("@/lib/queries/risk-cap");
let acct: number;

const CAP = 10_000;
const NEW_CAP = 5_000;

// Measured locally 2026-09-21: migrate + seed + the two query imports ~1.4 s.
beforeAll(async () => {
  t = await openTempDb("r-provenance-seam", { seed: true });
  q = await import("@/lib/queries/trades");
  riskCap = await import("@/lib/queries/risk-cap");
  acct = t.db.select().from(t.schema.accounts).all()[0]!.id;
  t.db.update(t.schema.settings).set({ selectedAccountId: acct }).run();
  t.sqlite.prepare("UPDATE risk_config SET per_trade_max_loss = NULL, cap_scheme = 1 WHERE scope <> 'global'").run();
  t.sqlite.prepare("UPDATE risk_config SET per_trade_max_loss = ?, cap_scheme = 1 WHERE scope = 'global'").run(CAP);

  const rows: Record<string, unknown>[] = [];
  // 3 PLAN rows: risk ties to the recorded stop (|100 − 90| × 10 = 100).
  for (let i = 0; i < 3; i++) {
    rows.push(tradeRow({
      accountId: acct, isOpen: false, sellDate: "2026-03-0" + (i + 1),
      buyQty: 10, sellQty: 10, avgBuyPrice: 100, avgSellPrice: 110,
      slPlanned: 90, riskAmount: 100, riskSource: "set", rMultiple: 1,
      netPnl: 100, grossPnl: 100, chargesTotal: 0, buyValue: 1000, sellValue: 1100,
    }));
  }
  // 2 TYPED rows: a risk the user set that ties to NO stop. The old two-way
  // labelling called these "default-cap"; they do not move when the cap moves.
  for (let i = 0; i < 2; i++) {
    rows.push(tradeRow({
      accountId: acct, isOpen: false, sellDate: "2026-03-1" + i,
      buyQty: 10, sellQty: 10, avgBuyPrice: 100, avgSellPrice: 90,
      riskAmount: 4000, riskSource: "set", rMultiple: -0.025,
      netPnl: -100, grossPnl: -100, chargesTotal: 0, buyValue: 1000, sellValue: 900,
    }));
  }
  // 4 CAP rows: the import default. These are the ONLY ones a cap edit re-prices.
  for (let i = 0; i < 4; i++) {
    rows.push(tradeRow({
      accountId: acct, isOpen: false, sellDate: "2026-03-2" + i,
      buyQty: 10, sellQty: 10, avgBuyPrice: 100, avgSellPrice: 120,
      riskAmount: CAP, riskSource: "cap", rMultiple: 0.02,
      netPnl: 200, grossPnl: 200, chargesTotal: 0, buyValue: 1000, sellValue: 1200,
    }));
  }
  // 1 NO-R row, closed and priced: in neither series, counted as "no R".
  rows.push(tradeRow({
    accountId: acct, isOpen: false, sellDate: "2026-03-28",
    buyQty: 10, sellQty: 10, avgBuyPrice: 100, avgSellPrice: 101,
    riskAmount: null, riskSource: null, rMultiple: null,
    netPnl: 10, grossPnl: 10, chargesTotal: 0, buyValue: 1000, sellValue: 1010,
  }));
  t.db.insert(t.schema.trades).values(rows as never).run();
}, 60_000);
afterAll(() => t?.cleanup());

const dashKpis = () => computeKpis(q.getDashboardTrades() as never);

describe("the three-way verdict", () => {
  it("'cap' beats hasPlanR, a stop-tied risk is 'plan', everything else is 'typed'", () => {
    // A cap row that HAPPENS to tie to a stop is still a cap row — the cap is
    // what moves it, and that is the claim the label makes.
    expect(rProvenance({ riskSource: "cap", slPlanned: 90, avgBuyPrice: 100, qty: 10, riskAmount: 100 })).toBe("cap");
    expect(rProvenance({ riskSource: "set", slPlanned: 90, avgBuyPrice: 100, qty: 10, riskAmount: 100 })).toBe("plan");
    expect(rProvenance({ riskSource: "set", riskAmount: 4000, qty: 10, avgBuyPrice: 100 })).toBe("typed");
    expect(rProvenance({ riskSource: "frozen", riskAmount: 4000, qty: 10, avgBuyPrice: 100 })).toBe("typed");
    // No flags at all: UNKNOWN, never silently 'typed'.
    expect(rProvenance({ rMultiple: 1 } as never)).toBeNull();
  });

  it("the dashboard projection counts the book three ways and the line says so", () => {
    const k = dashKpis();
    expect(k.rCount).toBe(9);
    expect(k.rPlanCount).toBe(3);
    expect(k.rCapCount).toBe(4);
    const line = rProvenanceLine(rProvenanceFromKpis(k));
    expect(line).toBe("3 plan-derived · 2 typed · 4 default-cap · 1 no R");
    // The old two-way wording would have read "3 plan-derived · 6 default-cap".
    expect(line).not.toContain("6 default-cap");
  });

  it("a projection that ships no flag reads null, not 0 — it never under-claims cap R", () => {
    const k = computeKpis([
      { broker: "d", bucket: "equity", segment: "eq_delivery", netPnl: 1, grossPnl: 1, chargesTotal: 0,
        rMultiple: 1, isOpen: false, sellDate: "2026-01-01", buyDate: null, setupTag: null,
        acquisition: null, acquisitionPrice: null, buyValue: 10 },
    ]);
    expect(k.rCount).toBe(1);
    expect(k.rPlanCount).toBeNull();
    expect(k.rCapCount).toBeNull();
    expect(rProvenanceFromKpis(k)).toMatchObject({ unknown: 1, cap: 0, plan: 0 });
  });

  it("/lenses ships the three counts on the PRO side only", () => {
    const k = dashKpis();
    const pro = toLensRow(k, true);
    expect(pro.edge).toMatchObject({ rCount: 9, rPlanCount: 3, rCapCount: 4 });
    const free = JSON.stringify(toLensRow(k, false));
    for (const key of ["rCount", "rPlanCount", "rCapCount"]) expect(free).not.toContain(key);
  });
});

describe("the source guard — no Avg R is printed without its provenance", () => {
  /** Every file under app/ or components/ that renders an Avg R must print the
   *  ONE wording helper beside it. A new surface is a new entry here, on purpose. */
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };

  it("every avgR renderer renders rProvenanceLine", () => {
    const root = path.resolve(__dirname, "..");
    const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "components"))];
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      if (!/\bavgR\b/.test(src)) continue;
      // THE ONE EXCEPTION: the share card's canvas renders `value.sub`, which
      // `buildShareCard` fills from `ShareStats.avgRSplit` — and that string is
      // produced by `rProvenanceLine` in app/reports/performance/page.tsx (pinned
      // below). The renderer never sees a Kpis to ask itself.
      if (f.endsWith(path.join("components", "reports", "share-card.tsx"))) {
        expect(src, "share card must still render the caveat sub-line").toMatch(/r\.sub/);
        continue;
      }
      if (!/rProvenanceLine/.test(src)) offenders.push(path.relative(root, f));
    }
    expect(offenders, `these print an Avg R with no provenance line: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the share card's split is built by the same helper, and travels into the PNG", () => {
    const root = path.resolve(__dirname, "..");
    expect(fs.readFileSync(path.join(root, "lib/analytics/share-card.ts"), "utf8")).toMatch(/avgRSplit/);
    expect(fs.readFileSync(path.join(root, "app/reports/performance/page.tsx"), "utf8"))
      .toMatch(/avgRSplit:\s*rProvenanceLine\(/);
    // ctx.fillText of the sub-line = it is in the exported image, not just the DOM preview.
    expect(fs.readFileSync(path.join(root, "components/reports/share-card.tsx"), "utf8"))
      .toMatch(/ctx\.fillText\(r\.sub/);
  });
});

describe("the cap-edit seam", () => {
  it("rows whose r_multiple moves after a cap edit = rCapCount, on every surface", () => {
    const before = dashKpis();
    const lensBefore = toLensRow(computeKpis(q.getLensTrades() as never), true);
    const capCount = before.rCapCount!;
    expect(capCount).toBe(4);
    expect(lensBefore.edge!.rCapCount).toBe(capCount);

    const rBefore = new Map(
      (t.sqlite.prepare("SELECT id, r_multiple AS r FROM trades").all() as { id: number; r: number | null }[])
        .map((r) => [r.id, r.r]),
    );
    const ids = [...rBefore.keys()];
    t.sqlite.prepare("UPDATE risk_config SET per_trade_max_loss = ? WHERE scope = 'global'").run(NEW_CAP);
    riskCap.repriceCapTrades(t.sqlite, { ids });

    const moved = (t.sqlite.prepare("SELECT id, r_multiple AS r FROM trades").all() as { id: number; r: number | null }[])
      .filter((r) => r.r !== rBefore.get(r.id)).length;
    expect(moved).toBe(capCount);

    // …and the surfaces still agree after the edit (the caches are per-request).
    // @ts-expect-error — react `cache` memoises per render; the test drains it.
    q.getDashboardTrades.clear?.();
    const after = dashKpis();
    expect(after.rCapCount).toBe(capCount);
    expect(after.rPlanCount).toBe(3);
  });
});
