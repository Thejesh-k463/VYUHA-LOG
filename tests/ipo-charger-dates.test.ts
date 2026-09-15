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
import { eq as eqOf } from "drizzle-orm";

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

  /**
   * L4 (v4.3.0 wave 2G). The Net P&L, Return, STCG/LTCG estimate and Post-tax net
   * cells are computed from the same broker-less charges as the Charges cell, so
   * they differ from the saved row too (measured, zerodha, exit 120: preview net
   * 1987551.13, saved 1987535.79). Before this fix only the Charges cell said so.
   */
  it("L4 · with a broker chosen, every preview cell derived from those charges says 'before broker charges'", () => {
    const gain = (b: string | null, p: Partial<IpoInput> = { exitPrice: 120, allotmentDate: "2026-06-10", exitDate: "2026-06-15" }) =>
      renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(ui.IpoForm, {
        existing: computeIpo(crore({ broker: b, ...p }), q.sellChargerFor(b, "NSE", p.exitDate ?? null, seed)), onDone: () => {},
      })));
    const z = gain("zerodha");
    for (const label of ["Charges", "Net P&amp;L", "Post-tax net", "Return"]) {
      expect(z, label).toContain(`>${label} before broker charges</span>`);
    }
    expect(z).toMatch(/>STCG @[\d.]+% before broker charges<\/span>/);

    const nb = gain(null);
    expect(nb).not.toContain("before broker charges");
    for (const label of ["Charges", "Net P&amp;L", "Post-tax net", "Return"]) expect(nb, label).toContain(`>${label}</span>`);

    // A holding not yet sold is marked at listing with no charges at all: its Return is not qualified.
    const held = gain("zerodha", { exitPrice: null, listingPrice: 130, allotmentDate: "2026-06-10", exitDate: null });
    expect(held).toContain(">Return</span>");
    expect(held).not.toContain("before broker charges");

    expect(ui.previewCellLabel("Net P&L", "zerodha")).toBe("Net P&L before broker charges");
    expect(ui.previewCellLabel("Net P&L", "")).toBe("Net P&L");
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

  /**
   * L3 (v4.3.0 wave 2G). The refusal above ran on EVERY request, so an IPO whose
   * exit date was stored unreadable before 4.3.0 (a restore, the API, any path
   * but the date input) could not be edited at all, not even its notes: the form
   * sends the stored value back, and a not-allotted IPO has no exit-date input to
   * fix it in. Measured before this fix: the notes-only edit below answered 400.
   * Now only an exit date the request CHANGES is checked; clearing is allowed.
   */
  const legacy = (name: string, exitDate: string, over: Record<string, unknown> = {}) =>
    t.db.insert(t.schema.ipos).values({
      accountId: 1, name, appliedPrice: 100, lotSize: 10, allotted: true, allottedQty: 10, exitPrice: 120, exitDate, ...over,
    }).returning({ id: t.schema.ipos.id }).get()!.id;

  it("L3 · a notes-only edit of an IPO with a stored unreadable exit date is saved, the stored date passing through", async () => {
    const id = legacy("LEGACY-DMY", "15-03-2011");
    const res = await post(app("15-03-2011", { id, name: "LEGACY-DMY", notes: "only a note changed" }));
    expect(res.status).toBe(200);
    const [after] = named("LEGACY-DMY");
    expect([after.notes, after.exitDate]).toEqual(["only a note changed", "15-03-2011"]);

    // A not-allotted IPO renders no exit-date input, yet its form still sends the stored value.
    const na = legacy("LEGACY-NA", "2026-02-30", { allotted: false, allottedQty: 0, exitPrice: null });
    const naRes = await post(app("2026-02-30", { id: na, name: "LEGACY-NA", allotted: false, allottedQty: 0, exitPrice: "", notes: "noted" }));
    expect(naRes.status).toBe(200);
    expect(named("LEGACY-NA").map((r) => [r.notes, r.exitDate])).toEqual([["noted", "2026-02-30"]]);
  });

  it("L3 · changing that stored date to another unreadable value is still refused; clearing it is saved", async () => {
    const [row] = named("LEGACY-DMY");
    const res = await post(app("0002-06-15", { id: row.id, name: "LEGACY-DMY", notes: "tried a new date" }));
    expect(res.status).toBe(400);
    expect(named("LEGACY-DMY").map((r) => [r.notes, r.exitDate])).toEqual([["only a note changed", "15-03-2011"]]);

    const cleared = await post(app("", { id: row.id, name: "LEGACY-DMY", notes: "date cleared" }));
    expect(cleared.status).toBe(200);
    expect(named("LEGACY-DMY").map((r) => [r.notes, r.exitDate])).toEqual([["date cleared", null]]);
  });

  it("L3 · a create carrying the same unreadable value is still refused (only an unchanged STORED value passes)", async () => {
    const res = await post(app("15-03-2011", { name: "LEGACY-CREATE" }));
    expect(res.status).toBe(400);
    expect(named("LEGACY-CREATE")).toHaveLength(0);
  });

  /**
   * H5 (v4.3.0 wave 2H). L3's pass-through let a save USE the unchanged unreadable
   * stored date: typing an exit price on an IPO linked to an open holding closed
   * that trade with sell_date '2026-02-30' and a realised P&L the tax base folds
   * into an invented year. Measured before this fix (the re-check's probe): 200,
   * trade isOpen false, sellDate '2026-02-30', grossPnl 500. At cba3e6c: 400.
   * The stored value now passes only while the save does not use it.
   */
  const openTrade = (symbol: string, over: Record<string, unknown> = {}) =>
    t.db.insert(t.schema.trades).values({
      accountId: 1, broker: "zerodha", bucket: "equity", segment: "eq_delivery", instrumentType: "equity", exchange: "NSE",
      symbol, tradingsymbol: symbol, dedupHash: `h5-${symbol}`, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2019-01-10", isOpen: true,
      ...over,
    }).returning({ id: t.schema.trades.id }).get()!.id;
  const tradeRow = (id: number) => t.db.select().from(t.schema.trades).all().find((r) => r.id === id)!;
  /** IpoForm.save()'s exact payload before this fix (the stored date sent back unseen). */
  const formPayload = (id: number, name: string, over: Record<string, unknown> = {}) => ({
    id, name, broker: "", exchange: "NSE", board: "mainboard", category: "", discountPerShare: "",
    appliedPrice: "100", lotSize: "10", lotsApplied: "1", allotted: true, allottedQty: 10, listingPrice: "130",
    exitPrice: "150", appliedDate: "", allotmentDate: "2019-01-10", listingDate: "", exitDate: "2026-02-30", notes: "", ...over,
  });
  const REFUSED = "The exit date must be a real calendar day written year-month-day, such as 2026-06-15, with a year from 1875 on. Nothing was saved.";

  it("H5 · an exit price on an IPO LINKED to an open holding, over an unreadable stored exit date, is refused and the trade stays open", async () => {
    const trade = openTrade("LNK");
    const id = legacy("LNK", "2026-02-30", { exitPrice: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const res = await post(formPayload(id, "LNK"));
    // THE assertions: 400, the IPO keeps no exit price, the trade is untouched.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(REFUSED);
    expect(named("LNK").map((r) => [r.exitPrice, r.exitDate])).toEqual([[null, "2026-02-30"]]);
    const tr = tradeRow(trade);
    expect([tr.isOpen, tr.sellDate, tr.sellQty, tr.grossPnl]).toEqual([true, null, 0, 0]);

    // A notes-only save of the same linked IPO still goes through (L3), and syncs an open holding.
    const notes = await post(formPayload(id, "LNK", { exitPrice: "", notes: "linked, noted" }));
    expect(notes.status).toBe(200);
    expect(named("LNK").map((r) => [r.notes, r.exitDate])).toEqual([["linked, noted", "2026-02-30"]]);
    expect([tradeRow(trade).isOpen, tradeRow(trade).sellDate]).toEqual([true, null]);
  });

  it("H5 · with no link, a save that makes the IPO exited over that stored date is refused too", async () => {
    const id = legacy("UNLINKED-EXIT", "15-03-2011", { exitPrice: null, listingPrice: 130 });
    const res = await post(formPayload(id, "UNLINKED-EXIT", { exitDate: "15-03-2011" }));
    expect(res.status).toBe(400);
    expect(named("UNLINKED-EXIT").map((r) => [r.exitPrice, r.exitDate])).toEqual([[null, "15-03-2011"]]);
  });

  it("H5 · linking an already-exited IPO with that stored date to an open holding is refused (the sync would write it as the sell date)", async () => {
    const trade = openTrade("NEWLINK");
    const id = legacy("NEWLINK", "2026-02-30", { exitPrice: 150, listingPrice: 130 });
    const res = await post({ ...formPayload(id, "NEWLINK"), tradeId: trade });
    expect(res.status).toBe(400);
    expect(named("NEWLINK").map((r) => r.tradeId)).toEqual([null]);
    expect([tradeRow(trade).isOpen, tradeRow(trade).sellDate]).toEqual([true, null]);
  });

  it("H5 · an already-exited LINKED IPO with that stored date and an unchanged exit price keeps saving notes; the sync re-writes the sell date it already carried (pre-existing)", async () => {
    // The linked trade as an earlier save left it: closed on the stored date.
    const trade = openTrade("EXITED-LNK", { isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-02-30", grossPnl: 500, netPnl: 500 });
    const id = legacy("EXITED-LNK", "2026-02-30", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const res = await post(formPayload(id, "EXITED-LNK", { notes: "exited, noted" }));
    expect(res.status).toBe(200);
    expect(named("EXITED-LNK").map((r) => [r.notes, r.exitPrice, r.exitDate])).toEqual([["exited, noted", 150, "2026-02-30"]]);
    // Recorded, not changed by H5: the unreadable date stays on trades.sell_date.
    const tr = tradeRow(trade);
    expect([tr.isOpen, tr.sellDate, tr.sellQty, tr.grossPnl]).toEqual([false, "2026-02-30", 10, 500]);
  });

  /**
   * S4 (v4.3.0 wave 2H seam (f)). H5's refusal was reachable only from a stale tab:
   * the shipped form opens the unreadable stored date as a BLANK input and sends ''
   * (exitDateToSend), and a blank date passed. Measured before this fix (the seam
   * tester's probe through the form's payload): 200, the linked trade isOpen false,
   * sellDate NULL, sellQty 10, gross 500, which taxByFy files as current-FY STCG for
   * shares allotted in 2019. A save that would CLOSE a linked trade as a new write now
   * needs a readable exit date; an unlinked IPO still records its exit undated.
   */
  const NEEDS_DATE = "An exit needs a readable exit date — enter the date the shares were sold.";
  /** X1 (wave 2H seam fix 5): the route's refusal of a money change over a sale recorded in Trades. */
  const HOLDING_SOLD = "The linked holding has a sale recorded in Trades. Change its quantity or prices there, or remove the sale first. Nothing was saved.";

  it("S4 · through the form's own payload (the blank date it opens with), an exit price on a LINKED open holding is refused and the trade stays open", async () => {
    const trade = openTrade("S4-LNK");
    const id = legacy("S4-LNK", "2026-02-30", { exitPrice: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    // The date the shipped form sends for this row, the input left as it opens.
    const sent = ui.exitDateToSend("2026-02-30", "", true);
    expect(sent).toBe("");
    const res = await post(formPayload(id, "S4-LNK", { exitDate: sent }));
    // THE assertions: 400 with the route's message (IpoForm.save() toasts json.message), nothing written.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean; message: string })).toEqual({ ok: false, message: NEEDS_DATE });
    expect(named("S4-LNK").map((r) => [r.exitPrice, r.exitDate])).toEqual([[null, "2026-02-30"]]);
    const tr = tradeRow(trade);
    expect([tr.isOpen, tr.sellDate, tr.sellQty, tr.grossPnl]).toEqual([true, null, 0, 0]);

    // A readable date typed into that input closes it on that date.
    const dated = await post(formPayload(id, "S4-LNK", { exitDate: ui.exitDateToSend("2026-02-30", "2026-03-02", true) }));
    expect(dated.status).toBe(200);
    expect([tradeRow(trade).isOpen, tradeRow(trade).sellDate, tradeRow(trade).grossPnl]).toEqual([false, "2026-03-02", 500]);
  });

  it("S4 · a notes-only save of that linked IPO with the blank date still saves and leaves the holding open (L3)", async () => {
    const trade = openTrade("S4-NOTES");
    const id = legacy("S4-NOTES", "2026-02-30", { exitPrice: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const res = await post(formPayload(id, "S4-NOTES", { exitPrice: "", exitDate: "", notes: "only notes" }));
    expect(res.status).toBe(200);
    expect(named("S4-NOTES").map((r) => [r.notes, r.exitDate])).toEqual([["only notes", null]]);
    expect([tradeRow(trade).isOpen, tradeRow(trade).sellDate]).toEqual([true, null]);
  });

  it("S4 · with no link, an exit price and a blank date is recorded as before", async () => {
    const id = legacy("S4-UNLINKED", "2026-02-30", { exitPrice: null, listingPrice: 130 });
    const res = await post(formPayload(id, "S4-UNLINKED", { exitDate: "" }));
    expect(res.status).toBe(200);
    expect(named("S4-UNLINKED").map((r) => [r.exitPrice, r.exitDate])).toEqual([[150, null]]);
  });

  it("S4 · clearing the date of an exited linked IPO (the trade closed on a real day) is refused; a create linking an open holding with an exit and no date is refused", async () => {
    const closed = openTrade("S4-CLEAR", { isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-06-15", grossPnl: 500, netPnl: 500 });
    const id = legacy("S4-CLEAR", "2026-06-15", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: closed });
    const res = await post(formPayload(id, "S4-CLEAR", { exitDate: "" }));
    expect(res.status).toBe(400);
    expect(named("S4-CLEAR").map((r) => r.exitDate)).toEqual(["2026-06-15"]);
    expect([tradeRow(closed).isOpen, tradeRow(closed).sellDate]).toEqual([false, "2026-06-15"]);

    const open = openTrade("S4-CREATE");
    const { id: _drop, ...create } = formPayload(0, "S4-CREATE", { exitDate: "" });
    void _drop;
    const made = await post({ ...create, tradeId: open });
    expect(made.status).toBe(400);
    expect(((await made.json()) as { message: string }).message).toBe(NEEDS_DATE);
    expect(named("S4-CREATE")).toHaveLength(0);
    expect([tradeRow(open).isOpen, tradeRow(open).sellDate]).toEqual([true, null]);
  });

  it("H5 · the form shows a stored unreadable exit date as a blank input, says why beside it, and sends what the input holds", () => {
    const form = (p: Partial<IpoInput>) =>
      renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(ui.IpoForm, {
        existing: computeIpo(crore({ exitPrice: null, listingPrice: 130, ...p })), onDone: () => {},
      })));
    const bad = form({ exitDate: "2026-02-30" });
    // THE assertions: no hidden '2026-02-30' in the date input, and the line beside it.
    expect(bad).not.toContain('value="2026-02-30"');
    expect(bad).toMatch(/>Exit date<\/label><input type="date"[^>]*value=""\/>/);
    expect(bad).toContain("The stored exit date (2026-02-30) could not be read — enter the date. Saved blank, the exit date is cleared.");
    const good = form({ exitDate: "2026-06-15" });
    expect(good).toMatch(/>Exit date<\/label><input type="date"[^>]*value="2026-06-15"\/>/);
    expect(good).not.toContain("could not be read");

    expect(ui.unreadableStoredExitDate("15-03-2011")).toBe(true);
    expect([ui.unreadableStoredExitDate("2026-06-15"), ui.unreadableStoredExitDate(null), ui.unreadableStoredExitDate("")]).toEqual([false, false, false]);
    // Allotted: the input is rendered, so what it holds is sent (blank clears, a typed day is sent).
    expect(ui.exitDateToSend("2026-02-30", "", true)).toBe("");
    expect(ui.exitDateToSend("2026-02-30", "2026-03-02", true)).toBe("2026-03-02");
    // Not allotted: no input is rendered, so the untouched stored value goes back and passes through (L3).
    expect(ui.exitDateToSend("2026-02-30", "", false)).toBe("2026-02-30");
    expect(ui.exitDateToSend("2026-06-15", "2026-06-15", false)).toBe("2026-06-15");
  });

  /**
   * T3 (v4.3.0 wave 2H seam fix). A pre-4.3.0 IPO whose unreadable '2026-02-30' was
   * synced onto its linked holding (trade closed, sell_date '2026-02-30'): the form
   * opened blank beside "Saved blank, the exit date is cleared.", sent '', and S4's
   * route answered 400 "An exit needs a readable exit date" — nothing saved, the notes
   * included (seam probe 2026-09-15). The form now sends the stored value back for an
   * IPO stored as SOLD while its date field is untouched (the route passes it through,
   * as for EXITED-LNK above), and the notice says the date is kept until one is entered.
   */
  it("T3 · a LINKED holding already sold on the unreadable stored date: a notes-only save through the form sends the stored date back, saves the notes (200) and leaves the trade as it was", async () => {
    const trade = openTrade("T3-SOLD", { isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-02-30", grossPnl: 500, netPnl: 500 });
    const id = legacy("T3-SOLD", "2026-02-30", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const e = q.getIposComputed().rows.find((r) => r.name === "T3-SOLD")!;
    // The date IpoForm.save() sends for this row, its input left as it opens.
    const sent = ui.exitDateToSend(e.exitDate, "", e.allotted, ui.storedAsSold(e), false);
    // THE assertions: the stored value goes back, and the route saves the notes.
    expect(sent).toBe("2026-02-30");
    const res = await post(formPayload(id, "T3-SOLD", { exitDate: sent, notes: "sold, noted" }));
    expect(res.status).toBe(200);
    expect(named("T3-SOLD").map((r) => [r.notes, r.exitPrice, r.exitDate])).toEqual([["sold, noted", 150, "2026-02-30"]]);
    const tr = tradeRow(trade);
    expect([tr.isOpen, tr.sellDate, tr.sellQty, tr.grossPnl]).toEqual([false, "2026-02-30", 10, 500]);

    // Once the field is typed in, the form sends what it holds and the route validates it.
    expect(ui.exitDateToSend(e.exitDate, "2026-03-02", true, true, true)).toBe("2026-03-02");
    expect(ui.exitDateToSend(e.exitDate, "", true, true, true)).toBe("");
    // Not stored as sold (H5, S4): the blank input is what is sent.
    expect(ui.exitDateToSend("2026-02-30", "", true, false, false)).toBe("");
    expect([ui.storedAsSold(e), ui.storedAsSold({ allotted: true, exitPrice: null }), ui.storedAsSold({ allotted: false, exitPrice: 150 }), ui.storedAsSold(undefined)]).toEqual([true, false, false, false]);
  });

  it("T3 · beside the blank input of an IPO sold on an unreadable stored date the notice says the date is kept until one is entered, never that saving clears it; an unsold one keeps H5's notice", () => {
    const form = (p: Partial<IpoInput>) =>
      renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(ui.IpoForm, {
        existing: computeIpo(crore({ listingPrice: 130, ...p })), onDone: () => {},
      })));
    const notice = (html: string) => /data-testid="ipo-exit-date-unreadable">([^<]*)</.exec(html)?.[1];
    const sold = form({ exitPrice: 150, exitDate: "2026-02-30" });
    expect(sold).toMatch(/>Exit date<\/label><input type="date"[^>]*value=""\/>/);
    // THE assertions.
    expect(notice(sold)).toBe("The stored exit date (2026-02-30) could not be read. It is kept as stored; to change it, enter the date the shares were sold.");
    expect(notice(sold)).not.toMatch(/clear/i);
    expect(notice(form({ exitPrice: null, exitDate: "2026-02-30" }))).toBe("The stored exit date (2026-02-30) could not be read — enter the date. Saved blank, the exit date is cleared.");
    expect(notice(form({ exitPrice: 150, exitDate: "2026-06-15" }))).toBeUndefined();
  });

  /**
   * U3 (v4.3.0 wave 2H seam fix 3). T3 decided on "stored as sold" alone because the
   * /ipos row carried no link: a SOLD IPO whose linked holding's sell date had been
   * corrected in the Trades editor to a readable day (2026-03-02) opened beside "It is
   * kept as stored", sent '2026-02-30' back, and the route refused it (H5: the sync
   * would write it over the holding's 2026-03-02) with 400 — the notes lost (seam
   * re-run 2026-09-15). The row now carries `linked` and `linkedSellDate`; the form
   * fills in the holding's readable sell date, says so, and sends it.
   */
  const formOf = (e: IpoComputed) =>
    renderToStaticMarkup(React.createElement(Dialog, null, React.createElement(ui.IpoForm, { existing: e, onDone: () => {} })));
  const inputValue = (html: string) => /Exit date<\/label><input type="date"[^>]*value="([^"]*)"/.exec(html)?.[1];
  const noticeOf = (html: string) => /data-testid="ipo-exit-date-unreadable">([^<]*)</.exec(html)?.[1]?.replace(/&#x27;/g, "'");
  /** IpoForm.save()'s exitDate for `e` as the form opens: the rendered input value through exitDateToSend (as the seam harness builds it). */
  const openedSend = (e: IpoComputed, html: string) =>
    ui.exitDateToSend(e.exitDate, inputValue(html) ?? "", e.allotted, ui.keepsStoredExitDate(e), false);

  it("U3 · SOLD and LINKED to a holding whose sell date reads 2026-03-02: the form fills that date in and says so, a notes-only save sends it, answers 200 and the IPO's exit date is readable", async () => {
    const trade = openTrade("U3-FIXED", { isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500, netPnl: 500 });
    const id = legacy("U3-FIXED", "2026-02-30", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const e = q.getIposComputed().rows.find((r) => r.name === "U3-FIXED")!;
    expect([e.linked, e.linkedSellDate]).toEqual([true, "2026-03-02"]);
    const html = formOf(e);
    // THE assertions: the input holds the holding's date, the notice names it, and it is what goes out.
    expect(inputValue(html)).toBe("2026-03-02");
    expect(noticeOf(html)).toBe("The stored exit date (2026-02-30) could not be read. The linked holding's sell date, 2026-03-02, is filled in and will be saved as the exit date; to use another day, enter it.");
    const sent = openedSend(e, html);
    expect(sent).toBe("2026-03-02");
    const res = await post(formPayload(id, "U3-FIXED", { exitDate: sent, notes: "fixed, noted" }));
    expect(res.status).toBe(200);
    expect(named("U3-FIXED").map((r) => [r.notes, r.exitPrice, r.exitDate])).toEqual([["fixed, noted", 150, "2026-03-02"]]);
    const after = q.getIposComputed().rows.find((r) => r.name === "U3-FIXED")!;
    expect([isPriceableExitDate(after.exitDate!), after.unpriced, after.realised]).toEqual([true, false, true]);
    const tr = tradeRow(trade);
    expect([tr.isOpen, tr.sellDate, tr.sellQty, tr.grossPnl]).toEqual([false, "2026-03-02", 10, 500]);
    // The next render has nothing unreadable to explain.
    expect(noticeOf(formOf(after))).toBeUndefined();

    // Typed over, the typed day is sent; not allotted, no input renders and the stored value goes back (L3).
    expect(ui.exitDateInputValue(e, "2026-03-05", true, true)).toBe("2026-03-05");
    expect(ui.exitDateInputValue(e, "", true, false)).toBe("2026-03-02");
    expect(ui.exitDateInputValue(e, "", false, false)).toBe("");
    expect(ui.exitDateToSend(e.exitDate, ui.exitDateInputValue(e, "", false, false), false, ui.keepsStoredExitDate(e), false)).toBe("2026-02-30");
    // Typed then cleared: blank goes out (the route asks for the date), and the notice claims no missing holding date.
    expect(ui.exitDateToSend(e.exitDate, ui.exitDateInputValue(e, "", true, true), true, ui.keepsStoredExitDate(e), true)).toBe("");
    expect(ui.unreadableExitDateNotice(e, "", true, true)).toBe("The stored exit date (2026-02-30) could not be read. Enter the date the shares were sold.");
    expect(ui.unreadableExitDateNotice(e, "2026-03-05", true, true)).toBeNull();
  });

  it("U3 · SOLD and LINKED to a holding closed on the same unreadable '2026-02-30': T3's behaviour — the date is kept and a notes-only save answers 200", async () => {
    const trade = openTrade("U3-SAME", { isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-02-30", grossPnl: 500, netPnl: 500 });
    const id = legacy("U3-SAME", "2026-02-30", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const e = q.getIposComputed().rows.find((r) => r.name === "U3-SAME")!;
    expect([e.linked, e.linkedSellDate, ui.keepsStoredExitDate(e)]).toEqual([true, "2026-02-30", true]);
    const html = formOf(e);
    expect(inputValue(html)).toBe("");
    expect(noticeOf(html)).toBe("The stored exit date (2026-02-30) could not be read. It is kept as stored; to change it, enter the date the shares were sold.");
    const sent = openedSend(e, html);
    expect(sent).toBe("2026-02-30");
    const res = await post(formPayload(id, "U3-SAME", { exitDate: sent, notes: "same, noted" }));
    expect(res.status).toBe(200);
    expect(named("U3-SAME").map((r) => [r.notes, r.exitDate])).toEqual([["same, noted", "2026-02-30"]]);
    expect([tradeRow(trade).isOpen, tradeRow(trade).sellDate]).toEqual([false, "2026-02-30"]);
  });

  it("U3 · SOLD and LINKED to a holding with no readable sell date (reopened in the Trades editor): the notice promises nothing the route refuses, and the save gets the route's 'enter the date' sentence with nothing moved", async () => {
    const trade = openTrade("U3-OPEN");
    const id = legacy("U3-OPEN", "2026-02-30", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const e = q.getIposComputed().rows.find((r) => r.name === "U3-OPEN")!;
    expect([e.linked, e.linkedSellDate, ui.keepsStoredExitDate(e)]).toEqual([true, null, false]);
    const html = formOf(e);
    expect(inputValue(html)).toBe("");
    // THE assertions: no "kept as stored" (the route refuses that), and the sentence save() toasts matches the notice.
    expect(noticeOf(html)).toBe("The stored exit date (2026-02-30) could not be read, and the linked holding has no readable sell date. Enter the date the shares were sold.");
    const res = await post(formPayload(id, "U3-OPEN", { exitDate: openedSend(e, html), notes: "open, noted" }));
    expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([400, NEEDS_DATE]);
    expect(named("U3-OPEN").map((r) => [r.notes, r.exitDate])).toEqual([[null, "2026-02-30"]]);
    expect([tradeRow(trade).isOpen, tradeRow(trade).sellDate]).toEqual([true, null]);

    // Unlinked rows keep T3 / H5 exactly as built.
    const unlinked = computeIpo(crore({ exitPrice: 150, exitDate: "2026-02-30" }));
    expect([ui.keepsStoredExitDate(unlinked), ui.exitDateInputValue(unlinked, "", true, false)]).toEqual([true, ""]);
  });

  /**
   * V2 (v4.3.0 wave 2H seam fix 4). An allotted IPO with NO exit price over an
   * unreadable '2026-02-30', linked to a holding the user closed in Trades (sell 10
   * @150 on 2026-03-02, gross +500): U3's form filled in 2026-03-02 beside "will be
   * saved as the exit date", the notes-only save answered 200, and the sync RE-OPENED
   * the holding (seam probe 2026-09-15: after [isOpen true, sellDate null, sellQty 0,
   * sellValue 0, gross 0]) — the sale the notice named, erased. The blank H5 form did
   * the same. The form now fills in the holding's date only for an IPO stored as sold,
   * and the sync leaves a sell leg the IPO does not carry where it is.
   */
  it("V2 · NOT sold and LINKED to a holding closed in Trades on 2026-03-02: no pre-fill and no 'will be saved' notice; a notes-only save answers 200 and the holding stays closed on its own sell leg", async () => {
    const trade = openTrade("V2-UNSOLD", { isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500, netPnl: 500 });
    const id = legacy("V2-UNSOLD", "2026-02-30", { exitPrice: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const e = q.getIposComputed().rows.find((r) => r.name === "V2-UNSOLD")!;
    expect([e.linked, e.linkedSellDate, ui.storedAsSold(e)]).toEqual([true, "2026-03-02", false]);
    const html = formOf(e);
    const holding = () => {
      const r = tradeRow(trade);
      return [r.isOpen, r.sellDate, r.sellQty, r.sellValue, r.grossPnl];
    };
    // THE assertions: the form keeps H5's blank input and notice (nothing promises a save)…
    expect(inputValue(html)).toBe("");
    expect(noticeOf(html)).toBe("The stored exit date (2026-02-30) could not be read — enter the date. Saved blank, the exit date is cleared.");
    expect([ui.linkedHoldingExitDate(e), ui.exitDateInputValue(e, "", true, false)]).toEqual([null, ""]);
    const sent = openedSend(e, html);
    expect(sent).toBe("");
    // …and the notes-only save it sends leaves the sale where the user recorded it.
    const res = await post(formPayload(id, "V2-UNSOLD", { exitPrice: "", exitDate: sent, notes: "unsold, noted" }));
    expect(res.status).toBe(200);
    expect(named("V2-UNSOLD").map((r) => [r.notes, r.exitPrice, r.exitDate])).toEqual([["unsold, noted", null, null]]);
    expect(holding()).toEqual([false, "2026-03-02", 10, 1500, 500]);
    expect([tradeRow(trade).avgSellPrice, tradeRow(trade).netPnl, tradeRow(trade).closingPrice]).toEqual([150, 500, null]);

    // The probe's own payload (U3's pre-filled date, as a stale tab still sends it): the same.
    const beforeStale = tradeRow(trade);
    const stale = await post(formPayload(id, "V2-UNSOLD", { exitPrice: "", exitDate: "2026-03-02", notes: "stale tab" }));
    expect(stale.status).toBe(200);
    expect(tradeRow(trade)).toEqual(beforeStale);

    // X1 re-pin: V2 re-read the buy side onto the kept sale (gross 1500 − 900 = 600). A money change
    // over a sale recorded in Trades is now refused, and neither row moves.
    const ipoBefore = named("V2-UNSOLD")[0];
    const priced = await post(formPayload(id, "V2-UNSOLD", { exitPrice: "", exitDate: "", appliedPrice: "90" }));
    expect([priced.status, ((await priced.json()) as { message: string }).message]).toEqual([409, HOLDING_SOLD]);
    expect(named("V2-UNSOLD")[0]).toEqual(ipoBefore);
    expect(tradeRow(trade)).toEqual(beforeStale);
  });

  /**
   * X1 (v4.3.0 wave 2H seam fix 5). V2's keepLinkedSellLeg RECOMPUTED a linked holding that
   * had a sale recorded in Trades (seam probe 2026-09-15): (m1) a notes-only save over a
   * holding partly sold 4 @150 left the OPEN row at gross −400 / net −417.40 with unrealised
   * on all 10 shares; (m2) the IPO's allotted quantity corrected to 20 over a holding sold
   * 10 @150 kept the row CLOSED at buy 20 / sell 10, net −518.43; (l4) clearing the exit of an
   * IPO sold on /ipos left the holding closed +500 while /ipos read not realised. Now a save
   * changing no money field writes nothing to that holding, a money change is refused 409,
   * and an IPO whose exit IS the holding's sale keeps the full sync, clearing it included.
   */

  it("X1 m1 · a notes-only save of an IPO linked to a holding PARTLY sold in Trades answers 200 and writes not one column of the holding", async () => {
    const trade = openTrade("X1-PART", { sellQty: 4, avgSellPrice: 150, sellValue: 600, sellDate: "2026-03-02", chargesTotal: 17.4, grossPnl: 0, netPnl: -17.4, unrealisedPnl: 0 });
    const id = legacy("X1-PART", "2026-06-15", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const before = tradeRow(trade);
    const res = await post(formPayload(id, "X1-PART", { exitPrice: "", exitDate: "", notes: "part sold, noted" }));
    // THE assertions: 200, the IPO's notes saved, the holding byte-identical (V2: gross −400, net −417.40, unrealised 300).
    expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([200, "IPO updated. The linked holding has a sale recorded in Trades and was left as it is."]);
    expect(named("X1-PART").map((r) => r.notes)).toEqual(["part sold, noted"]);
    expect(tradeRow(trade)).toEqual(before);
    expect([before.isOpen, before.grossPnl, before.netPnl, before.unrealisedPnl]).toEqual([true, 0, -17.4, 0]);
  });

  it("X1 m2 · the allotted quantity corrected to 20 over a holding SOLD 10 @150 in Trades is refused 409; neither the IPO nor the holding moves, and a create linking it is refused too", async () => {
    const trade = openTrade("X1-QTY", { isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500, netPnl: 500, realisedPct: 50 });
    const id = legacy("X1-QTY", "2026-06-15", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const ipoBefore = named("X1-QTY")[0];
    const before = tradeRow(trade);
    const res = await post(formPayload(id, "X1-QTY", { exitPrice: "", exitDate: "", lotsApplied: "2", allottedQty: 20 }));
    // THE assertions: 409 with the route's sentence (IpoForm.save() toasts json.message), nothing written.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, message: HOLDING_SOLD });
    expect(named("X1-QTY")[0]).toEqual(ipoBefore);
    expect(tradeRow(trade)).toEqual(before);

    const { id: _drop, ...create } = formPayload(0, "X1-QTY-NEW", { exitPrice: "", exitDate: "" });
    void _drop;
    const made = await post({ ...create, tradeId: trade });
    expect([made.status, ((await made.json()) as { message: string }).message]).toEqual([409, HOLDING_SOLD]);
    expect(named("X1-QTY-NEW")).toHaveLength(0);
    expect(tradeRow(trade)).toEqual(before);
  });

  it("X1 (c) · sold on /ipos, then the exit cleared: the holding re-opens and /ipos reads not realised — the two pages agree", async () => {
    const trade = openTrade("X1-CLEAR");
    const id = legacy("X1-CLEAR", "2026-06-15", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const holding = () => {
      const r = tradeRow(trade);
      return [r.isOpen, r.sellDate, r.sellQty, r.sellValue, r.grossPnl, r.closingPrice, r.unrealisedPnl];
    };
    const sold = await post(formPayload(id, "X1-CLEAR", { exitPrice: "150", exitDate: "2026-03-02" }));
    expect(sold.status).toBe(200);
    expect(holding()).toEqual([false, "2026-03-02", 10, 1500, 500, null, 0]);
    expect(q.getIposComputed().rows.find((r) => r.name === "X1-CLEAR")!.realised).toBe(true);

    const cleared = await post(formPayload(id, "X1-CLEAR", { exitPrice: "", exitDate: "" }));
    // THE assertions (V2: 200 with the holding still closed +500 while /ipos reads not realised).
    expect([cleared.status, ((await cleared.json()) as { message: string }).message]).toEqual([200, "IPO updated — the linked holding's cost basis and mark were updated with it."]);
    expect(holding()).toEqual([true, null, 0, 0, 0, 130, 300]);
    const row = q.getIposComputed().rows.find((r) => r.name === "X1-CLEAR")!;
    expect([row.realised, row.status, row.exitPrice]).toEqual([false, "listed", null]);
  });

  /**
   * Y2 (v4.3.0 wave 2H, route half). Sold 150 on an unreadable '2026-02-30', linked to a
   * holding whose sale was corrected in the Trades editor to 152 on 2026-03-02. Measured
   * before: the notes-only save with U3's pre-filled 2026-03-02 answered 409 HOLDING_SOLD, and
   * so did the save with the date cleared. The stored date was never readable, so neither
   * changes anything the sync writes: 200, the holding byte-identical. A price change is 409.
   */
  it("Y2 · SOLD 150 on an unreadable date, LINKED to a sale corrected in Trades to 152: a notes-only save (pre-filled, cleared, or stored date) answers 200 and writes not one holding column; a price change is 409", async () => {
    const linkedPair = (name: string) => {
      const trade = openTrade(name, { isOpen: false, sellQty: 10, avgSellPrice: 152, sellValue: 1520, sellDate: "2026-03-02", grossPnl: 520, netPnl: 520, realisedPct: 52 });
      return { trade, id: legacy(name, "2026-02-30", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade }) };
    };
    const LEFT = "IPO updated. The linked holding has a sale recorded in Trades and was left as it is.";
    // One pair per case: the first save stores the date it carries, so each starts from '2026-02-30'.
    for (const [exitDate, name] of [["2026-03-02", "Y2-PREFILL"], ["", "Y2-CLEARED"], ["2026-02-30", "Y2-STORED"]] as const) {
      const pair = linkedPair(name);
      const before = tradeRow(pair.trade);
      const res = await post(formPayload(pair.id, name, { exitDate, notes: "noted" }));
      // THE assertions.
      expect([res.status, ((await res.json()) as { message: string }).message], name).toEqual([200, LEFT]);
      expect(named(name).map((r) => [r.notes, r.exitPrice, r.exitDate]), name).toEqual([["noted", 150, exitDate === "" ? null : exitDate]]);
      expect(tradeRow(pair.trade), name).toEqual(before);
    }
    const { trade, id } = linkedPair("Y2-DIFF");
    const before = tradeRow(trade);
    const ipoBefore = named("Y2-DIFF")[0];
    const priced = await post(formPayload(id, "Y2-DIFF", { exitPrice: "160", exitDate: "", notes: "repriced" }));
    expect([priced.status, ((await priced.json()) as { message: string }).message]).toEqual([409, HOLDING_SOLD]);
    expect(named("Y2-DIFF")[0]).toEqual(ipoBefore);
    expect(tradeRow(trade)).toEqual(before);
  });

  /**
   * Z2 (A) (v4.3.0 wave 2H). Y2's probe through the FORM: sold 150 on '2026-02-30', linked to a
   * sale corrected in Trades to 152 on 2026-03-02. Measured before: U3 filled in 2026-03-02 beside
   * "… will be saved as the exit date", and the notes save (200, Y2's 'leave') stored 2026-03-02 as
   * the IPO's exit date for a sale at a price the IPO does not carry. The pre-fill is now offered
   * only when the linked sale IS the stored exit apart from the date (same quantity, same price).
   */
  it("Z2 (A) · SOLD 150 on an unreadable date, LINKED to a sale corrected in Trades to 152: no pre-fill, a notice that the sale differs and is recorded in Trades, and a notes save sends the stored value — 200, the IPO's exit date unchanged", async () => {
    const trade = openTrade("Z2-DIFF", { isOpen: false, sellQty: 10, avgSellPrice: 152, sellValue: 1520, sellDate: "2026-03-02", grossPnl: 520, netPnl: 520, realisedPct: 52 });
    const id = legacy("Z2-DIFF", "2026-02-30", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const e = q.getIposComputed().rows.find((r) => r.name === "Z2-DIFF")!;
    expect([e.linked, e.linkedSellDate, e.linkedSellQty, e.linkedSellPrice]).toEqual([true, "2026-03-02", 10, 152]);
    const html = formOf(e);
    // THE assertions: the input stays blank, the notice promises no save, and the stored value goes out.
    expect(inputValue(html)).toBe("");
    const notice = noticeOf(html)!;
    expect(notice).not.toMatch(/will be saved/);
    expect(notice).toBe("The stored exit date (2026-02-30) could not be read. The linked holding's sale (10 at 152) differs from this IPO's exit (10 at 150) and is recorded in Trades. The stored date is kept; to change it, enter the date the shares were sold.");
    const sent = openedSend(e, html);
    expect(sent).toBe("2026-02-30");
    const before = tradeRow(trade);
    const res = await post(formPayload(id, "Z2-DIFF", { exitDate: sent, notes: "differs, noted" }));
    expect([res.status, ((await res.json()) as { message: string }).message]).toEqual([200, "IPO updated. The linked holding has a sale recorded in Trades and was left as it is."]);
    expect(named("Z2-DIFF").map((r) => [r.notes, r.exitPrice, r.exitDate])).toEqual([["differs, noted", 150, "2026-02-30"]]);
    expect(tradeRow(trade)).toEqual(before);
    // Typed then cleared: blank goes out and the notice says so (Y2's route clears it, 200).
    expect(ui.exitDateToSend(e.exitDate, ui.exitDateInputValue(e, "", true, true), true, ui.keepsStoredExitDate(e), true)).toBe("");
    expect(ui.unreadableExitDateNotice(e, "", true, true)).toBe("The stored exit date (2026-02-30) could not be read. The linked holding's sale (10 at 152) differs from this IPO's exit (10 at 150) and is recorded in Trades. Saved blank, the exit date is cleared.");
    // A partial sale at the exit price differs too; the matching sale keeps U3's pre-fill.
    const part = { ...e, linkedSellQty: 4, linkedSellPrice: 150 };
    expect([ui.linkedHoldingExitDate(part), ui.keepsStoredExitDate(part)]).toEqual([null, true]);
    const same = { ...e, linkedSellPrice: 150 };
    expect([ui.linkedHoldingExitDate(same), ui.keepsStoredExitDate(same), ui.exitDateInputValue(same, "", true, false)]).toEqual(["2026-03-02", false, "2026-03-02"]);
  });

  /**
   * Z2 (B) (v4.3.0 wave 2H, pre-existing). An exit saved on /ipos synced its linked holding with NO
   * sell charges: measured before, the holding closed at charges 0 / net 500 while /ipos priced the
   * same sale at net 497.94, and capital (Y1) counts the holding's figure. The sync now writes the
   * IPO's own computed charges (charge_config, invariant 3) and net = gross − charges.
   */
  it("Z2 (B) · a linked IPO sold on /ipos: the holding's [chargesTotal, netPnl] equal the IPO's computed [charges, net]; a notes save rewrites the same figures, a sale corrected in Trades is 'leave' byte-identical, and the exit cleared zeroes them", async () => {
    const trade = openTrade("Z2-NET");
    const id = legacy("Z2-NET", "2026-06-15", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const sold = await post(formPayload(id, "Z2-NET", { exitDate: "2026-03-02" }));
    expect(sold.status).toBe(200);
    const e = q.getIposComputed().rows.find((r) => r.name === "Z2-NET")!;
    const figures = () => {
      const r = tradeRow(trade);
      return [r.chargesTotal, r.netPnl];
    };
    // THE assertions: the holding's net is the IPO's net, to the paisa, with its heads summing to it.
    expect([e.realised, e.netPnl]).toEqual([true, 497.94]);
    expect(figures()).toEqual([e.charges, e.netPnl]);
    const tr = tradeRow(trade);
    const heads = [tr.brokerage, tr.sttCtt, tr.exchangeTxn, tr.sebi, tr.stampDuty, tr.ipft, tr.gst, tr.dpCharges, tr.mtfInterest, tr.pledgeCharges];
    expect(Math.round(heads.reduce((s, v) => s + v, 0) * 100) / 100).toBe(tr.chargesTotal);
    expect([tr.sttCtt, tr.stampDuty]).toEqual([e.chargeBreakdown!.sttCtt, e.chargeBreakdown!.stampDuty]);

    // A notes-only save: the sale IS the IPO's exit, so the sync writes the same figures again.
    const noted = await post(formPayload(id, "Z2-NET", { exitDate: "2026-03-02", notes: "noted" }));
    expect(noted.status).toBe(200);
    expect(figures()).toEqual([e.charges, 497.94]);

    // The sale corrected in Trades: a notes-only save is 'leave' and writes not one column.
    t.db.update(t.schema.trades).set({ avgSellPrice: 152, sellValue: 1520 }).where(eqOf(t.schema.trades.id, trade)).run();
    const before = tradeRow(trade);
    const left = await post(formPayload(id, "Z2-NET", { exitDate: "2026-03-02", notes: "noted again" }));
    expect([left.status, ((await left.json()) as { message: string }).message]).toEqual([200, "IPO updated. The linked holding has a sale recorded in Trades and was left as it is."]);
    expect(tradeRow(trade)).toEqual(before);

    // Back to the IPO's sale, then the exit cleared on /ipos: the holding re-opens with no sale charges left on it.
    t.db.update(t.schema.trades).set({ avgSellPrice: 150, sellValue: 1500 }).where(eqOf(t.schema.trades.id, trade)).run();
    const cleared = await post(formPayload(id, "Z2-NET", { exitPrice: "", exitDate: "" }));
    expect(cleared.status).toBe(200);
    const r = tradeRow(trade);
    expect([r.isOpen, r.grossPnl, r.chargesTotal, r.netPnl, r.sttCtt, r.stampDuty]).toEqual([true, 0, 0, 0, 0, 0]);
  });

  /**
   * F1 (v4.3.0 wave 2I) — STORED CHARGES ARE NEVER REWRITTEN (owner ruling F1).
   *
   * Z2 wrote the IPO's exit charges over ALL TEN heads of every holding it synced,
   * so a holding carrying charges of its own lost them and its net P&L was
   * overstated — which feeds capital (CAP-IPO-LINK counts the TRADE), the tax
   * base, the ITR export and the /trades KPIs. Measured before: a holding stating
   * brokerage 20, DP 15.93 and mtfInterest 40 for the very sale the IPO records
   * came back as chargesTotal 2.06 with all three heads zeroed and net 497.94
   * instead of 424.07 ('[rc5 charges-wipe] CUR [17.4,0,15.34,0,482.6]').
   *
   * The rule as built: the IPO's figures are written only where nothing stated is
   * destroyed by them — the sync itself writes the close (the holding carried no
   * sale, so no sale charges either), or the holding states no charges at all.
   * And `mtfInterest` / `pledgeCharges` are NEVER written from here in any case:
   * the IPO model prices neither (an allotment is not brokered on margin and holds
   * no pledge), so a figure in those columns is money that really moved and it is
   * preserved verbatim, carried into the total the row states so the heads still
   * sum to `chargesTotal`.
   */
  it("F1 · the sync writes the IPO's charges only where nothing stated is destroyed: a no-sale or no-charges holding takes them, a holding stating its own for that sale keeps every head, and accrued MTF interest always survives", async () => {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const link = (name: string, tradeId: number, over: Record<string, unknown> = {}) =>
      legacy(name, "2026-03-02", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId, ...over });
    const sold = { isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500 };
    const save = async (id: number, name: string) => {
      const res = await post(formPayload(id, name, { exitDate: "2026-03-02" }));
      expect(res.status, name).toBe(200);
    };

    // (a) A holding with no sale of its own: the sync writes the close, so it
    //     writes that sale's charges — Z2's figure, unchanged.
    const a = openTrade("F1-NOSALE");
    await save(link("F1-NOSALE", a), "F1-NOSALE");
    const e = q.getIposComputed().rows.find((r) => r.name === "F1-NOSALE")!;
    expect([e.realised, e.netPnl]).toEqual([true, 497.94]);
    expect([tradeRow(a).chargesTotal, tradeRow(a).netPnl]).toEqual([e.charges, 497.94]);

    // (b) THE fix: a holding whose sale IS the IPO's exit and which states its own
    //     charges keeps every one of them, and nets gross − its own.
    const b = openTrade("F1-OWNCHG", { ...sold, chargesTotal: 75.93, brokerage: 20, dpCharges: 15.93, mtfInterest: 40, netPnl: 424.07 });
    await save(link("F1-OWNCHG", b), "F1-OWNCHG");
    const rb = tradeRow(b);
    expect([rb.chargesTotal, rb.brokerage, rb.dpCharges, rb.mtfInterest, rb.netPnl]).toEqual([75.93, 20, 15.93, 40, 424.07]);
    expect([rb.sttCtt, rb.stampDuty, rb.gst, rb.exchangeTxn, rb.sebi, rb.ipft, rb.pledgeCharges]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect([rb.grossPnl, rb.isOpen]).toEqual([500, false]); // everything else still syncs

    // (c) A holding whose sale is the IPO's exit but which states NO charges: the
    //     computed charges land, as Z2 built them.
    const c = openTrade("F1-ZERO", { ...sold, netPnl: 500 });
    await save(link("F1-ZERO", c), "F1-ZERO");
    expect([tradeRow(c).chargesTotal, tradeRow(c).netPnl]).toEqual([e.charges, 497.94]);

    // (d) An OPEN holding carrying purchase-side charges and ₹100 of accrued MTF
    //     interest. The sync writes the close, so the exit's own heads land over a
    //     row the IPO rewrites from the allotment (an allotment carries no
    //     brokerage — N15) — but the MTF interest is money that really moved: it
    //     survives verbatim and is part of the total the row states.
    const d = openTrade("F1-MTF", { chargesTotal: 141.5, brokerage: 20, dpCharges: 15.93, gst: 5.57, mtfInterest: 100, netPnl: -141.5 });
    await save(link("F1-MTF", d), "F1-MTF");
    const rd = tradeRow(d);
    expect([rd.mtfInterest, rd.chargesTotal, rd.netPnl]).toEqual([100, r2(e.charges + 100), r2(500 - e.charges - 100)]);
    const dHeads = [rd.brokerage, rd.sttCtt, rd.exchangeTxn, rd.sebi, rd.stampDuty, rd.ipft, rd.gst, rd.dpCharges, rd.mtfInterest, rd.pledgeCharges];
    expect(r2(dHeads.reduce((s, v) => s + v, 0))).toBe(rd.chargesTotal);
  });

  /**
   * ONE GROSS ARITHMETIC (v4.3.0 wave 2I), through the route. `computeIpo` booked
   * gross = r2((exit − cost) × qty) while the linked holding books
   * r2(r2(exit × qty) − r2(cost × qty)); for a 3-decimal price the extra rounding
   * of sellValue can round the other way, so /ipos read 150.01 where the Trades row,
   * capital, the tax pack and the ITR export read 150.02. The pure halves are pinned
   * in tests/ipo-link.test.ts; this is the two of them meeting on the row.
   */
  it("a 3-decimal issue and exit price: the IPO's [gross, charges, net] and the linked holding's are equal to the paisa", async () => {
    const trade = openTrade("GROSS-3DP");
    const id = legacy("GROSS-3DP", "2026-06-15", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    const res = await post(formPayload(id, "GROSS-3DP", {
      appliedPrice: "99.995", lotSize: "3", allottedQty: 3, exitPrice: "150.005", exitDate: "2026-03-02",
    }));
    expect(res.status).toBe(200);
    const e = q.getIposComputed().rows.find((r) => r.name === "GROSS-3DP")!;
    const r = tradeRow(trade);
    // THE assertion: one arithmetic on both sides.
    expect([e.grossPnl, e.charges, e.netPnl]).toEqual([r.grossPnl, r.chargesTotal, r.netPnl]);
    expect([r.sellValue, r.buyValue, r.grossPnl]).toEqual([450.02, 300, 150.02]);
  });

  /**
   * J4 (v4.3.0 wave 2J) — the sync OWNS a close it wrote and recomputes its charges;
   * a sale recorded in Trades keeps its own.
   *
   * F1 asked ONE question — "does this holding already state charges?" — of two
   * different histories, and answered both with "keep":
   *
   *   (a) the sale IS the IPO's exit AS STORED before this save: it is the sync's own
   *       earlier write (or a sale identical to it), so re-pricing the exit on /ipos
   *       moved the holding's price and gross while its charges stayed computed for the
   *       OLD sale — a stale figure the sync itself had written, and /ipos then read one
   *       net while the Trades row, capital (CAP-IPO-LINK counts the TRADE), the tax base
   *       and the ITR export read another;
   *   (b) the sale equals only the exit BEING RECORDED: the user recorded it in Trades
   *       first, with the broker's own charges. Those are the user's record and stay
   *       (owner ruling F1) — unchanged by this fix.
   *
   * Ownership is of the CLOSE and of the CHARGES on it: a holding whose sale is the
   * stored exit but whose heads are not the ones the sync priced for it (a contract
   * note's brokerage) still keeps every one of them — case (c) below, F1 (b)'s rule
   * under a re-price. `mtfInterest`/`pledgeCharges` are never written either way.
   */
  it("J4 · re-pricing an exit the sync itself closed recomputes its charges for the new exit, keeping accrued MTF interest; a sale recorded in Trades keeps its own charges", async () => {
    const r2n = (n: number) => Math.round(n * 100) / 100;
    const ipoRow = (name: string) => q.getIposComputed().rows.find((r) => r.name === name)!;

    // (a) A holding with no sale of its own, carrying 40 of accrued MTF interest, closed
    //     by the sync at 150: Z2's figure plus the 40 that really moved.
    const owned = openTrade("J4-OWNED", { chargesTotal: 40, mtfInterest: 40, netPnl: -40 });
    const id = legacy("J4-OWNED", "2026-03-02", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: owned });
    const sold = await post(formPayload(id, "J4-OWNED", { exitPrice: "150", exitDate: "2026-03-02" }));
    expect(sold.status).toBe(200);
    const at150 = ipoRow("J4-OWNED");
    expect([at150.charges, at150.netPnl]).toEqual([2.06, 497.94]);
    const first = tradeRow(owned);
    expect([first.sellQty, first.avgSellPrice, first.chargesTotal, first.netPnl, first.mtfInterest])
      .toEqual([10, 150, r2n(2.06 + 40), r2n(500 - 2.06 - 40), 40]);

    // The user corrects that exit to 155 on /ipos. The sync wrote this close and wrote
    // these charges, so both follow the new exit.
    const repriced = await post(formPayload(id, "J4-OWNED", { exitPrice: "155", exitDate: "2026-03-02" }));
    expect(repriced.status).toBe(200);
    const at155 = ipoRow("J4-OWNED");
    const r = tradeRow(owned);
    // THE assertions: price, gross AND charges follow the new exit; the 40 survives.
    expect([r.avgSellPrice, r.sellValue, r.grossPnl]).toEqual([155, 1550, 550]);
    expect([r.chargesTotal, r.netPnl]).toEqual([r2n(at155.charges + 40), r2n(550 - at155.charges - 40)]);
    expect([r.sttCtt, r.stampDuty, r.mtfInterest]).toEqual([r2n(at155.chargeBreakdown!.sttCtt), r2n(at155.chargeBreakdown!.stampDuty), 40]);
    const heads = (x: typeof r) => [x.brokerage, x.sttCtt, x.exchangeTxn, x.sebi, x.stampDuty, x.ipft, x.gst, x.dpCharges, x.mtfInterest, x.pledgeCharges];
    expect(r2n(heads(r).reduce((a, v) => a + v, 0))).toBe(r.chargesTotal);

    // Ten shares at 150 and at 155 both price to 2.06 (STT rounds to the rupee), so the
    // charges must also be seen MOVING: the same exit corrected again, to 500.
    const big = await post(formPayload(id, "J4-OWNED", { exitPrice: "500", exitDate: "2026-03-02" }));
    expect(big.status).toBe(200);
    const at500 = ipoRow("J4-OWNED");
    expect(at500.charges).not.toBe(at150.charges); // charge_config prices the bigger sale higher
    const rb = tradeRow(owned);
    expect([rb.avgSellPrice, rb.sellValue, rb.grossPnl]).toEqual([500, 5000, 4000]);
    expect([rb.chargesTotal, rb.netPnl]).toEqual([r2n(at500.charges + 40), r2n(4000 - at500.charges - 40)]);
    expect([rb.sttCtt, rb.stampDuty, rb.mtfInterest]).toEqual([r2n(at500.chargeBreakdown!.sttCtt), r2n(at500.chargeBreakdown!.stampDuty), 40]);
    expect(r2n(heads(rb).reduce((a, v) => a + v, 0))).toBe(rb.chargesTotal);

    // (b) The user recorded the sale in Trades first, with the broker's own 20 of
    //     brokerage, and then records that same exit on /ipos: the stored IPO carried no
    //     exit, so the sale is the user's record and every head of it stays.
    const byUser = openTrade("J4-TRADES", {
      isOpen: false, sellQty: 10, avgSellPrice: 155, sellValue: 1550, sellDate: "2026-03-02",
      grossPnl: 550, chargesTotal: 23.6, brokerage: 20, gst: 3.6, netPnl: 526.4,
    });
    const uid = legacy("J4-TRADES", "2026-03-02", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: byUser });
    const recorded = await post(formPayload(uid, "J4-TRADES", { exitPrice: "155", exitDate: "2026-03-02" }));
    expect(recorded.status).toBe(200);
    const u = tradeRow(byUser);
    expect([u.chargesTotal, u.brokerage, u.gst, u.netPnl]).toEqual([23.6, 20, 3.6, 526.4]);
    expect([u.sttCtt, u.stampDuty, u.dpCharges]).toEqual([0, 0, 0]);
    expect([u.isOpen, u.avgSellPrice, u.grossPnl]).toEqual([false, 155, 550]);

    // (c) The sale IS the stored exit, but its charges are the user's own record: a
    //     re-price follows on price and gross and rewrites not one stated head (F1).
    const stated = openTrade("J4-STATED", {
      isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02",
      grossPnl: 500, chargesTotal: 75.93, brokerage: 20, dpCharges: 15.93, mtfInterest: 40, netPnl: 424.07,
    });
    const sid = legacy("J4-STATED", "2026-03-02", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: stated });
    const restated = await post(formPayload(sid, "J4-STATED", { exitPrice: "155", exitDate: "2026-03-02" }));
    expect(restated.status).toBe(200);
    const s = tradeRow(stated);
    expect([s.chargesTotal, s.brokerage, s.dpCharges, s.mtfInterest]).toEqual([75.93, 20, 15.93, 40]);
    expect([s.sttCtt, s.stampDuty, s.gst]).toEqual([0, 0, 0]);
    expect([s.avgSellPrice, s.grossPnl, s.netPnl]).toEqual([155, 550, r2n(550 - 75.93)]);
  });

  /**
   * L3 (v4.3.0 wave 2L) — who wrote a close's charges is a FACT about the write,
   * not a recomputation.
   *
   * J4 proved the sync's ownership by RE-PRICING the stored exit against the LIVE
   * charge_config and comparing head by head. A rate correction in the charge editor
   * (invariant 3 makes charge_config the only rate source) changes what that
   * recomputation produces, so ownership was lost the moment the card moved — and
   * every later exit edit then kept `row.chargesTotal` while price, gross and net
   * followed the new exit. Measured (re-check probe): after a rate edit the same
   * stored sale priced 22.63 on /ipos beside 2.06 on the Trades row, and correcting
   * the exit to 500 left a ₹5,000 sale carrying the ₹1,500 sale's ₹2.06 bill — net
   * 3,997.94 against /ipos' 3,926.25, ₹71.69 that capital (CAP-IPO-LINK counts the
   * TRADE), the tax base and the ITR export all read too high.
   *
   * Ownership is now proved by the marker the sync writes into the holding's
   * `import_notes` beside the charges (the repo's provenance pattern — the
   * dedup-alias and stale-close sentences), which no rate edit can erase. The trade
   * editor drops it whenever it changes a charge head or the total, so a figure the
   * user's own save produced is never rewritten from here (owner ruling F1).
   */
  it("L3 · a charge_config correction between the sync's write and a later exit edit: the holding's charges still follow the new exit", async () => {
    const owned = openTrade("L3-RATE");
    const id = legacy("L3-RATE", "2026-03-02", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: owned });
    expect((await post(formPayload(id, "L3-RATE", { exitPrice: "150", exitDate: "2026-03-02" }))).status).toBe(200);
    const first = tradeRow(owned);
    expect([first.sellQty, first.avgSellPrice, first.chargesTotal]).toEqual([10, 150, 2.06]);

    // The user corrects the rate card — nothing about this trade or this IPO changed.
    const rates = t.sqlite
      .prepare("SELECT id, exchange_txn_pct, sebi_pct, gst_pct FROM charge_config WHERE segment = 'eq_delivery' AND exchange = 'NSE'")
      .all() as { id: number; exchange_txn_pct: number; sebi_pct: number; gst_pct: number }[];
    t.sqlite
      .prepare("UPDATE charge_config SET exchange_txn_pct = 0.01, sebi_pct = 0.001, gst_pct = 0.25 WHERE segment = 'eq_delivery' AND exchange = 'NSE'")
      .run();
    try {
      const at500 = await post(formPayload(id, "L3-RATE", { exitPrice: "500", exitDate: "2026-03-02" }));
      expect(at500.status).toBe(200);
      const e = q.getIposComputed().rows.find((r) => r.name === "L3-RATE")!;
      const r = tradeRow(owned);
      expect(e.charges).toBeGreaterThan(2.06); // the corrected card prices this sale higher
      // THE assertions (before: chargesTotal frozen at 2.06 on a ₹5,000 sale, and the
      // two pages reading different nets for the same sale).
      expect([r.avgSellPrice, r.sellValue, r.grossPnl]).toEqual([500, 5000, 4000]);
      expect([r.chargesTotal, r.netPnl]).toEqual([e.charges, e.netPnl]);
    } finally {
      const restore = t.sqlite.prepare("UPDATE charge_config SET exchange_txn_pct = ?, sebi_pct = ?, gst_pct = ? WHERE id = ?");
      for (const row of rates) restore.run(row.exchange_txn_pct, row.sebi_pct, row.gst_pct, row.id);
    }
  });

  it("L3 · a charge the TRADE EDITOR wrote is the user's: the marker goes with it and the next exit edit keeps their figure (F1)", async () => {
    const { IPO_SYNC_CHARGES_NOTE: NOTE } = await import("@/lib/analytics/ipo-link");
    const commit = await import("@/lib/import/commit");
    const trade = openTrade("L3-EDITED");
    const id = legacy("L3-EDITED", "2026-03-02", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: trade });
    expect((await post(formPayload(id, "L3-EDITED", { exitPrice: "150", exitDate: "2026-03-02" }))).status).toBe(200);
    const synced = tradeRow(trade);
    // The sync says so on the row itself, beside every other note.
    expect(synced.importNotes ?? "").toContain(NOTE);

    // The user edits the holding in Trades: the charges on it are now their save's.
    expect(commit.updateManualTrade(trade, { avgBuyPrice: 10 }).ok).toBe(true);
    const edited = tradeRow(trade);
    expect(edited.chargesTotal).not.toBe(synced.chargesTotal);
    // THE assertion: the marker went with the charges it described.
    expect(edited.importNotes ?? "").not.toContain(NOTE);

    // The exit is then corrected on /ipos: price and gross follow it, the charges do not.
    expect((await post(formPayload(id, "L3-EDITED", { exitPrice: "500", exitDate: "2026-03-02" }))).status).toBe(200);
    const after = tradeRow(trade);
    expect([after.avgSellPrice, after.grossPnl]).toEqual([500, 4000]);
    expect(after.chargesTotal).toBe(edited.chargesTotal);
  });

  /**
   * L3 (wave 2L) — the re-open half of the same question, and the inconsistency the
   * re-check named: the route refuses to REWRITE a contract note's heads on a
   * re-price (J4 case (c)) and zeroed all eight of them on a CLEAR. Clearing the
   * exit now re-opens only a close the sync owns; a sale the user recorded in Trades
   * with its own charges is theirs to re-open, in Trades.
   */
  it("L3 · clearing the exit over a close the USER recorded in Trades is refused 409 naming Trades; the contract note's charges survive", async () => {
    const stated = openTrade("L3-REOPEN-USER", {
      isOpen: false, sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02",
      grossPnl: 500, chargesTotal: 75.93, brokerage: 20, dpCharges: 15.93, mtfInterest: 40, netPnl: 424.07,
    });
    const id = legacy("L3-REOPEN-USER", "2026-03-02", { exitPrice: 150, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: stated });
    const before = tradeRow(stated);
    const ipoBefore = named("L3-REOPEN-USER")[0];
    const res = await post(formPayload(id, "L3-REOPEN-USER", { exitPrice: "", exitDate: "" }));
    // THE assertions (before: 200, the holding re-opened and brokerage 20 / DP 15.93 zeroed).
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("Trades");
    expect(tradeRow(stated)).toEqual(before);
    expect(named("L3-REOPEN-USER")[0]).toEqual(ipoBefore);
    expect([before.brokerage, before.dpCharges, before.chargesTotal]).toEqual([20, 15.93, 75.93]);
  });

  it("L3 · clearing an exit the SYNC wrote still re-opens the holding and takes that sale's charges off with it, MTF interest kept", async () => {
    const owned = openTrade("L3-REOPEN-SYNC", { chargesTotal: 40, mtfInterest: 40, netPnl: -40 });
    const id = legacy("L3-REOPEN-SYNC", "2026-03-02", { exitPrice: null, exitDate: null, listingPrice: 130, allotmentDate: "2019-01-10", tradeId: owned });
    expect((await post(formPayload(id, "L3-REOPEN-SYNC", { exitPrice: "150", exitDate: "2026-03-02" }))).status).toBe(200);
    expect(tradeRow(owned).isOpen).toBe(false);
    const cleared = await post(formPayload(id, "L3-REOPEN-SYNC", { exitPrice: "", exitDate: "" }));
    expect(cleared.status).toBe(200);
    const r = tradeRow(owned);
    expect([r.isOpen, r.sellQty, r.sellValue, r.grossPnl]).toEqual([true, 0, 0, 0]);
    expect([r.chargesTotal, r.sttCtt, r.brokerage, r.mtfInterest]).toEqual([40, 0, 0, 40]);
  });
});

/**
 * IPO-DAYS (v4.3.0 wave 2M, seam finding D2/F29) — the three OTHER days /ipos
 * takes from a keyboard.
 *
 * `appliedDate`, `allotmentDate` and `listingDate` were stored exactly as
 * typed, three lines from an exit date that is refused unless it is a real ISO
 * day. A day-first allotment date (`20-02-2026`) therefore went in verbatim and
 * then read as NO day at all: the IPO↔holding pairing could not recognise the
 * record as its holding's own (so a pre-4.3.0 Trash restore wrote no link and
 * the one sale stayed counted twice), and the ST/LT split that dates the
 * holding period (`lib/analytics/ipo.ts`, through `classifyTerm`) read the same
 * nothing and fell back to SHORT TERM.
 *
 * Each is now stored as the ISO day it states, and a non-empty value that
 * states no day is refused in the exit date's own words, naming the field. The
 * edit rule is L3's: refused on a create, or on an edit that CHANGES the value;
 * a value stored unreadable before this wave passes through, and clearing is
 * always allowed.
 */
describe("IPO-DAYS · the applied, allotment and listing days are stored as days, or refused", () => {
  let ipoRoute: typeof import("@/app/api/ipos/route");
  beforeAll(async () => {
    ipoRoute = await import("@/app/api/ipos/route");
    t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
  });
  const post = (body: unknown) =>
    ipoRoute.POST(new Request("http://local/api/ipos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const app = (over: Record<string, unknown> = {}) => ({
    name: "IPO-DAYS", exchange: "NSE", appliedPrice: 100, lotSize: 10, lotsApplied: 1,
    allotted: true, allottedQty: 10, listingPrice: 130, ...over,
  });
  const named = (name: string) => t.db.select().from(t.schema.ipos).all().filter((r) => r.name === name);
  const days = (name: string) => named(name).map((r) => [r.appliedDate, r.allotmentDate, r.listingDate]);

  it("stores a day-first date as the ISO day it states", async () => {
    // Measured before: stored verbatim — "20-02-2026" and "01/02/2026".
    const res = await post(app({ appliedDate: "01/02/2026", allotmentDate: "20-02-2026", listingDate: "2026-02-24" }));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(days("IPO-DAYS")).toEqual([["2026-02-01", "2026-02-20", "2026-02-24"]]);
  });

  it("refuses a value that states no day, naming the field, and saves nothing", async () => {
    const cases: [string, string, string][] = [
      ["allotmentDate", "2026-02-31", "allotment date"],
      ["allotmentDate", "0002-06-15", "allotment date"],
      ["appliedDate", "31-11-2026", "applied date"],
      ["listingDate", "not a date", "listing date"],
    ];
    for (const [field, value, label] of cases) {
      const res = await post(app({ name: "IPO-DAYS-BAD", [field]: value }));
      expect(res.status, `${field}=${value}`).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe(
        `The ${label} must be a real calendar day written year-month-day, such as 2026-06-15. Nothing was saved.`,
      );
    }
    expect(named("IPO-DAYS-BAD")).toHaveLength(0);
  });

  it("accepts a blank day as none", async () => {
    const res = await post(app({ name: "IPO-DAYS-BLANK", appliedDate: "", allotmentDate: "", listingDate: "" }));
    expect(res.status).toBe(200);
    expect(days("IPO-DAYS-BLANK")).toEqual([[null, null, null]]);
  });

  it("L3 · an edit that does not touch a legacy raw value is saved, the stored value passing through", async () => {
    // Written before this wave, by a restore or any path but the route.
    const id = t.db
      .insert(t.schema.ipos)
      .values({ accountId: 1, name: "IPO-DAYS-LEGACY", appliedPrice: 100, lotSize: 10, lotsApplied: 1, allotted: true, allottedQty: 10, allotmentDate: "2026-02-31" })
      .returning({ id: t.schema.ipos.id })
      .get()!.id;
    const res = await post(app({ id, name: "IPO-DAYS-LEGACY", allotmentDate: "2026-02-31", notes: "only a note changed" }));
    expect(res.status).toBe(200);
    expect(named("IPO-DAYS-LEGACY").map((r) => [r.notes, r.allotmentDate])).toEqual([["only a note changed", "2026-02-31"]]);

    // Changing it to another value it cannot read is still refused…
    const bad = await post(app({ id, name: "IPO-DAYS-LEGACY", allotmentDate: "0002-06-15", notes: "tried a new day" }));
    expect(bad.status).toBe(400);
    expect(named("IPO-DAYS-LEGACY").map((r) => [r.notes, r.allotmentDate])).toEqual([["only a note changed", "2026-02-31"]]);

    // …and fixing it day-first stores the day it states.
    const fixed = await post(app({ id, name: "IPO-DAYS-LEGACY", allotmentDate: "20-02-2026", notes: "fixed the day" }));
    expect(fixed.status).toBe(200);
    expect(named("IPO-DAYS-LEGACY").map((r) => [r.notes, r.allotmentDate])).toEqual([["fixed the day", "2026-02-20"]]);
  });
});
