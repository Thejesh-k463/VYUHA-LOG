import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { istWallClockIso } from "@/lib/domain/trading-day";
import { CURRENCY_PAIRS } from "@/lib/domain/currency-pairs";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";
import { alertFeedState, alertsGate } from "@/lib/telegram/alert-gate";
import { CURRENCY_NOT_PRICED, currencyRefusalsOf, parseZerodha } from "@/lib/import/parsers/zerodha";
import { normalizeKiteTrades, toParsedFile, type KiteTradeRow } from "@/lib/import/api/kite";

/**
 * SEAM PASS — v4.7.0 RELEASE-AUDIT FIX WAVE, second database (tests/seams-v47-fix.test.ts holds
 * S1–S4 and S6; a restore replaces the book, so it lives in a file of its own — AGENTS.md
 * Testing, "one temp database per FILE").
 *
 * | # | crossing value                          | producer file:line                                            | consumer file:line                                              | unit / type          | case |
 * |---|-----------------------------------------|---------------------------------------------------------------|-----------------------------------------------------------------|----------------------|------|
 * | 5 | a STORED open currency row (pre-4.7)    | lib/import/commit.ts commitParsedFile ← kite.ts normalizeKiteTrades (the pre-wave CDS→NSE shape) | FD app/api/import/route.ts:146-169 / broker/route.ts:1509-1526 (strandedCurrencyNotes) | trades.symbol / tradingsymbol | S5a, S5b |
 * | 5 | parsed → refused contracts (WeakMap)    | FD lib/import/parsers/zerodha.ts withCurrencyRefusals         | FD app/api/import/route.ts:152 currencyRefusalsOf(parsed)       | ParsedFile identity  | S5a |
 * | 5 | the same stored row, at the alert gate  | the writer above                                              | FC1 lib/telegram/alert-gate.ts:197-200 (isCurrencyPair)         | trades.symbol        | S5c |
 * | 5 | ONE list: refusal (FD) = skip (FC1)     | lib/domain/currency-pairs.ts (orchestrator → FC)              | zerodha.ts isCurrencyContract / alert-gate.ts                   | upper-case symbol    | S5d |
 * | 5 | the NIFTY future beside it               | parsers → previewParsedFile                                   | the preview row's charges / net                                 | rupees               | S5a, S5b |
 * | 7 | clinic_experiments ABSENT in a backup    | lib/backup.ts dumpDatabase (a pre-4.7 envelope has no key)    | FC1 lib/backup.ts:297-310 restore → lib/queries/edge-clinic.ts listExperiments / getClinicState | status text | S7 |
 *
 * NOT TESTED HERE (FE's concurrent mappers): the Angel One / Upstox / OpenAlgo currency refusals
 * (`app/api/import/broker/route.ts`'s upstox block is FE's) — out of this pass by instruction.
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let fileRoute: typeof import("@/app/api/import/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");
let backup: typeof import("@/lib/backup");
let clinicQ: typeof import("@/lib/queries/edge-clinic");
let accountsRoute: typeof import("@/app/api/accounts/route");

const A = 11; // holds the OPEN USDINR future a pre-4.7 Kite pull stored
const B = 12; // holds nothing currency
const NOW = new Date(istWallClockIso("2026-10-07", "10:42"));
type Msg = Record<string, unknown>;

// Measured locally 2026-10-05: migrate + seed + the two import routes' graphs ≈ 2.5 s; 120 s is for
// the Windows CI runner (> 15× slower on SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("seams-v47-fix-b", { seed: true });
  commit = await import("@/lib/import/commit");
  fileRoute = await import("@/app/api/import/route");
  brokerRoute = await import("@/app/api/import/broker/route");
  backup = await import("@/lib/backup");
  clinicQ = await import("@/lib/queries/edge-clinic");
  accountsRoute = await import("@/app/api/accounts/route");
  t.db.insert(t.schema.accounts).values([
    { id: A, name: "Has currency", isDefault: false },
    { id: B, name: "No currency", isDefault: false },
  ]).run();
}, 120_000);
afterAll(() => {
  vi.unstubAllGlobals();
  t?.cleanup();
});
afterEach(() => vi.unstubAllGlobals());

/* ─────────────────────────── fixtures ─────────────────────────── */

const kiteFill = (tradingsymbol: string, exchange: string, transaction_type: string, quantity: number, average_price: number): KiteTradeRow =>
  ({ tradingsymbol, exchange, product: "NRML", transaction_type, quantity, average_price, fill_timestamp: "2026-10-05 10:00:00" }) as KiteTradeRow;

/** The Console tradebook (Auction is its in-content fingerprint). */
const TB_HEAD = "Symbol,ISIN,Trade Date,Exchange,Segment,Series,Trade Type,Auction,Quantity,Price,Trade ID,Order ID,Order Execution Time";
const TB_NIFTY = [
  "NIFTY26OCTFUT,,2026-10-01,NFO,FO,,buy,false,75,25000,T1,O1,2026-10-01 09:20:00",
  "NIFTY26OCTFUT,,2026-10-01,NFO,FO,,sell,false,75,25100,T2,O2,2026-10-01 14:20:00",
];
/** The SELL that closes the position a pre-4.7 import left open. */
const TB_USDINR_SELL = "USDINR26OCTFUT,,2026-10-01,CDS,CDS,,sell,false,1,84.1,T3,O3,2026-10-01 10:00:00";
const tradebook = (rows: string[]) => `${[TB_HEAD, ...rows].join("\n")}\n`;

function postFile(accountId: number, csv: string): Promise<Response> {
  const fd = new FormData();
  fd.append("file", new File([csv], "zerodha-tradebook.csv", { type: "text/csv" }));
  fd.append("mode", "preview");
  fd.append("accountId", String(accountId));
  return fileRoute.POST(new Request("http://local/api/import", { method: "POST", body: fd }));
}
function postBroker(body: Msg): Promise<Response> {
  return brokerRoute.POST(
    new Request("http://localhost/api/import/broker", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  );
}
const strandedOf = (warnings: string[]) => warnings.filter((w) => /is still open from an earlier import/.test(w));
const refusalOf = (warnings: string[]) => warnings.filter((w) => w.includes(CURRENCY_NOT_PRICED));
type PreviewRow = { tradingsymbol: string; segment: string; exchange: string; chargesTotal: number; netPnl: number; grossPnl: number };
const niftyOf = (rows: PreviewRow[]) => {
  const r = rows.find((x) => x.tradingsymbol === "NIFTY26OCTFUT");
  if (!r) throw new Error("no NIFTY row in the preview");
  return { segment: r.segment, exchange: r.exchange, grossPnl: r.grossPnl, chargesTotal: r.chargesTotal, netPnl: r.netPnl };
};

/* ═══════════ S5 — a currency row stored before v4.7.0, met by FD's refusal and FC1's gate ═══════════ */

describe("S5 — the OPEN USDINR future a pre-4.7 Kite pull stored: named only in its own account, never alerted, and the NIFTY future beside it priced as before", () => {
  beforeAll(async () => {
    // THE PRE-4.7 WRITE, through the REAL pipeline: the old Kite normaliser folded CDS into NSE
    // (`exchangeOf`: NSE | NFO | CDS → "NSE"), which is exactly what today's normaliser still does for
    // an NFO fill — so the BUY is normalised as NFO and committed the way it was then.
    const old = normalizeKiteTrades([kiteFill("USDINR26OCTFUT", "NFO", "BUY", 1, 84)]);
    expect(old).toHaveLength(1);
    commit.commitParsedFile(toParsedFile(old), "kite-api-2026-09-30", null, A);
    // A pasted-token Kite connection in each book, through the REAL broker route (for S5b).
    for (const acct of [A, B]) {
      const saved = await postBroker({ action: "save", broker: "zerodha", accountId: acct, apiKey: `kite-key-${acct}`, accessToken: `kite-token-${acct}` });
      expect(saved.status, `save in ${acct}`).toBe(200);
    }
  }, 30_000);

  it("S5a (writer → the stored row): an OPEN NSE future in account A whose stored symbol IS the pair", () => {
    const rows = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, A)).all();
    expect(rows.map((r) => ({ s: r.symbol, ts: r.tradingsymbol, ex: r.exchange, seg: r.segment, open: r.isOpen }))).toEqual([
      { s: "USDINR", ts: "USDINR26OCTFUT", ex: "NSE", seg: "future", open: true },
    ]);
  });

  it("S5a (Zerodha file → file route): the closing SELL is refused; account A's note names the stranded row, B's does not; NIFTY is priced exactly as a file without the SELL", async () => {
    const parsed = parseZerodha({ filename: "zerodha-tradebook.csv", text: tradebook([...TB_NIFTY, TB_USDINR_SELL]), buffer: undefined } as never);
    expect(currencyRefusalsOf(parsed)).toEqual(["USDINR26OCTFUT"]);
    const inA = (await (await postFile(A, tradebook([...TB_NIFTY, TB_USDINR_SELL]))).json()) as { warnings: string[]; preview: { rows: PreviewRow[] } };
    const inB = (await (await postFile(B, tradebook([...TB_NIFTY, TB_USDINR_SELL]))).json()) as { warnings: string[]; preview: { rows: PreviewRow[] } };
    const plainA = (await (await postFile(A, tradebook(TB_NIFTY))).json()) as { warnings: string[]; preview: { rows: PreviewRow[] } };
    expect(strandedOf(inA.warnings)).toEqual([
      "USDINR26OCTFUT is still open from an earlier import — close or delete it by hand; Vyuha no longer prices currency.",
    ]);
    expect(strandedOf(inB.warnings)).toEqual([]);
    expect(refusalOf(inB.warnings)).toHaveLength(1);
    expect(inA.preview.rows.map((r) => r.tradingsymbol)).toEqual(["NIFTY26OCTFUT"]);
    expect(niftyOf(inA.preview.rows)).toEqual(niftyOf(plainA.preview.rows));
    expect(niftyOf(inB.preview.rows)).toEqual(niftyOf(plainA.preview.rows));
    expect(niftyOf(plainA.preview.rows).chargesTotal).toBeGreaterThan(0);
  });

  it("S5b (Kite pull → broker route): the CDS SELL is refused and counted; A's summary names the stranded row, B's does not; NIFTY unchanged", async () => {
    const answer = (fills: KiteTradeRow[]) => async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://api.kite.trade/trades") {
        return new Response(JSON.stringify({ status: "success", data: fills }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`TEST GUARD: S5b reached an unexpected host ${url}`);
    };
    const NIFTY = [kiteFill("NIFTY26OCTFUT", "NFO", "BUY", 75, 25000), kiteFill("NIFTY26OCTFUT", "NFO", "SELL", 75, 25100)];
    const pull = async (acct: number, fills: KiteTradeRow[]) => {
      vi.stubGlobal("fetch", answer(fills));
      const res = await postBroker({ action: "pull", broker: "zerodha", mode: "preview", accountId: acct });
      const json = (await res.json()) as Msg;
      expect(res.status, JSON.stringify(json).slice(0, 300)).toBe(200);
      return json as { warnings?: string[]; preview?: { rows: PreviewRow[] } } & Msg;
    };
    const withA = await pull(A, [...NIFTY, kiteFill("USDINR26OCTFUT", "CDS", "SELL", 1, 84.1)]);
    const withB = await pull(B, [...NIFTY, kiteFill("USDINR26OCTFUT", "CDS", "SELL", 1, 84.1)]);
    const plain = await pull(A, NIFTY);
    const warn = (j: { warnings?: string[] }) => j.warnings ?? [];
    expect(refusalOf(warn(withA))).toEqual([
      `1 currency derivative fill was refused — ${CURRENCY_NOT_PRICED} (no charge profile covers them), so nothing was imported for: USDINR26OCTFUT.`,
    ]);
    expect(strandedOf(warn(withA))).toHaveLength(1);
    expect(strandedOf(warn(withB))).toEqual([]);
    expect(niftyOf(withA.preview!.rows)).toEqual(niftyOf(plain.preview!.rows));
    expect(niftyOf(withB.preview!.rows)).toEqual(niftyOf(plain.preview!.rows));
  });

  it("S5c (the stored row → FC1's gate): as the alert job projects it, the USDINR row is never alertable; a cash row beside it is", () => {
    t.db.insert(t.schema.trades).values(tradeRow({ accountId: A, symbol: "RELIANCE", tradingsymbol: "RELIANCE", buyQty: 1, avgBuyPrice: 3000, isOpen: true, slPlanned: 2900 })).run();
    const open = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, A)).all().filter((r) => r.isOpen);
    // The stored USDINR row gets the same recorded stop a user would have typed.
    const positions = open.map((r) => ({ exchange: r.exchange, segment: r.segment, symbol: r.symbol, hasLevel: true }));
    const gate = alertsGate({
      pro: true, telegramEnabled: true, telegramAckVersion: TELEGRAM_DISCLOSURE.version, alertsEnabled: true, hasCredentials: true,
      feed: alertFeedState({ stored: "openalgo", effective: "openalgo" }), windowFrom: null, windowTo: null, positions, now: NOW,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(Object.fromEntries(open.map((r, i) => [r.symbol, gate.alertable[i]]))).toEqual({ USDINR: false, RELIANCE: true });
  });

  it.each(CURRENCY_PAIRS.flatMap((p) => [`${p}26OCTFUT`, `${p}26OCT90CE`]))(
    "S5d one list — %s: the Console P&L refuses it (FD) AND the row the commit pipeline stores for it is skipped by the gate (FC1)",
    (contract) => {
      const csv = `Symbol,ISIN,Buy Quantity,Sell Quantity,Buy Value,Sell Value,Realized P&L\n${contract},,1,1,100,101,1\n`;
      const parsed = parseZerodha({ filename: "zerodha-console-pnl.csv", text: csv, buffer: undefined } as never);
      expect(currencyRefusalsOf(parsed), "the importer let a currency contract through").toEqual([contract]);
      // What the pipeline would STORE for it (classify through the commit's own preview).
      const pre = commit.previewParsedFile(toParsedFile(normalizeKiteTrades([kiteFill(contract, "NFO", "BUY", 1, 90)])), null, B, "probe");
      const row = pre.rows[0]!;
      expect([row.symbol, row.exchange], "the pipeline would store it as an NSE derivative whose symbol is the pair").toEqual([contract.slice(0, 6), "NSE"]);
      // A NIFTY future beside it keeps the gate answering per row (so a refusal cannot pass vacuously).
      const gate = alertsGate({
        pro: true, telegramEnabled: true, telegramAckVersion: TELEGRAM_DISCLOSURE.version, alertsEnabled: true, hasCredentials: true,
        feed: alertFeedState({ stored: "openalgo", effective: "openalgo" }), windowFrom: null, windowTo: null,
        positions: [
          { exchange: row.exchange, segment: row.segment, symbol: row.symbol, hasLevel: true },
          { exchange: "NSE", segment: "future", symbol: "NIFTY", hasLevel: true },
        ],
        now: NOW,
      });
      expect(gate.ok && gate.alertable, `stored as ${row.symbol} / ${row.segment}`).toEqual([false, true]);
    },
  );
});

/* ═══════════ S7 — a pre-4.7 backup restored over a book with an experiment on an account it lacks ═══════════ */

describe("S7 — restore of a backup WITHOUT clinic_experiments: the orphaned OPEN experiment is abandoned, and every Clinic reader agrees", () => {
  const Y = 13;
  let envelope: ReturnType<typeof import("@/lib/backup").dumpDatabase>;
  let orphan = 0;
  let own = 0;

  function experiment(accountId: number, cellKey: string): number {
    return t.db
      .insert(t.schema.clinicExperiments)
      .values({ accountId, cellKey, cellLabel: cellKey, hypothesis: `my own words on ${cellKey}`, startedAt: "2026-09-01", targetN: 20, status: "open" })
      .returning({ id: t.schema.clinicExperiments.id })
      .get().id;
  }
  async function select(id: number) {
    const res = await accountsRoute.POST(
      new Request("http://localhost/api/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "select", id }) }),
    );
    expect(res.status).toBe(200);
  }

  // One restore (data fixes + the rate-card refresh) in the hook: measured 0.6–0.9 s locally
  // (2026-10-05, the same figure tests/restore-orphan-experiments.test.ts records) — over the 3 s
  // hook budget never, over the 300 ms `it` budget by nature, hence here and not in an `it`.
  beforeAll(async () => {
    // BOOK X: this journal as a pre-4.7 build would have dumped it — every table it knew, no key.
    const dump = backup.dumpDatabase(false);
    envelope = { ...dump, tables: { ...dump.tables } };
    delete (envelope.tables as Record<string, unknown>).clinic_experiments;
    // Since that backup: a new book Y with an experiment open on it, and one on Primary.
    t.db.insert(t.schema.accounts).values({ id: Y, name: "Book Y", isDefault: false }).run();
    orphan = experiment(Y, "eq_intraday|setup:Breakout");
    own = experiment(1, "eq_intraday|setup:Breakout");
    const r = backup.restoreDatabase(envelope);
    expect(r.ok, r.message).toBe(true);
  }, 30_000);

  const rowOf = (id: number) => t.db.select().from(t.schema.clinicExperiments).where(eq(t.schema.clinicExperiments.id, id)).get();

  it("the restore abandons the orphan (account_id and the user's text kept) and leaves Primary's experiment open", () => {
    expect(t.db.select().from(t.schema.accounts).all().map((a) => a.id).sort((a, b) => a - b)).toEqual([1, A, B]);
    expect(rowOf(orphan)).toMatchObject({ status: "abandoned", accountId: Y, hypothesis: "my own words on eq_intraday|setup:Breakout" });
    expect(rowOf(own)).toMatchObject({ status: "open", accountId: 1 });
  });

  it("every Clinic reader agrees: no live account lists the orphan as open; the All view lists it as abandoned", async () => {
    for (const id of [1, A, B]) {
      await select(id);
      const open = clinicQ.listExperiments().filter((e) => e.status === "open").map((e) => e.id);
      expect(open, `account ${id}`).not.toContain(orphan);
      expect(clinicQ.getClinicState().experiments.map((e) => e.id), `account ${id}'s Clinic page`).not.toContain(orphan);
    }
    await select(0);
    const all = clinicQ.listExperiments();
    expect(all.find((e) => e.id === orphan)?.status).toBe("abandoned");
    expect(all.find((e) => e.id === own)?.status).toBe("open");
    // The checker the compute route runs never revives it.
    clinicQ.runExperimentChecks();
    expect(rowOf(orphan)?.status).toBe("abandoned");
  });

  it("a NEW book made after the restore (real accounts route) does not inherit the orphan, and can open its own experiment on that cell", async () => {
    const res = await accountsRoute.POST(
      new Request("http://localhost/api/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "upsert", name: "Book Z" }) }),
    );
    expect(res.status).toBe(200);
    const z = ((await res.json()) as { id: number }).id;
    expect(z, "AUTOINCREMENT handed the deleted book's id to a new one").not.toBe(Y);
    await select(z);
    expect(clinicQ.listExperiments()).toEqual([]);
    // The partial unique index (account, cell) WHERE open has no stale holder for the new book.
    expect(() => experiment(z, "eq_intraday|setup:Breakout")).not.toThrow();
  });
});
