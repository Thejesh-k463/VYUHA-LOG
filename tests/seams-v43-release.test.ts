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
 * close happens — R72 is unreachable. The Angel One / Upstox sale used to land
 * as an OPEN SHORT with `sell_date` NULL and no basis flag (v4.2.0's shape).
 * The owner selected QS-AO (v4.3.0 fix work): it now lands dated the pull's IST
 * day and basis-unknown, Dhan's M-3 shape, and S2 pins that.
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
const PAGE_FLOOR = 81;
const DELIVERY_2011_BEFORE = 82;
const DELIVERY_2011_AFTER = 83;
const PAGE_RETRY = 84;
const MERGE_X = 85;
const MERGE_Y = 86;
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
      [PAGE_ROUTE, PAGE_AUTO, EDGE_IN, EDGE_OUT, KITE, ANGEL, UPSTOX, OPENALGO, RATES_BEFORE, RATES_AFTER, PAGE_FLOOR, DELIVERY_2011_BEFORE, DELIVERY_2011_AFTER, PAGE_RETRY, MERGE_X, MERGE_Y].map((id) => ({
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
  unfetched?: { from: string; to: string; reason: string; fact: string; remedy: string | null }[];
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

  // Frozen clock: today (IST) is 2026-09-11; the stamp is 10:30 IST on 2026-09-07.
  // F-L1-3a (fix wave 1): a truncated walk keeps NONE of what it read, its span
  // ends YESTERDAY (today came from /v2/positions), and the tradebook remedy
  // starts the day after the last pull's own day.
  const STAMP = "2026-09-07T05:00:00.000Z";
  // N6 (fix wave 2R) re-pin, here and in PAGE_LINE below: "Truncated: this pull
  // stopped … Today's book came from /v2/positions." → "Truncated: the pull on
  // 2026-09-11 stopped … The book for 2026-09-11 came from /v2/positions." — the
  // kept line is read on the card days later, so it dates the pull.
  const TRUNCATED =
    "Truncated: the pull on 2026-09-11 stopped at the 50-page limit of Dhan's trade history and kept none of what it read, so fills from 2026-09-07 to 2026-09-10 were not read. The book for 2026-09-11 came from /v2/positions. Fills on 2026-09-07 after 10:30 IST were not fetched; a tradebook for 2026-09-07 would repeat the fills already imported from it. To bring the rest in, import a Dhan tradebook for 2026-09-08 to 2026-09-10.";
  // P15 / P16 (fix wave 2): the card's line (components/import/broker-connect.tsx)
  // is the server's own two sentences, carried by GET and printed VERBATIM — so
  // it is TRUNCATED, character for character. Re-pinned from two toContain
  // fragments of the card's re-derived "may be missing … 08 Sep 2026" line
  // (the weakened seam pin DECISIONS 2026-09-14 assigns to this builder).
  const NOTICE_FACT =
    "Truncated: the pull on 2026-09-11 stopped at the 50-page limit of Dhan's trade history and kept none of what it read, so fills from 2026-09-07 to 2026-09-10 were not read. The book for 2026-09-11 came from /v2/positions. Fills on 2026-09-07 after 10:30 IST were not fetched; a tradebook for 2026-09-07 would repeat the fills already imported from it.";
  const NOTICE_REMEDY = "To bring the rest in, import a Dhan tradebook for 2026-09-08 to 2026-09-10.";
  const SPAN = [{ from: "2026-09-07", to: "2026-09-10", reason: "page-cap", fact: NOTICE_FACT, remedy: NOTICE_REMEDY }];

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
    // F-L1-3a: the fill read inside the truncated walk (2026-09-08) is NOT
    // committed, and /v2/positions is empty — so nothing is added.
    expect(json.result.added).toBe(0);
    expect(storedRows(PAGE_ROUTE)).toEqual([]);

    // THE assertion: the span outlives the lastPullAt move, and the card's line is the page-limit one.
    const conn = await connOf(PAGE_ROUTE);
    expect(conn.unfetched).toEqual(SPAN);
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toBe(TRUNCATED);
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
    // F-L1-3a: the truncated walk is dropped whole and /v2/positions is empty,
    // so the sweep finds nothing new — and R27 still keeps the span and stamps.
    expect(mine?.status).toBe("nothingNew");
    const WORDS =
      " (fills from 2026-09-07 to 2026-09-10 not read (page limit) — import a Dhan tradebook for 2026-09-08 to 2026-09-10; fills on 2026-09-07 after 10:30 IST not fetched — a tradebook for 2026-09-07 would repeat the fills already imported from it)";
    expect(mine?.detail).toBe(`no trades today${WORDS}`);
    expect(out.line).toContain(`Dhan nothing new${WORDS}`);
    // The token-only rows in this file are not unattended-eligible, so nothing else was pulled.
    expect(out.summary.filter((e) => e.status !== "notEligible").map((e) => e.accountId)).toEqual([PAGE_AUTO]);

    const conn = await connOf(PAGE_AUTO);
    expect(conn.unfetched).toEqual(SPAN);
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toBe(TRUNCATED);
    expect(conn.lastPullAt).toBe(AT_IST_BOUNDARY.toISOString());
  });

  /**
   * P15 (fix wave 2): a CLAMPED and truncated pull keeps a range-cap span and a
   * page-cap span that starts at the 90-day floor (2026-06-13), a day no pull
   * imported. The user clears the range-cap notice only. The card used to find
   * no range-cap sibling, read the page-cap span as starting on the last pull's
   * day, and name "14 Jun 2026" in its remedy — skipping the floor day.
   */
  it("P15 route: clamped + truncated, the range-cap notice cleared — the card's page-cap line IS the pull's, and names the floor day", async () => {
    addDhan(PAGE_FLOOR, "2026-06-01T05:00:00.000Z"); // 10:30 IST on 1 Jun — past the floor
    stubDhan([dhanFill("PF-1", "2026-09-08 10:00:00")], true);
    const res = await post({ action: "pull", broker: "dhan", accountId: PAGE_FLOOR, mode: "commit" });
    expect(res.status).toBe(200);
    const PAGE_LINE =
      "Truncated: the pull on 2026-09-11 stopped at the 50-page limit of Dhan's trade history and kept none of what it read, so fills from 2026-06-13 to 2026-09-10 were not read. The book for 2026-09-11 came from /v2/positions. To bring those fills in, import a Dhan tradebook for 2026-06-13 to 2026-09-10.";
    expect((await res.json()).warnings as string[]).toContain(PAGE_LINE);
    expect((await connOf(PAGE_FLOOR)).unfetched!.map((s) => s.reason)).toEqual(["range-cap", "page-cap"]);

    const cleared = await post({
      action: "clear-unfetched",
      broker: "dhan",
      accountId: PAGE_FLOOR,
      from: "2026-06-01",
      to: "2026-06-12",
      reason: "range-cap",
    });
    expect(cleared.status).toBe(200);

    const conn = await connOf(PAGE_FLOOR);
    expect(conn.unfetched!.map((s) => [s.from, s.to, s.reason])).toEqual([["2026-06-13", "2026-09-10", "page-cap"]]);
    // THE assertion ("… for 14 Jun 2026 to 10 Sep 2026 …" on revert of the card).
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toBe(PAGE_LINE);
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toContain("import a Dhan tradebook for 2026-06-13 to");
  });

  /**
   * N5 (fix wave 2R), route → lib/import/dhan-unfetched.ts → GET: a clamped,
   * truncated pull keeps range-cap [06-01, 06-12] and page-cap [06-13, 09-10];
   * its stamp stays where it was (as when the commit throws). The retry a DAY
   * later is untruncated and commits: the route keeps range-cap [06-01, 06-13]
   * BEFORE the commit, then clears with the stamp. The page-cap span starts on
   * the old floor, a day before the new read — and that day is the one the
   * range-cap notice now names. Measured before: both spans still listed.
   */
  it("N5 route: an untruncated retry on a later day clears the clamped page-cap span; the range-cap notice names the day before the read", async () => {
    const OLD = "2026-06-01T05:00:00.000Z";
    addDhan(PAGE_RETRY, OLD);
    stubDhan([dhanFill("PR-1", "2026-09-08 10:00:00")], true);
    expect((await post({ action: "pull", broker: "dhan", accountId: PAGE_RETRY, mode: "commit" })).status).toBe(200);
    expect((await connOf(PAGE_RETRY)).unfetched!.map((s) => [s.from, s.to, s.reason])).toEqual([
      ["2026-06-01", "2026-06-12", "range-cap"],
      ["2026-06-13", "2026-09-10", "page-cap"],
    ]);
    t.sqlite.prepare("UPDATE broker_connections SET last_pull_at = ? WHERE account_id = ?").run(OLD, PAGE_RETRY);

    vi.setSystemTime(AT_IST_BOUNDARY.getTime() + 86_400_000); // 00:30 IST on 12 Sep
    const paths = stubDhan([dhanFill("PR-2", "2026-09-08 10:00:00")]);
    const res = await post({ action: "pull", broker: "dhan", accountId: PAGE_RETRY, mode: "commit" });
    expect(res.status).toBe(200);
    expect(paths).toContain("/v2/trades/2026-06-14/2026-09-12/1"); // page 1 empty: the walk is NOT truncated
    expect((await res.json()).result.added).toBe(1);

    // THE assertion (the page-cap span [06-13, 09-10] still listed on revert).
    const conn = await connOf(PAGE_RETRY);
    expect(conn.unfetched!.map((s) => [s.from, s.to, s.reason])).toEqual([["2026-06-01", "2026-06-13", "range-cap"]]);
    expect(bc.unfetchedNotice(conn.unfetched![0]!)).toContain("import a Dhan tradebook for 2026-06-02 to 2026-06-13.");
  });

  /**
   * N4 (fix wave 2R), merge → route → GET: X's truncated pull keeps page-cap
   * [09-07, 09-10]. X merges into Y, which has its OWN Dhan client (the merge
   * keeps the target's credentials and removes X's). Y's untruncated pull reads
   * 09-07..09-11 of Y's client — nothing of X's — so X's carried notice stays.
   * Measured before: Y's GET listed [] and the audit trail said the fills "were read".
   */
  it("N4 route: a notice carried by a merge is not cleared by the target's own Dhan client's pull", async () => {
    addDhan(MERGE_X, STAMP);
    stubDhan([dhanFill("N4-X", "2026-09-08 10:00:00")], true);
    expect((await post({ action: "pull", broker: "dhan", accountId: MERGE_X, mode: "commit" })).status).toBe(200);
    expect((await connOf(MERGE_X)).unfetched).toEqual(SPAN);
    t.sqlite
      .prepare("INSERT INTO broker_connections (account_id, broker, api_key, access_token, last_pull_at) VALUES (?, 'dhan', '1000000077', ?, ?)")
      .run(MERGE_Y, alive(), STAMP);

    const del = await import("@/lib/queries/account-delete");
    const merged = del.deleteAccount({ accountId: MERGE_X, mode: "merge", targetId: MERGE_Y, connections: "move" });
    expect(merged.ok, merged.message).toBe(true);
    expect((await connOf(MERGE_Y)).unfetched).toEqual(SPAN);

    stubDhan([dhanFill("N4-Y", "2026-09-08 11:00:00")]); // Y's client: page 0 answers, page 1 is empty
    const res = await post({ action: "pull", broker: "dhan", accountId: MERGE_Y, mode: "commit" });
    expect(res.status).toBe(200);
    expect((await res.json()).result.added).toBe(1);

    // THE assertion ([] on revert: Y's read "cleared" fills of X's client).
    expect((await connOf(MERGE_Y)).unfetched).toEqual(SPAN);
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
    // F-L1-3a: the one-day span is the last pull's own day — stated as a
    // fact, with no tradebook remedy (there is no day left to name).
    // RANGE-CAP COPY (wave 2F, as N6): the kept fact names the pull by its IST day. Before: "so this one started at 2026-06-13".
    // L2 (wave 2G): re-pinned. Before: "The last pull ran on <day>"; after: "The pull before it ran on <day>" — the kept line sat under the card's newer "last pull" stamp and contradicted it.
    const ONE_DAY =
      "Not fetched: fills from 2026-06-12 to 2026-06-12. The pull before it ran on 2026-06-12, and a pull reads at most 90 days of Dhan's trade history, so the pull on 2026-09-11 started at 2026-06-13. Fills on 2026-06-12 after 00:30 IST were not fetched; a tradebook for 2026-06-12 would repeat the fills already imported from it.";
    expect(json.warnings as string[]).toContain(ONE_DAY);

    const after = await connOf(EDGE_OUT);
    expect(after.unfetched).toEqual([{ from: "2026-06-12", to: "2026-06-12", reason: "range-cap", fact: ONE_DAY, remedy: null }]);
    // P15 / P16 (fix wave 2): the card prints the pull's sentence above VERBATIM
    // (re-pinned from the card's own "Not fetched from Dhan: fills on 12 Jun 2026
    // after the last pull. …" re-derivation) — a one-day span names no import.
    expect(bc.unfetchedNotice(after.unfetched![0]!)).toBe(ONE_DAY);
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
  /** Whether this adapter flags a sell-only row's basis as unknown (QS-AO). */
  basisUnknownSellOnly: boolean;
}

const PULL_ADAPTERS: PullAdapter[] = [
  {
    name: "Kite (Zerodha)",
    account: KITE,
    basisUnknownSellOnly: false,
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
    basisUnknownSellOnly: true,
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
    basisUnknownSellOnly: true,
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
    basisUnknownSellOnly: false,
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
    // RE-PINNED DELIBERATELY for QS-AO (v4.3.0 fix work, plan-answers
    // "Q-SCOPE"): every adapter now dates a sell-only row. Before, Angel One and
    // Upstox measured `sellDate: null, acquisition: null` (v4.2.0's open-short
    // shape, see the header); now they carry Dhan's M-3 shape.
    expect(rows[1]!.sellDate).toBe("2026-09-02");
    expect(rows[1]!.acquisition).toBe(a.basisUnknownSellOnly ? "unknown" : null);
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
/** 4.2.0's one delivery/MTF STT (0.1% both sides, every date): QS-EQ2012 gave the 1970 row 0.125%. */
const PRE_EQ2012_DELIVERY_STT = 0.001;
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
       ipft_pct = CASE exchange WHEN 'NSE' THEN :ipft ELSE 0 END,
       stt_pct = CASE WHEN segment IN ('eq_delivery', 'eq_mtf') THEN :eqStt ELSE stt_pct END`,
  ).run({ ...PRE_C8, eqStt: PRE_EQ2012_DELIVERY_STT });
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
/** QS-EQ2012: a Dhan NSE delivery round trip before 1 Jul 2012 — 1,000 × ₹100 bought, sold at ₹101. */
const DAY_2011 = "2011-03-15";
const delivery2011File = (): ParsedFile => ({
  sourceId: "seams-v43-release",
  broker: "dhan",
  format: "tradebook",
  warnings: [],
  trades: [roundTrip("INFY", DAY_2011, "delivery", 1000, 100, 101)],
});
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

  it("before the refresh, the 4.2.0 card prices a 2011 delivery round trip at a flat 0.1% STT: ₹201 on ₹2,01,000", () => {
    const res = importer.commitParsedFile(delivery2011File(), "seams-v43-release-2011-before.csv", null, DELIVERY_2011_BEFORE);
    expect(res.added).toBe(1);
    expect(byDay(DELIVERY_2011_BEFORE, "eq_delivery").get(DAY_2011)).toMatchObject({ sttCtt: 201 });
  });

  // Re-pinned 2026-09-11 (v4.3.0 fix wave 1). R1 added 63 verified F&O STT
  // epochs (seed 459 -> 522 rows; FATAX23500/27711/32385/56235), so the owner's
  // 4.2.0 card gains 63 more rows than the 297 this pinned before; R54 added
  // `removed` to refreshRateCards' result. Measured, not derived.
  // Re-pinned 2026-09-14 (v4.3.0 fix wave 2, QS-EQ2012): the 36 delivery/MTF keys
  // gained FATAX20990's 2012-07-01 epoch (seed 522 -> 558), so the first launch reads
  // 396 / 135 / 0 where it read 360 / 135 / 0; the second launch is still 0 / 0 / 0. Measured.
  it("the real sidecar refresh moves that card onto the template: 396 added, 135 refreshed, 0 removed, then 0 / 0 / 0", () => {
    expect(refreshRateCards(t.sqlite, TEMPLATE, () => {})).toEqual({ added: 396, refreshed: 135, removed: 0 });
    expect(refreshRateCards(t.sqlite, TEMPLATE, () => {})).toEqual({ added: 0, refreshed: 0, removed: 0 });
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

  /**
   * QS-EQ2012 through the same seam: FATAX20990 rows 1 & 2 state 0.125 per cent on
   * the purchaser AND the seller till 30.06.2012. Buy ₹1,00,000 + sell ₹1,01,000 =
   * ₹2,01,000 turnover × 0.125% = ₹251.25, STT rounded to the rupee: ₹251. The flat
   * 0.1% card (4.2.0, and this build before QS-EQ2012) stores ₹201.
   */
  it("after it, commit stores a 2011 delivery round trip at FATAX20990's 0.125% both sides: ₹251 on ₹2,01,000", () => {
    const res = importer.commitParsedFile(delivery2011File(), "seams-v43-release-2011-after.csv", null, DELIVERY_2011_AFTER);
    expect(res.added).toBe(1);
    const r = byDay(DELIVERY_2011_AFTER, "eq_delivery").get(DAY_2011)!;
    expect({ buyValue: r.buyValue, sellValue: r.sellValue, sttCtt: r.sttCtt }).toEqual({
      buyValue: 100_000,
      sellValue: 101_000,
      sttCtt: 251,
    });
  });
});
