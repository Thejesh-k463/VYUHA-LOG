import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { buildChargeConfigSeed } from "@/lib/db/seed-data";
import { refreshRateCards } from "../scripts/rate-card-refresh.mjs";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v4.3.0 RELEASE-LEVEL SEAM PASS over `v4.2.0..d0eda00`.
 *
 * Written AFTER tests/seams-v43.test.ts (wave 1), seams-v43-wave2.test.ts
 * (wave 2), seams-v43-fix1.test.ts (fix wave 1) and
 * tests/fix-wave-c-import.test.ts (C-5 / C-6 through the real routes) — every
 * seam below is one none of those runs with both halves. Fix wave C split the
 * crossings across builders: CA (import: dhan.ts, the broker route,
 * broker-connect.tsx, auto-pull), CB + the C-8 builder (lib/db/seed-data.ts,
 * seed-core.ts), CC (commit.ts's source word, auto-pull's line), and F1 before
 * them (scripts/rate-card-refresh.mjs, the refresh the installed app runs).
 *
 * NOTHING HERE IS MOCKED ON EITHER SIDE OF A SEAM. The only stub is
 * `globalThis.fetch` (the network). One migrated temp SQLite file for the whole
 * file (lib/db caches its connection), one account per scenario. Every expected
 * value is a LITERAL taken from its source (the NSE circulars for rates, the
 * frozen clock for dates) — never asked of the module under test.
 *
 * ── THE SEAM TABLE ─────────────────────────────────────────────────────────
 *
 * # | crossing value                          | producer (file:line)                         | consumer (file:line)                              | unit / shape                          | test name
 * --|-----------------------------------------|----------------------------------------------|---------------------------------------------------|---------------------------------------|------------------------------------------
 * 1 | DhanHistoryRead.truncated (page cap)    | lib/import/api/dhan.ts:1039 fetchDhanTrades  | app/api/import/broker/route.ts:864 onHistory      | {pages, truncated, oldest, newest}    | S1 · the route keeps a page-cap span
 *   |   ↳ DhanUnfetchedSpan "page-cap"        | lib/import/api/dhan.ts:1141 toParsedFile     | route.ts:1060 recordUnfetched → audit_log         | {from,to: IST ISO day, reason}        |
 *   |   ↳ GET `unfetched[]`                   | route.ts:392 outstandingUnfetched            | components/import/broker-connect.tsx:293 notice   | JSON array, IST ISO days              | S1 · the card prints the page-limit line
 *   |   ↳ the sweep's copy                    | lib/jobs/auto-pull.ts:222 → :255             | auto-pull.ts:141 unfetchedDetail + route GET      | same audit record, `source: auto-pull`| S1 · the sweep keeps it too
 * 2 | ParsedFile.format === "api"             | lib/import/api/kite.ts:236, angelone.ts:363, | lib/import/commit.ts:1791 the auto-close sentence | string; "api" → "pull", else "file"   | S2 · SWITCHED OFF (4.3.0): no close sentence
 *   |                                         | upstox.ts:308, openalgo.ts:558               |                                                   |                                       |
 * 3 | charge_config epochs (C-7 STT, C-8 txn  | lib/db/seed-data.ts:191-226 schedules, :611  | scripts/rate-card-refresh.mjs:45 (the sidecar)    | fractions of turnover / sell premium  | S3 · the refreshed card, priced by commit
 *   |   + IPFT), via the desktop template     | buildChargeConfigSeed                        | → lib/engine/rates-db.ts:15 loadRatesMap          | → stored PAISE, rupees at runtime     |
 *   |                                         |                                              | → lib/import/commit.ts:116 findRates(pricingDate) |                                       |
 *   |                                         |                                              | → lib/engine/charges.ts:86/88/91                  |                                       |
 * 4 | GET `catchUpFrom`                       | route.ts:392 catchUpRange(lastPullAt)        | broker-connect.tsx:570 → :267 pullGapNotice       | IST ISO day or null                   | S4 · the clamp edge at the IST boundary
 *
 * DATES. S1 and S4 run at 2026-09-10T19:00:00Z = 00:30 IST on 11 Sep, inside
 * the 18:30–24:00 UTC window where the IST day and the UTC day disagree.
 *
 * SEAM DEFECT found by this pass, NOT fixed here (reported to the audit union):
 *  Angel One and Upstox state a sell-only row with `sellDate: null`
 *  (lib/import/api/angelone.ts:321, upstox.ts:214 — `closed ? today : null`).
 *  Under wave 1's auto-close that null became a CLOSED lot's `sell_date` — a
 *  realised trade with no exit date (R72; the shape DECISIONS 2026-09-10 M-3
 *  fixed for Dhan only).
 *
 * AUTO-CLOSE IS SWITCHED OFF FOR 4.3.0 (owner ruling 2026-09-11, 06-ANSWERS
 * "v4.3.0 release-level-audit rulings", row 1): lib/import/commit.ts is v4.2.0
 * again, so seam row 2's consumer (the close sentence) no longer exists and no
 * close happens — R72 is unreachable. The Angel One / Upstox sale still lands
 * as an OPEN SHORT with `sell_date` NULL and no basis flag: v4.2.0's shape,
 * which S2 pins as today's behaviour pending an owner decision (carried with
 * R72 to 4.3.1) — not as correct.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let brokerRoute: typeof import("@/app/api/import/broker/route");
let job: typeof import("@/lib/jobs/auto-pull");
let bc: typeof import("@/components/import/broker-connect");
let importer: typeof import("@/lib/import/commit");
let kite: typeof import("@/lib/import/api/kite");
let angel: typeof import("@/lib/import/api/angelone");
let upstox: typeof import("@/lib/import/api/upstox");
let openalgo: typeof import("@/lib/import/api/openalgo");

const PAGE_ROUTE = 71;
const PAGE_AUTO = 72;
const EDGE_IN = 73;
const EDGE_OUT = 74;
const KITE = 75;
const ANGEL = 76;
const UPSTOX = 77;
const OPENALGO = 78;
const RATES_BEFORE = 79;
const RATES_AFTER = 80;
const CLIENT = "1000000009";

beforeAll(async () => {
  t = await openTempDb("seams-v43-release", { seed: true });
  brokerRoute = await import("@/app/api/import/broker/route");
  job = await import("@/lib/jobs/auto-pull");
  bc = await import("@/components/import/broker-connect");
  importer = await import("@/lib/import/commit");
  kite = await import("@/lib/import/api/kite");
  angel = await import("@/lib/import/api/angelone");
  upstox = await import("@/lib/import/api/upstox");
  openalgo = await import("@/lib/import/api/openalgo");
  t.db
    .insert(t.schema.accounts)
    .values(
      [PAGE_ROUTE, PAGE_AUTO, EDGE_IN, EDGE_OUT, KITE, ANGEL, UPSTOX, OPENALGO, RATES_BEFORE, RATES_AFTER].map((id) => ({
        id,
        name: `seam ${id}`,
        isDefault: false,
      })),
    )
    .run();
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

/** 00:30 IST on 11 Sep 2026 — the UTC day is still the 10th. */
const AT_IST_BOUNDARY = new Date("2026-09-10T19:00:00.000Z");
const freezeAtBoundary = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT_IST_BOUNDARY);
};

const alive = () =>
  ["e30", Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "sig"].join(".");

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

/** A Dhan row as the save route leaves it (plaintext reads through readSecret's compatibility path). */
function addDhan(accountId: number, lastPullAt: string | null, authJson: Record<string, unknown> | null = null) {
  t.sqlite
    .prepare(
      "INSERT INTO broker_connections (account_id, broker, api_key, access_token, auth_json, last_pull_at) VALUES (?, 'dhan', ?, ?, ?, ?)",
    )
    .run(accountId, CLIENT, alive(), authJson ? JSON.stringify(authJson) : null, lastPullAt);
}

const dhanFill = (id: string, at: string) => ({
  exchangeTradeId: id,
  orderId: `O-${id}`,
  transactionType: "BUY",
  exchangeSegment: "NSE_EQ",
  productType: "CNC",
  tradingSymbol: "TCS",
  tradedQuantity: 5,
  tradedPrice: 200,
  exchangeTime: at,
});

/**
 * api.dhan.co. `everyPage`: every history page answers the fill, so the walk
 * never meets an empty page and stops at the 50-page cap. Otherwise only page 0
 * answers. /v2/positions answers [] either way.
 */
function stubDhan(fills: ReturnType<typeof dhanFill>[], everyPage = false): string[] {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    paths.push(u.pathname);
    const history = everyPage ? /^\/v2\/trades\//.test(u.pathname) : /^\/v2\/trades\/[\d-]+\/[\d-]+\/0$/.test(u.pathname);
    const body = u.host === "auth.dhan.co" ? { accessToken: alive() } : history ? fills : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return paths;
}

function post(body: unknown): Promise<Response> {
  return brokerRoute.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

interface ConnLite {
  broker: string;
  accountId: number;
  lastPullAt: string | null;
  unfetched?: { from: string; to: string; reason: string }[];
  catchUpFrom?: string | null;
}

/** The connection row exactly as the card receives it — through GET, serialised. */
async function connOf(accountId: number): Promise<ConnLite> {
  selectAccount(accountId);
  const json = (await (await brokerRoute.GET()).json()) as { connections: ConnLite[] };
  const c = json.connections.find((x) => x.broker === "dhan" && x.accountId === accountId);
  if (!c) throw new Error(`no Dhan connection listed for account ${accountId}`);
  return c;
}

const storedRows = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all();

// ===========================================================================
// S1 — the page cap: dhan.ts's walk → the route's `read` → a kept span → GET → the card
// ===========================================================================

describe("S1 · a Dhan history walk that hits the 50-page cap is kept and shown (dhan.ts → route / auto-pull → GET → card)", () => {
  beforeEach(freezeAtBoundary);

  // Frozen clock: today (IST) is 2026-09-11; the stamp's IST day is 2026-09-07.
  const STAMP = "2026-09-07T05:00:00.000Z";
  const TRUNCATED =
    "Truncated: this pull stopped at the 50-page limit of Dhan's trade history, so fills between 2026-09-07 and 2026-09-11 may be missing. The fills it read are dated 2026-09-08 to 2026-09-08. To be sure every fill is in, import a Dhan tradebook for 2026-09-07 to 2026-09-11.";
  const NOTICE =
    "A Dhan pull stopped at its page limit: fills between 07 Sep 2026 and 11 Sep 2026 may be missing. Import a Dhan tradebook for 07 Sep 2026 to 11 Sep 2026 to be sure every fill is in.";
  const SPAN = [{ from: "2026-09-07", to: "2026-09-11", reason: "page-cap" }];

  it("route: the commit names the truncation, GET lists a page-cap span, and the card prints the page-limit line", async () => {
    addDhan(PAGE_ROUTE, STAMP);
    const paths = stubDhan([dhanFill("PC-1", "2026-09-08 10:00:00")], true);
    const res = await post({ action: "pull", broker: "dhan", accountId: PAGE_ROUTE, mode: "commit" });
    expect(res.status).toBe(200);
    const json = await res.json();

    // The walk ran to the cap over the IST window (a UTC `today` would end it on the 10th).
    const walked = paths.filter((p) => p.startsWith("/v2/trades/"));
    expect(walked).toHaveLength(50);
    expect(walked[0]).toBe("/v2/trades/2026-09-07/2026-09-11/0");
    expect(walked[49]).toBe("/v2/trades/2026-09-07/2026-09-11/49");

    expect(json.warnings as string[]).toContain(TRUNCATED);
    expect(bc.pullResultMessage("commit", json)).toContain(TRUNCATED);
    expect(json.result.added).toBe(1);

    // THE assertion: the span outlives the lastPullAt move, and the card's line is the page-limit one.
    const conn = await connOf(PAGE_ROUTE);
    expect(conn.unfetched).toEqual(SPAN);
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toBe(NOTICE);
    // Pulled today: no gap line on top of the kept notice.
    expect(conn.catchUpFrom).toBeNull();
    expect(bc.pullGapNotice(conn.lastPullAt, new Date(), conn.catchUpFrom)).toBeNull();
  });

  it("auto-pull: the sweep line names the page limit, and the card lists the same span the manual pull would", async () => {
    t.sqlite.prepare("UPDATE settings SET auto_pull_enabled = 1, last_auto_pull_date = NULL").run();
    addDhan(PAGE_AUTO, STAMP, { pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP", totpAckVersion: 1 });
    stubDhan([dhanFill("PC-A", "2026-09-08 10:00:00")], true);

    const out = await job.runAutoPull(new Date()); // the REAL pullOne
    const mine = out.summary.find((e) => e.broker === "dhan" && e.accountId === PAGE_AUTO);
    expect(mine?.status).toBe("imported");
    expect(mine?.detail).toBe(
      "+1 trade (fills between 2026-09-07 and 2026-09-11 may be missing (page limit) — import a Dhan tradebook for those dates)",
    );
    // The token-only rows in this file are not unattended-eligible, so nothing else was pulled.
    expect(out.summary.filter((e) => e.status === "imported").map((e) => e.accountId)).toEqual([PAGE_AUTO]);

    const conn = await connOf(PAGE_AUTO);
    expect(conn.unfetched).toEqual(SPAN);
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toBe(NOTICE);
  });
});

// ===========================================================================
// S4 — the clamp edge: route GET's catchUpFrom → the card's gap line, at the IST boundary
// ===========================================================================

describe("S4 · catchUpFrom crosses to pullGapNotice at the exact 90-day edge, 00:30 IST (route GET → card)", () => {
  beforeEach(freezeAtBoundary);

  // today (IST) 2026-09-11 → the window's floor is 2026-06-13.
  it("a last pull whose IST day IS the floor (UTC day one earlier): no clamp — 'fetches the gap', and the pull asks from that day", async () => {
    addDhan(EDGE_IN, "2026-06-12T19:00:00.000Z"); // 00:30 IST on 13 Jun
    const conn = await connOf(EDGE_IN);
    expect(conn.catchUpFrom).toBe("2026-06-13");
    expect(bc.pullGapNotice(conn.lastPullAt, new Date(), conn.catchUpFrom)).toBe(
      "Pulls missed since 13 Jun 2026 — the next pull fetches the gap.",
    );

    const paths = stubDhan([dhanFill("E-IN", "2026-07-01 10:00:00")]);
    const res = await post({ action: "pull", broker: "dhan", accountId: EDGE_IN, mode: "preview" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(paths).toContain("/v2/trades/2026-06-13/2026-09-11/0");
    expect((json.warnings as string[]).filter((w) => w.startsWith("Not fetched:"))).toEqual([]);
  });

  it("one IST day older: the card says where the pull starts, the commit keeps a ONE-day span, and the card lists it", async () => {
    addDhan(EDGE_OUT, "2026-06-11T19:00:00.000Z"); // 00:30 IST on 12 Jun
    const before = await connOf(EDGE_OUT);
    expect(before.catchUpFrom).toBe("2026-06-13");
    // THE assertion: the server's clamp reaches the card's sentence.
    expect(bc.pullGapNotice(before.lastPullAt, new Date(), before.catchUpFrom)).toBe(
      "Pulls missed since 12 Jun 2026 — the next pull fetches from 13 Jun 2026; fills before that are not fetched.",
    );

    const paths = stubDhan([dhanFill("E-OUT", "2026-07-01 10:00:00")]);
    const res = await post({ action: "pull", broker: "dhan", accountId: EDGE_OUT, mode: "commit" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(paths).toContain("/v2/trades/2026-06-13/2026-09-11/0");
    expect(json.warnings as string[]).toContain(
      "Not fetched: fills from 2026-06-12 to 2026-06-12. The last pull ran on 2026-06-12, and a pull reads at most 90 days of Dhan's trade history, so this one started at 2026-06-13. To bring those fills in, import a Dhan tradebook for 2026-06-12 to 2026-06-12.",
    );

    const after = await connOf(EDGE_OUT);
    expect(after.unfetched).toEqual([{ from: "2026-06-12", to: "2026-06-12", reason: "range-cap" }]);
    expect(bc.unfetchedNotice(after.unfetched![0]!)).toBe(
      "Not fetched from Dhan: fills from 12 Jun 2026 to 12 Jun 2026 — they are older than the window a pull reads. Import a Dhan tradebook for 12 Jun 2026 to 12 Jun 2026 to bring them in.",
    );
    expect(bc.pullGapNotice(after.lastPullAt, new Date(), after.catchUpFrom)).toBeNull();
  });
});

// ===========================================================================
// S2 — every pull adapter's format word → commit's auto-close sentence
// ===========================================================================

interface PullAdapter {
  name: string;
  account: number;
  /** The adapter's REAL normalize + toParsedFile for one fill on `day`. */
  pull: (side: "BUY" | "SELL", day: string, time: string) => ParsedFile;
  /** Whether this adapter dates a sell-only row (see the header's defect). */
  datesSellOnly: boolean;
}

const PULL_ADAPTERS: PullAdapter[] = [
  {
    name: "Kite (Zerodha)",
    account: KITE,
    datesSellOnly: true,
    pull: (side, day, time) =>
      kite.toParsedFile(
        kite.normalizeKiteTrades([
          {
            tradingsymbol: "TCS",
            exchange: "NSE",
            product: "CNC",
            transaction_type: side,
            quantity: 10,
            average_price: side === "BUY" ? 100 : 110,
            fill_timestamp: `${day} ${time}`,
          },
        ]),
      ),
  },
  {
    name: "Angel One",
    account: ANGEL,
    datesSellOnly: false,
    pull: (side, day, time) =>
      angel.toParsedFile(
        angel.normalizeAngelTrades(
          [
            {
              tradingsymbol: "TCS-EQ",
              exchange: "NSE",
              producttype: "DELIVERY",
              transactiontype: side,
              fillsize: 10,
              fillprice: side === "BUY" ? 100 : 110,
              filltime: time,
            },
          ],
          day,
        ).trades,
      ),
  },
  {
    name: "Upstox",
    account: UPSTOX,
    datesSellOnly: false,
    pull: (side, day, time) =>
      upstox.toParsedFile(
        upstox.normalizeUpstoxTrades(
          [
            {
              exchange: "NSE",
              product: "D",
              tradingsymbol: "TCS",
              instrument_token: "NSE_EQ|INE467B01029",
              transaction_type: side,
              quantity: 10,
              average_price: side === "BUY" ? 100 : 110,
              order_timestamp: `${day} ${time}`,
              trade_id: `U-${side}-${day}`,
            },
          ],
          day,
        ),
      ),
  },
  {
    name: "OpenAlgo (over Zerodha)",
    account: OPENALGO,
    datesSellOnly: true,
    pull: (side, day, time) =>
      openalgo.toParsedFile(
        "zerodha",
        openalgo.normalizeOpenAlgoTrades(
          [{ action: side, symbol: "TCS", exchange: "NSE", product: "CNC", quantity: 10, average_price: side === "BUY" ? 100 : 110, timestamp: time }],
          "zerodha",
          day,
        ),
      ),
  },
];

// Rewritten DELIBERATELY for the 2026-09-11 owner ruling (06-ANSWERS "v4.3.0
// release-level-audit rulings", row 1): auto-close is switched off for 4.3.0,
// so this seam now pins v4.2.0's outcome for every pull adapter — the lot is
// untouched, the SELL is its own row, and no sentence claims a close.
describe("S2 · every broker-API adapter's pulled SELL of a held lot reaches commit as its own row (adapters → commit.ts; auto-close off in 4.3.0)", () => {
  it.each(PULL_ADAPTERS)("$name: a pulled SELL of a held lot lands as its own row; the lot is untouched and no sentence claims a close", (a) => {
    const buy = a.pull("BUY", "2026-09-01", "10:00:00");
    // Seam row 2's input: every adapter says it is a PULL.
    expect(buy.format).toBe("api");
    const opened = importer.commitParsedFile(buy, `${a.name}-api-2026-09-01`, null, a.account);
    expect(opened.added).toBe(1);
    const lot = storedRows(a.account)[0]!;
    expect(lot.isOpen).toBe(true);

    const closing = a.pull("SELL", "2026-09-02", "11:00:00");
    expect(closing.format).toBe("api");
    expect("autoClose" in importer.previewParsedFile(closing, null, a.account), "no close plan").toBe(false);
    const res = importer.commitParsedFile(closing, `${a.name}-api-2026-09-02`, null, a.account);
    expect(res.added).toBe(1);
    expect((res.warnings ?? []).some((w) => w.includes("closed by this"))).toBe(false);

    const rows = storedRows(a.account).sort((x, y) => x.id - y.id);
    expect(rows).toHaveLength(2);
    expect(rows[0], "the held lot is untouched").toEqual(lot);
    expect(rows[1]).toMatchObject({ isOpen: true, buyQty: 0, sellQty: 10 });
    // Kite and OpenAlgo date a sell-only row; Angel One and Upstox leave it
    // null — v4.2.0's shape, pending an owner decision (see the header).
    expect(rows[1]!.sellDate).toBe(a.datesSellOnly ? "2026-09-02" : null);
  });
});

// ===========================================================================
// S3 — C-7 + C-8 seed rows → the desktop refresh → loadRatesMap → commit's stored charges
// ===========================================================================

/**
 * The installed app never runs seedDatabase(): it runs the sidecar's
 * refreshRateCards() against a template built from buildChargeConfigSeed()
 * (scripts/build-desktop.mjs), and every import then prices through
 * loadRatesMap() → findRates(pricingDate) → computeCharges. Each builder ran
 * one half: CB / C-8 the seed, F1 the refresh, and the engine was nobody's.
 *
 * The planted state is the owner's real 4.2.0 card (DECISIONS 2026-09-11: two
 * F&O epochs with the 1970 row carrying the 2026 STT, open-ended; one flat row
 * per other key) — the same SQL as tests/stt-epoch-2024.test.ts.
 */
const STT_2024 = "2024-10-01";
const STT_2026 = "2026-04-01";
/** bbdc4ec's flat exchange charges, as exact doubles. */
const PRE_C8 = {
  eqNse: 0.0000297, eqBse: 0.0000375, optNse: 0.0003503, optBse: 0.000325,
  fut: 0.0000173, cfut: 0.000021, copt: 0.000418, ipft: 0.000000001,
};
function plantOwner420(db: Database.Database): void {
  db.prepare(
    `DELETE FROM charge_config WHERE effective_from <> '1970-01-01'
       AND (segment NOT IN ('future', 'index_option', 'stock_option') OR effective_from NOT IN (?, ?))`,
  ).run(STT_2024, STT_2026);
  db.prepare(
    `UPDATE charge_config SET
       exchange_txn_pct = CASE
         WHEN segment IN ('eq_delivery', 'eq_mtf', 'eq_intraday') THEN (CASE exchange WHEN 'BSE' THEN :eqBse ELSE :eqNse END)
         WHEN segment IN ('index_option', 'stock_option') THEN (CASE exchange WHEN 'BSE' THEN :optBse ELSE :optNse END)
         WHEN segment = 'future' THEN :fut
         WHEN segment = 'commodity_future' THEN :cfut
         WHEN segment = 'commodity_option' THEN :copt
         ELSE 0 END,
       ipft_pct = CASE exchange WHEN 'NSE' THEN :ipft ELSE 0 END`,
  ).run(PRE_C8);
  db.prepare(
    `UPDATE charge_config AS t SET effective_to = (SELECT min(n.effective_from) FROM charge_config n
       WHERE n.broker = t.broker AND n.plan = t.plan AND n.segment = t.segment AND n.exchange = t.exchange
         AND n.effective_from > t.effective_from)`,
  ).run();
  const same = `n.broker = t.broker AND n.plan = t.plan AND n.segment = t.segment
                AND n.exchange = t.exchange AND n.effective_from = '${STT_2026}'`;
  db.prepare(
    `UPDATE charge_config AS t SET
       stt_pct = (SELECT n.stt_pct FROM charge_config n WHERE ${same}),
       stt_side = (SELECT n.stt_side FROM charge_config n WHERE ${same}),
       effective_to = NULL
     WHERE t.effective_from = '1970-01-01' AND EXISTS (SELECT 1 FROM charge_config n WHERE ${same})`,
  ).run();
  db.prepare(`DELETE FROM charge_config WHERE effective_from = '${STT_2024}'`).run();
}

/** One closed round trip, Dhan, NSE, bought and sold on `day`; the file states no charges. */
const roundTrip = (sym: string, day: string, productHint: NormalizedTrade["productHint"], qty: number, buy: number, sell: number): NormalizedTrade => ({
  broker: "dhan",
  tradingsymbol: sym,
  isin: null,
  buyQty: qty,
  avgBuyPrice: buy,
  buyValue: qty * buy,
  sellQty: qty,
  avgSellPrice: sell,
  sellValue: qty * sell,
  closingPrice: null,
  grossPnl: qty * (sell - buy),
  unrealisedPnl: 0,
  buyDate: day,
  sellDate: day,
  productHint,
  exchangeHint: "NSE",
  sourceFile: "seams-v43-release",
});

/** Cash: 5,000 × ₹1,000 each way = ₹1 crore turnover, so a rate IS its per-crore figure. */
const CASH_DAYS = ["2023-03-31", "2023-04-01", "2024-03-31", "2024-04-01", "2024-09-30", "2024-10-01", "2026-02-28", "2026-03-01"];
/** Index options: 800 × ₹100 bought, 800 × ₹150 sold = ₹2 lakh premium turnover, ₹1.2 lakh sold. */
const OPTION_DAYS: [string, string][] = [
  ["2024-09-30", "NIFTY24DEC24000CE"],
  ["2024-10-01", "NIFTY24DEC24000CE"],
  ["2026-03-31", "NIFTY26JUN24000CE"],
  ["2026-04-01", "NIFTY26JUN24000CE"],
];
const ratesFile = (): ParsedFile => ({
  sourceId: "seams-v43-release",
  broker: "dhan",
  format: "tradebook",
  warnings: [],
  trades: [
    ...CASH_DAYS.map((d) => roundTrip("TCS", d, "delivery", 5000, 1000, 1000)),
    ...OPTION_DAYS.map(([d, sym]) => roundTrip(sym, d, null, 800, 100, 150)),
  ],
});

/**
 * The NSE circulars (DECISIONS 2026-09-11 C-8, skeptic-confirmed), in rupees on
 * the turnover above. Cash per crore: txn + IPFT = 345.01 / 335 / 332 / 307 / 307.
 */
const CASH_EXPECTED: Record<string, { exchangeTxn: number; ipft: number }> = {
  "2023-03-31": { exchangeTxn: 345, ipft: 0.01 }, // FA46730 (extended back)
  "2023-04-01": { exchangeTxn: 325, ipft: 10 }, //   FA56129
  "2024-03-31": { exchangeTxn: 325, ipft: 10 },
  "2024-04-01": { exchangeTxn: 322, ipft: 10 }, //   FA61137
  "2024-09-30": { exchangeTxn: 322, ipft: 10 },
  "2024-10-01": { exchangeTxn: 297, ipft: 10 }, //   FA64232
  "2026-02-28": { exchangeTxn: 297, ipft: 10 },
  "2026-03-01": { exchangeTxn: 306.99, ipft: 0.01 }, // FA73061 — IPFT stays its own line
};
/** Options on ₹2 lakh premium (5000 / 3553 / 3553 per crore) and STT on the ₹1.2 lakh sold (C-7). */
const OPTION_EXPECTED: Record<string, { exchangeTxn: number; ipft: number; sttCtt: number }> = {
  "2024-09-30": { exchangeTxn: 99, ipft: 1, sttCtt: 75 }, //    0.0495% + ₹50/cr; STT 0.0625%
  "2024-10-01": { exchangeTxn: 70.06, ipft: 1, sttCtt: 120 }, // 0.03503% + ₹50/cr; STT 0.10%
  "2026-03-31": { exchangeTxn: 71.06, ipft: 0, sttCtt: 120 }, // 0.0355299% + ₹0.01/cr
  "2026-04-01": { exchangeTxn: 71.06, ipft: 0, sttCtt: 180 }, // STT 0.15%
};

describe("S3 · the C-7/C-8 card, delivered by the desktop refresh, is what commit prices with (seed-data → refresh → loadRatesMap → commit)", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-seams-v43-release-"));
  const TEMPLATE = path.join(scratch, "template.sqlite");

  beforeAll(() => {
    // The desktop template: migrated, then seeded from buildChargeConfigSeed() (build-desktop.mjs's order).
    const m = new Database(":memory:");
    migrate(drizzle(m), { migrationsFolder: path.resolve(__dirname, "../drizzle") });
    const d = drizzle(m);
    m.transaction(() => {
      for (const row of buildChargeConfigSeed()) d.insert(t.schema.chargeConfig).values(row).run();
    })();
    fs.writeFileSync(TEMPLATE, m.serialize());
    m.close();
    plantOwner420(t.sqlite);
  });
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const byDay = (accountId: number, segment: string) =>
    new Map(storedRows(accountId).filter((r) => r.segment === segment).map((r) => [r.buyDate!, r]));

  it("before the refresh, the owner's 4.2.0 card prices every boundary flat (the book the upgrade must move)", () => {
    const res = importer.commitParsedFile(ratesFile(), "seams-v43-release-before.csv", null, RATES_BEFORE);
    expect(res.added).toBe(12);
    const cash = byDay(RATES_BEFORE, "eq_delivery");
    const opts = byDay(RATES_BEFORE, "index_option");
    expect([...cash.keys()].sort()).toEqual(CASH_DAYS);
    expect([...opts.keys()].sort()).toEqual(OPTION_DAYS.map(([d]) => d));
    expect(cash.get("2023-04-01")).toMatchObject({ exchangeTxn: 297, ipft: 0.01 });
    expect(opts.get("2024-09-30")).toMatchObject({ exchangeTxn: 70.06, sttCtt: 180 });
  });

  it("the real sidecar refresh moves that card onto the template: 297 added, 135 refreshed, then 0 / 0", () => {
    expect(refreshRateCards(t.sqlite, TEMPLATE, () => {})).toEqual({ added: 297, refreshed: 135 });
    expect(refreshRateCards(t.sqlite, TEMPLATE, () => {})).toEqual({ added: 0, refreshed: 0 });
  });

  it("after it, commit — reading charge_config through loadRatesMap — stores every boundary at its circular's rate", () => {
    const res = importer.commitParsedFile(ratesFile(), "seams-v43-release-after.csv", null, RATES_AFTER);
    expect(res.added).toBe(12);
    const cash = byDay(RATES_AFTER, "eq_delivery");
    const opts = byDay(RATES_AFTER, "index_option");
    // THE assertions: stored rupees (paise at rest) per boundary day, both sides of each.
    for (const d of CASH_DAYS) {
      const r = cash.get(d)!;
      expect({ day: d, exchangeTxn: r.exchangeTxn, ipft: r.ipft }).toEqual({ day: d, ...CASH_EXPECTED[d] });
    }
    for (const [d] of OPTION_DAYS) {
      const r = opts.get(d)!;
      expect({ day: d, exchangeTxn: r.exchangeTxn, ipft: r.ipft, sttCtt: r.sttCtt }).toEqual({ day: d, ...OPTION_EXPECTED[d] });
    }
  });
});
