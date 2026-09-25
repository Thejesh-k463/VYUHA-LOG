import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { executionHashOfPiece, hasStatedBillNote } from "@/lib/import/close-open-lots";
import etfList from "@/lib/data/etf-list.json";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";

/**
 * ════════════════════════════════════════════════════════════════════════════
 * v4.5.0 FIX-LIST WAVE — the half that needs a real database.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The pure half is tests/fixlist-v45-pure.test.ts. What is here, and why each
 * is here rather than there:
 *
 *   A2  broker-compare's "current" badge follows `planForView`. The badge is a
 *       predicate in the PAGE, so the page is rendered and its element tree
 *       walked — the same technique tests/seams-v43-fixF.test.ts uses.
 *   A3  ONE predicate feeds Data Quality's `broker_plan:<id>` issue AND the
 *       preview/calculator line: the pin is that the two CANNOT disagree —
 *       same database, same account list, and setting a plan removes both.
 *   A4  a broker-STATED bill survives a re-tag, through the REAL import path
 *       and the REAL `applyOverride`, all eleven stored values to the paisa.
 *   A7  a mid-un-close failure answers 409 `{ok:false, code:"FAILED"}` and the
 *       book is byte-identical. The failure is REAL, not mocked: a row planted
 *       on the execution's own hash makes the reinstating INSERT violate
 *       (account, broker, dedup_hash) — the same shape
 *       tests/auto-close-lifecycle.test.ts uses to prove the rollback.
 *   A8  the behaviour the one scope rule buys: a two-account book scoped to one.
 *   A9  the behaviour `isin` buys: an ETF priced by its ISIN through the REAL
 *       /api/charges/preview handler, against the etf_equity rate row read out
 *       of the temp database's own charge_config (invariant 3 — no literal).
 *   B1  the limits route's two numbers read by `parseFormNumber`.
 *
 * ONE temp database for the FILE (AGENTS.md Testing): `lib/db` caches its
 * connection on `globalThis`, so a second `openTempDb()` here would silently
 * reuse this one. Every case owns its own ACCOUNT instead.
 *
 * Measured locally 2026-09-22: the hook ~2 s (migrate + seed + eight dynamic
 * imports), every `it` well under 300 ms. The raised hook timeout is for the
 * Windows runner, > 15x slower on SQLite-file work.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let dq: typeof import("@/lib/queries/data-quality");
let tradesQ: typeof import("@/lib/queries/trades");
let ratesDb: typeof import("@/lib/engine/rates-db");
let rates: typeof import("@/lib/engine/rates");
let unClosePOST: (req: Request) => Promise<Response>;
let previewPOST: (req: Request) => Promise<Response>;
let limitsPOST: (req: Request) => Promise<Response>;
let brokerComparePage: () => unknown;
let ReportTr: unknown;

const A_PLUS = 8101; //  upstox, plan "plus"      — A2, A3
const A_BASIC = 8102; // upstox, no plan stated   — A2, A3
const A_BILL = 8103; //  A4, the stated bill
const A_UNCLOSE = 8104; // A7
const A_S1 = 8105; //    A8, book one
const A_S2 = 8106; //    A8, book two
const A_ETF = 8107; //   A9

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY = "2026-09-01";
const AC = { autoClose: true } as const;

// ── the element tree a server page returns (never the rendered string) ──────
type Elem = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const isElem = (n: unknown): n is Elem => !!n && typeof n === "object" && "type" in n && "props" in n;
function walk(node: unknown, visit: (e: Elem) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!isElem(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
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

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const rowsOf = (accountId: number) =>
  t.db
    .select()
    .from(t.schema.trades)
    .where(eq(t.schema.trades.accountId, accountId))
    .all()
    .sort((a, b) => a.id - b.id);
const rowById = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "dhan",
    isin: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    grossPnl: 0,
    unrealisedPnl: 0,
    buyDate: null,
    sellDate: null,
    productHint: "delivery",
    exchangeHint: "NSE",
    sourceFile: null,
    ...over,
  } as NormalizedTrade;
}
const buyRow = (symbol: string, qty: number, price: number, date: string) =>
  trade({ tradingsymbol: symbol, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date });
const sellRow = (symbol: string, qty: number, price: number, date: string) =>
  trade({ tradingsymbol: symbol, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date });
const parsed = (trades: NormalizedTrade[]): ParsedFile => ({
  sourceId: "dhan-gtr",
  broker: "dhan",
  format: "tradebook",
  trades,
  warnings: [],
});

beforeAll(async () => {
  t = await openTempDb("fixlist-v45-db", { seed: true });
  commit = await import("@/lib/import/commit");
  dq = await import("@/lib/queries/data-quality");
  tradesQ = await import("@/lib/queries/trades");
  ratesDb = await import("@/lib/engine/rates-db");
  rates = await import("@/lib/engine/rates");
  ({ POST: unClosePOST } = await import("@/app/api/trades/un-close/route"));
  ({ POST: previewPOST } = await import("@/app/api/charges/preview/route"));
  ({ POST: limitsPOST } = await import("@/app/api/risk/limits/route"));
  // v4.6.0 W3: the page body is the Costs hub's Broker Costs tab now.
  brokerComparePage = (await import("@/app/reports/costs/_tabs/broker-compare")).BrokerCompareTab as () => unknown;
  ({ ReportTr } = await import("@/components/ui/report-table"));

  t.db
    .insert(t.schema.accounts)
    .values([
      { id: A_PLUS, name: "Upstox Plus", broker: "upstox", brokerPlan: "plus", brokerPlanFrom: "2020-01-01" },
      { id: A_BASIC, name: "Upstox unstated", broker: "upstox" },
      { id: A_BILL, name: "stated bill", broker: "dhan" },
      { id: A_UNCLOSE, name: "un-close", broker: "dhan" },
      { id: A_S1, name: "scope one", broker: "dhan" },
      { id: A_S2, name: "scope two", broker: "dhan" },
      { id: A_ETF, name: "etf", broker: "zerodha" },
    ])
    .run();
}, 180_000);

afterAll(() => t?.cleanup());

// ═══ A2 · "current" is the broker AND the plan the book is priced on ════════

describe("A2 · broker-compare's `current` badge follows the account's resolved plan", () => {
  /** Every priced row of the report as `[row text, carries the current badge]`. */
  function rowsWithBadge(accountId: number): { text: string; current: boolean }[] {
    select(accountId);
    const out: { text: string; current: boolean }[] = [];
    walk(brokerComparePage(), (e) => {
      if (e.type !== ReportTr) return;
      const text = textLeaves(e.props.children).join(" ");
      if (!text.includes("Upstox")) return;
      out.push({ text, current: /\bcurrent\b/.test(text) });
    });
    return out;
  }

  const upstoxTrade = (accountId: number, sym: string) =>
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId, broker: "upstox", segment: "eq_delivery", bucket: "equity", symbol: sym, tradingsymbol: sym,
          buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01", buyOrderCount: 1,
          sellQty: 100, avgSellPrice: 110, sellValue: 11000, sellDate: "2026-08-10", sellOrderCount: 1,
          isOpen: false, grossPnl: 1000, chargesTotal: 40, netPnl: 960,
        }) as never,
      )
      .run();

  it("an Upstox PLUS account marks Plus current, and nothing else", () => {
    upstoxTrade(A_PLUS, "A2PLUS");
    const rows = rowsWithBadge(A_PLUS);
    const plus = rows.filter((r) => r.text.includes("Upstox Plus"));
    const basic = rows.filter((r) => !r.text.includes("Upstox Plus"));
    expect(plus.length, "the report prices the Plus tier as its own row").toBe(1);
    expect(basic.length, "…beside the free tier's row").toBe(1);
    // THE assertion (HEAD: the badge matched `plan === "default"`, so a Plus
    // account read "current" on the Basic row and compared its own bill with a
    // rate card it is not on).
    expect(plus[0]!.current, "the plan the book is actually priced on").toBe(true);
    expect(basic[0]!.current, "and not the one it is not").toBe(false);
  });

  it("an account that states NO plan still marks the free tier current", () => {
    upstoxTrade(A_BASIC, "A2BASIC");
    const rows = rowsWithBadge(A_BASIC);
    expect(rows.find((r) => r.text.includes("Upstox Plus"))!.current).toBe(false);
    expect(rows.find((r) => !r.text.includes("Upstox Plus"))!.current).toBe(true);
  });
});

// ═══ A3 · ONE predicate — Data Quality and the line cannot disagree ═════════

describe("A3 · the plan-pricing line and the Data Quality issue read ONE list", () => {
  /** The accounts Data Quality itself says have no plan, off its own issues. */
  const issueAccountIds = () =>
    dq
      .getDataQualityReport()
      .issues.filter((i) => i.code.startsWith("broker_plan:"))
      .map((i) => Number(i.code.split(":")[1]))
      .sort((a, b) => a - b);

  it("the same database gives the issue and the predicate the same account list", () => {
    select(0); // the All-accounts view: Data Quality lists every account
    const predicate = dq.getAccountsWithoutPlan().map((a) => a.id).sort((a, b) => a - b);
    expect(predicate, "a multi-plan broker's account that states no plan").toContain(A_BASIC);
    expect(predicate, "…and never one that states one").not.toContain(A_PLUS);
    // THE pin: two lists that could drift are one list.
    expect(issueAccountIds()).toEqual(predicate);
  });

  it("the line is account-scoped the ordinary way (invariant 8), and says nothing for an account that states a plan", () => {
    select(A_BASIC);
    const line = dq.getPlanPricingNotice()!;
    expect(line).toContain("Upstox's free plan");
    expect(line).toContain("Settings › Accounts");
    expect(line, "invariant 6 — it names the plan, never a price").not.toMatch(/₹/);

    select(A_PLUS);
    expect(dq.getPlanPricingNotice(), "this account has answered the question").toBeNull();
  });

  it("setting the plan removes BOTH the issue and the line — one predicate, one moment", () => {
    t.db.update(t.schema.accounts).set({ brokerPlan: "plus", brokerPlanFrom: "2020-01-01" }).where(eq(t.schema.accounts.id, A_BASIC)).run();
    select(A_BASIC);
    expect(dq.getPlanPricingNotice()).toBeNull();
    select(0);
    expect(issueAccountIds(), "the issue goes with it, in the same read").not.toContain(A_BASIC);
    // Put it back — the later cases do not depend on it, but the account's
    // stated shape is part of this file's fixture.
    t.db.update(t.schema.accounts).set({ brokerPlan: null, brokerPlanFrom: null }).where(eq(t.schema.accounts.id, A_BASIC)).run();
    select(0);
    expect(issueAccountIds()).toContain(A_BASIC);
  });
});

// ═══ A4 · a broker-STATED bill survives a re-tag ════════════════════════════

describe("A4 · a re-tag re-prices an ESTIMATE and never the broker's own bill", () => {
  /** The eleven stored values a re-tag must not touch on a stated row. */
  const BILL_COLS = [
    "chargesTotal", "brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty",
    "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges",
  ] as const;
  const billOf = (id: number) => {
    const r = rowById(id) as unknown as Record<string, unknown>;
    return Object.fromEntries(BILL_COLS.map((k) => [k, r[k]]));
  };

  /** A completed round trip whose FILE states the bill, verbatim. */
  const statedFile = (symbol: string, over: Partial<NormalizedTrade> = {}) =>
    parsed([
      trade({
        tradingsymbol: symbol,
        buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01",
        sellQty: 100, avgSellPrice: 120, sellValue: 12000, sellDate: "2026-08-20",
        grossPnl: 2000,
        // The broker's own contract note: ten heads that sum to the total.
        reportedCharges: {
          brokerage: 40, sttCtt: 12, exchangeTxn: 0.65, sebi: 0.02, stampDuty: 1,
          ipft: 0.01, gst: 7.32, dpCharges: 13.5, mtfInterest: 0, pledgeCharges: 0,
          total: 74.5,
        },
        ...over,
      }),
    ]);

  it("an import whose file STATES a total is marked, and the marker is provenance — not money", () => {
    select(A_BILL);
    commit.commitParsedFile(statedFile("A4STATED"), "stated.csv", null, A_BILL, AC);
    const row = rowsOf(A_BILL).find((r) => r.symbol === "A4STATED")!;
    expect(hasStatedBillNote(row.importNotes), "the row says whose figure it carries").toBe(true);
    expect([row.chargesTotal, row.netPnl], "…and carries the file's own figure verbatim").toEqual([74.5, 1925.5]);
  });

  it("a re-tag of that row keeps all eleven stored values to the paisa, and says so in the trail", () => {
    const id = rowsOf(A_BILL).find((r) => r.symbol === "A4STATED")!.id;
    const before = billOf(id);
    const beforeNet = rowById(id).netPnl;

    expect(commit.applyOverride(id, { segment: "eq_intraday" })).toBe(true);

    // THE assertions (HEAD before A4: every head is replaced by charge_config's
    // intraday estimate and netPnl moves with it — the journal then disagrees
    // with the contract note it was imported from).
    expect(billOf(id), "the broker's bill is the broker's bill, whatever the row is called").toEqual(before);
    expect(rowById(id).netPnl).toBe(beforeNet);
    expect(rowById(id).segment, "the CLASSIFICATION did move — that is what a re-tag is").toBe("eq_intraday");

    const audit = t.db
      .select()
      .from(t.schema.auditLog)
      .all()
      .filter((a) => a.entity === "trade" && a.entityId === id)
      .pop()!;
    expect(audit.summary).toContain("charges left as the broker stated them");
  });

  it("a row whose file stated NOTHING still re-prices at its account's plan", () => {
    select(A_BILL);
    commit.commitParsedFile(
      parsed([
        trade({
          tradingsymbol: "A4ESTIMATE",
          buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-08-01",
          sellQty: 100, avgSellPrice: 120, sellValue: 12000, sellDate: "2026-08-20",
          grossPnl: 2000,
        }),
      ]),
      "estimate.csv",
      null,
      A_BILL,
      AC,
    );
    const id = rowsOf(A_BILL).find((r) => r.symbol === "A4ESTIMATE")!.id;
    expect(hasStatedBillNote(rowById(id).importNotes), "no marker — this bill is ours").toBe(false);
    const before = billOf(id);

    expect(commit.applyOverride(id, { segment: "eq_intraday" })).toBe(true);
    // An estimate IS re-priced: delivery and intraday are not billed alike.
    expect(billOf(id), "the estimate follows the new classification").not.toEqual(before);
    const after = billOf(id) as Record<string, number>;
    const heads = BILL_COLS.filter((k) => k !== "chargesTotal").reduce((s, k) => s + (after[k] ?? 0), 0);
    expect(r2(heads), "…and the heads still sum to the total").toBe(after.chargesTotal);

    const audit = t.db
      .select()
      .from(t.schema.auditLog)
      .all()
      .filter((a) => a.entity === "trade" && a.entityId === id)
      .pop()!;
    expect(audit.summary, "and the trail does not claim a bill it did not keep").not.toContain("charges left as the broker");
  });

  it("a stated eq_mtf row re-tagged AWAY from MTF keeps its interest and the principal it was charged on", () => {
    select(A_BILL);
    commit.commitParsedFile(
      statedFile("A4MTF", {
        productHint: "mtf",
        reportedCharges: {
          brokerage: 40, sttCtt: 12, exchangeTxn: 0.65, sebi: 0.02, stampDuty: 1,
          ipft: 0.01, gst: 7.32, dpCharges: 13.5, mtfInterest: 120, pledgeCharges: 5,
          total: 199.5,
        },
      }),
      "mtf.csv",
      null,
      A_BILL,
      AC,
    );
    const id = rowsOf(A_BILL).find((r) => r.symbol === "A4MTF")!.id;
    t.db.update(t.schema.trades).set({ mtfFundedAmount: 7500 }).where(eq(t.schema.trades.id, id)).run();
    const before = billOf(id) as Record<string, number>;
    expect([before.mtfInterest, before.chargesTotal]).toEqual([120, 199.5]);

    expect(commit.applyOverride(id, { segment: "eq_delivery", isMtf: false })).toBe(true);
    const after = billOf(id) as Record<string, number>;
    // THE assertions (HEAD: a flip away from MTF zeroes interest and pledge and
    // rebuilds the total — the interest the broker actually charged, gone).
    expect(after, "the whole stated bill, including the interest half").toEqual(before);
    expect(rowById(id).mtfFundedAmount, "the principal the stated interest was charged on").toBe(7500);
    const heads = BILL_COLS.filter((k) => k !== "chargesTotal").reduce((s, k) => s + (after[k] ?? 0), 0);
    expect(r2(heads)).toBe(after.chargesTotal);
  });
});

// ═══ A7 · a mid-un-close failure ANSWERS, and the book does not move ════════

describe("A7 · POST /api/trades/un-close refuses instead of throwing", () => {
  /** Every row of the whole trades table, as one comparable string. */
  const bookChecksum = () =>
    JSON.stringify(
      t.db.select().from(t.schema.trades).all().sort((a, b) => a.id - b.id),
    );

  it("a failure part-way answers 409 `{ok:false, code:'FAILED'}` and the book is byte-identical", async () => {
    select(A_UNCLOSE);
    commit.commitParsedFile(parsed([buyRow("A7VEDL", 100, 100, "2026-04-01")]), "buy.csv", null, A_UNCLOSE, AC);
    commit.commitParsedFile(parsed([sellRow("A7VEDL", 100, 120, "2026-05-01")]), "sell.csv", null, A_UNCLOSE, AC);
    const converted = rowsOf(A_UNCLOSE)[0]!;
    const execHash = executionHashOfPiece(converted);
    expect([rowsOf(A_UNCLOSE).length, converted.isOpen], "the sale consumed the lot WHOLE").toEqual([1, false]);

    // A row planted on the execution's own hash: the reinstating INSERT now
    // violates (account_id, broker, dedup_hash) part-way through the
    // transaction. A REAL failure, not a mocked one.
    t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: A_UNCLOSE, broker: "dhan", dedupHash: execHash, tradingsymbol: "A7DECOY" }) as never)
      .run();

    const rowsBefore = t.db.select().from(t.schema.trades).all().length;
    const before = bookChecksum();

    const res = await unClosePOST(
      new Request("http://localhost:3011/api/trades/un-close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: A_UNCLOSE, broker: "dhan", execHash }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; code?: string; message?: string };

    // THE assertions (HEAD before A7: the throw propagated, Next answered the
    // client fetch with a 500 HTML page and the dialog said only "request
    // failed" — the user could not tell whether the journal had moved).
    expect([res.status, body.ok, body.code]).toEqual([409, false, "FAILED"]);
    expect(body.message).toContain("nothing was changed");
    expect(body.message).toContain("your book is exactly as it was");
    expect(t.db.select().from(t.schema.trades).all().length, "not one row was added or lost").toBe(rowsBefore);
    expect(bookChecksum(), "and not one column moved").toBe(before);
  });

  it("the happy path is untouched — 200 and the execution back as its own row", async () => {
    select(A_UNCLOSE);
    commit.commitParsedFile(parsed([buyRow("A7TCS", 100, 100, "2026-04-01")]), "buy2.csv", null, A_UNCLOSE, AC);
    commit.commitParsedFile(parsed([sellRow("A7TCS", 40, 120, "2026-05-01")]), "sell2.csv", null, A_UNCLOSE, AC);
    const lot = rowsOf(A_UNCLOSE).find((r) => r.symbol === "A7TCS" && r.buyQty > 0)!;
    const execHash = executionHashOfPiece(lot);

    const res = await unClosePOST(
      new Request("http://localhost:3011/api/trades/un-close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: A_UNCLOSE, broker: "dhan", execHash }),
      }),
    );
    expect([res.status, ((await res.json()) as { ok: boolean }).ok]).toEqual([200, true]);
    expect(rowById(lot.id).buyQty, "the lot came back whole").toBe(100);
  });

  it("an existing coded refusal still answers by its own code, not by FAILED", async () => {
    const res = await unClosePOST(
      new Request("http://localhost:3011/api/trades/un-close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: A_UNCLOSE, broker: "dhan", execHash: "f".repeat(40) }),
      }),
    );
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([404, "NOT_FOUND"]);
  });
});

// ═══ A8 · one scope rule, same rows ═════════════════════════════════════════

describe("A8 · the one scope predicate returns the book it is asked for", () => {
  it("a two-account book scoped to ONE returns that account's rows and no other", () => {
    for (const [acc, sym] of [
      [A_S1, "A8ONE"],
      [A_S2, "A8TWO"],
    ] as const) {
      t.db
        .insert(t.schema.trades)
        .values(tradeRow({ accountId: acc, broker: "dhan", symbol: sym, tradingsymbol: sym, isOpen: true, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: DAY }) as never)
        .run();
    }
    select(A_S1);
    const one = tradesQ.getTrades().filter((x) => x.symbol.startsWith("A8"));
    select(A_S2);
    const two = tradesQ.getTrades().filter((x) => x.symbol.startsWith("A8"));

    expect(one.map((x) => x.symbol)).toEqual(["A8ONE"]);
    expect(two.map((x) => x.symbol)).toEqual(["A8TWO"]);
    // Invariant 8's other half: 0 is a VIEW — it merges, it never filters.
    select(0);
    const all = tradesQ.getTrades().filter((x) => x.symbol.startsWith("A8")).map((x) => x.symbol).sort();
    expect(all).toEqual(["A8ONE", "A8TWO"]);
  });

  it("an EXPLICIT account list still wins over the selection, and an empty one is empty", () => {
    select(A_S1);
    expect(tradesQ.getTrades([A_S2]).filter((x) => x.symbol.startsWith("A8")).map((x) => x.symbol)).toEqual(["A8TWO"]);
    expect(tradesQ.getTrades([]).length, "no accounts is no rows, never every row").toBe(0);
  });
});

// ═══ A9 · an ETF is priced by the ISIN the row itself carries ═══════════════

type Snapshot = { byIsin?: Record<string, unknown> };
const HAVE_LIST = Object.keys((etfList as unknown as Snapshot).byIsin ?? {}).length > 0;

describe.skipIf(!HAVE_LIST)("A9 · /api/charges/preview prices NIFTYBEES on its ISIN", () => {
  const NIFTYBEES_ISIN = "INF204KB14I2";
  // A ticker the symbol path would NOT resolve — so the ISIN is the only thing
  // that can reach the etf_equity row.
  const SYMBOL = "A9ETFROW";
  const BUY_VALUE = 90_000;
  const SELL_VALUE = 100_000;

  it("the etf_equity STT row bills it, and that is not what an equity share pays", async () => {
    select(A_ETF);
    const id = t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId: A_ETF, broker: "zerodha", segment: "eq_delivery", bucket: "equity",
          symbol: SYMBOL, tradingsymbol: SYMBOL, isin: NIFTYBEES_ISIN,
          buyQty: 500, avgBuyPrice: 180, buyValue: BUY_VALUE, buyDate: "2026-08-01", buyOrderCount: 1,
          sellQty: 500, avgSellPrice: 200, sellValue: SELL_VALUE, sellDate: DAY, sellOrderCount: 1,
          isOpen: false, grossPnl: 10_000,
        }) as never,
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

    // The expectation's own source: the rate ROW out of this database's
    // charge_config, read by the engine's own reader (invariant 3, no literal).
    const map = ratesDb.loadRatesMap();
    const rowFor = (segment: string) =>
      rates.findRates(map, "zerodha" as Broker, segment as unknown as Segment, "NSE" as Exchange, DAY, "default");
    const etfStt = Math.round(rowFor("etf_equity").sttPct * SELL_VALUE);
    const shareStt = Math.round(rowFor("eq_delivery").sttPct * SELL_VALUE);
    expect(etfStt, "the two rows genuinely differ, so the case cannot pass by coincidence").not.toBe(shareStt);

    const res = await previewPOST(
      new Request("http://localhost:3011/api/charges/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          broker: "zerodha",
          tradingsymbol: SYMBOL,
          productHint: "delivery",
          exchange: "NSE",
          // A MOVED exit value, so the editor's "keep the stored bill" branch
          // does not answer and the engine prices it.
          buyValue: BUY_VALUE,
          sellValue: SELL_VALUE + 500,
          buyQty: 500,
          sellQty: 500,
          buyDate: "2026-08-01",
          sellDate: DAY,
          grossPnl: 10_500,
          tradeId: id,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const shown = (await res.json()) as { breakdown: { sttCtt: number }; keptCharges?: boolean };
    expect(shown.keptCharges, "the preview priced it rather than keeping a stored bill").toBeUndefined();
    // THE assertion (HEAD before A9: the route passed the SYMBOL alone, the
    // overlay never fired, and the dialog billed this unit at the equity-share
    // rate — a figure the save, which prices on `t.isin`, would not store).
    expect(shown.breakdown.sttCtt, "the etf_equity row's own rate, on the sale side").toBe(etfStt);
    expect(shown.breakdown.sttCtt).not.toBe(shareStt);
  });
});

// ═══ B1 · the limits route reads its numbers by the one rule ════════════════

describe("B1 · /api/risk/limits reads a typed number by `parseFormNumber`", () => {
  const post = async (body: Record<string, unknown>) => {
    const res = await limitsPOST(
      new Request("http://localhost:3011/api/risk/limits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const order = (over: Record<string, unknown>) => ({ segment: "eq_intraday", symbol: "RELIANCE", entry: "100", qty: "10", ...over });

  it("Indian grouping reads as the number it states", async () => {
    select(A_S1);
    const r = await post(order({ entry: "1,00,000", qty: "1" }));
    expect([r.status, r.json.ok]).toEqual([200, true]);
  });

  it("a decimal comma and an exponent are REFUSED, not read as numbers nobody typed", async () => {
    select(A_S1);
    // THE assertions (HEAD: "14,48" → 1448 and "1e5" → 100000, both accepted).
    for (const entry of ["14,48", "1e5"]) {
      const r = await post(order({ entry }));
      expect([entry, r.status, r.json.ok], entry).toEqual([entry, 400, false]);
      expect(r.json.message).toContain("Entry price and quantity are required");
    }
    // The refusal semantics are UNCHANGED for what was always unreadable.
    expect((await post(order({ entry: "abc" }))).status).toBe(400);
    expect((await post(order({ entry: "" }))).status).toBe(400);
  });

  it("an unreadable STOP is no stop at all — the guardrail fires rather than a level nobody typed", async () => {
    select(A_S1);
    const r = await post(order({ entry: "100", qty: "10", stop: "14,48" }));
    expect(r.status).toBe(200);
    const checks = (r.json.result as { checks: { rule: string }[] }).checks;
    expect(checks.map((c) => c.rule), "HEAD: a stop of 1448 — above the entry — and no warning at all").toContain("no_stop");
    // A readable stop is still a stop.
    const ok = await post(order({ entry: "100", qty: "10", stop: "95" }));
    expect(((ok.json.result as { checks: { rule: string }[] }).checks).map((c) => c.rule)).not.toContain("no_stop");
  });
});
