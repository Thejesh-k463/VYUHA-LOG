import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import {
  computeIpo,
  ipoChargeHeads,
  isPriceableExitDate,
  ISSUER_BEARS_ISSUE_STAMP_FROM,
  type IpoComputed,
  type IpoInput,
} from "@/lib/analytics/ipo";
import { ratesMapOf, seedRatesMap } from "@/lib/engine/rates";
import type { ChargeRates } from "@/lib/engine/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
// The IPO route revalidates pages after a write; there is no Next runtime here.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * v4.3.0 fix-wave-2R (R2-RATES) — the IPO charger and its dates.
 *
 *  N13  the charger threw for an exit date before 1970-01-01 ('0002-06-15', a
 *       Chromium date input's intermediate year) or a non-ISO one ('15-03-2011'),
 *       and threw EAGERLY while building the charger for every IPO row, exited
 *       or not — one such stored row took down /ipos, /settings and the tax pack.
 *       Now: rates resolve lazily, only for an exited IPO; a date that is not a
 *       real day in range is NOT YET PRICED (no charges, "—"); a real day before
 *       the earliest charge_config epoch prices at the earliest schedule.
 *  N14  the allottee was charged stamp duty on the allotment. From 1 Jul 2020 the
 *       issuer bears it (Indian Stamp Act s.9A(1)(c), s.29(l), Sch. I Art. 56A;
 *       Act 7 of 2019) — primary sources under
 *       LIVE-DESK-RESEARCH/_data/stt-primary-sources-2026-09-11/ (MANIFEST).
 *  N15  the statement label named DP where none is charged; the form preview
 *       omits the broker's charges and now says so.
 */

let t: TempDb;
let q: typeof import("@/lib/queries/ipos");
let ui: typeof import("@/components/ipo/ipo-client");
let Dialog: typeof import("@/components/ui/dialog").Dialog;

// ONE temp database for this file (AGENTS.md Testing). Migrate + seed + imports
// measured well inside the 3 s hook budget locally.
beforeAll(async () => {
  t = await openTempDb("ipo-charger-dates", { seed: true });
  q = await import("@/lib/queries/ipos");
  ui = await import("@/components/ipo/ipo-client");
  ({ Dialog } = await import("@/components/ui/dialog"));
});
afterAll(() => t?.cleanup());

const CRORE = 10_000_000;
const seed = seedRatesMap();

/** ₹1 cr allotted (100 × 1,00,000 shares) and sold at the issue price. */
const crore = (p: Partial<IpoInput> = {}): IpoInput => ({
  id: 1, name: "CRORE", broker: null, exchange: "NSE",
  appliedPrice: 100, lotSize: 100_000, lotsApplied: 1,
  allotted: true, allottedQty: 100_000, listingPrice: null, exitPrice: 100,
  ...p,
});

const base = (over: Partial<ChargeRates> = {}): ChargeRates =>
  ({
    broker: "zerodha", plan: "default", planLabel: null, subscriptionMonthly: 0,
    segment: "eq_delivery", exchange: "NSE",
    brokerageFlat: 0, brokeragePct: 0, brokerageCap: 0, brokerageFloor: 0,
    sttPct: 0.001, sttSide: "sell", exchangeTxnPct: 0, sebiPct: 0, stampPct: 0, ipftPct: 0, gstPct: 0.18,
    dpCharge: 0, dpPct: 0, dpGstApplicable: false, dpMinValue: 0,
    mtfInterestAnnual: 0, mtfRateUnknown: false, mtfTiers: null, pledgeCharge: 0, unpledgeCharge: 0,
    ...over,
  }) as ChargeRates;

describe("N13 · an exit date never throws", () => {
  it("isPriceableExitDate: a real ISO day from 1875 on; anything else is not yet priceable", () => {
    for (const ok of ["2026-06-15", "2011-03-15", "1970-01-01", "1965-03-15", "1875-01-01", "2024-02-29"]) {
      expect(isPriceableExitDate(ok), ok).toBe(true);
    }
    for (const bad of ["0002-06-15", "0202-06-15", "1874-12-31", "15-03-2011", "2026-02-30", "2025-02-29", "20111-06-15", "", "2026-6-15"]) {
      expect(isPriceableExitDate(bad), bad).toBe(false);
    }
  });

  it("building a charger resolves no rates: an intermediate or non-ISO date, even over a map with no rows at all", () => {
    expect(() => q.chargerFor(null, "NSE", "0202-06-15", seed)).not.toThrow();
    expect(() => q.chargerFor("zerodha", "NSE", "15-03-2011", seed)).not.toThrow();
    expect(() => q.chargerFor(null, "NSE", "0002-06-15", new Map())).not.toThrow();
    expect(() => q.chargeBreakdownFor("zerodha", "BSE", "0002-06-15", new Map())).not.toThrow();
  });

  it("an unpriceable exit date prices to null (not yet priced), never to a number", () => {
    expect(q.chargerFor(null, "NSE", "0202-06-15", seed)(CRORE, CRORE)).toBeNull();
    expect(q.chargerFor("zerodha", "NSE", "15-03-2011", seed)(CRORE, CRORE)).toBeNull();
    expect(q.chargeBreakdownFor(null, "NSE", "0002-06-15", seed)(CRORE, CRORE)).toBeNull();
  });

  it("computeIpo (the client preview's seed charger): exited with '0002-06-15' is exited but unpriced — no charges, no net, no tax", () => {
    let c: IpoComputed | undefined;
    expect(() => {
      c = computeIpo({ id: 1, name: "X", broker: null, exchange: "NSE", appliedPrice: 100, lotSize: 100, lotsApplied: 1, allotted: true, allottedQty: 100, listingPrice: 120, exitPrice: 130, exitDate: "0002-06-15" });
    }).not.toThrow();
    expect(c!.status).toBe("exited");
    expect(c!.unpriced).toBe(true);
    expect(c!.grossPnl).toBe(3000); // (130 − 100) × 100 needs no charge
    expect([c!.charges, c!.netPnl, c!.realised, c!.returnPct, c!.tax, c!.chargeBreakdown]).toEqual([0, 0, false, null, null, null]);
  });

  it("computeIpo never calls the charger for an unpriceable exit date, whatever charger is injected", () => {
    const charger = vi.fn(() => 100);
    const c = computeIpo(crore({ exitDate: "15-03-2011" }), charger);
    expect(charger).not.toHaveBeenCalled();
    expect(c.unpriced).toBe(true);
    expect(c.realised).toBe(false);
  });

  it("an UNEXITED IPO with a garbage exit date: no throw, the charger is never called", () => {
    const charger = vi.fn(q.chargerFor(null, "NSE", "0002-06-15", new Map()));
    const c = computeIpo(crore({ exitPrice: null, listingPrice: 120, exitDate: "0002-06-15" }), charger);
    expect(charger).not.toHaveBeenCalled();
    expect(c.status).toBe("listed");
    expect(c.unpriced).toBe(false);
    expect(c.unrealised).toBe(2_000_000);
  });

  it("a real day BEFORE the earliest seeded epoch prices at the earliest verified schedule (06-ANSWERS:345)", () => {
    // The seed's eq_delivery epochs start 1970-01-01 (STT 0.125% until 2012-07-01).
    const at = (d: string, b: string | null = null) => q.chargerFor(b, "NSE", d, seed)(CRORE, CRORE);
    expect(at("1965-03-15")).toBe(at("1970-01-01"));
    expect(at("1965-03-15", "zerodha")).toBe(at("1970-01-01", "zerodha"));
    expect(q.chargeBreakdownFor(null, "NSE", "1875-01-01", seed)(CRORE, CRORE)!.sttCtt).toBe(12500);
  });

  it("a map whose only epoch starts 2026-04-01: a 2025 exit prices at that epoch; a map with NO row still throws, when priced", () => {
    const m = ratesMapOf([base({ effectiveFrom: "2026-04-01", effectiveTo: null })]);
    expect(q.chargerFor("zerodha", "NSE", "2025-06-01", m)(100000, 90000)).toBe(100);
    expect(q.chargerFor(null, "NSE", "2025-06-01", m)(100000, 90000)).toBe(100);
    const none = q.chargerFor(null, "NSE", "2026-06-15", new Map());
    expect(() => none(100000, 90000)).toThrow(/No charge_config/);
  });

  it("the server reach: stored garbage exit dates do not take down getIposComputed / getIpoRealisedNet", () => {
    t.db.insert(t.schema.ipos).values([
      { name: "GARBAGE-NB", broker: null, appliedPrice: 100, lotSize: 100, allotted: true, allottedQty: 100, exitPrice: 130, exitDate: "0202-06-15" },
      { name: "GARBAGE-ZD", broker: "zerodha", appliedPrice: 100, lotSize: 100, allotted: true, allottedQty: 100, exitPrice: 130, exitDate: "15-03-2011" },
      { name: "HOLDING", broker: null, appliedPrice: 100, lotSize: 100, allotted: true, allottedQty: 100, listingPrice: 120, exitDate: "0002-06-15" },
      { name: "GOOD", broker: null, appliedPrice: 100, lotSize: 100, allotted: true, allottedQty: 100, exitPrice: 130, allotmentDate: "2026-06-10", exitDate: "2026-06-15" },
    ]).run();
    const { rows } = q.getIposComputed();
    const by = new Map(rows.map((r) => [r.name, r]));
    expect([by.get("GARBAGE-NB")!.unpriced, by.get("GARBAGE-ZD")!.unpriced, by.get("HOLDING")!.status]).toEqual([true, true, "listed"]);
    const good = by.get("GOOD")!;
    expect(good.realised).toBe(true);
    expect(q.getIpoRealisedNet()).toBe(good.netPnl);
  });
});

describe("N14 · the allottee owes no stamp on an allotment from 1 Jul 2020 (the issuer bears it)", () => {
  it("the boundary is the Act 7 of 2019 commencement", () => {
    expect(ISSUER_BEARS_ISSUE_STAMP_FROM).toBe("2020-07-01");
  });

  it("zerodha NSE, ₹1 cr allotted 2026-06-10 and sold 2026-06-15: 11889.40 less the 1500 stamp", () => {
    const c = computeIpo(crore({ broker: "zerodha", allotmentDate: "2026-06-10", exitDate: "2026-06-15" }), q.sellChargerFor("zerodha", "NSE", "2026-06-15", seed));
    expect(c.charges).toBe(10389.4);
    expect(c.chargeBreakdown!.stampDuty).toBe(0);
  });

  it("allotted 2020-06-30 keeps the stamp; 2020-07-01 drops it (same exit)", () => {
    const at = (allotmentDate: string) =>
      computeIpo(crore({ allotmentDate, exitDate: "2026-06-15" }), q.sellChargerFor(null, "NSE", "2026-06-15", seed));
    expect(at("2020-06-30").charges).toBe(11874.06);
    expect(at("2020-06-30").chargeBreakdown!.stampDuty).toBe(1500);
    expect(at("2020-07-01").charges).toBe(10374.06);
  });

  it("with no allotment date the chain is listing → applied → exit date", () => {
    const run = (p: Partial<IpoInput>) => computeIpo(crore({ exitDate: "2026-06-15", ...p }), q.sellChargerFor(null, "NSE", "2026-06-15", seed)).chargeBreakdown!.stampDuty;
    expect(run({ listingDate: "2020-06-15" })).toBe(1500);
    expect(run({ appliedDate: "2020-06-10", listingDate: null })).toBe(1500);
    expect(run({})).toBe(0); // only the 2026 exit date is known
    expect(run({ allotmentDate: "garbage", listingDate: "2019-01-01" })).toBe(1500); // an unreadable date is skipped
  });
});

describe("N15 · the charges label names only heads this IPO carries; the preview says what it omits", () => {
  const heads = (b: string | null, allotmentDate = "2020-06-30") =>
    ipoChargeHeads(computeIpo(crore({ broker: b, allotmentDate, exitDate: "2026-06-15" }), q.sellChargerFor(b, "NSE", "2026-06-15", seed)).chargeBreakdown);

  it("no broker: no DP and no brokerage; a post-July-2020 allotment carries no stamp either", () => {
    expect(heads(null)).toEqual(["STT", "exch", "stamp", "GST"]);
    expect(heads(null, "2026-06-10")).toEqual(["STT", "exch", "GST"]);
    expect(heads("zerodha", "2026-06-10")).toEqual(["STT", "exch", "DP", "GST"]);
    expect(heads("groww", "2026-06-10")).toEqual(["brokerage", "STT", "exch", "DP", "GST"]);
  });

  it("the statement renders that label, and '—' for an unpriced exit", () => {
    const row = (p: Partial<IpoInput>, b: string | null) =>
      computeIpo(crore({ broker: b, ...p }), q.sellChargerFor(b, "NSE", p.exitDate ?? null, seed));
    const html = (r: IpoComputed) => renderToStaticMarkup(React.createElement(ui.IpoStatement, { r }));
    const nb = html(row({ allotmentDate: "2026-06-10", exitDate: "2026-06-15" }, null));
    expect(nb).toContain("Sell charges (STT, exch, GST)");
    expect(nb).not.toContain("DP");
    expect(html(row({ allotmentDate: "2026-06-10", exitDate: "2026-06-15" }, "zerodha"))).toContain("Sell charges (STT, exch, DP, GST)");
    const garbage = html(row({ exitDate: "15-03-2011" }, "zerodha"));
    expect(garbage).toMatch(/Sell charges<\/span><span[^>]*>—<\/span>/);
    expect(garbage).toMatch(/Net P&amp;L<\/span><span[^>]*>—<\/span>/);
  });

  it("the form preview labels its charges 'before broker charges' when a broker is chosen", () => {
    const existing = (b: string | null) => computeIpo(crore({ broker: b, allotmentDate: "2026-06-10", exitDate: "2026-06-15" }), q.sellChargerFor(b, "NSE", "2026-06-15", seed));
    const form = (b: string | null) =>
      renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(ui.IpoForm, { existing: existing(b), onDone: () => {} })));
    expect(form("zerodha")).toContain("Charges before broker charges");
    const nb = form(null);
    expect(nb).not.toContain("before broker charges");
    expect(nb).toMatch(/>Charges<\/span>/);
  });
});

/**
 * IPO-EXITDATE (v4.3.0 wave 2F). N13 made a stored unreadable exit date safe to
 * READ; two surfaces still took one in:
 *  - POST /api/ipos stored `exitDate` as typed (strOrNull, no check), so a
 *    half-typed date input ('0002-06-15') or a day-first date ('15-03-2011')
 *    was saved and then read as "not yet priced". It is now refused with a 400
 *    by the same rule computeIpo reads a date by (isPriceableExitDate).
 *  - POST /api/ais handed the stored date to fyOfDate, which never throws on a
 *    string but FABRICATES a year for one (measured 2026-09-15 on this build:
 *    '0202-06-15' → "202-03", '0002-06-15' → "2-03", '2026-02-30' → "2025-26",
 *    '20111-06-15' → "20111-12", '15-03-2011' → "2010-11"; 'garbage' and
 *    '2026-13-01' → null). The IPO's sale is now skipped for such a date: no
 *    year is invented for it.
 */
describe("IPO-EXITDATE · an unreadable exit date is refused on the way in and skipped by AIS", () => {
  let ipoRoute: typeof import("@/app/api/ipos/route");
  let aisRoute: typeof import("@/app/api/ais/route");
  beforeAll(async () => {
    ipoRoute = await import("@/app/api/ipos/route");
    aisRoute = await import("@/app/api/ais/route");
    t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run(); // a create needs one account's book
  });
  const post = (body: unknown) =>
    ipoRoute.POST(new Request("http://local/api/ipos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const app = (exitDate: unknown, over: Record<string, unknown> = {}) => ({
    name: "EXITDATE-ROUTE", exchange: "NSE", appliedPrice: 100, lotSize: 10, lotsApplied: 1,
    allotted: true, allottedQty: 10, exitPrice: 120, exitDate, ...over,
  });
  const named = (name: string) => t.db.select().from(t.schema.ipos).all().filter((r) => r.name === name);

  it("fyOfDate fabricates a financial year for an unreadable date — the behaviour the AIS guard exists for", async () => {
    const { fyOfDate } = await import("@/lib/analytics/ais");
    expect(["0202-06-15", "0002-06-15", "2026-02-30", "20111-06-15"].map((d) => fyOfDate(d, 4))).toEqual(["202-03", "2-03", "2025-26", "20111-12"]);
    expect(fyOfDate("garbage", 4)).toBeNull();
  });

  it("POST /api/ipos refuses a non-ISO, impossible or pre-1875 exit date with a 400 and saves nothing", async () => {
    for (const bad of ["15-03-2011", "0002-06-15", "2026-02-30", "2026-6-15", "20111-06-15", 20260615]) {
      const res = await post(app(bad));
      expect(res.status, String(bad)).toBe(400);
      const json = (await res.json()) as { ok: boolean; message: string };
      expect(json.ok).toBe(false);
      expect(json.message).toBe("The exit date must be a real calendar day written year-month-day, such as 2026-06-15, with a year from 1875 on. Nothing was saved.");
    }
    expect(named("EXITDATE-ROUTE")).toHaveLength(0);
  });

  it("POST /api/ipos still saves a real ISO day, and a blank exit date as none", async () => {
    const ok = await post(app("2026-06-15"));
    expect(ok.status).toBe(200);
    const blank = await post(app("", { name: "EXITDATE-BLANK" }));
    expect(blank.status).toBe(200);
    expect(named("EXITDATE-ROUTE").map((r) => r.exitDate)).toEqual(["2026-06-15"]);
    expect(named("EXITDATE-BLANK").map((r) => r.exitDate)).toEqual([null]);
  });

  it("an EDIT that carries an unreadable exit date is refused too, and the stored row is unchanged", async () => {
    const [row] = named("EXITDATE-ROUTE");
    const res = await post(app("0202-06-15", { id: row.id, exitPrice: 999 }));
    expect(res.status).toBe(400);
    const [after] = named("EXITDATE-ROUTE");
    expect([after.exitDate, after.exitPrice]).toEqual(["2026-06-15", 120]);
  });

  it("POST /api/ais skips an IPO sale whose stored exit date is unreadable, and invents no financial year for it", async () => {
    // Stored directly: rows written before this build, or by any path other than the route.
    t.db.insert(t.schema.ipos).values([
      { name: "AIS-GOOD", appliedPrice: 100, lotSize: 1, allotted: true, allottedQty: 1, exitPrice: 333, exitDate: "2025-12-01" },
      { name: "AIS-FEB30", appliedPrice: 100, lotSize: 1, allotted: true, allottedQty: 1, exitPrice: 777, exitDate: "2026-02-30" },
      { name: "AIS-YEAR2", appliedPrice: 100, lotSize: 1, allotted: true, allottedQty: 1, exitPrice: 555, exitDate: "0002-06-15" },
    ]).run();
    const res = await aisRoute.POST(
      new Request("http://local/api/ais", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "nothing to parse" }) }),
    );
    expect(res.status).toBe(200);
    const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
    const sales = recon.fyTotals.filter((f) => f.kind === "sale");
    // THE assertions: the Feb-30 sale is not folded into FY 2025-26, and year 2 gets no "2-03".
    expect(sales.find((f) => f.fy === "2025-26")?.journal).toBe(333);
    expect(sales.map((f) => f.fy).filter((fy) => !/^\d{4}-\d{2}$/.test(fy))).toEqual([]);
  });
});
