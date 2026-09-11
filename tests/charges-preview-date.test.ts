import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { computeCharges } from "@/lib/engine/charges";
import { findRates, pricingDate } from "@/lib/engine/rates";
import { todayIstIso } from "@/lib/domain/trading-day";

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

beforeAll(async () => {
  t = await openTempDb("charges-preview-date", { seed: true });
  ({ POST } = await import("@/app/api/charges/preview/route"));
  ({ loadRatesMap } = await import("@/lib/engine/rates-db"));
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
  return (await res.json()) as { breakdown: { total: number }; netPnl: number };
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

  it("manual-trade-form: controlled date inputs, sent, and in the effect's deps", () => {
    const src = read("components/trades/manual-trade-form.tsx");
    expect(src).toMatch(/name="buyDate" type="date" value=\{buyDate\}/);
    expect(src).toMatch(/name="sellDate" type="date" value=\{sellDate\}/);
    const body = previewBody(src);
    expect(body).toMatch(/buyDate:/);
    expect(body).toMatch(/sellDate:/);
    const deps = src.slice(src.indexOf("}),", src.indexOf('"/api/charges/preview"')));
    expect(deps.slice(0, deps.indexOf("]);"))).toMatch(/\bbuyDate\b[\s\S]*\bsellDate\b/);
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
