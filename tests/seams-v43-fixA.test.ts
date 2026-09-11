import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { computeSettlement, DEFAULT_SETTLEMENT_RATES, type SettlementInput } from "@/lib/analytics/settlement";
import { OPTIONS_HELP } from "@/lib/domain/options-help";
import { getStrategyDef } from "@/lib/analytics/strategy-catalogue";
import { buildStrategies, type PositionedLeg } from "@/lib/analytics/strategies";
import { NET_LABEL, optionNetPremium } from "@/components/strategies/strategy-copy";
import { pairLegs, type Leg } from "@/lib/import/pair-legs";
import { todayIstIso } from "@/lib/domain/trading-day";

/**
 * v4.3.0 FIX WAVE 1 — THE SEAMS OF A NINE-BUILDER WAVE (plan waves[0]).
 *
 * Nine builders owned disjoint file sets (W1-PULL, W1-DQ, W1-RATES, W1-SETTLE,
 * W1-HELP, W1-STRAT, W1-PAYTM, W1-PREVIEW, W1-UI). Disjoint sets prevent edit
 * conflicts and guarantee that no builder ran two halves of a crossing
 * together. This file runs them together.
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The stubs are framework and
 * network only: `next/cache` and `next/navigation` (no request, no mounted app
 * router) and `globalThis.fetch` (api.dhan.co). Every Dhan payload goes through
 * the real `dhanImportSource().fetchTrades()` and the real route handler
 * (app/api/import/broker/route.ts); every Data Quality close goes through the
 * real close-stale route; the risk panel's props come from the real
 * app/risk/page.tsx over ONE real migrated, seeded SQLite file. Assertions are
 * on the CONSUMER'S OUTPUT (stored rows, the stamp, rendered buttons, ₹
 * figures), never on "the value arrived".
 *
 * ── THE SEAM TABLE ───────────────────────────────────────────────────────────
 *
 *  # | crossing value                          | producer (file:line, builder)                 | consumer (file:line, builder)                          | unit / shape                          | test
 * ---|-----------------------------------------|-----------------------------------------------|--------------------------------------------------------|---------------------------------------|------
 *  1 | physicalStt, SHORT ITM stock option     | lib/analytics/settlement.ts:300 (SETTLE)      | lib/domain/options-help.ts:151 short-call risk (HELP)  | integer ₹; delivery STT on strike×qty | S1a
 *  2 | physicalStt, LONG ITM stock option      | lib/analytics/settlement.ts:300 (SETTLE)      | options-help.ts:125 long-call + :151 "both sides"      | integer ₹; delivery + exercise        | S1b
 *  3 | optionNetPremium N (+ = collected)      | components/strategies/strategy-copy.ts:344    | options-help.ts:226 collar payoff, strategy-           | ₹ total, signed                       | S2
 *    |                                         |   (STRAT) + strategies.ts computeStrategy     |   catalogue.ts:303 "+ N" (HELP)                        |                                       |
 *  4 | netTone(strategyId, N) → the chip       | strategy-copy.ts:228, strategy-card.tsx:45    | options-help.ts:226 "a net debit counted as negative"  | "credit" | "debit" | null             | S2
 *  5 | the alias-aware existing-hash set       | lib/import/commit.ts:437/:1007 + :1745 (DQ)   | app/api/import/broker/route.ts:1007-1013 (PULL, R27)   | sha1 hex set → nothingNew → ISO stamp | S3a
 *  6 | a re-served sale's dedup hash           | lib/import/api/dhan.ts /v2/positions (PULL)   | commit.ts:437 preview set (DQ)                         | sha1 hex, account-free                | S3a, S3c
 *  7 | accounts[].removable after a stale close| close-open-lots withStaleCloseNote via        | components/quality/duplicate-fix.tsx:192 (UI)          | boolean → a "Remove the copy" button  | S3b
 *    |                                         |   commit.ts:1745 → broker-identity.ts:346 (DQ)|                                                        |                                       |
 *  8 | StaleOpenView[]                         | lib/queries/data-quality.ts:28 (DQ)           | stale-lot-fix.tsx beside DuplicateFix on               | pairs → one button each               | S3b
 *    |                                         |                                               |   app/data-quality/page.tsx (DQ page, UI sibling)      |                                       |
 *  9 | lastPullAt / catchUpFrom per Dhan row   | route.ts:1013 R27 stamp + GET :319/:343 (PULL)| components/import/broker-connect.tsx:302 (UI, R47)     | ISO UTC instant → IST day             | S3c
 * 10 | a history fill after the R42 cutoff     | dhan.ts catchUpAfter / fetchTrades (PULL)     | commit.ts:1007 alias set (DQ)                          | "YYYY-MM-DD HH:MM:SS" IST             | S3c
 * 11 | PairedPosition.exchange (R71)           | lib/import/pair-legs.ts:467 (PAYTM)           | dhan.ts:719 exchangeHint → trades.exchange (PULL)      | "NSE" | "BSE"                         | S4 — DEFECT D1
 * 12 | DhanUnfetchedSpan {from,to,reason}      | dhan.ts:1217 (PULL) → GET route.ts:343        | broker-connect.tsx:317 unfetchedNotice (UI)            | ISO days; remedy is NOT on the wire   | S5 — D2 (fixed)
 * 13 | F&O STT epochs × pricingDate            | lib/db/seed-data.ts:128-134 (RATES)           | app/api/charges/preview/route.ts:59 (PREVIEW)          | fraction of premium → integer ₹       | S6
 * 14 | eq_delivery sttPct                      | charge_config (RATES) → app/risk/page.tsx:350 | settlement.ts:300 + expiry-obligations.tsx:274 (SETTLE)| fraction (0.001 = 0.1%)               | S7
 * 15 | charge_config after a restore           | lib/backup.ts:306 → seed-core.ts:204 (RATES)  | every other restored table + the preview route         | rows                                  | S8
 *
 * DATES. The Dhan seams run on a frozen clock: 15:00 and 18:00 IST on Tue
 * 8 Sep 2026, then 2026-09-10T19:00Z (00:30 IST on Fri 11 Sep), inside the
 * 18:30–24:00 UTC window where the IST day and the UTC day disagree.
 *
 * TWO SEAM DEFECTS, reported rather than fixed (this pass changes no code).
 * Each is an `it.fails` whose assertion is the RIGHT value: it passes while
 * the defect stands and goes red once it is fixed, which is the signal to flip
 * it to `it`.
 *
 *  D1 (S4) — R71's row venue never reaches a Dhan row. `normalizeDhanTrades`
 *     groups fills by `symbol|product` and stamps every position with
 *     `exchangeHint: exchangeOf(g.segment)` (lib/import/api/dhan.ts:719), the
 *     group's FIRST fill's venue, and never reads `pos.exchange`. A TCS bought
 *     on NSE and sold on BSE, plus a later BSE-only buy, is stored NSE / NSE.
 *     `pairLegs` (the R71 rule) says BSE / BSE.
 *  D2 (S5) — the card's kept-notice remedy contradicts the pull's own sentence.
 *     F-L1-3a moved the remedy to the day AFTER the last pull's own IST day
 *     (dhan.ts:1217). Only {from,to,reason} crosses GET (route.ts:343), so
 *     `unfetchedNotice` (broker-connect.tsx:317) still tells the user to
 *     "Import a Dhan tradebook for 12 Jun 2026". The pull itself says a
 *     tradebook for 2026-06-12 "would repeat the fills already imported from it".
 *     FIXED in the fix-wave-1 follow-up (2026-09-11): the card's remedy starts
 *     the day after `from` and a one-day span names no import; S5 is now `it`.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));
// DuplicateFix / StaleLotFix / SpotMarkEditor call `useRouter`, which needs a
// mounted app router. A framework stub, not a half of any seam under test.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
}));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let brokerRoute: typeof import("@/app/api/import/broker/route");
let closeStaleRoute: typeof import("@/app/api/data-quality/close-stale/route");
let previewRoute: typeof import("@/app/api/charges/preview/route");
let bc: typeof import("@/components/import/broker-connect");
let dhan: typeof import("@/lib/import/api/dhan");
let importer: typeof import("@/lib/import/commit");
let identity: typeof import("@/lib/import/broker-identity");
let dqQueries: typeof import("@/lib/queries/data-quality");
let backup: typeof import("@/lib/backup");
let DuplicateFix: typeof import("@/components/quality/duplicate-fix").DuplicateFix;
let StaleLotFix: typeof import("@/components/quality/stale-lot-fix").StaleLotFix;
let StrategyCard: typeof import("@/components/strategies/strategy-card").StrategyCard;
let ExpiryObligations: typeof import("@/components/risk/expiry-obligations").ExpiryObligations;
let riskPage: () => unknown;

const BOOK_A = 61; // S3a: stale-closed, then re-pulled the same day
const BOOK_B = 62; // S3b: the plain copy of the same broker records
const BOOK_C = 63; // S3c: stale-closed, then re-served across the R42 cutoff
const VENUE = 64; //  S4
const CLAMP = 65; //  S5
const RISK = 66; //   S7
const CLIENT = "1000000009";

beforeAll(async () => {
  t = await openTempDb("seams-v43-fixA", { seed: true });
  brokerRoute = await import("@/app/api/import/broker/route");
  closeStaleRoute = await import("@/app/api/data-quality/close-stale/route");
  previewRoute = await import("@/app/api/charges/preview/route");
  bc = await import("@/components/import/broker-connect");
  dhan = await import("@/lib/import/api/dhan");
  importer = await import("@/lib/import/commit");
  identity = await import("@/lib/import/broker-identity");
  dqQueries = await import("@/lib/queries/data-quality");
  backup = await import("@/lib/backup");
  ({ DuplicateFix } = await import("@/components/quality/duplicate-fix"));
  ({ StaleLotFix } = await import("@/components/quality/stale-lot-fix"));
  ({ StrategyCard } = await import("@/components/strategies/strategy-card"));
  ({ ExpiryObligations } = await import("@/components/risk/expiry-obligations"));
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  t.db
    .insert(t.schema.accounts)
    .values([
      { id: BOOK_A, name: "Book A", isDefault: false },
      { id: BOOK_B, name: "Book B", isDefault: false },
      { id: BOOK_C, name: "Book C", isDefault: false },
      { id: VENUE, name: "Venue", isDefault: false },
      { id: CLAMP, name: "Clamp", isDefault: false },
      { id: RISK, name: "Risk", isDefault: false },
    ])
    .run();
  // Warm the GET path once. Its first call measured ~450 ms locally, and that
  // one-off cost belongs in a hook, not in the `it` that first reads the card.
  // The throwaway row is read and deleted; nothing else sees it.
  addDhan(VENUE, null);
  selectAccount(0);
  await brokerRoute.GET();
  t.sqlite.prepare("DELETE FROM broker_connections WHERE account_id = ?").run(VENUE);
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  t?.cleanup();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── shared harness ───────────────────────────────────────────────────────────

const freezeAt = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

const alive = () =>
  ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

/** A Dhan row as the save route leaves it (plaintext reads through readSecret's compatibility path). */
function addDhan(accountId: number, lastPullAt: string | null) {
  t.sqlite
    .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, NULL, ?)")
    .run(accountId, CLIENT, alive(), lastPullAt);
}

interface DhanFill {
  id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  at: string;
  segment?: string;
}

const fillRow = (f: DhanFill) => ({
  dhanClientId: CLIENT,
  exchangeTradeId: f.id,
  orderId: `O-${f.id}`,
  transactionType: f.side,
  exchangeSegment: f.segment ?? "NSE_EQ",
  productType: "CNC",
  tradingSymbol: "TCS",
  tradedQuantity: f.qty,
  tradedPrice: f.price,
  exchangeTime: f.at,
});

/** A sell-only `/v2/positions` row: sold today out of a holding the book cannot see. */
const sellOnlyPosition = (qty: number, price: number) => ({
  dhanClientId: CLIENT,
  tradingSymbol: "TCS",
  positionType: "CLOSED",
  exchangeSegment: "NSE_EQ",
  productType: "CNC",
  buyAvg: 0,
  buyQty: 0,
  sellAvg: price,
  sellQty: qty,
  netQty: 0,
});

/** api.dhan.co — page 0 of the history walk answers `history`, /v2/positions answers `positions`. */
function stubDhan(history: DhanFill[], positions: unknown[] = []): string[] {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    paths.push(u.pathname);
    const body =
      u.host === "auth.dhan.co"
        ? { accessToken: alive() }
        : u.pathname === "/v2/positions"
          ? positions
          : /^\/v2\/trades\/[\d-]+\/[\d-]+\/0$/.test(u.pathname)
            ? history.map(fillRow)
            : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return paths;
}

const pull = (accountId: number) =>
  brokerRoute.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify({ action: "pull", broker: "dhan", accountId, mode: "commit" }),
      headers: { "Content-Type": "application/json" },
    }),
  );

interface ConnLite {
  broker: string;
  accountId: number;
  accountName?: string | null;
  lastPullAt: string | null;
  unfetched?: { from: string; to: string; reason: string }[];
  catchUpFrom?: string | null;
}

/** Every connection row exactly as the card receives it — through GET, serialised. */
async function dhanRows(view: number): Promise<ConnLite[]> {
  selectAccount(view);
  const json = (await (await brokerRoute.GET()).json()) as { connections: ConnLite[] };
  return json.connections.filter((c) => c.broker === "dhan").sort((a, b) => a.accountId - b.accountId);
}

const storedRows = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);

const lastPullAtOf = (accountId: number) =>
  (t.sqlite.prepare("SELECT last_pull_at AS v FROM broker_connections WHERE account_id = ? AND broker = 'dhan'").get(accountId) as { v: string | null }).v;

/** The card's own POST (components/quality/stale-lot-fix.tsx:88), through the real route. */
const closeStale = (body: { lotId: number; saleId: number; exitDate: string }) =>
  closeStaleRoute.POST(
    new Request("http://localhost/api/data-quality/close-stale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;
const rupee = (n: number) => Math.round(n);
const helpEntry = (id: string) => {
  const e = OPTIONS_HELP.find((x) => x.id === id);
  if (!e) throw new Error(`no Options Help entry "${id}"`);
  return e;
};

// ============================================================================
// S1 — W1-SETTLE's physicalStt ↔ W1-HELP's STT doctrine (R49 / R77 / R78)
// ============================================================================

/**
 * The Help Desk states WHO pays which levy on a physically settled stock
 * option; the Risk panel computes the rupees. The doctrine is read from the
 * help copy exactly as the reader gets it, applied to the position, and must
 * produce the ₹ figure settlement.ts computes. One half reverted and they
 * disagree: the old help charged the WRITER exercise STT and said nothing of
 * delivery STT (₹75 for the short); the old engine did exactly that.
 */
describe("S1 · the help's STT doctrine, applied to a position, is the ₹ the Risk panel computes (SETTLE ↔ HELP)", () => {
  const TODAY = "2026-06-24";
  const base = { optionType: "CE", side: "long" as const, refPrice: null as number | null };

  /** What the Help Desk says, as three yes/no facts. */
  const doctrine = () => {
    const shortRisk = helpEntry("short-call").risk;
    const longRisk = helpEntry("long-call").risk;
    return {
      writerPaysExercise: !shortRisk.includes("not on the assigned writer"),
      deliveryBothSides: shortRisk.includes("equity-delivery rate on the shares, on both sides"),
      holderPaysExercise: longRisk.includes("charged STT on intrinsic value"),
    };
  };

  it("S1a · a SHORT ITM stock call (SBIN 1400 CE × 500, spot 1500): the help's rule gives ₹700, and so does settlement", () => {
    const [o] = computeSettlement(
      [{ ...base, id: 1, symbol: "SBIN", tradingsymbol: "OPT SBIN 25 Jun 2026 1400 CE", segment: "stock_option", strike: 1400, side: "short", expiry: "2026-06-26", netQty: 500, refPrice: 1500 } as SettlementInput],
      DEFAULT_SETTLEMENT_RATES,
      TODAY,
    ).obligations;
    const d = doctrine();
    const byHelp =
      (d.deliveryBothSides ? rupee(DEFAULT_SETTLEMENT_RATES.deliverySttPct * 1400 * 500) : 0) +
      (d.writerPaysExercise ? rupee(DEFAULT_SETTLEMENT_RATES.exerciseSttPct * (1500 - 1400) * 500) : 0);
    expect(o.physicalStt, "the panel's ₹ must be the help's doctrine applied to this short leg").toBe(byHelp);
    expect(byHelp).toBe(700);
  });

  it("S1b · a LONG ITM stock call (RELIANCE 2900 CE × 250, spot 3000): delivery ₹725 + exercise ₹38 = ₹763 by both", () => {
    const [o] = computeSettlement(
      [{ ...base, id: 2, symbol: "RELIANCE", tradingsymbol: "OPT RELIANCE 25 Jun 2026 2900 CE", segment: "stock_option", strike: 2900, expiry: "2026-06-26", netQty: 250, refPrice: 3000 } as SettlementInput],
      DEFAULT_SETTLEMENT_RATES,
      TODAY,
    ).obligations;
    const d = doctrine();
    const byHelp =
      (d.deliveryBothSides ? rupee(DEFAULT_SETTLEMENT_RATES.deliverySttPct * 2900 * 250) : 0) +
      (d.holderPaysExercise ? rupee(DEFAULT_SETTLEMENT_RATES.exerciseSttPct * (3000 - 2900) * 250) : 0);
    expect(o.physicalStt, "the panel's ₹ must be the help's doctrine applied to this long leg").toBe(byHelp);
    expect(byHelp).toBe(763);
  });
});

// ============================================================================
// S2 — W1-STRAT's optionNetPremium / netTone ↔ W1-HELP's collar copy (R97, R67/R68)
// ============================================================================

/**
 * STRAT prints N (the option legs' own premium, + = collected) on the card's
 * "Net premium" tile and decides the chip from it; HELP's collar copy and
 * catalogue row state Max profit / Max loss in terms of that N. Plug the card's
 * N into the help's formula and it must give the card's own Max profit / loss,
 * and the chip must say "Net debit" exactly when the help says N counts
 * negative. Both signs.
 */
describe("S2 · the card's N, put into the help's collar formula, is the card's own max profit / loss (STRAT ↔ HELP)", () => {
  const K1 = 950;
  const K2 = 1050;
  const S0 = 1000;
  const Q = 100;
  const collar = (pePremium: number, cePremium: number): PositionedLeg[] => [
    { symbol: "INFY", expiry: null, kind: "UL", strike: 0, side: "long", qty: Q, premium: S0 },
    { symbol: "INFY", expiry: "2026-09-29", kind: "PE", strike: K1, side: "long", qty: Q, premium: pePremium },
    { symbol: "INFY", expiry: "2026-09-29", kind: "CE", strike: K2, side: "short", qty: Q, premium: cePremium },
  ];

  it.each([
    { label: "a DEBIT collar (put 25, call 15)", pe: 25, ce: 15, n: -1000, chip: NET_LABEL.debit },
    { label: "a CREDIT collar (put 15, call 25)", pe: 15, ce: 25, n: 1000, chip: NET_LABEL.credit },
  ])("$label", ({ pe, ce, n, chip }) => {
    const [g] = buildStrategies(collar(pe, ce));
    expect(g.strategyId).toBe("collar");
    const N = optionNetPremium(g); // STRAT: the number the "Net premium" tile prints
    expect(N).toBe(n);

    // HELP: "capped at (K2 − S0) × quantity plus the net premium … the loss at
    // (S0 − K1) × quantity minus it, with a net debit counted as negative".
    const payoff = helpEntry("collar").payoff;
    const helpSign = payoff.includes("plus the net premium") ? 1 : -1;
    const catalogueSign = getStrategyDef("collar")!.maxProfit.includes("+ N") ? 1 : -1;
    expect(catalogueSign, "the catalogue row and the help entry state one formula").toBe(helpSign);
    expect(g.maxProfit, "Max profit on the card = the help's formula at the card's N").toBe((K2 - S0) * Q + helpSign * N);
    expect(g.maxLoss, "Max loss on the card = the help's formula at the card's N").toBe(-((S0 - K1) * Q - helpSign * N));

    // The chip: the help counts a net debit as negative, so the card's chip
    // must read "Net debit" exactly when N < 0 (and "Net credit" when N > 0).
    const debitIsNegative = payoff.includes("a net debit counted as negative");
    expect(debitIsNegative).toBe(true);
    const html = renderToStaticMarkup(React.createElement(StrategyCard, { group: { ...g, proWithheld: false }, chart: null }));
    expect(html, "the chip reads the sign the help defines for N").toContain(`>${chip}<`);
    expect(html).not.toContain(`>${chip === NET_LABEL.debit ? NET_LABEL.credit : NET_LABEL.debit}<`);
  });
});

// ============================================================================
// S3 — W1-DQ's stale-lot close ↔ W1-PULL's catch-up / stamp ↔ W1-UI's cards
// ============================================================================

/**
 * One Dhan client, three books. Each book gets the SAME real pull: yesterday's
 * BUY from the history walk and today's SELL from /v2/positions, which v4.2.0
 * (and 4.3.0, auto-close off) stores as a stale OPEN lot beside a sell-only
 * row. Data Quality joins them (R26) and records the sale's hash as an alias on
 * the lot. The re-served sale must then be a DUPLICATE to the pull (DQ's
 * alias-aware set). PULL must treat that nothing-new read as a successful
 * read and stamp it (R27). And the UI cards must read the merged lot as
 * merged (M-5) and each row's own stamp (R47).
 */
describe("S3 · a stale-closed lot meets the next Dhan pull and the Data Quality page (DQ ↔ PULL ↔ UI)", () => {
  const STAMP_0 = "2026-09-04T05:00:00.000Z"; // Fri 4 Sep, 10:30 IST
  const PULL_1 = "2026-09-08T09:30:00.000Z"; //  Tue 8 Sep, 15:00 IST
  const PULL_2 = "2026-09-08T12:30:00.000Z"; //  Tue 8 Sep, 18:00 IST — same IST day
  const PULL_3 = "2026-09-10T19:00:00.000Z"; //  Fri 11 Sep, 00:30 IST (UTC day still the 10th)
  const BUY: DhanFill = { id: "L-BUY", side: "BUY", qty: 10, price: 100, at: "2026-09-07 10:00:00" };
  const SALE = sellOnlyPosition(10, 120);

  it.each([BOOK_A, BOOK_B, BOOK_C])("pull 1 into book %i: the lot and its sale land as two rows, a stale pair", async (book) => {
    freezeAt(PULL_1);
    addDhan(book, STAMP_0);
    stubDhan([BUY], [SALE]);
    const res = await pull(book);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { added: number } }).result.added).toBe(2);
    expect(storedRows(book).map((r) => [r.buyQty, r.sellQty, r.isOpen, r.buyDate, r.sellDate])).toEqual([
      [10, 0, true, "2026-09-07", null],
      [0, 10, true, null, "2026-09-08"],
    ]);
    expect(lastPullAtOf(book)).toBe(PULL_1);
  });

  it("S3a · book A: joined from Data Quality, then the same-day pull re-serves the sale — nothing new, and the read is stamped", async () => {
    freezeAt(PULL_2);
    selectAccount(0);
    const pair = dqQueries.getStaleOpenPairs().find((p) => p.accountId === BOOK_A);
    expect(pair && [pair.oneClick, pair.saleDate, pair.saleDateStated]).toEqual([true, "2026-09-08", true]);
    const closed = await closeStale({ lotId: pair!.lotId, saleId: pair!.saleId, exitDate: pair!.saleDate });
    expect(closed.status).toBe(200);
    const joined = storedRows(BOOK_A);
    expect(joined.map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([[10, 10, false]]);

    // Pull 2, the same IST day: no history window, /v2/positions states the sale again.
    const paths = stubDhan([], [SALE]);
    const res = await pull(BOOK_A);
    expect(paths.some((p) => p.startsWith("/v2/trades/")), "pulled today already: no history walk").toBe(false);
    const json = (await res.json()) as { nothingNew?: boolean; result?: { added: number } };
    // DQ: the lot answers to the sale's hash, so the re-served sale is a duplicate.
    expect(res.status, "the re-served sale must be a duplicate of the joined lot").toBe(409);
    expect(json.nothingNew).toBe(true);
    expect(storedRows(BOOK_A), "the join survives the next pull").toEqual(joined);
    // PULL (R27): a nothing-new read is a successful read and moves the stamp.
    expect(lastPullAtOf(BOOK_A), "the nothing-new pull must stamp lastPullAt").toBe(PULL_2);
  });

  it("S3b · the page's two cards: the merged lot is never offered as a plain copy, and only the unjoined books keep a join button", async () => {
    freezeAt(PULL_2);
    selectAccount(0);
    const groups = identity.listDuplicateTradeGroups().filter((g) => g.symbol === "TCS" && g.broker === "dhan");
    expect(groups, "the BUY record and the SALE record, each held in three books").toHaveLength(2);
    const html = renderToStaticMarkup(
      React.createElement(DuplicateFix, { groups, connections: identity.listDuplicateConnections() }),
    );
    expect(count(html, "Remove the copy in Book A"), "book A's row is a merged lot (it carries the sale as an alias)").toBe(0);
    expect(count(html, "Remove the copy in Book B")).toBe(2);
    expect(count(html, "Remove the copy in Book C")).toBe(2);

    const pairs = dqQueries.getStaleOpenPairs().filter((p) => p.tradingsymbol === "TCS");
    expect(pairs.map((p) => p.accountId)).toEqual([BOOK_B, BOOK_C]);
    const stale = renderToStaticMarkup(React.createElement(StaleLotFix, { pairs }));
    expect(count(stale, "Close with the recorded sale")).toBe(2);
  });

  const namesOf = (lines: string[]) => lines.map((l) => l.slice(0, l.indexOf(":")));

  it("S3c · 00:30 IST three days on, book C joined: the card lists one gap line per stale Dhan row, named by account (R47)", async () => {
    freezeAt(PULL_3);
    expect(todayIstIso(), "19:00Z is already the next day in India").toBe("2026-09-11");
    selectAccount(0);
    const pair = dqQueries.getStaleOpenPairs().find((p) => p.accountId === BOOK_C)!;
    expect((await closeStale({ lotId: pair.lotId, saleId: pair.saleId, exitDate: pair.saleDate })).status).toBe(200);
    const lines = bc.pullGapLines(await dhanRows(0), true);
    expect(namesOf(lines)).toEqual(["Book A", "Book B", "Book C"]);
    expect(lines.every((l) => l.includes("Pulls missed since 08 Sep 2026"))).toBe(true);
  });

  it("S3c · the sale fill two seconds after pull 1's stamp is re-served; it is C's joined lot's, so nothing new — and the read is stamped", async () => {
    freezeAt(PULL_3);
    const joined = storedRows(BOOK_C);
    expect(joined.map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([[10, 10, false]]);
    // The sale executed at 15:00:02, two seconds after pull 1's pre-/positions
    // stamp: it sat in that snapshot AND survives R42's cutoff (the residual
    // catchUpAfter documents). The alias is what makes it a duplicate.
    const paths = stubDhan([{ id: "S-RES", side: "SELL", qty: 10, price: 120, at: "2026-09-08 15:00:02" }], []);
    const res = await pull(BOOK_C);
    expect(paths).toContain("/v2/trades/2026-09-08/2026-09-11/0");
    expect(res.status, "the re-served sale must be a duplicate of C's joined lot").toBe(409);
    expect(storedRows(BOOK_C), "the join survives the catch-up").toEqual(joined);
    expect(lastPullAtOf(BOOK_C), "the nothing-new catch-up must stamp lastPullAt").toBe(PULL_3);
  });

  it("S3c · after that read, the card drops C's gap line and keeps A's and B's", async () => {
    freezeAt(PULL_3);
    const lines = bc.pullGapLines(await dhanRows(0), true);
    expect(namesOf(lines), "C read successfully at 00:30 IST — its gap line must go, the others stay").toEqual(["Book A", "Book B"]);
  });
});

// ============================================================================
// S4 — W1-PAYTM's R71 row venue ↔ W1-PULL's Dhan adapter (DEFECT D1)
// ============================================================================

/**
 * pairLegs now labels a row with the venue of most of its own turnover (R71).
 * dhan.ts runs pairLegs on its legs and then stamps the GROUP's first venue on
 * every position anyway. The two halves disagree on the stored `exchange`,
 * which prices the row when Dhan states no charges and keys the Data Quality book.
 */
describe("S4 · the Dhan adapter stores the venue R71's pairLegs decides (PAYTM → PULL)", () => {
  const FILLS: DhanFill[] = [
    { id: "V-B1", side: "BUY", qty: 100, price: 200, at: "2026-09-01 10:00:00", segment: "NSE_EQ" },
    { id: "V-S1", side: "SELL", qty: 100, price: 210, at: "2026-09-02 10:00:00", segment: "BSE_EQ" },
    { id: "V-B2", side: "BUY", qty: 10, price: 200, at: "2026-09-03 10:00:00", segment: "BSE_EQ" },
  ];
  /** The legs as normalizeDhanTrades builds them: one per date|side, venue from the fill (dhan.ts:633-645). */
  const LEGS: Leg[] = FILLS.map((f) => ({
    symbol: "TCS",
    side: f.side === "BUY" ? "buy" : "sell",
    date: f.at.slice(0, 10),
    qty: f.qty,
    value: f.qty * f.price,
    charges: 0,
    exchange: f.segment === "BSE_EQ" ? "BSE" : "NSE",
  }));
  let stored: string[] = [];

  it("the real pull commits a closed row and a BSE-only open lot, and pairLegs (R71) puts both on BSE", async () => {
    freezeAt("2026-09-10T19:00:00.000Z");
    stubDhan(FILLS, []);
    const range = { from: "2026-09-01", to: "2026-09-11" };
    const trades = await dhan.dhanImportSource({ clientId: CLIENT, accessToken: alive() }).fetchTrades(range);
    const parsed = dhan.toParsedFile(trades, range);
    expect(importer.commitParsedFile(parsed, "dhan-api", null, VENUE).added).toBe(2);
    const rows = storedRows(VENUE);
    expect(rows.map((r) => [r.buyQty, r.sellQty])).toEqual([
      [100, 100],
      [10, 0],
    ]);
    expect(rows[0].importNotes ?? "").toContain("Bought on NSE, sold on BSE");
    stored = rows.map((r) => r.exchange);
    expect(pairLegs(LEGS).map((p) => [p.kind, p.exchange])).toEqual([
      ["closed", "BSE"],
      ["open", "BSE"],
    ]);
  });

  it.fails("DEFECT D1 — dhan.ts:719 stamps the group's first venue; the stored exchange must be pairLegs' row venue", () => {
    expect(stored).toEqual(pairLegs(LEGS).map((p) => p.exchange));
  });
});

// ============================================================================
// S5 — W1-PULL's kept span ↔ W1-UI's card line (DEFECT D2)
// ============================================================================

describe("S5 · a clamped pull's kept span, read back by the card (PULL → GET → UI)", () => {
  let span: { from: string; to: string; reason: string } | undefined;

  it("the pull says a tradebook for its own last day would repeat fills, and GET keeps that one-day span", async () => {
    freezeAt("2026-09-10T19:00:00.000Z");
    addDhan(CLAMP, "2026-06-11T19:00:00.000Z"); // 00:30 IST on 12 Jun — one IST day past the 90-day floor
    stubDhan([{ id: "CL-1", side: "BUY", qty: 5, price: 200, at: "2026-07-01 10:00:00" }], []);
    const res = await pull(CLAMP);
    expect(res.status).toBe(200);
    const warning = ((await res.json()) as { warnings: string[] }).warnings.find((w) => w.startsWith("Not fetched:"));
    expect(warning).toContain("a tradebook for 2026-06-12 would repeat the fills already imported from it");
    expect(warning).not.toContain("import a Dhan tradebook for 2026-06-12");
    const [row] = await dhanRows(CLAMP);
    expect(row.unfetched).toEqual([{ from: "2026-06-12", to: "2026-06-12", reason: "range-cap" }]);
    span = row.unfetched![0];
  });

  // D2 FIXED (v4.3.0 fix wave 1 follow-up, 2026-09-11): this was an `it.fails`.
  // The defect's own assertion is kept; the second one pins that the card now
  // says what the pull's warning above says about that day.
  it("D2 — the card does not tell the user to import the tradebook the pull says would double-count", () => {
    expect(span).not.toBeUndefined();
    expect(bc.unfetchedNotice(span!)).not.toContain("Import a Dhan tradebook for 12 Jun 2026");
    expect(bc.unfetchedNotice(span!)).toContain("A tradebook for 12 Jun 2026 would repeat the fills already imported from it.");
  });
});

// ============================================================================
// S6 — W1-RATES's F&O STT epochs ↔ W1-PREVIEW's pricing date (R1 × R56)
// ============================================================================

/**
 * A WRITTEN stock option closed ten days later, previewed with the dates the
 * close dialog sends for a short (buyDate = the exit, sellDate = the entry).
 * pricingDate → the entry day, and the seeded card must answer that day's
 * circular. ₹10,00,000 of premium sold, so every rate is a whole rupee.
 */
describe("S6 · the preview prices a dated option sale at that date's STT circular (RATES → PREVIEW)", () => {
  const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  it.each([
    { entry: "2016-05-20", pct: 0.00017, circular: "FATAX23500 — 0.017% before 1 Jun 2016" },
    { entry: "2016-06-01", pct: 0.0005, circular: "FATAX32385 — 0.05% from 1 Jun 2016" },
    { entry: "2023-03-31", pct: 0.0005, circular: "FATAX56235 — 0.05% up to 31 Mar 2023" },
  ])("$entry ($circular)", async ({ entry, pct }) => {
    const res = await previewRoute.POST(
      new Request("http://localhost/api/charges/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          broker: "zerodha",
          tradingsymbol: "OPT SBIN 30 Jun 2016 800 CE",
          segment: "stock_option",
          exchange: "NSE",
          buyValue: 900_000,
          sellValue: 1_000_000,
          buyQty: 1000,
          sellQty: 1000,
          isOpen: false,
          buyDate: plusDays(entry, 10),
          sellDate: entry,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { breakdown: { sttCtt: number } };
    expect(json.breakdown.sttCtt).toBe(rupee(pct * 1_000_000));
  });
});

// ============================================================================
// S7 — W1-RATES's eq_delivery row ↔ W1-SETTLE's panel, through app/risk/page.tsx:350
// ============================================================================

type Elem = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const isElem = (n: unknown): n is Elem => !!n && typeof n === "object" && "type" in n && "props" in n;
function findElem(node: unknown, pick: (e: Elem) => boolean): Elem | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findElem(n, pick);
      if (hit) return hit;
    }
    return null;
  }
  if (!isElem(node)) return null;
  if (pick(node)) return node;
  return findElem(node.props.children, pick);
}

describe("S7 · the eq_delivery STT in charge_config is the rate the Risk panel charges a settling short and prints (RATES → page → SETTLE)", () => {
  const isoDay = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const SHORT_ID = 96601;

  const panel = () => {
    const el = findElem(riskPage(), (e) => e.type === ExpiryObligations);
    if (!el) throw new Error("the risk page no longer renders <ExpiryObligations>");
    const props = el.props as unknown as React.ComponentProps<typeof ExpiryObligations>;
    const o = props.summary.obligations.find((x) => x.id === SHORT_ID);
    return { props, o, html: renderToStaticMarkup(React.createElement(ExpiryObligations, props)) };
  };
  const setDeliveryStt = (pct: number) =>
    t.sqlite.prepare("UPDATE charge_config SET stt_pct = ? WHERE segment = 'eq_delivery'").run(pct);

  it("the seeded 0.1% → ₹700 on a short SBIN 1400 CE × 500; a 0.12% row → ₹840 — and the footer names the rate it used", () => {
    selectAccount(RISK);
    t.db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          id: SHORT_ID,
          accountId: RISK,
          bucket: "active",
          segment: "stock_option",
          instrumentType: "option",
          exchange: "NFO",
          symbol: "SBIN",
          tradingsymbol: "OPT SBIN 29 SEP 2026 1400 CE",
          optionType: "CE",
          strike: 1400,
          expiry: isoDay(5),
          buyQty: 0,
          avgBuyPrice: 0,
          sellQty: 500,
          avgSellPrice: 20,
          isOpen: true,
        }),
      )
      .run();
    t.db.insert(t.schema.priceHistory).values({ symbol: "SBIN", date: isoDay(-1), close: 1500, source: "bhavcopy" }).run();

    const seeded = panel();
    expect(seeded.o?.deliveryAction).toBe("Give delivery (sell)");
    expect(seeded.o?.physicalStt, "0.1% × 1400 × 500, no exercise STT for the writer").toBe(700);
    expect(seeded.html).toContain("0.1% of the strike value");

    setDeliveryStt(0.0012);
    try {
      const edited = panel();
      expect(edited.o?.physicalStt, "the panel must charge the rate charge_config holds, not a default").toBe(840);
      expect(edited.html).toContain("0.12% of the strike value");
    } finally {
      setDeliveryStt(0.001);
    }
  });
});

// ============================================================================
// S8 — W1-RATES's restore refresh ↔ backup/restore of every other table (invariant 10). LAST: it replaces the database.
// ============================================================================

describe("S8 · restoring a pre-R1 backup keeps every row it carried and brings its rate card onto this build (RATES ↔ backup)", () => {
  type Rate = Record<string, unknown> & { broker: string; plan: string | null; segment: string; exchange: string; effectiveFrom: string; effectiveTo: string | null; sttPct: number };
  const tradeFacts = () => t.db.select().from(t.schema.trades).all().map((r) => [r.id, r.accountId, r.dedupHash, r.netPnl, r.importNotes]);
  let tradesBefore: unknown[][] = [];
  let planted: Rate | undefined;
  let restored: { ok: boolean; message: string } = { ok: false, message: "not run" };

  // The dump + restore is ONE operation and measured ~350 ms locally, so it
  // lives in this hook (≤ 3 s budget); the `it`s below only read its result.
  beforeAll(() => {
    const FNO = new Set(["future", "index_option", "stock_option"]);
    const R1_BOUNDARIES = new Set(["2013-06-01", "2016-06-01", "2023-04-01"]);
    tradesBefore = tradeFacts();

    // The donor: this database, with the v4.2-era F&O STT card planted in its
    // envelope — no 2013/2016/2023 epochs, one flat rate up to 1 Oct 2024.
    const dump = backup.dumpDatabase(false) as unknown as { tables: Record<string, Record<string, unknown>[]> };
    const kept = (dump.tables.charge_config as Rate[]).filter((r) => !(FNO.has(r.segment) && R1_BOUNDARIES.has(r.effectiveFrom)));
    const byKey = new Map<string, Rate[]>();
    for (const r of kept) {
      const k = `${r.broker}|${r.plan}|${r.segment}|${r.exchange}`;
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
    for (const rows of byKey.values()) {
      rows.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      rows.forEach((r, i) => {
        if (i + 1 < rows.length) r.effectiveTo = rows[i + 1].effectiveFrom;
        if (FNO.has(r.segment) && r.effectiveFrom < "2024-10-01") r.sttPct = r.segment === "future" ? 0.000125 : 0.000625;
      });
    }
    dump.tables.charge_config = kept;
    planted = kept.find(
      (r) => r.broker === "zerodha" && r.segment === "stock_option" && r.exchange === "NSE" && r.effectiveFrom <= "2016-05-20" && (r.effectiveTo == null || r.effectiveTo > "2016-05-20"),
    );
    restored = backup.restoreDatabase(dump);
  });

  it("floor: the donor envelope really carries the pre-R1 card — 2016-05-20 at the flat 0.0625%", () => {
    // A:1 B:2 C:1 (S3), Venue:2 (S4), Clamp:1 (S5), Risk:1 (S7).
    expect(tradesBefore).toHaveLength(8);
    expect(planted?.sttPct).toBe(0.000625);
  });

  it("invariant 10: the restore succeeds and every trade the envelope carried is back, byte for byte", () => {
    expect(restored.ok, restored.message).toBe(true);
    expect(tradeFacts()).toEqual(tradesBefore);
  });

  it("a 2016-05 written option previews at 0.017% after the restore — this build's card, not the envelope's", async () => {
    const preview = await previewRoute.POST(
      new Request("http://localhost/api/charges/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          broker: "zerodha",
          tradingsymbol: "OPT SBIN 30 Jun 2016 800 CE",
          segment: "stock_option",
          exchange: "NSE",
          buyValue: 900_000,
          sellValue: 1_000_000,
          buyQty: 1000,
          sellQty: 1000,
          isOpen: false,
          buyDate: "2016-05-30",
          sellDate: "2016-05-20",
        }),
      }),
    );
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { breakdown: { sttCtt: number } }).breakdown.sttCtt, "the restored card must be this build's").toBe(170);
  });
});
