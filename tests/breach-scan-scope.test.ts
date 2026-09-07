import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * OWNER RULING (2026-09-08, v4.2 fix wave 4) — WHO the breach banner speaks for.
 *
 * `scanBreaches()` in lib/jobs/auto-mtm.ts selects every open trade in the
 * database with no `account_id` filter at all. That is right for the EOD
 * auto-MTM job, which prices EVERY account from one bhavcopy and must report on
 * every account it just marked. It is wrong for the two page banners
 * (app/page.tsx and app/risk/page.tsx), which sit on account-scoped pages: with
 * the "Personal" account selected, the dashboard raised a stop breach naming a
 * symbol that is not in the book on screen — invariant 8's exact failure mode,
 * and nothing on screen looks broken.
 *
 * THE RULING, as implemented:
 *   • the banners call `scanBreachesForSelectedAccount()` → `getSelectedAccountId()`,
 *     applying the house rule `accountId > 0 ? filter : all`, so 0 ("All
 *     accounts") is every account exactly as it is for every other read;
 *   • the EOD job's `breaches` keeps `scanBreaches()` — every account, because
 *     it just marked every account. Its call site is unchanged.
 *
 * WHY A DATABASE: the behaviour under test IS the WHERE clause. A pure test of
 * `detectBreaches` cannot see it, and would only agree with itself.
 *
 * ONE temp database for the FILE (`lib/db` caches its connection on
 * `globalThis`), and everything server-only is imported DYNAMICALLY after
 * `openTempDb` has set `VYUHA_DB_PATH`.
 */

let t: TempDb;
let job: typeof import("@/lib/jobs/auto-mtm");
let riskPage: () => unknown;
let dashboardPage: () => unknown;

const PERSONAL = 1;
const SWING = 2;
const ALL = 0;

/** One open position per account, each already through its own target. */
const PERSONAL_ID = 951;
const SWING_ID = 952;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

/** Every `props[key]` in a React element tree (the pages are never rendered). */
function collectProps(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const n of node) collectProps(n, key, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props) {
    if (key in props) out.push(props[key]);
    collectProps(props.children, key, out);
  }
  return out;
}

/** The `breaches` prop the page hands `<BreachBanner>`. */
function bannerBreaches(page: () => unknown): Array<{ id: number; symbol: string }> {
  const found = collectProps(page(), "breaches").find((b) => Array.isArray(b));
  expect(found, "no <BreachBanner breaches={…}> in the rendered element tree").toBeDefined();
  return found as Array<{ id: number; symbol: string }>;
}

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id).sort((a, b) => a - b);

beforeAll(async () => {
  t = await openTempDb("breach-scan-scope", { seed: true });
  job = await import("@/lib/jobs/auto-mtm");
  riskPage = (await import("@/app/risk/page")).default as () => unknown;
  dashboardPage = (await import("@/app/page")).default as () => unknown;

  t.db.update(t.schema.settings).set({ equityCapital: 1_000_000, activeCapital: 1_000_000 }).run();
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      // Account 1 — TCS through its target on its own recorded close.
      tradeRow({
        id: PERSONAL_ID,
        accountId: PERSONAL,
        symbol: "TCS",
        tradingsymbol: "TCS",
        instrumentType: "equity",
        buyQty: 10,
        sellQty: 0,
        avgBuyPrice: 2000,
        closingPrice: 2100,
        targetPlanned: 2050,
        isOpen: true,
      }),
      // Account 2 — INFY, likewise. A different symbol, so a leak is legible.
      tradeRow({
        id: SWING_ID,
        accountId: SWING,
        symbol: "INFY",
        tradingsymbol: "INFY",
        instrumentType: "equity",
        buyQty: 10,
        sellQty: 0,
        avgBuyPrice: 1500,
        closingPrice: 1600,
        targetPlanned: 1550,
        isOpen: true,
      }),
    ])
    .run();
});

afterAll(() => t?.cleanup());

describe("the breach BANNERS are account-scoped (invariant 8)", () => {
  it("a floor: both positions really do breach, so an empty result cannot pass for the right reason", () => {
    expect(ids(job.scanBreaches())).toEqual([PERSONAL_ID, SWING_ID]);
  });

  it("with Personal selected, the scan returns Personal's breach and NOT Swing's", () => {
    selectAccount(PERSONAL);
    const rows = job.scanBreachesForSelectedAccount();
    expect(ids(rows)).toEqual([PERSONAL_ID]);
    expect(rows.map((r) => r.symbol)).not.toContain("INFY");
  });

  it("with Swing selected, the other book's breach is the one that disappears", () => {
    selectAccount(SWING);
    const rows = job.scanBreachesForSelectedAccount();
    expect(ids(rows)).toEqual([SWING_ID]);
    expect(rows.map((r) => r.symbol)).not.toContain("TCS");
  });

  it("0 is the All-accounts VIEW, so it shows both — the same rule every other read applies", () => {
    selectAccount(ALL);
    expect(ids(job.scanBreachesForSelectedAccount())).toEqual([PERSONAL_ID, SWING_ID]);
  });
});

describe("both page banners are fed the scoped scan", () => {
  it("/risk hands <BreachBanner> only the selected account's breaches", () => {
    selectAccount(PERSONAL);
    const rows = bannerBreaches(riskPage);
    expect(ids(rows)).toEqual([PERSONAL_ID]);
    selectAccount(SWING);
    expect(ids(bannerBreaches(riskPage))).toEqual([SWING_ID]);
  });

  it("the dashboard does the same", () => {
    selectAccount(PERSONAL);
    expect(ids(bannerBreaches(dashboardPage))).toEqual([PERSONAL_ID]);
    selectAccount(SWING);
    expect(ids(bannerBreaches(dashboardPage))).toEqual([SWING_ID]);
  });
});

describe("the EOD auto-MTM job still reports every account it marked", () => {
  it("scanBreaches() ignores the selection entirely, on either setting", () => {
    selectAccount(PERSONAL);
    expect(ids(job.scanBreaches())).toEqual([PERSONAL_ID, SWING_ID]);
    selectAccount(SWING);
    expect(ids(job.scanBreaches())).toEqual([PERSONAL_ID, SWING_ID]);
  });

  it("an explicit scope of null is the whole database, and account 0 is too", () => {
    selectAccount(PERSONAL);
    expect(ids(job.scanBreaches({ accountId: null }))).toEqual([PERSONAL_ID, SWING_ID]);
    expect(ids(job.scanBreaches({ accountId: 0 }))).toEqual([PERSONAL_ID, SWING_ID]);
    expect(ids(job.scanBreaches({ accountId: SWING }))).toEqual([SWING_ID]);
  });

  it("the EOD call site is the UNSCOPED one — the job prices every account, so it reports on every account", () => {
    const src = fs.readFileSync("lib/jobs/auto-mtm.ts", "utf8");
    expect(src).toContain("breaches: scanBreaches()");
    expect(src).not.toContain("breaches: scanBreachesForSelectedAccount()");
  });
});
