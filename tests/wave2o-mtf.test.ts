import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * D11 (v4.3.0 fix wave 2O — mtf#7 ≡ seams#1, PRE-EXISTING) — /reports/broker-compare
 * STOPS PRICING A PRINCIPAL THE JOURNAL NEVER RECORDED.
 *
 * `app/reports/broker-compare/page.tsx` was the last `?? defaultMtfFundedAmount(…)`
 * reader of a trade row: a null-funded MTF trade was re-priced on 75–80% of its buy
 * value at TODAY's margin_config for every broker's card. And the estimate did not
 * stay in an "MTF int." cell — `compareBrokers` adds it into every broker's `total`,
 * hence `vsActual`, the `cheapest` pick and the headline "Headroom to save". So a
 * rupee figure on a Pro report was a function of the margin table, on the same book
 * where /risk says "not priced", /trades "funding not yet resolved" and (since wave
 * 2N) /equity, /targets and the Live Desk refuse to price at all — with no string
 * on the page saying any figure was an estimate (invariant 6).
 *
 * The page now passes what the row states (null → 0 at the engine boundary, where
 * `lib/engine/charges.ts:106` bills neither interest nor pledge), so every broker's
 * column omits the same rows' financing — the comparison stays like-for-like — and
 * the page STATES the omission once.
 *
 * `missing` is deliberately NOT used for such a row: it means "this broker cannot
 * price this trade", and counting it would drop the row's priceable brokerage and
 * STT too and blank `cheapest` / `maxSaving` for the whole report.
 *
 * ONE temp database per FILE (AGENTS.md Testing); the page reaches lib/db, so it is
 * imported dynamically after the helper sets VYUHA_DB_PATH.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let comparePage: () => unknown;

// Measured locally 2026-09-16: migrate + seed + the page's import graph ~2 s, inside
// the 3 s local hook budget. The raised timeout is for the Windows runner (> 15x
// slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("wave2o-mtf", { seed: true });
  // v4.6.0 W3: the page body is the Costs hub's Broker Costs tab now.
  comparePage = (await import("@/app/reports/costs/_tabs/broker-compare")).BrokerCompareTab as () => unknown;
}, 120_000);
afterAll(() => t?.cleanup());

// The React element tree a server page returns, walked for the strings it prints —
// never the rendered HTML string, so a figure is asserted where the page produced it.
type Elem = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const isElem = (n: unknown): n is Elem => !!n && typeof n === "object" && "type" in n && "props" in n;
function textLeaves(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textLeaves(n, out);
    return out;
  }
  if (isElem(node)) textLeaves(node.props.children, out);
  return out;
}
const pageText = () => textLeaves(comparePage()).join(" ").replace(/\s+/g, " ");

/** Set the eq_mtf own-margin % the page used to estimate an unrecorded principal from. */
function setOwnMargin(broker: string, pct: number) {
  const row = t.db
    .select()
    .from(t.schema.marginConfig)
    .where(and(eq(t.schema.marginConfig.broker, broker), eq(t.schema.marginConfig.segment, "eq_mtf")))
    .get();
  if (row) {
    t.db.update(t.schema.marginConfig).set({ marginPct: pct }).where(eq(t.schema.marginConfig.id, row.id)).run();
  } else {
    t.db.insert(t.schema.marginConfig).values({ broker, segment: "eq_mtf", marginPct: pct }).run();
  }
}

const mtfTrade = (symbol: string, mtfFundedAmount: number | null) =>
  t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        broker: "zerodha",
        bucket: "equity",
        segment: "eq_mtf",
        instrumentType: "equity",
        symbol,
        tradingsymbol: symbol,
        buyQty: 100,
        avgBuyPrice: 100,
        buyValue: 10000,
        buyDate: "2026-08-01",
        buyOrderCount: 1,
        sellQty: 100,
        avgSellPrice: 110,
        sellValue: 11000,
        sellDate: "2026-09-01",
        sellOrderCount: 1,
        isOpen: false,
        grossPnl: 1000,
        chargesTotal: 20,
        netPnl: 980,
        mtfFundedAmount,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;

describe("D11 — the broker comparison prices no financing the journal never recorded", () => {
  it("a margin_config edit moves NOTHING the page prints, and the omission is stated once", () => {
    mtfTrade("D11NULL", null);

    setOwnMargin("zerodha", 20);
    const at20 = pageText();
    setOwnMargin("zerodha", 50);
    const at50 = pageText();

    // THE assertion (on revert: the two differ — every broker's total, "vs
    // recorded", the cheapest pick and "Headroom to save" are functions of the
    // margin table for a row the journal never priced).
    expect(at50, "a figure on the report moved when the margin table moved").toBe(at20);

    // …and the page says what it left out, once.
    const sentence = "1 MTF trade states no funded amount";
    expect(at20).toContain(sentence);
    expect(at20.split(sentence).length - 1, "stated once, not per broker row").toBe(1);
  });

  it("recording the amount is what puts financing into the columns — and takes the sentence away", () => {
    const only = t.db.select().from(t.schema.trades).all()[0]!;
    const unrecorded = pageText();

    // The remedy the sentence names: state what the broker funded.
    t.db.update(t.schema.trades).set({ mtfFundedAmount: 6000 }).where(eq(t.schema.trades.id, only.id)).run();
    const recorded = pageText();

    // THE assertion: financing reaches the columns only from a recorded principal
    // (on revert both books were priced, the unrecorded one off margin_config).
    expect(recorded, "a stated principal really is priced").not.toBe(unrecorded);
    expect(recorded, "and nothing is left to disclose").not.toContain("states no funded amount");
    expect(unrecorded).toContain("1 MTF trade states no funded amount");
  });

  it("the plural, and a book with no MTF rows says nothing", () => {
    t.db.delete(t.schema.trades).run();
    const empty = pageText();
    expect(empty, "no MTF rows, no sentence").not.toContain("states no funded amount");

    mtfTrade("D11P1", null);
    mtfTrade("D11P2", null);
    expect(pageText()).toContain("2 MTF trades state no funded amount");
  });
});
