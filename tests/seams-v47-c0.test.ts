import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  loadOracleConsumers, seedOracleBook, selectOracleAccount,
  ORACLE_A1, ORACLE_A2, ORACLE_A3, ORACLE_FY, ORACLE_PERSON_1, ORACLE_PERSON_2,
  type OracleBook,
} from "./helpers/oracle-book";
import { aggregateTradesByFy, type FyGrossGains } from "@/lib/analytics/capital-gains";
import { itrPackByFy, type ItrFyPack } from "@/lib/analytics/itr";
import { currentFy } from "@/lib/analytics/tax";

/**
 * SEAM v4.7.0 C0 — /reports/itr carries exited IPO allotments EXACTLY as the
 * tax pack does (owner ruling 2026-10-01; design review 2026-10-01).
 *
 * The two halves of the seam, both run for real here:
 *
 *   - lib/queries/tax-itr.ts — `getTaxBase().cgTrades` (what /reports/tax, the
 *     ITR export and the set-off engine read) and the new `getItrPageInputs()`,
 *     which hands the SAME base's realised rows and exited-IPO rows to the pure
 *     `itrPageInputs` (lib/analytics/itr.ts). The IPO capital-gains row is built
 *     by ONE function, `ipoCgTrade`, on both sides.
 *   - app/reports/itr/page.tsx — the page itself is CALLED, and its two export
 *     tables (the head-wise pack and the Schedule CG lines) are read out of the
 *     element tree it returns: the figures the user downloads, not a re-typed
 *     copy of the page's arithmetic.
 *
 * Before this wave the page read `getTrades` → `getRealisedRows` →
 * `itrPageInputs(realised)` and never read `ipos`, so an exited allotment that
 * no holding carries (ORACLE-LOOSE) was on the tax pack and missing from the
 * ITR pack: person 1's CG was 6829.42 there against 6829.42 + ORACLE-LOOSE's
 * net on /reports/tax. The obvious fold — every realised IPO — would instead
 * DOUBLE-count the two records whose holding is already a counted trade
 * (A2IPOH's linked record, ORACLE-LEGACY through A2SOLD); the correct set is the
 * one the tax base already computes (`ipoIdsCountedThroughTrades`).
 *
 * Local timing budget: one temp database for the file (AGENTS.md Testing), the
 * book seeded once per describe; each `it` reads, never writes.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
  redirect: () => {},
}));

const r2 = (n: number) => Math.round(n * 100) / 100;
const FSM = 4;
const CFY = currentFy(FSM);

let t: TempDb;
let book: OracleBook;
let taxItr: typeof import("@/lib/queries/tax-itr");
let itrPage: (p: { searchParams: Promise<{ person?: string }> }) => Promise<unknown>;

// Measured locally 2026-10-01 (--reporter=verbose): the slowest `it` is 52 ms,
// the ten sum to ~0.3 s; the file's "tests" time is 3.4 s, so this hook (migrate,
// eleven consumer imports, the page module, the seeded book) is ~3.1 s. The
// raised timeout is for the Windows runner, > 15x slower on SQLite-file work.
beforeAll(async () => {
  t = await openTempDb("seams-v47-c0", { seed: true });
  await loadOracleConsumers();
  taxItr = await import("@/lib/queries/tax-itr");
  itrPage = (await import("@/app/reports/itr/page")).default as typeof itrPage;
  book = await seedOracleBook(t);
}, 120_000);
afterAll(() => t?.cleanup());

// ── reading both halves ─────────────────────────────────────────────────────

type CgBuckets = { stcg111A: number; stcgOther: number; ltcg112A: number; ltcg112: number; cgUndetermined: number };
const ZERO: CgBuckets = { stcg111A: 0, stcgOther: 0, ltcg112A: 0, ltcg112: 0, cgUndetermined: 0 };
const pick = (b: CgBuckets): CgBuckets => ({
  stcg111A: b.stcg111A, stcgOther: b.stcgOther, ltcg112A: b.ltcg112A, ltcg112: b.ltcg112, cgUndetermined: b.cgUndetermined,
});
/** Per FY, the five capital-gains heads the set-off engine buckets (/reports/tax). */
const byFyBuckets = (rows: FyGrossGains[]) => Object.fromEntries(rows.map((f) => [f.fy, pick(f)]));
/** The same five heads as the ITR pack states them, FYs with no CG row dropped. */
const packBuckets = (packs: ItrFyPack[]) =>
  Object.fromEntries(packs.filter((p) => p.capitalGains.trades > 0).map((p) => [p.fy, pick(p.capitalGains)]));

type Elem = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const isElem = (n: unknown): n is Elem => !!n && typeof n === "object" && "type" in n && "props" in n;
function findElem(node: unknown, want: (e: Elem) => boolean): Elem | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findElem(n, want);
      if (hit) return hit;
    }
    return null;
  }
  if (!isElem(node)) return null;
  if (want(node)) return node;
  return findElem(node.props.children, want);
}
/** The rows an `<ExportButtons filename=…>` on the page would download; [] when absent. */
const exportRows = (tree: unknown, filename: string) =>
  ((findElem(tree, (e) => e.props.filename === filename)?.props.rows ?? []) as Record<string, unknown>[]);

/** The ITR pack's export, re-read as the five CG heads per FY (app/reports/itr/page.tsx EXPORT rows). */
const PACK_HEADS: Record<string, keyof CgBuckets> = {
  "Capital gains — STCG (s.111A)": "stcg111A",
  "Capital gains — STCG at slab / s.50AA deemed": "stcgOther",
  "Capital gains — LTCG (s.112A)": "ltcg112A",
  "Capital gains — LTCG (s.112, non-equity unit)": "ltcg112",
  "Capital gains — head undetermined": "cgUndetermined",
};
function pagePackBuckets(rows: Record<string, unknown>[]): Record<string, CgBuckets> {
  const out: Record<string, CgBuckets> = {};
  const cgTrades: Record<string, number> = {};
  for (const r of rows) {
    const key = PACK_HEADS[r.head as string];
    if (!key) continue;
    const fy = r.fy as string;
    out[fy] ??= { ...ZERO };
    out[fy][key] = r.net as number;
    if (key === "stcg111A") cgTrades[fy] = r.trades as number;
  }
  // An FY the pack lists only for its business heads carries no CG row.
  return Object.fromEntries(Object.entries(out).filter(([fy]) => (cgTrades[fy] ?? 0) > 0));
}

/** Schedule CG's balance lines (c) summed per FY, as the page's schedule export states them. */
function scheduleCgByFy(rows: Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.schedule !== "Schedule CG") continue;
    const label = r.label as string;
    if (!label.startsWith("Balance (a − b)") && label !== "Capital gain before exemption") continue;
    out[r.fy as string] = r2((out[r.fy as string] ?? 0) + (r.amount === "" ? NaN : (r.amount as number)));
  }
  return out;
}

function fyOfSold(sold: string): string {
  if (!sold) return CFY;
  const d = new Date(sold + "T00:00:00");
  const start = d.getMonth() + 1 >= FSM ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
/**
 * getItrExportRows' capital-gains `taxableGain`, summed per FY (the export files
 * by the sale). A row with no TERM is either a business head or a head this
 * journal cannot determine — neither is written into a Schedule CG box (the
 * latter is STATED there with a blank amount, invariant 6), so neither is summed.
 */
function exportCgByFy(person: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of taxItr.getItrExportRows(person)) {
    if (r.term === "") continue;
    const fy = fyOfSold(r.sold);
    out[fy] = r2((out[fy] ?? 0) + r.taxableGain);
  }
  return out;
}

const sumBuckets = (m: Record<string, CgBuckets>) =>
  r2(Object.values(m).reduce((s, b) => s + b.stcg111A + b.stcgOther + b.ltcg112A + b.ltcg112 + b.cgUndetermined, 0));

/**
 * Every identity, in one view: the page's inputs ARE the tax base's, and the
 * two exports the page renders state what /reports/tax and the ITR export state.
 * Returns the tax side's per-FY buckets for the caller's own literal pins.
 */
async function assertSeam(where: string, accountId: number, person: string | undefined) {
  selectOracleAccount(t, accountId);
  const base = taxItr.getTaxBase(person);
  const inputs = taxItr.getItrPageInputs(person);

  // 1. ONE set, ONE mapping, ONE order — the IPO rows included.
  expect(inputs.capitalGains, `${where}: /reports/itr's capital-gains rows ARE the tax base's cgTrades (ipoCgTrade on both sides)`)
    .toEqual(base.cgTrades);

  // 2. The set-off engine over each, per FY.
  const tax = byFyBuckets(aggregateTradesByFy(base.cgTrades, FSM, CFY));
  expect(byFyBuckets(aggregateTradesByFy(inputs.capitalGains, FSM, CFY)), `${where}: aggregateTradesByFy agrees on both inputs`)
    .toEqual(tax);

  // 3. The head-wise pack over the page's pack rows.
  expect(packBuckets(itrPackByFy(inputs.pack, FSM, CFY)), `${where}: itrPackByFy's CG heads = the set-off engine's`)
    .toEqual(tax);

  // 4. THE PAGE — its own render, its own export rows.
  const tree = await itrPage({ searchParams: Promise.resolve(person ? { person } : {}) });
  expect(pagePackBuckets(exportRows(tree, "vyuha-itr-pack")),
    `${where}: app/reports/itr/page.tsx's pack export states /reports/tax's CG heads (exited IPOs included)`)
    .toEqual(tax);

  // 5. Schedule CG's balances = the ITR export's taxable gains, per FY.
  expect(scheduleCgByFy(exportRows(tree, "vyuha-itr-schedules")),
    `${where}: the page's Schedule CG balances = getItrExportRows' taxableGain per FY`)
    .toEqual(exportCgByFy(person));

  return { tax, base };
}

// ============================================================================

describe("C0 · /reports/itr carries exited IPOs exactly as the tax pack does (the oracle book)", () => {
  // P1 = accounts 1 + 2; P2 = account 3; All over two persons = no figure.
  const P1 = () => r2(6829.42 + book.ipoNet.loose);
  it.each([
    ["account 1", ORACLE_A1, undefined, "p1"],
    ["account 2", ORACLE_A2, undefined, "p1"],
    ["account 3", ORACLE_A3, undefined, "p2"],
    ["All accounts", 0, undefined, "none"],
    ["All · ?person=P1", 0, ORACLE_PERSON_1, "p1"],
    ["All · ?person=P2", 0, ORACLE_PERSON_2, "p2"],
    ["account 1 · ?person=P2", ORACLE_A1, ORACLE_PERSON_2, "p2"],
  ] as const)("%s", async (where, accountId, person, who) => {
    const { tax, base } = await assertSeam(where, accountId, person);
    if (who === "p1") {
      // The literal anchor, independent of either consumer: P1's trades (6829.42,
      // tests/helpers/oracle-book.ts) + ORACLE-LOOSE — and ONLY ORACLE-LOOSE: the
      // linked and legacy records' sales are counted through their holdings.
      expect(base.exitedIpos.map((r) => r.name), `${where}: the one IPO not counted through a holding`).toEqual(["ORACLE-LOOSE"]);
      expect(sumBuckets(tax), `${where}: P1's CG = trades 6829.42 + ORACLE-LOOSE ${book.ipoNet.loose}`).toBe(P1());
      expect(Object.keys(tax), `${where}: one FY`).toEqual([ORACLE_FY]);
    } else if (who === "p2") {
      expect(tax, `${where}: P2 is account 3's one sale`).toEqual({ [ORACLE_FY]: { ...ZERO, stcg111A: 990 } });
    } else {
      expect(tax, `${where}: two persons, no figure`).toEqual({});
    }
  });
});

describe("C0 · the three IPO shapes the oracle book does not hold", () => {
  const LATER_ALLOT = "2024-05-10"; // FY 2024-25
  const LATER_EXIT = "2025-11-05"; //  FY 2025-26, 18 months on → LTCG 112A
  let undated: number;
  let held: number;
  let later: number;

  beforeAll(() => {
    const ipo = (name: string, over: Record<string, unknown>) =>
      t.db.insert(t.schema.ipos).values({
        accountId: ORACLE_A2, name, broker: "zerodha", exchange: "NSE",
        appliedPrice: 40, lotSize: 25, lotsApplied: 1, allotted: true, allottedQty: 25,
        appliedDate: "2025-05-01", allotmentDate: "2025-05-05", listingDate: "2025-05-08", listingPrice: 44,
        tradeId: null, ...over,
      }).returning({ id: t.schema.ipos.id }).get()!.id;
    // An exit with NO date: the tax base files it in today's FY (its fallback),
    // under NO head — with no transfer date the holding period is unknowable, so
    // it is `cgUndetermined` and Schedule CG states it without a box.
    undated = ipo("C0-UNDATED", { exitPrice: 52, exitDate: null });
    // Listed, never sold: realises nothing on either surface.
    held = ipo("C0-HELD", { exitPrice: null, exitDate: null });
    // Allotted in one FY, sold in the next: the SALE's year files it, as LTCG.
    later = ipo("C0-LATER", {
      appliedPrice: 60, lotSize: 10, allottedQty: 10, appliedDate: "2024-05-01", allotmentDate: LATER_ALLOT,
      listingDate: "2024-05-14", listingPrice: 66, exitPrice: 90, exitDate: LATER_EXIT,
    });
  });

  it("the tax base folds the undated and the later-FY exit in, and not the held allotment", () => {
    selectOracleAccount(t, ORACLE_A2);
    const names = taxItr.getTaxBase().exitedIpos.map((r) => r.name).sort();
    expect(names).toEqual(["C0-LATER", "C0-UNDATED", "ORACLE-LOOSE"]);
    expect([undated, held, later].every((id) => id > 0)).toBe(true);
  });

  it.each([
    ["account 2", ORACLE_A2, undefined],
    ["All · ?person=P1", 0, ORACLE_PERSON_1],
  ] as const)("%s: every identity holds with the three shapes in the book", async (where, accountId, person) => {
    const { tax, base } = await assertSeam(where, accountId, person);
    const net = (name: string) => r2(base.exitedIpos.find((r) => r.name === name)!.netPnl);
    // Undated → today's FY on BOTH surfaces (the page passes deriveCurrentFy, as
    // /reports/tax does), head undetermined; the page's schedule STATES it there.
    expect(tax[CFY], `${where}: the undated exit files in ${CFY}, head undetermined`).toEqual({ ...ZERO, cgUndetermined: net("C0-UNDATED") });
    const tree = await itrPage({ searchParams: Promise.resolve(person ? { person } : {}) });
    const stated = exportRows(tree, "vyuha-itr-schedules")
      .filter((r) => r.fy === CFY && r.schedule === "Schedule CG" && String(r.label).includes("cannot determine"));
    expect(stated.map((r) => [r.label, r.amount]), `${where}: Schedule CG states the undated exit in ${CFY}, in no box`)
      .toEqual([["1 realised trade(s) whose capital-gains head this journal cannot determine", ""]]);
    // Later FY → the exit's FY, never the allotment's, as a 112A long-term gain.
    expect(tax["2024-25"], `${where}: nothing files in the allotment's FY`).toBeUndefined();
    expect(tax[ORACLE_FY].ltcg112A, `${where}: the later exit is LTCG 112A in ${ORACLE_FY}`).toBe(net("C0-LATER"));
    expect(tax[ORACLE_FY].stcg111A, `${where}: the oracle's short-term book is unchanged`).toBe(r2(6829.42 + book.ipoNet.loose));
    // Held → absent from both.
    expect(base.exitedIpos.some((r) => r.name === "C0-HELD"), `${where}: a held allotment realises nothing`).toBe(false);
    expect(taxItr.getItrPageInputs(person).capitalGains.length, `${where}: nor does the page count it`).toBe(base.cgTrades.length);
  });
});
