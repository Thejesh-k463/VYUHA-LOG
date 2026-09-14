import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { computeCharges } from "@/lib/engine/charges";
import { findRates, pricingDate } from "@/lib/engine/rates";
import { todayIstIso } from "@/lib/domain/trading-day";
// PURE and browser-safe (no DB) — safe to import statically beside openTempDb.
import { buildManualPreviewBody, type ManualPreviewInput } from "@/components/trades/manual-preview-body";

// createManualTrade is a server action; outside a request revalidatePath has
// no store to write to.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * R56 (v4.3.0 release audit): the charge PREVIEW priced every trade at TODAY's
 * rate epoch, while every SAVE prices it at the trade's own date through
 * `pricingDate` (commit.ts). A 2024-09-30 index option previewed 96.96 and
 * stored 83.37, so the figure shown before Save was not the figure saved.
 *
 * The expected totals are MEASURED against the seeded charge_config at run
 * time, never copied from the audit: other builders add epochs to the seed,
 * and a literal would pin their numbers rather than this rule.
 *
 * One temp database for the whole file (AGENTS.md Testing): lib/db caches its
 * connection on globalThis, so the route is imported dynamically AFTER it.
 */

let t: TempDb;
let POST: (req: Request) => Promise<Response>;
let loadRatesMap: typeof import("@/lib/engine/rates-db").loadRatesMap;
let createManualTrade: typeof import("@/app/trades/actions").createManualTrade;

beforeAll(async () => {
  t = await openTempDb("charges-preview-date", { seed: true });
  ({ POST } = await import("@/app/api/charges/preview/route"));
  ({ loadRatesMap } = await import("@/lib/engine/rates-db"));
  ({ createManualTrade } = await import("@/app/trades/actions"));
});

afterAll(() => t?.cleanup());

const DAY = "2024-09-30";

/** A Zerodha NSE index option, bought 75 @ 200 and sold 75 @ 300. */
const BASE = {
  broker: "zerodha",
  tradingsymbol: "OPT NIFTY 31 Oct 2024 25000 CE",
  segment: "index_option",
  exchange: "NSE",
  buyValue: 75 * 200,
  sellValue: 75 * 300,
  buyQty: 75,
  sellQty: 75,
  grossPnl: 75 * 100,
  isOpen: false,
} as const;

async function preview(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost:3011/api/charges/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    classification: { segment: string; exchange: string };
    breakdown: { total: number };
    grossPnl: number;
    netPnl: number;
  };
}

/** What a SAVE of the same trade stores: computeCharges at pricingDate's epoch. */
function savedTotal(dates: { buyDate?: string | null; sellDate?: string | null }) {
  const r = findRates(loadRatesMap(), "zerodha", "index_option", "NSE", pricingDate(dates, todayIstIso()));
  return computeCharges(
    {
      segment: "index_option",
      buyValue: BASE.buyValue,
      sellValue: BASE.sellValue,
      buyQty: BASE.buyQty,
      sellQty: BASE.sellQty,
      buyOrderCount: 1,
      sellOrderCount: 1,
      mtf: null,
    },
    r,
  ).total;
}

describe("the charge preview prices at the trade's own date (R56)", () => {
  it("a 2024-09-30 trade previews at the 2024-09-30 epoch — what the save stores", async () => {
    const atDay = savedTotal({ buyDate: DAY, sellDate: DAY });
    const atToday = savedTotal({});
    // Precondition: the seed prices these two dates differently (the
    // 2024-10-01 STT epoch), so the assertion below can tell them apart.
    expect(atDay).not.toBe(atToday);

    const got = await preview({ ...BASE, buyDate: DAY, sellDate: DAY });
    expect(got.breakdown.total).toBe(atDay);
    expect(got.netPnl).toBe(Math.round((BASE.grossPnl - atDay) * 100) / 100);
  });

  it("the sell date dominates, as pricingDate rules: buy before the epoch, sell after it", async () => {
    const got = await preview({ ...BASE, buyDate: DAY, sellDate: "2024-10-01" });
    expect(got.breakdown.total).toBe(savedTotal({ buyDate: DAY, sellDate: "2024-10-01" }));
    expect(got.breakdown.total).not.toBe(savedTotal({ buyDate: DAY, sellDate: DAY }));
  });

  it("an open position (no sell date) prices at its buy date", async () => {
    const got = await preview({ ...BASE, buyDate: DAY, sellDate: null });
    expect(got.breakdown.total).toBe(savedTotal({ buyDate: DAY }));
  });

  it("no dates at all falls back to today (IST), as before", async () => {
    const got = await preview({ ...BASE });
    expect(got.breakdown.total).toBe(savedTotal({}));
  });
});

/**
 * P6 (v4.3.0 wave-1 re-check): the manual form holds the ENTRY in its buy*
 * state and the EXIT in its sell* state, but createManualTrade files a written
 * (sell-direction) F&O trade's entry on the SELL side. The preview sent the
 * form's sides as they stood — 79.37 / −7579.37 for a trade saved at
 * 83.37 / +7416.63.
 *
 * Nothing here models the save: the body comes from the form's own builder,
 * the figure from the real route, and the stored row from the real server
 * action (createManualTrade → commitManualTrade) fed the FormData the form
 * submits for an F&O trade.
 */
describe("the manual form previews a written F&O trade on the sides the save stores (P6)", () => {
  const SYM = "OPT NIFTY 31 Oct 2024 25000 CE";

  type Leg = Pick<ManualPreviewInput, "direction" | "open" | "entryQty" | "entryPrice" | "entryDate" | "exitQty" | "exitPrice" | "exitDate">;

  /** The builder input the form's preview effect assembles for kind "fno". */
  const input = (leg: Leg): ManualPreviewInput => ({
    broker: "zerodha",
    tradingsymbol: SYM,
    kind: "fno",
    // Untouched Equity overrides. The form hands the builder its product /
    // segment / exchange STATE whatever the kind, and switching to F&O resets
    // none of it — the N24 test below feeds the stale values the switch leaves.
    productHint: null,
    segment: null,
    exchange: null,
    ownCapitalUsed: null,
    daysHeld: 0,
    ...leg,
  });

  /** The FormData the same form submits: hidden mirrors of the entry (buy*) and exit (sell*) state. */
  function formData(leg: Leg): FormData {
    const fd = new FormData();
    const fields: Record<string, string> = {
      broker: "zerodha",
      tradingsymbol: SYM,
      direction: leg.direction,
      lotSize: "75",
      buyQty: String(leg.entryQty),
      avgBuyPrice: String(leg.entryPrice),
      sellQty: leg.open ? "" : String(leg.exitQty),
      avgSellPrice: leg.open ? "" : String(leg.exitPrice),
      buyDate: leg.entryDate ?? "",
    };
    if (leg.open) fields.open = "true";
    else fields.sellDate = leg.exitDate ?? "";
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  }

  async function savedRow(leg: Leg) {
    const res = await createManualTrade({ ok: false, message: "" }, formData(leg));
    expect(res, res.message).toMatchObject({ ok: true });
    const row = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, res.tradeId!)).get();
    expect(row).toBeDefined();
    return row!;
  }

  it("a closed short (sell 75 @ 300 on 2024-09-30, bought back 75 @ 200 on 2024-10-03) previews what it saves", async () => {
    const leg: Leg = {
      direction: "sell", open: false,
      entryQty: 75, entryPrice: 300, entryDate: DAY,
      exitQty: 75, exitPrice: 200, exitDate: "2024-10-03",
    };
    const got = await preview({ ...buildManualPreviewBody(input(leg)) });
    const row = await savedRow(leg);

    expect(got.classification).toMatchObject({ segment: row.segment, exchange: row.exchange });
    expect(got.breakdown.total).toBe(row.chargesTotal);
    expect(got.grossPnl).toBe(row.grossPnl);
    expect(got.netPnl).toBe(row.netPnl);
    // The re-check's measured figures on this seed (reverting the side map
    // previews 79.37 / −7579.37 against them).
    expect([row.chargesTotal, row.netPnl]).toEqual([83.37, 7416.63]);
  });

  it("an open short (sell 75 @ 300 on 2024-09-30) previews the entry charges it saves", async () => {
    const leg: Leg = {
      direction: "sell", open: true,
      entryQty: 75, entryPrice: 300, entryDate: DAY,
      exitQty: 0, exitPrice: 0, exitDate: null,
    };
    const got = await preview({ ...buildManualPreviewBody(input(leg)) });
    const row = await savedRow(leg);

    expect(row.isOpen).toBe(true);
    expect(got.breakdown.total).toBe(row.chargesTotal);
    expect(got.netPnl).toBe(row.netPnl);
    // Measured by the re-check; the unfixed preview gave 37.9.
    expect(row.chargesTotal).toBe(50.9);
  });

  it("the builder files a written trade's entry date on the sell side and a long's on the buy side (R56 swap)", () => {
    const legs = { entryQty: 75, entryPrice: 300, entryDate: DAY, exitQty: 75, exitPrice: 200, exitDate: "2024-10-03", open: false };
    expect(buildManualPreviewBody(input({ ...legs, direction: "sell" }))).toMatchObject({
      sellQty: 75, sellValue: 22500, sellDate: DAY,
      buyQty: 75, buyValue: 15000, buyDate: "2024-10-03",
      grossPnl: 7500,
    });
    expect(buildManualPreviewBody(input({ ...legs, direction: "buy" }))).toMatchObject({
      buyQty: 75, buyValue: 22500, buyDate: DAY,
      sellQty: 75, sellValue: 15000, sellDate: "2024-10-03",
      grossPnl: -7500,
    });
    // An open trade has no exit leg, whatever the form's exit state holds.
    expect(buildManualPreviewBody(input({ ...legs, direction: "sell", open: true }))).toMatchObject({
      sellQty: 75, sellDate: DAY, buyQty: 0, buyValue: 0, buyDate: null, grossPnl: 0, isOpen: true,
    });
  });

  /**
   * N24 (v4.3.0 wave-2 re-check): pick Segment "Equity delivery" and Exchange
   * "BSE" under Equity, then switch to F&O. The F&O form renders none of those
   * inputs, so the save's FormData carries none and createManualTrade
   * classifies the contract itself — but the preview effect still sent the
   * stale state, and priced the short as an equity delivery on BSE (57.05
   * previewed against 83.37 saved).
   */
  it("switching Equity-with-override → F&O: the preview carries none of the Equity overrides, and prices what the save stores (N24)", async () => {
    // Bought back @ 210, not 200: the P6 test above already saved the @ 200
    // short, and the save refuses a duplicate.
    const leg: Leg = {
      direction: "sell", open: false,
      entryQty: 75, entryPrice: 300, entryDate: DAY,
      exitQty: 75, exitPrice: 210, exitDate: "2024-10-03",
    };
    const OVERRIDES = { productHint: "delivery", segment: "eq_delivery", exchange: "BSE" };
    const stale = { ...input(leg), ...OVERRIDES };
    const body = buildManualPreviewBody(stale);

    const got = await preview({ ...body });
    const row = await savedRow(leg); // the F&O FormData: no product / segment / exchange field
    expect(got.breakdown.total).toBe(row.chargesTotal);
    expect(got.netPnl).toBe(row.netPnl);
    expect(got.classification).toMatchObject({ segment: row.segment, exchange: row.exchange });
    expect([row.segment, row.exchange]).toEqual(["index_option", "NSE"]);
    expect(body).toMatchObject({ productHint: null, segment: null, exchange: null });
    // Floor: the route prices the leaked overrides differently, so the
    // equalities above can tell a stale body from a clean one.
    expect((await preview({ ...body, ...OVERRIDES })).breakdown.total).not.toBe(row.chargesTotal);

    // The Equity form still sends its overrides, untouched.
    expect(buildManualPreviewBody({ ...stale, kind: "equity" })).toMatchObject({
      productHint: "delivery", segment: "eq_delivery", exchange: "BSE",
    });
  });
});

/**
 * The route can only price what it is sent. These pins read the three callers'
 * source, the way tests/exit-trigger-writers.test.ts does, and fail if a form
 * stops sending the dates its save will price at.
 */
describe("every preview caller sends the dates its save prices at", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  /** The JSON body handed to /api/charges/preview in a component. */
  const previewBody = (src: string) => {
    const at = src.indexOf('"/api/charges/preview"');
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("}),", at));
  };

  // Re-pinned for P6 (was: the body merely contained "buyDate:" / "sellDate:",
  // which stayed green with the short-F&O date swap removed — the re-check's
  // "manual swap mutant"). The swap and the side map now live in the pure
  // builder, pinned by behaviour above; this pins that the form hands the
  // builder its ENTRY/EXIT state and the SAME direction its hidden input
  // submits, and sends nothing but the builder's body.
  it("manual-trade-form: controlled dates, handed to the builder as entry/exit with the submitted direction", () => {
    const src = read("components/trades/manual-trade-form.tsx");
    expect(src).toMatch(/name="buyDate" type="date" value=\{buyDate\}/);
    expect(src).toMatch(/name="sellDate" type="date" value=\{sellDate\}/);
    expect(src).toMatch(/import \{ buildManualPreviewBody \} from "@\/components\/trades\/manual-preview-body"/);
    expect(src).toMatch(/name="direction" value=\{kind === "fno" \? direction : "buy"\}/);

    const at = src.indexOf("buildManualPreviewBody({");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf("});", at));
    expect(call).toMatch(/direction: kind === "fno" \? direction : "buy"/);
    // Shorthand properties, not bare words: `open: false` or `kind: "equity"`
    // in the call would stay green under /\bopen\b/ (wave-2 re-check).
    expect(call).toMatch(/(?:^|[\s{,])open,/);
    expect(call).toMatch(/(?:^|[\s{,])kind,/);
    expect(call).toMatch(/entryQty: bq, entryPrice: bp, entryDate: buyDate \|\| null/);
    expect(call).toMatch(/exitQty: sq, exitPrice: sp, exitDate: sellDate \|\| null/);

    // The fetch sends the builder's body and re-maps no side of its own.
    const fetchAt = src.indexOf('"/api/charges/preview"');
    expect(fetchAt).toBeGreaterThan(at);
    const effect = src.slice(fetchAt, src.indexOf("]);", fetchAt));
    expect(effect).toMatch(/body: JSON\.stringify\(body\)/);
    expect(effect).not.toMatch(/buyValue:|buyDate:|sellDate:/);
    const deps = effect.slice(effect.lastIndexOf("["));
    for (const d of ["buyDate", "sellDate", "kind", "direction", "open"]) expect(deps).toMatch(new RegExp(`\\b${d}\\b`));
  });

  it("edit-trade-dialog sends its buyDate / sellDate state", () => {
    const body = previewBody(read("components/trades/edit-trade-dialog.tsx"));
    expect(body).toMatch(/buyDate:/);
    expect(body).toMatch(/sellDate:/);
  });

  it("close-trade-dialog sends the dates closePosition will store (the exit on the covering side)", () => {
    const body = previewBody(read("components/trades/close-trade-dialog.tsx"));
    expect(body).toMatch(/buyDate: isShort \? exitIso : trade\.buyDate/);
    expect(body).toMatch(/sellDate: isShort \? trade\.sellDate : exitIso/);
  });
});
